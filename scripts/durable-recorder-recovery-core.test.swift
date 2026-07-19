import AVFoundation
import CryptoKit
import Foundation

// Phase 2C forced-relaunch recovery coverage.
//
// A process relaunch is modelled by discarding the DurableRecorderStore
// instance and rebuilding a new one over the same root directory. That is
// faithful: the store keeps no in-memory session cache, so every read already
// comes from disk exactly as it would after a cold start.

private struct RecoveryTestFailure: Error, CustomStringConvertible { let description: String }

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw RecoveryTestFailure(description: message) }
}

private func digest(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
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

/// Drives one segment through the real capture persistence path.
private func addSegment(
  store: DurableRecorderStore,
  sessionId: String,
  frequency: Double,
  seconds: Double = 0.4
) throws -> (session: DurableRecordingSession, bytes: Data) {
  let plan = try store.createSegmentPlan(recordingSessionId: sessionId)
  try writeTone(to: plan.activeURL, frequency: frequency, seconds: seconds)
  let inspection = try SystemDurableAudioFileInspector().inspect(url: plan.activeURL)
  let session = try store.commitSegment(
    recordingSessionId: sessionId,
    plan: plan,
    inspection: inspection
  )
  return (session, try Data(contentsOf: plan.finalizedURL))
}

private func segmentURL(
  root: URL,
  _ session: DurableRecordingSession,
  _ index: Int
) -> URL {
  root
    .appendingPathComponent(session.relativeSessionPath)
    .appendingPathComponent(session.segments[index].relativePath)
}

private func alwaysValidAudio(_ url: URL) -> Bool {
  (try? SystemDurableAudioFileInspector().inspect(url: url)) != nil
}

private final class RecoveryFakeAudioSession: DurableAudioSessionManaging {
  var permissionState: DurableRecorderPermissionState = .granted
  var hasSuitableInput = true
  var routeDescription = "builtInMic:Recovery test"
  func requestPermission() async -> DurableRecorderPermissionState { permissionState }
  func activateForRecording() throws {
    if !hasSuitableInput { throw DurableRecorderCoreError.noAudioInput }
  }
  func deactivate() {}
}

private final class RecoveryFakeCapture: DurableAudioCapture {
  private let url: URL
  private(set) var isRecording = false
  init(url: URL) { self.url = url }
  func prepareToRecord() -> Bool { true }
  func record() -> Bool {
    isRecording = true
    FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 9, count: 4_096))
    return true
  }
  func stop() { isRecording = false }
}

private final class RecoveryFakeCaptureFactory: DurableAudioCaptureFactory {
  func makeCapture(url: URL) throws -> DurableAudioCapture { RecoveryFakeCapture(url: url) }
}

private struct RecoveryFakeFileInspector: DurableAudioFileInspecting {
  func inspect(url: URL) throws -> DurableAudioFileInspection {
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    guard size > 0 else {
      throw DurableRecorderCoreError.segmentValidationFailed("empty recovery test asset")
    }
    return DurableAudioFileInspection(
      durationMs: 1_000,
      byteLength: Int64(size),
      sampleRate: 44_100,
      channelCount: 1
    )
  }
}

private func makeRecoveryEngine(root: URL) throws -> (DurableRecorderStore, DurableForegroundRecorder) {
  let store = try DurableRecorderStore(rootURL: root)
  let engine = DurableForegroundRecorder(
    store: store,
    audioSession: RecoveryFakeAudioSession(),
    captureFactory: RecoveryFakeCaptureFactory(),
    fileInspector: RecoveryFakeFileInspector(),
    observeSystemNotifications: false
  )
  return (store, engine)
}

@main
private struct RecoveryTests {
  static func main() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("durable-recovery-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }

    try await resumeAfterForcedRelaunch(root: root)
    try discardAfterForcedRelaunch(root: root)
    try interruptedCaptureKeepsEvidence(root: root)
    try await finishDirectlyAfterForcedRelaunch(root: root)
    try await finishRejectsCompetingLiveOwner(root: root)
    try await finishIdempotentWhenAlreadyOwned(root: root)
    try await finishReusesFinalizedAssetWithoutRecording(root: root)

    print("native recovery tests passed")
  }

  // MARK: Scenario A — resume an unfinished session across a forced relaunch.

