import AVFoundation
import Foundation

// Bounded checkpoint-rollover recovery: after a checkpoint SUCCESSFULLY commits segment N, a transient failure to
// open segment N+1 gets exactly ONE retry (same logical sequence, new segment id/file), otherwise the recorder pauses
// exactly as before. These tests drive the production recorder with real AAC segments and the real inspector,
// injecting a failure at every stage of `beginSegment`.

private struct RetryTestFailure: Error, CustomStringConvertible { let description: String }
private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if !(try condition()) { throw RetryTestFailure(description: message) }
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

private final class Box<T> {
  var value: T
  init(_ value: T) { self.value = value }
}

private final class ManualClock { var now: TimeInterval = 5_000 }

/// Which begin ATTEMPT (counted by audio-session activations, 1-based, across the whole run) fails, and how.
private final class Faults {
  var byActivation: [Int: String] = [:]
  var activation = 0
  var current: String? { byActivation[activation] }
}

private func stageError(_ code: Int) -> NSError {
  NSError(
    domain: NSOSStatusErrorDomain, code: code,
    userInfo: [
      NSLocalizedDescriptionKey: "injected audio session failure \(code)",
      NSUnderlyingErrorKey: NSError(domain: "com.apple.coreaudio.avfaudio", code: 1_701_737_535, userInfo: [NSLocalizedDescriptionKey: "underlying detail"]),
    ]
  )
}

private final class RetrySession: DurableAudioSessionManaging {
  let faults: Faults
  var permissionState: DurableRecorderPermissionState = .granted
  var routeDescription = "MicrophoneBuiltIn:iPad Microphone"
  var deactivations = 0
  var onActivate: ((Int) -> Void)?
  private var recheckFailsOnce = false
  private(set) var lastActivationStage = "idle"
  init(faults: Faults) { self.faults = faults }

  var hasSuitableInput: Bool {
    if recheckFailsOnce { recheckFailsOnce = false; return false }
    return true
  }
  func requestPermission() async -> DurableRecorderPermissionState { permissionState }
  func activateForRecording() throws {
    faults.activation += 1
    onActivate?(faults.activation)
    let fault = faults.current
    lastActivationStage = "set_category"
    if fault == "set_category" { throw stageError(560_030_580) }
    lastActivationStage = "set_active"
    if fault == "set_active" { throw stageError(561_017_449) }
    lastActivationStage = "input_availability"
    if fault == "input_availability" {
      deactivate() // the real manager deactivates itself before throwing noAudioInput
      throw DurableRecorderCoreError.noAudioInput
    }
    if fault == "input_recheck" { recheckFailsOnce = true }
    lastActivationStage = "activated"
  }
  func deactivate() { deactivations += 1 }
  func diagnosticSnapshot() -> [String: Any] {
    ["category": "AVAudioSessionCategoryRecord", "mode": "AVAudioSessionModeDefault", "options": 4,
     "inputs": ["MicrophoneBuiltIn:iPad Microphone"], "otherAudioPlaying": false]
  }
}

private final class RetryCapture: DurableAudioCapture {
  private let url: URL
  private let fault: String?
  private let activation: Int
  private let tone: Double
  var onPrepared: ((Int) -> Void)?
  var onRecorded: ((Int) -> Void)?
  private(set) var isRecording = false
  init(url: URL, fault: String?, activation: Int, tone: Double) {
    self.url = url; self.fault = fault; self.activation = activation; self.tone = tone
  }
  /// AVAudioRecorder creates the file at prepareToRecord(); the fake does the same (placeholder bytes).
  func prepareToRecord() -> Bool {
    FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 7, count: 512))
    onPrepared?(activation)
    return fault != "prepare_false"
  }
  func record() -> Bool {
    if fault == "record_false" { return false }
    try? FileManager.default.removeItem(at: url)
    guard (try? writeTone(to: url, frequency: tone, seconds: 1.0)) != nil else { return false }
    isRecording = true
    onRecorded?(activation)
    return true
  }
  func stop() { isRecording = false }
}

private final class RetryFactory: DurableAudioCaptureFactory {
  let faults: Faults
  var captures: [RetryCapture] = []
  var onPrepared: ((Int) -> Void)?
  var onRecorded: ((Int) -> Void)?
  init(faults: Faults) { self.faults = faults }
  var liveCount: Int { captures.filter(\.isRecording).count }
  func makeCapture(url: URL) throws -> DurableAudioCapture {
    if faults.current == "init_throw" {
      throw NSError(domain: "AVFoundationErrorDomain", code: -11_800, userInfo: [NSLocalizedDescriptionKey: "recorder init failed"])
    }
    let capture = RetryCapture(url: url, fault: faults.current, activation: faults.activation, tone: 440 + Double(captures.count) * 110)
    capture.onPrepared = { [weak self] in self?.onPrepared?($0) }
    capture.onRecorded = { [weak self] in self?.onRecorded?($0) }
    captures.append(capture)
    return capture
  }
}

private struct Rig {
  let root: URL
  let store: DurableRecorderStore
  let engine: DurableForegroundRecorder
  let session: RetrySession
  let factory: RetryFactory
  let faults: Faults
  let clock: ManualClock
  let sleeps: Box<[TimeInterval]>
  let sleepHook: Box<(() -> Void)?>
  let statuses: Box<[[String: Any]]>
  func cleanup() { try? FileManager.default.removeItem(at: root) }
}

