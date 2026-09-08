import AVFoundation
import Foundation

/// Recovers a legacy-resume lecture that is blocked behind
/// `audioAssemblyStatus === 'required'`: two (or more) separately-preserved
/// legacy `expo-audio` recordings that were never assembled into one
/// uploadable file.
///
/// This is deliberately a SEPARATE workspace from `DurableRecorderStore` —
/// legacy lectures never touched the native durable recorder's own session
/// state machine, and forcing them into that model would risk destabilizing
/// the accepted durable-recorder architecture for no benefit. What IS
/// shared is the actual AVFoundation composition primitive
/// (`AudioSegmentComposer`, extracted from `DurableFinalAssetExporter`) and
/// the audio-file verification primitive (`DurableAudioFileInspecting`) —
/// the only two pieces of genuinely reusable, fragile AVFoundation logic.
///
/// Every step is restart-safe: sources are copied (never moved) into a
/// durable workspace before anything else happens, composition always
/// starts from a freshly-discarded temp file (an interrupted export is
/// never trusted), and the final asset is only ever promoted via an atomic
/// rename that is itself idempotent (a second attempt after a crash simply
/// finds the final file already present and returns it, cheaply, without
/// redoing any work). Inputs are never deleted or overwritten at any step.
enum LegacyAudioAssemblyError: Error {
  case invalidLectureId
  case invalidSourceList
  case noSources
  case sourceMissing(String)
  case metadataMissing
  case sourceCopyFailed(String)
  case sourceValidationFailed(String)
  case compositionFailed(String)
  case verificationFailed(String)
  case storageFailure(String)

  var code: String {
    switch self {
    case .invalidLectureId: return "ERR_LEGACY_AUDIO_ASSEMBLY_INVALID_LECTURE_ID"
    case .invalidSourceList: return "ERR_LEGACY_AUDIO_ASSEMBLY_INVALID_SOURCE_LIST"
    case .noSources: return "ERR_LEGACY_AUDIO_ASSEMBLY_NO_SOURCES"
    case .sourceMissing: return "ERR_LEGACY_AUDIO_ASSEMBLY_SOURCE_MISSING"
    case .metadataMissing: return "ERR_LEGACY_AUDIO_ASSEMBLY_METADATA_MISSING"
    case .sourceCopyFailed: return "ERR_LEGACY_AUDIO_ASSEMBLY_SOURCE_COPY_FAILED"
    case .sourceValidationFailed: return "ERR_LEGACY_AUDIO_ASSEMBLY_SOURCE_VALIDATION_FAILED"
    case .compositionFailed: return "ERR_LEGACY_AUDIO_ASSEMBLY_COMPOSITION_FAILED"
    case .verificationFailed: return "ERR_LEGACY_AUDIO_ASSEMBLY_VERIFICATION_FAILED"
    case .storageFailure: return "ERR_LEGACY_AUDIO_ASSEMBLY_STORAGE"
    }
  }

  var message: String {
    switch self {
    case .invalidLectureId:
      return "The lecture identifier is invalid."
    case .invalidSourceList:
      return "The provided audio source list is invalid."
    case .noSources:
      return "No audio sources were provided to assemble."
    case let .sourceMissing(uri):
      return "A required audio source is missing: \(uri)"
    case .metadataMissing:
      return "No preserved sources were found for this lecture. Preservation must run before composition."
    case let .sourceCopyFailed(reason):
      return "A source segment could not be preserved: \(reason)"
    case let .sourceValidationFailed(reason):
      return "A source segment failed validation: \(reason)"
    case let .compositionFailed(reason):
      return "The assembled audio could not be created: \(reason)"
    case let .verificationFailed(reason):
      return "The assembled audio failed verification: \(reason)"
    case let .storageFailure(reason):
      return "Legacy audio assembly storage failed: \(reason)"
    }
  }
}

