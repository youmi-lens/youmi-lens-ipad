import AVFoundation
import Foundation

// Finish fast path: packet-preserving concatenation of the durable recorder's AAC segments (no re-encode).
// Proven here against real AAC segments written by the system encoder:
//  - the decoded output equals each individually-decoded segment sample-for-sample (error below -100 dBFS: only float
//    rounding) at every position;
//  - the seams add only the documented near-silent bridge;
//  - the container's gapless metadata describes the WHOLE stream (AVAudioFile and AVAsset agree);
//  - anything incompatible is refused BEFORE commit and the exporter falls back to the re-encoding composer;
//  - the exporter uses the fast path by default, honors the strategy switch, and cancellation still fails explicitly.

private struct PacketTestFailure: Error, CustomStringConvertible { let description: String }
private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if !(try condition()) { throw PacketTestFailure(description: message) }
}

/// Writes a real AAC/M4A segment of exactly `frames` valid frames. `frames == k * 1024 - 2112` gives remainder 0,
/// which is what the durable recorder's segments have.
private func writeTone(to url: URL, frequency: Double, frames: Int, sampleRate: Double = 44_100) throws {
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
  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
  buffer.frameLength = AVAudioFrameCount(frames)
  let samples = buffer.floatChannelData![0]
  for index in 0..<frames {
    let envelope = 0.5 + 0.5 * sin(2 * Double.pi * 3 * Double(index) / sampleRate)
    samples[index] = Float(sin(2 * Double.pi * frequency * Double(index) / sampleRate) * 0.25 * envelope)
  }
  try file.write(from: buffer)
}

private func decode(_ url: URL) throws -> [Float] {
  let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
  let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
  try file.read(into: buffer)
  return Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
}

private func temporaryDirectory(_ label: String) throws -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("packet-concat-\(label)-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

private final class TraceLog {
  private let lock = NSLock()
  private(set) var kinds: [String] = []
  private(set) var events: [(String, [String: Any])] = []
  func add(_ kind: String, _ extra: [String: Any]) { lock.lock(); kinds.append(kind); events.append((kind, extra)); lock.unlock() }
  func event(_ kind: String) -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return events.last { $0.0 == kind }?.1 }
}

@main
private struct PacketConcatenationTests {
  static func main() async throws {
    try await sampleExactOutputAndGaplessMetadata()
    try await incompatibleInputsAreRefusedBeforeCommit()
    try await exporterUsesFastPathAndFallsBack()
    print("native packet concatenation tests passed")
  }

  // Segment lengths (valid frames) chosen with remainder 0: k * 1024 - 2112.
  static let lengths = [60 * 1024 - 2112, 41 * 1024 - 2112, 97 * 1024 - 2112, 33 * 1024 - 2112]

  static func makeSegments(_ dir: URL) throws -> [URL] {
    var urls: [URL] = []
    for (index, frames) in lengths.enumerated() {
      let url = dir.appendingPathComponent(String(format: "%06d-seg.m4a", index + 1))
      try writeTone(to: url, frequency: 330 + 110 * Double(index), frames: frames)
      urls.append(url)
    }
    return urls
  }

  static func sampleExactOutputAndGaplessMetadata() async throws {
    let dir = try temporaryDirectory("exact"); defer { try? FileManager.default.removeItem(at: dir) }
    let sources = try makeSegments(dir)
    let truth = try sources.map(decode)
    for (index, frames) in lengths.enumerated() {
      try require(truth[index].count == frames, "fixture segment \(index + 1) must decode to its exact valid frames")
    }
    let output = dir.appendingPathComponent("out.m4a")
    let report = try await PacketPreservingConcatenator.concatenate(orderedSources: sources, outputURL: output)

    let seam = Int(PacketPreservingConcatenator.seamFrames)
    let expected = lengths.reduce(0, +) + (lengths.count - 1) * seam
    try require(seam == 1_088, "one priming packet is dropped per seam, leaving a 1088-frame bridge")
    try require(Int(report.expectedValidFrames) == expected, "report must describe the decoded length: \(report.expectedValidFrames) vs \(expected)")
    try require(report.seamFramesInserted == Int64((lengths.count - 1) * seam), "seam accounting")

    // Container metadata describes the whole stream for every reader.
    let decoded = try decode(output)
    try require(decoded.count == expected, "AVAudioFile length \(decoded.count) != \(expected) (gapless tag must cover all segments)")
    let assetSeconds = try await AVURLAsset(url: output).load(.duration).seconds
    try require(abs(assetSeconds - Double(expected) / 44_100) < 0.005, "AVAsset duration \(assetSeconds) vs \(Double(expected) / 44_100)")

    // Bit-exact: every segment's audio appears unchanged, in order, after each seam bridge.
    var position = 0
    var bridgePeak: Float = 0
    for (index, segment) in truth.enumerated() {
      if index > 0 {
        for sample in decoded[position..<(position + seam)] { bridgePeak = max(bridgePeak, abs(sample)) }
        position += seam
      }
      var maxError: Float = 0
      for i in 0..<segment.count { maxError = max(maxError, abs(decoded[position + i] - segment[i])) }
      try require(maxError < 1e-5, "segment \(index + 1) must decode sample-exactly, error below -100 dBFS (max error \(maxError))")
      position += segment.count
    }
    try require(position == decoded.count, "no stray frames")
    try require(bridgePeak < 0.02, "the seam bridge must be near-silent (peak \(bridgePeak) vs tone 0.25)")

    // A single segment is a plain copy: identical audio, no bridge.
    let single = dir.appendingPathComponent("single.m4a")
    let singleReport = try await PacketPreservingConcatenator.concatenate(orderedSources: [sources[0]], outputURL: single)
    try require(singleReport.seamFramesInserted == 0 && Int(singleReport.expectedValidFrames) == lengths[0], "single segment: no seam")
    try require(zip(try decode(single), truth[0]).allSatisfy { abs($0 - $1) < 1e-5 }, "single segment must decode identically")
  }