private func makeRig(
  diagnostics: Bool = true,
  interval: TimeInterval = 3_600,
  delay: TimeInterval = DurableCheckpointRetryPolicy.productionDelay,
  elapsedBudget: TimeInterval = DurableCheckpointRetryPolicy.productionElapsedBudget
) throws -> Rig {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("durable-checkpoint-retry-\(UUID().uuidString)", isDirectory: true)
  let store = try DurableRecorderStore(rootURL: root)
  let faults = Faults()
  let session = RetrySession(faults: faults)
  let factory = RetryFactory(faults: faults)
  let clock = ManualClock()
  let sleeps = Box<[TimeInterval]>([])
  let sleepHook = Box<(() -> Void)?>(nil)
  let policy = DurableCheckpointRetryPolicy(
    delay: delay, elapsedBudget: elapsedBudget,
    sleep: { seconds in sleeps.value.append(seconds); clock.now += seconds; sleepHook.value?() },
    uptime: { clock.now }
  )
  let engine = DurableForegroundRecorder(
    store: store, audioSession: session, captureFactory: factory,
    fileInspector: SystemDurableAudioFileInspector(),
    checkpointInterval: interval, observeSystemNotifications: false,
    checkpointRetryPolicy: policy,
    diagnostics: DurableRecorderDiagnostics(enabled: diagnostics, fileURL: { store.diagnosticsFileURL(recordingSessionId: $0) })
  )
  let statuses = Box<[[String: Any]]>([])
  engine.onStatusChange = { statuses.value.append($0) }
  return Rig(root: root, store: store, engine: engine, session: session, factory: factory, faults: faults,
             clock: clock, sleeps: sleeps, sleepHook: sleepHook, statuses: statuses)
}

private func startRecording(_ rig: Rig) async throws -> String {
  let session = try rig.store.createSession(lectureId: "lecture-checkpoint-retry")
  _ = try await rig.engine.prepareRecording(recordingSessionId: session.recordingSessionId, requestPermission: false)
  _ = try rig.engine.startRecording(recordingSessionId: session.recordingSessionId)
  return session.recordingSessionId
}

private func sessionDirectory(_ rig: Rig, _ sid: String) -> URL {
  rig.root.appendingPathComponent("sessions/\(sid)", isDirectory: true)
}

private func names(_ directory: URL) -> [String] {
  ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
}

/// Bytes of every committed segment file, keyed by manifest relative path.
private func committedBytes(_ store: DurableRecorderStore, _ root: URL, _ sid: String) throws -> [String: Data] {
  var out: [String: Data] = [:]
  for segment in try store.getSession(recordingSessionId: sid).segments {
    out[segment.relativePath] = try Data(contentsOf: root.appendingPathComponent("sessions/\(sid)/\(segment.relativePath)"))
  }
  return out
}

private func readEvents(_ store: DurableRecorderStore, _ sid: String) -> [[String: Any]] {
  guard let url = store.diagnosticsFileURL(recordingSessionId: sid),
        let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
  return text.split(separator: "\n").compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
}

private func kind(_ events: [[String: Any]], _ kind: String) -> [[String: Any]] {
  events.filter { ($0["kind"] as? String) == kind }
}

private func uuid(inPartialName name: String) -> String? {
  // NNNNNN-<uuid>.partial.m4a
  guard name.count > 43 else { return nil }
  let start = name.index(name.startIndex, offsetBy: 7)
  return String(name[start..<name.index(start, offsetBy: 36)])
}

private func publishedFailures(_ rig: Rig) -> Int {
  rig.statuses.value.filter { ($0["interruptionState"] as? String) == "checkpoint_begin_segment_failed" }.count
}

private struct StageSpec {
  let fault: String
  let stage: String
  let planAllocated: Bool
  let leavesPartial: Bool
  let errorMatches: ([String: Any]) -> Bool
}

private let retryableStages: [StageSpec] = [
  StageSpec(fault: "set_category", stage: "audio_session.set_category", planAllocated: false, leavesPartial: false,
            errorMatches: { ($0["domain"] as? String) == NSOSStatusErrorDomain && ($0["code"] as? Int) == 560_030_580
              && (($0["underlying"] as? [String: Any])?["code"] as? Int) == 1_701_737_535 }),
  StageSpec(fault: "set_active", stage: "audio_session.set_active", planAllocated: false, leavesPartial: false,
            errorMatches: { ($0["domain"] as? String) == NSOSStatusErrorDomain && ($0["code"] as? Int) == 561_017_449 }),
  StageSpec(fault: "input_availability", stage: "audio_session.input_availability", planAllocated: false, leavesPartial: false,
            errorMatches: { ($0["swift"] as? String)?.contains("noAudioInput") == true }),
  StageSpec(fault: "input_recheck", stage: "input_availability_recheck", planAllocated: false, leavesPartial: false,
            errorMatches: { ($0["swift"] as? String)?.contains("noAudioInput") == true }),
  StageSpec(fault: "init_throw", stage: "recorder_init", planAllocated: true, leavesPartial: false,
            errorMatches: { ($0["domain"] as? String) == "AVFoundationErrorDomain" && ($0["code"] as? Int) == -11_800 }),
  StageSpec(fault: "prepare_false", stage: "prepare_to_record", planAllocated: true, leavesPartial: true,
            errorMatches: { ($0["swift"] as? String)?.contains("recorderStartFailed") == true }),
  StageSpec(fault: "record_false", stage: "record", planAllocated: true, leavesPartial: true,
            errorMatches: { ($0["swift"] as? String)?.contains("recorderStartFailed") == true }),
]

