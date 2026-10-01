import ExpoModulesCore
#if os(iOS)
import UIKit
#endif

private struct CreateDurableSessionRecord: Record {
  @Field var lectureId: String
}

private struct TransitionDurableSessionRecord: Record {
  @Field var recordingSessionId: String
  @Field var state: String
  @Field var failureCode: String?
  @Field var failureMessage: String?
}

private struct DurableSessionIdentifierRecord: Record {
  @Field var recordingSessionId: String
}

private struct PrepareDurableRecordingRecord: Record {
  @Field var recordingSessionId: String
  @Field var requestPermission: Bool = false
}

public final class ExpoDurableRecorderModule: Module {
  private lazy var storeResult = Result { try DurableRecorderStore() }
  private lazy var engineResult = Result {
    DurableForegroundRecorder(store: try storeResult.get())
  }
  private lazy var exporterResult = Result {
    let exporter = DurableFinalAssetExporter(store: try storeResult.get())
    exporter.onTrace = { [weak self] sessionId, kind, extra in self?.traceFinish(sessionId, kind, extra) }
    // Production always uses the default (packet-preserving with automatic re-encode fallback). Only a Dev bundle
    // can force `reencode` (to A/B the two strategies on the same session).
    exporter.strategyProvider = { Self.devFinalExportStrategy() ?? .packetPreserving }
    return exporter
  }
  /// Keeps the process alive across Finish (stop -> JS hop -> export) so iOS cannot suspend it mid-Finish. See
  /// `DurableFinishBackgroundAssertion`.
  private lazy var finishAssertion: DurableFinishBackgroundAssertion = {
    let assertion = DurableFinishBackgroundAssertion.system()
    assertion.onTrace = { [weak self] sessionId, kind, extra in self?.traceFinish(sessionId, kind, extra) }
    assertion.onExpire = { [weak self] sessionId in
      _ = try? self?.exporterResult.get().cancelExport(recordingSessionId: sessionId, backgroundTimeExpired: true)
    }
    return assertion
  }()
  private let finishTraceLock = NSLock()
  private lazy var finishDiagnostics: DurableRecorderDiagnostics? = {
    guard let store = try? storeResult.get() else { return nil }
    let diagnostics = DurableRecorderDiagnostics(
      enabled: DurableRecorderDiagnostics.isDevBundle,
      fileURL: { store.diagnosticsFileURL(recordingSessionId: $0) }
    )
    diagnostics.contextProvider = { ["app": DurableRecorderDiagnostics.sharedAppState] }
    return diagnostics
  }()
  private lazy var legacyAudioAssemblyResult = Result { try LegacyAudioAssemblyStore() }
  private var statusBridgeInstalled = false

  public func definition() -> ModuleDefinition {
    Name("ExpoDurableRecorder")

    // DEV-ONLY export benchmark (inert in every other bundle): runs when `Documents/recording-export-bench.json`
    // carries a request id that has no result yet. Never touches `final/` or session metadata.
    OnCreate {
      self.runDevExportBenchmarkIfRequested()
    }

    Events("onRecordingStatusChange")

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      [
        "moduleAvailable": true,
        "contractVersion": 1,
        "platform": "ios",
        "implementation": "native-background-audio"
      ]
    }

    AsyncFunction("createSession") { (input: CreateDurableSessionRecord) throws -> [String: Any] in
      try self.withStore { store in
        try store.createSession(lectureId: input.lectureId).asDictionary()
      }
    }

    AsyncFunction("getSession") { (recordingSessionId: String) throws -> [String: Any] in
      try self.withStore { store in
        try store.getSession(recordingSessionId: recordingSessionId).asDictionary()
      }
    }

    AsyncFunction("listRecoverableSessions") { () throws -> [[String: Any]] in
      try self.withStore { store in
        try store.listRecoverableSessions().map { $0.asDictionary() }
      }
    }

    AsyncFunction("transitionSession") { (input: TransitionDurableSessionRecord) throws -> [String: Any] in
      guard let state = DurableRecordingState(rawValue: input.state) else {
        throw self.moduleException(.invalidMetadata)
      }
      return try self.withStore { store in
        try store.transitionSession(
          recordingSessionId: input.recordingSessionId,
          to: state,
          failureCode: input.failureCode,
          failureMessage: input.failureMessage
        ).asDictionary()
      }
    }

