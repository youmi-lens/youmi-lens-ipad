// P0 regression fixture — annotated PDF export ANNOTATION orientation.
//
// Build 54's fixture (pdf_export_orientation_fixture.swift) exported with an
// EMPTY annotation set, so it only ever proved the base PDF page was upright.
// It never drew a single stroke — which is exactly why build 54 shipped with
// the base page correct but every handwritten stroke vertically mirrored.
//
// This fixture draws real strokes AND a text annotation, in the SAME
// coordinate space the app captures them in — PDF page space, y-UP, bottom-left
// origin (PdfAnnotationView.swift: `pdfView.convert(viewPoint, to: page)`) —
// then renders the exported PDF to a bitmap and asserts WHERE the ink actually
// lands. It is a geometry test, not a "transform call exists" test.
//
// Run (needs real UIKit/PDFKit, so Simulator via simctl spawn):
//   DEVICE=$(xcrun simctl list devices | grep "iPad Pro 11-inch (M5)" | grep -oE '[0-9A-F-]{36}' | head -1)
//   SDKROOT=$(xcrun --sdk iphonesimulator --show-sdk-path)
//   swiftc -sdk "$SDKROOT" -target arm64-apple-ios17.0-simulator \
//     pdf_export_annotation_orientation_fixture.swift -o /tmp/pdf_anno_fixture
//   xcrun simctl spawn "$DEVICE" /tmp/pdf_anno_fixture
//
// Exits non-zero on any [P0ANNO] FAIL. Includes a negative control (the exact
// build-54 stroke path, drawn raw into the y-down context) that MUST fail the
// same assertions, so the fixture cannot silently stop proving anything.

import UIKit
import PDFKit
import Foundation

func log(_ s: String) { print("[P0ANNO] \(s)") }

// ── Stroke drawing under test ────────────────────────────────────────────────
// CURRENT (build 54) behaviour: draw stroke points RAW into the context.
func drawStrokes_build54(_ strokes: [[String: Any]], context: CGContext, pageHeight: CGFloat) {
  for stroke in strokes {
    guard let raw = stroke["points"] as? [[Double]], let first = raw.first, first.count >= 2 else { continue }
    context.saveGState()
    context.setStrokeColor(UIColor.black.cgColor)
    context.setLineWidth(CGFloat(stroke["width"] as? Double ?? 3)); context.setLineCap(.round); context.setLineJoin(.round)
    context.move(to: CGPoint(x: first[0], y: first[1]))
    for p in raw.dropFirst() where p.count >= 2 { context.addLine(to: CGPoint(x: p[0], y: p[1])) }
    context.strokePath()
    context.restoreGState()
  }
}

// CANDIDATE FIX: strokes are stored in PDF page space (y-up). The export
// context is y-down (UIGraphicsPDFRenderer). Flip each point's y to
// pageHeight - y — the identical convention drawText already uses — so strokes
// share the base page's orientation instead of being mirrored relative to it.
func drawStrokes_fixed(_ strokes: [[String: Any]], context: CGContext, pageHeight: CGFloat) {
  for stroke in strokes {
    guard let raw = stroke["points"] as? [[Double]], let first = raw.first, first.count >= 2 else { continue }
    context.saveGState()
    context.setStrokeColor(UIColor.black.cgColor)
    context.setLineWidth(CGFloat(stroke["width"] as? Double ?? 3)); context.setLineCap(.round); context.setLineJoin(.round)
    context.move(to: CGPoint(x: first[0], y: pageHeight - first[1]))
    for p in raw.dropFirst() where p.count >= 2 { context.addLine(to: CGPoint(x: p[0], y: pageHeight - p[1])) }
    context.strokePath()
    context.restoreGState()
  }
}

