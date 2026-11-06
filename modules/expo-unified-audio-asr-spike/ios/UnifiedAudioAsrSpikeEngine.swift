import AVFoundation
import Foundation

#if canImport(UIKit)
import UIKit
#endif

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
  /// Keep a couple of recent spike files for dogfood; older orphans are deleted.
  private static let spikeFileRetention = 2
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
  /// True while JS wants capture; survives temporary interruptions so we can resume.
  private var wantsRunning = false
  private var framesEmitted: Int = 0
  private var observers: [NSObjectProtocol] = []
  private var pcmFormat: AVAudioFormat?
  private var fileProcessingFormat: AVAudioFormat?

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

  deinit {
    removeObservers()
  }

  func start() throws -> [String: Any] {
    lock.lock()
    if running {
      lock.unlock()
      return statusDictionary(trailing: nil)
    }
    lock.unlock()

    let session = AVAudioSession.sharedInstance()
    // playAndRecord keeps lecture playback paths possible; default mode avoids
    // voice-processing AGC that can bury quieter classroom speech.
    // Intentionally do NOT renegotiate preferred sample rate / IO buffer while
    // a concurrent production AVAudioRecorder may own the session — converters
    // already resample hardware → 48 kHz PCM / 44.1 kHz AAC.
    try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
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

    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    let spikeDir = docs.appendingPathComponent("unified-audio-asr-spike", isDirectory: true)
    try FileManager.default.createDirectory(at: spikeDir, withIntermediateDirectories: true)
    Self.pruneOldSpikeFiles(in: spikeDir, keepingNewest: Self.spikeFileRetention)
    let outURL = spikeDir.appendingPathComponent("spike-\(UUID().uuidString).m4a")

    let file = try AVAudioFile(forWriting: outURL, settings: Self.aacSettings)
    guard let toPcm = AVAudioConverter(from: hwFormat, to: pcmFormat) else {
      throw SpikeError.formatUnavailable("hw->pcm16-48k converter")
    }
    let fileProcessing = file.processingFormat
    guard let toFile = AVAudioConverter(from: hwFormat, to: fileProcessing) else {
      throw SpikeError.formatUnavailable("hw->aac-file converter")
    }

    lock.lock()
    audioFile = file
    fileURL = outURL
    pcmConverter = toPcm
    aacConverter = toFile
    self.pcmFormat = pcmFormat
    self.fileProcessingFormat = fileProcessing
    pcmAccumulator = Data()
    framesEmitted = 0
    wantsRunning = true
    // `running` stays false until engine.start() succeeds.
    lock.unlock()

    installTap(pcmFormat: pcmFormat, fileProcessing: fileProcessing)
    engine.prepare()
    do {
      try engine.start()
    } catch {
      teardownEngine(keepFile: true)
      throw error
    }

    registerObserversIfNeeded()

    lock.lock()
    running = true
    defer { lock.unlock() }
    return statusDictionary(trailing: nil)
  }

  func stop() -> [String: Any] {
    lock.lock()
    wantsRunning = false
    let wasRunning = running
    running = false
    lock.unlock()

    if wasRunning || engine.isRunning {
      engine.inputNode.removeTap(onBus: 0)
      if engine.isRunning {
        engine.stop()
      }
    }

    lock.lock()
    // Flush any trailing PCM that did not fill a full 100 ms frame — return it
    // synchronously so JS can deliver it before removing its listener.
    let trailing = pcmAccumulator
    pcmAccumulator = Data()
    audioFile = nil
    pcmConverter = nil
    aacConverter = nil
    pcmFormat = nil
    fileProcessingFormat = nil
    let uri = fileURL?.absoluteString
    let frames = framesEmitted
    lock.unlock()

    var trailingBase64: String? = nil
    var trailingSamples = 0
    if trailing.count >= 2 {
      trailingSamples = trailing.count / 2
      trailingBase64 = trailing.base64EncodedString()
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
      "trailingPcmBase64": trailingBase64 as Any,
      "trailingSampleCount": trailingSamples,
    ]
  }

  func status() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    return statusDictionary(trailing: nil)
  }

  // MARK: - Private

  private func statusDictionary(trailing: (String, Int)?) -> [String: Any] {
    var dict: [String: Any] = [
      "isRunning": running,
      "fileUri": fileURL?.absoluteString as Any,
      "framesEmitted": framesEmitted,
      "sampleRate": Int(Self.targetPcmSampleRate),
      "channelCount": 1,
      "encoding": "pcm16le",
      "implementation": "spike-avaudioengine",
    ]
    if let trailing {
      dict["trailingPcmBase64"] = trailing.0
      dict["trailingSampleCount"] = trailing.1
    }
    return dict
  }

  private func installTap(pcmFormat: AVAudioFormat, fileProcessing: AVAudioFormat) {
    let input = engine.inputNode
    let hwFormat = input.inputFormat(forBus: 0)
    let bufferSize = AVAudioFrameCount(max(hwFormat.sampleRate * Self.frameDurationSeconds, 256))
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: bufferSize, format: hwFormat) { [weak self] buffer, _ in
      self?.handleTap(buffer: buffer, pcmFormat: pcmFormat, fileProcessing: fileProcessing)
    }
  }

  private func teardownEngine(keepFile: Bool) {
    engine.inputNode.removeTap(onBus: 0)
    if engine.isRunning {
      engine.stop()
    }
    lock.lock()
    running = false
    if !keepFile {
      audioFile = nil
      pcmConverter = nil
      aacConverter = nil
      pcmFormat = nil
      fileProcessingFormat = nil
    }
    lock.unlock()
  }

  private func registerObserversIfNeeded() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      self?.handleInterruption(notification)
    })
    observers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] notification in
      self?.handleRouteChange(notification)
    })
    observers.append(center.addObserver(
      forName: NSNotification.Name.AVAudioEngineConfigurationChange,
      object: engine,
      queue: nil
    ) { [weak self] _ in
      self?.handleEngineConfigurationChange()
    })
  }

  private func removeObservers() {
    let center = NotificationCenter.default
    for observer in observers {
      center.removeObserver(observer)
    }
    observers.removeAll()
  }

  private func handleInterruption(_ notification: Notification) {
    guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
    switch type {
    case .began:
      lock.lock()
      let shouldPause = wantsRunning
      lock.unlock()
      guard shouldPause else { return }
      // Engine may already be stopped by the system; mark not-running so resume can restart.
      lock.lock()
      running = false
      lock.unlock()
      if engine.isRunning {
        engine.pause()
      }
    case .ended:
      let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
      if options.contains(.shouldResume) {
        attemptResumeCapture(reason: "interruption_ended")
      }
    @unknown default:
      break
    }
  }

  private func handleRouteChange(_ notification: Notification) {
    let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
    let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason) ?? .unknown
    if reason == .oldDeviceUnavailable || reason == .newDeviceAvailable || reason == .categoryChange {
      attemptResumeCapture(reason: "route_change")
    }
  }

  private func handleEngineConfigurationChange() {
    attemptResumeCapture(reason: "engine_config_change")
  }

  private func attemptResumeCapture(reason: String) {
    lock.lock()
    let shouldResume = wantsRunning
    let pcm = pcmFormat
    let fileFmt = fileProcessingFormat
    lock.unlock()
    guard shouldResume, let pcm, let fileFmt else { return }

    do {
      let session = AVAudioSession.sharedInstance()
      try session.setActive(true, options: [])
      if engine.isRunning {
        // Tap may still be valid; nothing to do.
        lock.lock()
        running = true
        lock.unlock()
        return
      }
      installTap(pcmFormat: pcm, fileProcessing: fileFmt)
      engine.prepare()
      try engine.start()
      lock.lock()
      running = true
      lock.unlock()
      NSLog("[unifiedAudioAsrSpike] resumed after %@", reason)
    } catch {
      lock.lock()
      running = false
      lock.unlock()
      NSLog("[unifiedAudioAsrSpike] resume failed after %@: %@", reason, error.localizedDescription)
    }
  }

  private static func pruneOldSpikeFiles(in directory: URL, keepingNewest keep: Int) {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.contentModificationDateKey],
      options: [.skipsHiddenFiles]
    ) else { return }
    let spikeFiles = entries.filter { $0.lastPathComponent.hasPrefix("spike-") && $0.pathExtension == "m4a" }
    guard spikeFiles.count > keep else { return }
    let ranked = spikeFiles.compactMap { url -> (URL, Date)? in
      let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
      return (url, values?.contentModificationDate ?? .distantPast)
    }
    .sorted { $0.1 > $1.1 }
    for stale in ranked.dropFirst(keep) {
      try? fm.removeItem(at: stale.0)
    }
  }

  private func handleTap(buffer: AVAudioPCMBuffer, pcmFormat: AVAudioFormat, fileProcessing: AVAudioFormat) {
    writeAac(from: buffer, fileProcessing: fileProcessing)
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
