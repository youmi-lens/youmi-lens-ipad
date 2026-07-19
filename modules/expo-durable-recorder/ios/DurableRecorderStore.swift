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

  func createSegmentPlan(recordingSessionId: String) throws -> DurableSegmentPlan {
    try synchronized {
      let canonical = try requireCanonicalIdentifier(recordingSessionId)
      let session = try readSession(canonicalIdentifier: canonical)
      guard !session.state.isTerminal else {
        throw DurableRecorderCoreError.terminalState(session.state)
      }
      let sequence = (session.segments.map(\.sequence).max() ?? 0) + 1
      let createdAt = Self.timestamp(clock())

      for _ in 0..<10 {
        let segmentId = UUID().uuidString.lowercased()
        let prefix = String(format: "%06d-%@", sequence, segmentId)
        let activeRelativePath = "segments/\(prefix).partial.m4a"
        let finalizedRelativePath = "segments/\(prefix).m4a"
        let activeURL = sessionURL(forCanonicalIdentifier: canonical)
          .appendingPathComponent(activeRelativePath, isDirectory: false)
        let finalizedURL = sessionURL(forCanonicalIdentifier: canonical)
          .appendingPathComponent(finalizedRelativePath, isDirectory: false)
        if !fileManager.fileExists(atPath: activeURL.path),
           !fileManager.fileExists(atPath: finalizedURL.path) {
          return DurableSegmentPlan(
            segmentId: segmentId,
            sequence: sequence,
            createdAt: createdAt,
            activeRelativePath: activeRelativePath,
            finalizedRelativePath: finalizedRelativePath,
            activeURL: activeURL,
            finalizedURL: finalizedURL
          )
        }
      }
      throw DurableRecorderCoreError.segmentCollision
    }
  }

  func commitSegment(
    recordingSessionId: String,
    plan: DurableSegmentPlan,
    inspection: DurableAudioFileInspection,
    interruptionReason: String? = nil,
    routeAtStart: String? = nil,
    routeAtEnd: String? = nil,
    recoveredAfterRestart: Bool? = nil
  ) throws -> DurableRecordingSession {
    try synchronized {
      let canonical = try requireCanonicalIdentifier(recordingSessionId)
      var session = try readSession(canonicalIdentifier: canonical)
      guard !session.state.isTerminal else {
        throw DurableRecorderCoreError.terminalState(session.state)
      }
      guard inspection.durationMs > 0, inspection.byteLength > 0,
            inspection.sampleRate > 0, inspection.channelCount > 0 else {
        throw DurableRecorderCoreError.segmentValidationFailed("The audio asset has no readable media duration.")
      }
      guard plan.sequence == (session.segments.map(\.sequence).max() ?? 0) + 1,
            Self.canonicalIdentifier(plan.segmentId) == plan.segmentId,
            plan.finalizedRelativePath == Self.finalizedRelativePath(
              sequence: plan.sequence,
              segmentId: plan.segmentId
            ),
            plan.activeRelativePath == Self.activeRelativePath(
              sequence: plan.sequence,
              segmentId: plan.segmentId
            ) else {
        throw DurableRecorderCoreError.invalidMetadata
      }
      guard !session.segments.contains(where: {
        $0.segmentId == plan.segmentId || $0.sequence == plan.sequence || $0.relativePath == plan.finalizedRelativePath
      }) else {
        throw DurableRecorderCoreError.segmentCollision
      }
      guard fileManager.fileExists(atPath: plan.activeURL.path),
            !fileManager.fileExists(atPath: plan.finalizedURL.path) else {
        throw DurableRecorderCoreError.segmentCollision
      }

      do {
        try fileManager.moveItem(at: plan.activeURL, to: plan.finalizedURL)
      } catch {
        throw DurableRecorderCoreError.storageFailure(error.localizedDescription)
      }

      let finalizedAt = Self.timestamp(clock())
      session.segments.append(DurableRecordingSegmentMetadata(
        schemaVersion: durableRecorderSegmentSchemaVersion,
        segmentId: plan.segmentId,
        sequence: plan.sequence,
        relativePath: plan.finalizedRelativePath,
        createdAt: plan.createdAt,
        finalizedAt: finalizedAt,
        durationMs: inspection.durationMs,
        byteLength: inspection.byteLength,
        container: "m4a",
        codec: "aac",
        sampleRate: inspection.sampleRate,
        channelCount: inspection.channelCount,
        integrityStatus: "validated",
        interruptionReason: interruptionReason,
        routeAtStart: routeAtStart,
        routeAtEnd: routeAtEnd,
        recoveredAfterRestart: recoveredAfterRestart
      ))
      session.updatedAt = finalizedAt
      try write(session)
      return session
    }
  }

  func reconcileSession(
    recordingSessionId: String,
    inspectAudioFile: (URL) -> Bool
  ) throws -> DurableRecoveryResult {
    try synchronized {
      let canonical = try requireCanonicalIdentifier(recordingSessionId)
      let session = try readSession(canonicalIdentifier: canonical)
      let sessionDirectory = sessionURL(forCanonicalIdentifier: canonical)
      let segmentsDirectory = sessionDirectory.appendingPathComponent("segments", isDirectory: true)
      let referenced = Set(session.segments.map(\.relativePath))
      var issues: [DurableRecoveryIssue] = []

      for segment in session.segments {
        let url = sessionDirectory.appendingPathComponent(segment.relativePath, isDirectory: false)
        guard fileManager.fileExists(atPath: url.path) else {
          issues.append(DurableRecoveryIssue(
            code: "missing_referenced_file",
            relativePath: segment.relativePath,
            segmentId: segment.segmentId
          ))
          continue
        }
        if !inspectAudioFile(url) {
          issues.append(DurableRecoveryIssue(
            code: "invalid_referenced_file",
            relativePath: segment.relativePath,
            segmentId: segment.segmentId
          ))
        }
      }

      let entries = (try? fileManager.contentsOfDirectory(
        at: segmentsDirectory,
        includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
        options: [.skipsHiddenFiles]
      )) ?? []
      for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
        let relativePath = "segments/\(entry.lastPathComponent)"
        if entry.lastPathComponent.hasSuffix(".partial.m4a") {
          issues.append(DurableRecoveryIssue(
            code: "incomplete_temporary_file",
            relativePath: relativePath,
            segmentId: Self.segmentId(fromFileName: entry.lastPathComponent)
          ))
          continue
        }
        if Self.isFinalizedSegmentFileName(entry.lastPathComponent) {
          if !referenced.contains(relativePath) {
            issues.append(DurableRecoveryIssue(
              code: inspectAudioFile(entry) ? "orphan_finalized_file" : "invalid_orphan_file",
              relativePath: relativePath,
              segmentId: Self.segmentId(fromFileName: entry.lastPathComponent)
            ))
          }
          continue
        }
        issues.append(DurableRecoveryIssue(
          code: "unsupported_segment_format",
          relativePath: relativePath,
          segmentId: nil
        ))
      }
      return DurableRecoveryResult(session: session, issues: issues)
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
            session.finalized == (session.state == .finalized),
            try Self.segmentsAreValid(session.segments) else {
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

  private static func finalizedRelativePath(sequence: Int, segmentId: String) -> String {
    String(format: "segments/%06d-%@.m4a", sequence, segmentId)
  }

  private static func activeRelativePath(sequence: Int, segmentId: String) -> String {
    String(format: "segments/%06d-%@.partial.m4a", sequence, segmentId)
  }

  private static func segmentsAreValid(_ segments: [DurableRecordingSegmentMetadata]) throws -> Bool {
    var identifiers = Set<String>()
    var sequences = Set<Int>()
    var paths = Set<String>()
    var previousSequence = 0
    for segment in segments {
      guard segment.schemaVersion == durableRecorderSegmentSchemaVersion else {
        throw DurableRecorderCoreError.unsupportedSegmentSchemaVersion(segment.schemaVersion)
      }
      guard canonicalIdentifier(segment.segmentId) == segment.segmentId,
            segment.sequence > previousSequence,
            segment.relativePath == finalizedRelativePath(
              sequence: segment.sequence,
              segmentId: segment.segmentId
            ),
            segment.durationMs > 0,
            segment.byteLength > 0,
            segment.container == "m4a",
            segment.codec == "aac",
            segment.sampleRate > 0,
            segment.channelCount > 0,
            segment.integrityStatus == "validated",
            identifiers.insert(segment.segmentId).inserted,
            sequences.insert(segment.sequence).inserted,
            paths.insert(segment.relativePath).inserted else {
        return false
      }
      previousSequence = segment.sequence
    }
    return true
  }

  private static func isFinalizedSegmentFileName(_ fileName: String) -> Bool {
    guard fileName.count == 47, fileName.hasSuffix(".m4a") else { return false }
    let prefix = String(fileName.prefix(6))
    guard Int(prefix) != nil, fileName[fileName.index(fileName.startIndex, offsetBy: 6)] == "-" else {
      return false
    }
    return segmentId(fromFileName: fileName) != nil
  }

  private static func segmentId(fromFileName fileName: String) -> String? {
    guard fileName.count >= 43 else { return nil }
    let start = fileName.index(fileName.startIndex, offsetBy: 7)
    let end = fileName.index(start, offsetBy: 36)
    let candidate = String(fileName[start..<end])
    return canonicalIdentifier(candidate)
  }

  private static func timestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
  }
}
