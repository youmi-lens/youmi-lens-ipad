import Foundation

private struct TestFailure: Error, CustomStringConvertible {
  let description: String
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() {
    throw TestFailure(description: message)
  }
}

private final class TestClock {
  private var tick: TimeInterval = 0

  func now() -> Date {
    defer { tick += 1 }
    return Date(timeIntervalSince1970: 1_700_000_000 + tick)
  }
}

private let pathsToState: [DurableRecordingState: [DurableRecordingState]] = [
  .created: [],
  .preparing: [.preparing],
  .ready: [.preparing, .ready],
  .recording: [.preparing, .ready, .recording],
  .paused: [.preparing, .ready, .recording, .paused],
  .finalizing: [.preparing, .ready, .recording, .finalizing],
  .finalized: [.preparing, .ready, .recording, .finalizing, .finalized],
  .failed: [.preparing, .failed],
  .abandoned: [.preparing, .ready, .abandoned]
]

private func makeRoot(_ label: String) -> URL {
  FileManager.default.temporaryDirectory
    .appendingPathComponent("durable-recorder-tests-\(label)-\(UUID().uuidString.lowercased())", isDirectory: true)
}

private func makeStore(root: URL, identifiers: [String]? = nil) throws -> DurableRecorderStore {
  let clock = TestClock()
  var identifierIndex = 0
  return try DurableRecorderStore(
    rootURL: root,
    clock: { clock.now() },
    makeIdentifier: {
      if let identifiers, identifierIndex < identifiers.count {
        defer { identifierIndex += 1 }
        return identifiers[identifierIndex]
      }
      return UUID().uuidString.lowercased()
    }
  )
}

@discardableResult
private func advance(
  _ store: DurableRecorderStore,
  sessionId: String,
  to target: DurableRecordingState
) throws -> DurableRecordingSession {
  var session = try store.getSession(recordingSessionId: sessionId)
  for state in pathsToState[target] ?? [] {
    session = try store.transitionSession(
      recordingSessionId: sessionId,
      to: state,
      failureCode: state == .failed ? "test_failure" : nil,
      failureMessage: state == .failed ? "Expected test failure" : nil
    )
  }
  return session
}

private func testTransitionTable() throws {
  let allowed: [(DurableRecordingState, DurableRecordingState)] = [
    (.created, .preparing),
    (.preparing, .ready),
    (.preparing, .failed),
    (.ready, .recording),
    (.ready, .abandoned),
    (.recording, .paused),
    (.recording, .finalizing),
    (.recording, .failed),
    (.paused, .recording),
    (.paused, .finalizing),
    (.paused, .abandoned),
    (.paused, .failed),
    (.finalizing, .finalized),
    (.finalizing, .failed)
  ]

  for (source, target) in allowed {
    let root = makeRoot("allowed-\(source.rawValue)-\(target.rawValue)")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try makeStore(root: root)
    let created = try store.createSession(lectureId: "lecture-allowed")
    _ = try advance(store, sessionId: created.recordingSessionId, to: source)
    let transitioned = try store.transitionSession(
      recordingSessionId: created.recordingSessionId,
      to: target,
      failureCode: target == .failed ? "expected" : nil
    )
    try expect(transitioned.state == target, "Allowed transition \(source.rawValue) -> \(target.rawValue) failed")
  }

  for source in DurableRecordingState.allCases {
    for target in DurableRecordingState.allCases where target != source && !source.allowsTransition(to: target) {
      let root = makeRoot("forbidden-\(source.rawValue)-\(target.rawValue)")
      defer { try? FileManager.default.removeItem(at: root) }
      let store = try makeStore(root: root)
      let created = try store.createSession(lectureId: "lecture-forbidden")
      _ = try advance(store, sessionId: created.recordingSessionId, to: source)
      do {
        _ = try store.transitionSession(recordingSessionId: created.recordingSessionId, to: target)
        throw TestFailure(description: "Forbidden transition \(source.rawValue) -> \(target.rawValue) succeeded")
      } catch is TestFailure {
        throw TestFailure(description: "Forbidden transition \(source.rawValue) -> \(target.rawValue) succeeded")
      } catch let error as DurableRecorderCoreError {
        switch error {
        case .invalidTransition, .terminalState:
          break
        default:
          throw TestFailure(description: "Forbidden transition returned the wrong error: \(error)")
        }
      }
    }
  }
}

