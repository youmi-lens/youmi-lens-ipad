import Foundation

// Recording reliability invariant: once recording starts it keeps running through background/lock checkpoints, other
// subsystems changing the shared AVAudioSession, and ordinary route changes; a recorder the OS will not let continue
// lands in a TRUTHFUL pause with every committed segment intact.
//
// Physical evidence this encodes (Dev build a6ceb0b, 2026-09-30): at three consecutive 60 s checkpoints with the app in
// the background, the rollover's redundant `setCategory` was refused with OSStatus 560557684 ('!int') — even when the
// category was already identical — so segment N+1 never opened and the recorder protectively paused.
//
// `OwnershipSession` reproduces that iOS rule: while the app is in the background, ANY attempt to change the category
// or activate the session throws '!int'. Only an already-active, recording-compatible session may be reused.

private struct OwnershipFailure: Error, CustomStringConvertible { let description: String }
private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if !(try condition()) { throw OwnershipFailure(description: message) }
}

private let cannotInterruptOthers = NSError(domain: NSOSStatusErrorDomain, code: 560_557_684)

private final class OwnershipSession: DurableAudioSessionManaging {
  var permissionState: DurableRecorderPermissionState = .granted
  var hasSuitableInput = true
  var routeDescription = "MicrophoneBuiltIn:iPad Microphone"
  var appInBackground = false
  private(set) var heldActive = false
  var category = "none"
  private(set) var setCategoryCalls = 0
  private(set) var reuseCalls = 0
  private(set) var deactivations = 0
  /// Number of upcoming full (re)configurations that fail transiently even in the foreground.
  var transientFailures = 0
  private(set) var lastActivationStage = "idle"

  func requestPermission() async -> DurableRecorderPermissionState { permissionState }
  func activateForRecording() throws { try activateForRecording(reassertConfiguration: true) }

  func activateForRecording(reassertConfiguration: Bool) throws {
    let compatible = category == "record" || category == "playAndRecord"
    if !reassertConfiguration, heldActive, compatible {
      reuseCalls += 1
      lastActivationStage = "input_availability"
      guard hasSuitableInput else { throw DurableRecorderCoreError.noAudioInput }
      lastActivationStage = "activated"
      return
    }
    lastActivationStage = "set_category"
    setCategoryCalls += 1
    if appInBackground { throw cannotInterruptOthers }
    if transientFailures > 0 { transientFailures -= 1; throw cannotInterruptOthers }
    category = "record"
    lastActivationStage = "set_active"
    heldActive = true
    lastActivationStage = "input_availability"
    guard hasSuitableInput else { heldActive = false; throw DurableRecorderCoreError.noAudioInput }
    lastActivationStage = "activated"
  }

  func deactivate() { heldActive = false; deactivations += 1 }

  /// Another Youmi subsystem (live captions) reconfigures the shared session while recording.
  func otherSubsystemSetsCategory(_ value: String) { category = value }
}

private final class OwnershipCapture: DurableAudioCapture {
  private let url: URL
  private let shouldStart: Bool
  private let tracker: CaptureTracker
  private(set) var isRecording = false
  init(url: URL, shouldStart: Bool, tracker: CaptureTracker) {
    self.url = url; self.shouldStart = shouldStart; self.tracker = tracker
  }
  func prepareToRecord() -> Bool { shouldStart }
  func record() -> Bool {
    guard shouldStart else { return false }
    isRecording = true
    tracker.started()
    FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 7, count: 4_096))
    return true
  }
  func stop() {
    if isRecording { tracker.stopped() }
    isRecording = false
  }
}

private final class CaptureTracker {
  private(set) var live = 0
  private(set) var maxLive = 0
  var created = 0
  var failNext = 0
  func started() { live += 1; maxLive = max(maxLive, live) }
  func stopped() { live -= 1 }
}

private final class OwnershipFactory: DurableAudioCaptureFactory {
  let tracker = CaptureTracker()
  func makeCapture(url: URL) throws -> DurableAudioCapture {
    tracker.created += 1
    let shouldStart = tracker.failNext == 0
    if tracker.failNext > 0 { tracker.failNext -= 1 }
    return OwnershipCapture(url: url, shouldStart: shouldStart, tracker: tracker)
  }
}

