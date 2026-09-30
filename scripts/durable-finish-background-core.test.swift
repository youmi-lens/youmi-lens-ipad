import AVFoundation
import Foundation

private struct FinishTestFailure: Error, CustomStringConvertible { let description: String }
private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw FinishTestFailure(description: message) }
}

private func writeTone(to url: URL, frequency: Double, seconds: Double) throws {
  let sampleRate = 44_100.0
  let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
  let file = try AVAudioFile(
    forWriting: url,
    settings: [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 96_000,
    ],
    commonFormat: .pcmFormatFloat32,
    interleaved: false
  )
  let frames = AVAudioFrameCount(sampleRate * seconds)
  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
  buffer.frameLength = frames
  let samples = buffer.floatChannelData![0]
  for index in 0..<Int(frames) {
    samples[index] = Float(sin(2 * Double.pi * frequency * Double(index) / sampleRate) * 0.25)
  }
  try file.write(from: buffer)
}

private func addSegment(store: DurableRecorderStore, sessionId: String, frequency: Double) throws {
  let plan = try store.createSegmentPlan(recordingSessionId: sessionId)
  try writeTone(to: plan.activeURL, frequency: frequency, seconds: 0.4)
  let inspection = try SystemDurableAudioFileInspector().inspect(url: plan.activeURL)
  _ = try store.commitSegment(recordingSessionId: sessionId, plan: plan, inspection: inspection)
}

private final class Recorder {
  private let lock = NSLock()
  private(set) var events: [String] = []
  private(set) var begun = 0
  private(set) var ended: [Int] = []
  private(set) var expirations: [() -> Void] = []
  func note(_ event: String) { lock.lock(); events.append(event); lock.unlock() }
  func began(_ expiration: @escaping () -> Void) -> Int {
    lock.lock(); defer { lock.unlock() }
    begun += 1; expirations.append(expiration); return 100 + begun
  }
  func end(_ token: Int) { lock.lock(); ended.append(token); lock.unlock() }
  func snapshot() -> (events: [String], begun: Int, ended: [Int], expirations: [() -> Void]) {
    lock.lock(); defer { lock.unlock() }
    return (events, begun, ended, expirations)
  }
}

@main
private struct FinishBackgroundTests {
  static func main() async throws {
    try assertionLifecycle()
    try await cancellationIsDeterministicAndRetryable()
    print("native finish background tests passed")
  }

  // MARK: background assertion

  static func assertionLifecycle() throws {
    let rec = Recorder()
    let assertion = DurableFinishBackgroundAssertion(
      begin: { _, expiration in rec.began(expiration) },
      end: { rec.end($0) },
      safetyReleaseDelay: 0.05
    )
    assertion.onTrace = { _, kind, _ in rec.note(kind) }
    var expired: [String] = []
    assertion.onExpire = { expired.append($0) }

    // Acquire is idempotent per session; release ends exactly once; a second release is a no-op.
    try require(assertion.acquire(sessionId: "s1"), "acquire must report the task is held")
    try require(assertion.acquire(sessionId: "s1"), "a second acquire for the same session stays held")
    try require(rec.snapshot().begun == 1, "only ONE background task per session")
    try require(assertion.isHeld(sessionId: "s1"), "held after acquire")
    assertion.release(sessionId: "s1", reason: "export_finished")
    assertion.release(sessionId: "s1", reason: "export_finished")
    try require(rec.snapshot().ended == [101], "release must end the task exactly once")
    try require(!assertion.isHeld(sessionId: "s1"), "not held after release")

    // Expiration: the handler must cancel the export (onExpire), end the task, and never leave it dangling.
    try require(assertion.acquire(sessionId: "s2"), "acquire s2")
    let expiration = rec.snapshot().expirations[1]
    expiration()
    try require(expired == ["s2"], "expiration must request export cancellation for that session")
    try require(rec.snapshot().ended == [101, 102], "expiration must end the background task inside the handler")
    try require(!assertion.isHeld(sessionId: "s2"), "not held after expiration")
    let kinds = rec.snapshot().events
    try require(kinds.contains("finish_bgtask_expired") && kinds.contains("finish_bgtask_end"), "expiry must be traced")

    // Denied by the system: no token is recorded and no exception escapes.
    let denied = DurableFinishBackgroundAssertion(begin: { _, _ in nil }, end: { _ in })
    try require(!denied.acquire(sessionId: "s3"), "a denied task is reported, not faked")
    try require(!denied.isHeld(sessionId: "s3"), "denied must not look held")

    // Safety release: a task that is never released (JS never calls export) cannot live forever.
    try require(assertion.acquire(sessionId: "s4"), "acquire s4")
    Thread.sleep(forTimeInterval: 0.3)
    try require(!assertion.isHeld(sessionId: "s4"), "the safety timer must release an orphaned task")
    try require(rec.snapshot().ended.count == 3, "safety release ends the orphaned task once")
  }

