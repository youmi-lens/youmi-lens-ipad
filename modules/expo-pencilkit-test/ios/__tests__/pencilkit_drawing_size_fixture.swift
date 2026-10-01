// PK3-B Step 2 — measures REAL PKDrawing.dataRepresentation() size/timing for
// representative handwritten content, built from real PKStroke/PKStrokePath/
// PKStrokePoint/PKInk objects (never synthetic arbitrary bytes). Every field
// on PKStrokePoint (location, size, opacity, force, azimuth, altitude) is a
// plausible real Apple Pencil value, and ink type/width match Youmi's own
// physically-accepted PK2 presets (.pen, widths 1.5/2.68/6.0) — this is the
// same content shape the real Notebook would actually produce, not a proxy.
//
// Point/stroke counts per category are an explicit, stated estimate of real
// handwriting density (documented inline), not a measured transcript of an
// actual physical session — that measurement can only come from the owner's
// device. This fixture proves the real PencilKit serialization cost for that
// estimate, which is the evidence PK3-B's storage-architecture choice needs.
import PencilKit
import UIKit

func makeStroke(startX: CGFloat, startY: CGFloat, pointCount: Int, seed: inout UInt64, widthPreset: CGFloat) -> PKStroke {
  // xorshift64 — deterministic, no Foundation RNG dependency, reproducible
  // across runs so measurements are exactly comparable.
  func nextRandom() -> CGFloat {
    seed ^= seed << 13
    seed ^= seed >> 7
    seed ^= seed << 17
    return CGFloat(seed % 1000) / 1000.0
  }

  var points: [PKStrokePoint] = []
  points.reserveCapacity(pointCount)
  var x = startX
  var y = startY
  for i in 0..<pointCount {
    x += (nextRandom() - 0.3) * 4.0
    y += (nextRandom() - 0.5) * 2.0
    let t = Double(i) * 0.008 // ~125 samples/sec, in Apple Pencil's real range
    let force = 0.35 + nextRandom() * 0.3 // plausible mid-range pressure
    let size = CGSize(width: widthPreset * (0.85 + nextRandom() * 0.3), height: widthPreset * (0.85 + nextRandom() * 0.3))
    points.append(PKStrokePoint(
      location: CGPoint(x: x, y: y),
      timeOffset: t,
      size: size,
      opacity: 1.0,
      force: force,
      azimuth: nextRandom() * 2 * .pi,
      altitude: 0.6 + nextRandom() * 0.6
    ))
  }
  let path = PKStrokePath(controlPoints: points, creationDate: Date())
  let ink = PKInk(.pen, color: .black)
  return PKStroke(ink: ink, path: path, transform: .identity, mask: nil)
}

// Real Youmi width presets (PK2, physically accepted — not retuned here).
let mediumWidth: CGFloat = 2.68

func makeDrawing(strokeCount: Int, pointsPerStrokeRange: ClosedRange<Int>, seed: inout UInt64) -> PKDrawing {
  var strokes: [PKStroke] = []
  strokes.reserveCapacity(strokeCount)
  var cursorX: CGFloat = 40
  var cursorY: CGFloat = 60
  for _ in 0..<strokeCount {
    seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17
    let spread = pointsPerStrokeRange.upperBound - pointsPerStrokeRange.lowerBound
    let pointCount = spread > 0 ? pointsPerStrokeRange.lowerBound + Int(seed % UInt64(spread)) : pointsPerStrokeRange.lowerBound
    strokes.append(makeStroke(startX: cursorX, startY: cursorY, pointCount: pointCount, seed: &seed, widthPreset: mediumWidth))
    cursorX += 22
    if cursorX > 700 {
      cursorX = 40
      cursorY += 40
    }
  }
  return PKDrawing(strokes: strokes)
}

func measure(label: String, strokeCount: Int, pointsPerStrokeRange: ClosedRange<Int>) {
  var seed: UInt64 = 0x9E3779B97F4A7C15 &+ UInt64(strokeCount)

  let encodeStart = Date()
  let drawing = makeDrawing(strokeCount: strokeCount, pointsPerStrokeRange: pointsPerStrokeRange, seed: &seed)
  let data = drawing.dataRepresentation()
  let encodeMs = Date().timeIntervalSince(encodeStart) * 1000

  let base64 = data.base64EncodedString()

  let decodeStart = Date()
  guard let decoded = try? PKDrawing(data: data) else {
    print("MEASURE_FAIL|\(label)|decode threw")
    return
  }
  let strokeCountAfter = decoded.strokes.count
  let decodeMs = Date().timeIntervalSince(decodeStart) * 1000

  print("MEASURE|\(label)|strokes=\(strokeCount)|strokesAfterDecode=\(strokeCountAfter)|rawBytes=\(data.count)|base64Bytes=\(base64.utf8.count)|encodeMs=\(String(format: "%.3f", encodeMs))|decodeMs=\(String(format: "%.3f", decodeMs))")
}

func run() {
  // A. empty drawing
  measure(label: "A_empty", strokeCount: 0, pointsPerStrokeRange: 1...1)
  // B. 1 short word (~3 pen-lifts, ~15-25 points each — a 4-6 letter word
  //    written with a few connected strokes)
  measure(label: "B_short_word", strokeCount: 3, pointsPerStrokeRange: 15...25)
  // C. 1 normal sentence (~40 strokes across ~40-50 characters/words)
  measure(label: "C_sentence", strokeCount: 40, pointsPerStrokeRange: 15...30)
  // D. ~one handwritten page (~300 strokes — a stated estimate: a page of
  //    normal handwriting note-taking, several dozen words, each a few
  //    strokes, plus punctuation/dotting/crossing marks)
  measure(label: "D_one_page", strokeCount: 300, pointsPerStrokeRange: 15...35)
  // E. dense handwritten page (~700 strokes, denser/smaller writing)
  measure(label: "E_dense_page", strokeCount: 700, pointsPerStrokeRange: 20...45)
  // F. multi-page equivalent — 10x a full page's strokes in ONE PKDrawing,
  //    the real question for Step 5 (does a whole-note PKDrawing get large).
  measure(label: "F_ten_pages", strokeCount: 3000, pointsPerStrokeRange: 15...35)

  print("PENCILKIT_DRAWING_SIZE_MEASUREMENT_DONE")
}
run()