    AsyncFunction("finalizeSession") { (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      try self.withStore { store in
        try store.finalizeSession(recordingSessionId: input.recordingSessionId).asDictionary()
      }
    }

    AsyncFunction("abandonSession") { (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      try self.withStore { store in
        try store.abandonSession(recordingSessionId: input.recordingSessionId).asDictionary()
      }
    }

    AsyncFunction("deleteSession") { (recordingSessionId: String) throws -> Bool in
      try self.withStore { store in
        try store.deleteSession(recordingSessionId: recordingSessionId)
      }
    }

    AsyncFunction("getMicrophonePermissionStatus") { () throws -> String in
      try self.withEngine { engine in
        engine.permissionState().rawValue
      }
    }

    AsyncFunction("prepareRecording") {
      (input: PrepareDurableRecordingRecord) async throws -> [String: Any] in
      do {
        return try await self.ensureStatusBridge(self.engineResult.get()).prepareRecording(
          recordingSessionId: input.recordingSessionId,
          requestPermission: input.requestPermission
        )
      } catch let error as DurableRecorderCoreError {
        throw self.moduleException(error)
      } catch {
        throw self.storageException(error)
      }
    }

    AsyncFunction("startRecording") { (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      try self.withEngine { engine in
        try engine.startRecording(recordingSessionId: input.recordingSessionId)
      }
    }

    AsyncFunction("pauseRecording") { (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      try self.withEngine { engine in
        try engine.pauseRecording(recordingSessionId: input.recordingSessionId)
      }
    }

    AsyncFunction("resumeRecording") { (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      try self.withEngine { engine in
        try engine.resumeRecording(recordingSessionId: input.recordingSessionId)
      }
    }

    AsyncFunction("stopRecording") { (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      // Hold a background task from BEFORE capture stops until the export finishes (or fails / expires): once the
      // recorder releases its audio session nothing else keeps a backgrounded app running.
      self.acquireFinishAssertion(input.recordingSessionId)
      self.traceFinish(input.recordingSessionId, "finish_stop_begin", [:])
      do {
        let status = try self.withEngine { engine in
          try engine.stopRecording(recordingSessionId: input.recordingSessionId)
        }
        self.traceFinish(input.recordingSessionId, "finish_stop_end", ["outcome": "completed"])
        return status
      } catch {
        self.traceFinish(input.recordingSessionId, "finish_stop_end", [
          "outcome": "failed", "error": DurableRecorderDiagnostics.describe(error),
        ])
        self.finishAssertion.release(sessionId: input.recordingSessionId, reason: "stop_failed")
        throw error
      }
    }

    AsyncFunction("getRecordingStatus") { () throws -> [String: Any] in
      try self.withEngine { engine in
        engine.getRecordingStatus()
      }
    }

    AsyncFunction("recoverRecordingSession") { (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      try self.withEngine { engine in
        try engine.recoverRecordingSession(recordingSessionId: input.recordingSessionId).asDictionary()
      }
    }

    AsyncFunction("exportFinalizedAsset") {
      (input: DurableSessionIdentifierRecord) async throws -> [String: Any] in
      self.acquireFinishAssertion(input.recordingSessionId)
      defer { self.finishAssertion.release(sessionId: input.recordingSessionId, reason: "export_finished") }
      do {
        return try await self.exporterResult.get().export(recordingSessionId: input.recordingSessionId)
      } catch let error as DurableRecorderCoreError {
        throw self.moduleException(error)
      } catch {
        throw self.storageException(error)
      }
    }

    // Legacy-resume audio recovery — unrelated to the durable recorder's own
    // session state machine (see LegacyAudioAssembly.swift's doc comment).
    // Kept on this module because it reuses this module's already-registered
    // native bridge and the shared AudioSegmentComposer primitive.
    AsyncFunction("persistLegacyAudioSources") { (input: [String: Any]) throws -> [String: Any] in
      let (lectureId, orderedSources) = try self.parseLegacyAudioInput(input)
      do {
        let store = try self.legacyAudioAssemblyResult.get()
        let sources = try store.persistSources(lectureId: lectureId, orderedSources: orderedSources)
        return [
          "sourceCount": sources.count,
          "sources": sources.map { [
            "role": $0.role,
            "durableRelativePath": $0.durableRelativePath,
            "byteLength": $0.byteLength,
            "durationMs": $0.durationMs,
            "sourceModifiedAtMs": $0.sourceModifiedAtMs,
          ] },
        ]
      } catch let error as LegacyAudioAssemblyError {
        throw self.legacyAssemblyException(error)
      } catch {
        throw self.storageException(error)
      }
    }

    AsyncFunction("assembleLegacyAudio") { (input: [String: Any]) async throws -> [String: Any] in
      let (lectureId, orderedSources) = try self.parseLegacyAudioInput(input)
      do {
        let store = try self.legacyAudioAssemblyResult.get()
        let result = try await store.assemble(lectureId: lectureId, orderedSources: orderedSources)
        return result.asDictionary()
      } catch let error as LegacyAudioAssemblyError {
        throw self.legacyAssemblyException(error)
      } catch {
        throw self.storageException(error)
      }
    }

    AsyncFunction("acknowledgeFinalAssetHandoff") {
      (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      try self.withStore { store in
        try store.acknowledgeFinalAssetHandoff(
          recordingSessionId: input.recordingSessionId
        ).asDictionary()
      }
    }

    // DEBUG-only verification hooks for Simulator R6 durability automation.
    // Omitted from Release builds so production cannot invoke them.
    #if DEBUG
    AsyncFunction("performCheckpointForTesting") {
      (input: DurableSessionIdentifierRecord) throws -> [String: Any] in
      try self.withEngine { engine in
        try engine.performCheckpointForTesting()
        return engine.getRecordingStatus()
      }
    }

    AsyncFunction("simulateInterruptionBeganForTesting") { () throws -> [String: Any] in
      try self.withEngine { engine in
        engine.simulateInterruptionBeganForTesting()
        return engine.getRecordingStatus()
      }
    }

    AsyncFunction("simulateRouteLossForTesting") { () throws -> [String: Any] in
      try self.withEngine { engine in
        engine.simulateRouteLossForTesting()
        return engine.getRecordingStatus()
      }
    }
    #endif
  }

  /// Acquires the Finish background task unless a Dev-only experiment disabled it (used to reproduce and prove the
  /// suspension mechanism on a Dev build; the experiment switch is inert in every other bundle).
  private func acquireFinishAssertion(_ recordingSessionId: String) {
    if DurableRecorderDiagnostics.isDevBundle, Self.finishBackgroundTaskDisabledByExperiment() {
      traceFinish(recordingSessionId, "finish_bgtask_disabled_by_experiment", [:])
      return
    }
    finishAssertion.acquire(sessionId: recordingSessionId)
  }

  private static func finishBackgroundTaskDisabledByExperiment() -> Bool {
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
          let data = try? Data(contentsOf: documents.appendingPathComponent("recording-finish-experiment.json")),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return object["finishBackgroundTask"] as? Bool == false
  }

  /// Dev-only: `{"finalExportStrategy": "reencode"}` in Documents/recording-finish-experiment.json forces the original
  /// re-encoding export. nil (always, outside a Dev bundle) means the default strategy.
  private static func devFinalExportStrategy() -> DurableFinalAssetExporter.Strategy? {
    guard DurableRecorderDiagnostics.isDevBundle,
          let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
          let data = try? Data(contentsOf: documents.appendingPathComponent("recording-finish-experiment.json")),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let raw = object["finalExportStrategy"] as? String else { return nil }
    return DurableFinalAssetExporter.Strategy(rawValue: raw)
  }

  /// DEV BENCHMARK ONLY. Request: {"id": 1, "sessionId": "<uuid>", "runs": ["reencode","packetPreserving", ...]}.
  /// Result: Documents/recording-export-bench-result.json ({"id", "runs": [{strategy, seconds, bytes, durationMs, ...}]}).
  private func runDevExportBenchmarkIfRequested() {
    guard DurableRecorderDiagnostics.isDevBundle,
          let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
          let data = try? Data(contentsOf: documents.appendingPathComponent("recording-export-bench.json")),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = request["id"] as? Int,
          let sessionId = request["sessionId"] as? String,
          let runs = request["runs"] as? [String] else { return }
    let resultURL = documents.appendingPathComponent("recording-export-bench-result.json")
    if let existing = try? Data(contentsOf: resultURL),
       let object = try? JSONSerialization.jsonObject(with: existing) as? [String: Any],
       object["id"] as? Int == id { return }
    Task.detached(priority: .userInitiated) { [weak self] in
      guard let self, let exporter = try? self.exporterResult.get() else { return }
      var results: [[String: Any]] = []
      for raw in runs {
        guard let strategy = DurableFinalAssetExporter.Strategy(rawValue: raw) else { continue }
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("export-bench-\(UUID().uuidString).m4a")
        let appState = await MainActor.run { () -> String in
          #if os(iOS)
          switch UIApplication.shared.applicationState {
          case .active: return "active"
          case .inactive: return "inactive"
          default: return "background"
          }
          #else
          return "n/a"
          #endif
        }
        do {
          var run = try await exporter.benchmark(recordingSessionId: sessionId, strategy: strategy, scratchURL: scratch)
          run["appStateAtStart"] = appState
          results.append(run)
        } catch {
          results.append(["strategy": raw, "error": String(describing: error), "appStateAtStart": appState])
        }
        let payload: [String: Any] = ["id": id, "sessionId": sessionId, "runs": results, "complete": results.count == runs.count]
        if let out = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) {
          try? out.write(to: resultURL, options: .atomic)
        }
      }
    }
  }

  /// Dev-only Finish-stage evidence (one JSON line per stage in the session's diagnostics.jsonl). Never throws.
  private func traceFinish(_ sessionId: String, _ kind: String, _ extra: [String: Any]) {
    guard DurableRecorderDiagnostics.isDevBundle, let diagnostics = finishDiagnostics else { return }
    finishTraceLock.lock(); defer { finishTraceLock.unlock() }
    var event = extra
    event["kind"] = kind
    diagnostics.emit(sessionId: sessionId, event)
    diagnostics.flush()
  }

  private func withStore<T>(_ operation: (DurableRecorderStore) throws -> T) throws -> T {
    do {
      return try operation(storeResult.get())
    } catch let error as DurableRecorderCoreError {
      throw moduleException(error)
    } catch {
      throw storageException(error)
    }
  }

  private func withEngine<T>(_ operation: (DurableForegroundRecorder) throws -> T) throws -> T {
    do {
      return try operation(ensureStatusBridge(engineResult.get()))
    } catch let error as DurableRecorderCoreError {
      throw moduleException(error)
    } catch {
      throw storageException(error)
    }
  }

  private func ensureStatusBridge(_ engine: DurableForegroundRecorder) -> DurableForegroundRecorder {
    if !statusBridgeInstalled {
      engine.onStatusChange = { [weak self] payload in
        // Expo event delivery must happen on the main queue.
        DispatchQueue.main.async {
          self?.sendEvent("onRecordingStatusChange", payload)
        }
      }
      statusBridgeInstalled = true
    }
    return engine
  }

  private func moduleException(_ error: DurableRecorderCoreError) -> Exception {
    Exception(name: "DurableRecorderError", description: error.message, code: error.code)
  }

  private func parseLegacyAudioInput(_ input: [String: Any]) throws -> (lectureId: String, orderedSources: [(role: String, uri: String)]) {
    guard let lectureId = input["lectureId"] as? String, !lectureId.isEmpty else {
      throw legacyAssemblyException(.invalidLectureId)
    }
    guard let rawSources = input["sources"] as? [[String: Any]], !rawSources.isEmpty else {
      throw legacyAssemblyException(.noSources)
    }
    var orderedSources: [(role: String, uri: String)] = []
    for raw in rawSources {
      guard let role = raw["role"] as? String, !role.isEmpty,
            let uri = raw["uri"] as? String, !uri.isEmpty else {
        throw legacyAssemblyException(.invalidSourceList)
      }
      orderedSources.append((role: role, uri: uri))
    }
    return (lectureId, orderedSources)
  }

  private func legacyAssemblyException(_ error: LegacyAudioAssemblyError) -> Exception {
    Exception(name: "LegacyAudioAssemblyError", description: error.message, code: error.code)
  }

  private func storageException(_ error: Error) -> Exception {
    Exception(
      name: "DurableRecorderError",
      description: error.localizedDescription,
      code: "ERR_DURABLE_RECORDER_STORAGE"
    )
  }
}
