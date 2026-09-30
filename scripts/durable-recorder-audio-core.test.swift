import Foundation

private struct AudioTestFailure: Error, CustomStringConvertible {
  let description: String
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw AudioTestFailure(description: message) }
}

private final class FakeAudioSession: DurableAudioSessionManaging {
  var permissionState: DurableRecorderPermissionState = .granted
  var hasSuitableInput = true
  var routeDescription = "builtInMic:Test microphone"
  var activationCount = 0
  var deactivationCount = 0

  func requestPermission() async -> DurableRecorderPermissionState { permissionState }
  func activateForRecording() throws {
    activationCount += 1
    if !hasSuitableInput { throw DurableRecorderCoreError.noAudioInput }
  }
  func deactivate() { deactivationCount += 1 }
}

private final class FakeCapture: DurableAudioCapture {
  private let url: URL
  private let shouldStart: Bool
  private(set) var isRecording = false

  init(url: URL, shouldStart: Bool) {
    self.url = url
    self.shouldStart = shouldStart
  }

  func prepareToRecord() -> Bool { shouldStart }
  func record() -> Bool {
    guard shouldStart else { return false }
    isRecording = true
    FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 7, count: 4_096))
    return true
  }
  func stop() { isRecording = false }
}

private final class FakeCaptureFactory: DurableAudioCaptureFactory {
  /// How many upcoming captures fail to start. `failNext = true` is one (a transient failure); a checkpoint
  /// rollover now retries ONCE, so tests that model a persistent begin failure arm two.
  var failNextCount = 0
  var failNext: Bool {
    get { failNextCount > 0 }
    set { failNextCount = newValue ? 1 : 0 }
  }
  private(set) var createdURLs: [URL] = []

  func makeCapture(url: URL) throws -> DurableAudioCapture {
    createdURLs.append(url)
    let shouldStart = failNextCount == 0
    if failNextCount > 0 { failNextCount -= 1 }
    return FakeCapture(url: url, shouldStart: shouldStart)
  }
}

private final class FakeFileInspector: DurableAudioFileInspecting {
  var failNext = false
  var durationMs = 1_250

  func inspect(url: URL) throws -> DurableAudioFileInspection {
    if failNext {
      failNext = false
      throw DurableRecorderCoreError.segmentValidationFailed("empty test asset")
    }
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    guard size > 0 else {
      throw DurableRecorderCoreError.segmentValidationFailed("empty test asset")
    }
    return DurableAudioFileInspection(
      durationMs: durationMs,
      byteLength: Int64(size),
      sampleRate: 44_100,
      channelCount: 1
    )
  }
}

private func temporaryRoot(_ label: String) -> URL {
  FileManager.default.temporaryDirectory
    .appendingPathComponent("durable-recorder-audio-\(label)-\(UUID().uuidString)", isDirectory: true)
}

private func makeEngine(
  root: URL,
  checkpointInterval: TimeInterval = 0,
  inspector: FakeFileInspector = FakeFileInspector()
) throws -> (
  DurableRecorderStore,
  DurableForegroundRecorder,
  FakeAudioSession,
  FakeCaptureFactory,
  FakeFileInspector
) {
  let store = try DurableRecorderStore(rootURL: root)
  let audioSession = FakeAudioSession()
  let factory = FakeCaptureFactory()
  let engine = DurableForegroundRecorder(
    store: store,
    audioSession: audioSession,
    captureFactory: factory,
    fileInspector: inspector,
    checkpointInterval: checkpointInterval,
    observeSystemNotifications: false,
    checkpointRetryPolicy: DurableCheckpointRetryPolicy(sleep: { _ in })
  )
  return (store, engine, audioSession, factory, inspector)
}

private func prepare(
  _ engine: DurableForegroundRecorder,
  sessionId: String
) async throws {
  _ = try await engine.prepareRecording(recordingSessionId: sessionId, requestPermission: false)
}

private func testLifecycleAndImmutableSegments() async throws {
  let root = temporaryRoot("lifecycle")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, audioSession, factory, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-audio")
  try await prepare(engine, sessionId: session.recordingSessionId)

  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  let afterFirstPause = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(afterFirstPause.state == .paused, "Pause must persist paused state")
  try require(afterFirstPause.segments.map(\.sequence) == [1], "First segment must use sequence 1")
  let firstPath = afterFirstPause.segments[0].relativePath
  let firstURL = root.appendingPathComponent(afterFirstPause.relativeSessionPath).appendingPathComponent(firstPath)
  let firstBytes = try Data(contentsOf: firstURL)

  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  let afterRepeatedPause = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(
    afterRepeatedPause.segments.count == 1,
    "Repeated pause must not duplicate a segment"
  )

  _ = try engine.resumeRecording(recordingSessionId: session.recordingSessionId)
  _ = try engine.resumeRecording(recordingSessionId: session.recordingSessionId)
  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  _ = try engine.resumeRecording(recordingSessionId: session.recordingSessionId)
  let stoppedStatus = try engine.stopRecording(recordingSessionId: session.recordingSessionId)
  let finalized = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(finalized.state == .finalized, "Stop must finalize the durable session")
  try require(finalized.segments.map(\.sequence) == [1, 2, 3], "Resume must allocate monotonic segments")
  try require(Set(finalized.segments.map(\.segmentId)).count == 3, "Segment IDs must be immutable and unique")
  try require(Set(finalized.segments.map(\.relativePath)).count == 3, "Segment paths must never be reused")
  let preservedFirstBytes = try Data(contentsOf: firstURL)
  try require(preservedFirstBytes == firstBytes, "Later operations must not overwrite segment 1")
  try require((stoppedStatus["runtimeState"] as? String) == "idle", "Stop must release runtime ownership")
  _ = try engine.stopRecording(recordingSessionId: session.recordingSessionId)
  let afterRepeatedStop = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(
    afterRepeatedStop.segments.count == 3,
    "Repeated stop must be idempotent"
  )
  try require(factory.createdURLs.count == 3, "Exactly one active file must be created per segment")
  try require(
    factory.createdURLs.allSatisfy { $0.path.hasPrefix(root.appendingPathComponent("sessions").path) },
    "Active recording files must remain inside the durable session root"
  )
  try require(audioSession.activationCount == 3, "Every segment start must activate the audio session")
  try require(audioSession.deactivationCount >= 3, "Pause and stop must deactivate the audio session")
}

private func testOwnershipAndStartFailure() async throws {
  let root = temporaryRoot("ownership")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, factory, _) = try makeEngine(root: root)
  let first = try store.createSession(lectureId: "lecture-first")
  let second = try store.createSession(lectureId: "lecture-second")
  try await prepare(engine, sessionId: first.recordingSessionId)

  do {
    try await prepare(engine, sessionId: second.recordingSessionId)
    throw AudioTestFailure(description: "A second session claimed the recorder")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "A second session claimed the recorder")
  } catch let error as DurableRecorderCoreError {
    try require(error == .recorderBusy, "Second-session ownership must return recorderBusy")
  }

  _ = try engine.startRecording(recordingSessionId: first.recordingSessionId)
  _ = try engine.pauseRecording(recordingSessionId: first.recordingSessionId)
  let firstSegment = try store.getSession(recordingSessionId: first.recordingSessionId).segments[0]
  factory.failNext = true
  do {
    _ = try engine.resumeRecording(recordingSessionId: first.recordingSessionId)
    throw AudioTestFailure(description: "A forced segment start failure succeeded")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "A forced segment start failure succeeded")
  } catch {
    let preserved = try store.getSession(recordingSessionId: first.recordingSessionId)
    try require(preserved.state == .paused, "A resume failure must leave the session paused")
    try require(preserved.segments == [firstSegment], "A resume failure must preserve prior segments")
  }
}

