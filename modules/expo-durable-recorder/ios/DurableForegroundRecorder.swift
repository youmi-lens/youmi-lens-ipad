import AVFoundation
import Foundation
#if canImport(UIKit)
import UIKit
#endif

private let durableRecorderAudioSettings: [String: Any] = [
  AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
  AVSampleRateKey: 44_100.0,
  AVNumberOfChannelsKey: 1,
  AVEncoderBitRateKey: 96_000,
  AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
]

protocol DurableAudioCapture: AnyObject {
  var isRecording: Bool { get }
  func prepareToRecord() -> Bool
  func record() -> Bool
  func stop()
}

extension AVAudioRecorder: DurableAudioCapture {}

protocol DurableAudioCaptureFactory {
  func makeCapture(url: URL) throws -> DurableAudioCapture
}

struct SystemDurableAudioCaptureFactory: DurableAudioCaptureFactory {
  func makeCapture(url: URL) throws -> DurableAudioCapture {
    try AVAudioRecorder(url: url, settings: durableRecorderAudioSettings)
  }
}

protocol DurableAudioFileInspecting {
  func inspect(url: URL) throws -> DurableAudioFileInspection
}

struct SystemDurableAudioFileInspector: DurableAudioFileInspecting {
  func inspect(url: URL) throws -> DurableAudioFileInspection {
    guard url.pathExtension.lowercased() == "m4a" else {
      throw DurableRecorderCoreError.segmentValidationFailed("The segment is not an M4A asset.")
    }
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values.isRegularFile == true, let fileSize = values.fileSize, fileSize > 0 else {
      throw DurableRecorderCoreError.segmentValidationFailed("The segment file is empty or not a regular file.")
    }
    let audioFile: AVAudioFile
    do {
      audioFile = try AVAudioFile(forReading: url)
    } catch {
      throw DurableRecorderCoreError.segmentValidationFailed("The audio asset cannot be opened.")
    }
    let format = audioFile.processingFormat
    let durationSeconds = format.sampleRate > 0 ? Double(audioFile.length) / format.sampleRate : 0
    let durationMs = Int((durationSeconds * 1_000).rounded())
    guard durationMs > 0, format.sampleRate > 0, format.channelCount > 0 else {
      throw DurableRecorderCoreError.segmentValidationFailed("The audio asset has no readable duration.")
    }
    return DurableAudioFileInspection(
      durationMs: durationMs,
      byteLength: Int64(fileSize),
      sampleRate: format.sampleRate,
      channelCount: Int(format.channelCount)
    )
  }
}

protocol DurableAudioSessionManaging: AnyObject {
  var permissionState: DurableRecorderPermissionState { get }
  var hasSuitableInput: Bool { get }
  var routeDescription: String { get }
  /// DIAGNOSTIC ONLY. Which step of `activateForRecording()` ran last: "set_category", "set_active",
  /// "input_availability" or "activated". Read only after a failure, to say WHICH step threw.
  var lastActivationStage: String { get }
  func requestPermission() async -> DurableRecorderPermissionState
  func activateForRecording() throws
  func deactivate()
  /// DIAGNOSTIC ONLY. Best-effort, side-effect-free description of the shared audio session. Never throws.
  func diagnosticSnapshot() -> [String: Any]
}

extension DurableAudioSessionManaging {
  var lastActivationStage: String { "unknown" }
  func diagnosticSnapshot() -> [String: Any] { [:] }
}

#if os(iOS)
final class SystemDurableAudioSessionManager: DurableAudioSessionManaging {
  private let session = AVAudioSession.sharedInstance()

  var permissionState: DurableRecorderPermissionState {
    switch session.recordPermission {
    case .undetermined: return .undetermined
    case .denied: return .denied
    case .granted: return .granted
    @unknown default: return .restricted
    }
  }

  var hasSuitableInput: Bool {
    !session.currentRoute.inputs.isEmpty || !(session.availableInputs ?? []).isEmpty
  }

  var routeDescription: String {
    let inputs = session.currentRoute.inputs.map { "\($0.portType.rawValue):\($0.portName)" }
    return inputs.isEmpty ? "no-input" : inputs.joined(separator: ",")
  }

  func requestPermission() async -> DurableRecorderPermissionState {
    await withCheckedContinuation { continuation in
      session.requestRecordPermission { [weak self] _ in
        continuation.resume(returning: self?.permissionState ?? .restricted)
      }
    }
  }

  private(set) var lastActivationStage = "idle"

  func activateForRecording() throws {
    lastActivationStage = "set_category"
    try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
    lastActivationStage = "set_active"
    try session.setActive(true)
    lastActivationStage = "input_availability"
    guard hasSuitableInput else {
      deactivate()
      throw DurableRecorderCoreError.noAudioInput
    }
    lastActivationStage = "activated"
  }

  func diagnosticSnapshot() -> [String: Any] {
    func ports(_ list: [AVAudioSessionPortDescription]) -> [String] {
      list.map { "\($0.portType.rawValue):\($0.portName)" }
    }
    var out: [String: Any] = [
      "category": session.category.rawValue,
      "mode": session.mode.rawValue,
      "options": Int(session.categoryOptions.rawValue),
      "otherAudioPlaying": session.isOtherAudioPlaying,
      "secondaryAudioSilenceHint": session.secondaryAudioShouldBeSilencedHint,
      "sampleRate": session.sampleRate,
      "ioBufferMs": (session.ioBufferDuration * 1_000 * 10).rounded() / 10,
      "inputAvailable": session.isInputAvailable,
      "inputs": ports(session.currentRoute.inputs),
      "outputs": ports(session.currentRoute.outputs),
      "availableInputs": (session.availableInputs ?? []).count,
      "recordPermission": permissionState.rawValue,
      "inputChannels": session.inputNumberOfChannels,
    ]
    if let preferred = session.preferredInput {
      out["preferredInput"] = "\(preferred.portType.rawValue):\(preferred.portName)"
    }
    return out
  }

  func deactivate() {
    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
  }
}
#else
final class SystemDurableAudioSessionManager: DurableAudioSessionManaging {
  var permissionState: DurableRecorderPermissionState { .restricted }
  var hasSuitableInput: Bool { false }
  var routeDescription: String { "no-input" }
  func requestPermission() async -> DurableRecorderPermissionState { .restricted }
  func activateForRecording() throws { throw DurableRecorderCoreError.noAudioInput }
  func deactivate() {}
}
#endif

/// The operation inside one `beginSegment` attempt that failed, parsed from the stable stage id that the rollover
/// diagnostics persist. Retry eligibility is decided from THIS structured value, never from error text.
enum DurableBeginStage: Equatable {
  case permissionCheck
  case audioSessionSetCategory
  case audioSessionSetActive
  case audioSessionInputAvailability
  /// `audio_session` failed but the session manager could not say which of its operations did.
  case audioSessionUnclassified(String)
  case inputAvailabilityRecheck
  case segmentPlanCreate
  case recorderInit
  case prepareToRecord
  case record
  case sessionTransition

  init(stageId: String) {
    switch stageId {
    case "permission_check": self = .permissionCheck
    case "audio_session.set_category": self = .audioSessionSetCategory
    case "audio_session.set_active": self = .audioSessionSetActive
    case "audio_session.input_availability": self = .audioSessionInputAvailability
    case "input_availability_recheck": self = .inputAvailabilityRecheck
    case "segment_plan_create": self = .segmentPlanCreate
    case "recorder_init": self = .recorderInit
    case "prepare_to_record": self = .prepareToRecord
    case "record": self = .record
    case "session_transition": self = .sessionTransition
    default: self = .audioSessionUnclassified(stageId)
    }
  }

  /// Only failures that can plausibly be transient at the AVAudioSession / AVAudioRecorder boundary are eligible for
  /// the single checkpoint retry. Everything else (permission, store/metadata, an already-live recorder) is not, and
  /// neither is an audio-session failure that cannot be attributed to a specific operation.
  var isCheckpointRetryEligible: Bool {
    switch self {
    case .audioSessionSetCategory, .audioSessionSetActive, .audioSessionInputAvailability,
         .inputAvailabilityRecheck, .recorderInit, .prepareToRecord, .record:
      return true
    case .permissionCheck, .audioSessionUnclassified, .segmentPlanCreate, .sessionTransition:
      return false
    }
  }