struct LegacyAudioAssemblySource: Codable, Equatable {
  let role: String
  let originalURI: String
  let durableRelativePath: String
  let byteLength: Int64
  let durationMs: Int
  /// The ORIGINAL file's real modification time (epoch ms), captured at the
  /// moment it was resolved — i.e. from whichever URL (the literal
  /// persisted one, or the stale-container-rebased one) actually pointed at
  /// a real file. Used by JS-side recovery-source discovery to prove
  /// whether this source overlaps a native-durable session in real time
  /// (`estimatedStartMs = sourceModifiedAtMs - durationMs`) — the
  /// persisted `audioSegments[].createdAt` field is NOT usable for this,
  /// it holds the lecture's own `date`, not the file's real write time.
  ///
  /// Decode-tolerant: an `assembly.json` written before this field existed
  /// (a prior partial persistSources attempt, still `sourcesPersisted`, not
  /// yet composed) must still decode — defaults to 0 ("unknown") rather
  /// than failing the whole read.
  let sourceModifiedAtMs: Int64

  init(role: String, originalURI: String, durableRelativePath: String, byteLength: Int64, durationMs: Int, sourceModifiedAtMs: Int64) {
    self.role = role
    self.originalURI = originalURI
    self.durableRelativePath = durableRelativePath
    self.byteLength = byteLength
    self.durationMs = durationMs
    self.sourceModifiedAtMs = sourceModifiedAtMs
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    role = try container.decode(String.self, forKey: .role)
    originalURI = try container.decode(String.self, forKey: .originalURI)
    durableRelativePath = try container.decode(String.self, forKey: .durableRelativePath)
    byteLength = try container.decode(Int64.self, forKey: .byteLength)
    durationMs = try container.decode(Int.self, forKey: .durationMs)
    sourceModifiedAtMs = try container.decodeIfPresent(Int64.self, forKey: .sourceModifiedAtMs) ?? 0
  }
}

enum LegacyAudioAssemblyState: String, Codable {
  case sourcesPersisted
  case completed
}

struct LegacyAudioAssemblyMetadata: Codable {
  let schemaVersion: Int
  let lectureId: String
  var sources: [LegacyAudioAssemblySource]
  var state: LegacyAudioAssemblyState
  var updatedAt: String
  var finalRelativePath: String?
  var finalDurationMs: Int?
  var finalByteLength: Int64?
  /// Deterministic fingerprint of the ORDERED (role, uri) source list that
  /// `sources`/the final asset were (or are about to be) built from. This is
  /// what makes the "already completed, reuse it" shortcuts below safe: a
  /// lectureId's workspace can be revisited later with a COMPLETELY
  /// DIFFERENT requested source set (general media reconciliation
  /// discovering a durable session a first, legacy-only pass never knew
  /// about) — see this file's header. Keying reuse on lectureId/state alone
  /// would silently hand back an unrelated stale asset for the new request.
  ///
  /// Decode-tolerant: an assembly.json written before this field existed
  /// decodes to "" — a value no real request's fingerprint can equal — so
  /// an old completed workspace is correctly treated as NOT matching any
  /// new request (never reused, never crashes on decode) rather than
  /// spuriously matching an empty/absent comparison.
  var sourceFingerprint: String

  init(
    schemaVersion: Int,
    lectureId: String,
    sources: [LegacyAudioAssemblySource],
    state: LegacyAudioAssemblyState,
    updatedAt: String,
    finalRelativePath: String? = nil,
    finalDurationMs: Int? = nil,
    finalByteLength: Int64? = nil,
    sourceFingerprint: String
  ) {
    self.schemaVersion = schemaVersion
    self.lectureId = lectureId
    self.sources = sources
    self.state = state
    self.updatedAt = updatedAt
    self.finalRelativePath = finalRelativePath
    self.finalDurationMs = finalDurationMs
    self.finalByteLength = finalByteLength
    self.sourceFingerprint = sourceFingerprint
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    lectureId = try container.decode(String.self, forKey: .lectureId)
    sources = try container.decode([LegacyAudioAssemblySource].self, forKey: .sources)
    state = try container.decode(LegacyAudioAssemblyState.self, forKey: .state)
    updatedAt = try container.decode(String.self, forKey: .updatedAt)
    finalRelativePath = try container.decodeIfPresent(String.self, forKey: .finalRelativePath)
    finalDurationMs = try container.decodeIfPresent(Int.self, forKey: .finalDurationMs)
    finalByteLength = try container.decodeIfPresent(Int64.self, forKey: .finalByteLength)
    sourceFingerprint = try container.decodeIfPresent(String.self, forKey: .sourceFingerprint) ?? ""
  }
}

