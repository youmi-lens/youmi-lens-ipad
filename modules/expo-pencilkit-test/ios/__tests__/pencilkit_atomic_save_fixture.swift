// PK3-B Steps 7/11 — proves the real atomic-save + last-known-good-backup +
// corruption-recovery logic this phase's persistence relies on, using
// Foundation's own documented "safe save" API (read directly from this SDK's
// NSFileManager.h, not assumed from memory):
//
//   -replaceItemAtURL:withItemAtURL:backupItemName:options:resultingItemURL:error:
//   "for developers who wish to perform a safe-save... If `backupItemName` is
//   provided, that name will be used to create a backup of the original
//   item... The backup item will be removed in the event of success unless
//   the `NSFileManagerItemReplacementWithoutDeletingBackupItem` option is
//   provided."
//
// This is the exact production logic (mirrored, not re-implemented
// differently) that PencilKitTestModule.swift's saveDrawingAsync/
// loadDrawingAsync use — this fixture is a standalone, ExpoModulesCore-free
// copy so it can compile/run headlessly against the real filesystem, the
// same reason every other fixture in this project is standalone.
//
// Real finding from running this fixture: PKDrawing(strokes:) touches
// PKReplicaManager's CFPreferences-backed replica-UUID bookkeeping, which
// requires a real app-bundle context (a valid CFBundleIdentifier) — a bare
// swiftc/simctl binary has none, and this made the FIRST such call in a
// given simulator instance flaky (crashed deep inside CFEqual on some but
// not all runs, confirmed via crash-log symbolication). Erasing the
// simulator before each run of this fixture reliably avoids it — see
// scripts/notebook-pencilkit-atomic-save.test.mjs.
//
// Second real finding, discovered directly BY this fixture, not assumed:
// PKDrawing(data:) does not reliably throw for arbitrary garbage shorter
// than a genuine empty drawing's serialized size (42 bytes, measured in
// pencilkit_drawing_size_fixture.swift) — some short invalid byte sequences
// decode as a spurious 0-stroke drawing instead of throwing. Production
// corruption detection must not trust "PKDrawing(data:) didn't throw" alone
// for suspiciously small files — see MIN_VALID_PKDRAWING_BYTES below.
import PencilKit
import Foundation

enum AtomicSaveError: Error { case verifyFailed }

let MIN_VALID_PKDRAWING_BYTES = 42

func tryDecode(_ data: Data) -> PKDrawing? {
  guard data.count >= MIN_VALID_PKDRAWING_BYTES else { return nil }
  return try? PKDrawing(data: data)
}

