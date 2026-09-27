import ExpoModulesCore
import UIKit

/**
 * Pure observer of Apple Pencil touches — never drives activation, never
 * competes for a touch. `shouldRecognizeSimultaneouslyWith` unconditionally
 * returns true and `cancelsTouchesInView` is false, so this recognizer can
 * never fail or cancel Notebook's existing `react-native-gesture-handler`
 * Pan gesture; it only observes the same physical Pencil touch and reports
 * richer samples (coalesced points + normalized pressure + timestamp) for
 * whichever touch RNGH has already decided is a drawing stroke.
 *
 * `allowedTouchTypes = [.pencil]` means non-Pencil touches (finger, palm)
 * never reach these overrides at all — no explicit finger filtering needed.
 */
final class NotebookPencilSamplerGestureRecognizer: UIGestureRecognizer, UIGestureRecognizerDelegate {
  var onSample: ((NotebookPencilSample) -> Void)?

  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
    delegate = self
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
    allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }

  private func emit(_ phase: String, _ touch: UITouch) {
    onSample?(NotebookPencilSample(
      phase: phase,
      location: touch.location(in: view),
      force: touch.force,
      maximumPossibleForce: touch.maximumPossibleForce,
      timestamp: touch.timestamp
    ))
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard let touch = touches.first else { state = .failed; return }
    state = .began
    emit("began", touch)
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard let touch = touches.first else { return }
    state = .changed
    // Better spatial fidelity during fast handwriting: every coalesced
    // sub-sample for this exact touch, each with its own x/y/force/timestamp
    // read together (see NotebookPencilSample.init). Predicted touches are
    // deliberately not used — no evidence yet that Notebook needs them.
    let coalesced = event.coalescedTouches(for: touch) ?? [touch]
    for sample in coalesced {
      emit("moved", sample)
    }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    guard let touch = touches.first else { return }
    state = .ended
    emit("ended", touch)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    guard let touch = touches.first else { return }
    state = .cancelled
    emit("cancelled", touch)
  }
}

/**
 * Transparent overlay view: `NotebookCanvas.tsx` renders this absolutely
 * positioned over the exact same canvas surface RNGH's Pan gesture already
 * covers, so `touch.location(in: self)` yields the same raw coordinate space
 * as RNGH's own `touch.x`/`touch.y` for the same physical point — no new
 * transform is introduced; JS reuses its existing `touchToCanvasPoint`.
 *
 * Not a touch surface of its own accord in the exclusive sense: it never
 * blocks or delays anything underneath it (see the recognizer's
 * `cancelsTouchesInView`/simultaneous-recognition setup above).
 */
public final class NotebookPencilSamplerView: ExpoView {
  let onPencilSample = EventDispatcher()

  private lazy var recognizer: NotebookPencilSamplerGestureRecognizer = {
    let recognizer = NotebookPencilSamplerGestureRecognizer(target: nil, action: nil)
    recognizer.onSample = { [weak self] sample in
      self?.onPencilSample(sample.toDictionary())
    }
    return recognizer
  }()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = true
    addGestureRecognizer(recognizer)
  }
}

public final class ExpoNotebookPencilSamplerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoNotebookPencilSampler")

    View(NotebookPencilSamplerView.self) {
      Events("onPencilSample")
    }
  }
}
