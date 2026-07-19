import Foundation

let durableRecorderSchemaVersion = 1
let durableRecorderSegmentSchemaVersion = 1

enum DurableRecordingState: String, Codable, CaseIterable {
  case created
  case preparing
  case ready
  case recording
  case paused
  case finalizing
  case finalized
  case failed
  case abandoned

  var isTerminal: Bool {
    switch self {
    case .finalized, .failed, .abandoned:
      return true
    default:
      return false
    }
  }

  private static let transitions: [DurableRecordingState: Set<DurableRecordingState>] = [
    .created: [.preparing],
    .preparing: [.ready, .failed],
    .ready: [.recording, .abandoned],
    .recording: [.paused, .finalizing, .failed],
    .paused: [.recording, .finalizing, .abandoned, .failed],
    .finalizing: [.finalized, .failed],
    .finalized: [],
    .failed: [],
    .abandoned: []
  ]

  func allowsTransition(to target: DurableRecordingState) -> Bool {
    Self.transitions[self]?.contains(target) == true
  }
}

enum DurableRecorderRuntimeState: String, CaseIterable {
  case idle
  case preparing
  case ready
  case recording
  case pausing
  case paused
  case resuming
  case stopping
  case interrupted
  case failed
}

enum DurableRecorderPermissionState: String {
  case undetermined
  case granted
  case denied
  case restricted
}

struct DurableRecordingSegmentMetadata: Codable, Equatable {
  let schemaVersion: Int
  let segmentId: String
  let sequence: Int
  let relativePath: String
  let createdAt: String
  let finalizedAt: String
  let durationMs: Int
  let byteLength: Int64
  let container: String
  let codec: String
  let sampleRate: Double
  let channelCount: Int
  let integrityStatus: String
  let interruptionReason: String?
  let routeAtStart: String?
  let routeAtEnd: String?
  let recoveredAfterRestart: Bool?

  func asDictionary() -> [String: Any] {
    var result: [String: Any] = [
      "schemaVersion": schemaVersion,
      "segmentId": segmentId,
      "sequence": sequence,
      "relativePath": relativePath,
      "createdAt": createdAt,
      "finalizedAt": finalizedAt,
      "durationMs": durationMs,
      "byteLength": byteLength,
      "container": container,
      "codec": codec,
      "sampleRate": sampleRate,
      "channelCount": channelCount,
      "integrityStatus": integrityStatus
    ]
    if let interruptionReason { result["interruptionReason"] = interruptionReason }
    if let routeAtStart { result["routeAtStart"] = routeAtStart }
    if let routeAtEnd { result["routeAtEnd"] = routeAtEnd }
    if let recoveredAfterRestart { result["recoveredAfterRestart"] = recoveredAfterRestart }
    return result
  }
}

struct DurableRecordingSession: Codable, Equatable {
  let schemaVersion: Int
  let recordingSessionId: String
  let lectureId: String
  var state: DurableRecordingState
  let createdAt: String
  var updatedAt: String
  let relativeSessionPath: String
  var recoverable: Bool
  var finalized: Bool
  var failureCode: String?
  var failureMessage: String?
  var segments: [DurableRecordingSegmentMetadata]

  mutating func apply(
    state target: DurableRecordingState,
    updatedAt: String,
    failureCode: String? = nil,
    failureMessage: String? = nil
  ) {
    state = target
    self.updatedAt = updatedAt
    recoverable = !target.isTerminal
    finalized = target == .finalized
    self.failureCode = target == .failed ? failureCode : nil
    self.failureMessage = target == .failed ? failureMessage : nil
  }

  func asDictionary() -> [String: Any] {
    var result: [String: Any] = [
      "schemaVersion": schemaVersion,
      "recordingSessionId": recordingSessionId,
      "lectureId": lectureId,
      "state": state.rawValue,
      "createdAt": createdAt,
      "updatedAt": updatedAt,
      "relativeSessionPath": relativeSessionPath,
      "recoverable": recoverable,
      "finalized": finalized,
      "segments": segments.map { $0.asDictionary() }
    ]
    if let failureCode { result["failureCode"] = failureCode }
    if let failureMessage { result["failureMessage"] = failureMessage }
    return result
  }
}

struct DurableSegmentPlan: Equatable {
  let segmentId: String
  let sequence: Int
  let createdAt: String
  let activeRelativePath: String
  let finalizedRelativePath: String
  let activeURL: URL
  let finalizedURL: URL
}

struct DurableAudioFileInspection: Equatable {
  let durationMs: Int
  let byteLength: Int64
  let sampleRate: Double
  let channelCount: Int
}

struct DurableRecoveryIssue: Equatable {
  let code: String
  let relativePath: String
  let segmentId: String?

