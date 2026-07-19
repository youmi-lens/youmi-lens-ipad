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
  func requestPermission() async -> DurableRecorderPermissionState
  func activateForRecording() throws
  func deactivate()
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

  func activateForRecording() throws {
    try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
    try session.setActive(true)
    guard hasSuitableInput else {
      deactivate()
      throw DurableRecorderCoreError.noAudioInput
    }
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

final class DurableForegroundRecorder {
  private let store: DurableRecorderStore
  private let audioSession: DurableAudioSessionManaging
  private let captureFactory: DurableAudioCaptureFactory
  private let fileInspector: DurableAudioFileInspecting
  private let queue = DispatchQueue(label: "com.youmilens.durable-recorder.engine")
  private var observers: [NSObjectProtocol] = []

  private var runtimeState: DurableRecorderRuntimeState = .idle
  private var ownedSessionId: String?
  private var activePlan: DurableSegmentPlan?
  private var activeCapture: DurableAudioCapture?
  private var routeAtSegmentStart: String?
  private var lastInterruption: String?
  private var lastRouteChange: String?

  init(
    store: DurableRecorderStore,
    audioSession: DurableAudioSessionManaging = SystemDurableAudioSessionManager(),
    captureFactory: DurableAudioCaptureFactory = SystemDurableAudioCaptureFactory(),
    fileInspector: DurableAudioFileInspecting = SystemDurableAudioFileInspector(),
    observeSystemNotifications: Bool = true
  ) {
    self.store = store
    self.audioSession = audioSession
    self.captureFactory = captureFactory
    self.fileInspector = fileInspector
    if observeSystemNotifications {
      registerObservers()
    }
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
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
      return statusDictionary(session: session)
    }
  }

  func pauseRecording(recordingSessionId: String) throws -> [String: Any] {
    try queue.sync {
      try requireOwner(recordingSessionId)
      if runtimeState == .paused || runtimeState == .interrupted {
        return statusDictionary(session: try store.getSession(recordingSessionId: recordingSessionId))
      }
      guard runtimeState == .recording else {
        throw DurableRecorderCoreError.invalidRecorderState("Pause requires an active recording segment.")
      }
      runtimeState = .pausing
      do {
        _ = try finalizeActiveSegment(recordingSessionId: recordingSessionId)
        let session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .paused)
        runtimeState = .paused
        audioSession.deactivate()
        return statusDictionary(session: session)
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
      return statusDictionary(session: resumed)
    }
  }

  func stopRecording(recordingSessionId: String) throws -> [String: Any] {
    try queue.sync {
      let existing = try store.getSession(recordingSessionId: recordingSessionId)
      if existing.state == .finalized {
        if ownedSessionId == recordingSessionId { releaseOwnership() }
        return statusDictionary(session: existing)
      }
      // Finish must work after cold recovery without Resume. Ownership is
      // process-local, so a relaunch leaves no owner even when committed
      // segments are intact. Claim for finalization only when this process has
      // no live owner and no active capture; never start audio here.
      try claimForFinalization(recordingSessionId, session: existing)
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
        return statusDictionary(session: session)
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
      var quarantineIssues: [DurableRecoveryIssue] = []
      if hasStalePartial {
        quarantineIssues = try store.quarantineInactivePartialFiles(
          recordingSessionId: recordingSessionId
        )
        result = try store.reconcileSession(recordingSessionId: recordingSessionId) { [fileInspector] url in
          (try? fileInspector.inspect(url: url)) != nil
        }
        session = result.session
      }
      if !session.state.isTerminal {
        // Recovery does not claim ownership. Resume claims when the user
        // continues capture; Finish claims via claimForFinalization.
        runtimeState = session.state == .paused ? .paused : session.state == .ready ? .ready : .idle
      }
      return DurableRecoveryResult(
        session: session,
        issues: result.issues + quarantineIssues
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

  private func beginSegment(recordingSessionId: String, resuming: Bool) throws -> DurableRecordingSession {
    guard audioSession.permissionState == .granted else {
      runtimeState = resuming ? .paused : .ready
      throw DurableRecorderCoreError.microphonePermissionDenied
    }
    do {
      try audioSession.activateForRecording()
      guard audioSession.hasSuitableInput else { throw DurableRecorderCoreError.noAudioInput }
      let plan = try store.createSegmentPlan(recordingSessionId: recordingSessionId)
      let capture = try captureFactory.makeCapture(url: plan.activeURL)
      guard capture.prepareToRecord(), capture.record() else {
        capture.stop()
        throw DurableRecorderCoreError.recorderStartFailed("AVAudioRecorder rejected the recording request.")
      }
      activePlan = plan
      activeCapture = capture
      routeAtSegmentStart = audioSession.routeDescription
      let session = try store.transitionSession(recordingSessionId: recordingSessionId, to: .recording)
      runtimeState = .recording
      return session
    } catch {
      activeCapture?.stop()
      clearActiveCapture()
      audioSession.deactivate()
      runtimeState = resuming ? .paused : .ready
      throw error
    }
  }

  private func finalizeActiveSegment(
    recordingSessionId: String,
    reason: String? = nil
  ) throws -> DurableRecordingSession {
    guard let plan = activePlan, let capture = activeCapture else {
      throw DurableRecorderCoreError.invalidRecorderState("No active segment exists.")
    }
    capture.stop()
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
  }

  private func handleForcedPause(reason: String, runtimeAfter: DurableRecorderRuntimeState) {
    guard runtimeState == .recording, let recordingSessionId = ownedSessionId else {
      if reason.hasPrefix("interruption") { lastInterruption = reason }
      return
    }
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
  }

  private func claim(_ recordingSessionId: String) throws {
    if let ownedSessionId, ownedSessionId != recordingSessionId {
      throw DurableRecorderCoreError.recorderBusy
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
  /// Finish must be able to claim those sessions. A different live owner, or
  /// any active capture owned by another path, remains a hard conflict.
  private func claimForFinalization(
    _ recordingSessionId: String,
    session: DurableRecordingSession
  ) throws {
    if ownedSessionId == recordingSessionId {
      return
    }
    if ownedSessionId != nil {
      throw DurableRecorderCoreError.recorderBusy
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
    activeCapture?.stop()
    clearActiveCapture()
    audioSession.deactivate()
    ownedSessionId = nil
    runtimeState = .idle
  }

  private func statusDictionary(session: DurableRecordingSession?) -> [String: Any] {
    var result: [String: Any] = [
      "runtimeState": runtimeState.rawValue,
      "permission": audioSession.permissionState.rawValue,
      "completedSegments": session?.segments.map { $0.asDictionary() } ?? []
    ]
    if let ownedSessionId { result["recordingSessionId"] = ownedSessionId }
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
      self?.queue.async { self?.handleInterruption(notification) }
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      self?.queue.async { self?.handleRouteChange(notification) }
    })
    #if canImport(UIKit)
    observers.append(center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async {
        self?.handleForcedPause(reason: "application_backgrounded", runtimeAfter: .paused)
      }
    })
    #endif
    #endif
  }

  #if os(iOS)
  private func handleInterruption(_ notification: Notification) {
    guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
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
