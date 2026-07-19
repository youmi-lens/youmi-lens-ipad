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

@main
private struct RecoveryTests {
  static func main() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("durable-recovery-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }

    try await resumeAfterForcedRelaunch(root: root)
    try discardAfterForcedRelaunch(root: root)
    try interruptedCaptureKeepsEvidence(root: root)

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
}
