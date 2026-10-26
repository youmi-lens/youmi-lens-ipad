import AVFoundation
import Foundation

/// SPIKE ONLY — not the production durable recorder.
///
/// One AVAudioEngine graph:
///   input tap → PCM16 mono frames (for live captions / Deepgram)
///            → AAC/m4a via AVAudioFile (durable-ish proof of same-mic write)
///
/// Framing (JS contract):
/// - mono
/// - PCM16 little-endian
/// - target sample rate 48_000 (resampled from hardware when needed) so the
///   existing `startLiveCaptions(48_000, …)` / Deepgram path stays unchanged
/// - ~100 ms frames (matching liveMicStream's CALLBACK_DURATION_SECONDS)
///
/// AAC file: 44.1 kHz mono MPEG-4 AAC (same ballpark as production
/// DurableForegroundRecorder settings). Checkpoint / background / recovery of
/// the full durable store are intentionally NOT reimplemented here.
final class UnifiedAudioAsrSpikeEngine {
  static let targetPcmSampleRate: Double = 48_000
  static let frameDurationSeconds: Double = 0.1
  /// Matches production durable recorder bitrate / channel choices.
  private static let aacSettings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
    AVSampleRateKey: 44_100.0,
    AVNumberOfChannelsKey: 1,
    AVEncoderBitRateKey: 96_000,
    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
  ]

  private let engine = AVAudioEngine()
  private let lock = NSLock()
  private var audioFile: AVAudioFile?
  private var fileURL: URL?
  private var pcmConverter: AVAudioConverter?
  private var aacConverter: AVAudioConverter?
  private var pcmAccumulator = Data()
  private var running = false
  private var framesEmitted: Int = 0

  /// Invoked on a realtime audio thread — keep work tiny; hop to JS via main.
  var onPcmFrame: ((_ base64: String, _ sampleRate: Int, _ sampleCount: Int) -> Void)?

  var isRunning: Bool {
    lock.lock(); defer { lock.unlock() }
    return running
  }

  var recordingFileUri: String? {
    lock.lock(); defer { lock.unlock() }
    guard let fileURL else { return nil }
    return fileURL.absoluteString
  }

  var framesEmittedCount: Int {
    lock.lock(); defer { lock.unlock() }
    return framesEmitted
  }

  func start() throws -> [String: Any] {
    lock.lock()
    if running {
      lock.unlock()
      return statusDictionary()
    }
    lock.unlock()

    let session = AVAudioSession.sharedInstance()
    // playAndRecord keeps lecture playback paths possible; default mode avoids
    // voice-processing AGC that can bury quieter classroom speech. Spike may
    // still contend with a concurrent AVAudioRecorder — see docs.
    try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
    try session.setPreferredSampleRate(Self.targetPcmSampleRate)
    try session.setPreferredIOBufferDuration(Self.frameDurationSeconds)
    try session.setActive(true, options: [])

    let input = engine.inputNode
    let hwFormat = input.inputFormat(forBus: 0)
    guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
      throw SpikeError.noAudioInput
    }

    let pcmFormat = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: Self.targetPcmSampleRate,
      channels: 1,
      interleaved: true
    )
    guard let pcmFormat else { throw SpikeError.formatUnavailable("pcm16-48k-mono") }

    let aacWriteFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 44_100,
      channels: 1,
      interleaved: false
    )
    guard let aacWriteFormat else { throw SpikeError.formatUnavailable("float32-44.1k-mono") }

    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    let spikeDir = docs.appendingPathComponent("unified-audio-asr-spike", isDirectory: true)
    try FileManager.default.createDirectory(at: spikeDir, withIntermediateDirectories: true)
    let outURL = spikeDir.appendingPathComponent("spike-\(UUID().uuidString).m4a")

    let file = try AVAudioFile(forWriting: outURL, settings: Self.aacSettings)
    // Converter: hardware float bus → Int16 48 kHz mono for captions.
    guard let toPcm = AVAudioConverter(from: hwFormat, to: pcmFormat) else {
      throw SpikeError.formatUnavailable("hw->pcm16-48k converter")
    }
    // Converter: hardware → file.processingFormat so AVAudioFile can encode AAC.
    let fileProcessing = file.processingFormat
    guard let toFile = AVAudioConverter(from: hwFormat, to: fileProcessing) else {
      throw SpikeError.formatUnavailable("hw->aac-file converter")
    }

    lock.lock()
    audioFile = file
    fileURL = outURL
    pcmConverter = toPcm
    aacConverter = toFile
    pcmAccumulator = Data()
    framesEmitted = 0
    running = true
    lock.unlock()

    let bufferSize = AVAudioFrameCount(max(hwFormat.sampleRate * Self.frameDurationSeconds, 256))
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: bufferSize, format: hwFormat) { [weak self] buffer, _ in
      self?.handleTap(buffer: buffer, pcmFormat: pcmFormat, fileProcessing: fileProcessing)
    }

    engine.prepare()
    try engine.start()

    lock.lock()
    defer { lock.unlock() }
    return statusDictionary()
  }

  func stop() -> [String: Any] {
    lock.lock()
    let wasRunning = running
    running = false
    lock.unlock()

    if wasRunning {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }

    lock.lock()
    // Flush any trailing PCM that did not fill a full 100 ms frame.
    let trailing = pcmAccumulator
    pcmAccumulator = Data()
    audioFile = nil
    pcmConverter = nil
    aacConverter = nil
    let uri = fileURL?.absoluteString
    let frames = framesEmitted
    lock.unlock()

    if trailing.count >= 2 {
      let sampleCount = trailing.count / 2
      let base64 = trailing.base64EncodedString()
      DispatchQueue.main.async { [weak self] in
        self?.onPcmFrame?(base64, Int(Self.targetPcmSampleRate), sampleCount)
      }
    }

    // Best-effort: do not deactivate the shared session — production durable /
    // lecture playback may still own it.
    return [
      "isRunning": false,
      "fileUri": uri as Any,
      "framesEmitted": frames,
      "sampleRate": Int(Self.targetPcmSampleRate),
      "channelCount": 1,
      "encoding": "pcm16le",
      "implementation": "spike-avaudioengine",
    ]
  }

  func status() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    return statusDictionary()
  }

  // MARK: - Private

  private func statusDictionary() -> [String: Any] {
    [
      "isRunning": running,
      "fileUri": fileURL?.absoluteString as Any,
      "framesEmitted": framesEmitted,
      "sampleRate": Int(Self.targetPcmSampleRate),
      "channelCount": 1,
      "encoding": "pcm16le",
      "implementation": "spike-avaudioengine",
    ]
  }

  private func handleTap(buffer: AVAudioPCMBuffer, pcmFormat: AVAudioFormat, fileProcessing: AVAudioFormat) {
    // Write AAC/m4a (durable-ish) from the same tap buffer.
    writeAac(from: buffer, fileProcessing: fileProcessing)
    // Emit PCM16 @ 48 kHz mono for live captions.
    emitPcm(from: buffer, pcmFormat: pcmFormat)
  }

  private func writeAac(from buffer: AVAudioPCMBuffer, fileProcessing: AVAudioFormat) {
    lock.lock()
    let file = audioFile
    let converter = aacConverter
    lock.unlock()
    guard let file, let converter else { return }

    let frameCapacity = AVAudioFrameCount(
      Double(buffer.frameLength) * fileProcessing.sampleRate / buffer.format.sampleRate + 32
    )
    guard let out = AVAudioPCMBuffer(pcmFormat: fileProcessing, frameCapacity: max(frameCapacity, 1)) else { return }

    var error: NSError?
    var supplied = false
    let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
      if supplied {
        outStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      outStatus.pointee = .haveData
      return buffer
    }
    let status = converter.convert(to: out, error: &error, withInputFrom: inputBlock)
    if error != nil || status == .error { return }
    guard out.frameLength > 0 else { return }
    do {
      try file.write(from: out)
    } catch {
      // Spike: drop write errors rather than crashing the audio thread.
    }
  }

  private func emitPcm(from buffer: AVAudioPCMBuffer, pcmFormat: AVAudioFormat) {
    lock.lock()
    let converter = pcmConverter
    lock.unlock()
    guard let converter else { return }

    let ratio = pcmFormat.sampleRate / buffer.format.sampleRate
    let frameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 32)
    guard let out = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: max(frameCapacity, 1)) else { return }

    var error: NSError?
    var supplied = false
    let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
      if supplied {
        outStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      outStatus.pointee = .haveData
      return buffer
    }
    let status = converter.convert(to: out, error: &error, withInputFrom: inputBlock)
    if error != nil || status == .error || out.frameLength == 0 { return }

    guard let channels = out.int16ChannelData else { return }
    let sampleCount = Int(out.frameLength)
    let byteCount = sampleCount * MemoryLayout<Int16>.size
    let data = Data(bytes: channels[0], count: byteCount)

    lock.lock()
    pcmAccumulator.append(data)
    let bytesPerFrame = Int(Self.targetPcmSampleRate * Self.frameDurationSeconds) * MemoryLayout<Int16>.size
    var emitted: [(String, Int)] = []
    while pcmAccumulator.count >= bytesPerFrame {
      let chunk = pcmAccumulator.prefix(bytesPerFrame)
      pcmAccumulator.removeFirst(bytesPerFrame)
      framesEmitted += 1
      emitted.append((Data(chunk).base64EncodedString(), bytesPerFrame / 2))
    }
    lock.unlock()

    guard !emitted.isEmpty else { return }
    let rate = Int(Self.targetPcmSampleRate)
    DispatchQueue.main.async { [weak self] in
      for (base64, samples) in emitted {
        self?.onPcmFrame?(base64, rate, samples)
      }
    }
  }

  enum SpikeError: Error {
    case noAudioInput
    case formatUnavailable(String)
  }
}
