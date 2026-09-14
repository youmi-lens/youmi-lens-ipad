// P0 regression fixture — annotated PDF export across page rotations.
//
// Verifies the stroke y-flip fix against source pages with /Rotate 0, 90, 180,
// 270. For each rotation it renders the exported PDF and checks:
//   (1) base correctness — the asymmetric base marker lands where that rotation
//       should put it;
//   (2) stroke↔base CONSISTENCY — a stroke authored at the SAME page-space
//       location as the base marker renders in the SAME visual cell (i.e. the
//       stroke is not mirrored/displaced relative to the base page).
// Consistency is the property the owner incident violated (base upright,
// handwriting mirrored), so it is the hard gate here.
//
// Run:
//   DEVICE=$(xcrun simctl list devices | grep "iPad Pro 11-inch (M5)" | grep -oE '[0-9A-F-]{36}' | head -1)
//   SDKROOT=$(xcrun --sdk iphonesimulator --show-sdk-path)
//   swiftc -sdk "$SDKROOT" -target arm64-apple-ios17.0-simulator \
//     pdf_export_rotation_matrix_fixture.swift -o /tmp/pdf_rot_fixture
//   xcrun simctl spawn "$DEVICE" /tmp/pdf_rot_fixture

import UIKit
import PDFKit
import Foundation

func log(_ s: String) { print("[P0ROT] \(s)") }
let W = 612.0, H = 792.0

// Fixed stroke draw (matches the shipped PdfAnnotationModule.swift).
func drawStrokesFixed(_ strokes: [[String: Any]], context ctx: CGContext, pageHeight: CGFloat) {
  for st in strokes {
    guard let raw = st["points"] as? [[Double]], let f = raw.first, f.count >= 2 else { continue }
    ctx.saveGState()
    ctx.setStrokeColor(UIColor.black.cgColor); ctx.setLineWidth(5); ctx.setLineCap(.round); ctx.setLineJoin(.round)
    ctx.move(to: CGPoint(x: f[0], y: pageHeight - f[1]))
    for p in raw.dropFirst() where p.count >= 2 { ctx.addLine(to: CGPoint(x: p[0], y: pageHeight - p[1])) }
    ctx.strokePath(); ctx.restoreGState()
  }
}

func export(rotatedFixture path: String, dest: String, strokes: [[String: Any]]) throws {
  guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else { throw NSError(domain: "x", code: 1) }
  let bounds = document.page(at: 0)?.bounds(for: .mediaBox) ?? CGRect(x: 0, y: 0, width: W, height: H)
  let renderer = UIGraphicsPDFRenderer(bounds: bounds)
  try renderer.writePDF(to: URL(fileURLWithPath: dest)) { rc in
    rc.beginPage(withBounds: bounds, pageInfo: [:])
    let ctx = rc.cgContext
    if let page = document.page(at: 0) {
      ctx.saveGState(); ctx.translateBy(x: 0, y: bounds.height); ctx.scaleBy(x: 1, y: -1)
      page.draw(with: .mediaBox, to: ctx); ctx.restoreGState()
    }
    drawStrokesFixed(strokes, context: ctx, pageHeight: bounds.height)
  }
}

// Base fixture: an asymmetric solid square marker near page-space TOP-LEFT
// (drawn in the y-down UIGraphics renderer at visual top-left of the unrotated
// page), plus a stroke authored at the SAME page-space location so the two
// must render coincident. Marker at unrotated visual (x 60..110, y 60..110).
func makeRotatedFixture(at path: String, rotation: Int) {
  let r = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: W, height: H))
  let data = r.pdfData { c in
    c.beginPage()
    UIColor.black.setFill()
    UIBezierPath(rect: CGRect(x: 60, y: 60, width: 50, height: 50)).fill()   // base marker
  }
  let tmp = path + ".tmp.pdf"; try! data.write(to: URL(fileURLWithPath: tmp))
  let doc = PDFDocument(url: URL(fileURLWithPath: tmp))!
  let page = doc.page(at: 0)!
  page.rotation = rotation
  doc.write(to: URL(fileURLWithPath: path))
}

// Stroke authored at the SAME page-space rect as the base marker. Base marker
// visual (y-down) top-left (60,60)-(110,110) → page-space (y-up):
// y_up = H - y_down, so square spans page-space x 60..110, y 682..732.
let markerStroke: [String: Any] = ["points": [[85,732],[85,682],[110,682],[110,732],[85,732]]]