// MARK: - 1. Recovery at every retryable stage

private func testRecoversAtEveryRetryableStage() async throws {
  for spec in retryableStages {
    let rig = try makeRig()
    defer { rig.cleanup() }
    let label = spec.stage
    let sid = try await startRecording(rig)

    // Control: one ordinary rollover measures what a normal rollover does to the checkpoint timer generation.
    let g0 = rig.engine.checkpointIdentityForTesting()?.generation
    try rig.engine.performCheckpointForTesting()
    let g1 = rig.engine.checkpointIdentityForTesting()?.generation
    guard let g0, let g1 else { throw RetryTestFailure(description: "\(label): a checkpoint must be scheduled") }
    let controlDelta = g1 - g0

    let base = rig.faults.activation
    rig.faults.byActivation[base + 1] = spec.fault
    var atFail: [String: Data] = [:]
    var deactivationsAtAttempt: [Int: Int] = [:]
    rig.session.onActivate = { n in
      deactivationsAtAttempt[n] = rig.session.deactivations
      if n == base + 1 { atFail = (try? committedBytes(rig.store, rig.root, sid)) ?? [:] }
    }
    let publishedBefore = rig.statuses.value.count

    try rig.engine.performCheckpointForTesting()   // must NOT throw: the retry recovers

    try require(rig.faults.activation == base + 2, "\(label): exactly two attempts, got \(rig.faults.activation - base)")
    try require(atFail.count == 2, "\(label): the previous checkpoint segments were committed before the failure")
    let now = try rig.store.getSession(recordingSessionId: sid)
    try require(now.state == .recording, "\(label): session stays recording")
    try require(now.segments.map(\.sequence) == [1, 2], "\(label): committed sequence unchanged (no gap, no dup)")
    try require(try committedBytes(rig.store, rig.root, sid) == atFail, "\(label): committed audio is byte-identical")
    try require((rig.engine.getRecordingStatus()["runtimeState"] as? String) == "recording", "\(label): runtime stays recording")
    try require(rig.statuses.value.count == publishedBefore, "\(label): a recovered retry publishes no status (no paused flash)")
    try require(publishedFailures(rig) == 0, "\(label): JS never sees checkpoint_begin_segment_failed")
    try require(rig.factory.liveCount == 1, "\(label): exactly one recorder is active (got \(rig.factory.liveCount))")
    try require(rig.sleeps.value == [DurableCheckpointRetryPolicy.productionDelay], "\(label): one retry delay of \(DurableCheckpointRetryPolicy.productionDelay)s, got \(rig.sleeps.value)")
    try require(
      spec.fault == "input_availability" || deactivationsAtAttempt[base + 2] == deactivationsAtAttempt[base + 1],
      "\(label): the audio session is not deactivated between the attempts"
    )

    // Filesystem: committed segments, exactly one live partial, and the failed attempt's file accounted for.
    let segmentFiles = names(sessionDirectory(rig, sid).appendingPathComponent("segments"))
    let finalized = segmentFiles.filter { !$0.contains(".partial.") }
    let partials = segmentFiles.filter { $0.contains(".partial.") }
    try require(finalized.count == 2, "\(label): only the two committed segments are finalized files")
    try require(partials.count == 1, "\(label): exactly one live partial (the retry's), got \(partials)")
    let quarantine = names(sessionDirectory(rig, sid).appendingPathComponent("quarantine"))

    // Diagnostics: both attempts, the decision, the delay and the recovery.
    let events = readEvents(rig.store, sid).filter { ($0["cp"] as? Int) == 2 }
    let started = kind(events, "begin_started").filter { ($0["ctx"] as? String) == "checkpoint" }
    try require(started.compactMap { $0["attempt"] as? Int } == [1, 2], "\(label): begin_started for attempt 1 and 2")
    let failed = kind(events, "begin_failed")
    try require(failed.count == 1 && (failed[0]["attempt"] as? Int) == 1, "\(label): one begin_failed, attempt 1")
    try require((failed[0]["stage"] as? String) == spec.stage, "\(label): failure stage is \(spec.stage), got \(String(describing: failed[0]["stage"]))")
    try require(spec.errorMatches(failed[0]["error"] as? [String: Any] ?? [:]), "\(label): NSError details survive")
    try require((failed[0]["seq"] as? Int) == 3, "\(label): failed attempt was opening sequence 3")
    let decision = kind(events, "retry_decision")
    try require(decision.count == 1 && (decision[0]["eligible"] as? Bool) == true, "\(label): retry judged eligible")
    let retryStarted = kind(events, "retry_started")
    try require(retryStarted.count == 1, "\(label): one retry_started")
    try require((retryStarted[0]["delayMs"] as? Double) == 50, "\(label): delay recorded")
    try require(retryStarted[0]["firstAttemptMs"] is Double, "\(label): firstAttemptMs recorded")
    let succeeded = kind(events, "begin_succeeded").filter { ($0["ctx"] as? String) == "checkpoint" }
    try require(succeeded.count == 1 && (succeeded[0]["attempt"] as? Int) == 2 && (succeeded[0]["seq"] as? Int) == 3,
                "\(label): attempt 2 succeeded on the SAME sequence 3")
    try require(succeeded[0]["stopToRecordMs"] is Double, "\(label): stopToRecordMs recorded")
    let recovered = kind(events, "retry_succeeded")
    try require(recovered.count == 1 && (recovered[0]["stage"] as? String) == spec.stage && recovered[0]["stopToRecordMs"] is Double,
                "\(label): retry_succeeded keeps the first failure visible")
    try require(kind(events, "retry_failed").isEmpty && kind(events, "entered_paused_state").isEmpty, "\(label): no failure-path events")

    // Failed partial: never ambiguous.
    let livePartialUUID = uuid(inPartialName: partials[0])
    if spec.planAllocated {
      let planPath = failed[0]["planPath"] as? String ?? ""
      let failedUUID = uuid(inPartialName: (planPath as NSString).lastPathComponent)
      try require(failedUUID != nil && failedUUID != livePartialUUID, "\(label): the retry uses a NEW segment UUID")
      if spec.leavesPartial {
        try require((retryStarted[0]["failedPartial"] as? String)?.hasPrefix("quarantined:") == true, "\(label): failed partial quarantined")
        try require(quarantine.count == 1 && quarantine[0].contains(failedUUID!), "\(label): the quarantine holds exactly the failed partial, got \(quarantine)")
      } else {
        try require((retryStarted[0]["failedPartial"] as? String) == "absent", "\(label): no file was ever created")
        try require(quarantine.isEmpty, "\(label): nothing to quarantine")
      }
      try require(!segmentFiles.contains { $0.contains(failedUUID!) }, "\(label): the failed plan's file is out of segments/")
    } else {
      try require(failed[0]["planPath"] == nil && retryStarted[0]["failedPartial"] == nil, "\(label): no plan existed at this stage")
      try require(quarantine.isEmpty, "\(label): nothing to quarantine")
    }

    // The next checkpoint is scheduled exactly once, for the retry's segment.
    guard let identity = rig.engine.checkpointIdentityForTesting() else { throw RetryTestFailure(description: "\(label): no checkpoint scheduled after recovery") }
    try require(identity.generation - g1 == controlDelta, "\(label): checkpoint scheduling matches an ordinary rollover (\(identity.generation - g1) vs \(controlDelta))")
    try require(identity.sessionId == sid && identity.segmentId == livePartialUUID, "\(label): the checkpoint targets the retry's segment")

    // Finish: sequences contiguous, retry segment committed once under its own UUID.
    _ = try rig.engine.stopRecording(recordingSessionId: sid)
    let final = try rig.store.getSession(recordingSessionId: sid)
    try require(final.segments.map(\.sequence) == [1, 2, 3], "\(label): final sequences contiguous")
    try require(Set(final.segments.map(\.segmentId)).count == 3, "\(label): no duplicate manifest entry")
    try require(final.segments[2].segmentId == livePartialUUID, "\(label): sequence 3 is the retry's segment")
    let after = try committedBytes(rig.store, rig.root, sid)
    for (path, bytes) in atFail { try require(after[path] == bytes, "\(label): \(path) unchanged through Finish") }
  }
}