private func testStorageRecoveryAndIdempotency() throws {
  let root = makeRoot("storage")
  defer { try? FileManager.default.removeItem(at: root) }
  let firstId = "11111111-1111-4111-8111-111111111111"
  let secondId = "22222222-2222-4222-8222-222222222222"
  let store = try makeStore(root: root, identifiers: [firstId, secondId])

  let first = try store.createSession(lectureId: "lecture-one")
  let second = try store.createSession(lectureId: "lecture-two")
  try expect(first.recordingSessionId != second.recordingSessionId, "Session identifiers must be unique")
  try expect(first.relativeSessionPath == "sessions/\(firstId)", "Session path must be relative and deterministic")
  try expect(first.schemaVersion == 1 && first.segments.isEmpty, "Metadata schema or segment placeholder is invalid")

  let firstDirectory = root.appendingPathComponent(first.relativeSessionPath, isDirectory: true)
  let secondDirectory = root.appendingPathComponent(second.relativeSessionPath, isDirectory: true)
  try expect(firstDirectory != secondDirectory, "Sessions must use isolated directories")
  try expect(FileManager.default.fileExists(atPath: firstDirectory.appendingPathComponent("segments").path), "Segments placeholder directory is missing")
  try expect(FileManager.default.fileExists(atPath: firstDirectory.appendingPathComponent("session.json").path), "Metadata file is missing")

  _ = try store.transitionSession(recordingSessionId: firstId, to: .preparing)
  _ = try store.transitionSession(recordingSessionId: firstId, to: .ready)
  _ = try store.transitionSession(recordingSessionId: firstId, to: .recording)
  _ = try store.transitionSession(recordingSessionId: firstId, to: .finalizing)
  let finalized = try store.finalizeSession(recordingSessionId: firstId)
  let repeatedFinalize = try store.finalizeSession(recordingSessionId: firstId)
  try expect(finalized == repeatedFinalize && finalized.finalized, "Finalize must be idempotent")

  _ = try store.transitionSession(recordingSessionId: secondId, to: .preparing)
  _ = try store.transitionSession(recordingSessionId: secondId, to: .ready)
  let abandoned = try store.abandonSession(recordingSessionId: secondId)
  let repeatedAbandon = try store.abandonSession(recordingSessionId: secondId)
  try expect(abandoned == repeatedAbandon && abandoned.state == .abandoned, "Abandon must be idempotent")

  let restartedStore = try DurableRecorderStore(rootURL: root)
  let restartedFinalized = try restartedStore.getSession(recordingSessionId: firstId)
  let restartedRecoverable = try restartedStore.listRecoverableSessions()
  try expect(restartedFinalized == finalized, "Metadata must survive store recreation")
  try expect(restartedRecoverable.isEmpty, "Terminal sessions cannot be recoverable")

  let firstDeletion = try restartedStore.deleteSession(recordingSessionId: firstId)
  let repeatedDeletion = try restartedStore.deleteSession(recordingSessionId: firstId)
  try expect(firstDeletion, "Terminal session deletion must succeed")
  try expect(!repeatedDeletion, "Repeated deletion must return false")
}

