import ExpoModulesCore
import PencilKit
import UIKit

/**
 * PK3-B durable PencilKit persistence — real-filesystem save/load for the
 * PK3-A embedded ink layer only (`saveDrawingAsync`/`loadDrawingAsync`
 * below). One raw `PKDrawing.dataRepresentation()` file per lecture (never
 * base64, never through the shared `lectures` AsyncStorage array — see the
 * PK3-B report for why), written via Foundation's documented "safe save"
 * pattern: temp file -> verify it decodes -> `FileManager.replaceItem`
 * (which atomically swaps in the new file AND keeps the file it replaced as
 * a `.bak` last-known-good backup). Two real findings from proving this
 * logic in modules/expo-pencilkit-test/ios/__tests__/
 * pencilkit_atomic_save_fixture.swift, both load-bearing here:
 *   1. `PKDrawing(data:)` does not reliably throw for arbitrary garbage
 *      shorter than a genuine empty drawing's serialized size (42 bytes,
 *      measured in pencilkit_drawing_size_fixture.swift) — some short
 *      invalid byte sequences decode as a spurious 0-stroke drawing instead
 *      of throwing. `minValidPKDrawingBytes` guards against trusting that.
 *   2. Constructing a NEW PKDrawing via PKDrawing(strokes:) touches
 *      PKReplicaManager's CFPreferences-backed bookkeeping, which needs a
 *      real app-bundle context — irrelevant to production (this is a real
 *      Youmi app bundle), it only affected the standalone test fixture.
 */
private enum PencilKitPersistenceError: Error {
  case verifyFailed
  case invalidPath
}

private let minValidPKDrawingBytes = 42

private func tryDecodePKDrawing(_ data: Data) -> PKDrawing? {
  guard data.count >= minValidPKDrawingBytes else { return nil }
  return try? PKDrawing(data: data)
}