// MARK: - 2. Double failure

private func testDoubleFailureFallsBackToTodaysBehavior() async throws {
  for spec in retryableStages {
    let rig = try makeRig()
    defer { rig.cleanup() }
    let label = spec.stage + " x2"
    let sid = try await startRecording(rig)
    try rig.engine.performCheckpointForTesting()
    let base = rig.faults.activation
    rig.faults.byActivation[base + 1] = spec.fault
    rig.faults.byActivation[base + 2] = spec.fault
    var atFail: [String: Data] = [:]
    var deactivationsAtAttempt: [Int: Int] = [:]
    rig.session.onActivate = { n in
      deactivationsAtAttempt[n] = rig.session.deactivations
      if n == base + 1 { atFail = (try? committedBytes(rig.store, rig.root, sid)) ?? [:] }
    }
    let publishedBefore = rig.statuses.value.count

    do {
      try rig.engine.performCheckpointForTesting()
      throw RetryTestFailure(description: "\(label): a persistent failure must surface")
    } catch is RetryTestFailure { throw RetryTestFailure(description: "\(label): a persistent failure must surface") } catch {}

    try require(rig.faults.activation == base + 2, "\(label): exactly two attempts and no third, got \(rig.faults.activation - base)")
    try require(rig.sleeps.value == [DurableCheckpointRetryPolicy.productionDelay], "\(label): one delay only")
    let now = try rig.store.getSession(recordingSessionId: sid)
    try require(now.state == .paused, "\(label): session paused")
    try require(now.segments.map(\.sequence) == [1, 2], "\(label): committed segments preserved")
    try require(try committedBytes(rig.store, rig.root, sid) == atFail, "\(label): committed audio byte-identical")
    try require((rig.engine.getRecordingStatus()["runtimeState"] as? String) == "paused", "\(label): runtime paused")
    try require(rig.engine.getRecordingStatus()["activeSegmentId"] == nil, "\(label): no active capture")
    try require(rig.factory.liveCount == 0, "\(label): no recorder left running")
    try require(publishedFailures(rig) == 1 && rig.statuses.value.count == publishedBefore + 1,
                "\(label): checkpoint_begin_segment_failed published exactly once")
    let published = rig.statuses.value.last!
    try require((published["runtimeState"] as? String) == "paused" && ((published["session"] as? [String: Any])?["state"] as? String) == "paused",
                "\(label): published status is paused")
    try require(
      spec.fault == "input_availability" || deactivationsAtAttempt[base + 2] == deactivationsAtAttempt[base + 1],
      "\(label): no deactivation between the attempts"
    )
    try require(rig.session.deactivations > (deactivationsAtAttempt[base + 2] ?? 0), "\(label): the original final deactivation still happens")

    let events = readEvents(rig.store, sid).filter { ($0["cp"] as? Int) == 2 }
    let failures = kind(events, "begin_failed")
    try require(failures.compactMap { $0["attempt"] as? Int } == [1, 2], "\(label): both failures recorded")
    try require(failures.allSatisfy { ($0["stage"] as? String) == spec.stage && spec.errorMatches($0["error"] as? [String: Any] ?? [:]) },
                "\(label): both failures carry stage + NSError")
    let retryFailed = kind(events, "retry_failed")
    try require(retryFailed.count == 1 && (retryFailed[0]["firstStage"] as? String) == spec.stage && (retryFailed[0]["secondStage"] as? String) == spec.stage,
                "\(label): retry_failed records both stages")
    let paused = kind(events, "entered_paused_state")
    try require(paused.count == 1 && (paused[0]["cause"] as? String) == "retry_failed", "\(label): entered_paused_state recorded")
    try require(kind(events, "retry_succeeded").isEmpty, "\(label): no false recovery")

    // The manual path is untouched: Resume still works and continues at the same sequence.
    rig.session.onActivate = nil
    _ = try rig.engine.resumeRecording(recordingSessionId: sid)
    _ = try rig.engine.stopRecording(recordingSessionId: sid)
    let final = try rig.store.getSession(recordingSessionId: sid)
    try require(final.segments.map(\.sequence) == [1, 2, 3], "\(label): Resume continues at sequence 3")
  }
}