private func testRecoveryFilteringAndMalformedMetadata() throws {
  let root = makeRoot("recovery")
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try makeStore(root: root)
  let initiallyRecoverable = try store.listRecoverableSessions()
  try expect(initiallyRecoverable.isEmpty, "A new storage root must have an empty recovery list")
  let olderRecoverable = try store.createSession(lectureId: "lecture-recoverable-older")
  let newerRecoverable = try store.createSession(lectureId: "lecture-recoverable-newer")
  let failed = try store.createSession(lectureId: "lecture-failed")
  _ = try store.transitionSession(recordingSessionId: failed.recordingSessionId, to: .preparing)
  _ = try store.transitionSession(recordingSessionId: failed.recordingSessionId, to: .failed)

  let malformedId = "33333333-3333-4333-8333-333333333333"
  let unknownSchemaId = "44444444-4444-4444-8444-444444444444"
  let missingFieldId = "55555555-5555-4555-8555-555555555555"
  let sessionsRoot = root.appendingPathComponent("sessions", isDirectory: true)
  let malformedDirectory = sessionsRoot.appendingPathComponent(malformedId, isDirectory: true)
  let unknownDirectory = sessionsRoot.appendingPathComponent(unknownSchemaId, isDirectory: true)
  let missingFieldDirectory = sessionsRoot.appendingPathComponent(missingFieldId, isDirectory: true)
  try Data("unrelated".utf8).write(to: sessionsRoot.appendingPathComponent("unrelated.txt"))
  try FileManager.default.createDirectory(at: malformedDirectory, withIntermediateDirectories: true)
  try Data("{malformed".utf8).write(to: malformedDirectory.appendingPathComponent("session.json"))
  try FileManager.default.createDirectory(at: unknownDirectory, withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: missingFieldDirectory, withIntermediateDirectories: true)

  let validData = try Data(contentsOf: sessionsRoot
    .appendingPathComponent(olderRecoverable.recordingSessionId, isDirectory: true)
    .appendingPathComponent("session.json"))
  var unknown = try JSONSerialization.jsonObject(with: validData) as! [String: Any]
  unknown["schemaVersion"] = 999
  unknown["recordingSessionId"] = unknownSchemaId
  unknown["relativeSessionPath"] = "sessions/\(unknownSchemaId)"
  try JSONSerialization.data(withJSONObject: unknown).write(
    to: unknownDirectory.appendingPathComponent("session.json"),
    options: .atomic
  )

  var missingField = try JSONSerialization.jsonObject(with: validData) as! [String: Any]
  missingField.removeValue(forKey: "lectureId")
  missingField["recordingSessionId"] = missingFieldId
  missingField["relativeSessionPath"] = "sessions/\(missingFieldId)"
  try JSONSerialization.data(withJSONObject: missingField).write(
    to: missingFieldDirectory.appendingPathComponent("session.json"),
    options: .atomic
  )

  let restartedStore = try DurableRecorderStore(rootURL: root)
  let recovered = try restartedStore.listRecoverableSessions()
  try expect(
    recovered.map(\.recordingSessionId) == [newerRecoverable.recordingSessionId, olderRecoverable.recordingSessionId],
    "Recovery must survive restart, sort deterministically, and ignore terminal or malformed sessions"
  )
}

private func testDeletionBoundary() throws {
  let root = makeRoot("delete")
  defer { try? FileManager.default.removeItem(at: root) }
  let store = try makeStore(root: root)
  let session = try store.createSession(lectureId: "lecture-delete")
  let sentinel = root.deletingLastPathComponent().appendingPathComponent("durable-recorder-sentinel-\(UUID().uuidString)")
  try Data("keep".utf8).write(to: sentinel)
  defer { try? FileManager.default.removeItem(at: sentinel) }

  do {
    _ = try store.deleteSession(recordingSessionId: "../../\(sentinel.lastPathComponent)")
    throw TestFailure(description: "Path traversal deletion unexpectedly succeeded")
  } catch is TestFailure {
    throw TestFailure(description: "Path traversal deletion unexpectedly succeeded")
  } catch let error as DurableRecorderCoreError {
    try expect(error == .invalidIdentifier, "Path traversal must return invalid identifier")
  }
  try expect(FileManager.default.fileExists(atPath: sentinel.path), "Deletion escaped the recorder root")

  do {
    _ = try store.deleteSession(recordingSessionId: session.recordingSessionId)
    throw TestFailure(description: "Non-terminal deletion unexpectedly succeeded")
  } catch is TestFailure {
    throw TestFailure(description: "Non-terminal deletion unexpectedly succeeded")
  } catch let error as DurableRecorderCoreError {
    try expect(error == .sessionNotTerminal, "Non-terminal deletion returned the wrong error")
  }
}

@main
private enum DurableRecorderCoreTestRunner {
  static func main() throws {
    try testTransitionTable()
    try testStorageRecoveryAndIdempotency()
    try testRecoveryFilteringAndMalformedMetadata()
    try testDeletionBoundary()
    print("Durable recorder native session core tests passed.")
  }
}