  static func incompatibleInputsAreRefusedBeforeCommit() async throws {
    let dir = try temporaryDirectory("incompat"); defer { try? FileManager.default.removeItem(at: dir) }
    let good = try makeSegments(dir)

    // Non-zero remainder (e.g. a 0.35 s tone): refused.
    let ragged = dir.appendingPathComponent("ragged.m4a")
    try writeTone(to: ragged, frequency: 500, frames: 15_435)
    // Different sample rate: refused.
    let other = dir.appendingPathComponent("rate48.m4a")
    try writeTone(to: other, frequency: 500, frames: 60 * 1024 - 2112, sampleRate: 48_000)

    for (label, sources) in [("remainder", [good[0], ragged]), ("sample rate", [good[0], other]), ("missing", [good[0], dir.appendingPathComponent("nope.m4a")]), ("empty", [])] {
      let output = dir.appendingPathComponent("refused-\(label).m4a")
      do {
        _ = try await PacketPreservingConcatenator.concatenate(orderedSources: sources, outputURL: output)
        throw PacketTestFailure(description: "\(label): must be refused")
      } catch let failure as PacketTestFailure {
        throw failure
      } catch PacketConcatenationError.incompatible {
        // expected
      }
      try require(!FileManager.default.fileExists(atPath: output.path), "\(label): no partial output may remain")
    }

    // Cancellation is explicit and leaves nothing behind.
    let cancellation = AudioExportCancellation(); cancellation.cancel()
    let cancelled = dir.appendingPathComponent("cancelled.m4a")
    do {
      _ = try await PacketPreservingConcatenator.concatenate(orderedSources: good, outputURL: cancelled, cancellation: cancellation)
      throw PacketTestFailure(description: "a cancelled concatenation must fail")
    } catch let failure as PacketTestFailure { throw failure } catch PacketConcatenationError.cancelled {}
    try require(!FileManager.default.fileExists(atPath: cancelled.path), "cancelled: no partial output")
  }