  /// Stages at which a segment file for the failed plan may already exist on disk
  /// (`prepareToRecord()` creates the file; `recorder_init` is included defensively).
  var mayHaveCreatedPartialFile: Bool {
    switch self {
    case .recorderInit, .prepareToRecord, .record: return true
    default: return false
    }
  }
}

/// Everything one failed `beginSegment` attempt knows. Thrown by `performBeginAttempt`, which does NOT clean up:
/// cleanup is decided by the caller (`abandonFailedBegin` for Start/Resume, the checkpoint policy for a rollover).
struct DurableBeginAttemptFailure: Error {
  let stageId: String
  let stage: DurableBeginStage
  let error: Error
  /// The segment plan of the failed attempt, if one had been allocated (never committed to the manifest).
  let plan: DurableSegmentPlan?
  /// The permission guard fails before any audio-session work, so it never deactivates the session.
  let isPermissionGuard: Bool
  let beginToFailMs: Double
}

/// MITIGATION PARAMETERS for the single checkpoint-rollover retry. None of these values is experimentally tuned.
struct DurableCheckpointRetryPolicy {
  /// Hard ceiling for the pause before the retry. Do not raise without new evidence.
  static let maxDelay: TimeInterval = 0.15

  /// Pause before the one retry. 50 ms is roughly two AVAudioSession I/O buffer periods (23 ms observed on the
  /// target iPad): long enough for an in-flight route/hardware reconfiguration to finish its current cycle, short
  /// enough to stay near a normal rollover gap (20–65 ms measured, 163 ms worst). It is a defensible mitigation
  /// parameter, NOT a measured recovery time — no AVAudioSession API reports "ready".
  static let productionDelay: TimeInterval = 0.05

  /// If the first failed attempt has already pushed the time since the old recorder stopped past this, do not
  /// retry: a pathological first attempt means the audio stack is blocked, and the normal paused path is safer.
  /// Chosen as roughly 6x the slowest normal rollover gap observed (163 ms); not empirically tuned.
  static let productionElapsedBudget: TimeInterval = 1.0

  let delay: TimeInterval
  let elapsedBudget: TimeInterval
  /// Blocks the serial recorder-engine queue only (never the main thread). Injected so tests do not really wait.
  let sleep: (TimeInterval) -> Void
  let uptime: () -> TimeInterval

  init(
    delay: TimeInterval = Self.productionDelay,
    elapsedBudget: TimeInterval = Self.productionElapsedBudget,
    sleep: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
    uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.delay = min(max(delay, 0), Self.maxDelay)
    self.elapsedBudget = max(elapsedBudget, 0)
    self.sleep = sleep
    self.uptime = uptime
  }
}

final class DurableForegroundRecorder {
  /// Production checkpoint cadence for mid-capture durability.
  ///
  /// Bounds force-kill loss of the active `.partial.m4a` to roughly this
  /// interval by committing immutable segments and opening the next one while
  /// remaining logically recording. Zero disables scheduling (tests).
  static let defaultCheckpointInterval: TimeInterval = 60

  private let store: DurableRecorderStore
  private let audioSession: DurableAudioSessionManaging
  private let captureFactory: DurableAudioCaptureFactory
  private let fileInspector: DurableAudioFileInspecting
  /// Seconds between internal segment rollovers. `<= 0` disables checkpoints.
  private let checkpointInterval: TimeInterval
  private let queue = DispatchQueue(label: "com.youmilens.durable-recorder.engine")
  private var observers: [NSObjectProtocol] = []

  private var runtimeState: DurableRecorderRuntimeState = .idle
  private var ownedSessionId: String?
  private var activePlan: DurableSegmentPlan?
  private var activeCapture: DurableAudioCapture?
  private var routeAtSegmentStart: String?
  private var lastInterruption: String?
  private var lastRouteChange: String?
  /// Monotonic revision included in every status payload so JS can ignore stale events.
  private var statusSequence: Int = 0
  /// Optional bridge to the Expo module. Invoked on the engine queue after
  /// meaningful lifecycle transitions (forced pause, pause, resume, start, stop).
  var onStatusChange: (([String: Any]) -> Void)?

  /// Invalidates pending checkpoint timers when cancelled or rescheduled.
  private var checkpointGeneration: UInt64 = 0
  private var checkpointTimer: DispatchSourceTimer?
  /// Prevents overlapping rollover work on the engine queue.
  private var isCheckpointInProgress = false

  /// Mitigation for a transient failure to open the next segment after a successful checkpoint commit.
  private let checkpointRetryPolicy: DurableCheckpointRetryPolicy
  /// When the previous recorder stopped (recording logic: bounds the retry). Not the diagnostic copy below.
  private var lastSegmentStopUptime: TimeInterval?
  /// System notifications (interruption / route change) that arrived but have not run on the engine queue yet.
  /// Written from notification threads, so guarded by its own lock; a retry never proceeds while one is pending.
  private let pendingSystemEventsLock = NSLock()
  private var pendingSystemEvents = 0

  // ---- Rollover evidence (DIAGNOSTIC ONLY; never read by recording logic) ----
  private let diagnostics: DurableRecorderDiagnostics
  private var diagCheckpointOrdinal = 0
  private var diagOrdinalSessionId: String?
  private var diagRolloverPre: [String: Any]?
  private var diagRolloverStartUptime: TimeInterval?
  private var diagNextSequence: Int?
  private var diagLectureId: String?
  private var diagLastStopUptime: TimeInterval?
  private var diagLastRecordingUptime: TimeInterval?
  /// DIAGNOSTIC ONLY: the app's UIApplication state as last announced by UIKit notifications (thread-safe).
  private let appStateLock = NSLock()
  private var appStateName = "unknown"
  private func currentAppState() -> String {
    appStateLock.lock(); defer { appStateLock.unlock() }
    return appStateName
  }
  private func setAppState(_ name: String) {
    appStateLock.lock(); appStateName = name; appStateLock.unlock()
    DurableRecorderDiagnostics.setSharedAppState(name)
  }
  /// DIAGNOSTIC ONLY: one lifecycle event for the owned session, flushed at once (never inside a rollover window).
  private func emitLifecycle(_ kind: String, _ extra: [String: Any] = [:]) {
    guard diagnostics.isEnabled, let sessionId = ownedSessionId else { return }
    var event: [String: Any] = ["kind": kind, "runtime": runtimeState.rawValue]
    for (key, value) in extra { event[key] = value }
    diagnostics.emit(sessionId: sessionId, event)
    if !isCheckpointInProgress { diagnostics.flush() }
  }

  init(
    store: DurableRecorderStore,
    audioSession: DurableAudioSessionManaging = SystemDurableAudioSessionManager(),
    captureFactory: DurableAudioCaptureFactory = SystemDurableAudioCaptureFactory(),
    fileInspector: DurableAudioFileInspecting = SystemDurableAudioFileInspector(),
    checkpointInterval: TimeInterval = DurableForegroundRecorder.defaultCheckpointInterval,
    observeSystemNotifications: Bool = true,
    checkpointRetryPolicy: DurableCheckpointRetryPolicy = DurableCheckpointRetryPolicy(),
    diagnostics: DurableRecorderDiagnostics? = nil
  ) {
    self.checkpointRetryPolicy = checkpointRetryPolicy
    self.store = store
    self.audioSession = audioSession
    self.captureFactory = captureFactory
    self.fileInspector = fileInspector
    self.checkpointInterval = checkpointInterval
    self.diagnostics = diagnostics ?? DurableRecorderDiagnostics(
      enabled: DurableRecorderDiagnostics.isDevBundle,
      fileURL: { [store] in store.diagnosticsFileURL(recordingSessionId: $0) }
    )
    self.diagnostics.contextProvider = { [weak self] in ["app": self?.currentAppState() ?? "unknown"] }
    if observeSystemNotifications {
      registerObservers()
    }
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
    checkpointTimer?.cancel()
    checkpointTimer = nil
    activeCapture?.stop()
    audioSession.deactivate()
  }

  func permissionState() -> DurableRecorderPermissionState {
    audioSession.permissionState
  }