  func asDictionary() -> [String: Any] {
    var result: [String: Any] = ["code": code, "relativePath": relativePath]
    if let segmentId { result["segmentId"] = segmentId }
    return result
  }
}

struct DurableRecoveryResult {
  let session: DurableRecordingSession
  let issues: [DurableRecoveryIssue]

  func asDictionary() -> [String: Any] {
    ["session": session.asDictionary(), "issues": issues.map { $0.asDictionary() }]
  }
}

enum DurableRecorderCoreError: Error, Equatable {
  case invalidIdentifier
  case invalidLectureId
  case sessionNotFound
  case invalidTransition(from: DurableRecordingState, to: DurableRecordingState)
  case terminalState(DurableRecordingState)
  case unsupportedSchemaVersion(Int)
  case unsupportedSegmentSchemaVersion(Int)
  case invalidMetadata
  case sessionNotTerminal
  case recorderBusy
  case invalidRecorderState(String)
  case microphonePermissionDenied
  case noAudioInput
  case recorderStartFailed(String)
  case segmentValidationFailed(String)
  case segmentCollision
  case storageFailure(String)

  var code: String {
    switch self {
    case .invalidIdentifier: return "ERR_DURABLE_RECORDER_INVALID_IDENTIFIER"
    case .invalidLectureId: return "ERR_DURABLE_RECORDER_INVALID_LECTURE_ID"
    case .sessionNotFound: return "ERR_DURABLE_RECORDER_SESSION_NOT_FOUND"
    case .invalidTransition: return "ERR_DURABLE_RECORDER_INVALID_TRANSITION"
    case .terminalState: return "ERR_DURABLE_RECORDER_TERMINAL_STATE"
    case .unsupportedSchemaVersion: return "ERR_DURABLE_RECORDER_UNSUPPORTED_SCHEMA"
    case .unsupportedSegmentSchemaVersion: return "ERR_DURABLE_RECORDER_UNSUPPORTED_SEGMENT_SCHEMA"
    case .invalidMetadata: return "ERR_DURABLE_RECORDER_INVALID_METADATA"
    case .sessionNotTerminal: return "ERR_DURABLE_RECORDER_SESSION_NOT_TERMINAL"
    case .recorderBusy: return "ERR_DURABLE_RECORDER_BUSY"
    case .invalidRecorderState: return "ERR_DURABLE_RECORDER_INVALID_RECORDER_STATE"
    case .microphonePermissionDenied: return "ERR_DURABLE_RECORDER_PERMISSION_DENIED"
    case .noAudioInput: return "ERR_DURABLE_RECORDER_NO_AUDIO_INPUT"
    case .recorderStartFailed: return "ERR_DURABLE_RECORDER_START_FAILED"
    case .segmentValidationFailed: return "ERR_DURABLE_RECORDER_SEGMENT_VALIDATION"
    case .segmentCollision: return "ERR_DURABLE_RECORDER_SEGMENT_COLLISION"
    case .storageFailure: return "ERR_DURABLE_RECORDER_STORAGE"
    }
  }

  var message: String {
    switch self {
    case .invalidIdentifier:
      return "The recording session identifier is invalid."
    case .invalidLectureId:
      return "The lecture identifier must be a non-empty string."
    case .sessionNotFound:
      return "The durable recording session was not found."
    case let .invalidTransition(from, to):
      return "Cannot transition a durable recording session from \(from.rawValue) to \(to.rawValue)."
    case let .terminalState(state):
      return "The durable recording session is terminal in state \(state.rawValue)."
    case let .unsupportedSchemaVersion(version):
      return "Durable recording metadata schema version \(version) is unsupported."
    case let .unsupportedSegmentSchemaVersion(version):
      return "Durable segment metadata schema version \(version) is unsupported."
    case .invalidMetadata:
      return "The durable recording session metadata is invalid."
    case .sessionNotTerminal:
      return "Only terminal durable recording sessions can be deleted."
    case .recorderBusy:
      return "Another durable recording session already owns the native recorder."
    case let .invalidRecorderState(reason):
      return "The native recorder operation is invalid: \(reason)"
    case .microphonePermissionDenied:
      return "Microphone permission is not granted for the durable recorder."
    case .noAudioInput:
      return "No suitable audio input is available."
    case let .recorderStartFailed(reason):
      return "The native recorder could not start: \(reason)"
    case let .segmentValidationFailed(reason):
      return "The recorded segment failed validation: \(reason)"
    case .segmentCollision:
      return "A generated segment path already exists."
    case let .storageFailure(reason):
      return "Durable recording storage failed: \(reason)"
    }
  }
}
