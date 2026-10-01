import AVFoundation
import Foundation
#if os(iOS)
import UIKit
#endif

final class DurableFinalAssetExporter {
  private let store: DurableRecorderStore
  private let inspector: DurableAudioFileInspecting
  private let lock = NSLock()
  private var exportingSessionIds = Set<String>()
  private var cancellations: [String: AudioExportCancellation] = [:]
  /// Set by the bridge when the export was cancelled because the app ran out of background execution time, so the
  /// failure reported to JS is explicit and actionable instead of a generic AVFoundation cancellation.
  private var expiredSessionIds = Set<String>()
  /// Evidence hook (Dev diagnostics only): `(sessionId, kind, extra)`. Never affects behaviour.
  var onTrace: ((String, String, [String: Any]) -> Void)?

  /// How the final M4A is built. `packetPreserving` (default) copies the durable AAC packets without re-encoding and
  /// silently falls back to `reencode` (the original composer) on ANY incompatibility or failure except cancellation.
  enum Strategy: String {
    case packetPreserving
    case reencode
  }
  /// Decides the strategy per export. Production always answers `packetPreserving`; a Dev-only switch can force
  /// `reencode` to A/B the two on the same session.
  var strategyProvider: () -> Strategy = { .packetPreserving }
  /// Injectable for tests; the real implementation is `PacketPreservingConcatenator.concatenate`.
  var packetConcatenator: ([URL], URL, AudioExportCancellation?) async throws -> PacketConcatenationReport = {
    try await PacketPreservingConcatenator.concatenate(orderedSources: $0, outputURL: $1, cancellation: $2)
  }

  static let backgroundTimeExpiredMessage =
    "The final export was interrupted because the app ran out of background time. "
    + "The recording is safe on this device — open the app and tap Finish again."

  init(
    store: DurableRecorderStore,
    inspector: DurableAudioFileInspecting = SystemDurableAudioFileInspector()
  ) {
    self.store = store
    self.inspector = inspector
  }

  func export(recordingSessionId: String) async throws -> [String: Any] {
    try begin(recordingSessionId)
    let cancellation = AudioExportCancellation()
    register(cancellation, for: recordingSessionId)
    defer { end(recordingSessionId) }
    let startedAt = Date()
    onTrace?(recordingSessionId, "finish_export_begin", [:])
    do {
      let output = try await performExport(recordingSessionId: recordingSessionId, cancellation: cancellation)
      onTrace?(recordingSessionId, "finish_export_end", [
        "outcome": "completed", "ms": Int(Date().timeIntervalSince(startedAt) * 1_000),
      ])
      return output
    } catch {
      onTrace?(recordingSessionId, "finish_export_end", [
        "outcome": "failed", "ms": Int(Date().timeIntervalSince(startedAt) * 1_000),
        "error": DurableRecorderDiagnostics.describe(error),
      ])
      throw error
    }
  }

  private func performExport(
    recordingSessionId: String,
    cancellation: AudioExportCancellation
  ) async throws -> [String: Any] {
    let plan = try store.finalAssetPlan(recordingSessionId: recordingSessionId)
    let sourceIds = plan.sourceSegments.map(\.segmentId)

    if FileManager.default.fileExists(atPath: plan.finalURL.path) {
      let inspection = try inspector.inspect(url: plan.finalURL)
      let session = try store.commitFinalAsset(
        recordingSessionId: recordingSessionId,
        relativePath: plan.relativePath,
        inspection: inspection,
        sourceSegmentIds: sourceIds
      )
      return result(session: session, url: plan.finalURL)
    }

    try store.removeStaleFinalAssetTemporaryFile(plan)
    do {
      let builtWithoutReencode = try await buildPacketPreservingIfEnabled(
        plan: plan, recordingSessionId: recordingSessionId, cancellation: cancellation
      )
      if !builtWithoutReencode {
        try await AudioSegmentComposer.compose(
          orderedSources: plan.sourceURLs,
          outputURL: plan.temporaryURL,
          cancellation: cancellation
        )
      }
    } catch AudioSegmentComposerError.sourceMissing {
      throw DurableRecorderCoreError.finalAssetMissing
    } catch PacketConcatenationError.cancelled {
      onTrace?(recordingSessionId, "finish_export_cancelled", ["expired": wasExpired(recordingSessionId)])
      throw DurableRecorderCoreError.finalAssetExportFailed(Self.backgroundTimeExpiredMessage)
    } catch AudioSegmentComposerError.cancelled {
      // Deterministic, honest failure: committed segments are untouched and the partial temporary file is removed on
      // the next attempt (removeStaleFinalAssetTemporaryFile). Finish can simply be retried.
      onTrace?(recordingSessionId, "finish_export_cancelled", ["expired": wasExpired(recordingSessionId)])
      throw DurableRecorderCoreError.finalAssetExportFailed(Self.backgroundTimeExpiredMessage)
    } catch let error as AudioSegmentComposerError {
      throw DurableRecorderCoreError.finalAssetExportFailed(error.message)
    }
    _ = try inspector.inspect(url: plan.temporaryURL)
    try store.promoteFinalAsset(plan)
    let inspection = try inspector.inspect(url: plan.finalURL)
    let session = try store.commitFinalAsset(
      recordingSessionId: recordingSessionId,
      relativePath: plan.relativePath,
      inspection: inspection,
      sourceSegmentIds: sourceIds
    )
    return result(session: session, url: plan.finalURL)
  }

