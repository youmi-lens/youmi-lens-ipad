// Compiled alongside the ACTUAL production NotebookPencilSample.swift.
// No UIKit touch delivery involved — this fixture proves the pure pressure
// normalization + sample-construction logic only. Lifecycle/coordinate
// wiring (NotebookPencilSamplerGestureRecognizer/View) requires real UITouch
// delivery and is verified by the Phase 3B-2 physical foundation check.
import Foundation
import CoreGraphics

@main
struct NotebookPencilSampleFixture {
  static func expectNil(_ value: Double?, _ label: String) {
    precondition(value == nil, "\(label): expected nil, got \(String(describing: value))")
  }
  static func expectClose(_ value: Double?, _ expected: Double, _ label: String) {
    guard let value else { precondition(false, "\(label): expected \(expected), got nil"); return }
    precondition(abs(value - expected) < 1e-9, "\(label): expected \(expected), got \(value)")
  }

  static func main() {
    // Normal mid-range press.
    expectClose(NotebookPencilSample.normalizedPressure(force: 0.5, maximumPossibleForce: 1.0), 0.5, "normal")

    // Zero / negative / non-finite maximumPossibleForce must never divide
    // into a fabricated value — nil, not a crash, not 0, not Infinity.
    expectNil(NotebookPencilSample.normalizedPressure(force: 0.5, maximumPossibleForce: 0), "zero max")
    expectNil(NotebookPencilSample.normalizedPressure(force: 0.5, maximumPossibleForce: -1), "negative max")
    expectNil(NotebookPencilSample.normalizedPressure(force: 0.5, maximumPossibleForce: .nan), "nan max")
    expectNil(NotebookPencilSample.normalizedPressure(force: .nan, maximumPossibleForce: 1), "nan force")
    expectNil(NotebookPencilSample.normalizedPressure(force: .infinity, maximumPossibleForce: 1), "infinite force")

    // Some devices report force fractionally above touch.maximumPossibleForce
    // under a hard press — clamp into range rather than emit >1 or <0.
    expectClose(NotebookPencilSample.normalizedPressure(force: 1.2, maximumPossibleForce: 1.0), 1.0, "over-max clamps to 1")
    expectClose(NotebookPencilSample.normalizedPressure(force: -0.1, maximumPossibleForce: 1.0), 0.0, "negative force clamps to 0")

    // Full sample construction + dictionary shape, both the has-pressure and
    // no-pressure cases — "p" must always be a present key (NSNull, not
    // simply absent) so JS always sees `number | null`, never `undefined`.
    let withPressure = NotebookPencilSample(
      phase: "moved", location: CGPoint(x: 12.5, y: 40.25), force: 0.3, maximumPossibleForce: 1.0, timestamp: 123.456
    )
    let dictA = withPressure.toDictionary()
    precondition(dictA["phase"] as? String == "moved", "phase")
    precondition(dictA["x"] as? Double == 12.5, "x")
    precondition(dictA["y"] as? Double == 40.25, "y")
    precondition(dictA["t"] as? Double == 123.456, "t")
    precondition(abs((dictA["p"] as? Double ?? -1) - 0.3) < 1e-9, "p present as number")

    let noPressure = NotebookPencilSample(
      phase: "began", location: .zero, force: 0, maximumPossibleForce: 0, timestamp: 0
    )
    let dictB = noPressure.toDictionary()
    precondition(dictB["p"] is NSNull, "p present as NSNull when unavailable, not absent")

    print("NOTEBOOK_PENCIL_SAMPLE_PASS")
  }
}