  // MARK: deterministic export cancellation

  static func cancellationIsDeterministicAndRetryable() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("durable-finish-background-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try DurableRecorderStore(rootURL: root)
    var session = try store.createSession(lectureId: "lecture-finish-bg")
    let id = session.recordingSessionId
    session = try store.transitionSession(recordingSessionId: id, to: .preparing)
    session = try store.transitionSession(recordingSessionId: id, to: .ready)
    session = try store.transitionSession(recordingSessionId: id, to: .recording)
    try addSegment(store: store, sessionId: id, frequency: 440)
    session = try store.transitionSession(recordingSessionId: id, to: .paused)
    session = try store.transitionSession(recordingSessionId: id, to: .recording)
    try addSegment(store: store, sessionId: id, frequency: 660)
    session = try store.transitionSession(recordingSessionId: id, to: .finalizing)
    session = try store.finalizeSession(recordingSessionId: id)
    let committedSegments = session.segments
    let committedBytes = try committedSegments.map {
      try Data(contentsOf: root.appendingPathComponent(session.relativeSessionPath).appendingPathComponent($0.relativePath))
    }

    let exporter = DurableFinalAssetExporter(store: store)
    let rec = Recorder()
    exporter.onTrace = { _, kind, _ in rec.note(kind) }
    // Simulate "background time expired" the instant the export starts.
    exporter.onTrace = { sessionId, kind, _ in
      rec.note(kind)
      if kind == "finish_export_begin" {
        _ = exporter.cancelExport(recordingSessionId: sessionId, backgroundTimeExpired: true)
      }
    }
    do {
      _ = try await exporter.export(recordingSessionId: id)
      throw FinishTestFailure(description: "A cancelled export must FAIL, never report success")
    } catch let error as FinishTestFailure {
      throw error
    } catch let error as DurableRecorderCoreError {
      try require(error.message.contains(DurableFinalAssetExporter.backgroundTimeExpiredMessage),
                  "The failure must be explicit and actionable, got: \(error.message)")
    }
    let afterCancel = try store.getSession(recordingSessionId: id)
    try require(afterCancel.finalAsset == nil, "A cancelled export must not persist final asset metadata")
    let plan = try store.finalAssetPlan(recordingSessionId: id)
    try require(!FileManager.default.fileExists(atPath: plan.finalURL.path), "No final asset may exist after a cancelled export")
    let bytesAfter = try afterCancel.segments.map {
      try Data(contentsOf: root.appendingPathComponent(afterCancel.relativeSessionPath).appendingPathComponent($0.relativePath))
    }
    try require(bytesAfter == committedBytes, "Committed segments must be untouched by a cancelled export")
    let events = rec.snapshot().events
    try require(events.contains("finish_export_cancelled") && events.last == "finish_export_end", "cancel must be traced: \(events)")

    // The in-flight guard must be released so Finish can simply be retried, and the retry must succeed.
    exporter.onTrace = nil
    let retried = try await exporter.export(recordingSessionId: id)
    let finalURL = URL(string: retried["fileUri"] as! String)!
    let inspection = try SystemDurableAudioFileInspector().inspect(url: finalURL)
    try require(inspection.durationMs >= 700, "Retry must produce the complete final asset, got \(inspection.durationMs) ms")
    let committed = try store.getSession(recordingSessionId: id)
    try require(committed.finalAsset?.sourceSegmentIds == committed.segments.map(\.segmentId), "Every segment included once, in order")

    // Cancelling when nothing is exporting is a harmless no-op.
    try require(!exporter.cancelExport(recordingSessionId: id, backgroundTimeExpired: true), "no export in flight")
  }
}