  func prepareRecording(
    recordingSessionId: String,
    requestPermission: Bool
  ) async throws -> [String: Any] {
    var permission = audioSession.permissionState
    if permission == .undetermined, requestPermission {
      permission = await audioSession.requestPermission()
    }
    guard permission == .granted else {
      throw DurableRecorderCoreError.microphonePermissionDenied
    }
    return try queue.sync {
      var session = try store.getSession(recordingSessionId: recordingSessionId)
      guard [.created, .preparing, .ready, .paused].contains(session.state) else {
        throw DurableRecorderCoreError.invalidRecorderState(
          "A session in state \(session.state.rawValue) cannot be prepared."
        )
      }
      try claim(recordingSessionId)
      runtimeState = .preparing
      switch session.state {
      case .created:
        session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .preparing)
        session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .ready)
        runtimeState = .ready
      case .preparing:
        session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .ready)
        runtimeState = .ready
      case .ready:
        runtimeState = .ready
      case .paused:
        runtimeState = .paused
      default: break
      }
      return statusDictionary(session: session)
    }
  }

  func startRecording(recordingSessionId: String) throws -> [String: Any] {
    try queue.sync {
      try requireOwner(recordingSessionId)
      guard runtimeState == .ready else {
        throw DurableRecorderCoreError.invalidRecorderState("Start requires a prepared ready session.")
      }
      let session = try beginSegment(recordingSessionId: recordingSessionId, resuming: false)
      scheduleCheckpoint()
      return publishStatus(session: session)
    }
  }

  func pauseRecording(recordingSessionId: String) throws -> [String: Any] {
    try queue.sync {
      try requireOwner(recordingSessionId)
      emitLifecycle("pause_transition", ["caller": "user_pause_request"])
      if runtimeState == .paused || runtimeState == .interrupted {
        return statusDictionary(session: try store.getSession(recordingSessionId: recordingSessionId))
      }
      guard runtimeState == .recording else {
        throw DurableRecorderCoreError.invalidRecorderState("Pause requires an active recording segment.")
      }
      cancelCheckpoint()
      runtimeState = .pausing
      do {
        _ = try finalizeActiveSegment(recordingSessionId: recordingSessionId)
        let session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .paused)
        runtimeState = .paused
        audioSession.deactivate()
        return publishStatus(session: session)
      } catch {
        activeCapture?.stop()
        clearActiveCapture()
        _ = try? store.transitionSession(recordingSessionId: recordingSessionId, to: .paused)
        runtimeState = .paused
        audioSession.deactivate()
        throw error
      }
    }
  }

  func resumeRecording(recordingSessionId: String) throws -> [String: Any] {
    try queue.sync {
      if runtimeState == .recording {
        try requireOwner(recordingSessionId)
        return statusDictionary(session: try store.getSession(recordingSessionId: recordingSessionId))
      }
      let session = try store.getSession(recordingSessionId: recordingSessionId)
      guard session.state == .paused,
            runtimeState == .paused || runtimeState == .interrupted || runtimeState == .idle else {
        throw DurableRecorderCoreError.invalidRecorderState("Resume requires a recoverable paused session.")
      }
      try claim(recordingSessionId)
      runtimeState = .resuming
      let resumed = try beginSegment(recordingSessionId: recordingSessionId, resuming: true)
      scheduleCheckpoint()
      return publishStatus(session: resumed)
    }
  }

  func stopRecording(recordingSessionId: String) throws -> [String: Any] {
    try queue.sync {
      emitLifecycle("stop_requested")
      let existing = try store.getSession(recordingSessionId: recordingSessionId)
      if existing.state == .finalized {
        if ownedSessionId == recordingSessionId { releaseOwnership() }
        return publishStatus(session: existing)
      }
      // Finish must work after cold recovery without Resume. Ownership is
      // process-local, so a relaunch leaves no owner even when committed
      // segments are intact. Claim for finalization only when this process has
      // no live owner and no active capture; never start audio here.
      try claimForFinalization(recordingSessionId, session: existing)
      cancelCheckpoint()
      runtimeState = .stopping
      do {
        var session = existing
        if session.state == .recording {
          session = try finalizeActiveSegment(recordingSessionId: recordingSessionId)
        }
        switch session.state {
        case .recording:
          session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .finalizing)
        case .paused:
          session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .finalizing)
        case .finalizing:
          break
        default:
          throw DurableRecorderCoreError.invalidRecorderState(
            "Stop requires recording, paused, or finalizing state."
          )
        }
        session = try store.finalizeSession(recordingSessionId: recordingSessionId)
        releaseOwnership()
        return publishStatus(session: session)
      } catch {
        activeCapture?.stop()
        clearActiveCapture()
        let current = try? store.getSession(recordingSessionId: recordingSessionId)
        if current?.state == .recording {
          _ = try? store.transitionSession(
            recordingSessionId: recordingSessionId,
            to: .failed,
            failureCode: "recording_stop_failed",
            failureMessage: String(describing: error)
          )
        }
        runtimeState = .failed
        audioSession.deactivate()
        ownedSessionId = nil
        throw error
      }
    }
  }

  func getRecordingStatus() -> [String: Any] {
    queue.sync {
      let session = ownedSessionId.flatMap { try? store.getSession(recordingSessionId: $0) }
      return statusDictionary(session: session)
    }
  }

  func recoverRecordingSession(recordingSessionId: String) throws -> DurableRecoveryResult {
    try queue.sync {
      // Live capture owns its active `.partial.m4a`. Never quarantine while busy.
      guard activeCapture == nil else { throw DurableRecorderCoreError.recorderBusy }
      var session = try store.getSession(recordingSessionId: recordingSessionId)
      if session.state == .recording {
        session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .paused)
      }
      var result = try store.reconcileSession(recordingSessionId: recordingSessionId) { [fileInspector] url in
        (try? fileInspector.inspect(url: url)) != nil
      }
      // Stale mid-capture partials must not strand committed segments. With no
      // live owner, quarantine them, then re-reconcile so Resume/Finish see a
      // clean segments directory. Quarantine issues are informational only.
      let hasStalePartial = result.issues.contains { $0.code == "incomplete_temporary_file" }
      var repairIssues: [DurableRecoveryIssue] = []
      if hasStalePartial {
        repairIssues += try store.quarantineInactivePartialFiles(
          recordingSessionId: recordingSessionId
        )
      }

      // Re-attach segment files that were moved but never recorded in metadata,
      // then attach final/lecture.m4a metadata when the promote-then-crash window
      // left a valid final file without finalAsset.
      let segmentAdoption = try store.adoptOrphanFinalizedSegments(
        recordingSessionId: recordingSessionId
      ) { [fileInspector] url in
        try fileInspector.inspect(url: url)
      }
      repairIssues += segmentAdoption.issues
      session = segmentAdoption.session

      let finalAdoption = try store.adoptExistingFinalAssetIfPresent(
        recordingSessionId: recordingSessionId
      ) { [fileInspector] url in
        try fileInspector.inspect(url: url)
      }
      repairIssues += finalAdoption.issues
      session = finalAdoption.session

      result = try store.reconcileSession(recordingSessionId: recordingSessionId) { [fileInspector] url in
        (try? fileInspector.inspect(url: url)) != nil
      }
      session = result.session

      if !session.state.isTerminal {
        // Recovery does not claim ownership. Resume claims when the user
        // continues capture; Finish claims via claimForFinalization.
        runtimeState = session.state == .paused ? .paused : session.state == .ready ? .ready : .idle
      }
      return DurableRecoveryResult(
        session: session,
        issues: result.issues + repairIssues
      )
    }
  }

  func simulateInterruptionBeganForTesting() {
    queue.sync { handleForcedPause(reason: "interruption_began", runtimeAfter: .interrupted) }
  }

  func simulateInterruptionEndedForTesting(shouldResume: Bool) {
    queue.sync { lastInterruption = shouldResume ? "ended_resume_allowed" : "ended_resume_not_allowed" }
  }

  func simulateRouteLossForTesting() {
    queue.sync {
      lastRouteChange = "old_device_unavailable"
      handleForcedPause(reason: "route_old_device_unavailable", runtimeAfter: .paused)
    }
  }

  /// Test-only: run the production checkpoint rollover path immediately.
  func performCheckpointForTesting() throws {
    try queue.sync {
      guard runtimeState == .recording, let recordingSessionId = ownedSessionId else {
        throw DurableRecorderCoreError.invalidRecorderState("Checkpoint requires an active recording segment.")
      }
      try performCheckpointRollover(recordingSessionId: recordingSessionId)
    }
  }

  /// Test-only: fire a checkpoint callback with an explicit identity token.
  func fireCheckpointTimerForTesting(
    generation: UInt64,
    sessionId: String,
    segmentId: String
  ) {
    queue.sync {
      handleCheckpointTimer(generation: generation, sessionId: sessionId, segmentId: segmentId)
    }
  }

  /// Test-only: identity of the currently scheduled checkpoint, if any.
  func checkpointIdentityForTesting() -> (generation: UInt64, sessionId: String, segmentId: String)? {
    queue.sync {
      guard checkpointTimer != nil,
            let sessionId = ownedSessionId,
            let segmentId = activePlan?.segmentId else { return nil }
      return (checkpointGeneration, sessionId, segmentId)
    }
  }

  /// Start / Resume entry point: exactly ONE attempt, then the original failure handling. Never retries — the retry
  /// exists only inside a checkpoint rollover (`beginCheckpointSegment`).
  private func beginSegment(recordingSessionId: String, resuming: Bool) throws -> DurableRecordingSession {
    defer { diagnostics.flush() }
    do {
      return try performBeginAttempt(recordingSessionId: recordingSessionId, resuming: resuming, attempt: 1)
    } catch let failure as DurableBeginAttemptFailure {
      abandonFailedBegin(failure, resuming: resuming)
      throw failure.error
    }
  }

  /// ONE attempt to open the next segment. It records evidence and throws `DurableBeginAttemptFailure`, but it does
  /// NOT clean up after a failure and never retries: what happens next is the caller's policy.
  ///
  /// Evidence (`DurableRecorderDiagnostics`) never changes what is attempted, in what order, or how a failure is
  /// handled — every diagnostic call is non-throwing and buffers in memory.
  private func performBeginAttempt(
    recordingSessionId: String,
    resuming: Bool,
    attempt: Int
  ) throws -> DurableRecordingSession {
    let context = isCheckpointInProgress ? "checkpoint" : (resuming ? "resume" : "start")
    let beginUptime = ProcessInfo.processInfo.systemUptime
    if diagOrdinalSessionId != recordingSessionId {
      diagOrdinalSessionId = recordingSessionId
      diagCheckpointOrdinal = 0
    }
    if context != "checkpoint" { diagNextSequence = nil }
    var stage = "permission_check"
    var probe = DurableRecorderProbe()
    var plan: DurableSegmentPlan?
    diagnostics.emit(sessionId: recordingSessionId, [
      "kind": "begin_started", "ctx": context, "cp": diagCheckpointOrdinal, "attempt": attempt,
      "seq": diagNextSequence as Any,
    ])
    guard audioSession.permissionState == .granted else {
      recordBeginFailure(
        recordingSessionId: recordingSessionId, context: context, attempt: attempt, stage: stage,
        error: DurableRecorderCoreError.microphonePermissionDenied, plan: nil, probe: probe, beginUptime: beginUptime
      )
      throw DurableBeginAttemptFailure(
        stageId: stage, stage: .permissionCheck, error: DurableRecorderCoreError.microphonePermissionDenied,
        plan: nil, isPermissionGuard: true, beginToFailMs: Self.milliseconds(ProcessInfo.processInfo.systemUptime - beginUptime)
      )
    }
    do {
      stage = "audio_session"
      try audioSession.activateForRecording()
      stage = "input_availability_recheck"
      guard audioSession.hasSuitableInput else { throw DurableRecorderCoreError.noAudioInput }
      stage = "segment_plan_create"
      let newPlan = try store.createSegmentPlan(recordingSessionId: recordingSessionId)
      plan = newPlan
      diagNextSequence = newPlan.sequence
      stage = "recorder_init"
      let capture = try captureFactory.makeCapture(url: newPlan.activeURL)
      probe.recorderExists = true
      probe.url = newPlan.activeRelativePath
      stage = "prepare_to_record"
      let prepared = capture.prepareToRecord()
      probe.prepared = prepared
      var started = false
      if prepared {
        stage = "record"
        started = capture.record()
        probe.recorded = started
      }
      probe.isRecording = capture.isRecording
      guard prepared, started else {
        capture.stop()
        throw DurableRecorderCoreError.recorderStartFailed("AVAudioRecorder rejected the recording request.")
      }
      let recordingUptime = ProcessInfo.processInfo.systemUptime
      diagLastRecordingUptime = recordingUptime
      activePlan = newPlan
      activeCapture = capture
      routeAtSegmentStart = audioSession.routeDescription
      stage = "session_transition"
      let session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .recording)
      runtimeState = .recording
      var success: [String: Any] = [
        "kind": "begin_succeeded", "ctx": context, "cp": diagCheckpointOrdinal, "attempt": attempt,
        "seq": newPlan.sequence,
        "beginToRecordMs": Self.milliseconds(recordingUptime - beginUptime),
        "route": audioSession.routeDescription,
      ]
      if context == "checkpoint", let stop = diagLastStopUptime {
        success["stopToRecordMs"] = Self.milliseconds(recordingUptime - stop)
      }
      let snapshot = audioSession.diagnosticSnapshot()
      if !snapshot.isEmpty { success["post"] = DurableRecorderDiagnostics.compactSession(snapshot) }
      diagnostics.emit(sessionId: recordingSessionId, success)
      return session
    } catch {
      // Evidence FIRST, while the session and recorder are exactly as they were at the failure. Cleanup is the
      // caller's decision (see `abandonFailedBegin` and `beginCheckpointSegment`).
      recordBeginFailure(
        recordingSessionId: recordingSessionId, context: context, attempt: attempt, stage: stage, error: error,
        plan: plan, probe: probe, beginUptime: beginUptime
      )
      var stageId = stage
      if stage == "audio_session" { stageId = "audio_session." + audioSession.lastActivationStage }
      throw DurableBeginAttemptFailure(
        stageId: stageId, stage: DurableBeginStage(stageId: stageId), error: error, plan: plan,
        isPermissionGuard: false,
        beginToFailMs: Self.milliseconds(ProcessInfo.processInfo.systemUptime - beginUptime)
      )
    }
  }

  /// The original failure handling of `beginSegment`, unchanged and in the original order.
  private func abandonFailedBegin(_ failure: DurableBeginAttemptFailure, resuming: Bool) {
    if !failure.isPermissionGuard {
      activeCapture?.stop()
      clearActiveCapture()
      audioSession.deactivate()
    }
    runtimeState = resuming ? .paused : .ready
  }

  private static func milliseconds(_ interval: TimeInterval) -> Double {
    (max(0, interval) * 1_000 * 10).rounded() / 10
  }

  // MARK: Checkpoint rollover: bounded recovery

  private enum CheckpointRetryDecision {
    case eligible
    case skipped(String)
  }

  /// Opens the next segment after a SUCCESSFUL checkpoint commit. One attempt; if it fails for a plausibly transient
  /// reason and every precondition still holds, exactly ONE more attempt after a short bounded pause. There is no
  /// loop and no recursion: attempt 1, at most attempt 2, then the original failure handling.
  ///
  /// The retry uses the SAME logical sequence (always derived from the committed manifest) with a NEW segment id and
  /// file plan. Nothing is committed for a failed attempt, so committed audio is never touched.
  private func beginCheckpointSegment(
    recordingSessionId: String,
    previousCommitted: DurableRecordingSegmentMetadata?
  ) throws {
    let first: DurableBeginAttemptFailure
    do {
      _ = try performBeginAttempt(recordingSessionId: recordingSessionId, resuming: true, attempt: 1)
      return
    } catch let failure as DurableBeginAttemptFailure {
      first = failure
    }

    let decision = checkpointRetryDecision(
      recordingSessionId: recordingSessionId, previousCommitted: previousCommitted, first: first
    )
    if diagnostics.isEnabled {
      var event: [String: Any] = [
        "kind": "retry_decision", "cp": diagCheckpointOrdinal, "stage": first.stageId,
        "seq": diagNextSequence as Any,
      ]
      switch decision {
      case .eligible: event["eligible"] = true
      case .skipped(let reason): event["eligible"] = false; event["reason"] = reason
      }
      if let stop = lastSegmentStopUptime {
        event["sinceStopMs"] = Self.milliseconds(checkpointRetryPolicy.uptime() - stop)
      }
      diagnostics.emit(sessionId: recordingSessionId, event)
    }
    guard case .eligible = decision else {
      if case .skipped(let reason) = decision {
        emitEnteredPaused(recordingSessionId: recordingSessionId, cause: "not_retryable", detail: reason, stage: first.stageId)
      }
      abandonFailedBegin(first, resuming: true)
      throw first.error
    }

    // Attempt-1 leftovers only. The audio session is deliberately NOT deactivated between attempts: attempt 2
    // re-asserts the same category/activation itself, and deactivating would tear the session down under any other
    // running I/O for no benefit. If attempt 2 fails, the original failure handling below deactivates as before.
    activeCapture?.stop()
    clearActiveCapture()
    var partialDisposition: String?
    if first.stage.mayHaveCreatedPartialFile, let plan = first.plan {
      partialDisposition = store.quarantineFailedPartial(recordingSessionId: recordingSessionId, plan: plan)
    }
    let retryDelay = checkpointRetryPolicy.delay
    if diagnostics.isEnabled {
      var event: [String: Any] = [
        "kind": "retry_started", "cp": diagCheckpointOrdinal, "attempt": 2, "seq": diagNextSequence as Any,
        "stage": first.stageId, "delayMs": Self.milliseconds(retryDelay), "firstAttemptMs": first.beginToFailMs,
        "error": DurableRecorderDiagnostics.describe(first.error),
      ]
      if let plan = first.plan { event["failedPartialPath"] = plan.activeRelativePath }
      if let partialDisposition { event["failedPartial"] = partialDisposition }
      diagnostics.emit(sessionId: recordingSessionId, event)
      // The one place evidence is written mid-rollover: this is the failure path, and the write survives a kill
      // during the pause below.
      diagnostics.flush()
    }
    if retryDelay > 0 { checkpointRetryPolicy.sleep(retryDelay) }

    // Re-verify after the pause: an interruption or route change may have queued while we waited.
    if case .skipped(let reason) = checkpointRetryDecision(
      recordingSessionId: recordingSessionId, previousCommitted: previousCommitted, first: first
    ) {
      emitEnteredPaused(recordingSessionId: recordingSessionId, cause: "not_retryable", detail: "after_delay:" + reason, stage: first.stageId)
      abandonFailedBegin(first, resuming: true)
      throw first.error
    }

    do {
      _ = try performBeginAttempt(recordingSessionId: recordingSessionId, resuming: true, attempt: 2)
      if diagnostics.isEnabled {
        var event: [String: Any] = [
          "kind": "retry_succeeded", "cp": diagCheckpointOrdinal, "attempt": 2, "seq": diagNextSequence as Any,
          "stage": first.stageId, "delayMs": Self.milliseconds(retryDelay), "firstAttemptMs": first.beginToFailMs,
          "error": DurableRecorderDiagnostics.describe(first.error),
        ]
        if let stop = diagLastStopUptime, let recording = diagLastRecordingUptime {
          event["stopToRecordMs"] = Self.milliseconds(recording - stop)
        }
        if let plan = first.plan { event["failedPartialPath"] = plan.activeRelativePath }
        diagnostics.emit(sessionId: recordingSessionId, event)
      }
    } catch let second as DurableBeginAttemptFailure {
      if diagnostics.isEnabled {
        var event: [String: Any] = [
          "kind": "retry_failed", "cp": diagCheckpointOrdinal, "attempt": 2, "firstStage": first.stageId,
          "secondStage": second.stageId, "error": DurableRecorderDiagnostics.describe(second.error),
          "firstError": DurableRecorderDiagnostics.describe(first.error), "delayMs": Self.milliseconds(retryDelay),
          "firstAttemptMs": first.beginToFailMs,
        ]
        if let stop = diagLastStopUptime {
          event["stopToFailMs"] = Self.milliseconds(ProcessInfo.processInfo.systemUptime - stop)
        }
        diagnostics.emit(sessionId: recordingSessionId, event)
      }
      emitEnteredPaused(recordingSessionId: recordingSessionId, cause: "retry_failed", detail: nil, stage: second.stageId)
      abandonFailedBegin(second, resuming: true)
      throw second.error
    }
  }

  private func emitEnteredPaused(recordingSessionId: String, cause: String, detail: String?, stage: String) {
    guard diagnostics.isEnabled else { return }
    var event: [String: Any] = [
      "kind": "entered_paused_state", "cp": diagCheckpointOrdinal, "cause": cause, "stage": stage,
    ]
    if let detail { event["detail"] = detail }
    if let stop = diagLastStopUptime {
      event["stopToPauseMs"] = Self.milliseconds(ProcessInfo.processInfo.systemUptime - stop)
    }
    diagnostics.emit(sessionId: recordingSessionId, event)
  }

  /// Decides — from structured facts only — whether the one checkpoint retry may run right now.
  private func checkpointRetryDecision(
    recordingSessionId: String,
    previousCommitted: DurableRecordingSegmentMetadata?,
    first: DurableBeginAttemptFailure
  ) -> CheckpointRetryDecision {
    guard first.stage.isCheckpointRetryEligible else { return .skipped("stage_not_retryable") }
    guard let stopped = lastSegmentStopUptime,
          checkpointRetryPolicy.uptime() - stopped <= checkpointRetryPolicy.elapsedBudget else {
      return .skipped("elapsed_budget_exceeded")
    }
    guard runtimeState == .recording else { return .skipped("runtime_not_recording") }
    guard ownedSessionId == recordingSessionId else { return .skipped("ownership_changed") }
    guard activeCapture == nil, activePlan == nil else { return .skipped("recorder_present") }
    guard !hasPendingSystemEvents else { return .skipped("system_event_pending") }
    guard let session = try? store.getSession(recordingSessionId: recordingSessionId),
          session.state == .recording else { return .skipped("session_not_recording") }
    guard let previous = previousCommitted,
          session.segments.contains(where: { $0.segmentId == previous.segmentId && $0.sequence == previous.sequence }),
          let previousURL = store.segmentFileURL(recordingSessionId: recordingSessionId, relativePath: previous.relativePath),
          FileManager.default.fileExists(atPath: previousURL.path) else {
      return .skipped("previous_segment_missing")
    }
    return .eligible
  }

  /// DIAGNOSTIC ONLY: one compact, self-describing failure record. Never throws.
  private func recordBeginFailure(
    recordingSessionId: String,
    context: String,
    attempt: Int,
    stage: String,
    error: Error,
    plan: DurableSegmentPlan?,
    probe: DurableRecorderProbe,
    beginUptime: TimeInterval
  ) {
    guard diagnostics.isEnabled else { return }
    let now = ProcessInfo.processInfo.systemUptime
    var resolvedStage = stage
    if stage == "audio_session" { resolvedStage = "audio_session." + audioSession.lastActivationStage }
    var event: [String: Any] = [
      "kind": "begin_failed", "ctx": context, "cp": diagCheckpointOrdinal, "attempt": attempt, "stage": resolvedStage,
      "error": DurableRecorderDiagnostics.describe(error),
      "recorder": [
        "exists": probe.recorderExists, "prepared": probe.prepared as Any, "recordReturned": probe.recorded as Any,
        "isRecording": probe.isRecording as Any, "url": probe.url as Any,
        "activeCaptureAtFailure": activeCapture != nil,
      ],
      "atFailure": audioSession.diagnosticSnapshot(),
      "route": audioSession.routeDescription,
      "beginToFailMs": Self.milliseconds(now - beginUptime),
    ]
    if let plan { event["planPath"] = plan.activeRelativePath }
    if let pre = diagRolloverPre { event["pre"] = pre }
    if context == "checkpoint", let stop = diagLastStopUptime { event["stopToFailMs"] = Self.milliseconds(now - stop) }
    if let seq = diagNextSequence { event["seq"] = seq }
    if let session = try? store.getSession(recordingSessionId: recordingSessionId) {
      event["lecture"] = session.lectureId
      if event["seq"] == nil { event["seq"] = (session.segments.map(\.sequence).max() ?? 0) + 1 }
      event["committedSegments"] = session.segments.count
    }
    diagnostics.emit(sessionId: recordingSessionId, event)
  }

  private func finalizeActiveSegment(
    recordingSessionId: String,
    reason: String? = nil
  ) throws -> DurableRecordingSession {
    guard let plan = activePlan, let capture = activeCapture else {
      throw DurableRecorderCoreError.invalidRecorderState("No active segment exists.")
    }
    capture.stop()
    lastSegmentStopUptime = checkpointRetryPolicy.uptime()
    diagLastStopUptime = ProcessInfo.processInfo.systemUptime
    do {
      let inspection = try fileInspector.inspect(url: plan.activeURL)
      let session = try store.commitSegment(
        recordingSessionId: recordingSessionId,
        plan: plan,
        inspection: inspection,
        interruptionReason: reason,
        routeAtStart: routeAtSegmentStart,
        routeAtEnd: audioSession.routeDescription
      )
      clearActiveCapture()
      return session
    } catch {
      // Keep the on-disk partial for quarantine/evidence, but drop live capture
      // so callers cannot double-stop or pretend recording continues.
      clearActiveCapture()
      throw error
    }
  }

  private func handleForcedPause(reason: String, runtimeAfter: DurableRecorderRuntimeState) {
    emitLifecycle("pause_transition", ["caller": "forced_pause", "reason": reason, "willApply": runtimeState == .recording])
    guard runtimeState == .recording, let recordingSessionId = ownedSessionId else {
      if reason.hasPrefix("interruption") { lastInterruption = reason }
      return
    }
    cancelCheckpoint()
    do {
      _ = try finalizeActiveSegment(recordingSessionId: recordingSessionId, reason: reason)
      _ = try store.transitionSession(recordingSessionId: recordingSessionId, to: .paused)
    } catch {
      activeCapture?.stop()
      clearActiveCapture()
      _ = try? store.transitionSession(recordingSessionId: recordingSessionId, to: .paused)
    }
    if reason.hasPrefix("interruption") { lastInterruption = reason }
    runtimeState = runtimeAfter
    audioSession.deactivate()
    // Native is authoritative: push paused/interrupted status to JS so the UI
    // cannot keep showing "recording" after capture has already stopped.
    let session = try? store.getSession(recordingSessionId: recordingSessionId)
    _ = publishStatus(session: session)
  }

  /// Commit the active segment and immediately open the next one without
  /// pausing session state or publishing a paused UI event.
  private func performCheckpointRollover(recordingSessionId: String) throws {
    guard !isCheckpointInProgress else {
      throw DurableRecorderCoreError.invalidRecorderState("Checkpoint already in progress.")
    }
    guard runtimeState == .recording else {
      throw DurableRecorderCoreError.invalidRecorderState("Checkpoint requires an active recording segment.")
    }
    guard ownedSessionId == recordingSessionId, activeCapture != nil, activePlan != nil else {
      throw DurableRecorderCoreError.invalidRecorderState("Checkpoint requires a live owned capture.")
    }

    isCheckpointInProgress = true
    defer { isCheckpointInProgress = false }

    // Evidence only: capture the audio-session state BEFORE the recorder is touched, and buffer everything in
    // memory so no file I/O happens between the old recorder stopping and the new one recording.
    diagCheckpointOrdinal += 1
    diagLastStopUptime = nil
    diagNextSequence = nil
    diagRolloverStartUptime = ProcessInfo.processInfo.systemUptime
    diagRolloverPre = diagnostics.isEnabled ? audioSession.diagnosticSnapshot() : nil
    defer {
      diagnostics.flush()
      diagRolloverPre = nil
    }
    diagnostics.emit(sessionId: recordingSessionId, [
      "kind": "rollover_start", "cp": diagCheckpointOrdinal, "oldSeq": activePlan?.sequence as Any,
      "pre": diagRolloverPre as Any,
    ])

    // Drop any pending timer for this segment before mutating capture.
    cancelCheckpoint()

    var previousCommitted: DurableRecordingSegmentMetadata?
    lastSegmentStopUptime = nil
    do {
      let committed = try finalizeActiveSegment(recordingSessionId: recordingSessionId, reason: "checkpoint")
      if let last = committed.segments.max(by: { $0.sequence < $1.sequence }) {
        previousCommitted = last
        diagNextSequence = last.sequence + 1
        var event: [String: Any] = [
          "kind": "old_segment_committed", "cp": diagCheckpointOrdinal, "oldSeq": last.sequence,
          "durationMs": last.durationMs, "bytes": last.byteLength, "lecture": committed.lectureId,
        ]
        if let stop = diagLastStopUptime { event["stopToCommitMs"] = Self.milliseconds(ProcessInfo.processInfo.systemUptime - stop) }
        diagnostics.emit(sessionId: recordingSessionId, event)
      }
    } catch {
      diagnostics.emit(sessionId: recordingSessionId, [
        "kind": "commit_failed", "cp": diagCheckpointOrdinal, "error": DurableRecorderDiagnostics.describe(error),
      ])
      failCheckpointCapture(
        recordingSessionId: recordingSessionId,
        runtimeAfter: .paused,
        reason: "checkpoint_commit_failed"
      )
      throw error
    }

    do {
      // Keep the audio session active across the rollover. The attempt re-activates if needed and leaves
      // session.state as recording. A transient failure gets exactly one bounded retry (see
      // `beginCheckpointSegment`); anything else, or a second failure, lands in the catch below unchanged.
      try beginCheckpointSegment(recordingSessionId: recordingSessionId, previousCommitted: previousCommitted)
      scheduleCheckpoint()
      // Do not publishStatus: a successful checkpoint must stay invisible to JS
      // so the recording timer is not reset or double-counted.
    } catch {
      diagnostics.emit(sessionId: recordingSessionId, ["kind": "pause_transition", "caller": "checkpoint_begin_failed_protective_pause", "cp": diagCheckpointOrdinal])
      if (try? store.getSession(recordingSessionId: recordingSessionId))?.state == .recording {
        _ = try? store.transitionSession(recordingSessionId: recordingSessionId, to: .paused)
      }
      runtimeState = .paused
      audioSession.deactivate()
      // Distinguishable from a plain user pause or an AVAudioSession
      // interruption/route change — JS uses this to show a clear "checkpoint
      // failed, tap Resume" recovery state instead of an ordinary paused UI.
      // The committed segments up to (and including) this checkpoint are
      // untouched; only the NEXT segment failed to open.
      lastInterruption = "checkpoint_begin_segment_failed"
      let session = try? store.getSession(recordingSessionId: recordingSessionId)
      _ = publishStatus(session: session)
      throw error
    }
  }

  private func failCheckpointCapture(
    recordingSessionId: String,
    runtimeAfter: DurableRecorderRuntimeState,
    reason: String
  ) {
    diagnostics.emit(sessionId: recordingSessionId, ["kind": "pause_transition", "caller": "checkpoint_commit_failed", "reason": reason, "cp": diagCheckpointOrdinal])
    activeCapture?.stop()
    clearActiveCapture()
    cancelCheckpoint()
    _ = try? store.transitionSession(recordingSessionId: recordingSessionId, to: .paused)
    runtimeState = runtimeAfter
    audioSession.deactivate()
    lastInterruption = reason
    let session = try? store.getSession(recordingSessionId: recordingSessionId)
    _ = publishStatus(session: session)
  }

  private func scheduleCheckpoint() {
    cancelCheckpoint()
    guard checkpointInterval > 0 else { return }
    guard runtimeState == .recording else { return }
    guard let sessionId = ownedSessionId, let plan = activePlan, activeCapture != nil else { return }

    let generation = checkpointGeneration
    let expectedSessionId = sessionId
    let expectedSegmentId = plan.segmentId
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + checkpointInterval, repeating: .never)
    timer.setEventHandler { [weak self] in
      self?.handleCheckpointTimer(
        generation: generation,
        sessionId: expectedSessionId,
        segmentId: expectedSegmentId
      )
    }
    checkpointTimer = timer
    timer.resume()
  }

  private func cancelCheckpoint() {
    checkpointTimer?.cancel()
    checkpointTimer = nil
    checkpointGeneration &+= 1
  }

  private func handleCheckpointTimer(generation: UInt64, sessionId: String, segmentId: String) {
    guard generation == checkpointGeneration else { return }
    guard !isCheckpointInProgress else { return }
    guard runtimeState == .recording else { return }
    guard ownedSessionId == sessionId else { return }
    guard activePlan?.segmentId == segmentId else { return }
    guard activeCapture != nil else { return }

    checkpointTimer = nil
    do {
      try performCheckpointRollover(recordingSessionId: sessionId)
    } catch {
      // Failure path already published authoritative paused status.
    }
  }

  /// True only when the currently-owned session (if any) is safe to
  /// silently release in favor of a different session's claim.
  ///
  /// Deliberately narrow: only `.paused` and `.interrupted` qualify — a
  /// session sitting there with nothing currently happening to it. Every
  /// OTHER non-recording state (`.preparing`, `.ready`, `.pausing`,
  /// `.resuming`, `.stopping`) is mid-lifecycle-transition — about to
  /// become active, or in the middle of becoming inactive — and pre-empting
  /// those would race the very operation already in flight for that owner
  /// (this is exactly what testOwnershipAndStartFailure guards: preparing a
  /// SECOND session while the first is merely `.ready`, not yet recording,
  /// must still be rejected as recorderBusy). `.recording` — genuinely
  /// active capture — is the hard conflict the product invariant "only one
  /// session may actively capture at a time" exists to protect, and
  /// claim/claimForFinalization still throw `.recorderBusy` for it,
  /// unchanged. `.idle`/`.failed` mean there is effectively no live owner
  /// to protect either way.
  ///
  /// A `.paused`/`.interrupted` owner has already safely committed
  /// everything it's going to for now. Releasing it here touches no
  /// segments, no metadata, nothing on disk; it only clears this in-memory
  /// pointer, exactly what a cold process relaunch already does today (see
  /// claimForFinalization's own doc comment below) — so the released
  /// session's OWN later Resume/Finish can re-claim it the same way
  /// recovery already works after a relaunch. Without this, a single paused
  /// lecture permanently deadlocked every OTHER in-progress lecture in the
  /// app for the remaining lifetime of the process: opening any of them
  /// correctly found a real, recoverable session, but Resume always failed
  /// with `.recorderBusy` — "I found your unfinished recording, but I
  /// cannot let you continue it."
  private var currentOwnerIsSafeToRelease: Bool {
    guard ownedSessionId != nil else { return false }
    switch runtimeState {
    case .paused, .interrupted, .idle, .failed:
      return true
    case .preparing, .ready, .recording, .pausing, .resuming, .stopping:
      return false
    }
  }

  private func claim(_ recordingSessionId: String) throws {
    if let ownedSessionId, ownedSessionId != recordingSessionId {
      guard currentOwnerIsSafeToRelease else { throw DurableRecorderCoreError.recorderBusy }
      releaseOwnership()
    }
    ownedSessionId = recordingSessionId
  }

  private func requireOwner(_ recordingSessionId: String) throws {
    guard ownedSessionId == recordingSessionId else {
      if ownedSessionId != nil { throw DurableRecorderCoreError.recorderBusy }
      throw DurableRecorderCoreError.invalidRecorderState("The session does not own the native recorder.")
    }
  }

  /// Acquire stop/finalize authority without starting capture.
  ///
  /// After a cold relaunch the process has no `ownedSessionId`, but a paused
  /// (or already-finalizing) session may still have valid committed segments.
  /// Finish must be able to claim those sessions. A genuinely live owner
  /// (actively recording) remains a hard conflict; a different owner that is
  /// merely paused is safely released first — same rule as `claim` above,
  /// see `currentOwnerIsSafeToRelease`'s doc comment. Any active capture
  /// owned by another path is still a hard conflict regardless.
  private func claimForFinalization(
    _ recordingSessionId: String,
    session: DurableRecordingSession
  ) throws {
    if ownedSessionId == recordingSessionId {
      return
    }
    if ownedSessionId != nil {
      guard currentOwnerIsSafeToRelease else { throw DurableRecorderCoreError.recorderBusy }
      releaseOwnership()
    }
    guard activeCapture == nil else {
      throw DurableRecorderCoreError.recorderBusy
    }
    switch session.state {
    case .paused, .finalizing:
      ownedSessionId = recordingSessionId
      if runtimeState == .idle {
        runtimeState = session.state == .paused ? .paused : .idle
      }
    case .recording:
      // Live capture finalization requires the owner that started the segment.
      throw DurableRecorderCoreError.invalidRecorderState(
        "The session does not own the native recorder."
      )
    default:
      throw DurableRecorderCoreError.invalidRecorderState(
        "The session does not own the native recorder."
      )
    }
  }

  private func clearActiveCapture() {
    activeCapture = nil
    activePlan = nil
    routeAtSegmentStart = nil
  }

  private func releaseOwnership() {
    cancelCheckpoint()
    activeCapture?.stop()
    clearActiveCapture()
    audioSession.deactivate()
    ownedSessionId = nil
    runtimeState = .idle
  }

  private func noteSystemEventQueued() {
    pendingSystemEventsLock.lock(); defer { pendingSystemEventsLock.unlock() }
    pendingSystemEvents += 1
  }

  private func noteSystemEventHandled() {
    pendingSystemEventsLock.lock(); defer { pendingSystemEventsLock.unlock() }
    pendingSystemEvents = max(0, pendingSystemEvents - 1)
  }

  private var hasPendingSystemEvents: Bool {
    pendingSystemEventsLock.lock(); defer { pendingSystemEventsLock.unlock() }
    return pendingSystemEvents > 0
  }

  /// Test-only: pretend an interruption/route notification is queued behind the current engine work.
  func simulatePendingSystemEventForTesting() { noteSystemEventQueued() }

  private func publishStatus(session: DurableRecordingSession?) -> [String: Any] {
    statusSequence += 1
    let payload = statusDictionary(session: session)
    onStatusChange?(payload)
    return payload
  }

  private func statusDictionary(session: DurableRecordingSession?) -> [String: Any] {
    var result: [String: Any] = [
      "runtimeState": runtimeState.rawValue,
      "permission": audioSession.permissionState.rawValue,
      "completedSegments": session?.segments.map { $0.asDictionary() } ?? [],
      "statusSequence": statusSequence
    ]
    if let ownedSessionId { result["recordingSessionId"] = ownedSessionId }
    if let session { result["recordingSessionId"] = session.recordingSessionId }
    if let activePlan { result["activeSegmentId"] = activePlan.segmentId }
    if let lastInterruption { result["interruptionState"] = lastInterruption }
    if let lastRouteChange { result["routeChangeState"] = lastRouteChange }
    if let session { result["session"] = session.asDictionary() }
    return result
  }

  private func registerObservers() {
    #if os(iOS)
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      self?.noteSystemEventQueued()
      self?.queue.async {
        defer { self?.noteSystemEventHandled() }
        self?.handleInterruption(notification)
      }
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      self?.noteSystemEventQueued()
      self?.queue.async {
        defer { self?.noteSystemEventHandled() }
        self?.handleRouteChange(notification)
      }
    })
    if diagnostics.isEnabled {
      DispatchQueue.main.async { [weak self] in
        let state = UIApplication.shared.applicationState
        self?.setAppState(state == .active ? "active" : (state == .inactive ? "inactive" : "background"))
      }
      let appEvents: [(Notification.Name, String)] = [
        (UIApplication.didBecomeActiveNotification, "active"),
        (UIApplication.willResignActiveNotification, "inactive"),
        (UIApplication.didEnterBackgroundNotification, "background"),
        (UIApplication.willEnterForegroundNotification, "foreground_pending"),
      ]
      for (name, label) in appEvents {
        observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
          self?.setAppState(label)
          self?.queue.async { self?.emitLifecycle("app_state", ["state": label]) }
        })
      }
    }
    #endif
  }

  #if os(iOS)
  private func handleInterruption(_ notification: Notification) {
    guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
    let rawReason = notification.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
    emitLifecycle("interruption", ["type": type == .began ? "began" : "ended", "reasonRaw": rawReason.map { Int($0) } as Any])
    switch type {
    case .began:
      handleForcedPause(reason: "interruption_began", runtimeAfter: .interrupted)
    case .ended:
      let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
      lastInterruption = options.contains(.shouldResume)
        ? "ended_resume_allowed"
        : "ended_resume_not_allowed"
    @unknown default:
      lastInterruption = "unknown"
    }
  }

  private func handleRouteChange(_ notification: Notification) {
    let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
    let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason) ?? .unknown
    lastRouteChange = Self.routeReasonName(reason)
    emitLifecycle("route_change", ["reason": Self.routeReasonName(reason), "route": audioSession.routeDescription])
    if reason == .oldDeviceUnavailable || !audioSession.hasSuitableInput {
      handleForcedPause(reason: "route_\(Self.routeReasonName(reason))", runtimeAfter: .paused)
    }
  }

  private static func routeReasonName(_ reason: AVAudioSession.RouteChangeReason) -> String {
    switch reason {
    case .newDeviceAvailable: return "new_device_available"
    case .oldDeviceUnavailable: return "old_device_unavailable"
    case .categoryChange: return "category_change"
    case .override: return "override"
    case .wakeFromSleep: return "wake_from_sleep"
    case .noSuitableRouteForCategory: return "no_suitable_input"
    case .routeConfigurationChange: return "route_configuration_change"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
  }
  #endif
}