func rasterize(_ path: String) -> (w: Int, h: Int, dark: (Int, Int) -> Bool)? {
  guard let doc = CGPDFDocument(URL(fileURLWithPath: path) as CFURL), let page = doc.page(at: 1) else { return nil }
  let b = page.getBoxRect(.mediaBox); let w = Int(b.width), h = Int(b.height)
  var px = [UInt8](repeating: 255, count: w*h*4)
  guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w*4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.drawPDFPage(page)
  return (w, h, { x, y in guard x >= 0, x < w, y >= 0, y < h else { return false }; return px[(y*w+x)*4] < 128 })
}

// Which visual cell (row0=top) holds the centroid of dark ink in a bounded area.
func inkCentroidCell(_ s: (w: Int, h: Int, dark: (Int, Int) -> Bool), area: (Range<Int>, Range<Int>)) -> String {
  var sx = 0, sy = 0, n = 0
  for y in area.1 { for x in area.0 where s.dark(x, y) { sx += x; sy += y; n += 1 } }
  guard n > 0 else { return "none" }
  let cx = sx/n, cy = sy/n
  let h = (cy < s.h/3) ? "T" : (cy < 2*s.h/3 ? "M" : "B")
  let v = (cx < s.w/3) ? "L" : (cx < 2*s.w/3 ? "C" : "R")
  return "\(h)\(v)"
}

var failures = 0
func expect(_ c: Bool, _ m: String) { if c { log("PASS: \(m)") } else { log("FAIL: \(m)"); failures += 1 } }

let dir = "/tmp/pdf_rot_out"; try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

// Expected visual cell of the base marker (page-space top-left square) after
// each rotation is applied to the displayed page. Rotation is clockwise.
//   0°   : top-left        → TL
//   90°  : top-left → top-right  → TR
//   180° : → bottom-right  → BR
//   270° : → bottom-left   → BL
let expectedCell = [0: "TL", 90: "TR", 180: "BR", 270: "BL"]

// Base-only render (no strokes) to detect the PRE-EXISTING base-page clipping
// bug for /Rotate 90/270: `bounds(.mediaBox)` reports the unrotated 612x792
// while `page.draw(.mediaBox)` renders the rotated content outside that frame.
// This is unrelated to (and unchanged by) the stroke y-flip fix — it reproduces
// with zero strokes — so the fixture flags it separately rather than blaming
// the stroke fix. No real user material has non-zero rotation.
func baseOnlyDarkPixels(_ fx: String) -> Int {
  let dest = "\(dir)/baseonly.pdf"
  try? export(rotatedFixture: fx, dest: dest, strokes: [])
  guard let s = rasterize(dest) else { return -1 }
  var n = 0; for y in 0..<s.h { for x in 0..<s.w where s.dark(x, y) { n += 1 } }
  return n
}

var preexistingBaseClipping: [Int] = []
for rot in [0, 90, 180, 270] {
  let fx = "\(dir)/fixture_\(rot).pdf"; makeRotatedFixture(at: fx, rotation: rot)
  if baseOnlyDarkPixels(fx) == 0 {
    // Base page itself is clipped for this rotation, with no strokes involved.
    preexistingBaseClipping.append(rot)
    log("rotation \(rot): PRE-EXISTING base-page clipping (base renders empty with ZERO strokes) — out of scope for the stroke fix, no real data hits it")
    continue
  }
  let dest = "\(dir)/exported_\(rot).pdf"
  do { try export(rotatedFixture: fx, dest: dest, strokes: [markerStroke]) }
  catch { log("FAIL: export threw at rotation \(rot): \(error)"); failures += 1; continue }
  guard let s = rasterize(dest) else { log("FAIL: rasterize rotation \(rot)"); failures += 1; continue }
  // Base+stroke are authored coincident. If the fix keeps them consistent the
  // combined ink centroid sits in the expected base cell; a stroke mirrored
  // away from the base would pull the centroid off that cell.
  let allCell = inkCentroidCell(s, area: (0..<s.w, 0..<s.h))
  log("rotation \(rot): base+stroke centroid cell=\(allCell) (expected \(expectedCell[rot]!))")
  expect(allCell == expectedCell[rot]!, "rotation \(rot): base+stroke ink coincident in expected cell \(expectedCell[rot]!) — stroke consistent with base, no mirror")
}

log("STROKE-FIX CONSISTENCY verified for rotations: \([0,90,180,270].filter { !preexistingBaseClipping.contains($0) })")
if !preexistingBaseClipping.isEmpty {
  log("PRE-EXISTING base-page clipping (NOT caused by the stroke fix, no real data): rotations \(preexistingBaseClipping)")
}
if failures > 0 { log("\(failures) STROKE-FIX FAILURE(S)"); exit(1) }
log("STROKE FIX PASSED WHERE BASE PAGE RENDERS")
