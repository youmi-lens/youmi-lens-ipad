import Foundation
import CoreGraphics

/// One authoritative Apple Pencil sample for Notebook's Natural Pen input
/// foundation. Every field is read from the SAME `UITouch` (see
/// `NotebookPencilSamplerModule.swift`'s gesture recognizer) — this type
/// itself has no UIKit dependency so it can be compiled and exercised outside
/// the app target (see `__tests__/notebook_pencil_sample_fixture.swift`).
public struct NotebookPencilSample {
  public let phase: String // "began" | "moved" | "ended" | "cancelled"
  public let x: Double
  public let y: Double
  /// Normalized 0...1, or nil when the device/touch cannot report a
  /// meaningful pressure. Never fabricated.
  public let pressure: Double?
  /// Passthrough of `UITouch.timestamp` (seconds since system boot).
  public let timestamp: Double

  public init(phase: String, location: CGPoint, force: Double, maximumPossibleForce: Double, timestamp: Double) {
    self.phase = phase
    self.x = Double(location.x)
    self.y = Double(location.y)
    self.pressure = NotebookPencilSample.normalizedPressure(force: force, maximumPossibleForce: maximumPossibleForce)
    self.timestamp = timestamp
  }

  /// Pure and deterministic: guards every way `force / maximumPossibleForce`
  /// can misbehave (zero/negative/NaN/infinite denominator, non-finite
  /// numerator) by returning nil rather than a fabricated or garbage value.
  /// Clamps a technically-out-of-range ratio (some devices report force
  /// fractionally above their own maximum under hard presses) into 0...1.
  public static func normalizedPressure(force: Double, maximumPossibleForce: Double) -> Double? {
    guard force.isFinite, maximumPossibleForce.isFinite, maximumPossibleForce > 0 else { return nil }
    let value = force / maximumPossibleForce
    guard value.isFinite else { return nil }
    return min(max(value, 0), 1)
  }

  /// `p` is always present (never an absent/optional key) so JS always sees
  /// `number | null`, matching the Phase 3B-2 contract, rather than
  /// `number | undefined` for the no-pressure case.
  public func toDictionary() -> [String: Any] {
    return [
      "phase": phase,
      "x": x,
      "y": y,
      "t": timestamp,
      "p": pressure ?? NSNull(),
    ]
  }
}
