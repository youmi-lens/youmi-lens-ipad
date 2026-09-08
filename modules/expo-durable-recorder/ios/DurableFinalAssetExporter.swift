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
    do {
      try await AudioSegmentComposer.compose(orderedSources: plan.sourceURLs, outputURL: plan.temporaryURL)
    } catch AudioSegmentComposerError.sourceMissing {
      throw DurableRecorderCoreError.finalAssetMissing
    } catch let error as AudioSegmentComposerError {
      throw DurableRecorderCoreError.finalAssetExportFailed(error.message)
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
