// Compiled alongside the ACTUAL production geometry and PageTextAnnotationLayer.
// Synthetic PDF only; never touches device/app data.
import UIKit
import PDFKit

@main
struct MaterialTextGeometryFixture {
  static func close(_ a: CGPoint, _ b: CGPoint, _ label: String) {
    precondition(hypot(a.x - b.x, a.y - b.y) < 0.05, "\(label): \(a) != \(b)")
  }

  static func main() {
    // Actual glyph raster comparison: the editor and committed CATextLayer
    // must share first/last ink bounds, not merely equal container boxes.
    let canvas = UIView(frame: CGRect(x: 0, y: 0, width: 300, height: 150))
    canvas.backgroundColor = .white
    canvas.overrideUserInterfaceStyle = .light
    let sample = TextAnnotation(id: "glyph", text: "ABC\n123", x: 20, y: 130, width: 260, fontSize: 16, anchor: "top-left")
    let sampleRect = PageTextAnnotationLayer.annotationFrame(sample)
    let editor = UITextView(frame: CGRect(x: sampleRect.minX, y: 150-sampleRect.maxY, width: sampleRect.width, height: sampleRect.height))
    editor.font = UIFont.systemFont(ofSize: 16)
    editor.textColor = .black
    editor.backgroundColor = .clear
    editor.textContainerInset = .zero
    editor.textContainer.lineFragmentPadding = 0
    editor.isScrollEnabled = false
    editor.text = sample.text
    canvas.addSubview(editor)
    editor.layoutIfNeeded()
    func inkRows() -> (Int, Int) {
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let image = UIGraphicsImageRenderer(size: canvas.bounds.size, format: format).image { ctx in canvas.layer.render(in: ctx.cgContext) }
      var bytes = [UInt8](repeating: 0, count: 300*150*4)
      let cg = CGContext(data: &bytes, width: 300, height: 150, bitsPerComponent: 8, bytesPerRow: 300*4,
                         space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      cg.draw(image.cgImage!, in: canvas.bounds)
      let rows = (0..<150).filter { y in
        (15..<285).contains { x in
          let i = (y*300+x)*4
          return Int(bytes[i])+Int(bytes[i+1])+Int(bytes[i+2]) < 400
        }
      }
      precondition(!rows.isEmpty, "text raster empty")
      return (rows.first!, rows.last!)
    }
    let editingInk = inkRows()
    editor.removeFromSuperview()
    let staticLayer = PageTextAnnotationLayer()
    staticLayer.render([sample])
    staticLayer.setAffineTransform(CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 150))
    canvas.layer.addSublayer(staticLayer)
    let committedInk = inkRows()
    print("GLYPH_BOUNDS editor=\(editingInk) committed=\(committedInk)")
    precondition(abs(editingInk.0-committedInk.0) <= 1 && abs(editingInk.1-committedInk.1) <= 1, "commit glyph jump")
    staticLayer.removeFromSuperlayer()
    let data = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { ctx in
      for n in 1...3 {
        ctx.beginPage()
        ("SYNTHETIC PAGE \(n) ABC 123" as NSString).draw(at: CGPoint(x: 40, y: 40), withAttributes: [.font: UIFont.systemFont(ofSize: 16)])
      }
    }
    let document = PDFDocument(data: data)!
    let container = UIView(frame: CGRect(x: 0, y: 0, width: 900, height: 1000))
    let pdf = PDFView(frame: container.bounds)
    container.addSubview(pdf)
    pdf.displayMode = .singlePageContinuous
    pdf.document = document
    pdf.minScaleFactor = 0.1
    pdf.maxScaleFactor = 4
    var cases = 0
    for rotation in [0, 90, 180, 270] {
      for pageIndex in 0..<3 {
        let page = document.page(at: pageIndex)!
        page.rotation = rotation
        for scale: CGFloat in [0.8, 1.4, 2.2] {
          pdf.scaleFactor = scale
          pdf.go(to: PDFDestination(page: page, at: CGPoint(x: 40, y: 680)))
          pdf.layoutDocumentView()
          container.layoutIfNeeded()
          RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.03))
          let anchor = CGPoint(x: 110, y: 650)
          let tap = pdf.convert(anchor, from: page)
          close(pdf.convert(tap, to: page), anchor, "tap round-trip")
          for anchorKind: String? in ["top-left", nil] {
            for value in ["ABC\n123", "ABC\n123\nLonger pasted text wrapping across the same page box."] {
              let a = TextAnnotation(id: "fixture", text: value, x: Double(anchor.x), y: Double(anchor.y), width: 190, fontSize: 16, anchor: anchorKind)
              let rect = PageTextAnnotationLayer.annotationFrame(a)
              let placement = MaterialTextGeometry.editorPlacement(rect: rect, page: page, pdfView: pdf, container: container)
              let editor = UITextView(frame: .zero)
              container.addSubview(editor)
              editor.bounds = CGRect(origin: .zero, size: rect.size)
              editor.center = placement.center
              editor.transform = placement.transform
              let top = container.convert(pdf.convert(CGPoint(x: rect.minX, y: rect.maxY), from: page), from: pdf)
              close(editor.convert(.zero, to: container), top, "editor/static top-left")
              if anchorKind == "top-left" {
                close(top, container.convert(tap, from: pdf), "tap/editor/commit identical")
              } else {
                precondition(abs(rect.minY - anchor.y) < 0.001, "saved legacy coordinates shifted")
              }
              let layer = PageTextAnnotationLayer()
              layer.render([a])
              precondition(layer.sublayers?.count == 1, "selection UI remains")
              let glyph = layer.sublayers!.first as! CATextLayer
              precondition(glyph.affineTransform().d == -1, "upright glyph counter-reflection lost")
              precondition(glyph.fontSize == 16, "document font changed with zoom")
              close(glyph.frame.origin, rect.origin, "static page rect")
              let host = pdf.documentView!
              func mapped(_ p: CGPoint) -> CGPoint { host.convert(pdf.convert(p, from: page), from: pdf) }
              let o = mapped(.zero), x = mapped(CGPoint(x: 1, y: 0)), y = mapped(CGPoint(x: 0, y: 1))
              layer.setAffineTransform(CGAffineTransform(a: x.x-o.x, b: x.y-o.y, c: y.x-o.x, d: y.y-o.y, tx: o.x, ty: o.y))
              host.layer.addSublayer(layer)
              let staticTop = layer.convert(CGPoint(x: rect.minX, y: rect.maxY), to: host.layer)
              close(container.convert(staticTop, from: host), top, "document-hosted static/editor alignment")
              // New text grows below a fixed tap; no commit-time height-dependent shift.
              if anchorKind == "top-left" { precondition(abs(rect.maxY-anchor.y) < 0.001) }
              layer.removeFromSuperlayer()
              editor.removeFromSuperview()
              cases += 1
            }
          }
        }
      }
    }
    print("MATERIAL_TEXT_GEOMETRY_PASS cases=\(cases) pages=3 rotations=0,90,180,270 zoom=0.8,1.4,2.2 new+legacy")
  }
}
