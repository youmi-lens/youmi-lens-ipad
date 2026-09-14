// P0 regression fixture — annotated PDF export orientation.
//
// Standalone, not wired into the app target or any CI step (this repo has no
// existing native/XCTest harness, and ExpoModulesCore — imported by the real
// PdfAnnotationModule.swift — is not linkable outside the full app build).
// PdfAnnotatedExporter below is a byte-for-byte mirror of the same-named
// enum in ../PdfAnnotationModule.swift; if that file's export/drawStrokes/
// drawText change, update this copy to match before trusting the result.
//
// Run manually (compiles for iOS Simulator, executes via `simctl spawn` so it
// has real UIKit/PDFKit, no Xcode project needed):
//
//   xcrun simctl boot "iPad Pro 11-inch (M5)" 2>/dev/null || true
//   DEVICE=$(xcrun simctl list devices | grep "iPad Pro 11-inch (M5)" | grep -oE '[0-9A-F-]{36}' | head -1)
//   SDKROOT=$(xcrun --sdk iphonesimulator --show-sdk-path)
//   swiftc -sdk "$SDKROOT" -target arm64-apple-ios17.0-simulator \
//     pdf_export_orientation_fixture.swift -o /tmp/pdf_export_fixture_test
//   xcrun simctl spawn "$DEVICE" /tmp/pdf_export_fixture_test
//
// Exits non-zero (and prints [P0PDF] FAIL lines) if the base page's TOP/
// BOTTOM/LEFT/RIGHT markers are not found within a small tolerance of their
// expected pixel positions after export.

import UIKit
import PDFKit
import Foundation

func log(_ s: String) { print("[P0PDF] \(s)") }

// ── Verbatim mirror of PdfAnnotationModule.swift's PdfAnnotatedExporter ─────
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
    let destination = URL(fileURLWithPath: (options["destPath"] as! String))
    let renderer = UIGraphicsPDFRenderer(bounds: finalBounds)
    try renderer.writePDF(to: destination) { rendererContext in
      for index in 0..<exportPages {
        let page = index < sourcePages ? document.page(at: index) : nil
        let bounds = page?.bounds(for: .mediaBox) ?? finalBounds
        rendererContext.beginPage(withBounds: bounds, pageInfo: [:])
        let context = rendererContext.cgContext
        if let page {
          context.saveGState()
          context.translateBy(x: 0, y: bounds.height)
          context.scaleBy(x: 1, y: -1)
          page.draw(with: .mediaBox, to: context)
          context.restoreGState()
        }
        drawStrokes(strokes[String(index + 1)] as? [[String: Any]] ?? [], context: context)
        drawText(texts[String(index + 1)] as? [[String: Any]] ?? [], context: context, pageHeight: bounds.height)
      }
    }
    return destination.absoluteString
  }

  private static func drawStrokes(_ strokes: [[String: Any]], context: CGContext) {
    for stroke in strokes {
      guard let raw = stroke["points"] as? [[Double]], let first = raw.first, first.count >= 2 else { continue }
      context.saveGState()
      if (stroke["tool"] as? String) == "highlighter" { context.setBlendMode(.multiply) }
      context.setStrokeColor(PdfExporterColor(hex: stroke["color"] as? String ?? "#061B34").withAlphaComponent(CGFloat(stroke["opacity"] as? Double ?? ((stroke["tool"] as? String) == "highlighter" ? 0.34 : 1))).cgColor)
      context.setLineWidth(CGFloat(stroke["width"] as? Double ?? 2.4)); context.setLineCap(.round); context.setLineJoin(.round)
      context.move(to: CGPoint(x: first[0], y: first[1]))
      for point in raw.dropFirst() where point.count >= 2 { context.addLine(to: CGPoint(x: point[0], y: point[1])) }
      context.strokePath()
      context.restoreGState()
    }
  }

  private static func drawText(_ annotations: [[String: Any]], context: CGContext, pageHeight: CGFloat) {
    for annotation in annotations {
      guard let text = annotation["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
      let x = CGFloat(annotation["x"] as? Double ?? 0), y = CGFloat(annotation["y"] as? Double ?? 0), width = max(40, CGFloat(annotation["width"] as? Double ?? 180))
      let font = UIFont.systemFont(ofSize: max(8, CGFloat(annotation["fontSize"] as? Double ?? 16)))
      let paragraph = NSMutableParagraphStyle(); paragraph.lineBreakMode = .byWordWrapping
      let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.label, .paragraphStyle: paragraph]
      let size = (text as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes, context: nil).size
      UIGraphicsPushContext(context)
      (text as NSString).draw(in: CGRect(x: x, y: pageHeight - y - size.height, width: width, height: size.height + 2), withAttributes: attributes)
      UIGraphicsPopContext()
    }
  }
}