private func testInterruptionRouteAndRestart() async throws {
  let root = temporaryRoot("recovery")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, firstEngine, _, _, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-recovery")
  try await prepare(firstEngine, sessionId: session.recordingSessionId)
  _ = try firstEngine.startRecording(recordingSessionId: session.recordingSessionId)
  firstEngine.simulateInterruptionBeganForTesting()
  var interrupted = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(interrupted.state == .paused && interrupted.segments.count == 1, "Interruption must preserve segment 1")
  try require(interrupted.segments[0].interruptionReason == "interruption_began", "Interruption reason must persist")
  firstEngine.simulateInterruptionEndedForTesting(shouldResume: true)
  _ = try firstEngine.resumeRecording(recordingSessionId: session.recordingSessionId)
  firstEngine.simulateRouteLossForTesting()
  interrupted = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(interrupted.state == .paused && interrupted.segments.count == 2, "Route loss must preserve segment 2")

  let (_, restartedEngine, _, _, _) = try makeEngine(root: root)
  let recovery = try restartedEngine.recoverRecordingSession(recordingSessionId: session.recordingSessionId)
  try require(recovery.session.segments.count == 2, "Restart recovery must discover completed segments")
  let disposable = try store.createSession(lectureId: "lecture-recovery-discard")
  _ = try restartedEngine.recoverRecordingSession(recordingSessionId: disposable.recordingSessionId)
  _ = try store.transitionSession(recordingSessionId: disposable.recordingSessionId, to: .preparing)
  _ = try store.transitionSession(recordingSessionId: disposable.recordingSessionId, to: .ready)
  _ = try store.abandonSession(recordingSessionId: disposable.recordingSessionId)
  _ = try store.deleteSession(recordingSessionId: disposable.recordingSessionId)
  _ = try restartedEngine.resumeRecording(recordingSessionId: session.recordingSessionId)
  _ = try restartedEngine.stopRecording(recordingSessionId: session.recordingSessionId)
  let finalized = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(finalized.segments.map(\.sequence) == [1, 2, 3], "Restart resume must allocate a new segment")
  restartedEngine.simulateRouteLossForTesting()
  let afterTerminalRoute = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(
    afterTerminalRoute == finalized,
    "A route notification after finalization must not mutate the session"
  )
}

private func testReconciliationPolicies() async throws {
  let root = temporaryRoot("reconcile")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-reconcile")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  let persisted = try store.getSession(recordingSessionId: session.recordingSessionId)
  let sessionDirectory = root.appendingPathComponent(persisted.relativeSessionPath, isDirectory: true)
  let segmentsDirectory = sessionDirectory.appendingPathComponent("segments", isDirectory: true)

  let referencedURL = sessionDirectory.appendingPathComponent(persisted.segments[0].relativePath)
  try FileManager.default.removeItem(at: referencedURL)
  let orphanId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  let orphanURL = segmentsDirectory.appendingPathComponent("000002-\(orphanId).m4a")
  try Data(repeating: 1, count: 128).write(to: orphanURL)
  let zeroId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  let zeroURL = segmentsDirectory.appendingPathComponent("000003-\(zeroId).m4a")
  try Data().write(to: zeroURL)
  let partialId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  try Data(repeating: 2, count: 16).write(
    to: segmentsDirectory.appendingPathComponent("000004-\(partialId).partial.m4a")
  )
  try Data(repeating: 3, count: 16).write(to: segmentsDirectory.appendingPathComponent("unsupported.wav"))

  let result = try store.reconcileSession(recordingSessionId: session.recordingSessionId) { url in
    ((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0
  }
  let codes = Set(result.issues.map(\.code))
  try require(codes.contains("missing_referenced_file"), "Recovery must detect a missing referenced file")
  try require(codes.contains("orphan_finalized_file"), "Recovery must detect an orphan finalized file")
  try require(codes.contains("invalid_orphan_file"), "Recovery must reject a zero-byte orphan")
  try require(codes.contains("incomplete_temporary_file"), "Recovery must retain and report crash artifacts")
  try require(codes.contains("unsupported_segment_format"), "Recovery must reject unsupported extensions")
}

private func testSeparateSessionBoundariesAndNoInput() async throws {
  let firstRoot = temporaryRoot("boundaries")
  defer { try? FileManager.default.removeItem(at: firstRoot) }
  let (store, engine, audioSession, _, _) = try makeEngine(root: firstRoot)
  let session = try store.createSession(lectureId: "lecture-boundary")
  try await prepare(engine, sessionId: session.recordingSessionId)
  audioSession.hasSuitableInput = false
  do {
    _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
    throw AudioTestFailure(description: "Recording started without an input")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "Recording started without an input")
  } catch let error as DurableRecorderCoreError {
    try require(error == .noAudioInput, "No input must return a typed noAudioInput error")
  }

  do {
    _ = try store.createSegmentPlan(recordingSessionId: "../../escape")
    throw AudioTestFailure(description: "Segment path traversal succeeded")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "Segment path traversal succeeded")
  } catch let error as DurableRecorderCoreError {
    try require(error == .invalidIdentifier, "Traversal must be rejected before path construction")
  }

  let secondSession = try store.createSession(lectureId: "lecture-second-boundary")
  let firstPlan = try store.createSegmentPlan(recordingSessionId: session.recordingSessionId)
  let secondPlan = try store.createSegmentPlan(recordingSessionId: secondSession.recordingSessionId)
  try require(firstPlan.activeURL != secondPlan.activeURL, "Separate sessions cannot share segment file paths")
  try require(
    firstPlan.activeURL.path.contains(session.recordingSessionId) &&
      secondPlan.activeURL.path.contains(secondSession.recordingSessionId),
    "Segment paths must remain bound to their owning session"
  )
}

private func testInvalidSegmentMetadataVersions() async throws {
  let root = temporaryRoot("metadata")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-metadata")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  let metadataURL = root
    .appendingPathComponent("sessions", isDirectory: true)
    .appendingPathComponent(session.recordingSessionId, isDirectory: true)
    .appendingPathComponent("session.json")
  let data = try Data(contentsOf: metadataURL)
  var json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
  var segments = json["segments"] as! [[String: Any]]
  segments[0]["schemaVersion"] = 999
  json["segments"] = segments
  try JSONSerialization.data(withJSONObject: json).write(to: metadataURL, options: .atomic)
  let restartedStore = try DurableRecorderStore(rootURL: root)
  do {
    _ = try restartedStore.getSession(recordingSessionId: session.recordingSessionId)
    throw AudioTestFailure(description: "Unknown segment metadata schema was accepted")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "Unknown segment metadata schema was accepted")
  } catch let error as DurableRecorderCoreError {
    try require(
      error == .unsupportedSegmentSchemaVersion(999),
      "Unknown segment metadata schema must return a typed error"
    )
  }
}

private func testForcedPausePublishesStatus() async throws {
  let root = temporaryRoot("status-events")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  var payloads: [[String: Any]] = []
  engine.onStatusChange = { payloads.append($0) }

  let session = try store.createSession(lectureId: "lecture-status-events")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  try require(!payloads.isEmpty, "Start must publish a status payload")
  let startSequence = payloads.last?["statusSequence"] as? Int ?? 0
  try require(startSequence > 0, "Published status must carry a positive statusSequence")

  engine.simulateInterruptionBeganForTesting()
  try require(payloads.count >= 2, "Interruption forced-pause must publish status")
  let interrupted = payloads.last!
  try require((interrupted["runtimeState"] as? String) == "interrupted", "Interruption runtime must be interrupted")
  try require(
    ((interrupted["session"] as? [String: Any])?["state"] as? String) == "paused",
    "Forced pause must persist session state paused"
  )
  try require(
    (interrupted["recordingSessionId"] as? String) == session.recordingSessionId,
    "Forced-pause status must identify the active session"
  )
  let interruptedSequence = interrupted["statusSequence"] as? Int ?? 0
  try require(interruptedSequence > startSequence, "Forced pause must advance statusSequence")

  _ = try engine.resumeRecording(recordingSessionId: session.recordingSessionId)
  let resumeSequence = payloads.last?["statusSequence"] as? Int ?? 0
  try require(resumeSequence > interruptedSequence, "Resume must advance statusSequence")

  engine.simulateRouteLossForTesting()
  let routed = payloads.last!
  try require((routed["runtimeState"] as? String) == "paused", "Route-loss runtime must be paused")
  try require(
    ((routed["session"] as? [String: Any])?["state"] as? String) == "paused",
    "Route-loss must leave the session paused"
  )
  try require(
    (routed["statusSequence"] as? Int ?? 0) > resumeSequence,
    "Route-loss must advance statusSequence past Resume"
  )

  // Explicit pause after resume should publish once and remain idempotent on repeat.
  _ = try engine.resumeRecording(recordingSessionId: session.recordingSessionId)
  let beforeExplicitPause = payloads.count
  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  try require(payloads.count == beforeExplicitPause + 1, "Explicit pause must publish exactly one status")
  let afterExplicit = payloads.count
  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  try require(payloads.count == afterExplicit, "Repeated pause must not republish")
}

