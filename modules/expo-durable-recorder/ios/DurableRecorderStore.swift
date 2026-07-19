import Foundation

final class DurableRecorderStore {
  typealias Clock = () -> Date
  typealias IdentifierFactory = () -> String

  private let fileManager: FileManager
  private let sessionsRootURL: URL
  private let clock: Clock
  private let makeIdentifier: IdentifierFactory
  private let lock = NSLock()
  private let encoder: JSONEncoder
  private let decoder = JSONDecoder()

  convenience init() throws {
    let applicationSupport = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let root = applicationSupport
      .appendingPathComponent("YoumiLens", isDirectory: true)
      .appendingPathComponent("DurableRecorder", isDirectory: true)
    try self.init(rootURL: root)
  }

  init(
    rootURL: URL,
    fileManager: FileManager = .default,
    clock: @escaping Clock = Date.init,
    makeIdentifier: @escaping IdentifierFactory = { UUID().uuidString.lowercased() }
  ) throws {
    self.fileManager = fileManager
    sessionsRootURL = rootURL.appendingPathComponent("sessions", isDirectory: true)
    self.clock = clock
    self.makeIdentifier = makeIdentifier
    encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]

    do {
      try fileManager.createDirectory(at: sessionsRootURL, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var recorderRoot = rootURL
      try? recorderRoot.setResourceValues(values)
    } catch {
      throw DurableRecorderCoreError.storageFailure(error.localizedDescription)
    }
  }

  func createSession(lectureId: String) throws -> DurableRecordingSession {
    try synchronized {
      let normalizedLectureId = lectureId.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !normalizedLectureId.isEmpty, normalizedLectureId.count <= 256 else {
        throw DurableRecorderCoreError.invalidLectureId
      }

      var sessionId: String?
      for _ in 0..<10 {
        let candidate = makeIdentifier()
        guard Self.canonicalIdentifier(candidate) != nil else {
          throw DurableRecorderCoreError.invalidIdentifier
        }
        if !fileManager.fileExists(atPath: sessionURL(forCanonicalIdentifier: candidate).path) {
          sessionId = candidate
          break
        }
      }
      guard let sessionId else {
        throw DurableRecorderCoreError.storageFailure("Unable to allocate a unique session identifier.")
      }

      let sessionURL = sessionURL(forCanonicalIdentifier: sessionId)
      let timestamp = Self.timestamp(clock())
      let session = DurableRecordingSession(
        schemaVersion: durableRecorderSchemaVersion,
        recordingSessionId: sessionId,
        lectureId: normalizedLectureId,
        state: .created,
        createdAt: timestamp,
        updatedAt: timestamp,
        relativeSessionPath: "sessions/\(sessionId)",
        recoverable: true,
        finalized: false,
        failureCode: nil,
        failureMessage: nil,
        segments: []
      )

      do {
        try fileManager.createDirectory(at: sessionURL, withIntermediateDirectories: false)
        try fileManager.createDirectory(
          at: sessionURL.appendingPathComponent("segments", isDirectory: true),
          withIntermediateDirectories: false
        )
        try write(session)
        return session
      } catch {
        try? fileManager.removeItem(at: sessionURL)
        if let durableError = error as? DurableRecorderCoreError {
          throw durableError
        }
        throw DurableRecorderCoreError.storageFailure(error.localizedDescription)
      }
    }
  }

  func getSession(recordingSessionId: String) throws -> DurableRecordingSession {
    try synchronized {
      let canonical = try requireCanonicalIdentifier(recordingSessionId)
      return try readSession(canonicalIdentifier: canonical)
    }
  }

  func listRecoverableSessions() throws -> [DurableRecordingSession] {
    try synchronized {
      let entries: [URL]
      do {
        entries = try fileManager.contentsOfDirectory(
          at: sessionsRootURL,
          includingPropertiesForKeys: [.isDirectoryKey],
          options: [.skipsHiddenFiles]
        )
      } catch CocoaError.fileReadNoSuchFile {
        return []
      } catch {
        throw DurableRecorderCoreError.storageFailure(error.localizedDescription)
      }

      return entries.compactMap { entry in
        guard let canonical = Self.canonicalIdentifier(entry.lastPathComponent) else {
          return nil
        }
        guard let session = try? readSession(canonicalIdentifier: canonical) else {
          return nil
        }
        return session.recoverable && !session.state.isTerminal ? session : nil
      }.sorted { lhs, rhs in
        if lhs.updatedAt != rhs.updatedAt {
          return lhs.updatedAt > rhs.updatedAt
        }
        return lhs.recordingSessionId < rhs.recordingSessionId
      }
    }
  }