  static func resumeAfterForcedRelaunch(root: URL) async throws {
    let lectureId = "lecture-recovery-resume"

    // --- Launch 1: record segment 1, then pause. ---
    var sessionId = ""
    var firstSegmentId = ""
    var firstBytes = Data()
    do {
      let store = try DurableRecorderStore(rootURL: root)
      var session = try store.createSession(lectureId: lectureId)
      sessionId = session.recordingSessionId
      session = try store.transitionSession(recordingSessionId: sessionId, to: .preparing)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .ready)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .recording)
      let first = try addSegment(store: store, sessionId: sessionId, frequency: 440)
      session = first.session
      firstBytes = first.bytes
      firstSegmentId = session.segments[0].segmentId
      session = try store.transitionSession(recordingSessionId: sessionId, to: .paused)

      try require(session.segments.count == 1, "Exactly one segment must exist before termination")
      try require(session.segments[0].sequence == 1, "First segment must carry sequence 1")
      try require(session.segments[0].byteLength > 0, "Segment 1 must be non-empty")
      try require(session.segments[0].durationMs > 0, "Segment 1 must have a readable duration")
    }
    let preRelaunchDigest = digest(firstBytes)

    // --- Forced termination: the store instance is dropped entirely. ---

    // --- Launch 2: the unfinished session must be rediscovered from disk. ---
    let relaunched = try DurableRecorderStore(rootURL: root)
    let discovered = try relaunched.listRecoverableSessions()
    try require(
      discovered.contains { $0.recordingSessionId == sessionId },
      "The unfinished session must be rediscovered after relaunch"
    )
    let recoveredCandidate = discovered.first { $0.recordingSessionId == sessionId }!
    try require(recoveredCandidate.lectureId == lectureId, "Recovery must resolve the original lecture identity")
    try require(recoveredCandidate.state == .paused, "The rediscovered session must still be paused")
    try require(recoveredCandidate.segments.count == 1, "Recovery must not lose or duplicate segment 1")
    try require(recoveredCandidate.segments[0].segmentId == firstSegmentId, "Segment 1 identity must survive relaunch")
    try require(recoveredCandidate.finalAsset == nil, "An unfinished session must not carry a final asset")

    // Segment bytes must be untouched by the crash.
    let survivingBytes = try Data(contentsOf: segmentURL(root: root, recoveredCandidate, 0))
    try require(digest(survivingBytes) == preRelaunchDigest, "Segment 1 must survive relaunch byte-for-byte")
    let survivingDuration = try SystemDurableAudioFileInspector()
      .inspect(url: segmentURL(root: root, recoveredCandidate, 0)).durationMs
    try require(survivingDuration > 0, "Recovered segment 1 must remain probeable audio")

    // Reconciliation must report a clean, resumable session.
    let reconciled = try relaunched.reconcileSession(
      recordingSessionId: sessionId,
      inspectAudioFile: alwaysValidAudio
    )
    let blocking = ["missing_referenced_file", "invalid_referenced_file", "incomplete_temporary_file", "invalid_orphan_file"]
    try require(
      !reconciled.issues.contains { blocking.contains($0.code) },
      "A cleanly paused session must reconcile without blocking issues"
    )

    // --- Resume: append segment 2 to the SAME durable session. ---
    var session = try relaunched.transitionSession(recordingSessionId: sessionId, to: .recording)
    let second = try addSegment(store: relaunched, sessionId: sessionId, frequency: 880)
    session = second.session
    try require(session.recordingSessionId == sessionId, "Resume must not create a new durable session")
    try require(session.segments.count == 2, "Resume must append exactly one new segment")
    try require(session.segments[0].segmentId == firstSegmentId, "Resume must preserve segment 1 identity")
    try require(session.segments[1].segmentId != firstSegmentId, "Segment 2 must be a distinct immutable segment")
    try require(session.segments.map(\.sequence) == [1, 2], "Segment order must be strictly sequential")
    let firstAfterResume = digest(try Data(contentsOf: segmentURL(root: root, session, 0)))
    try require(
      firstAfterResume == preRelaunchDigest,
      "Appending segment 2 must leave segment 1 immutable"
    )

    // --- Finish and export the final asset. ---
    session = try relaunched.transitionSession(recordingSessionId: sessionId, to: .finalizing)
    session = try relaunched.finalizeSession(recordingSessionId: sessionId)
    let exporter = DurableFinalAssetExporter(store: relaunched)
    let exported = try await exporter.export(recordingSessionId: sessionId)
    let fileUri = exported["fileUri"] as! String
    let finalURL = URL(string: fileUri)!

    let finalized = try relaunched.getSession(recordingSessionId: sessionId)
    try require(finalized.state == .finalized, "The session must reach the finalized state")
    try require(
      finalized.finalAsset?.sourceSegmentIds == finalized.segments.map(\.segmentId),
      "Final metadata must list every segment exactly once, in order"
    )
    try require(finalized.finalAsset?.sourceSegmentIds.count == 2, "The final asset must be built from both segments")
    try require(FileManager.default.fileExists(atPath: finalURL.path), "The final asset file must exist")
    let finalBytes = try Data(contentsOf: finalURL)
    try require(finalBytes.count > 0, "The final asset must be non-empty")

    // The merged asset must actually contain both segments' audio.
    let finalDuration = try SystemDurableAudioFileInspector().inspect(url: finalURL).durationMs
    let sourceDuration = finalized.segments.reduce(0) { $0 + $1.durationMs }
    try require(
      abs(finalDuration - sourceDuration) <= 400,
      "Final duration \(finalDuration)ms must match the combined sources \(sourceDuration)ms"
    )

    // --- Handoff must happen exactly once. ---
    let pendingHandoff = try relaunched.listRecoverableSessions()
    try require(
      pendingHandoff.contains { $0.recordingSessionId == sessionId },
      "Finalized audio must stay discoverable until the lecture handoff is acknowledged"
    )
    let acknowledged = try relaunched.acknowledgeFinalAssetHandoff(recordingSessionId: sessionId)
    let handoffAt = acknowledged.handoffCompletedAt
    try require(handoffAt != nil, "Handoff acknowledgment must be durable")

    // --- Launch 3: a relaunch must not re-offer an acknowledged session. ---
    let afterHandoff = try DurableRecorderStore(rootURL: root)
    let offeredAfterHandoff = try afterHandoff.listRecoverableSessions()
    try require(
      !offeredAfterHandoff.contains { $0.recordingSessionId == sessionId },
      "A relaunch must not trigger a duplicate downstream handoff"
    )
    let reacknowledged = try afterHandoff.acknowledgeFinalAssetHandoff(recordingSessionId: sessionId)
    try require(
      reacknowledged.handoffCompletedAt == handoffAt,
      "Repeated acknowledgment must be idempotent and keep the original timestamp"
    )
    let reExported = try await DurableFinalAssetExporter(store: afterHandoff).export(recordingSessionId: sessionId)
    try require(
      (reExported["fileUri"] as? String) == fileUri,
      "Repeated export after relaunch must return the same stable asset"
    )
    let finalAfterReexport = digest(try Data(contentsOf: finalURL))
    try require(
      finalAfterReexport == digest(finalBytes),
      "Repeated export must not rewrite the final asset"
    )
    let segmentsAfterRelaunch = try afterHandoff.getSession(recordingSessionId: sessionId).segments.count
    try require(
      segmentsAfterRelaunch == 2,
      "Relaunch must not duplicate segments"
    )
  }

  // MARK: Scenario B — discard an unfinished session after a forced relaunch.

  static func discardAfterForcedRelaunch(root: URL) throws {
    let lectureId = "lecture-recovery-discard"
    var sessionId = ""
    do {
      let store = try DurableRecorderStore(rootURL: root)
      var session = try store.createSession(lectureId: lectureId)
      sessionId = session.recordingSessionId
      session = try store.transitionSession(recordingSessionId: sessionId, to: .preparing)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .ready)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .recording)
      session = try addSegment(store: store, sessionId: sessionId, frequency: 660).session
      _ = try store.transitionSession(recordingSessionId: sessionId, to: .paused)
    }

    // --- Relaunch and discard. ---
    let relaunched = try DurableRecorderStore(rootURL: root)
    let offeredBeforeDiscard = try relaunched.listRecoverableSessions()
    try require(
      offeredBeforeDiscard.contains { $0.recordingSessionId == sessionId },
      "The discardable session must be offered after relaunch"
    )
    let session = try relaunched.getSession(recordingSessionId: sessionId)
    let sessionDirectory = root.appendingPathComponent(session.relativeSessionPath)
    try require(
      FileManager.default.fileExists(atPath: sessionDirectory.path),
      "Durable state must exist before discard"
    )

    _ = try relaunched.reconcileSession(recordingSessionId: sessionId, inspectAudioFile: alwaysValidAudio)
    let abandoned = try relaunched.abandonSession(recordingSessionId: sessionId)
    try require(abandoned.state == .abandoned, "Discard must move the session to a terminal state")
    let deleted = try relaunched.deleteSession(recordingSessionId: sessionId)
    try require(deleted, "Discard must delete durable state")

    // --- Everything must be gone, and nothing may have been produced. ---
    try require(
      !FileManager.default.fileExists(atPath: sessionDirectory.path),
      "Discard must remove the durable session directory and its segments"
    )
    let offeredAfterDiscard = try relaunched.listRecoverableSessions()
    try require(
      !offeredAfterDiscard.contains { $0.recordingSessionId == sessionId },
      "A discarded session must not be offered again"
    )
    try require(abandoned.finalAsset == nil, "Discard must never produce a downstream asset")
    do {
      _ = try relaunched.getSession(recordingSessionId: sessionId)
      throw RecoveryTestFailure(description: "A discarded session must no longer be readable")
    } catch let failure as RecoveryTestFailure {
      throw failure
    } catch {
      // Expected: the session is gone.
    }

    // --- A further relaunch must not resurrect it. ---
    let afterDiscard = try DurableRecorderStore(rootURL: root)
    let offeredAfterRelaunch = try afterDiscard.listRecoverableSessions()
    try require(
      !offeredAfterRelaunch.contains { $0.recordingSessionId == sessionId },
      "A relaunch after discard must not resurrect the session"
    )
  }

  // MARK: Scenario C — a kill mid-capture must preserve evidence, never hide it.

  static func interruptedCaptureKeepsEvidence(root: URL) throws {
    let lectureId = "lecture-recovery-interrupted"
    var sessionId = ""
    do {
      let store = try DurableRecorderStore(rootURL: root)
      var session = try store.createSession(lectureId: lectureId)
      sessionId = session.recordingSessionId
      session = try store.transitionSession(recordingSessionId: sessionId, to: .preparing)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .ready)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .recording)
      // Capture starts but the process dies before the segment is committed.
      let plan = try store.createSegmentPlan(recordingSessionId: sessionId)
      try writeTone(to: plan.activeURL, frequency: 550, seconds: 0.4)
    }

    let relaunched = try DurableRecorderStore(rootURL: root)
    let offeredAfterInterruption = try relaunched.listRecoverableSessions()
    try require(
      offeredAfterInterruption.contains { $0.recordingSessionId == sessionId },
      "A session interrupted mid-capture must still be offered for recovery"
    )
    let reconciled = try relaunched.reconcileSession(
      recordingSessionId: sessionId,
      inspectAudioFile: alwaysValidAudio
    )
    try require(
      reconciled.issues.contains { $0.code == "incomplete_temporary_file" },
      "An interrupted capture must be reported, never silently dropped"
    )
    try require(
      reconciled.session.segments.isEmpty,
      "An uncommitted capture must not appear as a committed segment"
    )
  }

  // MARK: Scenario D — Finish directly after relaunch (no Resume).

  static func finishDirectlyAfterForcedRelaunch(root: URL) async throws {
    let lectureId = "lecture-recovery-finish-direct"
    var sessionId = ""
    var firstSegmentId = ""
    var firstDigest = ""
    do {
      let store = try DurableRecorderStore(rootURL: root)
      var session = try store.createSession(lectureId: lectureId)
      sessionId = session.recordingSessionId
      session = try store.transitionSession(recordingSessionId: sessionId, to: .preparing)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .ready)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .recording)
      let first = try addSegment(store: store, sessionId: sessionId, frequency: 520)
      session = first.session
      firstSegmentId = session.segments[0].segmentId
      firstDigest = digest(first.bytes)
      _ = try store.transitionSession(recordingSessionId: sessionId, to: .paused)
    }

    // Cold relaunch: new engine, no prior claim, no Resume.
    let (store, engine) = try makeRecoveryEngine(root: root)
    let recovery = try engine.recoverRecordingSession(recordingSessionId: sessionId)
    try require(recovery.session.state == .paused, "Recovered session must remain paused")
    try require(recovery.session.segments.count == 1, "Committed segment must survive relaunch")
    let recoveredDigest = digest(try Data(contentsOf: segmentURL(root: root, recovery.session, 0)))
    try require(
      recoveredDigest == firstDigest,
      "Finish-after-relaunch must preserve committed segment bytes"
    )

    let stopped = try engine.stopRecording(recordingSessionId: sessionId)
    let stoppedSession = stopped["session"] as! [String: Any]
    try require((stoppedSession["state"] as? String) == "finalized", "Direct Finish must finalize without Resume")
    try require((stopped["runtimeState"] as? String) == "idle", "Finish must release runtime ownership")

    let exported = try await DurableFinalAssetExporter(store: store).export(recordingSessionId: sessionId)
    let fileUri = exported["fileUri"] as! String
    let finalURL = URL(string: fileUri)!
    let finalBytes = try Data(contentsOf: finalURL)
    try require(!finalBytes.isEmpty, "Direct Finish must produce a non-empty final asset")
    let finalized = try store.getSession(recordingSessionId: sessionId)
    try require(finalized.finalAsset != nil, "Final metadata must be present after export")
    try require(
      finalized.finalAsset?.sourceSegmentIds == [firstSegmentId],
      "Final asset must reference the committed segment only"
    )
    let segmentAfterExport = digest(try Data(contentsOf: segmentURL(root: root, finalized, 0)))
    try require(
      segmentAfterExport == firstDigest,
      "Export must leave committed segment bytes immutable"
    )

    // Repeated Finish / export must stay idempotent.
    let stoppedAgain = try engine.stopRecording(recordingSessionId: sessionId)
    try require(
      ((stoppedAgain["session"] as? [String: Any])?["state"] as? String) == "finalized",
      "Repeated Finish on a finalized session must remain safe"
    )
    let reExported = try await DurableFinalAssetExporter(store: store).export(recordingSessionId: sessionId)
    try require((reExported["fileUri"] as? String) == fileUri, "Repeated export must return the same URI")
    let finalAfterRepeat = digest(try Data(contentsOf: finalURL))
    try require(
      finalAfterRepeat == digest(finalBytes),
      "Repeated export must not rewrite final asset bytes"
    )

    let acknowledged = try store.acknowledgeFinalAssetHandoff(recordingSessionId: sessionId)
    try require(acknowledged.handoffCompletedAt != nil, "Handoff acknowledgement must still work after direct Finish")
  }

  // MARK: Scenario E — Finish must not steal a live competing owner.

  static func finishRejectsCompetingLiveOwner(root: URL) async throws {
    let (store, engine) = try makeRecoveryEngine(root: root)
    let owned = try store.createSession(lectureId: "lecture-owner-live")
    _ = try await engine.prepareRecording(recordingSessionId: owned.recordingSessionId, requestPermission: false)

    var victim = try store.createSession(lectureId: "lecture-owner-victim")
    victim = try store.transitionSession(recordingSessionId: victim.recordingSessionId, to: .preparing)
    victim = try store.transitionSession(recordingSessionId: victim.recordingSessionId, to: .ready)
    victim = try store.transitionSession(recordingSessionId: victim.recordingSessionId, to: .recording)
    let committed = try addSegment(store: store, sessionId: victim.recordingSessionId, frequency: 610)
    victim = committed.session
    victim = try store.transitionSession(recordingSessionId: victim.recordingSessionId, to: .paused)
    let beforeDigest = digest(committed.bytes)
    let beforeState = victim.state

    do {
      _ = try engine.stopRecording(recordingSessionId: victim.recordingSessionId)
      throw RecoveryTestFailure(description: "Finish stole a session while another live owner held the recorder")
    } catch is RecoveryTestFailure {
      throw RecoveryTestFailure(description: "Finish stole a session while another live owner held the recorder")
    } catch let error as DurableRecorderCoreError {
      try require(error == .recorderBusy, "Competing Finish must fail with recorderBusy")
    }

    let after = try store.getSession(recordingSessionId: victim.recordingSessionId)
    try require(after.state == beforeState, "Rejected Finish must not mutate victim session state")
    try require(after.segments.count == 1, "Rejected Finish must not delete committed segments")
    try require(after.finalAsset == nil, "Rejected Finish must not create a final asset")
    let afterDigest = digest(try Data(contentsOf: segmentURL(root: root, after, 0)))
    try require(
      afterDigest == beforeDigest,
      "Rejected Finish must leave committed audio untouched"
    )
  }

  // MARK: Scenario F — Finish still works when this process already owns the session.

  static func finishIdempotentWhenAlreadyOwned(root: URL) async throws {
    let (store, engine) = try makeRecoveryEngine(root: root)
    var session = try store.createSession(lectureId: "lecture-already-owned")
    let sessionId = session.recordingSessionId
    session = try store.transitionSession(recordingSessionId: sessionId, to: .preparing)
    session = try store.transitionSession(recordingSessionId: sessionId, to: .ready)
    session = try store.transitionSession(recordingSessionId: sessionId, to: .recording)
    session = try addSegment(store: store, sessionId: sessionId, frequency: 480).session
    session = try store.transitionSession(recordingSessionId: sessionId, to: .paused)
    try require(session.segments.count == 1, "Precondition: one committed segment")

    // prepareRecording claims a paused session without opening a new segment.
    _ = try await engine.prepareRecording(recordingSessionId: sessionId, requestPermission: false)
    let stopped = try engine.stopRecording(recordingSessionId: sessionId)
    try require(
      ((stopped["session"] as? [String: Any])?["state"] as? String) == "finalized",
      "Finish must succeed when the current process already owns the session"
    )
    let exported = try await DurableFinalAssetExporter(store: store).export(recordingSessionId: sessionId)
    try require(((exported["fileUri"] as? String)?.isEmpty) == false, "Owned Finish must export a final asset")
    let afterOwnedFinish = try store.getSession(recordingSessionId: sessionId)
    try require(
      afterOwnedFinish.segments.count == 1,
      "Owned Finish must not invent extra segments"
    )
  }

  // MARK: Scenario G — Finalized recovery reuses the asset; no new recording.

  static func finishReusesFinalizedAssetWithoutRecording(root: URL) async throws {
    let lectureId = "lecture-recovery-finalized"
    var sessionId = ""
    var fileUri = ""
    var finalDigest = ""
    do {
      let store = try DurableRecorderStore(rootURL: root)
      var session = try store.createSession(lectureId: lectureId)
      sessionId = session.recordingSessionId
      session = try store.transitionSession(recordingSessionId: sessionId, to: .preparing)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .ready)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .recording)
      session = try addSegment(store: store, sessionId: sessionId, frequency: 700).session
      session = try store.transitionSession(recordingSessionId: sessionId, to: .paused)
      session = try store.transitionSession(recordingSessionId: sessionId, to: .finalizing)
      session = try store.finalizeSession(recordingSessionId: sessionId)
      let exported = try await DurableFinalAssetExporter(store: store).export(recordingSessionId: sessionId)
      fileUri = exported["fileUri"] as! String
      finalDigest = digest(try Data(contentsOf: URL(string: fileUri)!))
    }

    let (store, engine) = try makeRecoveryEngine(root: root)
    let offered = try store.listRecoverableSessions()
    try require(
      offered.contains { $0.recordingSessionId == sessionId },
      "Finalized-but-unacked sessions must remain recoverable"
    )
    let stopped = try engine.stopRecording(recordingSessionId: sessionId)
    try require(
      ((stopped["session"] as? [String: Any])?["state"] as? String) == "finalized",
      "Finish on an already-finalized session must not restart recording"
    )
    let reExported = try await DurableFinalAssetExporter(store: store).export(recordingSessionId: sessionId)
    try require((reExported["fileUri"] as? String) == fileUri, "Recovery Finish must reuse the existing final URI")
    let reusedDigest = digest(try Data(contentsOf: URL(string: fileUri)!))
    try require(
      reusedDigest == finalDigest,
      "Recovery Finish must not rewrite or duplicate the final asset"
    )
    let session = try store.getSession(recordingSessionId: sessionId)
    try require(session.segments.count == 1, "Finalized recovery must not append new segments")
  }
}