  static func exporterUsesFastPathAndFallsBack() async throws {
    let root = try temporaryDirectory("exporter"); defer { try? FileManager.default.removeItem(at: root) }
    let store = try DurableRecorderStore(rootURL: root.appendingPathComponent("store"))

    func makeFinalizedSession(_ label: String) throws -> DurableRecordingSession {
      var session = try store.createSession(lectureId: "lecture-\(label)")
      let id = session.recordingSessionId
      session = try store.transitionSession(recordingSessionId: id, to: .preparing)
      session = try store.transitionSession(recordingSessionId: id, to: .ready)
      session = try store.transitionSession(recordingSessionId: id, to: .recording)
      for (index, frames) in lengths.enumerated() {
        let plan = try store.createSegmentPlan(recordingSessionId: id)
        try writeTone(to: plan.activeURL, frequency: 300 + 90 * Double(index), frames: frames)
        let inspection = try SystemDurableAudioFileInspector().inspect(url: plan.activeURL)
        _ = try store.commitSegment(recordingSessionId: id, plan: plan, inspection: inspection)
        if index < lengths.count - 1 {
          _ = try store.transitionSession(recordingSessionId: id, to: .paused)
          _ = try store.transitionSession(recordingSessionId: id, to: .recording)
        }
      }
      _ = try store.transitionSession(recordingSessionId: id, to: .finalizing)
      return try store.finalizeSession(recordingSessionId: id)
    }

    let committedSum = lengths.reduce(0, +)
    let seamTotal = (lengths.count - 1) * Int(PacketPreservingConcatenator.seamFrames)

    // 1) Default strategy: fast path, valid final asset, every segment listed once in order.
    do {
      let session = try makeFinalizedSession("fast")
      let trace = TraceLog()
      let exporter = DurableFinalAssetExporter(store: store)
      exporter.onTrace = { _, kind, extra in trace.add(kind, extra) }
      let result = try await exporter.export(recordingSessionId: session.recordingSessionId)
      try require(trace.event("finish_export_fast_path")?["outcome"] as? String == "completed", "default export must use the fast path: \(trace.kinds)")
      let committed = try store.getSession(recordingSessionId: session.recordingSessionId)
      try require(committed.finalAsset?.sourceSegmentIds == committed.segments.map(\.segmentId), "all segments, once, in order")
      let url = URL(string: result["fileUri"] as! String)!
      let inspection = try SystemDurableAudioFileInspector().inspect(url: url)
      let expectedMs = Int((Double(committedSum + seamTotal) / 44_100 * 1_000).rounded())
      try require(abs(inspection.durationMs - expectedMs) <= 1, "final duration \(inspection.durationMs) ms != \(expectedMs) ms")
      try require(committed.finalAsset?.durationMs == inspection.durationMs, "authoritative duration is the asset's")
      try require(!FileManager.default.fileExists(atPath: url.deletingLastPathComponent().appendingPathComponent("lecture.exporting.m4a").path), "no temp left")
      // The committed source segments are untouched.
      for segment in committed.segments {
        let data = try Data(contentsOf: root.appendingPathComponent("store").appendingPathComponent(committed.relativeSessionPath).appendingPathComponent(segment.relativePath))
        try require(data.count == Int(segment.byteLength), "segment \(segment.sequence) untouched")
      }
    }

    // 2) Strategy switch: `reencode` never touches the fast path and still succeeds.
    do {
      let session = try makeFinalizedSession("reencode")
      let trace = TraceLog()
      let exporter = DurableFinalAssetExporter(store: store)
      exporter.strategyProvider = { .reencode }
      exporter.onTrace = { _, kind, extra in trace.add(kind, extra) }
      _ = try await exporter.export(recordingSessionId: session.recordingSessionId)
      try require(trace.event("finish_export_fast_path") == nil, "reencode must not run the fast path")
      try require(try store.getSession(recordingSessionId: session.recordingSessionId).finalAsset != nil, "reencode export committed")
    }

    // 3) Fast path refuses (incompatible): automatic fallback to the re-encoding composer, same final result contract.
    do {
      let session = try makeFinalizedSession("fallback")
      let trace = TraceLog()
      let exporter = DurableFinalAssetExporter(store: store)
      exporter.packetConcatenator = { _, _, _ in throw PacketConcatenationError.incompatible("test") }
      exporter.onTrace = { _, kind, extra in trace.add(kind, extra) }
      let result = try await exporter.export(recordingSessionId: session.recordingSessionId)
      try require(trace.event("finish_export_fast_path")?["outcome"] as? String == "fallback_to_reencode", "must record the fallback: \(trace.kinds)")
      let inspection = try SystemDurableAudioFileInspector().inspect(url: URL(string: result["fileUri"] as! String)!)
      try require(inspection.durationMs >= Int(Double(committedSum) / 44_100 * 1_000) - 50, "fallback export is complete")
    }

    // 4) Even an unexpected fast-path failure (not just incompatibility) falls back, never loses the recording.
    do {
      let session = try makeFinalizedSession("surprise")
      let exporter = DurableFinalAssetExporter(store: store)
      exporter.packetConcatenator = { _, output, _ in
        FileManager.default.createFile(atPath: output.path, contents: Data("junk".utf8))
        throw PacketConcatenationError.writerFailed("injected")
      }
      _ = try await exporter.export(recordingSessionId: session.recordingSessionId)
      try require(try store.getSession(recordingSessionId: session.recordingSessionId).finalAsset != nil, "fallback after a writer failure committed a valid asset")
    }

    // 5) Cancellation (background time expiry) is NOT swallowed by the fallback: explicit failure, segments intact,
    //    retry succeeds.
    do {
      let session = try makeFinalizedSession("cancel")
      let exporter = DurableFinalAssetExporter(store: store)
      exporter.packetConcatenator = { _, _, _ in throw PacketConcatenationError.cancelled }
      do {
        _ = try await exporter.export(recordingSessionId: session.recordingSessionId)
        throw PacketTestFailure(description: "a cancelled fast path must fail the export")
      } catch let failure as PacketTestFailure { throw failure } catch let error as DurableRecorderCoreError {
        try require(error.message.contains(DurableFinalAssetExporter.backgroundTimeExpiredMessage), "explicit expiry message: \(error.message)")
      }
      try require(try store.getSession(recordingSessionId: session.recordingSessionId).finalAsset == nil, "nothing committed after cancel")
      exporter.packetConcatenator = { try await PacketPreservingConcatenator.concatenate(orderedSources: $0, outputURL: $1, cancellation: $2) }
      _ = try await exporter.export(recordingSessionId: session.recordingSessionId)
      try require(try store.getSession(recordingSessionId: session.recordingSessionId).finalAsset != nil, "retry succeeds")
    }
  }
}