/// DIAGNOSTIC ONLY. What the recorder looked like when `beginSegment` failed.
struct DurableRecorderProbe {
  var recorderExists = false
  var prepared: Bool?
  var recorded: Bool?
  var isRecording: Bool?
  var url: String?
}

/// Bounded, best-effort evidence log for the checkpoint-rollover path.
///
/// Purpose: when `beginSegment(next)` throws during a rollover, say exactly which operation failed, with the
/// NSError, the AVAudioSession state before/at the failure, and (for successful rollovers) the measured capture gap.
///
/// Guarantees:
///  - OFF unless explicitly enabled (Dev bundle by default), so production recording is byte-for-byte unchanged.
///  - Never throws and never touches session metadata: a failure to log is swallowed.
///  - Events are buffered in memory and written by `flush()` AFTER the new recorder is already recording (or after
///    the failure has been handled), so it adds no file I/O inside the stop→record gap.
///  - One JSON object per line in `sessions/<id>/diagnostics.jsonl`, trimmed to `maxLines`; failure records are
///    kept preferentially (`maxFailureLines`). No audio, transcript or other user content is recorded.
final class DurableRecorderDiagnostics {
  static let maxLines = 240
  static let maxFailureLines = 40
  static let maxPendingEvents = 64
  private static let trimCheckInterval = 20