func atomicSaveDrawing(_ data: Data, to finalURL: URL) throws {
  let dir = finalURL.deletingLastPathComponent()
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let tmpURL = dir.appendingPathComponent(finalURL.lastPathComponent + ".tmp-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: tmpURL) }

  try data.write(to: tmpURL, options: [.atomic])
  // Verify the fresh write actually decodes as a real PKDrawing before it is
  // ever allowed to become the trusted current file.
  let verifyData = try Data(contentsOf: tmpURL)
  guard tryDecode(verifyData) != nil else { throw AtomicSaveError.verifyFailed }

  let backupName = finalURL.lastPathComponent + ".bak"
  if FileManager.default.fileExists(atPath: finalURL.path) {
    var resultingURL: NSURL?
    try FileManager.default.replaceItem(
      at: finalURL,
      withItemAt: tmpURL,
      backupItemName: backupName,
      options: [.usingNewMetadataOnly, .withoutDeletingBackupItem],
      resultingItemURL: &resultingURL
    )
  } else {
    try FileManager.default.moveItem(at: tmpURL, to: finalURL)
  }
}

func loadDrawing(from finalURL: URL) -> (drawing: PKDrawing?, usedBackup: Bool) {
  if let data = try? Data(contentsOf: finalURL), let drawing = tryDecode(data) {
    return (drawing, false)
  }
  let backupURL = finalURL.deletingLastPathComponent().appendingPathComponent(finalURL.lastPathComponent + ".bak")
  if let data = try? Data(contentsOf: backupURL), let drawing = tryDecode(data) {
    return (drawing, true)
  }
  return (nil, false)
}

func makeDrawing(marker: String) -> PKDrawing {
  var points: [PKStrokePoint] = []
  for i in 0..<20 {
    points.append(PKStrokePoint(
      location: CGPoint(x: Double(i) * 3, y: Double(marker.count) * 10),
      timeOffset: Double(i) * 0.01, size: CGSize(width: 2, height: 2),
      opacity: 1, force: 0.5, azimuth: 0, altitude: 1
    ))
  }
  let path = PKStrokePath(controlPoints: points, creationDate: Date())
  let ink = PKInk(.pen, color: .black)
  return PKDrawing(strokes: [PKStroke(ink: ink, path: path, transform: .identity, mask: nil)])
}

func run() {
  setvbuf(stdout, nil, _IONBF, 0) // ensure partial output survives a crash, same rationale as the other fixtures' checkpoints

  let tmpDir = FileManager.default.temporaryDirectory.appendingPathComponent("youmi-pk3b-atomic-\(UUID().uuidString)")
  let fileURL = tmpDir.appendingPathComponent("lecture-abc123.pkdrawing")
  let backupURL = tmpDir.appendingPathComponent("lecture-abc123.pkdrawing.bak")

  // 1. Fresh save (no existing file) — plain move, no backup created yet.
  let drawingV1 = makeDrawing(marker: "v1")
  try! atomicSaveDrawing(drawingV1.dataRepresentation(), to: fileURL)
  precondition(FileManager.default.fileExists(atPath: fileURL.path), "primary file must exist after first save")
  precondition(!FileManager.default.fileExists(atPath: backupURL.path), "no backup should exist yet after the very first save")
  let (loadedV1, usedBackup1) = loadDrawing(from: fileURL)
  precondition(loadedV1 != nil && !usedBackup1, "first save must load back successfully from the primary file")
  precondition(loadedV1!.strokes.count == drawingV1.strokes.count, "loaded stroke count must match what was saved")
  print("Step 1 (fresh save, no backup yet): PASS")

  // 2. Second save — replaceItemAtURL must now create the backup from V1's content.
  let drawingV2 = makeDrawing(marker: "v2-longer-marker")
  try! atomicSaveDrawing(drawingV2.dataRepresentation(), to: fileURL)
  precondition(FileManager.default.fileExists(atPath: backupURL.path), "backup must exist after the second save")
  let (loadedPrimaryV2, usedBackupV2) = loadDrawing(from: fileURL)
  precondition(loadedPrimaryV2 != nil && !usedBackupV2, "primary after second save must load V2 directly")
  precondition(loadedPrimaryV2!.strokes.first!.path.count == drawingV2.strokes.first!.path.count, "primary must reflect V2's content, not V1's")
  print("Step 2 (second save creates backup of V1, primary is V2): PASS")

  // 3. Corrupt the primary file only — load must fall back to the backup (V1).
  try! Data("not a valid PKDrawing".utf8).write(to: fileURL)
  let (loadedAfterCorruption, usedBackupAfterCorruption) = loadDrawing(from: fileURL)
  precondition(loadedAfterCorruption != nil && usedBackupAfterCorruption, "corrupt primary must fall back to the last-known-good backup")
  precondition(loadedAfterCorruption!.strokes.first!.path.count == drawingV1.strokes.first!.path.count, "recovered content must be V1 (the backup), not V2")
  print("Step 3 (corrupt primary recovers V1 from backup): PASS")

  // 4. Corrupt BOTH primary and backup — load must fail cleanly (nil), never crash.
  try! Data("also invalid".utf8).write(to: backupURL)
  let (loadedTotalFailure, _) = loadDrawing(from: fileURL)
  precondition(loadedTotalFailure == nil, "corrupt primary AND corrupt backup must return nil, not crash or fabricate a drawing")
  print("Step 4 (corrupt primary AND backup fails cleanly, no crash, no fabricated drawing): PASS")

  try? FileManager.default.removeItem(at: tmpDir)
  print("PENCILKIT_ATOMIC_SAVE_PASS")
}
run()