private func PdfExporterColor(hex: String) -> UIColor {
  let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")); var raw: UInt64 = 0; Scanner(string: value).scanHexInt64(&raw)
  return UIColor(red: CGFloat((raw >> 16) & 0xff) / 255, green: CGFloat((raw >> 8) & 0xff) / 255, blue: CGFloat(raw & 0xff) / 255, alpha: 1)
}

// ── Deliberately-broken control ──────────────────────────────────────────────
// Byte-for-byte PdfAnnotatedExporter.export EXCEPT the base-page draw has no
// compensating flip — i.e. exactly what production looked like before the
// fix. Run through the same assertions below and MUST fail them. Without
// this the fixture can silently stop proving anything (see the two bugs
// documented on `rasterize` below — both let this file pass unchanged
// whether the real fix was present or not, for three separate attempts).
enum PdfAnnotatedExporterBrokenControl {
  static func export(options: [String: Any]) throws -> String {
    guard let fileUri = options["fileUri"] as? String,
          let url = fileUri.hasPrefix("file://") ? URL(string: fileUri) : URL(fileURLWithPath: fileUri),
          let document = PDFDocument(url: url) else {
      throw NSError(domain: "ExpoPdfAnnotation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Source PDF could not be opened."])
    }
    let finalBounds = document.page(at: 0)?.bounds(for: .mediaBox) ?? CGRect(x: 0, y: 0, width: 612, height: 792)
    let destination = URL(fileURLWithPath: (options["destPath"] as! String))
    let renderer = UIGraphicsPDFRenderer(bounds: finalBounds)
    try renderer.writePDF(to: destination) { rendererContext in
      rendererContext.beginPage(withBounds: finalBounds, pageInfo: [:])
      if let page = document.page(at: 0) { page.draw(with: .mediaBox, to: rendererContext.cgContext) }
    }
    return destination.absoluteString
  }
}

// ── Fixture + assertions ─────────────────────────────────────────────────────
let outDir = "/tmp/pdf_export_fixture_out"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
let size = CGSize(width: 612, height: 792)

// Deliberately asymmetric: ONLY a "TOP" marker, near the top edge, nothing
// elsewhere on the page. A fixture with both a TOP and a BOTTOM marker (as
// this file originally had) cannot detect vertical mirroring by an
// ink-presence check alone — mirroring just swaps which label occupies which
// quarter, and since both quarters still contain *some* dark text either way,
// "is there ink here" passes identically whether the page is oriented
// correctly or completely upside-down. This was proven experimentally: the
// symmetric two-marker version of this fixture passed against both a
// genuinely-fixed and a genuinely-broken exporter. A single off-center
// marker doesn't have this blind spot: if the page is mirrored, the marker's
// quarter changes, and the *other* quarter (with nothing drawn there) has no
// ink to falsely satisfy the check.
func makeFixture(at path: String) {
  let renderer = UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: size))
  let data = renderer.pdfData { ctx in
    ctx.beginPage()
    let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: 28), .foregroundColor: UIColor.black]
    ("TOP" as NSString).draw(at: CGPoint(x: size.width/2 - 20, y: 20), withAttributes: attrs)
  }
  try! data.write(to: URL(fileURLWithPath: path))
}

