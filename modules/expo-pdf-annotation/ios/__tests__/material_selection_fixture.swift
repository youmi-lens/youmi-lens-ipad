import UIKit
import PDFKit

@main
final class MaterialSelectionFixture: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window!.rootViewController = UIViewController()
    window!.makeKeyAndVisible()
    DispatchQueue.main.async { self.run() }
    return true
  }

  func run() {
    setvbuf(stdout, nil, _IONBF, 0)
    let viewer = PdfAnnotationView()
    viewer.frame = window!.bounds
    window!.rootViewController!.view.addSubview(viewer)
    let data = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { ctx in
      for _ in 0..<3 { ctx.beginPage() }
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("material-selection-fixture.pdf")
    try! data.write(to: url)
    viewer.layoutIfNeeded()
    viewer.fileUri = url.absoluteString
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
      guard let document = viewer.document, document.pageCount == 3 else { fatalError("PDF not loaded") }
      viewer.annotationsByPage = [
        "1": [
          ["id": "p1-selected", "tool": "pen", "color": "#061B34", "width": 2.4, "points": [[100.0, 600.0], [105.0, 595.0]]],
          ["id": "p1-other", "tool": "pen", "color": "#061B34", "width": 2.4, "points": [[400.0, 400.0]]],
        ],
        "2": [["id": "p2-selected", "tool": "highlighter", "color": "#F5D246", "width": 18.0, "points": [[100.0, 600.0], [105.0, 595.0]]]],
      ]
      viewer.textAnnotationsByPage = ["1": [["id": "p1-text", "text": "Hello", "x": 110.0, "y": 610.0, "width": 80.0, "fontSize": 16.0, "anchor": "top-left"]]]
      viewer.annotationMode = "select"
      let pencil = NSNumber(value: UITouch.TouchType.pencil.rawValue)
      let finger = NSNumber(value: UITouch.TouchType.direct.rawValue)
      precondition(viewer.selectionGesture.isEnabled && viewer.selectionGesture.allowedTouchTypes == [pencil], "only Pencil may create a selection")
      precondition(viewer.observedScrollView?.panGestureRecognizer.isEnabled ?? false, "finger PDF pan must stay available in Select")
      precondition((viewer.observedScrollView?.panGestureRecognizer.allowedTouchTypes as? [NSNumber])?.contains(finger) ?? false, "finger PDF pan must accept direct touch")
      viewer.pdfView.minScaleFactor = 0.25
      viewer.pdfView.maxScaleFactor = 5
      for scale: CGFloat in [0.5, 1, 2] {
        for number in [1, 2] {
          let page = document.page(at: number - 1)!
          viewer.pdfView.scaleFactor = scale
          viewer.pdfView.go(to: PDFDestination(page: page, at: CGPoint(x: 0, y: 720)))
          viewer.pdfView.layoutDocumentView()
          func select(_ pagePoints: [CGPoint], shape: String) -> (pageNumber: Int, strokeIds: [String]) {
            let overlay = viewer.annotationOverlay
            overlay.beginSelection(at: viewer.pdfView.convert(pagePoints[0], from: page), shape: shape)
            for point in pagePoints.dropFirst() { overlay.appendSelection(at: viewer.pdfView.convert(point, from: page)) }
            return overlay.finishSelection()!
          }
          let rect = select([CGPoint(x: 80, y: 570), CGPoint(x: 140, y: 640)], shape: "rect")
          precondition(rect.pageNumber == number)
          precondition(rect.strokeIds == [number == 1 ? "p1-selected" : "p2-selected"], "rect selected wrong page/ink at scale \(scale)")
          let lasso = select([CGPoint(x: 80, y: 590), CGPoint(x: 100, y: 640), CGPoint(x: 140, y: 620), CGPoint(x: 130, y: 570)], shape: "lasso")
          precondition(lasso.strokeIds == rect.strokeIds, "lasso missed sampled ink at scale \(scale)")
          print("SELECTION_PASS page=\(number) scale=\(scale) rect=\(rect.strokeIds) lasso=\(lasso.strokeIds) text_excluded=true")
        }
      }
      // A gesture that leaves page 1 still resolves only page-1 object IDs.
      let first = document.page(at: 0)!, second = document.page(at: 1)!
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      let overlay = viewer.annotationOverlay
      overlay.beginSelection(at: viewer.pdfView.convert(CGPoint(x: 80, y: 570), from: first), shape: "rect")
      overlay.appendSelection(at: viewer.pdfView.convert(CGPoint(x: 140, y: 640), from: first))
      overlay.appendSelection(at: viewer.pdfView.convert(CGPoint(x: 100, y: 600), from: second))
      // A region whose latest point left page 1 is clamped to page 1: it may select nothing (nil), never another page's ink.
      let boundary = overlay.finishSelection()
      precondition(boundary == nil || (boundary!.pageNumber == 1 && !boundary!.strokeIds.contains("p2-selected")), "selection leaked to another page")

      // Box is corner A -> latest point, not the bounds of a wandering path.
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      overlay.beginSelection(at: viewer.pdfView.convert(CGPoint(x: 80, y: 570), from: first), shape: "rect")
      overlay.appendSelection(at: viewer.pdfView.convert(CGPoint(x: 400, y: 780), from: first))
      overlay.appendSelection(at: viewer.pdfView.convert(CGPoint(x: 82, y: 572), from: first))
      precondition(overlay.finishSelection() == nil, "rect overshoot must use corner A to latest point (tiny box selects nothing)")
      print("SELECTION_BOX_CORNER_PASS")

      // ---- Ink geometry == Notebook's strokeToPath (M s0, Q s[i] mid(s[i],s[i+1]), L last)
      func elements(_ path: CGPath) -> [String] {
        var out: [String] = []
        path.applyWithBlock { e in
          let p = e.pointee.points
          switch e.pointee.type {
          case .moveToPoint: out.append("M \(p[0].x) \(p[0].y)")
          case .addLineToPoint: out.append("L \(p[0].x) \(p[0].y)")
          case .addQuadCurveToPoint: out.append("Q \(p[0].x) \(p[0].y) \(p[1].x) \(p[1].y)")
          default: out.append("?")
          }
        }
        return out
      }
      func expected(_ pts: [CGPoint]) -> [String] {
        var d = ["M \(pts[0].x) \(pts[0].y)"]
        if pts.count > 2 { for i in 1..<(pts.count - 1) {
          d.append("Q \(pts[i].x) \(pts[i].y) \((pts[i].x + pts[i + 1].x) / 2) \((pts[i].y + pts[i + 1].y) / 2)") } }
        d.append("L \(pts[pts.count - 1].x) \(pts[pts.count - 1].y)")
        return d
      }
      var sample: [CGPoint] = []
      for i in 0..<20 {
        let fi = CGFloat(i)
        sample.append(CGPoint(x: 100 + fi * 6, y: 300 + 20 * sin(fi / 2)))
      }
      let oneShot = PageInkStrokeLayer(color: "#061B34", width: 2, opacity: 1)
      oneShot.append(contentsOf: sample)
      let incremental = PageInkStrokeLayer(color: "#061B34", width: 2, opacity: 1)
      for i in stride(from: 0, to: sample.count, by: 3) { incremental.append(contentsOf: Array(sample[i..<min(i + 3, sample.count)])) }
      let want = expected(sample)
      let oneShotPath = (oneShot.sublayers!.compactMap { $0 as? CAShapeLayer }.first!).path!
      let incrementalPath = (incremental.sublayers!.compactMap { $0 as? CAShapeLayer }.first!).path!
      precondition(elements(oneShotPath) == want, "live geometry must equal Notebook strokeToPath")
      precondition(elements(incrementalPath) == want, "batching must not change geometry")
      // Long stroke (multiple chunks) stays continuous and ends at the last sample.
      let long = (0..<200).map { CGPoint(x: 50 + CGFloat($0) * 2.5, y: 400 + 30 * sin(CGFloat($0) / 7)) }
      let longLayer = PageInkStrokeLayer(color: "#061B34", width: 2, opacity: 1)
      for i in stride(from: 0, to: long.count, by: 7) { longLayer.append(contentsOf: Array(long[i..<min(i + 7, long.count)])) }
      let chunks = longLayer.sublayers!.compactMap { $0 as? CAShapeLayer }
      precondition(chunks.count > 1, "expected multiple chunks")
      for k in 0..<(chunks.count - 1) {
        let a = elements(chunks[k].path!), b = elements(chunks[k + 1].path!)
        let endOfA = a.last!.split(separator: " ").suffix(2).joined(separator: " ")
        precondition("M \(endOfA)" == b.first!, "chunk \(k) does not join chunk \(k + 1)")
      }
      precondition(elements(chunks.last!.path!).last == "L \(long.last!.x) \(long.last!.y)", "stroke must end at the last sample")
      print("INK_GEOMETRY_PASS chunks=\(chunks.count)")

      // ---- Micro-benchmark (simulator CPU, NOT device latency): previous per-point
      // polyline appender vs the batched Notebook-geometry layer, same 6-sample events.
      final class LegacyPolylineLayer: CALayer {
        private var chunk = CAShapeLayer(), path = CGMutablePath(), count = 0, lastPoint: CGPoint?
        override init() { super.init(); addSublayer(chunk); chunk.strokeColor = UIColor.black.cgColor; chunk.fillColor = nil }
        override init(layer: Any) { super.init(layer: layer) }
        required init?(coder: NSCoder) { fatalError() }
        func append(_ point: CGPoint) {
          if point == lastPoint { return }
          CATransaction.begin(); CATransaction.setDisableActions(true)
          if lastPoint == nil { path.move(to: point) } else {
            if count >= 32 { chunk = CAShapeLayer(); chunk.strokeColor = UIColor.black.cgColor; chunk.fillColor = nil; addSublayer(chunk); path = CGMutablePath(); if let l = lastPoint { path.move(to: l) }; count = 0 }
            path.addLine(to: point); chunk.path = path
          }
          count += 1; lastPoint = point; CATransaction.commit()
        }
      }
      let benchPoints = (0..<6000).map { CGPoint(x: 20 + CGFloat($0) * 0.4, y: 300 + 40 * sin(CGFloat($0) / 15)) }
      func time(_ body: () -> Void) -> Double { let s = ProcessInfo.processInfo.systemUptime; body(); return (ProcessInfo.processInfo.systemUptime - s) * 1000 }
      var legacyTransactions = 0
      let legacyMs = time { let l = LegacyPolylineLayer(); for p in benchPoints { l.append(p); legacyTransactions += 1 } }
      var newTransactions = 0
      let newMs = time { let l = PageInkStrokeLayer(color: "#061B34", width: 2, opacity: 1); for i in stride(from: 0, to: benchPoints.count, by: 6) { l.append(contentsOf: Array(benchPoints[i..<min(i + 6, benchPoints.count)])); newTransactions += 1 } }
      print("INK_BENCH points=6000 legacy_per_point_ms=\(String(format: "%.1f", legacyMs)) transactions=\(legacyTransactions) | batched_ms=\(String(format: "%.1f", newMs)) transactions=\(newTransactions)")

      // ---- Shape Snap (draw-and-hold), native side --------------------------------
      let originalDict = viewer.annotationsByPage
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      viewer.pdfView.layoutDocumentView()
      overlay.shapeSnapEnabled = true
      overlay.shapeSnapHoldSeconds = 0.15
      overlay.shapeSnapTolerancePt = 3.5
      var holds: [(token: Int, page: Int, points: [CGPoint])] = []
      overlay.onShapeHold = { token, page, pts in holds.append((token, page, pts)) }
      func sv(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
      func drawLine(to endX: CGFloat) {
        overlay.beginStroke(at: sv(100, 300), tool: "pen", color: "#061B34", width: 2.4)
        var x: CGFloat = 112
        while x <= endX { overlay.appendPoints(at: [sv(x, 300 + (x.truncatingRemainder(dividingBy: 24) == 0 ? 1.0 : -1.0))]); x += 12 }
      }
      func spin(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
      let loadsBeforeSnap = overlay.perf.loadCalls
      let drawsBeforeSnap = overlay.perf.drawPasses

      // 1. Ordinary stroke, Pencil lifts before the threshold: original stroke, no event.
      holds.removeAll()
      drawLine(to: 300)
      spin(0.05)
      let ordinary = overlay.endStroke()!
      spin(0.35)
      precondition(holds.isEmpty, "lifting before the hold threshold must never fire a hold")
      precondition(ordinary.stroke.points.count >= 10 && ordinary.stroke.points.first! != ordinary.stroke.points.last!, "the original handwritten stroke is kept")
      let originalPoints = ordinary.stroke.points
      overlay.loadAnnotations(originalDict)   // discard the committed test stroke from the model

      // 2. Hold reached: exactly one event, carrying the live points and a token.
      holds.removeAll()
      drawLine(to: 300)
      spin(0.35)
      precondition(holds.count == 1, "one hold event expected, got \(holds.count)")
      precondition(holds[0].page == 1 && holds[0].points.count >= 10, "hold event must carry the stroke")
      let token = holds[0].token

      // 3. A stale token is ignored; the right token swaps the live geometry.
      precondition(!overlay.applyShapeSnap(token: token + 1, points: [CGPoint(x: 100, y: 300), CGPoint(x: 300, y: 300)]), "stale token must be rejected")
      let clean = [CGPoint(x: 100, y: 300), CGPoint(x: 300, y: 300)]
      precondition(overlay.applyShapeSnap(token: token, points: clean), "matching token must apply")
      // Frozen preview: further Pencil samples are ignored until lift.
      overlay.appendPoints(at: [sv(320, 320), sv(340, 340)])
      let committed = overlay.endStroke()!
      precondition(committed.stroke.points == clean, "the snapped geometry is what commits on lift: \(committed.stroke.points)")
      precondition(!overlay.applyShapeSnap(token: token, points: clean), "no snap after the stroke ended")
      spin(0.3)
      precondition(holds.count == 1, "no second hold after commit")
      overlay.loadAnnotations(originalDict)

      // 4. Movement during the hold cancels it (restarts from the new anchor).
      holds.removeAll()
      drawLine(to: 300)
      spin(0.09)
      overlay.appendPoints(at: [sv(360, 300)])   // real movement > tolerance
      spin(0.09)
      precondition(holds.isEmpty, "movement during the hold must restart the timer")
      spin(0.25)
      precondition(holds.count == 1, "the hold fires once the NEW anchor has been still long enough")
      _ = overlay.endStroke()
      overlay.loadAnnotations(originalDict)

      // 5. Cancelled stroke: the timer dies with the stroke.
      holds.removeAll()
      drawLine(to: 300)
      overlay.cancelStroke()
      spin(0.4)
      precondition(holds.isEmpty, "a cancelled stroke must not fire a hold")

      // 6. Tiny tick / dot is never eligible.
      overlay.beginStroke(at: sv(100, 300), tool: "pen", color: "#061B34", width: 2.4)
      overlay.appendPoints(at: [sv(104, 300)])
      spin(0.4)
      _ = overlay.endStroke()
      precondition(holds.isEmpty, "a dot/tick must never be eligible")
      overlay.loadAnnotations(originalDict)

      // 7. Recognition/preview never touches props or redraws during the stroke.
      precondition(overlay.perf.loadCalls - loadsBeforeSnap == 4, "only the 4 explicit test resets may load annotations (hold/snap itself loads none), got \(overlay.perf.loadCalls - loadsBeforeSnap)")
      _ = drawsBeforeSnap
      overlay.shapeSnapEnabled = false
      _ = originalPoints
      print("SHAPE_SNAP_HOLD_PASS")

      // 8. Per-sample overhead of hold tracking on ordinary handwriting (simulator CPU, not device).
      func benchStroke(enabled: Bool) -> Double {
        overlay.shapeSnapEnabled = enabled
        overlay.shapeSnapHoldSeconds = 60
        overlay.beginStroke(at: sv(20, 300), tool: "pen", color: "#061B34", width: 2.4)
        let s = ProcessInfo.processInfo.systemUptime
        for i in 0..<3000 { overlay.appendPoints(at: [sv(20 + CGFloat(i) * 0.15, 300 + 60 * sin(CGFloat(i) / 40)), sv(20 + CGFloat(i) * 0.15 + 0.07, 300 + 60 * sin(CGFloat(i) / 40))]) }
        let ms = (ProcessInfo.processInfo.systemUptime - s) * 1000
        overlay.cancelStroke()
        return ms
      }
      _ = benchStroke(enabled: false)   // warm-up
      let offMs = benchStroke(enabled: false), onMs = benchStroke(enabled: true)
      print("SHAPE_SNAP_OVERHEAD samples=6000 tracking_off_ms=\(String(format: "%.1f", offMs)) tracking_on_ms=\(String(format: "%.1f", onMs))")
      overlay.shapeSnapEnabled = false

      // ---- loadAnnotations cost vs ink volume (simulator; native parse+compare only — the
      // JS->native tree conversion Expo does before this is NOT included, so real cost is higher).
      func bigDict(_ strokesPerPage: Int) -> [String: Any] {
        var d: [String: Any] = [:]
        for page in 1...3 {
          d["\(page)"] = (0..<strokesPerPage).map { i -> [String: Any] in
            ["id": "big-\(page)-\(i)", "tool": "pen", "color": "#061B34", "width": 2.4,
             "points": (0..<80).map { [Double(20 + $0), Double(100 + (i % 50) * 10) + sin(Double($0) / 5)] }]
          }
        }
        return d
      }
      for count in [50, 200, 600] {
        let dict = bigDict(count)
        overlay.loadAnnotations(dict)
        let unchangedMs = time { overlay.loadAnnotations(dict) }
        var changed = dict
        var p1 = changed["1"] as! [[String: Any]]
        p1[0]["width"] = 3.0
        changed["1"] = p1
        let changedMs = time { overlay.loadAnnotations(changed) }
        print("INK_LOAD_COST points=\(count * 3 * 80) identical_resend_ms=\(String(format: "%.1f", unchangedMs)) one_stroke_changed_ms=\(String(format: "%.1f", changedMs))")
      }
      overlay.loadAnnotations(originalDict)

      // ---- Prop resend with identical content must not redraw (setNeedsDisplay storm)
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      viewer.layoutIfNeeded()
      RunLoop.current.run(until: Date().addingTimeInterval(0.3))
      let dictionary = viewer.annotationsByPage
      let draws0 = overlay.perf.drawPasses, loads0 = overlay.perf.loadCalls, skipped0 = overlay.perf.loadSkipped
      for _ in 0..<50 { viewer.annotationsByPage = dictionary }
      RunLoop.current.run(until: Date().addingTimeInterval(0.3))
      precondition(overlay.perf.loadCalls - loads0 == 50 && overlay.perf.loadSkipped - skipped0 == 50, "identical resends must be skipped")
      precondition(overlay.perf.drawPasses == draws0, "identical resends must not trigger a draw pass (got \(overlay.perf.drawPasses - draws0))")
      print("INK_RESEND_NOOP_PASS resends=50 draws=\(overlay.perf.drawPasses - draws0) skipped=\(overlay.perf.loadSkipped - skipped0)")

      // Dragging selected ink: page-space delta at every zoom, unselected ink
      // untouched, outside-hit never moves, and ink stays on its page.
      for scale: CGFloat in [0.5, 1, 2] {
        viewer.pdfView.scaleFactor = scale
        viewer.pdfView.go(to: PDFDestination(page: first, at: CGPoint(x: 0, y: 720)))
        viewer.pdfView.layoutDocumentView()
        func v(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
        overlay.setSelection(pageNumber: 1, ids: ["p1-selected"])
        precondition(!overlay.beginMoveIfHit(at: v(300, 300)), "a Pencil-down outside the selection must start a new region, not a move")
        precondition(overlay.beginMoveIfHit(at: v(102, 598)), "a Pencil-down inside the selection must start a move")
        overlay.updateMove(at: v(122, 588))
        // LIVE: outline is glued to the dragged ink (original bounds + delta), page space.
        func near(_ a: CGRect, _ b: CGRect) -> Bool { abs(a.minX - b.minX) < 0.01 && abs(a.minY - b.minY) < 0.01 && abs(a.width - b.width) < 0.01 && abs(a.height - b.height) < 0.01 }
        func chrome() -> CGRect { overlay.selectionLayer!.path!.boundingBoxOfPath }
        precondition(near(chrome(), CGRect(x: 115, y: 580, width: 15, height: 15)), "live outline must follow the ink at scale \(scale): \(chrome())")
        let moved = overlay.finishMove()!
        // RELEASE: outline is recomputed from the FINAL moved geometry, with no residual offset.
        precondition(overlay.moveOffset == .zero && overlay.moveStartPagePoint == nil, "drag state must be cleared on release")
        precondition(near(chrome(), CGRect(x: 115, y: 580, width: 15, height: 15)), "released outline must stay around the moved ink at scale \(scale): \(chrome())")
        precondition(moved.pageNumber == 1 && moved.strokeIds == ["p1-selected"])
        precondition(abs(moved.dx - 20) < 0.01 && abs(moved.dy + 10) < 0.01, "move delta must be page-space at scale \(scale): \(moved.dx),\(moved.dy)")
        let strokes = overlay.pagedStrokes[1]!
        precondition(strokes.first { $0.id == "p1-selected" }!.points == [CGPoint(x: 120, y: 590), CGPoint(x: 125, y: 585)], "selected ink did not translate exactly")
        precondition(strokes.first { $0.id == "p1-other" }!.points == [CGPoint(x: 400, y: 400)], "unselected ink moved")
        // UNDO / REDO: an echo with the old / moved geometry re-anchors the outline.
        var undoDict = dictionary ?? [:]
        var movedDict = undoDict
        if var page1 = movedDict["1"] as? [[String: Any]] {
          for i in page1.indices where page1[i]["id"] as? String == "p1-selected" { page1[i]["points"] = [[120.0, 590.0], [125.0, 585.0]] }
          movedDict["1"] = page1
        }
        overlay.loadAnnotations(undoDict)
        precondition(near(chrome(), CGRect(x: 95, y: 590, width: 15, height: 15)), "Undo must put the outline back around the original ink: \(chrome())")
        overlay.loadAnnotations(movedDict)
        precondition(near(chrome(), CGRect(x: 115, y: 580, width: 15, height: 15)), "Redo must put the outline around the moved ink: \(chrome())")
        undoDict = [:]
        // Clamp: a huge drag cannot push ink off its page.
        precondition(overlay.beginMoveIfHit(at: v(122, 588)), "clamp begin")
        overlay.updateMove(at: v(122 + 5000, 588))
        let clamped = overlay.finishMove()!
        precondition(abs((120 + clamped.dx + 5) - 612) < 0.01, "ink must stop at the page edge, moved \(clamped.dx)")
        precondition(near(chrome(), CGRect(x: 115 + clamped.dx, y: 580, width: 15, height: 15)), "outline must stay glued at the clamped edge: \(chrome())")
        // Put it back exactly for the next scale.
        precondition(overlay.beginMoveIfHit(at: v(120 + clamped.dx + 2, 588)), "back begin")
        overlay.updateMove(at: v(120 + 2, 598))
        _ = overlay.finishMove()
        precondition(overlay.beginMoveIfHit(at: v(122, 588)), "restore begin")
        overlay.updateMove(at: v(102, 588))
        _ = overlay.finishMove()
        precondition(overlay.pagedStrokes[1]!.first { $0.id == "p1-selected" }!.points == [CGPoint(x: 100, y: 600), CGPoint(x: 105, y: 595)], "ink not restored exactly")
        overlay.setSelection(pageNumber: 1, ids: [])
        print("SELECTION_MOVE_PASS scale=\(scale)")
      }

      // Multiple selected strokes move and keep ONE shared outline.
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      viewer.pdfView.layoutDocumentView()
      overlay.setSelection(pageNumber: 1, ids: ["p1-selected", "p1-other"])
      precondition(overlay.beginMoveIfHit(at: viewer.pdfView.convert(CGPoint(x: 102, y: 598), from: first)))
      overlay.updateMove(at: viewer.pdfView.convert(CGPoint(x: 112, y: 608), from: first))
      let both = overlay.finishMove()!
      precondition(both.strokeIds == ["p1-other", "p1-selected"] && abs(both.dx - 10) < 0.01 && abs(both.dy - 10) < 0.01)
      let unionBox = overlay.selectionLayer!.path!.boundingBoxOfPath
      precondition(abs(unionBox.minX - 105) < 0.01 && abs(unionBox.maxX - 415) < 0.01 && abs(unionBox.minY - 395 - 0) < 20, "multi-stroke outline must wrap the union of the moved strokes: \(unionBox)")
      print("SELECTION_OUTLINE_PASS")
      overlay.setSelection(pageNumber: 1, ids: [])

      first.rotation = 90
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      viewer.pdfView.layoutDocumentView()
      overlay.beginSelection(at: viewer.pdfView.convert(CGPoint(x: 80, y: 570), from: first), shape: "rect")
      overlay.appendSelection(at: viewer.pdfView.convert(CGPoint(x: 140, y: 640), from: first))
      let rotated = overlay.finishSelection()!
      precondition(rotated.pageNumber == 1 && rotated.strokeIds == ["p1-selected"], "rotation broke page coordinate selection")
      precondition(overlay.beginMoveIfHit(at: viewer.pdfView.convert(CGPoint(x: 102, y: 598), from: first)), "rotated page must still hit-test the selection")
      overlay.updateMove(at: viewer.pdfView.convert(CGPoint(x: 122, y: 588), from: first))
      let rotatedMove = overlay.finishMove()!
      precondition(abs(rotatedMove.dx - 20) < 0.01 && abs(rotatedMove.dy + 10) < 0.01, "rotated page move must stay in page space")
      let rotatedChrome = overlay.selectionLayer!.path!.boundingBoxOfPath
      precondition(abs(rotatedChrome.midX - (overlay.pagedStrokes[1]!.first { $0.id == "p1-selected" }!.points.map(\.x).reduce(0, +) / 2)) < 0.5, "rotated page outline must stay around the moved ink")
      print("SELECTION_MOVE_ROTATED_PASS")
      print("SELECTION_BOUNDARY_ROTATION_PASS")
      // ================= Structured shapes (Shape System Phase 2) =================
      first.rotation = 0
      overlay.setSelection(pageNumber: 1, ids: [])
      func ptJSON(_ x: Double, _ y: Double) -> [String: Any] { ["x": x, "y": y] }
      let triShape: [String: Any] = ["origin": "triangle", "geometry": ["kind": "polygon", "vertices": [ptJSON(200, 500), ptJSON(300, 500), ptJSON(250, 600)]]]
      let circShape: [String: Any] = ["origin": "circle", "geometry": ["kind": "ellipse", "center": ptJSON(400, 300), "ax": ptJSON(40, 0), "ay": ptJSON(0, 40)]]
      let lineShape: [String: Any] = ["origin": "line", "geometry": ["kind": "line", "a": ptJSON(100, 150), "b": ptJSON(220, 190)]]
      var circPoints: [[Double]] = []
      for i in 0...60 {
        let t: Double = Double(i) / 60.0 * 2.0 * Double.pi
        circPoints.append([400.0 + 40.0 * cos(t), 300.0 + 40.0 * sin(t)])
      }
      func shapeDict(triVertexX: Double = 300, triVertexY: Double = 500) -> [String: Any] {
        let vertices = [ptJSON(200, 500), ptJSON(triVertexX, triVertexY), ptJSON(250, 600)]
        let editedTri: [String: Any] = ["origin": "triangle", "geometry": ["kind": "polygon", "vertices": vertices]]
        let ring: [[Double]] = [[200, 500], [triVertexX, triVertexY], [250, 600], [200, 500]]
        return ["1": [
          ["id": "tri", "tool": "pen", "color": "#061B34", "width": 3.0, "points": ring, "shape": triVertexX == 300 && triVertexY == 500 ? triShape : editedTri],
          ["id": "circ", "tool": "pen", "color": "#061B34", "width": 3.0, "points": circPoints, "shape": circShape],
          ["id": "ln", "tool": "pen", "color": "#061B34", "width": 3.0, "points": [[100.0, 150.0], [220.0, 190.0]], "shape": lineShape],
          ["id": "hand", "tool": "pen", "color": "#061B34", "width": 3.0, "points": [[500.0, 100.0], [520.0, 110.0], [540.0, 100.0]]],
        ]]
      }
      // The draw pass creates ink layers lazily; sync them like production does after each load.
      func loadShapes(_ d: [String: Any]) { overlay.loadAnnotations(d); overlay.syncPageInk() }
      viewer.annotationsByPage = shapeDict()
      loadShapes(shapeDict())
      let tri0 = overlay.pagedStrokes[1]!.first { $0.id == "tri" }!
      precondition(tri0.shape == StrokeShape.parse(triShape), "structured shape must parse into the native model")
      precondition(overlay.pagedStrokes[1]!.first { $0.id == "hand" }!.shape == nil, "ordinary handwriting must stay shapeless")
      let reserialized = viewer.serializeStroke(tri0)
      precondition(StrokeShape.parse(reserialized["shape"]) == tri0.shape, "serialize must round-trip the shape exactly")
      precondition(viewer.serializeStroke(overlay.pagedStrokes[1]!.first { $0.id == "hand" }!)["shape"] == nil, "ordinary ink serializes without a shape")

      // Swift edit semantics == TS `dragShapeHandle` (numbers pinned by scripts/annotation-shape.test.mjs).
      let c45 = cos(Double.pi / 4), s45 = sin(Double.pi / 4)
      let g0 = StrokeShapeGeometry.ellipse(center: CGPoint(x: 50, y: 50), ax: CGPoint(x: 40, y: 0), ay: CGPoint(x: 0, y: 40))
      precondition(g0.dragged(handle: 1, to: CGPoint(x: 190, y: 50)) == .ellipse(center: CGPoint(x: 100, y: 50), ax: CGPoint(x: 90, y: 0), ay: CGPoint(x: 0, y: 40)), "circle->ellipse right handle parity")
      let rotated0 = StrokeShapeGeometry.ellipse(center: .zero, ax: CGPoint(x: 50 * c45, y: 50 * s45), ay: CGPoint(x: -20 * s45, y: 20 * c45))
      if case let .ellipse(rc, rax, ray) = rotated0.dragged(handle: 1, to: CGPoint(x: 100 * c45 - 30 * s45, y: 100 * s45 + 30 * c45)) {
        precondition(abs(rc.x - 25 * c45) < 1e-9 && abs(rc.y - 25 * s45) < 1e-9 && abs(rax.x - 75 * c45) < 1e-9 && abs(rax.y - 75 * s45) < 1e-9 && abs(ray.x + 20 * s45) < 1e-9, "rotated ellipse axis drag parity")
      } else { fatalError("rotated ellipse must stay an ellipse") }
      precondition(StrokeShapeGeometry.polygon([CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 10), CGPoint(x: 40, y: 90)]).dragged(handle: 1, to: CGPoint(x: 150, y: -20)) == .polygon([CGPoint(x: 0, y: 0), CGPoint(x: 150, y: -20), CGPoint(x: 40, y: 90)]), "polygon vertex parity")
      precondition(g0.handles == [CGPoint(x: 50, y: 10), CGPoint(x: 90, y: 50), CGPoint(x: 50, y: 90), CGPoint(x: 10, y: 50)], "ellipse handle order [top,right,bottom,left]")
      print("NATIVE_SHAPE_MODEL_PASS")

      for scale: CGFloat in [0.5, 1, 2] {
        viewer.pdfView.scaleFactor = scale
        viewer.pdfView.go(to: PDFDestination(page: first, at: CGPoint(x: 0, y: 720)))
        viewer.pdfView.layoutDocumentView()
        func sv2(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
        loadShapes(shapeDict())
        overlay.setSelection(pageNumber: 1, ids: [])
        // TAP on the outline selects the shape (handles appear); tap on blank paper / handwriting does not.
        overlay.beginSelection(at: sv2(250, 500 + 3), shape: "lasso")
        let tapped = overlay.finishSelection()
        precondition(tapped?.strokeIds == ["tri"], "tap on a structured outline must select that shape at scale \(scale): \(String(describing: tapped))")
        let handleBox = overlay.handleLayer!.path!.boundingBoxOfPath
        let r = 9 / scale
        precondition(abs(handleBox.minX - (200 - r)) < 0.01 && abs(handleBox.maxX - (300 + r)) < 0.01 && abs(handleBox.minY - (500 - r)) < 0.01 && abs(handleBox.maxY - (600 + r)) < 0.01, "handles must be centred on the 3 vertices with a screen-constant radius at scale \(scale): \(handleBox)")
        precondition(overlay.selectionLayer?.path?.boundingBoxOfPath.isEmpty ?? true, "a single shape shows handles, not the dashed bounding box")
        overlay.setSelection(pageNumber: 1, ids: [])
        overlay.beginSelection(at: sv2(500, 700), shape: "lasso")
        precondition(overlay.finishSelection() == nil, "tap on blank paper must not select")
        overlay.setSelection(pageNumber: 1, ids: [])
        overlay.beginSelection(at: sv2(520, 110), shape: "lasso")
        precondition(overlay.finishSelection() == nil, "a tap on ordinary handwriting must not select a shape")

        // HANDLE DRAG: only that vertex changes; live preview is a lightweight layer; ONE event on release.
        overlay.setSelection(pageNumber: 1, ids: ["tri"])
        precondition(!overlay.beginHandleDragIfHit(at: sv2(250, 550)), "the shape body is not a handle")
        precondition(overlay.beginHandleDragIfHit(at: sv2(300 + 4 / scale, 500 - 4 / scale)), "a Pencil-down within 24pt of a vertex handle starts a reshape at scale \(scale)")
        overlay.updateHandleDrag(at: sv2(330 + 4 / scale, 520 - 4 / scale))
        precondition(overlay.shapePreviewLayer != nil && overlay.savedInkLayers["tri"]?.isHidden == true, "live preview replaces the stored layer during the drag")
        precondition(overlay.handleDrag!.geometry == .polygon([CGPoint(x: 200, y: 500), CGPoint(x: 330, y: 520), CGPoint(x: 250, y: 600)]), "only the dragged vertex moves (grab offset preserved): \(overlay.handleDrag!.geometry)")
        let edit = overlay.finishHandleDrag(at: sv2(330 + 4 / scale, 520 - 4 / scale))
        precondition(edit != nil && edit!.strokeId == "tri" && edit!.handleIndex == 1 && edit!.pageNumber == 1, "one edit event on release")
        precondition(abs(edit!.x - 330) < 0.05 && abs(edit!.y - 520) < 0.05, "reported handle target is the vertex position in page space at scale \(scale): \(edit!.x),\(edit!.y)")
        precondition(overlay.shapeEditAwaitingId == "tri" && overlay.shapePreviewLayer != nil, "preview stays until JS echoes the edit")
        precondition(overlay.pagedStrokes[1]!.first { $0.id == "tri" }!.shape == StrokeShape.parse(triShape), "native does not invent geometry: JS is authoritative")
        // ECHO from JS with the regenerated geometry: preview ends, handles follow the stored geometry.
        loadShapes(shapeDict(triVertexX: 330, triVertexY: 520))
        precondition(overlay.shapePreviewLayer == nil && overlay.shapeEditAwaitingId == nil, "echo of the edited stroke ends the live preview")
        precondition(overlay.savedInkLayers["tri"]?.isHidden != true, "stored ink is visible again after the echo")
        let echoedBox = overlay.handleLayer!.path!.boundingBoxOfPath
        precondition(abs(echoedBox.maxX - (330 + r)) < 0.01, "handles follow the edited geometry after the echo")
        // Undo echo (old geometry) restores handles at the old vertex.
        loadShapes(shapeDict())
        precondition(abs(overlay.handleLayer!.path!.boundingBoxOfPath.maxX - (300 + r)) < 0.01, "undo echo restores the original handles")
        // CANCEL: nothing changes.
        precondition(overlay.beginHandleDragIfHit(at: sv2(300, 500)), "begin again")
        overlay.updateHandleDrag(at: sv2(360, 540))
        overlay.cancelHandleDrag()
        precondition(overlay.shapePreviewLayer == nil && overlay.savedInkLayers["tri"]?.isHidden != true && overlay.handleDrag == nil, "cancel restores the original")
        precondition(overlay.finishHandleDrag(at: sv2(360, 540)) == nil, "no edit event after cancel")
        // A press on a handle without moving is not an edit.
        precondition(overlay.beginHandleDragIfHit(at: sv2(300, 500)), "begin no-move")
        precondition(overlay.finishHandleDrag(at: sv2(300, 500)) == nil && overlay.shapePreviewLayer == nil, "a stationary press is no edit")

        // ELLIPSE: circle -> ellipse via the right handle; opposite side anchored (local axis).
        overlay.setSelection(pageNumber: 1, ids: ["circ"])
        precondition(overlay.beginHandleDragIfHit(at: sv2(440, 300)), "right handle")
        overlay.updateHandleDrag(at: sv2(480, 300))
        precondition(overlay.handleDrag!.geometry == .ellipse(center: CGPoint(x: 420, y: 300), ax: CGPoint(x: 60, y: 0), ay: CGPoint(x: 0, y: 40)), "ellipse resize keeps the left side anchored: \(overlay.handleDrag!.geometry)")
        overlay.cancelHandleDrag()
        overlay.setSelection(pageNumber: 1, ids: [])

        // LINE: two handles.
        overlay.setSelection(pageNumber: 1, ids: ["ln"])
        precondition(overlay.handleLayer!.path!.boundingBoxOfPath.width > 120 + r, "a line has two end handles")
        overlay.setSelection(pageNumber: 1, ids: [])

        // BODY MOVE translates points AND geometry together (structured shape stays structured).
        overlay.setSelection(pageNumber: 1, ids: ["tri"])
        precondition(overlay.beginMoveIfHit(at: sv2(250, 540)), "body drag starts a move")
        overlay.updateMove(at: sv2(270, 530))
        let bodyMove = overlay.finishMove()!
        precondition(abs(bodyMove.dx - 20) < 0.01 && abs(bodyMove.dy + 10) < 0.01, "body move delta in page space")
        let movedTri = overlay.pagedStrokes[1]!.first { $0.id == "tri" }!
        precondition(movedTri.shape?.geometry == .polygon([CGPoint(x: 220, y: 490), CGPoint(x: 320, y: 490), CGPoint(x: 270, y: 590)]), "shape geometry translates with the ink: \(String(describing: movedTri.shape))")
        precondition(movedTri.points.first == CGPoint(x: 220, y: 490), "points translate with the geometry")
        overlay.setSelection(pageNumber: 1, ids: [])
        print("NATIVE_SHAPE_EDIT_PASS scale=\(scale)")
      }

      // ROTATED PAGE: handle drag still reports PAGE-space coordinates.
      first.rotation = 90
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      viewer.pdfView.layoutDocumentView()
      loadShapes(shapeDict())
      overlay.setSelection(pageNumber: 1, ids: ["tri"])
      precondition(overlay.beginHandleDragIfHit(at: viewer.pdfView.convert(CGPoint(x: 300, y: 500), from: first)), "rotated page handle hit")
      let rotatedEdit = overlay.finishHandleDrag(at: viewer.pdfView.convert(CGPoint(x: 340, y: 470), from: first))
      precondition(rotatedEdit != nil && abs(rotatedEdit!.x - 340) < 0.05 && abs(rotatedEdit!.y - 470) < 0.05, "rotated page: reported target in page space: \(String(describing: rotatedEdit))")
      overlay.clearShapeEditPreview()
      overlay.setSelection(pageNumber: 1, ids: [])
      first.rotation = 0
      print("NATIVE_SHAPE_ROTATED_PASS")
      print("NATIVE_SHAPE_FIXTURE_PASS")


      // ================= Selection interaction (state machine, finger move, pinch scale) =================
      first.rotation = 0
      overlay.setSelection(pageNumber: 1, ids: [])
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      viewer.pdfView.layoutDocumentView()

      // ---- The shared case table (scripts/fixtures/selection-machine-cases.json) against the Swift reducer.
      let casesJSON = #"""
__SELECTION_CASES_JSON__
"""#
      let cases = try! JSONSerialization.jsonObject(with: Data(casesJSON.utf8)) as! [[String: Any]]
      func decodeEvent(_ raw: [Any]) -> SelectionEvent {
        let name = raw[0] as! String
        let args = raw.dropFirst().map { $0 as! String }
        switch name {
        case "REGION_BEGIN_LASSO": return .beginRegion("lasso")
        case "REGION_COMPLETE": return .regionComplete(Array(args))
        case "REGION_DRAGGED": return .regionDragged
        case "REGION_CANCELLED": return .regionCancelled
        case "SELECT_INK": return .selectInk(Array(args))
        case "TAP_SHAPE": return .tapShape(args[0])
        case "TAP_BLANK": return .tapBlank
        case "BEGIN_MOVE": return .beginMove
        case "END_MOVE": return .endMove
        case "BEGIN_SCALE": return .beginScale
        case "END_SCALE": return .endScale
        case "BEGIN_HANDLE": return .beginHandle
        case "END_HANDLE": return .endHandle
        case "MANIPULATION_CANCELLED": return .manipulationCancelled
        case "TOOL_CHANGE": return .toolChange(args[0])
        case "DELETE": return .delete
        case "PAGE_CHANGE": return .pageChange(valid: args[0] == "valid")
        case "CONTENT_CHANGED": return .contentChanged(Array(args))
        case "CANCEL": return .cancel
        case "NOOP": return .noop(args[0])
        default: fatalError("unknown event \(name)")
        }
      }
      for c in cases {
        var state = SelectionState.idle
        var cleared: [String?] = []
        for raw in c["events"] as! [[Any]] {
          let (next, reason) = SelectionMachine.reduce(state, decodeEvent(raw))
          state = next
          cleared.append(reason)
        }
        let name = c["name"] as! String
        precondition(state.kind == (c["kind"] as! String), "machine parity kind: \(name) -> \(state.kind)")
        precondition(SelectionMachine.selectedIds(state) == (c["ids"] as! [String]), "machine parity ids: \(name)")
        let expectedCleared = (c["cleared"] as! [Any]).map { $0 as? String }
        precondition(cleared == expectedCleared, "machine parity cleared: \(name) \(cleared)")
      }
      print("NATIVE_SELECTION_MACHINE_PASS cases=\(cases.count)")

      // ---- Fixture data: one structured triangle + two ink strokes.
      func inkDict() -> [String: Any] {
        return ["1": [
          ["id": "tri", "tool": "pen", "color": "#061B34", "width": 3.0, "points": [[200.0, 500.0], [300.0, 500.0], [250.0, 600.0], [200.0, 500.0]], "shape": triShape],
          ["id": "hand", "tool": "pen", "color": "#061B34", "width": 3.0, "points": [[500.0, 100.0], [520.0, 110.0], [540.0, 100.0]]],
          ["id": "hand2", "tool": "pen", "color": "#123456", "width": 4.0, "opacity": 1.0, "points": [[510.0, 140.0], [560.0, 150.0]]],
          ["id": "far", "tool": "pen", "color": "#061B34", "width": 3.0, "points": [[100.0, 100.0], [110.0, 110.0]]],
        ]]
      }
      func loadInk(_ d: [String: Any]) { overlay.loadAnnotations(d); overlay.syncPageInk() }
      func close(_ a: CGFloat, _ b: CGFloat, _ eps: CGFloat = 1e-6) -> Bool { abs(a - b) <= eps }
      func closePt(_ a: CGPoint, _ b: CGPoint, _ eps: CGFloat = 1e-6) -> Bool { close(a.x, b.x, eps) && close(a.y, b.y, eps) }
      var reconciled: [(Int, [String])] = []
      let savedReconcileHandler = overlay.onSelectionReconciled
      overlay.onSelectionReconciled = { page, ids in reconciled.append((page, ids)) }

      // ---- PERSISTENCE: a tap-selected shape survives every ambient event.
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: PDFDestination(page: first, at: CGPoint(x: 0, y: 720)))
      viewer.pdfView.layoutDocumentView()
      func pv(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
      loadInk(inkDict())
      overlay.beginSelection(at: pv(250, 503), shape: "lasso")
      precondition(overlay.selectionStateKind == "SELECTING", "region begun")
      precondition(overlay.finishSelection()?.strokeIds == ["tri"], "tap selects the shape")
      precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer != nil, "shape selected with handles")
      for _ in 0..<5 { loadInk(inkDict()) }                                        // store echoes / prop reloads
      var changedFar = inkDict()
      var pageArray = changedFar["1"] as! [[String: Any]]
      pageArray[3]["points"] = [[100.0, 100.0], [111.0, 111.0]]                      // an UNRELATED stroke changed
      changedFar["1"] = pageArray
      loadInk(changedFar)
      overlay.refreshSelectionChrome()
      precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer?.superlayer != nil, "reloads never deselect the shape")
      precondition(reconciled.isEmpty, "no spurious selection change was reported")
      viewer.pdfView.scaleFactor = 1.0                                               // rerender / layout churn
      viewer.pdfView.layoutDocumentView()
      overlay.refreshSelectionChrome()
      precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer?.superlayer != nil, "layout churn never deselects the shape")
      // Handle drag completion keeps it selected with handles visible.
      precondition(overlay.beginHandleDragIfHit(at: pv(300, 500)), "handle grab")
      overlay.updateHandleDrag(at: pv(320, 520))
      _ = overlay.finishHandleDrag(at: pv(320, 520))
      precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer != nil, "handle-drag completion keeps the shape selected")
      loadInk(inkDict())                                                            // the echo of the edit (here: unchanged) arrives
      precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer != nil, "the echo after a handle edit keeps the selection")
      overlay.clearShapeEditPreview()
      // Pencil body move completion keeps it selected.
      precondition(overlay.beginMoveIfHit(at: pv(250, 550)), "body")
      overlay.updateMove(at: pv(260, 545))
      _ = overlay.finishMove()
      precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer != nil, "Pencil body move keeps the shape selected")
      loadInk(inkDict())
      overlay.setSelection(pageNumber: 1, ids: [])
      print("NATIVE_SELECTION_PERSIST_PASS")

      // ---- CANCEL is never a deselect; a new region only drops the old selection once it is a real drag.
      loadInk(inkDict())
      overlay.setSelection(pageNumber: 1, ids: ["tri"])
      overlay.beginSelection(at: pv(450, 300), shape: "lasso")                       // blank paper, region begins
      precondition(overlay.selectionStateKind == "SELECTING" && overlay.handleLayer != nil, "the previous selection stays visible while a region begins")
      overlay.cancelRegion()                                                         // recogniser cancelled / failed
      precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer != nil, "a cancelled region restores the previous selection")
      overlay.beginSelection(at: pv(450, 300), shape: "lasso")
      overlay.appendSelection(at: pv(451, 301))                                       // still a tap-sized wobble
      precondition(overlay.handleLayer != nil, "wobble below the tap threshold is not a new selection")
      overlay.appendSelection(at: pv(520, 380))                                       // a real drag
      precondition(overlay.handleLayer == nil && overlay.selectionLayer == nil, "a real region drag explicitly drops the previous selection")
      overlay.cancelRegion()
      precondition(overlay.selectionStateKind == "IDLE", "cancelling AFTER the explicit drop leaves nothing selected")
      overlay.setSelection(pageNumber: 1, ids: ["tri"])
      overlay.beginSelection(at: pv(450, 300), shape: "lasso")
      precondition(overlay.finishSelection() == nil && overlay.selectionStateKind == "IDLE" && overlay.handleLayer == nil, "a tap on blank paper is an explicit deselect")
      // A finger tap on blank paper deselects; a finger tap on a shape outline selects it.
      overlay.setSelection(pageNumber: 1, ids: ["tri"])
      precondition(overlay.fingerTap(at: pv(450, 300)) == nil && overlay.selectionStateKind == "IDLE", "finger blank tap deselects")
      precondition(overlay.fingerTap(at: pv(250, 503))?.strokeIds == ["tri"] && overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer != nil, "finger tap on the outline selects the shape")
      // Tool change away from Select is the other explicit deselect; switching TO select keeps it.
      overlay.toolChanged(to: "select")
      precondition(overlay.selectionStateKind == "SELECTED_SHAPE", "switching to select keeps the selection")
      overlay.toolChanged(to: "pen")
      precondition(overlay.selectionStateKind == "IDLE" && overlay.handleLayer == nil, "leaving Select deselects")
      print("NATIVE_SELECTION_CANCEL_PASS")

      // ---- RECONCILE: undo/redo/reload keep objects that still exist; drop only what is gone.
      reconciled.removeAll()
      loadInk(inkDict())
      overlay.setSelection(pageNumber: 1, ids: ["hand", "hand2"])
      var withoutHand2 = inkDict()
      var arr = withoutHand2["1"] as! [[String: Any]]
      arr.removeAll { ($0["id"] as! String) == "hand2" }
      withoutHand2["1"] = arr
      loadInk(withoutHand2)
      precondition(overlay.selectionStateKind == "SELECTED_INK" && reconciled.count == 1 && reconciled[0].1 == ["hand"], "undo removed one selected stroke: the rest stays selected")
      loadInk(inkDict())                                                              // redo brings hand2 back
      precondition(reconciled.count == 1, "a reload that changes nothing selected reports nothing")
      var withoutBoth = inkDict()
      var arr2 = withoutBoth["1"] as! [[String: Any]]
      arr2.removeAll { ($0["id"] as! String) == "hand" || ($0["id"] as! String) == "hand2" }
      withoutBoth["1"] = arr2
      loadInk(withoutBoth)
      precondition(overlay.selectionStateKind == "IDLE" && reconciled.last?.0 == 0 && reconciled.last?.1 == [], "every selected object gone -> object-removed")
      loadInk(inkDict())
      overlay.setSelection(pageNumber: 1, ids: ["tri"])
      var withoutTri = inkDict()
      var arr3 = withoutTri["1"] as! [[String: Any]]
      arr3.removeAll { ($0["id"] as! String) == "tri" }
      withoutTri["1"] = arr3
      loadInk(withoutTri)
      precondition(overlay.selectionStateKind == "IDLE", "undo of the shape clears its selection (object removed)")
      // Duplicate copies selected before native has them: a STALE reload must not drop them.
      loadInk(inkDict())
      overlay.setSelection(pageNumber: 1, ids: ["copy-1"])
      var stale = inkDict()
      var staleArr = stale["1"] as! [[String: Any]]
      staleArr[3]["points"] = [[100.0, 100.0], [112.0, 112.0]]
      stale["1"] = staleArr
      loadInk(stale)
      precondition(overlay.selectionStateKind == "SELECTED_INK", "a stale reload cannot drop copies that are still in flight")
      var withCopy = inkDict()
      var copyArr = withCopy["1"] as! [[String: Any]]
      copyArr.append(["id": "copy-1", "tool": "pen", "color": "#061B34", "width": 3.0, "points": [[300.0, 300.0], [310.0, 310.0]]])
      withCopy["1"] = copyArr
      loadInk(withCopy)
      precondition(overlay.selectionStateKind == "SELECTED_INK", "the copy arrived: still selected")
      loadInk(inkDict())                                                              // and undo removes it again
      precondition(overlay.selectionStateKind == "IDLE", "once seen, removing the copy clears the selection")
      overlay.onSelectionReconciled = savedReconcileHandler
      print("NATIVE_SELECTION_RECONCILE_PASS")

      // ---- SCALE LIMITS: pinned against the TS literals in scripts/selection-transform.test.mjs.
      let clampCases: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
        (0.05, 40, 1, 0.6), (0.05, 40, 0.5, 0.3), (0.05, 40, 2, 1.2), (100, 40, 1, 5), (1.5, 40, 1, 1.5),
        (0.01, 1000, 1, 0.2), (50, 1000, 1, 5), (10, 2000, 1, 3),
      ]
      for (factor, span, unitsPerPt, expected) in clampCases {
        precondition(close(SelectionLimits.clamp(factor, spanUnits: span, unitsPerPt: unitsPerPt), expected, 1e-9), "clamp parity \(factor) \(span) \(unitsPerPt)")
      }
      for bad: CGFloat in [0, -1, .nan, .infinity] { precondition(SelectionLimits.clamp(bad, spanUnits: 40, unitsPerPt: 1) == 1, "garbage factors are ignored") }
      print("NATIVE_SCALE_CLAMP_PASS")

      // ---- Finger routing + finger MOVE + two-finger SCALE at every zoom (outline stays attached, one commit).
      for scale: CGFloat in [0.5, 1, 2] {
        viewer.pdfView.scaleFactor = scale
        viewer.pdfView.go(to: PDFDestination(page: first, at: CGPoint(x: 0, y: 720)))
        viewer.pdfView.layoutDocumentView()
        func v(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
        func selBox() -> CGRect { overlay.selectionLayer!.path!.boundingBoxOfPath }
        func nearBox(_ a: CGRect, _ b: CGRect) -> Bool { close(a.minX, b.minX, 0.01) && close(a.minY, b.minY, 0.01) && close(a.width, b.width, 0.01) && close(a.height, b.height, 0.01) }
        loadInk(inkDict())
        overlay.setSelection(pageNumber: 1, ids: ["hand", "hand2"])
        // union bounds of hand+hand2: x 500..560, y 100..150 ; chrome adds a 5pt inset.
        let pad = SelectionLimits.touchPadPt / scale
        precondition(overlay.fingerHitsSelection(at: v(530, 125)), "finger inside the region is captured")
        precondition(overlay.fingerHitsSelection(at: v(560 + pad - 0.5, 125)), "the touch pad is \(SelectionLimits.touchPadPt)pt on screen at scale \(scale)")
        precondition(!overlay.fingerHitsSelection(at: v(560 + pad + 1, 125)), "outside the padded region the finger belongs to the page")
        precondition(!overlay.fingerHitsSelection(at: v(300, 300)), "far outside: page navigation")
        overlay.setSelection(pageNumber: 1, ids: [])
        precondition(!overlay.fingerHitsSelection(at: v(530, 125)), "nothing selected: every finger belongs to the page")
        overlay.setSelection(pageNumber: 1, ids: ["hand", "hand2"])

        // FINGER MOVE
        precondition(!overlay.beginMoveIfHit(at: v(300, 300), padPt: SelectionLimits.touchPadPt), "a finger outside never starts a move")
        precondition(overlay.beginMoveIfHit(at: v(530, 125), padPt: SelectionLimits.touchPadPt), "a finger inside starts the move")
        precondition(overlay.selectionStateKind == "MOVING_SELECTION", "moving state")
        overlay.updateMove(at: v(550, 115))
        precondition(nearBox(selBox(), CGRect(x: 515, y: 85, width: 70, height: 60)), "the outline follows the finger continuously at scale \(scale): \(selBox())")
        let moved = overlay.finishMove()!
        precondition(close(moved.dx, 20, 0.01) && close(moved.dy, -10, 0.01), "finger move delta is exact in page space")
        precondition(overlay.selectionStateKind == "SELECTED_INK", "finger release keeps the selection")
        precondition(nearBox(selBox(), CGRect(x: 515, y: 85, width: 70, height: 60)), "outline stays at the NEW position after release (no double offset): \(selBox())")
        precondition(overlay.moveOffset == .zero && overlay.moveStartPagePoint == nil, "drag state cleared")
        let movedHand = overlay.pagedStrokes[1]!.first { $0.id == "hand" }!
        precondition(closePt(movedHand.points[0], CGPoint(x: 520, y: 90), 0.01), "ink translated exactly")
        precondition(overlay.pagedStrokes[1]!.first { $0.id == "far" }!.points[0] == CGPoint(x: 100, y: 100), "unselected ink untouched")
        loadInk(inkDict())                                                            // UNDO echo: original geometry
        precondition(nearBox(selBox(), CGRect(x: 495, y: 95, width: 70, height: 60)), "undo puts the outline back around the original ink: \(selBox())")
        precondition(overlay.selectionStateKind == "SELECTED_INK", "undo keeps the selection (objects still exist)")
        print("NATIVE_FINGER_MOVE_PASS scale=\(scale)")

        // TWO-FINGER SCALE (both fingers inside): 20 -> 30 page units apart = 1.5x about the selection center.
        let center = CGPoint(x: 530, y: 125)
        precondition(overlay.beginScale(at: v(510, 125), and: v(530, 125)), "two fingers inside begin a scale")
        precondition(overlay.selectionStateKind == "SCALING_SELECTION", "scaling state")
        overlay.updateScale(at: v(505, 125), and: v(535, 125))
        precondition(overlay.scalePreviewLayers.count == 2 && overlay.savedInkLayers["hand"]?.isHidden == true, "live preview replaces the stored layers")
        precondition(nearBox(selBox(), CGRect(x: 530 - 30 * 1.5 - 5, y: 125 - 25 * 1.5 - 5, width: 60 * 1.5 + 10, height: 50 * 1.5 + 10)), "the outline scales with the content at scale \(scale): \(selBox())")
        precondition(overlay.scalePreviewLayers["hand2"]!.lineWidth == 4, "pen width is NOT scaled")
        // Wobble through many frames, then settle at 1.5 — the result may not drift.
        for i in 0..<200 {
          let d = 20 + 10 * CGFloat(i) / 199 + (i % 2 == 0 ? 6 : -6)
          overlay.updateScale(at: v(530 - d / 2, 125), and: v(530 + d / 2, 125))
        }
        let scaled = overlay.finishScale(at: v(515, 125), and: v(545, 125))!
        precondition(close(scaled.factor, 1.5, 1e-6), "final factor comes from the LAST fingers only: \(scaled.factor)")
        precondition(closePt(CGPoint(x: scaled.centerX, y: scaled.centerY), center, 1e-9), "scale anchor is the captured selection center")
        precondition(overlay.selectionStateKind == "SELECTED_INK" && overlay.scalePreviewLayers.isEmpty, "pinch end keeps the selection and removes the preview")
        let h1 = overlay.pagedStrokes[1]!.first { $0.id == "hand" }!
        let expected0 = CGPoint(x: center.x + (500 - center.x) * scaled.factor, y: center.y + (100 - center.y) * scaled.factor)
        precondition(closePt(h1.points[0], expected0, 1e-9), "points are ORIGINAL x factor, no drift: \(h1.points[0]) vs \(expected0)")
        precondition(h1.width == 3 && overlay.pagedStrokes[1]!.first { $0.id == "hand2" }!.width == 4 && overlay.pagedStrokes[1]!.first { $0.id == "hand2" }!.color == "#123456", "identity/style/width preserved")
        precondition(nearBox(selBox(), CGRect(x: 530 - 30 * 1.5 - 5, y: 125 - 25 * 1.5 - 5, width: 60 * 1.5 + 10, height: 50 * 1.5 + 10)), "committed outline matches the scaled content: \(selBox())")
        loadInk(inkDict())                                                            // UNDO echo
        precondition(nearBox(selBox(), CGRect(x: 495, y: 95, width: 70, height: 60)), "undo restores the exact outline: \(selBox())")
        // 0.5x pinch
        precondition(overlay.beginScale(at: v(505, 125), and: v(555, 125)), "second pinch")
        let half = overlay.finishScale(at: v(517.5, 125), and: v(542.5, 125))!
        // At 0.5x zoom the 60-unit selection is only 30pt on screen, so the shared 24pt floor legitimately clamps 0.5 up to 0.8.
        let expectedHalf = SelectionLimits.clamp(0.5, spanUnits: 60, unitsPerPt: 1 / scale)
        precondition(close(half.factor, expectedHalf, 1e-6), "1.0 -> 0.5 (clamped by the shared screen-point floor): \(half.factor)")
        if scale >= 1 { precondition(close(half.factor, 0.5, 1e-6), "1.0 -> 0.5 exactly when the floor does not bind") }
        else { precondition(close(half.factor, 0.8, 1e-6), "floor binds at 0.5x zoom") }
        loadInk(inkDict())
        // Tiny pinch clamps at the shared minimum (screen-point based).
        precondition(overlay.beginScale(at: v(505, 125), and: v(555, 125)), "third pinch")
        overlay.updateScale(at: v(529.99, 125), and: v(530.01, 125))
        let clamped = overlay.finishScale(at: v(529.99, 125), and: v(530.01, 125))!
        precondition(close(clamped.factor, SelectionLimits.clamp(0.0004, spanUnits: 60, unitsPerPt: 1 / scale), 1e-9) && clamped.factor > 0, "minimum clamp never collapses")
        loadInk(inkDict())
        // A pinch that never changed the size commits nothing and keeps the selection.
        precondition(overlay.beginScale(at: v(510, 125), and: v(530, 125)), "no-op pinch")
        precondition(overlay.finishScale(at: v(510, 125), and: v(530, 125)) == nil && overlay.selectionStateKind == "SELECTED_INK", "a pinch that does not resize is not an edit")
        // Cancelled pinch: restores everything.
        precondition(overlay.beginScale(at: v(510, 125), and: v(530, 125)), "cancelled pinch")
        overlay.updateScale(at: v(500, 125), and: v(540, 125))
        overlay.cancelScale()
        precondition(overlay.scalePreviewLayers.isEmpty && overlay.savedInkLayers["hand"]?.isHidden != true && overlay.selectionStateKind == "SELECTED_INK", "cancel restores the original and keeps the selection")
        // A move that a second finger upgrades to a scale begins from the ORIGINAL geometry.
        precondition(overlay.beginMoveIfHit(at: v(530, 125), padPt: SelectionLimits.touchPadPt), "move first")
        overlay.updateMove(at: v(560, 130))
        precondition(overlay.beginScale(at: v(510, 125), and: v(530, 125)) && overlay.moveOffset == .zero, "the move preview is discarded when the second finger joins")
        overlay.cancelScale()

        // STRUCTURED SHAPE: body move by finger and pinch keep it a selected shape with handles.
        loadInk(inkDict())
        overlay.setSelection(pageNumber: 1, ids: ["tri"])
        precondition(overlay.beginMoveIfHit(at: v(250, 550), padPt: SelectionLimits.touchPadPt), "finger body drag on the shape")
        overlay.updateMove(at: v(270, 540))
        _ = overlay.finishMove()
        precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer != nil, "finger body move keeps the shape selected with handles")
        precondition(overlay.pagedStrokes[1]!.first { $0.id == "tri" }!.shape?.geometry == .polygon([CGPoint(x: 220, y: 490), CGPoint(x: 320, y: 490), CGPoint(x: 270, y: 590)]), "shape geometry moved with the body")
        loadInk(inkDict())
        overlay.setSelection(pageNumber: 1, ids: ["tri"])
        precondition(overlay.beginScale(at: v(230, 540), and: v(270, 540)), "two fingers on the shape")
        overlay.updateScale(at: v(220, 540), and: v(280, 540))
        let handleBox = overlay.handleLayer!.path!.boundingBoxOfPath
        let hr = 9 / scale
        precondition(close(handleBox.minX, 175 - hr, 0.01) && close(handleBox.maxX, 325 + hr, 0.01), "handles scale live with the shape at scale \(scale): \(handleBox)")
        let shapeScaled = overlay.finishScale(at: v(220, 540), and: v(280, 540))!
        precondition(overlay.selectionStateKind == "SELECTED_SHAPE" && overlay.handleLayer != nil, "shape pinch keeps the shape selected with handles")
        if case let .polygon(vertices)? = overlay.pagedStrokes[1]!.first(where: { $0.id == "tri" })!.shape?.geometry {
          precondition(closePt(vertices[0], CGPoint(x: 250 + (200 - 250) * shapeScaled.factor, y: 550 + (500 - 550) * shapeScaled.factor), 1e-9), "shape vertices scale about the selection center")
        } else { fatalError("triangle must stay a polygon") }
        loadInk(inkDict())
        overlay.setSelection(pageNumber: 1, ids: [])
        print("NATIVE_PINCH_SCALE_PASS scale=\(scale)")
      }
      print("NATIVE_FINGER_ROUTING_PASS")

      // ---- ROTATED PAGE: finger move + pinch are computed in PAGE space.
      first.rotation = 90
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      viewer.pdfView.layoutDocumentView()
      func rv(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
      loadInk(inkDict())
      overlay.setSelection(pageNumber: 1, ids: ["hand", "hand2"])
      precondition(overlay.fingerHitsSelection(at: rv(530, 125)), "rotated page: finger hit-test")
      precondition(overlay.beginMoveIfHit(at: rv(530, 125), padPt: SelectionLimits.touchPadPt), "rotated finger move")
      overlay.updateMove(at: rv(550, 115))
      let rotMoved = overlay.finishMove()!
      precondition(close(rotMoved.dx, 20, 0.05) && close(rotMoved.dy, -10, 0.05), "rotated page: finger move delta stays in page space: \(rotMoved.dx),\(rotMoved.dy)")
      loadInk(inkDict())
      precondition(overlay.beginScale(at: rv(510, 125), and: rv(530, 125)), "rotated pinch")
      let rotScaled = overlay.finishScale(at: rv(505, 125), and: rv(535, 125))!
      precondition(close(rotScaled.factor, 1.5, 1e-6) && close(rotScaled.centerX, 530, 1e-6) && close(rotScaled.centerY, 125, 1e-6), "rotated page: factor and anchor in page space: \(rotScaled)")
      loadInk(inkDict())
      overlay.setSelection(pageNumber: 1, ids: [])
      first.rotation = 0
      print("NATIVE_SELECTION_ROTATED_PASS")
      print("NATIVE_SELECTION_INTERACTION_PASS")


      // ================= REAL device ellipse through the native commit path (regression) =================
      // The exact ellipse recognized on the iPad (Course Material, aspect 0.44, rotated 54 degrees).
      first.rotation = 0
      overlay.setSelection(pageNumber: 1, ids: [])
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: PDFDestination(page: first, at: CGPoint(x: 0, y: 720)))
      viewer.pdfView.layoutDocumentView()
      func ev(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
      func subpaths(_ layer: CAShapeLayer?) -> Int {
        var moves = 0
        layer?.path?.applyWithBlock { e in if e.pointee.type == .moveToPoint { moves += 1 } }
        return moves
      }
      let realJSON = #"{"origin":"ellipse","geometry":{"kind":"ellipse","center":{"x":331.7667,"y":388.3742},"ax":{"x":40.62165,"y":55.68978},"ay":{"x":-24.49018,"y":17.86381}}}"#
      let realShape = try! JSONSerialization.jsonObject(with: Data(realJSON.utf8)) as! [String: Any]
      let realParsed = StrokeShape.parse(realShape)
      precondition(realParsed != nil, "the real recognized ellipse must parse natively")
      overlay.beginStroke(at: ev(372.4, 444.1), tool: "pen", color: "#061B34", width: 2.4)
      var realRing: [CGPoint] = []
      for i in 0...120 {
        let t = Double(i) / 120.0 * 2 * Double.pi
        realRing.append(CGPoint(x: 331.7667 + 40.62165 * cos(t) - 24.49018 * sin(t), y: 388.3742 + 55.68978 * cos(t) + 17.86381 * sin(t)))
      }
      precondition(overlay.applyShapeSnap(token: overlay.strokeToken, points: realRing, shape: realParsed), "snap applied to the live stroke")
      let realCommit = overlay.endStroke()
      var committedIds: [String] = []
      precondition(realCommit?.stroke.shape != nil, "a snapped ellipse is committed as a STRUCTURED shape")
      let realWire = viewer.serializeStroke(realCommit!.stroke)
      precondition(realWire["shape"] != nil, "the structured ellipse survives serialization")
      let realBack = try! JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: ["1": [realWire]])) as! [String: Any]
      overlay.loadAnnotations(realBack)
      overlay.syncPageInk()
      precondition(overlay.pagedStrokes[1]!.first { $0.id == realCommit!.stroke.id }!.shape != nil, "and the JS echo (reload) keeps it structured")
      overlay.beginSelection(at: ev(realRing[0].x + 2, realRing[0].y), shape: "lasso")
      precondition(overlay.finishSelection()?.strokeIds == [realCommit!.stroke.id] && overlay.selectionStateKind == "SELECTED_SHAPE", "tapping the real ellipse selects it")
      precondition(subpaths(overlay.handleLayer) == 4, "the real ellipse shows exactly FOUR handles")
      overlay.setSelection(pageNumber: 1, ids: [])
      committedIds.append(realCommit!.stroke.id)
      overlay.markStrokeRemovalIntent(ids: committedIds)   // undo of the test stroke, as JS does
      loadInk(inkDict())
      committedIds.removeAll()
      print("NATIVE_REAL_ELLIPSE_PASS")

      // ================= DIRECT SHAPE TAP from Pen / Highlighter (no switch to Select) =================
      let polyQuad: [String: Any] = ["origin": "rectangle", "geometry": ["kind": "polygon", "vertices": [ptJSON(100, 300), ptJSON(200, 300), ptJSON(200, 380), ptJSON(100, 380)]]]
      let ellShape: [String: Any] = ["origin": "ellipse", "geometry": ["kind": "ellipse", "center": ptJSON(400, 400), "ax": ptJSON(120, 72), "ay": ptJSON(-36, 60)]]
      func ring(_ shape: [String: Any]) -> [[Double]] {
        let g = shape["geometry"] as! [String: Any]
        if (g["kind"] as! String) == "polygon" {
          let v = (g["vertices"] as! [[String: Any]]).map { [$0["x"] as! Double, $0["y"] as! Double] }
          return v + [v[0]]
        }
        let c = g["center"] as! [String: Any], ax = g["ax"] as! [String: Any], ay = g["ay"] as! [String: Any]
        var out: [[Double]] = []
        for i in 0...120 {
          let t = Double(i) / 120.0 * 2 * Double.pi
          out.append([(c["x"] as! Double) + (ax["x"] as! Double) * cos(t) + (ay["x"] as! Double) * sin(t), (c["y"] as! Double) + (ax["y"] as! Double) * cos(t) + (ay["y"] as! Double) * sin(t)])
        }
        return out
      }
      func directDict() -> [String: Any] {
        var d = inkDict()
        var page = d["1"] as! [[String: Any]]
        page.append(["id": "quad", "tool": "pen", "color": "#061B34", "width": 3.0, "points": ring(polyQuad), "shape": polyQuad])
        page.append(["id": "ell", "tool": "pen", "color": "#061B34", "width": 3.0, "points": ring(ellShape), "shape": ellShape])
        d["1"] = page
        return d
      }
      viewer.penColor = "#112233"
      viewer.penWidth = 5
      viewer.highlighterColor = "#FFE066"
      viewer.annotationMode = "pen"
      for scale: CGFloat in [0.5, 1, 2] {
        viewer.pdfView.scaleFactor = scale
        viewer.pdfView.go(to: PDFDestination(page: first, at: CGPoint(x: 0, y: 720)))
        viewer.pdfView.layoutDocumentView()
        func dv(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
        loadInk(directDict())
        overlay.setSelection(pageNumber: 1, ids: [])
        func tap(_ tool: String, at p: CGPoint) -> String? {
          overlay.beginStroke(at: p, tool: tool, color: tool == "pen" ? viewer.penColor : viewer.highlighterColor, width: tool == "pen" ? viewer.penWidth : viewer.highlighterWidth)
          overlay.appendPoints(at: [CGPoint(x: p.x + 0.5, y: p.y + 0.5)])
          guard let hit = overlay.penTapShapeTarget() else { return nil }
          overlay.cancelStroke()
          overlay.selectShapeFromPenTap(hit.stroke, pageNumber: hit.pageNumber)
          return hit.stroke.id
        }
        // Pen active + tap triangle / quadrilateral / ellipse -> SELECTED_SHAPE with 3 / 4 / 4 handles.
        precondition(tap("pen", at: dv(250, 500)) == "tri" && overlay.selectionStateKind == "SELECTED_SHAPE" && subpaths(overlay.handleLayer) == 3, "pen tap triangle -> 3 handles at \(scale)")
        let quadHit = tap("pen", at: dv(150, 300))
        precondition(quadHit == "quad", "pen tap quadrilateral selects it at scale \(scale): got \(String(describing: quadHit))")
        precondition(overlay.selectionStateKind == "SELECTED_SHAPE", "quad kind \(overlay.selectionStateKind)")
        precondition(subpaths(overlay.handleLayer) == 4, "pen tap quadrilateral -> 4 handles, got \(subpaths(overlay.handleLayer))")
        // Ellipse: tap each arc (local-axis extrema) and a 45 degree arc point -> hit, 4 handles.
        let cx: CGFloat = 400, cy: CGFloat = 400
        let extrema: [(String, CGPoint)] = [("top", CGPoint(x: cx + 36, y: cy - 60)), ("right", CGPoint(x: cx + 120, y: cy + 72)), ("bottom", CGPoint(x: cx - 36, y: cy + 60)), ("left", CGPoint(x: cx - 120, y: cy - 72))]
        for (name, p) in extrema {
          overlay.setSelection(pageNumber: 1, ids: [])
          precondition(tap("pen", at: dv(p.x, p.y)) == "ell" && subpaths(overlay.handleLayer) == 4, "pen tap ellipse \(name) arc -> 4 handles at scale \(scale)")
        }
        let t45 = Double.pi / 4
        let arc45 = CGPoint(x: cx + 120 * CGFloat(cos(t45)) - 36 * CGFloat(sin(t45)), y: cy + 72 * CGFloat(cos(t45)) + 60 * CGFloat(sin(t45)))
        overlay.setSelection(pageNumber: 1, ids: [])
        precondition(tap("pen", at: dv(arc45.x, arc45.y)) == "ell", "pen tap 45-degree arc hits")
        // Just outside the screen-point tolerance misses; the empty interior / center is NOT a hit.
        overlay.setSelection(pageNumber: 1, ids: [])
        let unit = 1 / scale
        precondition(tap("pen", at: dv(cx + 120 + 16 * unit + 4 * unit, cy + 72 + 4 * unit)) == nil, "just outside tolerance misses at \(scale)")
        overlay.cancelStroke()
        precondition(tap("pen", at: dv(cx, cy)) == nil, "the center of a large empty ellipse is not an outline hit")
        overlay.cancelStroke()
        // Highlighter active + tap -> selected.
        overlay.setSelection(pageNumber: 1, ids: [])
        precondition(tap("highlighter", at: dv(250, 500)) == "tri" && overlay.selectionStateKind == "SELECTED_SHAPE", "highlighter tap selects the shape")
        overlay.setSelection(pageNumber: 1, ids: [])
        // Pen active + a real stroke BEGINNING on the shape is handwriting, not selection.
        overlay.beginStroke(at: dv(250, 500), tool: "pen", color: viewer.penColor, width: viewer.penWidth)
        overlay.appendPoints(at: [dv(262, 512), dv(280, 528), dv(300, 540)])
        precondition(overlay.penTapShapeTarget() == nil, "a drag from a shape is ordinary Pen writing")
        let dragCommit = overlay.endStroke()
        precondition(dragCommit != nil && overlay.selectionStateKind == "IDLE", "and it commits as ink without selecting anything")
        committedIds.append(dragCommit!.stroke.id)
        // A slow press (longer than the tap window) is a deliberate mark.
        overlay.beginStroke(at: dv(250, 500), tool: "pen", color: viewer.penColor, width: viewer.penWidth)
        RunLoop.current.run(until: Date().addingTimeInterval(AnnotationOverlay.penTapMaxDurationSeconds + 0.12))
        precondition(overlay.penTapShapeTarget() == nil, "a slow press on a shape is not a tap")
        if let slow = overlay.endStroke() { committedIds.append(slow.stroke.id) }
        // A hold-snapped stroke is never a tap.
        overlay.beginStroke(at: dv(250, 500), tool: "pen", color: viewer.penColor, width: viewer.penWidth)
        _ = overlay.applyShapeSnap(token: overlay.strokeToken, points: ring(polyQuad).map { CGPoint(x: $0[0], y: $0[1]) }, shape: StrokeShape.parse(polyQuad))
        precondition(overlay.penTapShapeTarget() == nil, "a snapped stroke is never a tap")
        if let snappedCommit = overlay.endStroke() { committedIds.append(snappedCommit.stroke.id) }
        // Blank-paper tap keeps ordinary Pen behavior: the dot is committed.
        overlay.beginStroke(at: dv(450, 650), tool: "pen", color: viewer.penColor, width: viewer.penWidth)
        precondition(overlay.penTapShapeTarget() == nil, "blank tap is not a shape tap")
        let dot = overlay.endStroke()
        precondition(dot != nil && dot!.stroke.points.count == 1 && dot!.stroke.shape == nil, "the ordinary dot is preserved")
        committedIds.append(dot!.stroke.id)
        overlay.markStrokeRemovalIntent(ids: committedIds)   // the test strokes are undone before the next zoom level
        committedIds.removeAll()
        loadInk(directDict())
        // Pen-down elsewhere releases a shape selected by a tap; on a handle / the outline it does not.
        loadInk(directDict())
        overlay.setSelection(pageNumber: 1, ids: ["tri"])
        precondition(!overlay.penDownDeselectIfElsewhere(at: dv(300, 500)) && overlay.selectionStateKind == "SELECTED_SHAPE", "Pencil on a handle keeps the selection")
        precondition(!overlay.penDownDeselectIfElsewhere(at: dv(250, 502)) && overlay.selectionStateKind == "SELECTED_SHAPE", "Pencil on the outline keeps the selection (re-tap)")
        precondition(overlay.penDownDeselectIfElsewhere(at: dv(450, 650)) && overlay.selectionStateKind == "IDLE", "Pencil-down elsewhere releases it")
        overlay.setSelection(pageNumber: 1, ids: ["tri"])
        precondition(overlay.clearSelectionAfterInk() && overlay.selectionStateKind == "IDLE", "writing releases a leftover selection")
        // Ellipse drag from Pen mode: 4 handles persist through release; local axes change.
        overlay.setSelection(pageNumber: 1, ids: ["ell"])
        precondition(overlay.beginHandleDragIfHit(at: dv(520, 472)), "right handle grabbed with a drawing tool active")
        overlay.updateHandleDrag(at: dv(545, 490))
        if case let .ellipse(_, ax, ay)? = overlay.handleDrag?.geometry {
          precondition(!(close(ax.x, 120) && close(ax.y, 72)) && closePt(ay, CGPoint(x: -36, y: 60), 1e-6), "right handle changes only the horizontal local axis")
        } else { fatalError("ellipse drag geometry") }
        let ellEdit = overlay.finishHandleDrag(at: dv(545, 490))
        precondition(ellEdit != nil && overlay.selectionStateKind == "SELECTED_SHAPE" && subpaths(overlay.handleLayer) == 4, "handle release keeps all four handles")
        overlay.clearShapeEditPreview()
        loadInk(directDict())
        overlay.setSelection(pageNumber: 1, ids: ["ell"])
        precondition(overlay.beginHandleDragIfHit(at: dv(436, 340)), "top handle")
        overlay.updateHandleDrag(at: dv(450, 300))
        if case let .ellipse(_, ax, ay)? = overlay.handleDrag?.geometry {
          precondition(closePt(ax, CGPoint(x: 120, y: 72), 1e-6) && !closePt(ay, CGPoint(x: -36, y: 60), 1e-3), "top handle changes only the vertical local axis")
        } else { fatalError("ellipse drag geometry") }
        overlay.cancelHandleDrag()
        overlay.setSelection(pageNumber: 1, ids: [])
        print("NATIVE_PEN_TAP_PASS scale=\(scale)")
      }
      // The user's tool is untouched by all of the above.
      precondition(viewer.annotationMode == "pen" && viewer.penColor == "#112233" && viewer.penWidth == 5 && viewer.highlighterColor == "#FFE066", "Pen tool, colour and width unchanged by shape interaction")
      print("NATIVE_PEN_TOOL_STATE_PASS")

      // Pinned against the TS literals in scripts/annotation-shape.test.mjs (ellipse TOP handle, anchored bottom).
      let g1 = StrokeShapeGeometry.ellipse(center: .zero, ax: CGPoint(x: 50, y: 0), ay: CGPoint(x: 0, y: 30))
      precondition(g1.dragged(handle: 0, to: CGPoint(x: 0, y: -80)) == .ellipse(center: CGPoint(x: 0, y: -25), ax: CGPoint(x: 50, y: 0), ay: CGPoint(x: 0, y: 55)), "ellipse top-handle parity")
      precondition(g1.dragged(handle: 3, to: CGPoint(x: -90, y: 0)) == .ellipse(center: CGPoint(x: -20, y: 0), ax: CGPoint(x: 70, y: 0), ay: CGPoint(x: 0, y: 30)), "ellipse left-handle parity")
      print("NATIVE_ELLIPSE_HANDLES_PASS")

      // Rotated page: the direct tap is decided in PAGE space.
      first.rotation = 90
      viewer.pdfView.scaleFactor = 1
      viewer.pdfView.go(to: first)
      viewer.pdfView.layoutDocumentView()
      func rv2(_ x: CGFloat, _ y: CGFloat) -> CGPoint { viewer.pdfView.convert(CGPoint(x: x, y: y), from: first) }
      loadInk(directDict())
      overlay.beginStroke(at: rv2(520, 472), tool: "pen", color: viewer.penColor, width: viewer.penWidth)
      overlay.appendPoints(at: [rv2(520.3, 472.3)])
      let rotatedTap = overlay.penTapShapeTarget()
      precondition(rotatedTap?.stroke.id == "ell", "rotated page: tapping the ellipse's right arc selects it")
      overlay.cancelStroke()
      overlay.selectShapeFromPenTap(rotatedTap!.stroke, pageNumber: rotatedTap!.pageNumber)
      precondition(subpaths(overlay.handleLayer) == 4, "rotated page: four handles")
      overlay.setSelection(pageNumber: 1, ids: [])
      first.rotation = 0
      viewer.annotationMode = "select"
      print("NATIVE_PEN_TAP_ROTATED_PASS")

      viewer.annotationMode = "scroll"
      precondition(!viewer.selectionGesture.isEnabled && (viewer.observedScrollView?.panGestureRecognizer.isEnabled ?? false), "Hand mode must restore PDF pan")
      print("NATIVE_SELECTION_FIXTURE_PASS")
      fflush(stdout)
      exit(0)
    }
  }
}