private func testAutomaticCheckpointCommitsSegment() async throws {
  let root = temporaryRoot("checkpoint-one")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, audioSession, factory, _) = try makeEngine(root: root)
  var payloads: [[String: Any]] = []
  engine.onStatusChange = { payloads.append($0) }

  let session = try store.createSession(lectureId: "lecture-checkpoint-one")
  try await prepare(engine, sessionId: session.recordingSessionId)
  let started = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  try require((started["runtimeState"] as? String) == "recording", "Start must leave runtime recording")
  let publishCountAfterStart = payloads.count

  try engine.performCheckpointForTesting()
  let after = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(after.state == .recording, "Checkpoint must keep session state recording")
  try require(after.segments.map(\.sequence) == [1], "Checkpoint must commit segment 1")
  try require(after.segments[0].interruptionReason == "checkpoint", "Checkpoint reason must persist")
  try require(factory.createdURLs.count == 2, "Checkpoint must open the next active segment")
  try require(audioSession.deactivationCount == 0, "Successful checkpoint must not deactivate the audio session")
  try require(payloads.count == publishCountAfterStart, "Successful checkpoint must not publish status")

  let status = engine.getRecordingStatus()
  try require((status["runtimeState"] as? String) == "recording", "Status refresh must remain recording")
  try require((status["activeSegmentId"] as? String) != nil, "A new active segment must exist after checkpoint")
  try require(
    (status["activeSegmentId"] as? String) != after.segments[0].segmentId,
    "Active segment must differ from the committed checkpoint segment"
  )
}

private func testMultipleCheckpoints() async throws {
  let root = temporaryRoot("checkpoint-many")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, factory, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-checkpoint-many")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)

  var priorDuration = 0
  for expectedCount in 1...5 {
    try engine.performCheckpointForTesting()
    let current = try store.getSession(recordingSessionId: session.recordingSessionId)
    try require(current.state == .recording, "Session must stay recording across checkpoints")
    try require(current.segments.count == expectedCount, "Committed segment count must match checkpoint count")
    try require(
      current.segments.map(\.sequence) == Array(1...expectedCount),
      "Checkpoint sequences must be strictly increasing without gaps"
    )
    try require(
      Set(current.segments.map(\.segmentId)).count == expectedCount,
      "Checkpoint segment IDs must be unique"
    )
    let cumulative = current.segments.reduce(0) { $0 + $1.durationMs }
    try require(cumulative > priorDuration, "Cumulative duration must be monotonic")
    priorDuration = cumulative
  }
  try require(factory.createdURLs.count == 6, "Five checkpoints leave one active segment open")
  let status = engine.getRecordingStatus()
  try require((status["runtimeState"] as? String) == "recording", "Runtime must remain recording")
  try require((status["activeSegmentId"] as? String) != nil, "Exactly one active segment identity must remain")
}

private func testFinishAfterCheckpoints() async throws {
  let root = temporaryRoot("checkpoint-finish")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-checkpoint-finish")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  try engine.performCheckpointForTesting()
  try engine.performCheckpointForTesting()
  try engine.performCheckpointForTesting()

  let stopped = try engine.stopRecording(recordingSessionId: session.recordingSessionId)
  let finalized = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(finalized.state == .finalized, "Finish after checkpoints must finalize")
  try require(finalized.segments.map(\.sequence) == [1, 2, 3, 4], "Finish must commit the trailing active segment once")
  try require(Set(finalized.segments.map(\.segmentId)).count == 4, "Finish must not duplicate checkpoint segments")
  let totalDuration = finalized.segments.reduce(0) { $0 + $1.durationMs }
  try require(totalDuration == 5_000, "Final duration must equal the sum of segment durations")
  try require((stopped["runtimeState"] as? String) == "idle", "Finish must release ownership")
}

private func testPauseDuringCheckpointWindow() async throws {
  let root = temporaryRoot("checkpoint-pause")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, factory, _) = try makeEngine(root: root, checkpointInterval: 60)
  let session = try store.createSession(lectureId: "lecture-checkpoint-pause")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  guard let identity = engine.checkpointIdentityForTesting() else {
    throw AudioTestFailure(description: "Start must schedule a checkpoint timer")
  }

  let paused = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  try require((paused["runtimeState"] as? String) == "paused", "Pause must win and leave runtime paused")
  let afterPause = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(afterPause.segments.map(\.sequence) == [1], "Pause must commit exactly one segment")
  try require(engine.checkpointIdentityForTesting() == nil, "Pause must cancel the checkpoint timer")

  engine.fireCheckpointTimerForTesting(
    generation: identity.generation,
    sessionId: identity.sessionId,
    segmentId: identity.segmentId
  )
  let afterStale = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(afterStale == afterPause, "Stale checkpoint after pause must not mutate the session")
  try require(factory.createdURLs.count == 1, "Stale checkpoint must not open a new segment after pause")
  try require(engine.getRecordingStatus()["activeSegmentId"] as? String == nil, "No active segment after pause")
}

private func testResumeAfterCheckpointedPause() async throws {
  let root = temporaryRoot("checkpoint-resume")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-checkpoint-resume")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  try engine.performCheckpointForTesting()
  try engine.performCheckpointForTesting()
  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
  let paused = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(paused.segments.map(\.sequence) == [1, 2, 3], "Pause after checkpoints commits the active remnant")

  _ = try engine.resumeRecording(recordingSessionId: session.recordingSessionId)
  let recording = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(recording.state == .recording, "Resume must return to recording")
  try require(recording.segments == paused.segments, "Resume must leave prior checkpoint segments immutable")
  let status = engine.getRecordingStatus()
  try require((status["activeSegmentId"] as? String) != nil, "Resume must allocate the next sequence segment")
  try require(
    (status["activeSegmentId"] as? String) != paused.segments.last?.segmentId,
    "Resume must not reopen the last committed segment"
  )
}

private func testFinishCheckpointRace() async throws {
  let root = temporaryRoot("checkpoint-finish-race")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-checkpoint-finish-race")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  try engine.performCheckpointForTesting()

  // Serialized on the engine queue: checkpoint then Finish.
  try engine.performCheckpointForTesting()
  let stopped = try engine.stopRecording(recordingSessionId: session.recordingSessionId)
  let finalized = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(finalized.state == .finalized, "Finish must win the race with a finalized session")
  try require(finalized.segments.map(\.sequence) == [1, 2, 3], "Race must commit each segment exactly once")
  try require(Set(finalized.segments.map(\.segmentId)).count == 3, "Race must not duplicate segment IDs")
  try require((stopped["runtimeState"] as? String) == "idle", "Finalized state must release ownership")
  _ = try engine.stopRecording(recordingSessionId: session.recordingSessionId)
  let repeated = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(repeated.segments.count == 3, "Repeated Finish must not invent segments")
}

