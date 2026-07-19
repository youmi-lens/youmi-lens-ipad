import AVFoundation
import Foundation

private struct FinalizationTestFailure: Error, CustomStringConvertible { let description: String }
private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw FinalizationTestFailure(description: message) }
}

private func writeTone(to url: URL, frequency: Double, seconds: Double) throws {
  let sampleRate = 44_100.0
  let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
  let file = try AVAudioFile(
    forWriting: url,
    settings: [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 96_000,
    ],
    commonFormat: .pcmFormatFloat32,
    interleaved: false
  )
  let frames = AVAudioFrameCount(sampleRate * seconds)
  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
  buffer.frameLength = frames
  let samples = buffer.floatChannelData![0]
  for index in 0..<Int(frames) {
    samples[index] = Float(sin(2 * Double.pi * frequency * Double(index) / sampleRate) * 0.25)
  }
  try file.write(from: buffer)
}

private func addSegment(
  store: DurableRecorderStore,
  sessionId: String,
  frequency: Double
) throws -> (DurableRecordingSession, Data) {
  let plan = try store.createSegmentPlan(recordingSessionId: sessionId)
  try writeTone(to: plan.activeURL, frequency: frequency, seconds: 0.35)
  let inspection = try SystemDurableAudioFileInspector().inspect(url: plan.activeURL)
  let session = try store.commitSegment(recordingSessionId: sessionId, plan: plan, inspection: inspection)
  return (session, try Data(contentsOf: plan.finalizedURL))
}

@main
private struct FinalizationTests {
  static func main() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("durable-finalization-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try DurableRecorderStore(rootURL: root)
    var session = try store.createSession(lectureId: "lecture-finalization")
    session = try store.transitionSession(recordingSessionId: session.recordingSessionId, to: .preparing)
    session = try store.transitionSession(recordingSessionId: session.recordingSessionId, to: .ready)
    session = try store.transitionSession(recordingSessionId: session.recordingSessionId, to: .recording)
    let first = try addSegment(store: store, sessionId: session.recordingSessionId, frequency: 440)
    session = try store.transitionSession(recordingSessionId: session.recordingSessionId, to: .paused)
    session = try store.transitionSession(recordingSessionId: session.recordingSessionId, to: .recording)
    let second = try addSegment(store: store, sessionId: session.recordingSessionId, frequency: 880)
    session = try store.transitionSession(recordingSessionId: session.recordingSessionId, to: .finalizing)
    session = try store.finalizeSession(recordingSessionId: session.recordingSessionId)

    let exporter = DurableFinalAssetExporter(store: store)
    let interruptedPlan = try store.finalAssetPlan(recordingSessionId: session.recordingSessionId)
    try Data("interrupted export".utf8).write(to: interruptedPlan.temporaryURL)
    let firstResult = try await exporter.export(recordingSessionId: session.recordingSessionId)
    let firstUri = firstResult["fileUri"] as! String
    let firstURL = URL(string: firstUri)!
    let finalInspection = try SystemDurableAudioFileInspector().inspect(url: firstURL)
    try require(finalInspection.durationMs >= 600, "Combined asset duration must include both source segments")
    let persisted = try store.getSession(recordingSessionId: session.recordingSessionId)
    try require(persisted.finalAsset?.sourceSegmentIds == persisted.segments.map(\.segmentId), "Every segment must appear exactly once in sequence order")
    let firstPreserved = try Data(contentsOf: root.appendingPathComponent(session.relativeSessionPath).appendingPathComponent(session.segments[0].relativePath))
    let secondPreserved = try Data(contentsOf: root.appendingPathComponent(session.relativeSessionPath).appendingPathComponent(session.segments[1].relativePath))
    try require(firstPreserved == first.1, "Segment 1 must remain immutable")
    try require(secondPreserved == second.1, "Segment 2 must remain immutable")
    try require(!FileManager.default.fileExists(atPath: interruptedPlan.temporaryURL.path), "A stale interrupted-export file must be safely replaced")
    let completionCandidates = try store.listRecoverableSessions().map(\.recordingSessionId)
    try require(completionCandidates.contains(session.recordingSessionId), "Finalized audio must remain discoverable until lecture handoff")
    let acknowledged = try store.acknowledgeFinalAssetHandoff(recordingSessionId: session.recordingSessionId)
    try require(acknowledged.handoffCompletedAt != nil, "Lecture handoff acknowledgment must be durable")
    let postHandoffCandidates = try store.listRecoverableSessions().map(\.recordingSessionId)
    try require(!postHandoffCandidates.contains(session.recordingSessionId), "Acknowledged final output must not be offered twice")

    let repeated = try await DurableFinalAssetExporter(store: store).export(recordingSessionId: session.recordingSessionId)
    try require((repeated["fileUri"] as? String) == firstUri, "Repeated export must return the stable asset URI")
    let afterRepeated = try store.getSession(recordingSessionId: session.recordingSessionId)
    try require(afterRepeated.finalAsset == persisted.finalAsset, "Repeated export must not duplicate final metadata")

    var failedSession = try store.createSession(lectureId: "lecture-failed-export")
    failedSession = try store.transitionSession(recordingSessionId: failedSession.recordingSessionId, to: .preparing)
    failedSession = try store.transitionSession(recordingSessionId: failedSession.recordingSessionId, to: .ready)
    failedSession = try store.transitionSession(recordingSessionId: failedSession.recordingSessionId, to: .recording)
    let surviving = try addSegment(store: store, sessionId: failedSession.recordingSessionId, frequency: 220)
    failedSession = try store.transitionSession(recordingSessionId: failedSession.recordingSessionId, to: .paused)
    failedSession = try store.transitionSession(recordingSessionId: failedSession.recordingSessionId, to: .recording)
    _ = try addSegment(store: store, sessionId: failedSession.recordingSessionId, frequency: 330)
    failedSession = try store.transitionSession(recordingSessionId: failedSession.recordingSessionId, to: .finalizing)
    failedSession = try store.finalizeSession(recordingSessionId: failedSession.recordingSessionId)
    let failedDirectory = root.appendingPathComponent(failedSession.relativeSessionPath)
    try FileManager.default.removeItem(at: failedDirectory.appendingPathComponent(failedSession.segments[1].relativePath))
    do {
      _ = try await exporter.export(recordingSessionId: failedSession.recordingSessionId)
      throw FinalizationTestFailure(description: "Export must fail when a referenced source segment is missing")
    } catch let error as FinalizationTestFailure {
      throw error
    } catch {
      // Expected: failure is recoverable and source data remains untouched.
    }
    let survivingAfterFailure = try Data(contentsOf: failedDirectory.appendingPathComponent(failedSession.segments[0].relativePath))
    try require(survivingAfterFailure == surviving.1, "Export failure must preserve every remaining source segment")
    let persistedFailedSession = try store.getSession(recordingSessionId: failedSession.recordingSessionId)
    try require(persistedFailedSession.finalAsset == nil, "Failed export must not persist final asset metadata")
    print("native final asset tests passed")
  }
}