  let isEnabled: Bool
  /// Extra context stamped on every event (e.g. the app's foreground/background state). Diagnostics only.
  var contextProvider: (() -> [String: Any])?
  private let fileURL: (String) -> URL?
  private var pending: [(sessionId: String, event: [String: Any])] = []
  private var appendsSinceTrim = 0
  private static let timestampFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  init(enabled: Bool, fileURL: @escaping (String) -> URL?) {
    isEnabled = enabled
    self.fileURL = fileURL
  }

  /// DIAGNOSTIC ONLY: the app's UIApplication state as last announced by UIKit notifications, shared so evidence
  /// emitted outside the recorder (Finish/export) can carry the same context.
  private static let sharedAppStateLock = NSLock()
  private static var sharedAppStateName = "unknown"
  static func setSharedAppState(_ name: String) {
    sharedAppStateLock.lock(); sharedAppStateName = name; sharedAppStateLock.unlock()
  }
  static var sharedAppState: String {
    sharedAppStateLock.lock(); defer { sharedAppStateLock.unlock() }
    return sharedAppStateName
  }

  /// Dev builds only (bundle id `com.aydenz.youmilensipad.dev`); the Production bundle never matches.
  static var isDevBundle: Bool {
    Bundle.main.bundleIdentifier?.hasSuffix(".dev") == true
  }