private func testForcedPauseCheckpointRace() async throws {
  let root = temporaryRoot("checkpoint-forced-pause")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, factory, _) = try makeEngine(root: root, checkpointInterval: 60)
  var payloads: [[String: Any]] = []
  engine.onStatusChange = { payloads.append($0) }

  let session = try store.createSession(lectureId: "lecture-checkpoint-forced")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  try engine.performCheckpointForTesting()
  let publishCountAfterCheckpoint = payloads.count
  guard let identity = engine.checkpointIdentityForTesting() else {
    throw AudioTestFailure(description: "Checkpoint must reschedule the next timer")
  }

  engine.simulateInterruptionBeganForTesting()
  try require(payloads.count == publishCountAfterCheckpoint + 1, "Forced pause must publish authoritative status")
  let interrupted = payloads.last!
  try require((interrupted["runtimeState"] as? String) == "interrupted", "Forced-pause runtime must be interrupted")
  try require(
    ((interrupted["session"] as? [String: Any])?["state"] as? String) == "paused",
    "Forced pause must persist paused session state"
  )

  let after = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(after.state == .paused, "Interruption must leave the session paused")
  try require(after.segments.map(\.sequence) == [1, 2], "Committed checkpoint audio must survive forced pause")

  engine.fireCheckpointTimerForTesting(
    generation: identity.generation,
    sessionId: identity.sessionId,
    segmentId: identity.segmentId
  )
  let afterStale = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(afterStale == after, "Stale checkpoint after forced pause must not mutate state")
  try require(factory.createdURLs.count == 2, "Forced pause must prevent a post-pause segment start")
}

private func testStaleCheckpointCallback() async throws {
  let root = temporaryRoot("checkpoint-stale")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, factory, _) = try makeEngine(root: root, checkpointInterval: 60)
  let sessionA = try store.createSession(lectureId: "lecture-checkpoint-a")
  try await prepare(engine, sessionId: sessionA.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: sessionA.recordingSessionId)
  guard let stale = engine.checkpointIdentityForTesting() else {
    throw AudioTestFailure(description: "Session A must schedule a checkpoint")
  }
  _ = try engine.pauseRecording(recordingSessionId: sessionA.recordingSessionId)
  _ = try engine.stopRecording(recordingSessionId: sessionA.recordingSessionId)

  let sessionB = try store.createSession(lectureId: "lecture-checkpoint-b")
  try await prepare(engine, sessionId: sessionB.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: sessionB.recordingSessionId)
  let before = try store.getSession(recordingSessionId: sessionB.recordingSessionId)
  let createdBefore = factory.createdURLs.count

  engine.fireCheckpointTimerForTesting(
    generation: stale.generation,
    sessionId: stale.sessionId,
    segmentId: stale.segmentId
  )
  let after = try store.getSession(recordingSessionId: sessionB.recordingSessionId)
  try require(after == before, "Stale session-A callback must not mutate session B")
  try require(factory.createdURLs.count == createdBefore, "Stale callback must not create a segment")
  try require((engine.getRecordingStatus()["runtimeState"] as? String) == "recording", "Session B must keep recording")
}

private func testInvalidCheckpointOutput() async throws {
  let root = temporaryRoot("checkpoint-invalid")
  defer { try? FileManager.default.removeItem(at: root) }
  let inspector = FakeFileInspector()
  let (store, engine, _, _, _) = try makeEngine(root: root, inspector: inspector)
  var payloads: [[String: Any]] = []
  engine.onStatusChange = { payloads.append($0) }

  let session = try store.createSession(lectureId: "lecture-checkpoint-invalid")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  try engine.performCheckpointForTesting()
  let committed = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(committed.segments.count == 1, "Precondition: one valid checkpoint segment")
  let publishCount = payloads.count

  inspector.failNext = true
  do {
    try engine.performCheckpointForTesting()
    throw AudioTestFailure(description: "Invalid checkpoint commit succeeded")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "Invalid checkpoint commit succeeded")
  } catch {
    let after = try store.getSession(recordingSessionId: session.recordingSessionId)
    try require(after.state == .paused, "Invalid checkpoint must force a safe paused state")
    try require(after.segments.count == 1, "Invalid checkpoint must not append metadata")
    try require(after.segments[0].segmentId == committed.segments[0].segmentId, "Earlier segments must remain")
    try require(payloads.count == publishCount + 1, "Failure must publish authoritative status")
    try require((payloads.last?["runtimeState"] as? String) == "paused", "UI must stop claiming recording")
    try require(engine.getRecordingStatus()["activeSegmentId"] as? String == nil, "No active capture after failure")
  }
}

private func testCheckpointBeginSegmentFailurePreservesAudio() async throws {
  let root = temporaryRoot("checkpoint-begin-fail")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, audioSession, factory, _) = try makeEngine(root: root)
  var payloads: [[String: Any]] = []
  engine.onStatusChange = { payloads.append($0) }

  let session = try store.createSession(lectureId: "lecture-checkpoint-begin-fail")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  let publishCount = payloads.count

  // The commit half of the rollover (finalizeActiveSegment) must succeed;
  // only the SECOND half (beginSegment for the next segment) fails — this is
  // the exact P0 incident: segment N committed, segment N+1 never opened.
  // The rollover retries once, so a PERSISTENT failure (both attempts) is what reaches the paused path.
  factory.failNextCount = 2
  do {
    try engine.performCheckpointForTesting()
    throw AudioTestFailure(description: "A forced beginSegment failure during checkpoint succeeded")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "A forced beginSegment failure during checkpoint succeeded")
  } catch {
    let after = try store.getSession(recordingSessionId: session.recordingSessionId)
    try require(after.state == .paused, "A failed beginSegment during checkpoint must leave the session paused")
    try require(after.segments.count == 1, "The already-committed checkpoint segment must be preserved")
    try require(
      after.segments[0].interruptionReason == "checkpoint",
      "The preserved segment must still carry its checkpoint reason"
    )
    try require(payloads.count == publishCount + 1, "A failed rollover must publish exactly one authoritative status")
    let published = payloads.last!
    try require((published["runtimeState"] as? String) == "paused", "UI must stop claiming recording after a failed rollover")
    try require(
      (published["interruptionState"] as? String) == "checkpoint_begin_segment_failed",
      "A failed rollover must be distinguishable from a plain interruption or route change"
    )
    try require(
      ((published["session"] as? [String: Any])?["state"] as? String) == "paused",
      "Published status must reflect the paused session"
    )
    try require(engine.getRecordingStatus()["activeSegmentId"] as? String == nil, "No active capture after a failed rollover")
    try require(audioSession.deactivationCount > 0, "A failed rollover must deactivate the audio session")
  }
}

private func testResumeAfterFailedCheckpointRollover() async throws {
  let root = temporaryRoot("checkpoint-begin-fail-resume")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, factory, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-checkpoint-begin-fail-resume")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)

  // The rollover retries once, so a PERSISTENT failure (both attempts) is what reaches the paused path.
  factory.failNextCount = 2
  do {
    try engine.performCheckpointForTesting()
    throw AudioTestFailure(description: "A forced beginSegment failure during checkpoint succeeded")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "A forced beginSegment failure during checkpoint succeeded")
  } catch {
    // Expected — proven by testCheckpointBeginSegmentFailurePreservesAudio.
  }
  let paused = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(paused.state == .paused && paused.segments.count == 1, "Precondition: one committed segment, paused")

  // Resume must retry opening the NEXT segment on the SAME session — not
  // create a new one — and must leave the already-committed segment intact.
  _ = try engine.resumeRecording(recordingSessionId: session.recordingSessionId)
  let resumed = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(resumed.state == .recording, "Resume after a failed rollover must return to recording")
  try require(resumed.segments == paused.segments, "Resume must not alter the already-committed segment")
  try require(resumed.recordingSessionId == session.recordingSessionId, "Resume must reattach to the SAME session")
  let status = engine.getRecordingStatus()
  try require((status["activeSegmentId"] as? String) != nil, "Resume must open a new active segment")
  try require(
    (status["activeSegmentId"] as? String) != paused.segments[0].segmentId,
    "The new active segment must not reuse the committed one's identity"
  )

  try engine.performCheckpointForTesting()
  let after = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(after.segments.map(\.sequence) == [1, 2], "A subsequent checkpoint must extend the same session")
}