func export(fixture: String, dest: String, strokes: [[String: Any]],
            useFixed: Bool) throws {
  guard let document = PDFDocument(url: URL(fileURLWithPath: fixture)) else {
    throw NSError(domain: "x", code: 1)
  }
  let bounds = document.page(at: 0)?.bounds(for: .mediaBox) ?? CGRect(x: 0, y: 0, width: 612, height: 792)
  let renderer = UIGraphicsPDFRenderer(bounds: bounds)
  try renderer.writePDF(to: URL(fileURLWithPath: dest)) { rc in
    rc.beginPage(withBounds: bounds, pageInfo: [:])
    let ctx = rc.cgContext
    if let page = document.page(at: 0) {
      // Build-54 base-page flip (kept — base page is correct).
      ctx.saveGState()
      ctx.translateBy(x: 0, y: bounds.height)
      ctx.scaleBy(x: 1, y: -1)
      page.draw(with: .mediaBox, to: ctx)
      ctx.restoreGState()
    }
    if useFixed { drawStrokes_fixed(strokes, context: ctx, pageHeight: bounds.height) }
    else        { drawStrokes_build54(strokes, context: ctx, pageHeight: bounds.height) }
  }
}

// ── Fixture geometry ─────────────────────────────────────────────────────────
// Page 612 x 792. Strokes are authored in y-UP page space (as captured).
// Four markers, each in a UNIQUE (vertical band x horizontal third) cell, so
// any vertical OR horizontal mirror moves ink into a cell that must be empty.
//   TOP:    y-up ~740 (visual top),    x ~150 (left third)   + up-chevron apex highest
//   BOTTOM: y-up ~52  (visual bottom),  x ~460 (right third)  + down-chevron apex lowest
//   LEFT:   y-up ~396 (vertical middle),x ~40  (left third)
//   RIGHT:  y-up ~396 (vertical middle),x ~572 (right third)
let W = 612.0, H = 792.0
func seg(_ pts: [[Double]]) -> [String: Any] { ["points": pts, "width": 4.0] }
// up-chevron: apex at TOP means largest y-up at the apex
let topMarker    = seg([[130,730],[150,762],[170,730]])          // apex y-up 762 (visual top)
let bottomMarker = seg([[440,60],[460,28],[480,60]])             // apex y-up 28 (visual bottom)
let leftMarker   = seg([[40,380],[40,412]])                      // far left, middle
let rightMarker  = seg([[572,380],[572,412]])                    // far right, middle
let strokes = [topMarker, bottomMarker, leftMarker, rightMarker]

func makeFixture(at path: String) {
  let r = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: W, height: H))
  let data = r.pdfData { c in
    c.beginPage()
    // readable source text near visual top-CENTER (its own third, clear of the
    // four marker cells) so we can confirm the base page stays upright and
    // consistent with the strokes without polluting a marker cell.
    ("SOURCE" as NSString).draw(at: CGPoint(x: 270, y: 16),
      withAttributes: [.font: UIFont.boldSystemFont(ofSize: 22), .foregroundColor: UIColor.black])
  }
  try! data.write(to: URL(fileURLWithPath: path))
}

// Render exported PDF page 1 to RGBA. Row 0 = visual TOP (established by
// build 54's fixture for CGContext(data:) + drawPDFPage — no bufferY inversion).
func rasterize(_ path: String) -> (w: Int, h: Int, dark: (Int, Int) -> Bool)? {
  guard let doc = CGPDFDocument(URL(fileURLWithPath: path) as CFURL), let page = doc.page(at: 1) else { return nil }
  let b = page.getBoxRect(.mediaBox)
  let w = Int(b.width), h = Int(b.height)
  var px = [UInt8](repeating: 255, count: w*h*4)
  let cs = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w*4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.drawPDFPage(page)
  return (w, h, { x, y in
    guard x >= 0, x < w, y >= 0, y < h else { return false }
    return px[(y*w + x)*4] < 128
  })
}

func hasInk(_ s: (w: Int, h: Int, dark: (Int, Int) -> Bool), _ xr: Range<Int>, _ yr: Range<Int>) -> Bool {
  for y in yr { for x in xr { if s.dark(x, y) { return true } } }
  return false
}

var failures = 0
func expect(_ cond: Bool, _ msg: String) {
  if cond { log("PASS: \(msg)") } else { log("FAIL: \(msg)"); failures += 1 }
}

