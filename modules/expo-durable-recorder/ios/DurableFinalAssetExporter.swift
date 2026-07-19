import AVFoundation
import Foundation

final class DurableFinalAssetExporter {
  private let store: DurableRecorderStore
  private let inspector: DurableAudioFileInspecting
  private let lock = NSLock()
  private var exportingSessionIds = Set<String>()

  init(
    store: DurableRecorderStore,
    inspector: DurableAudioFileInspecting = SystemDurableAudioFileInspector()
  ) {
    self.store = store
    self.inspector = inspector
  }

  func export(recordingSessionId: String) async throws -> [String: Any] {
    try begin(recordingSessionId)
    defer { end(recordingSessionId) }

    let plan = try store.finalAssetPlan(recordingSessionId: recordingSessionId)
    let sourceIds = plan.sourceSegments.map(\.segmentId)

    if FileManager.default.fileExists(atPath: plan.finalURL.path) {
      let inspection = try inspector.inspect(url: plan.finalURL)
      let session = try store.commitFinalAsset(
        recordingSessionId: recordingSessionId,
        relativePath: plan.relativePath,
        inspection: inspection,
        sourceSegmentIds: sourceIds
      )
      return result(session: session, url: plan.finalURL)
    }

    try store.removeStaleFinalAssetTemporaryFile(plan)
    let composition = AVMutableComposition()
    guard let compositionTrack = composition.addMutableTrack(
      withMediaType: .audio,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
      throw DurableRecorderCoreError.finalAssetExportFailed("Unable to allocate an audio composition track.")
    }

    var cursor = CMTime.zero
    for sourceURL in plan.sourceURLs {
      guard FileManager.default.fileExists(atPath: sourceURL.path) else {
        throw DurableRecorderCoreError.finalAssetMissing
      }
      let asset = AVURLAsset(url: sourceURL)
      let tracks = try await asset.loadTracks(withMediaType: .audio)
      guard let sourceTrack = tracks.first else {
        throw DurableRecorderCoreError.finalAssetExportFailed("A source segment has no audio track.")
      }
      let duration = try await asset.load(.duration)
      guard duration.isValid, duration.seconds > 0 else {
        throw DurableRecorderCoreError.finalAssetExportFailed("A source segment has no readable duration.")
      }
      try compositionTrack.insertTimeRange(
        CMTimeRange(start: .zero, duration: duration),
        of: sourceTrack,
        at: cursor
      )
      cursor = CMTimeAdd(cursor, duration)
    }

    guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else {
      throw DurableRecorderCoreError.finalAssetExportFailed("AVAssetExportSession could not be created.")
    }
    exporter.outputURL = plan.temporaryURL
    exporter.outputFileType = .m4a
    exporter.shouldOptimizeForNetworkUse = true
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      exporter.exportAsynchronously {
        switch exporter.status {
        case .completed:
          continuation.resume()
        case .failed, .cancelled:
          continuation.resume(throwing: DurableRecorderCoreError.finalAssetExportFailed(
            exporter.error?.localizedDescription ?? "The export did not complete."
          ))
        default:
          continuation.resume(throwing: DurableRecorderCoreError.finalAssetExportFailed(
            "The export ended in state \(exporter.status.rawValue)."
          ))
        }
      }
    }
    _ = try inspector.inspect(url: plan.temporaryURL)
    try store.promoteFinalAsset(plan)
    let inspection = try inspector.inspect(url: plan.finalURL)
    let session = try store.commitFinalAsset(
      recordingSessionId: recordingSessionId,
      relativePath: plan.relativePath,
      inspection: inspection,
      sourceSegmentIds: sourceIds
    )
    return result(session: session, url: plan.finalURL)
  }

  private func result(session: DurableRecordingSession, url: URL) -> [String: Any] {
    ["session": session.asDictionary(), "fileUri": url.absoluteString]
  }

  private func begin(_ sessionId: String) throws {
    lock.lock(); defer { lock.unlock() }
    guard exportingSessionIds.insert(sessionId).inserted else {
      throw DurableRecorderCoreError.finalAssetExportFailed("A final asset export is already running.")
    }
  }

  private func end(_ sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    exportingSessionIds.remove(sessionId)
  }
}
