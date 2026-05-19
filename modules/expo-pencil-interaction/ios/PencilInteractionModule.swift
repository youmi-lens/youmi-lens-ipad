import ExpoModulesCore
import UIKit

/**
 * Receives Apple Pencil double-tap events from `UIPencilInteraction` and
 * forwards them to a JS callback.
 *
 * `pencilInteractionDidTap(_:)` is delivered whenever the user double-taps a
 * supported Apple Pencil while the app is in the foreground. The method is
 * marked deprecated on iPadOS 17.5+ but is still delivered there, so it remains
 * the simplest cross-version way to observe the double-tap.
 */
final class PencilTapReceiver: NSObject, UIPencilInteractionDelegate {
  var onDoubleTap: (() -> Void)?

  func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
    onDoubleTap?()
  }
}

/**
 * Optional Expo module exposing Apple Pencil double-tap as a JS event.
 *
 * This module is compiled only into development/standalone builds. It is absent
 * from Expo Go, where `requireOptionalNativeModule('ExpoPencilInteraction')`
 * returns `null` — see `lib/pencilInteraction.ts`.
 *
 * It registers a single `UIPencilInteraction` on the app's key window. The
 * interaction is attached when JS adds the first listener (`OnStartObserving`),
 * by which point the app UI — and therefore a key window — exists.
 */
public final class ExpoPencilInteractionModule: Module {
  private let receiver = PencilTapReceiver()
  private var interaction: UIPencilInteraction?

  public func definition() -> ModuleDefinition {
    Name("ExpoPencilInteraction")

    Events("onPencilDoubleTap")

    Function("isAvailable") { () -> Bool in
      true
    }

    OnCreate {
      self.receiver.onDoubleTap = { [weak self] in
        self?.sendEvent("onPencilDoubleTap", [:])
      }
    }

    OnStartObserving {
      self.attachInteraction()
    }
  }

  /// Attach the pencil interaction to the key window exactly once.
  private func attachInteraction() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.interaction == nil else { return }
      guard let hostView = Self.hostView() else { return }
      let interaction = UIPencilInteraction()
      interaction.delegate = self.receiver
      hostView.addInteraction(interaction)
      self.interaction = interaction
    }
  }

  /// The foreground key window — any visible view receives Pencil double-taps.
  private static func hostView() -> UIView? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    return windows.first(where: { $0.isKeyWindow }) ?? windows.first
  }
}
