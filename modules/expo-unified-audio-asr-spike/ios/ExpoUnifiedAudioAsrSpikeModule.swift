import ExpoModulesCore
import Foundation

/// SPIKE Expo module — opt-in unified AVAudioEngine capture.
/// Production durable recording (`ExpoDurableRecorder` / AVAudioRecorder) is
/// unchanged. JS must gate every call behind `isUnifiedAudioAsrSpikeEnabled()`.
public final class ExpoUnifiedAudioAsrSpikeModule: Module {
  private let engine = UnifiedAudioAsrSpikeEngine()
  private var pcmBridgeInstalled = false

  public func definition() -> ModuleDefinition {
    Name("ExpoUnifiedAudioAsrSpike")

    Events("onPcmFrame")

    AsyncFunction("isAvailable") { () -> Bool in
      true
    }

    AsyncFunction("start") { () throws -> [String: Any] in
      self.ensurePcmBridge()
      do {
        return try self.engine.start()
      } catch let error as UnifiedAudioAsrSpikeEngine.SpikeError {
        throw Exception(name: "UnifiedAudioAsrSpikeError", description: self.describe(error), code: self.code(error))
      } catch {
        throw Exception(
          name: "UnifiedAudioAsrSpikeError",
          description: error.localizedDescription,
          code: "ERR_SPIKE_START_FAILED"
        )
      }
    }

    AsyncFunction("stop") { () -> [String: Any] in
      self.engine.stop()
    }

    AsyncFunction("getStatus") { () -> [String: Any] in
      self.engine.status()
    }
  }

  private func ensurePcmBridge() {
    guard !pcmBridgeInstalled else { return }
    engine.onPcmFrame = { [weak self] base64, sampleRate, sampleCount in
      self?.sendEvent("onPcmFrame", [
        "base64": base64,
        "sampleRate": sampleRate,
        "sampleCount": sampleCount,
        "encoding": "pcm16le",
        "channelCount": 1,
      ])
    }
    pcmBridgeInstalled = true
  }

  private func describe(_ error: UnifiedAudioAsrSpikeEngine.SpikeError) -> String {
    switch error {
    case .noAudioInput:
      return "Spike capture found no usable audio input."
    case .formatUnavailable(let detail):
      return "Spike capture could not build audio format (\(detail))."
    }
  }

  private func code(_ error: UnifiedAudioAsrSpikeEngine.SpikeError) -> String {
    switch error {
    case .noAudioInput: return "ERR_SPIKE_NO_AUDIO_INPUT"
    case .formatUnavailable: return "ERR_SPIKE_FORMAT_UNAVAILABLE"
    }
  }
}
