import ExpoModulesCore
import PDFKit
import UIKit

public final class ExpoPdfAnnotationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoPdfAnnotation")

    AsyncFunction("exportAnnotatedPdfAsync") { (options: [String: Any]) throws -> String in
      try PdfAnnotatedExporter.export(options: options)
    }

    View(PdfAnnotationView.self) {
      Events(
        "onPageChanged",
        "onLoadComplete",
        "onViewportChanged",
        "onError",
        "onAnnotationsChanged",
        "onEraserGestureEnded",
        "onTextAnnotationAction",
        "onSelectionChanged",
        "onSelectionMoved",
        "onShapeEdited",
        "onSelectionScaled",
        "onPencilActivity",
        "onShapeHold",
        "onViewportDiagnostic"
      )

      Prop("fileUri") { (view: PdfAnnotationView, fileUri: String?) in
        view.fileUri = fileUri
      }

      Prop("initialPage") { (view: PdfAnnotationView, initialPage: Int?) in
        view.initialPage = initialPage ?? 1
      }
      Prop("initialViewport") { (view: PdfAnnotationView, value: [String: Any]?) in
        view.initialViewport = value
      }

      Prop("annotationMode") { (view: PdfAnnotationView, mode: String?) in
        view.annotationMode = mode ?? "scroll"
      }
      Prop("selectionShape") { (view: PdfAnnotationView, shape: String?) in
        view.selectionShape = shape == "rect" ? "rect" : "lasso"
      }

      Prop("shapeSnapEnabled") { (view: PdfAnnotationView, enabled: Bool?) in
        view.shapeSnapEnabled = enabled ?? false
      }
      Prop("shapeSnapHoldMs") { (view: PdfAnnotationView, ms: Double?) in
        view.shapeSnapHoldMs = ms ?? 650
      }
      Prop("shapeSnapTolerancePt") { (view: PdfAnnotationView, pt: Double?) in
        view.shapeSnapTolerancePt = pt ?? 3.5
      }

      Prop("penColor") { (view: PdfAnnotationView, color: String?) in
        view.penColor = color ?? "#061B34"
      }

      Prop("penWidth") { (view: PdfAnnotationView, width: Double?) in
        view.penWidth = width ?? 2.4
      }

      Prop("highlighterColor") { (view: PdfAnnotationView, color: String?) in
        view.highlighterColor = color ?? "#FFE066"
      }

      Prop("highlighterWidth") { (view: PdfAnnotationView, width: Double?) in
        view.highlighterWidth = width ?? 18
      }

      Prop("eraserRadius") { (view: PdfAnnotationView, radius: Double?) in
        view.eraserRadius = radius ?? 26
      }

      Prop("annotationsByPage") { (view: PdfAnnotationView, value: [String: Any]?) in
        view.annotationsByPage = value
      }

      Prop("appendedBlankPageCount") { (view: PdfAnnotationView, value: Int?) in
        view.appendedBlankPageCount = max(0, value ?? 0)
      }

      Prop("textAnnotationsByPage") { (view: PdfAnnotationView, value: [String: Any]?) in
        view.textAnnotationsByPage = value
      }

      AsyncFunction("setPageAsync") { (view: PdfAnnotationView, pageNumber: Int) in
        view.setPage(pageNumber)
      }
      AsyncFunction("setAnnotationModeAsync") { (view: PdfAnnotationView, mode: String) in
        view.annotationMode = mode
      }
      AsyncFunction("flushViewportAsync") { (view: PdfAnnotationView) in
        view.flushViewport()
      }
      AsyncFunction("captureViewportAsync") { (view: PdfAnnotationView) -> [String: Any] in
        view.captureViewportPayload()
      }
      AsyncFunction("markStrokeRemovalIntentAsync") { (view: PdfAnnotationView, ids: [String]) in
        view.markStrokeRemovalIntent(ids: ids)
      }
      AsyncFunction("markStrokeRestorationIntentAsync") { (view: PdfAnnotationView, ids: [String]) in
        view.markStrokeRestorationIntent(ids: ids)
      }
      AsyncFunction("setTextHistoryIntentAsync") { (view: PdfAnnotationView, pageNumber: Int, annotations: [[String: Any]]) in
        view.setTextHistoryIntent(pageNumber: pageNumber, annotations: annotations)
      }
      AsyncFunction("applyShapeSnapAsync") { (view: PdfAnnotationView, token: Int, points: [[Double]], shape: [String: Any]?) in
        view.applyShapeSnap(token: token, points: points, shape: shape)
      }
      AsyncFunction("clearSelectionAsync") { (view: PdfAnnotationView) in
        view.clearSelection()
      }
      AsyncFunction("setSelectionAsync") { (view: PdfAnnotationView, pageNumber: Int, ids: [String]) in
        view.setSelection(pageNumber: pageNumber, ids: ids)
      }
    }
  }
}