// MARK: - 3. Non-retryable and precondition-skipped failures

private func armCheckpoint(_ rig: Rig) async throws -> (sid: String, base: Int) {
  let sid = try await startRecording(rig)
  try rig.engine.performCheckpointForTesting()
  return (sid, rig.faults.activation)
}

private func expectNoRetry(
  _ rig: Rig, _ sid: String, _ base: Int, label: String, attempts: Int = 1, stage: String, reason: String?
) throws {
  try require(rig.faults.activation == base + attempts || stage == "permission_check", "\(label): attempts")
  try require(rig.sleeps.value.isEmpty, "\(label): zero retry delay")
  let events = readEvents(rig.store, sid).filter { ($0["cp"] as? Int) == 2 }
  try require(kind(events, "begin_started").filter { ($0["ctx"] as? String) == "checkpoint" }.count == 1, "\(label): exactly one attempt")
  let failed = kind(events, "begin_failed")
  try require(failed.count == 1 && (failed[0]["stage"] as? String) == stage, "\(label): stage \(stage), got \(failed.compactMap { $0["stage"] })")
  let decision = kind(events, "retry_decision")
  try require(decision.count == 1 && (decision[0]["eligible"] as? Bool) == false, "\(label): decision recorded as not eligible")
  if let reason { try require((decision[0]["reason"] as? String) == reason, "\(label): reason \(reason), got \(String(describing: decision[0]["reason"]))") }
  try require(kind(events, "retry_started").isEmpty && kind(events, "retry_succeeded").isEmpty, "\(label): no retry ran")
  let paused = kind(events, "entered_paused_state")
  try require(paused.count == 1 && (paused[0]["cause"] as? String) == "not_retryable", "\(label): entered_paused_state recorded")
  try require(publishedFailures(rig) == 1, "\(label): checkpoint_begin_segment_failed published once")
  try require((rig.engine.getRecordingStatus()["runtimeState"] as? String) == "paused", "\(label): paused")
  try require(rig.factory.liveCount == 0, "\(label): no recorder running")
}