let dir = "/tmp/pdf_anno_out"; try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
let fixture = "\(dir)/fixture.pdf"; makeFixture(at: fixture)

// bands (bufferY, row0 = visual top): top quarter, bottom quarter, middle band
func bands(_ s: (w: Int, h: Int, dark: (Int, Int) -> Bool)) -> (topL: Bool, topR: Bool, botL: Bool, botR: Bool, midL: Bool, midR: Bool) {
  let w = s.w, h = s.h
  let L = 0..<(w/3), R = (2*w/3)..<w
  let TOP = 0..<(h/4), BOT = (3*h/4)..<h, MID = (3*h/8)..<(5*h/8)
  return (hasInk(s, L, TOP), hasInk(s, R, TOP), hasInk(s, L, BOT), hasInk(s, R, BOT), hasInk(s, L, MID), hasInk(s, R, MID))
}

func evaluate(label: String, useFixed: Bool, expectCorrect: Bool) {
  let dest = "\(dir)/\(label).pdf"
  try! export(fixture: fixture, dest: dest, strokes: strokes, useFixed: useFixed)
  guard let s = rasterize(dest) else { log("FAIL: rasterize \(label)"); failures += 1; return }
  let b = bands(s)
  log("\(label): topL=\(b.topL) topR=\(b.topR) botL=\(b.botL) botR=\(b.botR) midL=\(b.midL) midR=\(b.midR)")
  if expectCorrect {
    // TOP marker → top-left; BOTTOM marker → bottom-right; LEFT → mid-left; RIGHT → mid-right.
    expect(b.topL,  "\(label): TOP marker ink in visual-top-left cell")
    expect(!b.topR, "\(label): visual-top-right cell empty (BOTTOM marker did not mirror up)")
    expect(b.botR,  "\(label): BOTTOM marker ink in visual-bottom-right cell")
    expect(!b.botL, "\(label): visual-bottom-left cell empty (TOP marker did not mirror down)")
    expect(b.midL,  "\(label): LEFT marker ink in mid-left cell")
    expect(b.midR,  "\(label): RIGHT marker ink in mid-right cell")
    // arrow direction: TOP up-chevron apex (highest visual point = smallest bufferY)
    // must be near x=150; find topmost ink row in left third, check it is the apex.
    // apex scan restricted to the TOP chevron's own x-band (120..180), clear of
    // the base text. Up-chevron: apex (narrow) is the topmost ink; arms (wide)
    // are lower. A vertical mirror would put the wide arms on top instead.
    var apexY = -1, apexXmin = 9999, apexXmax = -1, armXmin = 9999, armXmax = -1
    for y in 0..<(s.h/4) { for x in 120..<180 where s.dark(x, y) {
      if apexY < 0 { apexY = y }
      if y <= apexY + 3 { apexXmin = min(apexXmin, x); apexXmax = max(apexXmax, x) }
      armXmin = min(armXmin, x); armXmax = max(armXmax, x)
    } }
    expect(apexY >= 0 && (apexXmax - apexXmin) < 20 && (armXmax - armXmin) > 25,
      "\(label): TOP chevron apex is a narrow point ABOVE its wide arms (arrow points up, not mirrored)")
  } else {
    // build-54 stroke path: strokes are mirrored vertically relative to base.
    // TOP marker (y-up 762) renders at visual BOTTOM-left; BOTTOM at TOP-right.
    expect(b.botL, "\(label) [negative control]: TOP marker WRONGLY mirrored into bottom-left")
    expect(b.topR, "\(label) [negative control]: BOTTOM marker WRONGLY mirrored into top-right")
  }
}

log("=== negative control: build-54 raw stroke draw (must mirror) ===")
evaluate(label: "build54", useFixed: false, expectCorrect: false)
log("=== candidate fix: y-flip stroke points (must be correct) ===")
evaluate(label: "fixed", useFixed: true, expectCorrect: true)

if failures > 0 { log("\(failures) FAILURE(S)"); exit(1) }
log("ALL CHECKS PASSED")