/** Sequential, vector-first copy of the immutable source PDF plus Youmi layers. */
enum PdfAnnotatedExporter {
  static func export(options: [String: Any]) throws -> String {
    guard let fileUri = options["fileUri"] as? String,
          let url = fileUri.hasPrefix("file://") ? URL(string: fileUri) : URL(fileURLWithPath: fileUri),
          let document = PDFDocument(url: url) else {
      throw NSError(domain: "ExpoPdfAnnotation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Source PDF could not be opened."])
    }
    let sourcePages = min(document.pageCount, max(1, options["sourcePageCount"] as? Int ?? document.pageCount))
    let appended = max(0, options["appendedBlankPageCount"] as? Int ?? 0)
    let exportPages = sourcePages + max(0, appended - 1)
    let strokes = options["annotationsByPage"] as? [String: Any] ?? [:]
    let texts = options["textAnnotationsByPage"] as? [String: Any] ?? [:]
    let finalBounds = document.page(at: max(0, sourcePages - 1))?.bounds(for: .mediaBox) ?? CGRect(x: 0, y: 0, width: 612, height: 792)
    let destination = FileManager.default.temporaryDirectory.appendingPathComponent("Youmi-Lens-Annotated-\(UUID().uuidString).pdf")
    let renderer = UIGraphicsPDFRenderer(bounds: finalBounds)
    try renderer.writePDF(to: destination) { rendererContext in
      for index in 0..<exportPages {
        let page = index < sourcePages ? document.page(at: index) : nil
        let bounds = page?.bounds(for: .mediaBox) ?? finalBounds
        rendererContext.beginPage(withBounds: bounds, pageInfo: [:])
        let context = rendererContext.cgContext
        if let page {
          // UIGraphicsPDFRenderer hands out a context in the top-left-origin,
          // y-down (UIKit) coordinate convention. PDFPage.draw(with:to:) draws
          // assuming the standard PDF bottom-left-origin, y-up convention —
          // calling it directly here rendered every exported page vertically
          // mirrored (proven via an isolated fixture export: TOP/BOTTOM swapped,
          // every glyph upside-down). This flips the context to PDF's own
          // convention for just this one draw call, then restores it so the
          // annotation drawing below (already authored for this context's
          // native y-down convention) is unaffected.
          context.saveGState()
          context.translateBy(x: 0, y: bounds.height)
          context.scaleBy(x: 1, y: -1)
          page.draw(with: .mediaBox, to: context)
          context.restoreGState()
        }
        drawStrokes(strokes[String(index + 1)] as? [[String: Any]] ?? [], context: context, pageHeight: bounds.height)
        drawText(texts[String(index + 1)] as? [[String: Any]] ?? [], context: context, pageHeight: bounds.height)
      }
    }
    return destination.absoluteString
  }

  private static func drawStrokes(_ strokes: [[String: Any]], context: CGContext, pageHeight: CGFloat) {
    // Stroke points are captured and stored in PDF PAGE space — bottom-left
    // origin, y-UP (PdfAnnotationView captures them via
    // `pdfView.convert(viewPoint, to: page)`). The export context supplied by
    // UIGraphicsPDFRenderer is top-left origin, y-DOWN. The base page above is
    // flipped to draw correctly, then restored to y-down before annotations
    // draw — so stroke points must be flipped here to `pageHeight - y`, the
    // same convention drawText already uses for this same y-down context, or
    // every stroke renders vertically mirrored relative to the (correct) base
    // page (physically observed: printed content upright, handwriting
    // upside-down). Proven by the rendered geometry fixture in
    // __tests__/pdf_export_annotation_orientation_fixture.swift.
    for stroke in strokes {
      guard let raw = stroke["points"] as? [[Double]], let first = raw.first, first.count >= 2 else { continue }
      context.saveGState()
      if (stroke["tool"] as? String) == "highlighter" { context.setBlendMode(.multiply) }
      context.setStrokeColor(PdfExporterColor(hex: stroke["color"] as? String ?? "#061B34").withAlphaComponent(CGFloat(stroke["opacity"] as? Double ?? ((stroke["tool"] as? String) == "highlighter" ? 0.34 : 1))).cgColor)
      context.setLineWidth(CGFloat(stroke["width"] as? Double ?? 2.4)); context.setLineCap(.round); context.setLineJoin(.round)
      context.move(to: CGPoint(x: first[0], y: pageHeight - first[1]))
      for point in raw.dropFirst() where point.count >= 2 { context.addLine(to: CGPoint(x: point[0], y: pageHeight - point[1])) }
      context.strokePath()
      context.restoreGState()
    }
  }

  private static func drawText(_ annotations: [[String: Any]], context: CGContext, pageHeight: CGFloat) {
    for annotation in annotations {
      guard let text = annotation["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
      let x = CGFloat(annotation["x"] as? Double ?? 0), y = CGFloat(annotation["y"] as? Double ?? 0), width = max(40, CGFloat(annotation["width"] as? Double ?? 180))
      let font = UIFont.systemFont(ofSize: max(8, CGFloat(annotation["fontSize"] as? Double ?? 16)))
      let attributes = MaterialTextGeometry.attributes(fontSize: Double(font.pointSize))
      let rect = MaterialTextGeometry.pageRect(
        text: text, x: Double(x), y: Double(y), width: Double(width),
        fontSize: Double(font.pointSize), anchor: annotation["anchor"] as? String
      )
      UIGraphicsPushContext(context)
      (text as NSString).draw(in: CGRect(x: rect.minX, y: pageHeight - rect.maxY, width: rect.width, height: rect.height), withAttributes: attributes)
      UIGraphicsPopContext()
    }
  }
}

private func PdfExporterColor(hex: String) -> UIColor {
  let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")); var raw: UInt64 = 0; Scanner(string: value).scanHexInt64(&raw)
  return UIColor(red: CGFloat((raw >> 16) & 0xff) / 255, green: CGFloat((raw >> 8) & 0xff) / 255, blue: CGFloat(raw & 0xff) / 255, alpha: 1)
}
