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
  var failNext = false
  private(set) var createdURLs: [URL] = []

  func makeCapture(url: URL) throws -> DurableAudioCapture {
    createdURLs.append(url)
    let shouldStart = !failNext
    failNext = false
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
    observeSystemNotifications: false
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
    try await testCheckpointStatusListenerRegression()
    try await testLongSessionSegmentCounts()
    try await testScheduledCheckpointTimerFires()
    print("Durable recorder native audio engine tests passed.")
  }
}