private struct OwnershipInspector: DurableAudioFileInspecting {
  func inspect(url: URL) throws -> DurableAudioFileInspection {
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    guard size > 0 else { throw DurableRecorderCoreError.segmentValidationFailed("empty test asset") }
    return DurableAudioFileInspection(durationMs: 60_000, byteLength: Int64(size), sampleRate: 44_100, channelCount: 1)
  }
}

private struct Rig {
  let root: URL
  let store: DurableRecorderStore
  let engine: DurableForegroundRecorder
  let session: OwnershipSession
  let factory: OwnershipFactory
  let sessionId: String
}

private func makeRig(_ label: String) async throws -> Rig {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("durable-ownership-\(label)-\(UUID().uuidString)", isDirectory: true)
  let store = try DurableRecorderStore(rootURL: root)
  let session = OwnershipSession()
  let factory = OwnershipFactory()
  let engine = DurableForegroundRecorder(
    store: store,
    audioSession: session,
    captureFactory: factory,
    fileInspector: OwnershipInspector(),
    checkpointInterval: 0,
    observeSystemNotifications: false,
    checkpointRetryPolicy: DurableCheckpointRetryPolicy(sleep: { _ in })
  )
  let created = try store.createSession(lectureId: "lecture-\(label)")
  _ = try await engine.prepareRecording(recordingSessionId: created.recordingSessionId, requestPermission: false)
  _ = try engine.startRecording(recordingSessionId: created.recordingSessionId)
  return Rig(root: root, store: store, engine: engine, session: session, factory: factory, sessionId: created.recordingSessionId)
}

private func runtime(_ rig: Rig) -> String { rig.engine.getRecordingStatus()["runtimeState"] as? String ?? "?" }
private func interruption(_ rig: Rig) -> String? { rig.engine.getRecordingStatus()["interruptionState"] as? String }
private func persisted(_ rig: Rig) throws -> DurableRecordingSession { try rig.store.getSession(recordingSessionId: rig.sessionId) }
private func segmentBytes(_ rig: Rig, _ segment: DurableRecordingSegmentMetadata) throws -> Data {
  let session = try persisted(rig)
  return try Data(contentsOf: rig.root.appendingPathComponent(session.relativeSessionPath).appendingPathComponent(segment.relativePath))
}

@main
private struct OwnershipTests {
  static func main() async throws {
    try await backgroundCheckpointContinues()
    try await captionsChangingTheCategoryDoesNotBreakBackgroundCheckpoint()
    try await lockScreenMultipleCheckpointsContinue()
    try await transientSessionFailureRecoversWithoutPause()
    try await persistentFailureIsTruthfulAndPreservesAudio()
    try await explicitPauseResumeStillReassertsConfiguration()
    try await routeLossWithFallbackInputRecoversAutomatically()
    try await routeLossWithoutInputPausesTruthfully()
    try await failedRouteRecoveryPausesWithDistinctReason()
    try await foregroundAutoRecoveryIsBoundedAndNeverOverridesUserPause()
    print("native audio-session ownership tests passed")
  }

  // 2 + 8 + 1. Background checkpoint: the session is reused, never reconfigured; one recorder at a time.
  static func backgroundCheckpointContinues() async throws {
    let rig = try await makeRig("background")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    let calls = rig.session.setCategoryCalls
    rig.session.appInBackground = true
    try rig.engine.performCheckpointForTesting()
    try require(runtime(rig) == "recording", "a background checkpoint must continue recording, got \(runtime(rig))")
    try require(try persisted(rig).state == .recording, "manifest state must stay recording")
    try require(rig.session.setCategoryCalls == calls, "the rollover must not call setCategory/setActive again")
    try require(rig.session.reuseCalls == 1, "the rollover reuses the active session exactly once")
    let session = try persisted(rig)
    try require(session.segments.map(\.sequence) == [1], "old segment committed")
    try require(rig.factory.tracker.live == 1 && rig.factory.tracker.maxLive == 1, "exactly one recorder, never overlapping")
    try require(interruption(rig) == nil, "no protective pause marker")
  }

