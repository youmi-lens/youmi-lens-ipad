import ExpoModulesCore

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
    DurableFinalAssetExporter(store: try storeResult.get())
  }
  private var statusBridgeInstalled = false

  public func definition() -> ModuleDefinition {
    Name("ExpoDurableRecorder")

    Events("onRecordingStatusChange")

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      [
        "moduleAvailable": true,
        "contractVersion": 1,
        "platform": "ios",
        "implementation": "native-foreground-audio"
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
      try self.withEngine { engine in
        try engine.stopRecording(recordingSessionId: input.recordingSessionId)
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
      do {
        return try await self.exporterResult.get().export(recordingSessionId: input.recordingSessionId)
      } catch let error as DurableRecorderCoreError {
        throw self.moduleException(error)
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

  private func storageException(_ error: Error) -> Exception {
    Exception(
      name: "DurableRecorderError",
      description: error.localizedDescription,
      code: "ERR_DURABLE_RECORDER_STORAGE"
    )
  }
}
