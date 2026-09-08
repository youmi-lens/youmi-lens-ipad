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
    }
  }
}

enum AudioSegmentComposer {
  /// Inserts each source's audio sequentially — source array order becomes
  /// output time order — into one AVMutableComposition, then exports it to
  /// `outputURL` as M4A. Throws before any export begins if a source is
  /// missing, has no audio track, or reports a zero/invalid duration, so a
  /// partial composition is never exported.
  static func compose(orderedSources: [URL], outputURL: URL) async throws {
    let composition = AVMutableComposition()
    guard let compositionTrack = composition.addMutableTrack(
      withMediaType: .audio,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw AudioSegmentComposerError.compositionTrackUnavailable
    }

    var cursor = CMTime.zero
    for sourceURL in orderedSources {
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
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      exporter.exportAsynchronously {
        switch exporter.status {
        case .completed:
          continuation.resume()
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