  // 1. Live captions turn the category into PlayAndRecord; that is recording-compatible, so it must be reused.
  static func captionsChangingTheCategoryDoesNotBreakBackgroundCheckpoint() async throws {
    let rig = try await makeRig("captions")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    rig.session.otherSubsystemSetsCategory("playAndRecord")
    rig.session.appInBackground = true
    let calls = rig.session.setCategoryCalls
    try rig.engine.performCheckpointForTesting()
    try require(runtime(rig) == "recording", "live caption's PlayAndRecord must not stop the recording")
    try require(rig.session.setCategoryCalls == calls, "no category transition is forced on the shared session")
    try require(rig.factory.tracker.maxLive == 1, "no overlapping recorders")
  }

  // 3. Lock screen == background for the recorder: several consecutive checkpoints, all continue.
  static func lockScreenMultipleCheckpointsContinue() async throws {
    let rig = try await makeRig("lock")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    rig.session.appInBackground = true
    for _ in 1...4 { try rig.engine.performCheckpointForTesting() }
    try require(runtime(rig) == "recording", "four locked checkpoints in a row must keep recording")
    let session = try persisted(rig)
    try require(session.segments.map(\.sequence) == [1, 2, 3, 4], "every checkpoint committed its segment in order")
    try require(rig.factory.tracker.maxLive == 1, "never two recorders at once")
  }

  // 4 + 5. A transient audio-session failure gets the bounded retry (full reassert, foreground) and never pauses.
  static func transientSessionFailureRecoversWithoutPause() async throws {
    let rig = try await makeRig("transient")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    // Something made the held session unusable for reuse (e.g. an incompatible category), and the first full
    // reconfiguration fails transiently.
    rig.session.otherSubsystemSetsCategory("playback")
    rig.session.transientFailures = 1
    let before = rig.session.setCategoryCalls
    try rig.engine.performCheckpointForTesting()
    try require(runtime(rig) == "recording", "a recovered transient failure must not leave the recorder paused")
    try require(rig.session.setCategoryCalls - before == 2, "exactly one retry: attempt 1 + attempt 2")
    try require(try persisted(rig).state == .recording, "manifest says recording")
    try require(interruption(rig) == nil, "a successful recovery is transparent (no pause reason)")
  }

  // 6 + 7. Unrecoverable in the background: truthful pause, committed audio untouched, nothing pretends to record.
  static func persistentFailureIsTruthfulAndPreservesAudio() async throws {
    let rig = try await makeRig("persistent")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    rig.session.otherSubsystemSetsCategory("playback") // not reusable
    rig.session.appInBackground = true                 // and iOS refuses to change it
    do {
      try rig.engine.performCheckpointForTesting()
      throw OwnershipFailure(description: "an unrecoverable rollover must surface its failure")
    } catch let failure as OwnershipFailure { throw failure } catch {}
    try require(runtime(rig) == "paused", "must report paused, never a false Recording: \(runtime(rig))")
    let session = try persisted(rig)
    try require(session.state == .paused, "manifest state is paused")
    try require(interruption(rig) == "checkpoint_begin_segment_failed", "distinguishable, explicit reason")
    try require(session.segments.map(\.sequence) == [1], "the old segment stays committed")
    try require(rig.factory.tracker.live == 0, "no recorder is left running")
    let bytes = try segmentBytes(rig, session.segments[0])
    try require(bytes.count == 4_096, "committed segment bytes untouched")
  }

  // Start/Resume are not checkpoint rollovers: they keep the full configuration sequence.
  static func explicitPauseResumeStillReassertsConfiguration() async throws {
    let rig = try await makeRig("pauseresume")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    _ = try rig.engine.pauseRecording(recordingSessionId: rig.sessionId)
    try require(runtime(rig) == "paused", "explicit pause pauses")
    let before = rig.session.setCategoryCalls
    _ = try rig.engine.resumeRecording(recordingSessionId: rig.sessionId)
    try require(runtime(rig) == "recording", "resume records")
    try require(rig.session.setCategoryCalls == before + 1, "Resume re-asserts the recording configuration")
  }