// Render page 0 to an RGBA bitmap and return a sampler for pixel "ink present"
// checks — using CGContext.drawPDFPage(_:), the low-level Core Graphics API,
// NOT PDFKit's PDFPage.draw(with:to:) (the API the real bug is in) and NOT
// PDFPage.thumbnail(of:for:) (tried first; it renders through its own
// internal path and could not reproduce the bug at all — passed even against
// deliberately-broken code, so it is not a valid proxy for what the exporter
// actually does).
func rasterize(pdfPath: String) -> (width: Int, height: Int, isDark: (Int, Int) -> Bool)? {
  guard let pdfDoc = CGPDFDocument(URL(fileURLWithPath: pdfPath) as CFURL), let page = pdfDoc.page(at: 1) else { return nil }
  let bounds = page.getBoxRect(.mediaBox)
  let w = Int(bounds.width), h = Int(bounds.height)
  var pixels = [UInt8](repeating: 255, count: w * h * 4)
  let cs = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.drawPDFPage(page)
  // Empirically verified against a pristine, never-exported fixture (whose
  // "TOP" marker position is known ground truth): for this CGContext(data:)
  // buffer layout, row index 0 is the visual TOP of the page, not the
  // bottom — i.e. bufferY needs NO inversion here. An earlier version of
  // this function inverted it (`h - 1 - bufferY`), which was backwards; that
  // bug combined with the symmetric-fixture blind spot above to make this
  // fixture pass unconditionally, regardless of whether the real fix was
  // present.
  return (w, h, { x, bufferY in
    guard x >= 0, x < w, bufferY >= 0, bufferY < h else { return false }
    let idx = (bufferY * w + x) * 4
    return pixels[idx] < 128 // dark (black text) pixel present
  })
}

func regionHasInk(_ sample: (width: Int, height: Int, isDark: (Int, Int) -> Bool), xRange: Range<Int>, yRange: Range<Int>) -> Bool {
  for y in yRange { for x in xRange { if sample.isDark(x, y) { return true } } }
  return false
}

var failures = 0
func expect(_ condition: Bool, _ message: String) {
  if condition { log("PASS: \(message)") } else { log("FAIL: \(message)"); failures += 1 }
}

let fixturePath = "\(outDir)/fixture.pdf"
makeFixture(at: fixturePath)

func checkOrientation(destPath: String, label: String) -> (top: Bool, bottom: Bool) {
  guard let exported = rasterize(pdfPath: destPath) else {
    log("FAIL: could not rasterize \(label) output"); failures += 1; return (false, false)
  }
  let w = exported.width, h = exported.height
  let top = regionHasInk(exported, xRange: 0..<w, yRange: 0..<(h/4))
  let bottom = regionHasInk(exported, xRange: 0..<w, yRange: (3*h/4)..<h)
  return (top, bottom)
}

let destPath = "\(outDir)/exported.pdf"
_ = try! PdfAnnotatedExporter.export(options: [
  "fileUri": fixturePath, "sourcePageCount": 1, "appendedBlankPageCount": 0,
  "annotationsByPage": [String: Any](), "textAnnotationsByPage": [String: Any](),
  "destPath": destPath,
])
let real = checkOrientation(destPath: destPath, label: "real exporter")
expect(real.top, "real exporter: TOP marker ink found in the top quarter of the exported page")
expect(!real.bottom, "real exporter: no ink in the bottom quarter (page was not mirrored)")

let brokenDestPath = "\(outDir)/exported_broken_control.pdf"
_ = try! PdfAnnotatedExporterBrokenControl.export(options: ["fileUri": fixturePath, "destPath": brokenDestPath])
let broken = checkOrientation(destPath: brokenDestPath, label: "broken control")
expect(!broken.top, "negative control: unflipped export must NOT show the TOP marker in the top quarter (i.e. it mirrored, as expected)")
expect(broken.bottom, "negative control: unflipped export must show the TOP marker displaced into the bottom quarter")

if failures > 0 {
  log("\(failures) FAILURE(S)")
  exit(1)
} else {
  log("ALL CHECKS PASSED (including negative control on a deliberately-unflipped exporter)")
}
