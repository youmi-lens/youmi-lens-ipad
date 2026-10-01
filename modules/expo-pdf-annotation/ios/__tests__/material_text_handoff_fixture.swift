import UIKit
import PDFKit

enum TextInputProbe {
  static var onChange: (() -> Void)?
}

@main
final class TextHandoffFixture: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  var viewer: PdfAnnotationView!
  var link: CADisplayLink?
  var frames = 0
  var gaps = 0
  var doubles = 0
  var events = 0
  var queued: [String: Any]?
  var payload: [String: Any] = [:]
  var targetId = ""
  var expectedText = "ABC\n123"
  var beforeGeometry: CGRect = .zero
  var testCase = 0
  var totalGaps = 0
  var dismissScheduled = false
  var committedGlyph: CALayer?
  let labels = ["paste-top", "type-top", "paste-scrolled", "type-zoomed", "re-edit-top", "re-edit-zoomed"]
  var observing: Bool { CommandLine.arguments.contains("observe") }

  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window!.rootViewController = UIViewController()
    window!.makeKeyAndVisible()
    // Test-only watchdog; never compiled into the production module.
    DispatchQueue.main.asyncAfter(deadline: .now()+20) { fatalError("fixture input/transition timeout") }
    DispatchQueue.main.async { self.startCase() }
    return true
  }

  func startCase() {
    viewer?.removeFromSuperview()
    viewer = PdfAnnotationView()
    viewer.frame = window!.rootViewController!.view.bounds
    window!.rootViewController!.view.addSubview(viewer)
    let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { ctx in
      for _ in 0..<3 { ctx.beginPage() }
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("synthetic-handoff.pdf")
    try! pdf.write(to: url)
    viewer.layoutIfNeeded()
    viewer.annotationMode = "text"
    viewer.initialPage = testCase == 2 ? 2 : 1
    viewer.onLoadComplete.handler = { _ in DispatchQueue.main.async { self.beginLoadedCase() } }
    viewer.fileUri = url.absoluteString
  }

  func beginLoadedCase() {
    let pageIndex = testCase == 2 ? 1 : 0
    let page = viewer.document!.page(at: pageIndex)!
    if testCase == 3 || testCase == 5 { viewer.pdfView.scaleFactor = 1.7 }
    viewer.pdfView.go(to: PDFDestination(page: page, at: CGPoint(x: 0, y: 720)))
    viewer.pdfView.layoutDocumentView()
    frames = 0; gaps = 0; doubles = 0; events = 0; queued = nil; payload = [:]
    dismissScheduled = false
    targetId = testCase >= 4 ? "existing-synthetic" : ""
    expectedText = "ABC\n123"
    viewer.onTextAnnotationAction.handler = { event in
      self.events += 1
      self.queued = event
      self.targetId = event["annotationId"] as? String ?? "js-generated-synthetic"
      self.committedGlyph = self.viewer.annotationOverlay.pageTextLayers.values
        .flatMap { $0.sublayers ?? [] }.first { $0.name == self.targetId }
      self.trace("native-event-before-JS")
    }
    if testCase >= 4 {
      payload = ["id": targetId, "text": "old text", "x": 110.0, "y": 650.0, "width": 190.0, "fontSize": 16.0, "anchor": "top-left"]
      viewer.textAnnotationsByPage = ["1": [payload]]
      viewer.annotationOverlay.layer.displayIfNeeded()
      viewer.beginInlineTextEditing(TextAnnotationHit(id: targetId, text: "old text", pageNumber: 1, x: 110, y: 650, width: 190, fontSize: 16, anchor: "top-left"))
    } else {
      viewer.beginInlineTextCreation(at: CGPoint(x: 110, y: 650), pageNumber: pageIndex+1, page: page)
    }
    TextInputProbe.onChange = { [weak self] in
      guard let self, self.viewer.inlineTextEditor.text == self.expectedText, !self.dismissScheduled else { return }
      self.dismissScheduled = true
      DispatchQueue.main.async { self.dismiss() }
    }
    // Let UIKit keyboard/layout settle; then type or paste using actual text input.
    DispatchQueue.main.async {
      if self.testCase % 2 == 0 {
        UIPasteboard.general.string = self.expectedText
        self.viewer.inlineTextEditor.selectAll(nil)
        self.viewer.inlineTextEditor.paste(nil)
      } else {
        if self.testCase >= 4 { self.viewer.inlineTextEditor.text = "" }
        self.viewer.inlineTextEditor.insertText(self.expectedText)
      }
    }
  }

  func trace(_ event: String) {
    let editor = !viewer.inlineTextEditor.isHidden && !viewer.inlineTextEditor.text.isEmpty
    let glyphs = viewer.annotationOverlay.pageTextLayers.values.flatMap { $0.sublayers ?? [] }
      .compactMap { $0 as? CATextLayer }
      .filter { ($0.string as? NSAttributedString)?.string == expectedText }
    let count = (editor ? 1 : 0) + glyphs.count
    if count == 0 { gaps += 1 }
    if count > 1 { doubles += 1 }
    print("HANDOFF case=\(labels[testCase]) event=\(event) frame=\(frames) editor=\(editor) static=\(glyphs.count) representations=\(count) editorFrame=\(viewer.inlineTextEditor.frame)")
    if !observing { precondition(count == 1, "commit must have exactly one visible representation") }
  }

  func dismiss() {
    precondition(viewer.inlineTextEditor.text == expectedText, "paste/type did not populate editor")
    viewer.repositionInlineTextEditor()
    beforeGeometry = viewer.inlineTextEditor.frame
    viewer.annotationOverlay.layer.displayIfNeeded()
    trace("before-dismiss")
    // Actual first-responder resignation triggers textViewDidEndEditing.
    let resigned = viewer.inlineTextEditor.resignFirstResponder()
    precondition(resigned, "keyboard did not resign")
    trace("after-resign")
    link = CADisplayLink(target: self, selector: #selector(tick))
    link!.add(to: .main, forMode: .common)
  }

  @objc func tick() {
    frames += 1
    viewer.annotationOverlay.layer.displayIfNeeded()
    if frames <= 3 { trace("display-frame") }
    if frames == 3 {
      // An older React prop may reach native BEFORE the new commit echo.
      viewer.textAnnotationsByPage = testCase >= 4 ? ["1": [payload]] : [:]
      viewer.annotationOverlay.layer.displayIfNeeded()
      trace("stale-prop")
      if !observing {
        precondition(viewer.annotationOverlay.pageTextLayers.values.flatMap { $0.sublayers ?? [] }
          .first { $0.name == targetId } === committedGlyph, "stale echo recreated glyph")
      }
    }
    if frames == 5 {
      guard let event = queued else { fatalError("commit event missing") }
      if event["action"] as? String == "create" {
        payload = event
        payload["id"] = targetId
      } else { payload["text"] = event["text"] }
      viewer.textAnnotationsByPage = [String(event["pageNumber"] as! Int): [payload]]
      viewer.annotationOverlay.layer.displayIfNeeded()
      trace("JS-ack")
      if !observing {
        precondition(viewer.annotationOverlay.pendingTextCommits.isEmpty, "exact echo did not acknowledge commit")
        precondition(viewer.annotationOverlay.pageTextLayers.values.flatMap { $0.sublayers ?? [] }
          .first { $0.name == targetId } === committedGlyph, "ack recreated glyph")
      }
      precondition(events == 1, "resign caused duplicate commit")
      let layer = viewer.annotationOverlay.pageTextLayers[event["pageNumber"] as! Int]!
      let annotation = viewer.annotationOverlay.pagedTextAnnotations[event["pageNumber"] as! Int]!.first!
      let rect = PageTextAnnotationLayer.annotationFrame(annotation)
      let host = viewer.pdfView.documentView!
      let staticBounds = viewer.convert(host.convert(layer.convert(rect, to: host.layer), to: viewer.pdfView), from: viewer.pdfView)
      precondition(abs(staticBounds.minX-beforeGeometry.minX) < 0.1 && abs(staticBounds.minY-beforeGeometry.minY) < 0.1, "position changed during handoff")
    }
    if frames == 7 {
      link!.invalidate(); link = nil
      print("HANDOFF case=\(labels[testCase]) gaps=\(gaps) doubles=\(doubles) events=\(events)")
      totalGaps += gaps
      if !observing { precondition(gaps == 0 && doubles == 0) }
      testCase += 1
      if testCase < labels.count { startCase() }
      else {
        if !observing { verifyPendingIntents() }
        print(observing ? "HANDOFF_BASELINE_GAP_PROVEN gaps=\(totalGaps)" : "HANDOFF_FIX_PASS cases=6 gaps=0 doubles=0")
        if observing { precondition(totalGaps > 0) }
        fflush(stdout)
        exit(0)
      }
    }
  }

  func verifyPendingIntents() {
    viewer.onTextAnnotationAction.handler = nil
    TextInputProbe.onChange = nil
    let overlay = viewer.annotationOverlay
    let item = TextAnnotation(id: "pending-intent", text: "ABC\n123", x: 110, y: 650, width: 190, fontSize: 16, anchor: "top-left")
    let encoded: [String: Any] = ["id": item.id, "text": item.text, "x": item.x, "y": item.y, "width": item.width, "fontSize": item.fontSize, "anchor": "top-left"]
    overlay.stageTextCommit(id: item.id, pageNumber: 1, annotation: item)
    precondition(overlay.renderCommittedTextIfPossible(id: item.id, pageNumber: 1))
    viewer.setTextHistoryIntent(pageNumber: 1, annotations: [])
    viewer.textAnnotationsByPage = ["1": [encoded]] // older create echo after Undo
    precondition(overlay.pagedTextAnnotations[1]?.isEmpty == true, "Undo resurrected pending text")
    viewer.textAnnotationsByPage = ["1": []]
    precondition(overlay.pendingTextCommits.isEmpty)
    viewer.setTextHistoryIntent(pageNumber: 1, annotations: [encoded])
    viewer.textAnnotationsByPage = ["1": []] // older Undo echo after Redo
    precondition(overlay.pagedTextAnnotations[1]?.first == item, "Redo lost pending text")
    viewer.textAnnotationsByPage = ["1": [encoded]]
    precondition(overlay.pendingTextCommits.isEmpty)

    viewer.beginInlineTextEditing(TextAnnotationHit(id: item.id, text: item.text, pageNumber: 1, x: item.x, y: item.y, width: item.width, fontSize: item.fontSize, anchor: item.anchor))
    viewer.inlineTextEditor.text = ""
    viewer.commitInlineTextEditorIfNeeded()
    viewer.textAnnotationsByPage = ["1": [encoded]]
    precondition(overlay.pagedTextAnnotations[1]?.isEmpty == true, "empty edit resurrected old text")
    viewer.textAnnotationsByPage = ["1": []]
    precondition(overlay.pendingTextCommits.isEmpty)

    // Readiness failure: keep the real editor, then complete when the host returns.
    viewer.beginInlineTextCreation(at: CGPoint(x: 110, y: 650), pageNumber: 1, page: viewer.document!.page(at: 0)!)
    viewer.inlineTextEditor.text = "host-ready"
    overlay.pdfView = nil
    viewer.commitInlineTextEditorIfNeeded()
    precondition(!viewer.inlineTextEditor.isHidden && viewer.inlineTextEditor.text == "host-ready")
    precondition(viewer.pendingInlineTextHandoff != nil)
    overlay.pdfView = viewer.pdfView
    viewer.completeInlineTextHandoffIfReady()
    precondition(viewer.inlineTextEditor.isHidden && viewer.pendingInlineTextHandoff == nil)
    precondition(overlay.pageTextLayers[1]?.sublayers?.contains {
      (($0 as? CATextLayer)?.string as? NSAttributedString)?.string == "host-ready"
    } == true)
    print("HANDOFF_PENDING_INTENTS_PASS undo redo empty-edit host-readiness glyph-identity")
  }
}