private func testFinishAfterFailedCheckpointRollover() async throws {
  let root = temporaryRoot("checkpoint-begin-fail-finish")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, factory, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-checkpoint-begin-fail-finish")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)

  // The rollover retries once, so a PERSISTENT failure (both attempts) is what reaches the paused path.
  factory.failNextCount = 2
  do {
    try engine.performCheckpointForTesting()
    throw AudioTestFailure(description: "A forced beginSegment failure during checkpoint succeeded")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "A forced beginSegment failure during checkpoint succeeded")
  } catch {
    // Expected.
  }
  let paused = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(paused.segments.count == 1, "Precondition: one committed segment")

  // Finish must still be able to finalize the segment(s) already committed
  // before the failed rollover — no data loss just because the NEXT
  // segment never opened.
  _ = try engine.stopRecording(recordingSessionId: session.recordingSessionId)
  let finalized = try store.getSession(recordingSessionId: session.recordingSessionId)
  try require(finalized.state == .finalized, "Finish after a failed rollover must still finalize")
  try require(finalized.segments == paused.segments, "Finish must not lose or alter the committed segment")
  try require(finalized.segments.count == 1, "Finish must not invent a phantom second segment")
}

// P0 — cross-lecture ownership: a paused session must never permanently
// deadlock every OTHER in-progress lecture in the app. Real incident: four
// separate Hhh lectures each had their own real, recoverable durable
// session — but only the FIRST one ever paused could be resumed; every
// other one's Resume/Finish failed with recorderBusy ("Another durable
// recording session already owns the native recorder"), because pausing a
// session never released `ownedSessionId` — only Finish/discard/a cold
// process relaunch did.

private func testPausedOwnerReleasedForDifferentSessionResume() async throws {
  let root = temporaryRoot("ownership-paused-release")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let lectureA = try store.createSession(lectureId: "lecture-ownership-a")
  let lectureB = try store.createSession(lectureId: "lecture-ownership-b")

  try await prepare(engine, sessionId: lectureA.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: lectureA.recordingSessionId)
  _ = try engine.pauseRecording(recordingSessionId: lectureA.recordingSessionId)
  let pausedA = try store.getSession(recordingSessionId: lectureA.recordingSessionId)
  try require(pausedA.state == .paused && pausedA.segments.count == 1, "Precondition: A paused with one segment")

  // Before the fix, THIS is exactly where a real owner opened lecture B,
  // hit Resume, and got "Could not resume the recording." with no way out.
  try await prepare(engine, sessionId: lectureB.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: lectureB.recordingSessionId)
  let recordingB = try store.getSession(recordingSessionId: lectureB.recordingSessionId)
  try require(recordingB.state == .recording, "B must be able to start despite A merely being paused")

  // A's segment must be completely untouched — released, never discarded.
  let untouchedA = try store.getSession(recordingSessionId: lectureA.recordingSessionId)
  try require(untouchedA == pausedA, "Releasing A's ownership must not mutate A's own session/segments at all")

  _ = try engine.pauseRecording(recordingSessionId: lectureB.recordingSessionId)
  let pausedB = try store.getSession(recordingSessionId: lectureB.recordingSessionId)
  try require(pausedB.segments.count == 1, "Precondition: B paused with one segment")

  // Reopening A afterward must still resume A's OWN session — ownership
  // transfer must be a two-way street, not a one-shot escape hatch.
  _ = try engine.resumeRecording(recordingSessionId: lectureA.recordingSessionId)
  let resumedA = try store.getSession(recordingSessionId: lectureA.recordingSessionId)
  try require(resumedA.state == .recording, "A must be resumable again after B released it back")
  try engine.performCheckpointForTesting()
  let afterA = try store.getSession(recordingSessionId: lectureA.recordingSessionId)
  try require(afterA.segments.map(\.sequence) == [1, 2], "A's resumed segment must extend A's own session")

  // B must still be exactly as A left it — preserved, not corrupted, not
  // silently finalized or discarded by A reclaiming ownership.
  let untouchedB = try store.getSession(recordingSessionId: lectureB.recordingSessionId)
  try require(untouchedB == pausedB, "Releasing B's ownership back to A must not mutate B's own session/segments")
}

private func testActiveOwnerStillBlocksDifferentSessionClaim() async throws {
  let root = temporaryRoot("ownership-active-blocks")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let lectureA = try store.createSession(lectureId: "lecture-ownership-active-a")
  let lectureB = try store.createSession(lectureId: "lecture-ownership-active-b")

  try await prepare(engine, sessionId: lectureA.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: lectureA.recordingSessionId)
  let recordingA = try store.getSession(recordingSessionId: lectureA.recordingSessionId)
  try require(recordingA.state == .recording, "Precondition: A is genuinely, actively recording")

  // A GENUINELY active recording must never be silently pre-empted — this
  // is the one case the fix must NOT relax.
  do {
    try await prepare(engine, sessionId: lectureB.recordingSessionId)
    throw AudioTestFailure(description: "A second session claimed the recorder while the first was actively recording")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "A second session claimed the recorder while the first was actively recording")
  } catch let error as DurableRecorderCoreError {
    try require(error == .recorderBusy, "An actively-recording owner must still reject a different session's claim")
  }
  let stillRecordingA = try store.getSession(recordingSessionId: lectureA.recordingSessionId)
  try require(stillRecordingA.state == .recording, "A must be completely unaffected by B's rejected claim attempt")
}

private func testReadyOwnerStillBlocksDifferentSessionClaim() async throws {
  // Regression guard for the exact scenario testOwnershipAndStartFailure
  // already covers — proving the NEW release logic did not widen the
  // releasable-state set beyond paused/interrupted. A session merely
  // `.ready` (prepared, not yet started) is mid-lifecycle, not "resting",
  // and must still block a different session's claim.
  let root = temporaryRoot("ownership-ready-blocks")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let lectureA = try store.createSession(lectureId: "lecture-ownership-ready-a")
  let lectureB = try store.createSession(lectureId: "lecture-ownership-ready-b")
  try await prepare(engine, sessionId: lectureA.recordingSessionId)

  do {
    try await prepare(engine, sessionId: lectureB.recordingSessionId)
    throw AudioTestFailure(description: "A second session claimed the recorder while the first was merely ready")
  } catch is AudioTestFailure {
    throw AudioTestFailure(description: "A second session claimed the recorder while the first was merely ready")
  } catch let error as DurableRecorderCoreError {
    try require(error == .recorderBusy, "A ready-but-not-recording owner must still reject a different session's claim")
  }
}

private func testFinishAcrossPausedOwner() async throws {
  let root = temporaryRoot("ownership-finish-across-paused")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let lectureA = try store.createSession(lectureId: "lecture-ownership-finish-a")
  let lectureB = try store.createSession(lectureId: "lecture-ownership-finish-b")

  try await prepare(engine, sessionId: lectureA.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: lectureA.recordingSessionId)
  _ = try engine.pauseRecording(recordingSessionId: lectureA.recordingSessionId)
  let pausedA = try store.getSession(recordingSessionId: lectureA.recordingSessionId)

  // Finish on B (never even started/prepared, cold) must not be blocked by
  // A merely holding ownership while paused.
  try await prepare(engine, sessionId: lectureB.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: lectureB.recordingSessionId)
  _ = try engine.stopRecording(recordingSessionId: lectureB.recordingSessionId)
  let finalizedB = try store.getSession(recordingSessionId: lectureB.recordingSessionId)
  try require(finalizedB.state == .finalized, "Finish must succeed for B despite A merely holding ownership while paused")

  let untouchedA = try store.getSession(recordingSessionId: lectureA.recordingSessionId)
  try require(untouchedA == pausedA, "Finishing B must not touch A's preserved segments/state at all")
}

