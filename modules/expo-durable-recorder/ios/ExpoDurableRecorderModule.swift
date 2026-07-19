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

public final class ExpoDurableRecorderModule: Module {
  private lazy var storeResult = Result { try DurableRecorderStore() }

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
  }

  private func withStore<T>(_ operation: (DurableRecorderStore) throws -> T) throws -> T {
    do {
      return try operation(storeResult.get())
    } catch let error as DurableRecorderCoreError {
      throw moduleException(error)
    } catch {
      throw Exception(
        name: "DurableRecorderError",
        description: error.localizedDescription,
        code: "ERR_DURABLE_RECORDER_STORAGE"
      )
    }
  }

  private func moduleException(_ error: DurableRecorderCoreError) -> Exception {
    Exception(name: "DurableRecorderError", description: error.message, code: error.code)
  }
}