  // 9. AirPods removed while a built-in mic is available: transparent recovery, in the background too.
  static func routeLossWithFallbackInputRecoversAutomatically() async throws {
    let rig = try await makeRig("routeok")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    rig.session.appInBackground = true
    rig.session.routeDescription = "MicrophoneBuiltIn:iPad Microphone"
    rig.engine.simulateRouteLossForTesting()
    try require(runtime(rig) == "recording", "a valid fallback input keeps the recorder recording")
    let session = try persisted(rig)
    try require(session.state == .recording, "manifest says recording")
    try require(session.segments.map(\.sequence) == [1], "the pre-route-change audio was committed")
    try require(session.segments[0].interruptionReason == "route_old_device_unavailable", "commit reason records why")
    try require(rig.factory.tracker.live == 1 && rig.factory.tracker.maxLive == 1, "one live recorder on the new route")
  }

  // 10. iOS provides no microphone at all: explicit pause, data preserved. Not hidden.
  static func routeLossWithoutInputPausesTruthfully() async throws {
    let rig = try await makeRig("routeno")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    rig.session.hasSuitableInput = false
    rig.engine.simulateRouteLossForTesting()
    try require(runtime(rig) == "paused", "no usable input means a truthful pause")
    let session = try persisted(rig)
    try require(session.state == .paused, "manifest paused")
    try require(session.segments.count == 1 && session.segments[0].byteLength > 0, "committed audio preserved")
    try require(rig.factory.tracker.live == 0, "nothing pretends to record")
  }

  // Route recovery that fails is distinguishable from a checkpoint failure and preserves audio.
  static func failedRouteRecoveryPausesWithDistinctReason() async throws {
    let rig = try await makeRig("routefail")
    defer { try? FileManager.default.removeItem(at: rig.root) }
    rig.factory.tracker.failNext = 2 // both bounded attempts fail to start a recorder
    rig.engine.simulateRouteLossForTesting()
    try require(runtime(rig) == "paused", "failed route recovery pauses: \(runtime(rig))")
    try require(interruption(rig) == "route_recovery_failed", "distinct, truthful reason: \(String(describing: interruption(rig)))")
    try require(try persisted(rig).segments.count == 1, "committed audio preserved")
  }

  // Foreground net: the recorder's own protective pause gets ONE automatic resume attempt; a user pause never does.
  static func foregroundAutoRecoveryIsBoundedAndNeverOverridesUserPause() async throws {
    // A) protective pause in the background -> foreground -> recovered without a manual Resume.
    let rigA = try await makeRig("autorecover")
    defer { try? FileManager.default.removeItem(at: rigA.root) }
    rigA.session.otherSubsystemSetsCategory("playback")
    rigA.session.appInBackground = true
    _ = try? rigA.engine.performCheckpointForTesting()
    try require(runtime(rigA) == "paused", "precondition: protective pause")
    rigA.session.appInBackground = false
    rigA.engine.simulateForegroundForTesting()
    try require(runtime(rigA) == "recording", "foreground return recovers the recorder without a manual Resume")
    try require(try persisted(rigA).state == .recording, "manifest recording")

    // B) bounded: a failed attempt is not retried by further foreground events.
    let rigB = try await makeRig("autobounded")
    defer { try? FileManager.default.removeItem(at: rigB.root) }
    rigB.session.otherSubsystemSetsCategory("playback")
    rigB.session.appInBackground = true
    _ = try? rigB.engine.performCheckpointForTesting()
    let callsBefore = rigB.session.setCategoryCalls
    rigB.engine.simulateForegroundForTesting() // still "background" for the session => attempt fails
    try require(runtime(rigB) == "paused", "failed recovery leaves a truthful pause")
    let afterFirst = rigB.session.setCategoryCalls
    try require(afterFirst == callsBefore + 1, "exactly one automatic attempt")
    rigB.engine.simulateForegroundForTesting()
    try require(rigB.session.setCategoryCalls == afterFirst, "never retried again automatically")

    // C) a deliberate user Pause is never auto-resumed.
    let rigC = try await makeRig("userpause")
    defer { try? FileManager.default.removeItem(at: rigC.root) }
    _ = try rigC.engine.pauseRecording(recordingSessionId: rigC.sessionId)
    rigC.engine.simulateForegroundForTesting()
    try require(runtime(rigC) == "paused", "a user Pause must stay paused")
  }
}