  func emit(sessionId: String, _ event: [String: Any]) {
    guard isEnabled else { return }
    var stamped = Self.sanitize(event) as? [String: Any] ?? [:]
    stamped["t"] = Self.timestampFormatter.string(from: Date())
    stamped["up"] = Self.uptimeMilliseconds()
    stamped["sid"] = sessionId
    if let extra = contextProvider?() { for (key, value) in extra where stamped[key] == nil { stamped[key] = value } }
    pending.append((sessionId, stamped))
    if pending.count > Self.maxPendingEvents { pending.removeFirst(pending.count - Self.maxPendingEvents) }
  }

  /// Writes and clears buffered events. Never throws.
  func flush() {
    guard isEnabled, !pending.isEmpty else { pending.removeAll(); return }
    let batch = pending
    pending.removeAll()
    var bySession: [String: [String]] = [:]
    var order: [String] = []
    for item in batch {
      guard JSONSerialization.isValidJSONObject(item.event),
            let data = try? JSONSerialization.data(withJSONObject: item.event, options: [.sortedKeys]),
            let line = String(data: data, encoding: .utf8) else { continue }
      if bySession[item.sessionId] == nil { order.append(item.sessionId) }
      bySession[item.sessionId, default: []].append(line)
    }
    for sessionId in order {
      guard let url = fileURL(sessionId), let lines = bySession[sessionId] else { continue }
      append(lines: lines, to: url)
    }
  }