  /// Returns true when the packet-preserving build produced `plan.temporaryURL`. Returns false (temp file removed) when
  /// the strategy is `reencode` or the fast path is not applicable/failed, so the caller runs the original composer.
  /// Only cancellation propagates; the fallback never hides a real data problem because the composer validates sources
  /// exactly as before.
  private func buildPacketPreservingIfEnabled(
    plan: DurableFinalAssetPlan,
    recordingSessionId: String,
    cancellation: AudioExportCancellation
  ) async throws -> Bool {
    guard strategyProvider() == .packetPreserving else { return false }
    let startedAt = Date()
    do {
      let report = try await packetConcatenator(plan.sourceURLs, plan.temporaryURL, cancellation)
      onTrace?(recordingSessionId, "finish_export_fast_path", [
        "outcome": "completed", "ms": Int(Date().timeIntervalSince(startedAt) * 1_000),
        "segments": report.segmentCount, "packets": report.packetCount, "seamFrames": report.seamFramesInserted,
      ])
      return true
    } catch PacketConcatenationError.cancelled {
      try? FileManager.default.removeItem(at: plan.temporaryURL)
      throw PacketConcatenationError.cancelled
    } catch {
      try? FileManager.default.removeItem(at: plan.temporaryURL)
      onTrace?(recordingSessionId, "finish_export_fast_path", [
        "outcome": "fallback_to_reencode", "ms": Int(Date().timeIntervalSince(startedAt) * 1_000),
        "reason": (error as? PacketConcatenationError)?.message ?? String(describing: error),
      ])
      return false
    }
  }

  /// DEV BENCHMARK ONLY: builds the same session's final audio with `strategy` into `scratchURL`, never touching
  /// `final/` or session metadata, and reports wall time, size and the decoded frame count.
  func benchmark(recordingSessionId: String, strategy: Strategy, scratchURL: URL) async throws -> [String: Any] {
    let plan = try store.finalAssetPlan(recordingSessionId: recordingSessionId)
    try? FileManager.default.removeItem(at: scratchURL)
    defer { try? FileManager.default.removeItem(at: scratchURL) }
    let started = ProcessInfo.processInfo.systemUptime
    var extra: [String: Any] = [:]
    switch strategy {
    case .packetPreserving:
      let report = try await PacketPreservingConcatenator.concatenate(
        orderedSources: plan.sourceURLs, outputURL: scratchURL, cancellation: nil
      )
      extra["packets"] = report.packetCount
      extra["seamFrames"] = report.seamFramesInserted
    case .reencode:
      try await AudioSegmentComposer.compose(orderedSources: plan.sourceURLs, outputURL: scratchURL, cancellation: nil)
    }
    let seconds = ProcessInfo.processInfo.systemUptime - started
    let inspection = try inspector.inspect(url: scratchURL)
    var result: [String: Any] = [
      "strategy": strategy.rawValue, "seconds": (seconds * 1_000).rounded() / 1_000,
      "bytes": inspection.byteLength, "durationMs": inspection.durationMs, "segments": plan.sourceURLs.count,
    ]
    for (key, value) in extra { result[key] = value }
    return result
  }

  private func result(session: DurableRecordingSession, url: URL) -> [String: Any] {
    ["session": session.asDictionary(), "fileUri": url.absoluteString]
  }

  /// Cancels the in-flight export for a session, if any. Returns whether an export was running.
  @discardableResult
  func cancelExport(recordingSessionId: String, backgroundTimeExpired: Bool) -> Bool {
    lock.lock()
    if backgroundTimeExpired { expiredSessionIds.insert(recordingSessionId) }
    let cancellation = cancellations[recordingSessionId]
    lock.unlock()
    cancellation?.cancel()
    return cancellation != nil
  }

