import AVFoundation
import Foundation

/// Composes an ordered list of existing audio files into a single M4A asset
/// using AVFoundation media composition (never byte concatenation), so
/// container framing/timestamps stay valid no matter how the individual
/// sources were encoded.
///
/// Extracted from `DurableFinalAssetExporter`'s own segment-export loop so
/// the durable recorder's session-based export AND legacy-resume audio
/// recovery (`LegacyAudioAssembly.swift`) share exactly one tested
/// AVMutableComposition + AVAssetExportSession implementation, rather than
/// two independently-maintained copies of the same fragile AVFoundation
/// sequencing logic.
enum AudioSegmentComposerError: Error {
  case sourceMissing(URL)
  case sourceHasNoAudioTrack(URL)
  case sourceHasNoReadableDuration(URL)
  case compositionTrackUnavailable
  case exportSessionUnavailable
  case exportFailed(String)
  /// The export was cancelled on purpose through an `AudioExportCancellation` (for example because the app's
  /// background-execution time expired). Never produces a partial output that could be mistaken for success.
  case cancelled

  var message: String {
    switch self {
    case let .sourceMissing(url):
      return "A source segment is missing: \(url.lastPathComponent)"
    case let .sourceHasNoAudioTrack(url):
      return "A source segment has no audio track: \(url.lastPathComponent)"
    case let .sourceHasNoReadableDuration(url):
      return "A source segment has no readable duration: \(url.lastPathComponent)"
    case .compositionTrackUnavailable:
      return "Unable to allocate an audio composition track."
    case .exportSessionUnavailable:
      return "AVAssetExportSession could not be created."
    case let .exportFailed(reason):
      return reason
    case .cancelled:
      return "The export was cancelled."
    }
  }
}

/// Lets another thread (e.g. the background-task expiration handler) cancel an in-flight export deterministically.
/// Safe to call before, during or after the export; cancelling after completion is a no-op.
final class AudioExportCancellation {
  private let lock = NSLock()
  private var exporter: AVAssetExportSession?
  private var cancelled = false

  var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

  func attach(_ exporter: AVAssetExportSession) {
    lock.lock()
    self.exporter = exporter
    let shouldCancel = cancelled
    lock.unlock()
    if shouldCancel { exporter.cancelExport() }
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let exporter = self.exporter
    lock.unlock()
    exporter?.cancelExport()
  }
}

enum AudioSegmentComposer {
  /// Inserts each source's audio sequentially — source array order becomes
  /// output time order — into one AVMutableComposition, then exports it to
  /// `outputURL` as M4A. Throws before any export begins if a source is
  /// missing, has no audio track, or reports a zero/invalid duration, so a
  /// partial composition is never exported.
  static func compose(
    orderedSources: [URL],
    outputURL: URL,
    cancellation: AudioExportCancellation? = nil
  ) async throws {
    let composition = AVMutableComposition()
    guard let compositionTrack = composition.addMutableTrack(
      withMediaType: .audio,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw AudioSegmentComposerError.compositionTrackUnavailable
    }

    var cursor = CMTime.zero
    for sourceURL in orderedSources {
      if cancellation?.isCancelled == true { throw AudioSegmentComposerError.cancelled }
      guard FileManager.default.fileExists(atPath: sourceURL.path) else {
        throw AudioSegmentComposerError.sourceMissing(sourceURL)
      }
      let asset = AVURLAsset(url: sourceURL)
      let tracks = try await asset.loadTracks(withMediaType: .audio)
      guard let sourceTrack = tracks.first else {
        throw AudioSegmentComposerError.sourceHasNoAudioTrack(sourceURL)
      }
      let duration = try await asset.load(.duration)
      guard duration.isValid, duration.seconds > 0 else {
        throw AudioSegmentComposerError.sourceHasNoReadableDuration(sourceURL)
      }
      try compositionTrack.insertTimeRange(
        CMTimeRange(start: .zero, duration: duration),
        of: sourceTrack,
        at: cursor
      )
      cursor = CMTimeAdd(cursor, duration)
    }

    guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else {
      throw AudioSegmentComposerError.exportSessionUnavailable
    }
    exporter.outputURL = outputURL
    exporter.outputFileType = .m4a
    exporter.shouldOptimizeForNetworkUse = true
    if cancellation?.isCancelled == true { throw AudioSegmentComposerError.cancelled }
    cancellation?.attach(exporter)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      exporter.exportAsynchronously {
        switch exporter.status {
        case .completed:
          continuation.resume()
        case .cancelled where cancellation?.isCancelled == true:
          continuation.resume(throwing: AudioSegmentComposerError.cancelled)
        case .failed, .cancelled:
          continuation.resume(throwing: AudioSegmentComposerError.exportFailed(
            exporter.error?.localizedDescription ?? "The export did not complete."
          ))
        default:
          continuation.resume(throwing: AudioSegmentComposerError.exportFailed(
            "The export ended in state \(exporter.status.rawValue)."
          ))
        }
      }
    }
  }
}