private func testNonRetryableStagesDoNotRetry() async throws {
  // permission_check
  do {
    let rig = try makeRig(); defer { rig.cleanup() }
    let (sid, base) = try await armCheckpoint(rig)
    let before = try committedBytes(rig.store, rig.root, sid)
    rig.session.permissionState = .denied
    _ = try? rig.engine.performCheckpointForTesting()
    try expectNoRetry(rig, sid, base, label: "permission_check", stage: "permission_check", reason: "stage_not_retryable")
    try require(rig.faults.activation == base, "permission_check: the audio session is never touched")
    let after = try committedBytes(rig.store, rig.root, sid)
    for (path, bytes) in before { try require(after[path] == bytes, "permission_check: \(path) byte-identical") }
    try require(after.count == 2, "permission_check: the checkpoint's own commit is intact")
    try require(try rig.store.getSession(recordingSessionId: sid).state == .paused, "permission_check: paused")
  }
  // segment_plan_create — the store cannot plan the next segment (metadata unreadable)
  do {
    let rig = try makeRig(); defer { rig.cleanup() }
    let (sid, base) = try await armCheckpoint(rig)
    let sessionJSON = sessionDirectory(rig, sid).appendingPathComponent("session.json")
    var stash = Data()
    rig.session.onActivate = { n in
      if n == base + 1 { stash = (try? Data(contentsOf: sessionJSON)) ?? Data(); try? Data("{}".utf8).write(to: sessionJSON) }
    }
    _ = try? rig.engine.performCheckpointForTesting()
    try expectNoRetry(rig, sid, base, label: "segment_plan_create", stage: "segment_plan_create", reason: "stage_not_retryable")
    try stash.write(to: sessionJSON)
    let restored = try rig.store.getSession(recordingSessionId: sid)
    try require(restored.segments.map(\.sequence) == [1, 2], "segment_plan_create: committed manifest intact")
    let bytes = try committedBytes(rig.store, rig.root, sid)
    try require(bytes.count == 2 && bytes.values.allSatisfy { !$0.isEmpty }, "segment_plan_create: committed audio intact")
  }
  // session_transition — the recorder is already live when the store fails
  do {
    let rig = try makeRig(); defer { rig.cleanup() }
    let (sid, base) = try await armCheckpoint(rig)
    let sessionJSON = sessionDirectory(rig, sid).appendingPathComponent("session.json")
    var stash = Data()
    rig.factory.onRecorded = { n in
      if n == base + 1 { stash = (try? Data(contentsOf: sessionJSON)) ?? Data(); try? Data("{}".utf8).write(to: sessionJSON) }
    }
    _ = try? rig.engine.performCheckpointForTesting()
    try expectNoRetry(rig, sid, base, label: "session_transition", stage: "session_transition", reason: "stage_not_retryable")
    try stash.write(to: sessionJSON)
    let restored = try rig.store.getSession(recordingSessionId: sid)
    try require(restored.segments.map(\.sequence) == [1, 2], "session_transition: committed manifest intact")
  }
}

private func testPreconditionsSkipTheRetry() async throws {
  // Eligible stage, but the first attempt burned the time budget.
  do {
    let rig = try makeRig(); defer { rig.cleanup() }
    let (sid, base) = try await armCheckpoint(rig)
    rig.faults.byActivation[base + 1] = "set_active"
    rig.session.onActivate = { n in if n == base + 1 { rig.clock.now += DurableCheckpointRetryPolicy.productionElapsedBudget + 1 } }
    _ = try? rig.engine.performCheckpointForTesting()
    try expectNoRetry(rig, sid, base, label: "elapsed budget", stage: "audio_session.set_active", reason: "elapsed_budget_exceeded")
  }
  // A system notification (interruption / route change) is already queued.
  do {
    let rig = try makeRig(); defer { rig.cleanup() }
    let (sid, base) = try await armCheckpoint(rig)
    rig.faults.byActivation[base + 1] = "set_active"
    rig.session.onActivate = { n in if n == base + 1 { rig.engine.simulatePendingSystemEventForTesting() } }
    _ = try? rig.engine.performCheckpointForTesting()
    try expectNoRetry(rig, sid, base, label: "pending system event", stage: "audio_session.set_active", reason: "system_event_pending")
  }
  // The committed previous segment is not on disk.
  do {
    let rig = try makeRig(); defer { rig.cleanup() }
    let (sid, base) = try await armCheckpoint(rig)
    rig.faults.byActivation[base + 1] = "set_active"
    rig.session.onActivate = { n in
      if n == base + 1, let last = (try? rig.store.getSession(recordingSessionId: sid))?.segments.last {
        try? FileManager.default.removeItem(at: sessionDirectory(rig, sid).appendingPathComponent(last.relativePath))
      }
    }
    _ = try? rig.engine.performCheckpointForTesting()
    try expectNoRetry(rig, sid, base, label: "previous segment missing", stage: "audio_session.set_active", reason: "previous_segment_missing")
  }
  // A system notification arrives DURING the pause: the retry must not run.
  do {
    let rig = try makeRig(); defer { rig.cleanup() }
    let (sid, base) = try await armCheckpoint(rig)
    rig.faults.byActivation[base + 1] = "set_active"
    rig.sleepHook.value = { rig.engine.simulatePendingSystemEventForTesting() }
    _ = try? rig.engine.performCheckpointForTesting()
    try require(rig.faults.activation == base + 1, "notification during delay: attempt 2 never runs")
    try require(rig.sleeps.value == [DurableCheckpointRetryPolicy.productionDelay], "notification during delay: the one delay happened")
    let events = readEvents(rig.store, sid).filter { ($0["cp"] as? Int) == 2 }
    try require(kind(events, "retry_started").count == 1, "notification during delay: retry_started recorded")
    let paused = kind(events, "entered_paused_state")
    try require(paused.count == 1 && (paused[0]["detail"] as? String) == "after_delay:system_event_pending", "notification during delay: recorded as skipped after the delay")
    try require(publishedFailures(rig) == 1, "notification during delay: paused path published once")
  }
}

// MARK: - 4. Start and Resume never retry; diagnostics are not required

