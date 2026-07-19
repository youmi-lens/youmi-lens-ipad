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

private struct FakeFileInspector: DurableAudioFileInspecting {
  func inspect(url: URL) throws -> DurableAudioFileInspection {
    let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    guard size > 0 else {
      throw DurableRecorderCoreError.segmentValidationFailed("empty test asset")
    }
    return DurableAudioFileInspection(
      durationMs: 1_250,
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

private func makeEngine(root: URL) throws -> (
  DurableRecorderStore,
  DurableForegroundRecorder,
  FakeAudioSession,
  FakeCaptureFactory
) {
  let store = try DurableRecorderStore(rootURL: root)
  let audioSession = FakeAudioSession()
  let factory = FakeCaptureFactory()
  let engine = DurableForegroundRecorder(
    store: store,
    audioSession: audioSession,
    captureFactory: factory,
    fileInspector: FakeFileInspector(),
    observeSystemNotifications: false
  )
  return (store, engine, audioSession, factory)
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
  let (store, engine, audioSession, factory) = try makeEngine(root: root)
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
  let (store, engine, _, factory) = try makeEngine(root: root)
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
  let (store, firstEngine, _, _) = try makeEngine(root: root)
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

  let (_, restartedEngine, _, _) = try makeEngine(root: root)
  let recovery = try restartedEngine.recoverRecordingSession(recordingSessionId: session.recordingSessionId)
  try require(recovery.session.segments.count == 2, "Restart recovery must discover completed segments")
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
  let (store, engine, _, _) = try makeEngine(root: root)
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
  let (store, engine, audioSession, _) = try makeEngine(root: firstRoot)
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
  let (store, engine, _, _) = try makeEngine(root: root)
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

@main
private enum DurableRecorderAudioTestRunner {
  static func main() async throws {
    try await testLifecycleAndImmutableSegments()
    try await testOwnershipAndStartFailure()
    try await testInterruptionRouteAndRestart()
    try await testReconciliationPolicies()
    try await testSeparateSessionBoundariesAndNoInput()
    try await testInvalidSegmentMetadataVersions()
    print("Durable recorder native audio engine tests passed.")
  }
}
