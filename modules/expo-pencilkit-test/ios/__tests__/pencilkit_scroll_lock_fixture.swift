// Compiled standalone against only PencilKit + UIKit (system frameworks) —
// NOT the actual PencilKitTestView class, which depends on ExpoModulesCore
// (a CocoaPods dependency unavailable to a standalone swiftc/simctl compile
// outside the full Xcode project build). This proves the underlying SDK fact
// our production code relies on: does UIScrollView is defined and behave as
// PencilKitTestModule.swift assumes for a real PKCanvasView. The Node harness
// (scripts/notebook-pencilkit-viewport-gesture.test.mjs) separately proves,
// via source-text inspection, that PencilKitTestView actually sets
// `isScrollEnabled = false` — the two together are the closest available
// proof this repo's fixture infrastructure can give without importing
// ExpoModulesCore into a bare swiftc compile.
import PencilKit
import UIKit

func run() {
  let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 300, height: 300))

  // Baseline: PKCanvasView starts with pan enabled (ordinary UIScrollView
  // default) and pinch NOT enabled (zooming is opt-in — no delegate/
  // viewForZooming/non-default zoom scale configured here or in our
  // production init, so pinch was never live in the first place).
  precondition(canvas.panGestureRecognizer.isEnabled, "expected pan enabled before isScrollEnabled=false")

  canvas.isScrollEnabled = false
  precondition(!canvas.panGestureRecognizer.isEnabled, "isScrollEnabled=false must disable panGestureRecognizer")
  precondition(!(canvas.pinchGestureRecognizer?.isEnabled ?? false), "pinchGestureRecognizer must be disabled")

  // Drawing must remain fully independent of the scroll-lock — Apple
  // Pencil must still be able to draw after isScrollEnabled=false.
  canvas.drawingPolicy = .pencilOnly
  precondition(canvas.drawingGestureRecognizer.isEnabled, "drawingGestureRecognizer must remain enabled")

  print("PENCILKIT_SCROLL_LOCK_PASS")
}
run()