/// Serialize -> temp file -> verify it decodes -> atomic replace (keeping the
/// previous good file as `.bak`), or a plain move when there's no existing
/// file yet. Throws (never partially overwrites the current good file) if
/// any step fails, leaving whatever was already on disk untouched.
private func atomicWritePKDrawing(_ data: Data, to finalURL: URL) throws {
  let dir = finalURL.deletingLastPathComponent()
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let tmpURL = dir.appendingPathComponent(finalURL.lastPathComponent + ".tmp-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: tmpURL) }

  try data.write(to: tmpURL, options: [.atomic])
  let verifyData = try Data(contentsOf: tmpURL)
  guard tryDecodePKDrawing(verifyData) != nil else { throw PencilKitPersistenceError.verifyFailed }

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

/// Read the primary file; on any failure (missing, corrupt, or a spurious
/// too-small decode — see `minValidPKDrawingBytes`) fall back to `.bak`.
/// Never throws and never fabricates a drawing from unrecoverable data.
private func loadPKDrawing(from finalURL: URL) -> (drawing: PKDrawing?, usedBackup: Bool) {
  if let data = try? Data(contentsOf: finalURL), let drawing = tryDecodePKDrawing(data) {
    return (drawing, false)
  }
  let backupURL = finalURL.deletingLastPathComponent().appendingPathComponent(finalURL.lastPathComponent + ".bak")
  if let data = try? Data(contentsOf: backupURL), let drawing = tryDecodePKDrawing(data) {
    return (drawing, true)
  }
  return (nil, false)
}

/**
 * PK1/PK2/PK3-A — Apple PencilKit spike surface (see project notes).
 *
 * Two use sites share this exact class:
 *  - PK1/PK2: an isolated, full-screen, opaque-white disposable comparison
 *    screen (`transparent` prop left false/default).
 *  - PK3-A: embedded as a session-only overlay INSIDE the real Notebook
 *    canvas hierarchy (`transparent` prop set true), so existing legacy ink/
 *    images beneath it stay visible. Still completely independent of
 *    Youmi's custom Natural Pen renderer and native Pencil sampler
 *    (`expo-notebook-pencil-sampler`, unmodified — never imported here).
 *
 * No persistence in either use site: `drawing` lives only in this view's
 * memory for as long as it's mounted. `clearAsync()` resets it to an empty
 * `PKDrawing()`. Nothing here reads or writes NoteStroke, AsyncStorage, or
 * any cloud data.
 */
public final class PencilKitTestView: ExpoView, PKCanvasViewDelegate {
  let canvasView = PKCanvasView()
  // PK3-A gesture-ownership fix: the outer Notebook viewport must lock ONLY
  // while a real PencilKit stroke is in progress, not for the whole time the
  // Dev Native Ink Layer is enabled. `canvasViewDidBeginUsingTool`/
  // `canvasViewDidEndUsingTool` are PKCanvasViewDelegate's real, documented
  // BEGIN/END lifecycle pair (read directly from this SDK's PKCanvasView.h:
  // "Called when the user starts/stops using a tool, eg. selecting, drawing,
  // or erasing" — not assumed from memory, and verified compiling/running
  // against a real PKCanvasView in __tests__/pencilkit_stroke_lifecycle_
  // fixture.swift). Two events per stroke, no per-move JS traffic.
  let onPencilStrokeActiveChange = EventDispatcher()
  // Real device-queried PKInkingTool.InkType.pen.validWidthRange is
  // 0.878...25.66 (default 2.68) — see the PK2 report. These three are
  // defensible points inside that real range, loosely echoing Youmi's own
  // existing Thin/Medium/Thick (2 / 3.5 / 6), not independently invented.
  // Physically re-confirmed good at all three in PK2 — do not retune (PK3-A).
  static let widthPresets: [String: CGFloat] = ["thin": 1.5, "medium": 2.68, "thick": 6.0]

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    // Ordinary handwriting/note-taking ink — the same type PKCanvasView uses
    // as its own default tool, matching what the Notes app opens with. NOT
    // marker/monoline/fountain-pen/watercolor/crayon — see the module's own
    // ink-type audit in the Phase PK1 report for why.
    //
    // `PKInkType` is NS_TYPED_ENUM + NS_REFINED_FOR_SWIFT — its actual Swift
    // name is the nested `PKInkingTool.InkType`, not a top-level `PKInkType`,
    // and `PKInkingTool`'s Swift-refined initializer takes the ink type as an
    // UNLABELED first argument with an OPTIONAL width (nil uses the type's
    // own default) — confirmed directly from this SDK's own
    // PencilKit.swiftmodule/*.swiftinterface, not assumed from the ObjC
    // header alone (an earlier attempt using the raw ObjC shape failed to
    // compile: "cannot find 'PKInkType' in scope").
    let inkType: PKInkingTool.InkType = .pen
    canvasView.tool = PKInkingTool(inkType, color: .black, width: inkType.defaultWidth)

    // Pencil-only so finger touches can never contaminate the handwriting
    // comparison / never draw during Notebook finger-navigation.
    canvasView.drawingPolicy = .pencilOnly

    // PK3-A single-viewport-authority requirement: PKCanvasView is a
    // UIScrollView subclass and, left at its default, would independently
    // respond to finger pan/pinch on ITS OWN content (drawingPolicy only
    // gates drawing, not scrolling — confirmed from PKCanvasView.h, which
    // declares no separate "scrolling policy"). Disabling scroll here is
    // universal (applies to the PK1/PK2 screen too) since it is only ever
    // correct: this view must never independently pan/zoom in either use
    // site — Notebook's existing scroll/zoom (PK3-A) or nothing (PK1/PK2,
    // a fixed-size screen) must be the sole viewport authority.
    canvasView.isScrollEnabled = false

    // No PKToolPicker: this spike is not a tool-switching UI, just one fixed
    // pen so the comparison is apples-to-apples with one fixed Youmi profile.
    canvasView.drawing = PKDrawing()
    canvasView.backgroundColor = .white
    canvasView.isOpaque = true

    // PK3-A only: PK1/PK2's isolated screen never reads this event (nothing
    // listens for it there), so assigning it universally is harmless — same
    // reasoning as `isScrollEnabled = false` above.
    canvasView.delegate = self

    addSubview(canvasView)
  }

  public func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
    onPencilStrokeActiveChange(["active": true])
  }

  public func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
    onPencilStrokeActiveChange(["active": false])
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    canvasView.frame = bounds
  }

  /// PK3-A only: transparent so legacy strokes/images beneath this overlay
  /// (inside the real Notebook canvas) remain visible. Never used by the
  /// PK1/PK2 isolated full-screen spike, which keeps its original opaque
  /// white background unchanged.
  func setTransparent(_ transparent: Bool) {
    canvasView.backgroundColor = transparent ? .clear : .white
    canvasView.isOpaque = !transparent
  }

  func clear() {
    canvasView.drawing = PKDrawing()
  }

  /// PK2 width verification only (section 19) — changes the BASE width of the
  /// current `.pen` tool. Does not touch ink type, color, or drawingPolicy,
  /// and never affects existing/already-drawn strokes (PencilKit strokes
  /// bake in the tool's width at draw time, same as any ink app) — only the
  /// NEXT stroke drawn uses the new width, exactly like Youmi's own Thin/
  /// Medium/Thick selector.
  func setWidthPreset(_ preset: String) {
    guard let width = Self.widthPresets[preset] else { return }
    let inkType: PKInkingTool.InkType = .pen
    canvasView.tool = PKInkingTool(inkType, color: .black, width: width)
  }

  /// PK3-B — durably writes the CURRENT `canvasView.drawing` to `path` (a
  /// `file://` URI, computed JS-side by lib/notebookInkStorage.ts so this
  /// module never needs its own directory-naming logic). Bytes never cross
  /// the JS bridge — only the path string does, avoiding a multi-hundred-KB-
  /// to-multi-MB round trip for a real handwritten page (see the PK3-B
  /// report's size measurements). Throws on failure, leaving whatever was
  /// already durably saved untouched (atomicWritePKDrawing never partially
  /// overwrites the current good file).
  func saveDrawing(to path: String) throws -> [String: Any] {
    guard let url = URL(string: path) else { throw PencilKitPersistenceError.invalidPath }
    let drawing = canvasView.drawing
    let data = drawing.dataRepresentation()
    try atomicWritePKDrawing(data, to: url)
    return ["success": true, "strokeCount": drawing.strokes.count, "byteSize": data.count]
  }

  /// PK3-B — loads `path` into `canvasView.drawing` if a valid drawing (or
  /// last-known-good backup) exists there; otherwise leaves the canvas
  /// untouched and returns `success: false` — the normal, expected case for
  /// a lecture that has never had PencilKit ink, never an error. A primary
  /// file that EXISTS but is unrecoverable (corrupt, and no usable backup)
  /// is a distinct, logged condition (Step 11) — still returns success:
  /// false rather than throwing, since a bad PK file must never block the
  /// rest of Notebook (legacy strokes/images/text) from opening.
  func loadDrawing(from path: String) -> [String: Any] {
    guard let url = URL(string: path) else {
      return ["success": false, "strokeCount": 0, "usedBackup": false]
    }
    let primaryExisted = FileManager.default.fileExists(atPath: url.path)
    let (drawing, usedBackup) = loadPKDrawing(from: url)
    guard let drawing else {
      if primaryExisted {
        print("[PencilKitTest] loadDrawing: \(path) exists but is unreadable/corrupt and no valid backup was found — legacy note content is unaffected")
      }
      return ["success": false, "strokeCount": 0, "usedBackup": false]
    }
    canvasView.drawing = drawing
    return ["success": true, "strokeCount": drawing.strokes.count, "usedBackup": usedBackup]
  }
}

public final class ExpoPencilKitTestModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoPencilKitTest")

    View(PencilKitTestView.self) {
      Prop("transparent") { (view: PencilKitTestView, transparent: Bool?) in
        view.setTransparent(transparent ?? false)
      }
      Events("onPencilStrokeActiveChange")
      AsyncFunction("clearAsync") { (view: PencilKitTestView) in
        view.clear()
      }
      AsyncFunction("setWidthPresetAsync") { (view: PencilKitTestView, preset: String) in
        view.setWidthPreset(preset)
      }
      AsyncFunction("saveDrawingAsync") { (view: PencilKitTestView, path: String) -> [String: Any] in
        try view.saveDrawing(to: path)
      }
      AsyncFunction("loadDrawingAsync") { (view: PencilKitTestView, path: String) -> [String: Any] in
        view.loadDrawing(from: path)
      }
    }
  }
}