private func testStartAndResumeNeverRetry() async throws {
  let rig = try makeRig(); defer { rig.cleanup() }
  let session = try rig.store.createSession(lectureId: "lecture-no-retry")
  let sid = session.recordingSessionId
  _ = try await rig.engine.prepareRecording(recordingSessionId: sid, requestPermission: false)
  rig.faults.byActivation[1] = "set_active"
  do { _ = try rig.engine.startRecording(recordingSessionId: sid); throw RetryTestFailure(description: "start must fail") }
  catch is RetryTestFailure { throw RetryTestFailure(description: "start must fail") } catch {}
  try require(rig.faults.activation == 1 && rig.sleeps.value.isEmpty, "Start makes exactly one attempt and never retries")
  _ = try rig.engine.startRecording(recordingSessionId: sid)
  _ = try rig.engine.pauseRecording(recordingSessionId: sid)
  let paused = rig.faults.activation
  rig.faults.byActivation[paused + 1] = "record_false"
  do { _ = try rig.engine.resumeRecording(recordingSessionId: sid); throw RetryTestFailure(description: "resume must fail") }
  catch is RetryTestFailure { throw RetryTestFailure(description: "resume must fail") } catch {}
  try require(rig.faults.activation == paused + 1 && rig.sleeps.value.isEmpty, "Resume makes exactly one attempt and never retries")
  try require(try rig.store.getSession(recordingSessionId: sid).state == .paused, "a failed Resume leaves the session paused, as before")
}

private func testRecoveryDoesNotDependOnDiagnostics() async throws {
  let rig = try makeRig(diagnostics: false); defer { rig.cleanup() }
  let (sid, base) = try await armCheckpoint(rig)
  rig.faults.byActivation[base + 1] = "record_false"
  try rig.engine.performCheckpointForTesting()
  try require(rig.faults.activation == base + 2, "the retry runs with diagnostics off")
  try require(try rig.store.getSession(recordingSessionId: sid).state == .recording, "and recovers")
  try require(readEvents(rig.store, sid).isEmpty, "diagnostics off writes nothing")
  try require(rig.factory.liveCount == 1, "one recorder")
}

private func testRetryParametersAreBounded() throws {
  try require(DurableCheckpointRetryPolicy.productionDelay == 0.05, "production delay is 50 ms")
  try require(DurableCheckpointRetryPolicy.maxDelay == 0.15, "hard ceiling is 150 ms")
  try require(DurableCheckpointRetryPolicy(delay: 30).delay == 0.15, "a larger delay is clamped to the ceiling")
  try require(DurableCheckpointRetryPolicy(delay: -1).delay == 0, "a negative delay is clamped to zero")
  try require(DurableCheckpointRetryPolicy().elapsedBudget == 1.0, "production elapsed budget is 1 s")
}

// MARK: - 5. Process death during the retry