private func testFourLectureOwnershipCycling() async throws {
  // Directly represents the owner's real condition: four separate
  // paused/recoverable lectures, each with its own committed segment,
  // cycling which one currently owns the recorder — proving ownership
  // transfer never corrupts any of the other three's data.
  let root = temporaryRoot("ownership-four-lectures")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  let lectures = try (["a", "b", "c", "d"]).map { try store.createSession(lectureId: "lecture-four-\($0)") }

  for lecture in lectures {
    try await prepare(engine, sessionId: lecture.recordingSessionId)
    _ = try engine.startRecording(recordingSessionId: lecture.recordingSessionId)
    _ = try engine.pauseRecording(recordingSessionId: lecture.recordingSessionId)
  }
  // Every lecture must independently show exactly one committed segment —
  // creating/pausing D must not have disturbed A, B, or C at all.
  for lecture in lectures {
    let session = try store.getSession(recordingSessionId: lecture.recordingSessionId)
    try require(session.state == .paused && session.segments.count == 1, "\(lecture.lectureId) must be paused with its own single segment")
  }

  // Resume each one in turn (not necessarily in creation order) and prove
  // every other one stays exactly as it was. Tracks each lecture's expected
  // segment count explicitly (1 until its own turn, 2 after) rather than
  // assuming an order, so a regression in ANY lecture's isolation is caught
  // precisely, not just "something changed."
  var expectedSegmentCount = [String: Int](uniqueKeysWithValues: lectures.map { ($0.recordingSessionId, 1) })
  let resumeOrder = [2, 0, 3, 1] // C, A, D, B
  for index in resumeOrder {
    let target = lectures[index]
    _ = try engine.resumeRecording(recordingSessionId: target.recordingSessionId)
    let resumed = try store.getSession(recordingSessionId: target.recordingSessionId)
    try require(resumed.state == .recording, "\(target.lectureId) must resume regardless of which lecture currently held ownership")
    _ = try engine.pauseRecording(recordingSessionId: target.recordingSessionId)
    let afterCycle = try store.getSession(recordingSessionId: target.recordingSessionId)
    try require(afterCycle.segments.count == 2, "\(target.lectureId) must have gained exactly one more committed segment")
    expectedSegmentCount[target.recordingSessionId] = 2

    for other in lectures {
      let session = try store.getSession(recordingSessionId: other.recordingSessionId)
      try require(session.state == .paused, "\(other.lectureId) must be paused after this cycle, regardless of whose turn it was")
      try require(
        session.segments.count == expectedSegmentCount[other.recordingSessionId],
        "\(other.lectureId) must have exactly its own expected segment count — untouched unless it was THIS cycle's target"
      )
    }
  }

  // Final sanity: total segment count across all four must equal exactly
  // (1 initial + 1 resumed) each — no lecture was silently dropped, merged,
  // or duplicated across the whole cycling sequence.
  for lecture in lectures {
    let session = try store.getSession(recordingSessionId: lecture.recordingSessionId)
    try require(session.segments.count == 2, "\(lecture.lectureId) must end with exactly 2 segments — its original plus its one resume")
    try require(session.segments.map(\.sequence) == [1, 2], "\(lecture.lectureId)'s segment sequence must stay contiguous and its own")
  }
}

private func testCheckpointStatusListenerRegression() async throws {
  let root = temporaryRoot("checkpoint-listener")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, _, _) = try makeEngine(root: root)
  var payloads: [[String: Any]] = []
  engine.onStatusChange = { payloads.append($0) }

  let session = try store.createSession(lectureId: "lecture-checkpoint-listener")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  let afterStart = payloads.count
  try engine.performCheckpointForTesting()
  try engine.performCheckpointForTesting()
  try require(payloads.count == afterStart, "Successful checkpoints must not emit paused/finalized events")

  engine.simulateInterruptionBeganForTesting()
  try require(payloads.count == afterStart + 1, "Real forced pause must still publish")
  try require((payloads.last?["runtimeState"] as? String) == "interrupted", "R3 interruption sync must remain")
  let sequence = payloads.last?["statusSequence"] as? Int ?? 0
  try require(sequence > 0, "Forced-pause statusSequence must remain gated and positive")
}

private func testLongSessionSegmentCounts() async throws {
  let root = temporaryRoot("checkpoint-long-session")
  defer { try? FileManager.default.removeItem(at: root) }
  // Deterministic stand-in for 60 / 90 / 180 minute lectures at a 60s cadence:
  // one performCheckpoint ≈ one production interval without waiting in real time.
  let lectureCheckpointCounts = [60, 90, 180]
  for checkpointCount in lectureCheckpointCounts {
    let (store, engine, _, factory, _) = try makeEngine(root: root)
    let session = try store.createSession(lectureId: "lecture-long-\(checkpointCount)")
    try await prepare(engine, sessionId: session.recordingSessionId)
    _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
    for _ in 0..<checkpointCount {
      try engine.performCheckpointForTesting()
    }
    let recording = try store.getSession(recordingSessionId: session.recordingSessionId)
    try require(recording.state == .recording, "Long session must remain recording")
    try require(
      recording.segments.count == checkpointCount,
      "Expected \(checkpointCount) committed checkpoint segments"
    )
    try require(
      recording.segments.map(\.sequence) == Array(1...checkpointCount),
      "Long-session sequences must stay contiguous"
    )
    let cumulative = recording.segments.reduce(0) { $0 + $1.durationMs }
    try require(cumulative == checkpointCount * 1_250, "Duration accumulation must stay exact")
    try require(factory.createdURLs.count == checkpointCount + 1, "One active segment must remain open")
    _ = try engine.stopRecording(recordingSessionId: session.recordingSessionId)
    let finalized = try store.getSession(recordingSessionId: session.recordingSessionId)
    try require(
      finalized.segments.count == checkpointCount + 1,
      "Finish must append the trailing active segment once"
    )
  }
}

private func testScheduledCheckpointTimerFires() async throws {
  let root = temporaryRoot("checkpoint-timer")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, _, factory, _) = try makeEngine(root: root, checkpointInterval: 0.05)
  let session = try store.createSession(lectureId: "lecture-checkpoint-timer")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)

  var committed = 0
  let deadline = Date().addingTimeInterval(2.0)
  while Date() < deadline {
    committed = try store.getSession(recordingSessionId: session.recordingSessionId).segments.count
    if committed >= 1 { break }
    Thread.sleep(forTimeInterval: 0.02)
  }
  try require(committed >= 1, "Short-interval timer must commit at least one checkpoint segment")
  let status = engine.getRecordingStatus()
  try require((status["runtimeState"] as? String) == "recording", "Timer checkpoint must keep runtime recording")
  try require(factory.createdURLs.count >= 2, "Timer checkpoint must open the next segment")
  _ = try engine.pauseRecording(recordingSessionId: session.recordingSessionId)
}

// ===== Rollover diagnostics (evidence only; no behavioral change) =====

private final class DiagAudioSession: DurableAudioSessionManaging {
  var permissionState: DurableRecorderPermissionState = .granted
  var routeDescription = "MicrophoneBuiltIn:iPad Microphone"
  var failStage: String?
  /// After a successful activation the input disappears (proves the RE-check boundary).
  var inputVanishesAfterActivation = false
  private var activated = false
  private(set) var lastActivationStage = "idle"
  var category = "record"
  var deactivations = 0