// MARK: - Packet-preserving concatenation (Finish fast path)

enum PacketConcatenationError: Error {
  /// The sources are not safely concatenable at packet level; the caller falls back to the re-encoding composer.
  case incompatible(String)
  case writerFailed(String)
  /// The finished file did not match what the construction proves; it is discarded by the caller.
  case verificationFailed(String)
  case cancelled

  var message: String {
    switch self {
    case let .incompatible(reason): return "Segments are not packet-concatenable: \(reason)"
    case let .writerFailed(reason): return "Packet concatenation failed: \(reason)"
    case let .verificationFailed(reason): return "Packet concatenation verification failed: \(reason)"
    case .cancelled: return "The export was cancelled."
    }
  }
}

struct PacketConcatenationReport {
  let segmentCount: Int
  let packetCount: Int
  /// Frames AVAudioFile must report for the output (valid frames, priming excluded).
  let expectedValidFrames: Int64
  /// Near-silent frames the seams add (one dropped-priming packet per seam leaves `primingFrames - 1024`).
  let seamFramesInserted: Int64
  /// Phase timings (ms) for evidence only: source validation, packet copy, gapless-tag patch + verification.
  var preflightMs = 0
  var copyMs = 0
  var finalizeMs = 0
}

/// Joins the durable recorder's AAC segments WITHOUT re-encoding: the compressed packets are copied as-is into one
/// M4A, so the cost is I/O, not codec work (the re-encoding composer costs ~17.6 ms per audio second on device).
///
/// Why this is sample-exact (proven offline on a real 23-segment session: the decoded output is bit-identical to the
/// individually decoded segments, error 0): every segment starts with the AAC encoder's 2112 priming frames. Packet 0 of a
/// later segment contains only encoder warm-up (silence) and is dropped; the remaining priming packet is kept, so
/// the decoder has the overlap partner the first real packet needs, and its decoded output is a near-silent bridge of
/// `2112 - 1024 = 1088` frames (24.7 ms, measured peak -53 dBFS) in place of the gap the recorder's stop->start window
/// already leaves at every seam. Dropping two packets instead produces seam artifacts, so exactly one is dropped.
///
/// Anything unexpected — a different format, priming, sample rate, codec cookie, remainder, or a too-short segment —
/// throws `incompatible` BEFORE anything is committed, and the caller uses the re-encoding composer.
enum PacketPreservingConcatenator {
  static let sampleRate: Int32 = 44_100
  static let framesPerPacket: Int64 = 1_024
  static let primingFrames: Int64 = 2_112
  static let droppedPacketsPerSeam = 1
  static let seamFrames: Int64 = primingFrames - Int64(droppedPacketsPerSeam) * framesPerPacket

  private struct Source {
    let url: URL
    let asset: AVURLAsset
    let track: AVAssetTrack
    let validFrames: Int64
    let formatDescription: CMFormatDescription
  }

