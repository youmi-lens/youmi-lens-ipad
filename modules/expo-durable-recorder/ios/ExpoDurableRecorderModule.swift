import ExpoModulesCore

public final class ExpoDurableRecorderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoDurableRecorder")

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      [
        "moduleAvailable": true,
        "contractVersion": 1,
        "platform": "ios",
        "implementation": "native-placeholder"
      ]
    }
  }
}