  var hasSuitableInput: Bool { !(inputVanishesAfterActivation && activated) }
  func requestPermission() async -> DurableRecorderPermissionState { permissionState }
  func activateForRecording() throws {
    lastActivationStage = "set_category"
    if failStage == "set_category" { throw diagError(560_030_580) }
    lastActivationStage = "set_active"
    if failStage == "set_active" { category = "playAndRecord"; throw diagError(561_017_449) }
    lastActivationStage = "input_availability"
    if failStage == "input_availability" { throw DurableRecorderCoreError.noAudioInput }
    activated = true
    lastActivationStage = "activated"
  }
  func deactivate() { deactivations += 1; activated = false }
  func diagnosticSnapshot() -> [String: Any] {
    ["category": category, "mode": "default", "options": 4, "inputs": ["MicrophoneBuiltIn:iPad Microphone"], "otherAudioPlaying": false]
  }
  private func diagError(_ code: Int) -> NSError {
    NSError(
      domain: NSOSStatusErrorDomain,
      code: code,
      userInfo: [
        NSLocalizedDescriptionKey: "The operation couldn\u{2019}t be completed (diag \(code)).",
        NSUnderlyingErrorKey: NSError(domain: "com.apple.coreaudio.avfaudio", code: 1_701_737_535, userInfo: [NSLocalizedDescriptionKey: "underlying detail"]),
      ]
    )
  }
}

private final class DiagCapture: DurableAudioCapture {
  private let url: URL
  private let prepareResult: Bool
  private let recordResult: Bool
  private(set) var isRecording = false
  init(url: URL, prepare: Bool, record: Bool) { self.url = url; prepareResult = prepare; recordResult = record }
  func prepareToRecord() -> Bool { prepareResult }
  func record() -> Bool {
    guard recordResult else { return false }
    isRecording = true
    FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 9, count: 2_048))
    return true
  }
  func stop() { isRecording = false }
}

private final class DiagCaptureFactory: DurableAudioCaptureFactory {
  var mode = "ok"   // ok | throw | prepare_false | record_false
  func makeCapture(url: URL) throws -> DurableAudioCapture {
    if mode == "throw" { throw NSError(domain: AVFoundationErrorDomainForTest, code: -11_800, userInfo: [NSLocalizedDescriptionKey: "recorder init failed"]) }
    return DiagCapture(url: url, prepare: mode != "prepare_false", record: mode != "record_false")
  }
}
private let AVFoundationErrorDomainForTest = "AVFoundationErrorDomain"

private func makeDiagEngine(
  root: URL,
  enabled: Bool = true,
  fileURL: ((DurableRecorderStore, String) -> URL?)? = nil
) throws -> (DurableRecorderStore, DurableForegroundRecorder, DiagAudioSession, DiagCaptureFactory) {
  let store = try DurableRecorderStore(rootURL: root)
  let session = DiagAudioSession()
  let factory = DiagCaptureFactory()
  let diagnostics = DurableRecorderDiagnostics(enabled: enabled, fileURL: { id in
    fileURL?(store, id) ?? store.diagnosticsFileURL(recordingSessionId: id)
  })
  let engine = DurableForegroundRecorder(
    store: store, audioSession: session, captureFactory: factory, fileInspector: FakeFileInspector(),
    checkpointInterval: 0, observeSystemNotifications: false, diagnostics: diagnostics
  )
  return (store, engine, session, factory)
}