  func transitionSession(
    recordingSessionId: String,
    to target: DurableRecordingState,
    failureCode: String? = nil,
    failureMessage: String? = nil
  ) throws -> DurableRecordingSession {
    try synchronized {
      let canonical = try requireCanonicalIdentifier(recordingSessionId)
      var session = try readSession(canonicalIdentifier: canonical)
      if session.state == target {
        return session
      }
      guard !session.state.isTerminal else {
        throw DurableRecorderCoreError.terminalState(session.state)
      }
      guard session.state.allowsTransition(to: target) else {
        throw DurableRecorderCoreError.invalidTransition(from: session.state, to: target)
      }
      session.apply(
        state: target,
        updatedAt: Self.timestamp(clock()),
        failureCode: failureCode,
        failureMessage: failureMessage
      )
      try write(session)
      return session
    }
  }

  func finalizeSession(recordingSessionId: String) throws -> DurableRecordingSession {
    try synchronized {
      let canonical = try requireCanonicalIdentifier(recordingSessionId)
      var session = try readSession(canonicalIdentifier: canonical)
      if session.state == .finalized {
        return session
      }
      guard !session.state.isTerminal else {
        throw DurableRecorderCoreError.terminalState(session.state)
      }
      guard session.state == .finalizing else {
        throw DurableRecorderCoreError.invalidTransition(from: session.state, to: .finalized)
      }
      session.apply(state: .finalized, updatedAt: Self.timestamp(clock()))
      try write(session)
      return session
    }
  }

  func abandonSession(recordingSessionId: String) throws -> DurableRecordingSession {
    try synchronized {
      let canonical = try requireCanonicalIdentifier(recordingSessionId)
      var session = try readSession(canonicalIdentifier: canonical)
      if session.state == .abandoned {
        return session
      }
      guard !session.state.isTerminal else {
        throw DurableRecorderCoreError.terminalState(session.state)
      }
      guard session.state.allowsTransition(to: .abandoned) else {
        throw DurableRecorderCoreError.invalidTransition(from: session.state, to: .abandoned)
      }
      session.apply(state: .abandoned, updatedAt: Self.timestamp(clock()))
      try write(session)
      return session
    }
  }

  func deleteSession(recordingSessionId: String) throws -> Bool {
    try synchronized {
      let canonical = try requireCanonicalIdentifier(recordingSessionId)
      let sessionURL = sessionURL(forCanonicalIdentifier: canonical)
      guard fileManager.fileExists(atPath: sessionURL.path) else {
        return false
      }
      let session = try readSession(canonicalIdentifier: canonical)
      guard session.state.isTerminal else {
        throw DurableRecorderCoreError.sessionNotTerminal
      }
      do {
        try fileManager.removeItem(at: sessionURL)
        return true
      } catch {
        throw DurableRecorderCoreError.storageFailure(error.localizedDescription)
      }
    }
  }

  private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try operation()
  }

  private func write(_ session: DurableRecordingSession) throws {
    do {
      let data = try encoder.encode(session)
      let metadataURL = sessionURL(forCanonicalIdentifier: session.recordingSessionId)
        .appendingPathComponent("session.json", isDirectory: false)
      try data.write(to: metadataURL, options: .atomic)
    } catch {
      if let durableError = error as? DurableRecorderCoreError {
        throw durableError
      }
      throw DurableRecorderCoreError.storageFailure(error.localizedDescription)
    }
  }

  private func readSession(canonicalIdentifier: String) throws -> DurableRecordingSession {
    let metadataURL = sessionURL(forCanonicalIdentifier: canonicalIdentifier)
      .appendingPathComponent("session.json", isDirectory: false)
    guard fileManager.fileExists(atPath: metadataURL.path) else {
      throw DurableRecorderCoreError.sessionNotFound
    }
    do {
      let data = try Data(contentsOf: metadataURL)
      let session = try decoder.decode(DurableRecordingSession.self, from: data)
      guard session.schemaVersion == durableRecorderSchemaVersion else {
        throw DurableRecorderCoreError.unsupportedSchemaVersion(session.schemaVersion)
      }
      guard session.recordingSessionId == canonicalIdentifier,
            session.relativeSessionPath == "sessions/\(canonicalIdentifier)",
            session.recoverable == !session.state.isTerminal,
            session.finalized == (session.state == .finalized) else {
        throw DurableRecorderCoreError.invalidMetadata
      }
      return session
    } catch let error as DurableRecorderCoreError {
      throw error
    } catch is DecodingError {
      throw DurableRecorderCoreError.invalidMetadata
    } catch {
      throw DurableRecorderCoreError.storageFailure(error.localizedDescription)
    }
  }

  private func requireCanonicalIdentifier(_ rawIdentifier: String) throws -> String {
    guard let canonical = Self.canonicalIdentifier(rawIdentifier) else {
      throw DurableRecorderCoreError.invalidIdentifier
    }
    return canonical
  }

  private func sessionURL(forCanonicalIdentifier identifier: String) -> URL {
    sessionsRootURL.appendingPathComponent(identifier, isDirectory: true)
  }

  private static func canonicalIdentifier(_ rawIdentifier: String) -> String? {
    let canonical = UUID(uuidString: rawIdentifier)?.uuidString.lowercased()
    return canonical == rawIdentifier ? canonical : nil
  }

  private static func timestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }
}