private func snapshot(_ root: URL) -> URL {
  let copy = FileManager.default.temporaryDirectory.appendingPathComponent("durable-retry-snapshot-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.copyItem(at: root, to: copy)
  return copy
}

private func recoverAndFinalize(
  snapshotRoot: URL, sid: String, original: [String: Data], label: String, expectedQuarantined: Int
) async throws {
  defer { try? FileManager.default.removeItem(at: snapshotRoot) }
  let store = try DurableRecorderStore(rootURL: snapshotRoot)
  let before = try store.getSession(recordingSessionId: sid)   // structurally valid manifest
  try require(before.state == .recording && before.segments.map(\.sequence) == [1, 2], "\(label): kill left state=recording with both committed segments")
  for (path, bytes) in original {
    try require((try? Data(contentsOf: snapshotRoot.appendingPathComponent("sessions/\(sid)/\(path)"))) == bytes, "\(label): \(path) byte-identical at the moment of death")
  }
  let engine = DurableForegroundRecorder(
    store: store, audioSession: RetrySession(faults: Faults()), captureFactory: RetryFactory(faults: Faults()),
    fileInspector: SystemDurableAudioFileInspector(), checkpointInterval: 0, observeSystemNotifications: false,
    diagnostics: DurableRecorderDiagnostics(enabled: false, fileURL: { _ in nil })
  )
  let recovery = try engine.recoverRecordingSession(recordingSessionId: sid)
  try require(recovery.session.state == .paused, "\(label): cold recovery moves the unfinished session to paused")
  try require(recovery.session.segments.map(\.sequence) == [1, 2], "\(label): manifest unchanged by recovery")
  let dir = snapshotRoot.appendingPathComponent("sessions/\(sid)", isDirectory: true)
  try require(!names(dir.appendingPathComponent("segments")).contains { $0.contains(".partial.") }, "\(label): no partial left in segments/")
  try require(names(dir.appendingPathComponent("quarantine")).count == expectedQuarantined,
              "\(label): quarantine holds \(expectedQuarantined), got \(names(dir.appendingPathComponent("quarantine")))")
  _ = try engine.stopRecording(recordingSessionId: sid)
  let output = try await DurableFinalAssetExporter(store: store).export(recordingSessionId: sid)
  let exported = try store.getSession(recordingSessionId: sid)
  try require(exported.finalAsset?.sourceSegmentIds == exported.segments.map(\.segmentId), "\(label): final assembly uses exactly the committed segments")
  try require(exported.segments.count == 2, "\(label): no failed partial contaminates the final asset")
  try require(output["fileUri"] is String && (exported.finalAsset?.durationMs ?? 0) > 1_500, "\(label): final asset is valid")
}

private func testProcessDeathDuringRetryPreservesCommittedAudio() async throws {
  let rig = try makeRig(); defer { rig.cleanup() }
  let (sid, base) = try await armCheckpoint(rig)
  rig.faults.byActivation[base + 1] = "prepare_false"     // leaves a partial that the retry quarantines
  var original: [String: Data] = [:]
  var duringDelay: URL?
  var duringSecondAttempt: URL?
  rig.session.onActivate = { n in
    if n == base + 1 { original = (try? committedBytes(rig.store, rig.root, sid)) ?? [:] }
  }
  rig.sleepHook.value = { duringDelay = snapshot(rig.root) }
  rig.factory.onPrepared = { n in if n == base + 2 { duringSecondAttempt = snapshot(rig.root) } }
  try rig.engine.performCheckpointForTesting()
  guard let duringDelay, let duringSecondAttempt else { throw RetryTestFailure(description: "snapshots were not taken") }

  // The failure evidence was flushed BEFORE the delay, so it survives a kill during it.
  let delayEvents = ((try? String(contentsOf: duringDelay.appendingPathComponent("sessions/\(sid)/diagnostics.jsonl"), encoding: .utf8)) ?? "")
  try require(delayEvents.contains("\"kind\":\"begin_failed\"") && delayEvents.contains("\"kind\":\"retry_started\""),
              "the first failure is durable before the retry delay begins")

  try await recoverAndFinalize(snapshotRoot: duringDelay, sid: sid, original: original, label: "death during retry delay", expectedQuarantined: 1)
  try await recoverAndFinalize(snapshotRoot: duringSecondAttempt, sid: sid, original: original, label: "death during second attempt", expectedQuarantined: 2)
}

// MARK: - 6. Final asset with a recovered checkpoint

private func testFinalAssetWithRecoveredCheckpoint() async throws {
  let rig = try makeRig(); defer { rig.cleanup() }
  let (sid, _) = try await armCheckpoint(rig)                       // seq 1 committed, seq 2 active
  let base = rig.faults.activation
  rig.faults.byActivation[base + 1] = "record_false"                // checkpoint 2: seq 2 committed, seq 3 recovered
  try rig.engine.performCheckpointForTesting()
  try rig.engine.performCheckpointForTesting()                      // checkpoint 3: seq 3 committed, seq 4 active
  _ = try rig.engine.stopRecording(recordingSessionId: sid)
  let output = try await DurableFinalAssetExporter(store: rig.store).export(recordingSessionId: sid)
  let session = try rig.store.getSession(recordingSessionId: sid)

  try require(session.segments.map(\.sequence) == [1, 2, 3, 4], "sequences contiguous, got \(session.segments.map(\.sequence))")
  try require(Set(session.segments.map(\.segmentId)).count == 4, "each committed segment once")
  try require(session.finalAsset?.sourceSegmentIds == session.segments.map(\.segmentId), "final sourceSegmentIds exact and ordered")
  let failedPath = readEvents(rig.store, sid).first { ($0["kind"] as? String) == "begin_failed" }?["planPath"] as? String
  let failedUUID = failedPath.flatMap { uuid(inPartialName: ($0 as NSString).lastPathComponent) }
  try require(failedUUID != nil && !session.segments.contains { $0.segmentId == failedUUID }, "the failed partial is not a manifest segment")
  try require(session.finalAsset?.sourceSegmentIds.contains(failedUUID ?? "") == false, "the failed partial is not in the final asset")
  let dir = sessionDirectory(rig, sid)
  let segmentFiles = names(dir.appendingPathComponent("segments"))
  try require(segmentFiles.count == 4 && !segmentFiles.contains { $0.contains(".partial.") }, "segments/ holds exactly the four committed segments")
  try require(names(dir.appendingPathComponent("quarantine")).count == 1, "the failed partial sits in quarantine, not in segments/")
  let duration = Double(session.finalAsset?.durationMs ?? 0) / 1_000
  try require(duration > 3.4 && duration < 4.6, "final duration matches four one-second segments, got \(duration)")
  let inspection = try SystemDurableAudioFileInspector().inspect(url: URL(string: output["fileUri"] as! String)!)
  try require(inspection.durationMs > 3_400, "the final asset decodes")
  let reconcile = try rig.store.reconcileSession(recordingSessionId: sid) { (try? SystemDurableAudioFileInspector().inspect(url: $0)) != nil }
  try require(reconcile.issues.isEmpty, "reconcile finds no orphan or partial: \(reconcile.issues)")
}

@main
private struct CheckpointRetryTests {
  static func main() async throws {
    try testRetryParametersAreBounded()
    try await testRecoversAtEveryRetryableStage()
    try await testDoubleFailureFallsBackToTodaysBehavior()
    try await testNonRetryableStagesDoNotRetry()
    try await testPreconditionsSkipTheRetry()
    try await testStartAndResumeNeverRetry()
    try await testRecoveryDoesNotDependOnDiagnostics()
    try await testProcessDeathDuringRetryPreservesCommittedAudio()
    try await testFinalAssetWithRecoveredCheckpoint()
    print("durable checkpoint retry tests passed")
  }
}
