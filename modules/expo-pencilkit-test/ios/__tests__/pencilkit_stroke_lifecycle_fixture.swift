// PK3-A ownership-fix — proves the authoritative PencilKit stroke-lifecycle
// API this fix relies on: PKCanvasViewDelegate.canvasViewDidBeginUsingTool(_:)
// / .canvasViewDidEndUsingTool(_:), read directly from this SDK's real
// PKCanvasView.h (NOT from memory — that header documents these as "Called
// when the user starts/stops using a tool, eg. selecting, drawing, or
// erasing," i.e. exactly the BEGIN/END stroke-lifecycle pair PK3-A needs, two
// events per stroke, no per-move traffic).
//
// This is a structural/compile-time proof (conformance + assignability),
// like the other fixtures in this project — actually driving a live Pencil
// touch through the delegate is not reproducible in a headless swiftc/simctl
// binary and is instead verified by the owner's physical test.
import PencilKit
import UIKit

final class ProbeDelegate: NSObject, PKCanvasViewDelegate {
  var beganCount = 0
  var endedCount = 0
  func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) { beganCount += 1 }
  func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) { endedCount += 1 }
}

func run() {
  let canvas = PKCanvasView(frame: CGRect(x: 0, y: 0, width: 300, height: 300))
  let delegate = ProbeDelegate()
  canvas.delegate = delegate
  precondition(canvas.delegate === delegate, "PKCanvasView.delegate must accept a PKCanvasViewDelegate-conforming object")

  // Directly invoke the two lifecycle methods the way PencilKit itself would
  // (compile-time proof they exist with this exact signature/selector and
  // are reachable through the assigned delegate).
  delegate.canvasViewDidBeginUsingTool(canvas)
  delegate.canvasViewDidEndUsingTool(canvas)
  precondition(delegate.beganCount == 1 && delegate.endedCount == 1, "begin/end lifecycle methods must be independently callable, once each")

  print("PENCILKIT_STROKE_LIFECYCLE_PASS")
}
run()