  private func append(lines: [String], to url: URL) {
    let payload = Data((lines.joined(separator: "\n") + "\n").utf8)
    do {
      if !FileManager.default.fileExists(atPath: url.path) {
        guard FileManager.default.createFile(atPath: url.path, contents: payload) else { return }
      } else {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: payload)
      }
    } catch {
      return
    }
    appendsSinceTrim += lines.count
    if appendsSinceTrim >= Self.trimCheckInterval {
      appendsSinceTrim = 0
      trimIfNeeded(url)
    }
  }

  private func trimIfNeeded(_ url: URL) {
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    guard lines.count > Self.maxLines else { return }
    var keep = Set<Int>()
    let failures = lines.indices.filter { Self.isFailureLine(lines[$0]) }.suffix(Self.maxFailureLines)
    keep.formUnion(failures)
    var budget = Self.maxLines - keep.count
    for index in lines.indices.reversed() where budget > 0 && !keep.contains(index) {
      keep.insert(index)
      budget -= 1
    }
    let trimmed = lines.indices.filter(keep.contains).map { lines[$0] }.joined(separator: "\n") + "\n"
    try? Data(trimmed.utf8).write(to: url, options: .atomic)
  }

  static func isFailureLine(_ line: String) -> Bool {
    ["begin_failed", "commit_failed", "retry_started", "retry_succeeded", "retry_failed", "entered_paused_state"]
      .contains { line.contains("\"kind\":\"\($0)\"") }
  }

  static func uptimeMilliseconds() -> Double {
    (ProcessInfo.processInfo.systemUptime * 1_000).rounded()
  }

  /// Compact form of a full session snapshot for SUCCESS events (category / mode / options / route only).
  static func compactSession(_ snapshot: [String: Any]) -> [String: Any] {
    var out: [String: Any] = [:]
    for key in ["category", "mode", "options", "inputs", "otherAudioPlaying"] {
      if let value = snapshot[key] { out[key] = value }
    }
    return out
  }

  /// NSError details (domain / code / FourCC / description / underlying chain) plus the Swift error text.
  static func describe(_ error: Error, depth: Int = 0) -> [String: Any] {
    let ns = error as NSError
    var out: [String: Any] = [
      "domain": ns.domain,
      "code": ns.code,
      "desc": truncated(ns.localizedDescription, 240),
      "swift": truncated(String(describing: error), 240),
    ]
    if let code = fourCC(ns.code) { out["fourCC"] = code }
    if let reason = ns.localizedFailureReason { out["reason"] = truncated(reason, 160) }
    if depth < 2, let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
      out["underlying"] = describe(underlying, depth: depth + 1)
    }
    return out
  }

  static func fourCC(_ code: Int) -> String? {
    guard code > 0, code <= Int(UInt32.max) else { return nil }
    let value = UInt32(code)
    let bytes = [UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff), UInt8((value >> 8) & 0xff), UInt8(value & 0xff)]
    guard bytes.allSatisfy({ $0 >= 0x20 && $0 <= 0x7e }) else { return nil }
    return String(bytes: bytes, encoding: .ascii)
  }

  private static func truncated(_ text: String, _ limit: Int) -> String {
    text.count <= limit ? text : String(text.prefix(limit)) + "…"
  }

  /// JSON-safe copy: drops nil optionals, keeps numbers/strings/bools/arrays/dictionaries, stringifies the rest.
  static func sanitize(_ value: Any) -> Any? {
    let mirror = Mirror(reflecting: value)
    if mirror.displayStyle == .optional {
      guard let child = mirror.children.first else { return nil }
      return sanitize(child.value)
    }
    switch value {
    case let string as String: return string
    case let bool as Bool: return bool
    case let int as Int: return int
    case let int64 as Int64: return int64
    case let double as Double: return double.isFinite ? double : nil
    case let float as Float: return float.isFinite ? Double(float) : nil
    case let array as [Any]: return array.compactMap(sanitize)
    case let dict as [String: Any]: return dict.compactMapValues(sanitize)
    default: return String(describing: value)
    }
  }
}