  private func register(_ cancellation: AudioExportCancellation, for sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    cancellations[sessionId] = cancellation
    expiredSessionIds.remove(sessionId)
  }

  private func wasExpired(_ sessionId: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return expiredSessionIds.contains(sessionId)
  }

  private func begin(_ sessionId: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard exportingSessionIds.insert(sessionId).inserted else {
      throw DurableRecorderCoreError.finalAssetExportFailed("A final asset export is already running.")
    }
  }

  private func end(_ sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    exportingSessionIds.remove(sessionId)
    cancellations.removeValue(forKey: sessionId)
    expiredSessionIds.remove(sessionId)
  }
}

/// Keeps the process alive while Finish (stop -> JS hop -> export -> handoff) is in flight.
///
/// Why this exists (production incident d184e93f): after the durable recorder stops, its active audio session is
/// released, so nothing keeps the app running in the background. iOS then suspends the process, freezing the JS thread
/// and the AVAssetExportSession. Finish appeared to hang for hours and only completed when the app was next opened.
///
/// A UIKit background task gives a bounded grace period. Its expiration handler cancels the export deterministically
/// (explicit failure, never a fake success) and ends the task; it never deletes or alters committed segments.
/// At most one task per session; `release` is idempotent.
final class DurableFinishBackgroundAssertion {
  typealias BeginHook = (_ name: String, _ expiration: @escaping () -> Void) -> Int?
  typealias EndHook = (_ token: Int) -> Void

  static let safetyReleaseSeconds: TimeInterval = 240

  private let lock = NSLock()
  private var tokens: [String: Int] = [:]
  private let beginHook: BeginHook
  private let endHook: EndHook
  private let safetyReleaseDelay: TimeInterval
  /// `(sessionId)` — cancel the session's in-flight export because background time ran out.
  var onExpire: ((String) -> Void)?
  /// Evidence hook (Dev diagnostics only): `(sessionId, kind, extra)`.
  var onTrace: ((String, String, [String: Any]) -> Void)?

  init(
    begin: @escaping BeginHook,
    end: @escaping EndHook,
    safetyReleaseDelay: TimeInterval = DurableFinishBackgroundAssertion.safetyReleaseSeconds
  ) {
    self.beginHook = begin
    self.endHook = end
    self.safetyReleaseDelay = safetyReleaseDelay
  }

  /// The real UIKit-backed assertion (no-op where UIKit is unavailable).
  static func system() -> DurableFinishBackgroundAssertion {
    #if os(iOS)
    return DurableFinishBackgroundAssertion(
      begin: { name, expiration in
        let identifier = UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expiration)
        return identifier == .invalid ? nil : identifier.rawValue
      },
      end: { token in
        UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: token))
      }
    )
    #else
    return DurableFinishBackgroundAssertion(begin: { _, _ in nil }, end: { _ in })
    #endif
  }

  func isHeld(sessionId: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return tokens[sessionId] != nil
  }

  /// Returns whether a background task is now held for the session.
  @discardableResult
  func acquire(sessionId: String) -> Bool {
    if isHeld(sessionId: sessionId) { return true }
    let token = beginHook("YoumiLens.finish.\(sessionId.prefix(8))") { [weak self] in
      self?.expired(sessionId: sessionId)
    }
    guard let token else {
      onTrace?(sessionId, "finish_bgtask_denied", [:])
      return false
    }
    lock.lock()
    let alreadyHeld = tokens[sessionId] != nil
    if !alreadyHeld { tokens[sessionId] = token }
    lock.unlock()
    if alreadyHeld {
      endHook(token)
      return true
    }
    onTrace?(sessionId, "finish_bgtask_begin", [:])
    DispatchQueue.global().asyncAfter(deadline: .now() + safetyReleaseDelay) { [weak self] in
      self?.release(sessionId: sessionId, reason: "safety_timeout", onlyToken: token)
    }
    return true
  }

  func release(sessionId: String, reason: String) {
    release(sessionId: sessionId, reason: reason, onlyToken: nil)
  }

  private func release(sessionId: String, reason: String, onlyToken: Int?) {
    lock.lock()
    guard let token = tokens[sessionId], onlyToken == nil || onlyToken == token else {
      lock.unlock()
      return
    }
    tokens.removeValue(forKey: sessionId)
    lock.unlock()
    endHook(token)
    onTrace?(sessionId, "finish_bgtask_end", ["reason": reason])
  }

  private func expired(sessionId: String) {
    onTrace?(sessionId, "finish_bgtask_expired", [:])
    onExpire?(sessionId)
    // iOS requires the task to be ended inside the expiration handler.
    release(sessionId: sessionId, reason: "expired")
  }
}