  static func concatenate(
    orderedSources: [URL],
    outputURL: URL,
    cancellation: AudioExportCancellation? = nil
  ) async throws -> PacketConcatenationReport {
    guard !orderedSources.isEmpty else { throw PacketConcatenationError.incompatible("no sources") }
    let phaseStart = ProcessInfo.processInfo.systemUptime
    var sources: [Source] = []
    var referenceCookie: Data?
    for url in orderedSources {
      if cancellation?.isCancelled == true { throw PacketConcatenationError.cancelled }
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw PacketConcatenationError.incompatible("missing source \(url.lastPathComponent)")
      }
      let asset = AVURLAsset(url: url)
      guard let track = try await asset.loadTracks(withMediaType: .audio).first,
            let description = try await track.load(.formatDescriptions).first else {
        throw PacketConcatenationError.incompatible("no audio track in \(url.lastPathComponent)")
      }
      guard let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
            basic.mFormatID == kAudioFormatMPEG4AAC,
            basic.mSampleRate == Double(sampleRate),
            basic.mChannelsPerFrame == 1,
            Int64(basic.mFramesPerPacket) == framesPerPacket else {
        throw PacketConcatenationError.incompatible("unexpected audio format in \(url.lastPathComponent)")
      }
      var cookieSize = 0
      let cookiePointer = CMAudioFormatDescriptionGetMagicCookie(description, sizeOut: &cookieSize)
      let cookie = cookiePointer.map { Data(bytes: $0, count: cookieSize) } ?? Data()
      // Compare the AAC AudioSpecificConfig (what the decoder needs), not the whole esds: its bit-rate fields
      // legitimately differ from segment to segment.
      guard let config = audioSpecificConfig(fromCookie: cookie) else {
        throw PacketConcatenationError.incompatible("unrecognized codec configuration in \(url.lastPathComponent)")
      }
      if let referenceCookie, referenceCookie != config {
        throw PacketConcatenationError.incompatible("codec configuration differs in \(url.lastPathComponent)")
      }
      referenceCookie = config
      let validFrames: Int64
      do { validFrames = try AVAudioFile(forReading: url).length } catch {
        throw PacketConcatenationError.incompatible("unreadable \(url.lastPathComponent)")
      }
      sources.append(Source(url: url, asset: asset, track: track, validFrames: validFrames, formatDescription: description))
    }

