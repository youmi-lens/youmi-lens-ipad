import Foundation

let durableRecorderSchemaVersion = 1

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

struct DurableRecordingSegmentMetadata: Codable, Equatable {
  let segmentId: String
  let createdAt: String
  let relativePath: String
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
      "segments": segments.map { segment in
        [
          "segmentId": segment.segmentId,
          "createdAt": segment.createdAt,
          "relativePath": segment.relativePath
        ]
      }
    ]
    if let failureCode {
      result["failureCode"] = failureCode
    }
    if let failureMessage {
      result["failureMessage"] = failureMessage
    }
    return result
  }
}

enum DurableRecorderCoreError: Error, Equatable {
  case invalidIdentifier
  case invalidLectureId
  case sessionNotFound
  case invalidTransition(from: DurableRecordingState, to: DurableRecordingState)
  case terminalState(DurableRecordingState)
  case unsupportedSchemaVersion(Int)
  case invalidMetadata
  case sessionNotTerminal
  case storageFailure(String)

  var code: String {
    switch self {
    case .invalidIdentifier:
      return "ERR_DURABLE_RECORDER_INVALID_IDENTIFIER"
    case .invalidLectureId:
      return "ERR_DURABLE_RECORDER_INVALID_LECTURE_ID"
    case .sessionNotFound:
      return "ERR_DURABLE_RECORDER_SESSION_NOT_FOUND"
    case .invalidTransition:
      return "ERR_DURABLE_RECORDER_INVALID_TRANSITION"
    case .terminalState:
      return "ERR_DURABLE_RECORDER_TERMINAL_STATE"
    case .unsupportedSchemaVersion:
      return "ERR_DURABLE_RECORDER_UNSUPPORTED_SCHEMA"
    case .invalidMetadata:
      return "ERR_DURABLE_RECORDER_INVALID_METADATA"
    case .sessionNotTerminal:
      return "ERR_DURABLE_RECORDER_SESSION_NOT_TERMINAL"
    case .storageFailure:
      return "ERR_DURABLE_RECORDER_STORAGE"
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
    case .invalidMetadata:
      return "The durable recording session metadata is invalid."
    case .sessionNotTerminal:
      return "Only terminal durable recording sessions can be deleted."
    case let .storageFailure(reason):
      return "Durable recording storage failed: \(reason)"
    }
  }
}