struct LegacyAudioAssemblyResult {
  let fileUri: String
  let durationMs: Int
  let byteLength: Int64
  let sourceCount: Int
  /// The fingerprint the returned final asset actually corresponds to —
  /// always the CALLER's requested fingerprint on this code path (every
  /// return site below only returns after proving a match), included so the
  /// JS caller can independently verify it received an answer to the
  /// request it actually made, rather than trusting `ok: true` alone.
  let sourceFingerprint: String

  func asDictionary() -> [String: Any] {
    ["fileUri": fileUri, "durationMs": durationMs, "byteLength": byteLength, "sourceCount": sourceCount, "sourceFingerprint": sourceFingerprint]
  }
}

private let legacyAudioAssemblySchemaVersion = 1

final class LegacyAudioAssemblyStore {
  typealias Clock = () -> Date

  private let fileManager: FileManager
  private let rootURL: URL
  private let clock: Clock
  private let inspector: DurableAudioFileInspecting
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
      .appendingPathComponent("AudioAssembly", isDirectory: true)
    try self.init(rootURL: root)
  }

  init(
    rootURL: URL,
    fileManager: FileManager = .default,
    clock: @escaping Clock = Date.init,
    inspector: DurableAudioFileInspecting = SystemDurableAudioFileInspector()
  ) throws {
    self.fileManager = fileManager
    self.rootURL = rootURL
    self.clock = clock
    self.inspector = inspector
    encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]

    do {
      try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var mutableRoot = rootURL
      try? mutableRoot.setResourceValues(values)
    } catch {
      throw LegacyAudioAssemblyError.storageFailure(error.localizedDescription)
    }
  }

  /// Phase 2: copy every source into the durable workspace and record it in
  /// `assembly.json`. Callable on its own, as early as the moment the app
  /// first detects a legacy resume requiring assembly — BEFORE the user can
  /// leave the recording flow — so the durable copies exist independently
  /// of whatever happens afterward to the original Cache/Documents files
  /// (eviction, or an app reinstall that rotates the container UUID and
  /// invalidates every absolute URI persisted before it). Also callable
  /// again later (e.g. from `assemble`) — restart-safe and idempotent: an
  /// already-durably-copied, still-valid source is reused as-is, and only a
  /// missing or corrupt copy is redone from the original.
  func persistSources(
    lectureId: String,
    orderedSources: [(role: String, uri: String)]
  ) throws -> [LegacyAudioAssemblySource] {
    let normalizedLectureId = try Self.normalizeLectureId(lectureId)
    guard !orderedSources.isEmpty else { throw LegacyAudioAssemblyError.noSources }

    let lectureDirectory = rootURL.appendingPathComponent(normalizedLectureId, isDirectory: true)
    let sourcesDirectory = lectureDirectory.appendingPathComponent("sources", isDirectory: true)
    do {
      try fileManager.createDirectory(at: sourcesDirectory, withIntermediateDirectories: true)
    } catch {
      throw LegacyAudioAssemblyError.storageFailure(error.localizedDescription)
    }

    var persistedSources: [LegacyAudioAssemblySource] = []
    for (index, source) in orderedSources.enumerated() {
      // The legacy `expo-audio` recorder only ever returns an ABSOLUTE URI.
      // resolveExistingURL re-verifies against the CURRENT app container
      // (never assumed) before trusting a rebased path — see its own doc
      // comment for why the persisted URI's UUID can go stale.
      guard let originalURL = Self.resolveExistingURL(source.uri, fileManager: fileManager),
            fileManager.fileExists(atPath: originalURL.path) else {
        throw LegacyAudioAssemblyError.sourceMissing(source.uri)
      }
      // Captured from the ORIGINAL resolved URL, before any copy, so it
      // reflects the real file's own history rather than whatever the copy
      // operation does to timestamps.
      let sourceModifiedAtMs = Self.modificationTimeMs(of: originalURL)
      let durableRelativePath = "sources/\(index)-\(Self.sanitize(source.role)).m4a"
      let durableURL = lectureDirectory.appendingPathComponent(durableRelativePath)

      var inspection: DurableAudioFileInspection?
      if fileManager.fileExists(atPath: durableURL.path) {
        inspection = try? inspector.inspect(url: durableURL)
        if inspection == nil {
          // Present but not independently valid — an interrupted copy from
          // a prior attempt. Discard and re-copy; the original is untouched.
          try? fileManager.removeItem(at: durableURL)
        }
      }
      if inspection == nil {
        do {
          try fileManager.copyItem(at: originalURL, to: durableURL)
        } catch {
          throw LegacyAudioAssemblyError.sourceCopyFailed(error.localizedDescription)
        }
        inspection = try inspect(durableURL, context: "\(source.role) segment")
      }

      persistedSources.append(LegacyAudioAssemblySource(
        role: source.role,
        originalURI: source.uri,
        durableRelativePath: durableRelativePath,
        byteLength: inspection!.byteLength,
        durationMs: inspection!.durationMs,
        sourceModifiedAtMs: sourceModifiedAtMs
      ))
    }

    try writeMetadata(LegacyAudioAssemblyMetadata(
      schemaVersion: legacyAudioAssemblySchemaVersion,
      lectureId: normalizedLectureId,
      sources: persistedSources,
      state: .sourcesPersisted,
      updatedAt: Self.timestamp(clock()),
      sourceFingerprint: Self.sourceFingerprint(orderedSources)
    ), directory: lectureDirectory)

    return persistedSources
  }

  /// Phase 3/4: compose the ALREADY-durably-persisted sources (read from
  /// `assembly.json`, not re-derived from `orderedSources`) and verify
  /// before any promotion. Never touches the original Cache/Documents
  /// files — by this point everything it needs already lives in the
  /// durable workspace, which is the whole point of separating this from
  /// `persistSources`.
  func composeAndVerify(lectureId: String, expectedSourceCount: Int, sourceFingerprint: String) async throws -> LegacyAudioAssemblyResult {
    let normalizedLectureId = try Self.normalizeLectureId(lectureId)
    let lectureDirectory = rootURL.appendingPathComponent(normalizedLectureId, isDirectory: true)
    let finalDirectory = lectureDirectory.appendingPathComponent("final", isDirectory: true)
    let temporaryURL = finalDirectory.appendingPathComponent("lecture.exporting.m4a")
    let finalURL = finalDirectory.appendingPathComponent("lecture.m4a")

    do {
      try fileManager.createDirectory(at: finalDirectory, withIntermediateDirectories: true)
    } catch {
      throw LegacyAudioAssemblyError.storageFailure(error.localizedDescription)
    }

    let existingMetadata = try readMetadata(directory: lectureDirectory)

    // A prior call already finished with THIS EXACT ordered source set (or
    // crashed after promotion but before the caller recorded success) —
    // reuse the verified final asset rather than recomposing from scratch.
    // Keyed on the source fingerprint, never on lectureId/state alone — a
    // DIFFERENT requested source set (e.g. general media reconciliation
    // discovering a durable session a first, legacy-only pass never knew
    // about) must never silently receive a stale final built for an earlier,
    // unrelated request. This was the exact Build 50 P0 bug: a 1-durable-
    // source reconciliation request received back the old 2-legacy-source
    // 2:18 asset because reuse was keyed on "a final file exists", not on
    // whether it actually corresponds to what was asked for.
    if fileManager.fileExists(atPath: finalURL.path),
       let existingMetadata,
       existingMetadata.state == .completed,
       existingMetadata.sourceFingerprint == sourceFingerprint {
      let inspection = try inspect(finalURL, context: "the previously assembled asset")
      return LegacyAudioAssemblyResult(
        fileUri: finalURL.absoluteString,
        durationMs: inspection.durationMs,
        byteLength: inspection.byteLength,
        sourceCount: expectedSourceCount,
        sourceFingerprint: sourceFingerprint
      )
    }

    guard let metadata = try readMetadata(directory: lectureDirectory), !metadata.sources.isEmpty else {
      throw LegacyAudioAssemblyError.metadataMissing
    }
    guard metadata.sourceFingerprint == sourceFingerprint else {
      // persistSources must run again for this request before composing —
      // the persisted sources on disk answer a DIFFERENT, earlier request.
      throw LegacyAudioAssemblyError.metadataMissing
    }
    let persistedSources = metadata.sources
    guard persistedSources.count == expectedSourceCount else {
      throw LegacyAudioAssemblyError.verificationFailed(
        "persisted source count \(persistedSources.count) does not match the expected \(expectedSourceCount)"
      )
    }

    // Compose. An interrupted export from a prior attempt is never trusted
    // as a canonical or resumable artifact — always start from a clean
    // temporary file.
    if fileManager.fileExists(atPath: temporaryURL.path) {
      try? fileManager.removeItem(at: temporaryURL)
    }
    let durableURLs = persistedSources.map { lectureDirectory.appendingPathComponent($0.durableRelativePath) }
    do {
      try await AudioSegmentComposer.compose(orderedSources: durableURLs, outputURL: temporaryURL)
    } catch let error as AudioSegmentComposerError {
      throw LegacyAudioAssemblyError.compositionFailed(error.message)
    }

    // Verify BEFORE any promotion or state change. `inspect` below already
    // proves: file exists, size > 0, the container loads as a valid audio
    // file, an audio track/channel exists, and duration is > 0. What
    // remains is comparing the assembled duration against the sum of the
    // source durations.
    let tempInspection = try inspect(temporaryURL, context: "the assembled audio")
    let expectedDurationMs = persistedSources.reduce(0) { $0 + $1.durationMs }
    // Tolerance appropriate for compressed M4A/AAC container timing across a
    // multi-source concatenation (frame-boundary rounding per source), not a
    // magic number tied to any specific recording's length.
    let toleranceMs = max(500, Int((Double(expectedDurationMs) * 0.02).rounded()))
    guard abs(tempInspection.durationMs - expectedDurationMs) <= toleranceMs else {
      try? fileManager.removeItem(at: temporaryURL)
      throw LegacyAudioAssemblyError.verificationFailed(
        "assembled duration \(tempInspection.durationMs)ms does not match the sum of source durations " +
        "\(expectedDurationMs)ms within a \(toleranceMs)ms tolerance"
      )
    }

    // Atomic finalize. Reaching this point already proved the fingerprint
    // does NOT match whatever completed final currently sits at finalURL
    // (a matching one would have returned via the reuse shortcut above), so
    // if one is still there it is a stale, unrelated-request asset — it is
    // preserved under a timestamped name, never deleted, before the newly
    // verified asset is promoted. A second concurrent/retried call for the
    // SAME (matching) fingerprint still lands here idempotently because the
    // reuse shortcut above already returns before reaching this block.
    do {
      try synchronized {
        if fileManager.fileExists(atPath: finalURL.path) {
          let preservedURL = finalDirectory.appendingPathComponent(
            "lecture.prev-\(Self.compactTimestamp(clock())).m4a"
          )
          if !fileManager.fileExists(atPath: preservedURL.path) {
            try? fileManager.copyItem(at: finalURL, to: preservedURL)
          }
          try fileManager.removeItem(at: finalURL)
        }
        try fileManager.moveItem(at: temporaryURL, to: finalURL)
      }
    } catch {
      throw LegacyAudioAssemblyError.storageFailure(error.localizedDescription)
    }

    let finalInspection = try inspect(finalURL, context: "the finalized assembled asset")
    try writeMetadata(LegacyAudioAssemblyMetadata(
      schemaVersion: legacyAudioAssemblySchemaVersion,
      lectureId: normalizedLectureId,
      sources: persistedSources,
      state: .completed,
      updatedAt: Self.timestamp(clock()),
      finalRelativePath: "final/lecture.m4a",
      finalDurationMs: finalInspection.durationMs,
      finalByteLength: finalInspection.byteLength,
      sourceFingerprint: sourceFingerprint
    ), directory: lectureDirectory)

    return LegacyAudioAssemblyResult(
      fileUri: finalURL.absoluteString,
      durationMs: finalInspection.durationMs,
      byteLength: finalInspection.byteLength,
      sourceCount: persistedSources.count,
      sourceFingerprint: sourceFingerprint
    )
  }

  /// Full pipeline in one call — `persistSources` then `composeAndVerify`.
  /// Kept for callers (e.g. a first-time Finish that never ran early
  /// preservation) that just want "make this lecture's audio safe to
  /// upload" without caring about the two-phase split. Skips straight to
  /// `composeAndVerify` if a final asset already exists, so a lecture whose
  /// sources are no longer resolvable (evicted Cache, reinstalled
  /// container) but which was ALREADY successfully assembled before is
  /// unaffected by that later unavailability.
  func assemble(lectureId: String, orderedSources: [(role: String, uri: String)]) async throws -> LegacyAudioAssemblyResult {
    let normalizedLectureId = try Self.normalizeLectureId(lectureId)
    let fingerprint = Self.sourceFingerprint(orderedSources)
    let lectureDirectory = rootURL.appendingPathComponent(normalizedLectureId, isDirectory: true)
    let finalURL = lectureDirectory
      .appendingPathComponent("final", isDirectory: true)
      .appendingPathComponent("lecture.m4a")
    // Only short-circuit straight to the existing final asset when it was
    // actually built from THIS EXACT requested source set — see
    // composeAndVerify's matching reuse-shortcut doc comment for why this
    // must never be keyed on lectureId/state alone. A different (e.g.
    // expanded, reconciliation-discovered) source set falls through to a
    // real persistSources + composeAndVerify below, same as a first-ever run.
    if fileManager.fileExists(atPath: finalURL.path),
       let metadata = try readMetadata(directory: lectureDirectory),
       metadata.state == .completed,
       metadata.sourceFingerprint == fingerprint {
      let inspection = try inspect(finalURL, context: "the previously assembled asset")
      return LegacyAudioAssemblyResult(
        fileUri: finalURL.absoluteString,
        durationMs: inspection.durationMs,
        byteLength: inspection.byteLength,
        sourceCount: orderedSources.count,
        sourceFingerprint: fingerprint
      )
    }
    _ = try persistSources(lectureId: lectureId, orderedSources: orderedSources)
    return try await composeAndVerify(lectureId: lectureId, expectedSourceCount: orderedSources.count, sourceFingerprint: fingerprint)
  }

  private func inspect(_ url: URL, context: String) throws -> DurableAudioFileInspection {
    do {
      return try inspector.inspect(url: url)
    } catch {
      throw LegacyAudioAssemblyError.sourceValidationFailed("\(context): \(error.localizedDescription)")
    }
  }

  private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
    lock.lock(); defer { lock.unlock() }
    return try operation()
  }

  private func writeMetadata(_ metadata: LegacyAudioAssemblyMetadata, directory: URL) throws {
    do {
      let data = try encoder.encode(metadata)
      try data.write(to: directory.appendingPathComponent("assembly.json", isDirectory: false), options: .atomic)
    } catch {
      throw LegacyAudioAssemblyError.storageFailure(error.localizedDescription)
    }
  }

  private func readMetadata(directory: URL) throws -> LegacyAudioAssemblyMetadata? {
    let url = directory.appendingPathComponent("assembly.json", isDirectory: false)
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    do {
      let data = try Data(contentsOf: url)
      return try decoder.decode(LegacyAudioAssemblyMetadata.self, from: data)
    } catch {
      throw LegacyAudioAssemblyError.storageFailure(error.localizedDescription)
    }
  }

  private static func normalizeLectureId(_ lectureId: String) throws -> String {
    let normalized = lectureId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty, normalized.count <= 256,
          normalized.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
      throw LegacyAudioAssemblyError.invalidLectureId
    }
    return normalized
  }

  /// Resolves a persisted `file://` URI to a URL that verifiably exists
  /// RIGHT NOW. The legacy `expo-audio` recorder only ever returns an
  /// ABSOLUTE URI (`file:///var/mobile/Containers/Data/Application/<UUID>/
  /// ...`), and iOS rotates that container UUID on reinstall — a URI
  /// persisted before a reinstall can reference a container that no longer
  /// exists even though the identical file is still sitting at the same
  /// path relative to Documents/Library/tmp under the CURRENT container.
  /// This never assumes that: it re-verifies with fileExists before
  /// trusting the rebased path, and falls back to the literal original
  /// path (which the caller's own existence check will then correctly
  /// reject) if rebasing doesn't resolve to a real file either — a missing
  /// Cache file is never magically assumed to exist somewhere else.
  private static func resolveExistingURL(_ uri: String, fileManager: FileManager) -> URL? {
    let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard let direct = trimmed.hasPrefix("file://") ? URL(string: trimmed) : URL(fileURLWithPath: trimmed) else {
      return nil
    }
    if fileManager.fileExists(atPath: direct.path) { return direct }

    let sandboxTopLevelAnchors: Set<String> = ["Documents", "Library", "tmp"]
    let components = direct.pathComponents
    guard let anchorIndex = components.firstIndex(where: { sandboxTopLevelAnchors.contains($0) }) else {
      return direct
    }
    var rebased = URL(fileURLWithPath: NSHomeDirectory())
    for component in components[anchorIndex...] { rebased.appendPathComponent(component) }
    return fileManager.fileExists(atPath: rebased.path) ? rebased : direct
  }

  /// 0 when unreadable — callers must treat 0 as "unknown", never as a real
  /// epoch time, since JS-side overlap proofs must fail closed on missing data.
  private static func modificationTimeMs(of url: URL) -> Int64 {
    guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
          let date = values.contentModificationDate else {
      return 0
    }
    return Int64((date.timeIntervalSince1970 * 1000).rounded())
  }

  private static func sanitize(_ value: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    let filtered = value.unicodeScalars.filter { allowed.contains($0) }
    let result = String(String.UnicodeScalarView(filtered))
    return result.isEmpty ? "source" : result
  }

  private static func timestamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  /// Deterministic fingerprint of an ORDERED (role, uri) source list — the
  /// caller's REQUESTED set. Deliberately NOT String.hashValue, which is
  /// seed-randomized per process and would produce a different value on
  /// every app launch, making a persisted comparison meaningless.
  private static func sourceFingerprint(_ orderedSources: [(role: String, uri: String)]) -> String {
    orderedSources.map { "\($0.role)::\($0.uri)" }.joined(separator: "\u{1E}")
  }

  /// Sortable, collision-safe-enough (millisecond resolution) suffix for a
  /// preserved prior final asset's filename.
  private static func compactTimestamp(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMddHHmmssSSS"
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter.string(from: date)
  }
}