    try? FileManager.default.removeItem(at: outputURL)
    let copyStart = ProcessInfo.processInfo.systemUptime
    var report: PacketConcatenationReport = try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          continuation.resume(returning: try copyPackets(sources: sources, outputURL: outputURL, cancellation: cancellation))
        } catch {
          try? FileManager.default.removeItem(at: outputURL)
          continuation.resume(throwing: error)
        }
      }
    }
    let finalizeStart = ProcessInfo.processInfo.systemUptime
    do {
      try patchGaplessTag(at: outputURL, validFrames: report.expectedValidFrames)
      let actual = try AVAudioFile(forReading: outputURL).length
      guard actual == report.expectedValidFrames else {
        throw PacketConcatenationError.verificationFailed("frame count \(actual) != \(report.expectedValidFrames)")
      }
    } catch {
      try? FileManager.default.removeItem(at: outputURL)
      throw error
    }
    let end = ProcessInfo.processInfo.systemUptime
    report.preflightMs = Int((copyStart - phaseStart) * 1_000)
    report.copyMs = Int((finalizeStart - copyStart) * 1_000)
    report.finalizeMs = Int((end - finalizeStart) * 1_000)
    return report
  }

  /// Extracts the AudioSpecificConfig from an MPEG-4 `esds` magic cookie
  /// (ES_Descriptor 0x03 -> DecoderConfigDescriptor 0x04 -> DecoderSpecificInfo 0x05). Returns nil if the layout is
  /// anything else, which makes the caller fall back to the re-encoding composer.
  static func audioSpecificConfig(fromCookie cookie: Data) -> Data? {
    let bytes = [UInt8](cookie)
    var index = 0
    func readLength() -> Int? {
      var length = 0
      for _ in 0..<4 {
        guard index < bytes.count else { return nil }
        let byte = bytes[index]; index += 1
        length = (length << 7) | Int(byte & 0x7F)
        if byte & 0x80 == 0 { return length }
      }
      return nil
    }
    guard index < bytes.count, bytes[index] == 0x03 else { return nil }
    index += 1
    guard readLength() != nil, index + 3 <= bytes.count else { return nil }
    let flags = bytes[index + 2]
    guard flags & 0xE0 == 0 else { return nil } // no stream dependence / URL / OCR fields
    index += 3
    guard index < bytes.count, bytes[index] == 0x04 else { return nil }
    index += 1
    guard readLength() != nil, index + 13 <= bytes.count else { return nil }
    index += 13
    guard index < bytes.count, bytes[index] == 0x05 else { return nil }
    index += 1
    guard let configLength = readLength(), configLength > 0, index + configLength <= bytes.count else { return nil }
    return Data(bytes[index..<(index + configLength)])
  }

  // Blocking; runs on a background queue.
  private static func copyPackets(
    sources: [Source],
    outputURL: URL,
    cancellation: AudioExportCancellation?
  ) throws -> PacketConcatenationReport {
    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
    writer.shouldOptimizeForNetworkUse = true
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: sources[0].formatDescription)
    writer.add(input)
    guard writer.startWriting() else {
      throw PacketConcatenationError.writerFailed(writer.error?.localizedDescription ?? "startWriting")
    }
    writer.startSession(atSourceTime: .zero)

    var packetsWritten: Int64 = 0
    func fail(_ error: PacketConcatenationError) -> PacketConcatenationError {
      writer.cancelWriting()
      return error
    }

    for (index, source) in sources.enumerated() {
      let reader: AVAssetReader
      do { reader = try AVAssetReader(asset: source.asset) } catch {
        throw fail(.writerFailed("reader: \(error.localizedDescription)"))
      }
      let output = AVAssetReaderTrackOutput(track: source.track, outputSettings: nil)
      output.alwaysCopiesSampleData = false
      reader.add(output)
      guard reader.startReading() else {
        throw fail(.writerFailed("startReading: \(reader.error?.localizedDescription ?? "unknown")"))
      }
      var sourcePackets: Int64 = 0
      var first = true
      while let buffer = output.copyNextSampleBuffer() {
        if cancellation?.isCancelled == true { reader.cancelReading(); throw fail(.cancelled) }
        let count = CMSampleBufferGetNumSamples(buffer)
        sourcePackets += Int64(count)
        var outgoing = buffer
        if first {
          // Every source must carry exactly the expected encoder priming.
          guard let trimRaw = CMGetAttachment(buffer, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart, attachmentModeOut: nil),
                CFGetTypeID(trimRaw) == CFDictionaryGetTypeID() else {
            throw fail(.incompatible("segment \(index + 1) has no priming"))
          }
          let trim = CMTimeMakeFromDictionary(trimRaw as! CFDictionary)
          guard trim.timescale == sampleRate, Int64(trim.value) == primingFrames else {
            throw fail(.incompatible("segment \(index + 1) priming is not \(primingFrames) frames"))
          }
          if index > 0 {
            guard count > droppedPacketsPerSeam + 1 else { throw fail(.incompatible("segment \(index + 1) too short")) }
            var trimmed: CMSampleBuffer?
            let status = CMSampleBufferCopySampleBufferForRange(
              allocator: nil, sampleBuffer: buffer,
              sampleRange: CFRange(location: droppedPacketsPerSeam, length: count - droppedPacketsPerSeam),
              sampleBufferOut: &trimmed
            )
            guard status == noErr, let trimmed else { throw fail(.writerFailed("range copy \(status)")) }
            outgoing = trimmed
          }
        }
        let kept = CMSampleBufferGetNumSamples(outgoing)
        var timing = CMSampleTimingInfo(
          duration: CMTime(value: framesPerPacket, timescale: sampleRate),
          presentationTimeStamp: CMTime(value: packetsWritten * framesPerPacket, timescale: sampleRate),
          decodeTimeStamp: .invalid
        )
        var retimed: CMSampleBuffer?
        let copyStatus = CMSampleBufferCreateCopyWithNewTiming(
          allocator: nil, sampleBuffer: outgoing, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &retimed
        )
        guard copyStatus == noErr, let retimed else { throw fail(.writerFailed("retime \(copyStatus)")) }
        // Priming is carried only by the file's first buffer (the container's own gapless metadata); a mid-stream trim
        // is not representable and makes the writer fail.
        if !(index == 0 && first) { CMRemoveAttachment(retimed, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart) }
        first = false
        while !input.isReadyForMoreMediaData {
          if cancellation?.isCancelled == true { reader.cancelReading(); throw fail(.cancelled) }
          if writer.status == .failed { throw fail(.writerFailed(writer.error?.localizedDescription ?? "writer failed")) }
          usleep(500)
        }
        guard input.append(retimed) else {
          throw fail(.writerFailed("append: \(writer.error?.localizedDescription ?? "unknown")"))
        }
        packetsWritten += Int64(kept)
      }
      guard reader.status == .completed else {
        throw fail(.writerFailed("read: \(reader.error?.localizedDescription ?? "status \(reader.status.rawValue)")"))
      }
      // Remainder must be zero: valid frames are exactly packets * 1024 - priming, so nothing is trimmed at the tail.
      guard sourcePackets * framesPerPacket - primingFrames == source.validFrames else {
        throw fail(.incompatible("segment \(index + 1) has a non-zero remainder"))
      }
    }

    input.markAsFinished()
    writer.endSession(atSourceTime: CMTime(value: packetsWritten * framesPerPacket, timescale: sampleRate))
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else {
      throw PacketConcatenationError.writerFailed(writer.error?.localizedDescription ?? "finishWriting status \(writer.status.rawValue)")
    }
    let segments = Int64(sources.count)
    return PacketConcatenationReport(
      segmentCount: sources.count,
      packetCount: Int(packetsWritten),
      expectedValidFrames: packetsWritten * framesPerPacket - primingFrames,
      seamFramesInserted: (segments - 1) * seamFrames
    )
  }

  /// AVAssetWriter records the gapless (iTunSMPB) valid-frame count from its FIRST buffer group only, which would
  /// make players truncate the file to the first segment. Rewrite the fixed-width fields so they describe the whole
  /// stream: priming 2112, remainder 0, valid frames = packets * 1024 - 2112. Refuses anything it does not recognize.
  static func patchGaplessTag(at url: URL, validFrames: Int64) throws {
    var data = try Data(contentsOf: url)
    guard let tag = data.range(of: Data("iTunSMPB".utf8)) else {
      throw PacketConcatenationError.verificationFailed("no gapless tag")
    }
    // Layout after the atom header:  " 00000000 <prime 8> <remainder 8> <valid 16> 00000000 ..."
    guard let start = data.range(of: Data(" 00000000 ".utf8), options: [], in: tag.upperBound..<min(data.count, tag.upperBound + 64)) else {
      throw PacketConcatenationError.verificationFailed("unrecognized gapless tag layout")
    }
    let base = start.lowerBound
    let replacement = String(format: " 00000000 %08X %08X %016llX", UInt32(primingFrames), UInt32(0), UInt64(validFrames))
    let bytes = Array(replacement.utf8)
    guard base + bytes.count <= data.count else { throw PacketConcatenationError.verificationFailed("tag bounds") }
    // The original fields must be hex in exactly those positions (space-separated), else we do not touch the file.
    let original = data.subdata(in: base..<(base + bytes.count))
    guard let originalText = String(data: original, encoding: .ascii),
          originalText.range(of: #"^ [0-9A-F]{8} [0-9A-F]{8} [0-9A-F]{8} [0-9A-F]{16}$"#, options: .regularExpression) != nil else {
      throw PacketConcatenationError.verificationFailed("unexpected gapless tag fields")
    }
    data.replaceSubrange(base..<(base + bytes.count), with: bytes)
    try data.write(to: url, options: .atomic)
  }
}