private func readDiagnosticEvents(_ store: DurableRecorderStore, _ sessionId: String) -> [[String: Any]] {
  guard let url = store.diagnosticsFileURL(recordingSessionId: sessionId),
        let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
  return text.split(separator: "\n").compactMap {
    (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
  }
}

private func startDiagRecording(
  _ engine: DurableForegroundRecorder, _ store: DurableRecorderStore, lecture: String
) async throws -> String {
  let session = try store.createSession(lectureId: lecture)
  _ = try await engine.prepareRecording(recordingSessionId: session.recordingSessionId, requestPermission: false)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  return session.recordingSessionId
}

private func testRolloverDiagnosticStagesAreDistinctAndFaithful() async throws {
  // (label, arm failure, expected stage, extra checks)
  let cases: [(String, (DiagAudioSession, DiagCaptureFactory) -> Void, String)] = [
    ("set_category", { s, _ in s.failStage = "set_category" }, "audio_session.set_category"),
    ("set_active", { s, _ in s.failStage = "set_active" }, "audio_session.set_active"),
    ("input_availability", { s, _ in s.failStage = "input_availability" }, "audio_session.input_availability"),
    ("input_recheck", { s, _ in s.inputVanishesAfterActivation = true }, "input_availability_recheck"),
    ("recorder_init", { _, f in f.mode = "throw" }, "recorder_init"),
    ("prepare_to_record", { _, f in f.mode = "prepare_false" }, "prepare_to_record"),
    ("record", { _, f in f.mode = "record_false" }, "record"),
  ]
  var seenStages = Set<String>()
  for (label, arm, expectedStage) in cases {
    let root = temporaryRoot("diag-stage-\(label)")
    defer { try? FileManager.default.removeItem(at: root) }
    let (store, engine, audioSession, factory) = try makeDiagEngine(root: root)
    let id = try await startDiagRecording(engine, store, lecture: "lecture-diag-\(label)")
    arm(audioSession, factory)
    var threw = false
    do { try engine.performCheckpointForTesting() } catch { threw = true }
    try require(threw, "\(label): the injected boundary failure must still surface exactly as before")

    // BEHAVIOR IS UNCHANGED: committed segment kept, session paused, next segment never opened.
    let after = try store.getSession(recordingSessionId: id)
    try require(after.state == .paused, "\(label): a failed rollover must still pause the session")
    try require(after.segments.count == 1 && after.segments[0].interruptionReason == "checkpoint", "\(label): committed checkpoint kept")

    let events = readDiagnosticEvents(store, id)
    guard let failure = events.first(where: { ($0["kind"] as? String) == "begin_failed" && ($0["ctx"] as? String) == "checkpoint" }) else {
      throw AudioTestFailure(description: "\(label): a checkpoint begin failure must persist a begin_failed event; got \(events.map { $0["kind"] ?? "?" })")
    }
    try require((failure["stage"] as? String) == expectedStage, "\(label): stage must be \(expectedStage), got \(String(describing: failure["stage"]))")
    seenStages.insert(expectedStage)
    try require((failure["cp"] as? Int) == 1, "\(label): checkpoint ordinal recorded")
    try require((failure["seq"] as? Int) == 2, "\(label): the segment being opened is sequence 2")
    try require((failure["lecture"] as? String) == "lecture-diag-\(label)", "\(label): lecture id recorded")
    try require((failure["sid"] as? String) == id, "\(label): session id recorded")
    try require(failure["pre"] != nil && failure["atFailure"] != nil, "\(label): pre-rollover and at-failure audio-session snapshots persisted")
    try require(failure["stopToFailMs"] != nil, "\(label): time from the previous stop to the failure recorded")
    let recorder = failure["recorder"] as? [String: Any] ?? [:]
    switch label {
    case "recorder_init":
      try require((recorder["exists"] as? Bool) == false, "recorder_init: no recorder exists")
      let error = failure["error"] as? [String: Any] ?? [:]
      try require((error["domain"] as? String) == AVFoundationErrorDomainForTest && (error["code"] as? Int) == -11_800, "recorder_init: NSError domain/code survive persistence")
      try require((error["desc"] as? String) == "recorder init failed", "recorder_init: localized description survives")
    case "prepare_to_record":
      try require((recorder["exists"] as? Bool) == true && (recorder["prepared"] as? Bool) == false && recorder["recordReturned"] == nil, "prepare_to_record: prepare false, record never attempted")
    case "record":
      try require((recorder["prepared"] as? Bool) == true && (recorder["recordReturned"] as? Bool) == false, "record: prepare true, record() false")
    case "set_category", "set_active":
      let error = failure["error"] as? [String: Any] ?? [:]
      try require((error["domain"] as? String) == NSOSStatusErrorDomain, "\(label): NSError domain survives")
      let expectedCode = label == "set_category" ? 560_030_580 : 561_017_449
      try require((error["code"] as? Int) == expectedCode, "\(label): NSError code survives")
      try require((error["fourCC"] as? String) != nil, "\(label): FourCC decoded")
      try require((error["desc"] as? String)?.contains("diag \(expectedCode)") == true, "\(label): localized description survives")
      let underlying = error["underlying"] as? [String: Any]
      try require((underlying?["domain"] as? String) == "com.apple.coreaudio.avfaudio" && (underlying?["code"] as? Int) == 1_701_737_535, "\(label): underlying error chain survives")
    default: break
    }
    if label == "set_active" {
      // The audio session changed under the recorder between the pre-rollover snapshot and the failure.
      let pre = failure["pre"] as? [String: Any] ?? [:]
      let atFailure = failure["atFailure"] as? [String: Any] ?? [:]
      try require((pre["category"] as? String) == "record" && (atFailure["category"] as? String) == "playAndRecord", "pre and at-failure snapshots must be captured at different moments")
    }
  }
  try require(seenStages.count == cases.count, "every reachable begin boundary maps to its own distinct stage id")
}

private func testRolloverSuccessEventsAndBoundedLog() async throws {
  let root = temporaryRoot("diag-success")
  defer { try? FileManager.default.removeItem(at: root) }
  let (store, engine, audioSession, factory) = try makeDiagEngine(root: root)
  let id = try await startDiagRecording(engine, store, lecture: "lecture-diag-success")
  for _ in 0..<3 { try engine.performCheckpointForTesting() }
  var events = readDiagnosticEvents(store, id)
  let kinds = events.compactMap { $0["kind"] as? String }
  for expected in ["rollover_start", "old_segment_committed", "begin_started", "begin_succeeded"] {
    try require(kinds.filter { $0 == expected }.count >= 3, "each of the 3 rollovers must persist \(expected)")
  }
  let succeeded = events.filter { ($0["kind"] as? String) == "begin_succeeded" && ($0["ctx"] as? String) == "checkpoint" }
  try require(succeeded.map { $0["seq"] as? Int } == [2, 3, 4], "new sequence numbers recorded")
  try require(succeeded.allSatisfy { ($0["stopToRecordMs"] as? Double) != nil }, "the old-stop → new-recording gap is measured for every successful rollover")
  let committedEvents = events.filter { ($0["kind"] as? String) == "old_segment_committed" }
  try require(committedEvents.map { $0["oldSeq"] as? Int } == [1, 2, 3], "old sequence numbers recorded")

  // One early failure, then a long run: the log stays bounded and the failure record survives trimming.
  audioSession.failStage = "set_active"
  do { try engine.performCheckpointForTesting() } catch {}
  audioSession.failStage = nil
  _ = try engine.resumeRecording(recordingSessionId: id)
  for _ in 0..<400 { try engine.performCheckpointForTesting() }
  events = readDiagnosticEvents(store, id)
  let url = store.diagnosticsFileURL(recordingSessionId: id)!
  let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
  try require(events.count <= DurableRecorderDiagnostics.maxLines + 8, "bounded line count after 400 rollovers: \(events.count)")
  try require(size < 200_000, "bounded file size after 400 rollovers: \(size) bytes")
  try require(events.contains { ($0["kind"] as? String) == "begin_failed" }, "failure evidence survives trimming")
  _ = factory
}

private func testDiagnosticPersistenceCannotBreakRecording() async throws {
  // A diagnostics location that can never be written (a path under a regular file) and one that resolves to nil.
  for label in ["unwritable", "nil_url"] {
    let root = temporaryRoot("diag-broken-\(label)")
    defer { try? FileManager.default.removeItem(at: root) }
    let blocker = root.appendingPathComponent("blocker")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: blocker.path, contents: Data([1]))
    let (store, engine, audioSession, _) = try makeDiagEngine(root: root) { _, _ in
      label == "nil_url" ? nil : blocker.appendingPathComponent("nested/diagnostics.jsonl")
    }
    let id = try await startDiagRecording(engine, store, lecture: "lecture-diag-broken-\(label)")
    for _ in 0..<3 { try engine.performCheckpointForTesting() }
    audioSession.failStage = "set_category"
    var threw = false
    do { try engine.performCheckpointForTesting() } catch { threw = true }
    try require(threw, "\(label): failure semantics unchanged")
    let after = try store.getSession(recordingSessionId: id)
    try require(after.state == .paused && after.segments.count == 4, "\(label): session metadata and segments unaffected by a diagnostics failure")
    audioSession.failStage = nil
    _ = try engine.resumeRecording(recordingSessionId: id)
    _ = try engine.stopRecording(recordingSessionId: id)
    let finished = try store.getSession(recordingSessionId: id)
    try require(finished.state == .finalized, "\(label): Resume + Finish still work")
  }
}

private func testDiagnosticsAreOffByDefaultAndAddNoFiles() async throws {
  let root = temporaryRoot("diag-off")
  defer { try? FileManager.default.removeItem(at: root) }
  // Default construction (no injected diagnostics) is what Production runs: bundle id is not a Dev bundle here.
  let (store, engine, audioSession, _, _) = try makeEngine(root: root)
  let session = try store.createSession(lectureId: "lecture-diag-off")
  try await prepare(engine, sessionId: session.recordingSessionId)
  _ = try engine.startRecording(recordingSessionId: session.recordingSessionId)
  try engine.performCheckpointForTesting()
  _ = audioSession
  try require(store.diagnosticsFileURL(recordingSessionId: session.recordingSessionId).map { !FileManager.default.fileExists(atPath: $0.path) } ?? false, "no diagnostics file is created unless explicitly enabled")
  try require(!DurableRecorderDiagnostics.isDevBundle, "the test host is not a Dev bundle, so the default is OFF")
  try require(DurableRecorderDiagnostics.fourCC(560_030_580) == "!act", "FourCC decoding")
  try require(DurableRecorderDiagnostics.fourCC(-11_800) == nil && DurableRecorderDiagnostics.fourCC(12) == nil, "non-FourCC codes are left numeric")
}

@main
private enum DurableRecorderAudioTestRunner {
  static func main() async throws {
    try await testLifecycleAndImmutableSegments()
    try await testOwnershipAndStartFailure()
    try await testInterruptionRouteAndRestart()
    try await testReconciliationPolicies()
    try await testSeparateSessionBoundariesAndNoInput()
    try await testInvalidSegmentMetadataVersions()
    try await testForcedPausePublishesStatus()
    try await testAutomaticCheckpointCommitsSegment()
    try await testMultipleCheckpoints()
    try await testFinishAfterCheckpoints()
    try await testPauseDuringCheckpointWindow()
    try await testResumeAfterCheckpointedPause()
    try await testFinishCheckpointRace()
    try await testForcedPauseCheckpointRace()
    try await testStaleCheckpointCallback()
    try await testInvalidCheckpointOutput()
    try await testCheckpointBeginSegmentFailurePreservesAudio()
    try await testResumeAfterFailedCheckpointRollover()
    try await testFinishAfterFailedCheckpointRollover()
    try await testPausedOwnerReleasedForDifferentSessionResume()
    try await testActiveOwnerStillBlocksDifferentSessionClaim()
    try await testReadyOwnerStillBlocksDifferentSessionClaim()
    try await testFinishAcrossPausedOwner()
    try await testFourLectureOwnershipCycling()
    try await testCheckpointStatusListenerRegression()
    try await testLongSessionSegmentCounts()
    try await testScheduledCheckpointTimerFires()
    try await testRolloverDiagnosticStagesAreDistinctAndFaithful()
    try await testRolloverSuccessEventsAndBoundedLog()
    try await testDiagnosticPersistenceCannotBreakRecording()
    try await testDiagnosticsAreOffByDefaultAndAddNoFiles()
    print("Durable recorder native audio engine tests passed.")
  }
}
