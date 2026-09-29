import ExpoModulesCore
import PDFKit
import UIKit

/// Bounded, release-safe physical-QA tracing for Course Material text only.
/// It is compiled into the native module but can run solely when the Dev
/// variant's Info.plist explicitly sets `YoumiMaterialTextTrace=true`; normal
/// Dev and every production build leave it disabled. It observes state and
/// geometry only — it never changes annotation ownership, rendering, gestures,
/// persistence, or recorder behavior.
private enum MaterialTextTrace {
  private static let enabled = (Bundle.main.object(forInfoDictionaryKey: "YoumiMaterialTextTrace") as? Bool) == true
  private static var remaining = 96

  static func log(_ event: String, _ fields: () -> String) {
    guard enabled, remaining > 0 else { return }
    remaining -= 1
    print("[material-text-trace] event=\(event) \(fields())")
  }

}

/// Native PDFKit viewer + Pencil annotation overlay for Youmi Lens.
///
/// Phase 1 gave us native PDFKit scroll + pinch zoom. Phase 2 adds an
/// Apple-Pencil-only drawing overlay on top of the same PDFView. Strokes
/// are stored in **PDFKit page coordinates** so they stay glued to the page
/// across zoom, pan, and page changes.
///
/// ── Gesture split (Phase 2 fix) ─────────────────────────────────────────
/// The first Phase 2 cut tried to filter Pencil touches inside a UIView
/// `hitTest(_:with:)` override on the overlay. That pattern is unreliable —
/// `UIEvent.allTouches` is not populated consistently while iOS is
/// speculatively hit-testing for gesture probing, so Pencil touches kept
/// falling through and Pen mode behaved like Scroll mode.
///
/// The reliable approach (same one Notability / GoodNotes use):
///   - A custom `UIGestureRecognizer` with `allowedTouchTypes = [.pencil]`,
///     attached to PDFView. The OS itself routes only Pencil touches to it,
///     using the same plumbing PencilKit relies on.
///   - The overlay (`AnnotationOverlay`) is now a pure rendering surface
///     (`isUserInteractionEnabled = false`); the gesture recognizer drives
///     it via `beginStroke / appendPoint / endStroke`.
///   - While in pen mode we restrict PDFView's internal pan gesture to
///     `[.direct]` (finger only) so Pencil never accidentally scrolls
///     the page mid-stroke. In scroll mode we restore the default so the
///     Pencil can still scroll when not drawing.
public final class PdfAnnotationView: ExpoView {
  private let pdfView = PDFView(frame: .zero)
  private lazy var annotationOverlay: AnnotationOverlay = {
    let v = AnnotationOverlay(pdfView: pdfView)
    v.translatesAutoresizingMaskIntoConstraints = false
    v.backgroundColor = .clear
    v.isOpaque = false
    // Pure rendering — gesture recognizer below drives stroke input.
    v.isUserInteractionEnabled = false
    v.onShapeHold = { [weak self] token, pageNumber, points in
      guard let self else { return }
      self.onShapeHold([
        "token": token, "pageNumber": pageNumber, "scale": Double(self.pdfView.scaleFactor),
        "points": points.map { [Double($0.x), Double($0.y)] },
      ])
    }
    return v
  }()

  private lazy var pencilGesture: PencilDrawGestureRecognizer = {
    let g = PencilDrawGestureRecognizer(target: self, action: #selector(handlePencilGesture(_:)))
    g.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
    g.cancelsTouchesInView = false  // don't kill PDFView's own gestures
    g.delaysTouchesBegan = false
    g.delaysTouchesEnded = false
    g.delegate = self
    g.isEnabled = false              // turned on by annotationMode = "pen"
    return g
  }()

  private lazy var selectionGesture: PageSelectionGestureRecognizer = {
    let gesture = PageSelectionGestureRecognizer(target: self, action: #selector(handleSelectionGesture(_:)))
    gesture.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
    gesture.cancelsTouchesInView = true
    gesture.delegate = self
    gesture.isEnabled = false
    return gesture
  }()

  /// ONE finger that begins INSIDE the selected region moves it; two fingers beginning inside scale it.
  /// A finger that begins anywhere else fails at once, so PDFView keeps panning/zooming (never locked).
  private lazy var selectionFingerGesture: SelectionFingerGestureRecognizer = {
    let gesture = SelectionFingerGestureRecognizer(target: self, action: #selector(handleSelectionFingerGesture(_:)))
    gesture.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    gesture.cancelsTouchesInView = true
    gesture.delegate = self
    gesture.isEnabled = false
    gesture.beginsInside = { [weak self] point in self?.annotationOverlay.fingerHitsSelection(at: point) ?? false }
    return gesture
  }()

  /// Finger tap in Select: on a structured shape's outline selects it; on blank paper is an explicit deselect.
  private lazy var selectionTapGesture: UITapGestureRecognizer = {
    let g = UITapGestureRecognizer(target: self, action: #selector(handleSelectionTap(_:)))
    g.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    g.cancelsTouchesInView = false
    g.delegate = self
    g.isEnabled = false
    return g
  }()

  /// Direct tap-to-create/edit in Text mode; PDF scrolling remains independent.
  private lazy var textTapGesture: UITapGestureRecognizer = {
    let g = UITapGestureRecognizer(target: self, action: #selector(handleTextTap(_:)))
    g.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    g.delegate = self
    return g
  }()

  /// Native inline text editing — replaces the old "tap → JS opens a modal"
  /// flow. A UITextView positioned directly over the PDF page at the
  /// annotation's own anchor point; the user types on the canvas itself,
  /// PDFKit's keyboard/caret handle everything, and JS only ever learns the
  /// FINAL committed text (same shape as how "paste" already works — JS
  /// persists, it never owns the typing UX). isScrollEnabled = false and
  /// zero container insets/padding so its auto-growing height matches
  /// drawTextAnnotation's own NSString.boundingRect math as closely as
  /// possible — minimizes any visual size jump at commit.
  private lazy var inlineTextEditor: UITextView = {
    let tv = UITextView(frame: .zero)
    tv.isHidden = true
    tv.backgroundColor = .clear
    tv.textColor = .label
    tv.textContainerInset = .zero
    tv.textContainer.lineFragmentPadding = 0
    tv.isScrollEnabled = false
    tv.autocorrectionType = .default
    tv.delegate = self
    return tv
  }()

  /// Set for the duration of one inline text edit/create session. `id == nil`
  /// means a brand-new annotation (nothing committed to the store yet);
  /// non-nil means editing an existing one (suppressed from drawing/hit-
  /// testing for the duration — see AnnotationOverlay.editingTextAnnotationId).
  /// Immutable PDF-page anchor; old annotations retain bottom-anchor semantics.
  private typealias InlineTextContext = (id: String?, pageNumber: Int, originX: Double, originY: Double, fontSize: Double, width: Double, anchor: String?)
  private var inlineTextEditingContext: InlineTextContext?
  /// Only used if PDFKit's document host is temporarily unavailable. Keep the
  /// actual editor until its document representation is ready; never a timer.
  private var pendingInlineTextHandoff: (id: String, context: InlineTextContext)?
  /// PDFKit sends contentOffset/bounds KVO while its internal page transform
  /// is still transient (the physical trace captured a valid editor frame,
  /// then y=-75893, then the same valid frame again at identical PDF coords).
  /// Coalesce those notifications to the end of THIS main-runloop layout turn
  /// before asking PDFKit to convert the stable document anchor. This is not a
  /// timed debounce: it merely avoids making the UITextView own a frame from
  /// an in-progress PDFKit transform.
  private var inlineEditorRepositionScheduled = false

  private var document: PDFDocument?
  private var sourceDocument: PDFDocument?
  private var sourcePageCount: Int = 0
  private var loadedFileUri: String?
  private var hasAppliedInitialPage = false
  private var lastEmittedPage: Int?
  private var observedScrollView: UIScrollView?
  /// Default pan-gesture touch-type list, captured before we ever restrict it.
  /// Used to restore scroll-mode behaviour without guessing.
  private var defaultPanAllowedTouchTypes: [NSNumber]?
  /// PDFKit owns private gesture recognizers for text selection/copy. In
  /// annotation modes those recognizers must not see Apple Pencil touches, or
  /// dragging over PDF text opens the native Copy / Select / Look Up menu.
  /// Store their original touch filters so Hand/scroll mode can restore PDFKit.
  private var defaultAllowedTouchTypesByRecognizer: [ObjectIdentifier: [NSNumber]] = [:]
  /// Tracks the bounds size we last applied scale settings for, so we only
  /// recompute min/max on actual orientation/splitview changes — never per
  /// layout pass (which would yank user pinch state mid-gesture).
  private var lastBoundsSize: CGSize = .zero
  private var pendingInitialViewport: (pageIndex: Int, scale: CGFloat, anchor: CGPoint)?
  private var restorationComplete = false
  /// Guards against reentrant restore attempts. layoutSubviews() calls
  /// applyInitialViewportIfPossible() on every layout pass, and the restore
  /// sequence itself (go(to:) + a large scaleFactor change + go(to:) again)
  /// triggers further layout passes on pdfView BEFORE restorationComplete
  /// flips true — without this guard, those reentrant calls race the
  /// original one and can leave PDFKit's actual scroll position settled on
  /// the wrong page (proven from a physical repro: restore correctly
  /// reaches the saved page, then an unprompted page-1 jump follows within
  /// ~300ms, matching PDFKit's deferred layout/re-tiling after a large zoom
  /// change racing this function's own later steps).
  private var isRestoringViewport = false
  private var viewportRestoreAttempts = 0
  /// True only when a restore attempt's settled viewport was independently
  /// VERIFIED to match the saved target. `restorationComplete` alone means
  /// "the restore sequence stopped running" — that included exhausting the
  /// retry budget WITHOUT a match, which used to still enable normal event
  /// emission, letting a synthetic layout-driven page/scale change (not a
  /// real user action) get persisted over the known-good saved viewport.
  /// `restoreVerified` is the trust bit: emission is gated on
  /// `restoreVerified || userHasInteracted`, never on `restorationComplete`
  /// alone.
  private var restoreVerified = false
  /// True once a genuine user pan/pinch gesture has begun on the PDFView's
  /// own scroll view (see startObservingScroll's gesture observers). This is
  /// deliberately NOT inferred from PDFViewPageChanged/onViewportChanged,
  /// since PDFKit itself generates those during layout and restore, not only
  /// from real touches. Once true for this mount, normal persistence is
  /// unlocked regardless of whether the initial restore ever verified —
  /// the user has taken over the viewport.
  private var userHasInteracted = false
  /// Emission (onPageChanged / onViewportChanged / captureViewportPayload)
  /// is only trustworthy once the restore actually verified against the
  /// saved target, or the user has explicitly taken over navigation.
  private var viewportTrustedForEmission: Bool { restoreVerified || userHasInteracted }
  #if DEBUG
  private var restoreTraceRemaining = 100
  /// A bounded, per-gesture forensic window for the material viewport-jump
  /// investigation. It is deliberately armed only by a Pencil stroke or a
  /// tool change, so normal reading does not produce scroll/layout noise.
  private var viewportTraceSequence = 0
  private var viewportTraceUntil: Date?
  private var pencilStrokeActive = false
  private var strokeJustEnded = false
  private var strokeFirstSampleSeen = false

  private func armViewportTrace(_ reason: String) {
    viewportTraceUntil = Date().addingTimeInterval(2)
    traceViewportMutation("trace-armed", reason: reason, force: true)
  }

  private func traceViewportMutation(_ event: String, reason: String = "", force: Bool = false) {
    guard force || (viewportTraceUntil.map { Date() <= $0 } ?? false) else { return }
    viewportTraceSequence += 1
    let scroll = observedScrollView ?? findInnerScrollView(in: pdfView)
    let visible = pdfView.page(for: .zero, nearest: true).flatMap { page in document.map { $0.index(for: page) + 1 } }
    let currentPage = pdfView.currentPage.flatMap { page in document.map { $0.index(for: page) + 1 } }
    onViewportDiagnostic([
      "sequence": viewportTraceSequence,
      "event": event,
      "reason": reason,
      "currentPage": currentPage as Any,
      "visiblePage": visible as Any,
      "offsetX": scroll?.contentOffset.x as Any,
      "offsetY": scroll?.contentOffset.y as Any,
      "scaleFactor": pdfView.scaleFactor,
      "pageCount": document?.pageCount ?? 0,
      "annotationCount": annotationOverlay.annotationCount,
      "pencilActive": pencilStrokeActive,
      "strokeJustEnded": strokeJustEnded,
      "mode": annotationMode,
      "restoring": isRestoringViewport,
      "restorationComplete": restorationComplete,
    ])
    print("[material-viewport-trace] seq=\(viewportTraceSequence) t=\(ProcessInfo.processInfo.systemUptime) event=\(event) reason=\(reason) currentPage=\(String(describing: currentPage)) visiblePage=\(String(describing: visible)) offset=\(String(describing: scroll?.contentOffset)) scale=\(pdfView.scaleFactor) pages=\(document?.pageCount ?? 0) annotations=\(annotationOverlay.annotationCount) pencilActive=\(pencilStrokeActive) strokeJustEnded=\(strokeJustEnded) mode=\(annotationMode) restoring=\(isRestoringViewport) restoreComplete=\(restorationComplete)")
  }

  /// Pencil double-tap / palm viewport-jump investigation: setNonPencilGesturesEnabled(true)
  /// re-enables pan/pinch the INSTANT a stroke ends, with no grace at all —
  /// unlike Notebook's 300ms window. If a palm is still resting at that
  /// exact moment (the common case: a brief pause to double-tap, or just a
  /// pause between strokes), it can drive the freshly re-enabled pan
  /// immediately. This is a bounded, one-shot watch armed at that release
  /// point, not polling — observeValue below only checks it while armed.
  private var postStrokeWatchUntil: Date?
  private var postStrokeWatchBaseline: CGPoint?
  private static let postStrokeWatchSeconds: TimeInterval = 1.2

  private func armPostStrokeWatch(reason: String) {
    postStrokeWatchUntil = Date().addingTimeInterval(Self.postStrokeWatchSeconds)
    postStrokeWatchBaseline = observedScrollView?.contentOffset
    print("[PdfAnnotationView] post-stroke-watch-armed reason=\(reason) baseline=\(String(describing: postStrokeWatchBaseline))")
  }
  #endif

  /// Bounded diagnostic for one mount; no timers or per-scroll bridge traffic.
  private func traceRestore(_ phase: String) {
    #if DEBUG
    guard restoreTraceRemaining > 0 else { return }
    restoreTraceRemaining -= 1
    let actual = currentViewport()
    let scroll = observedScrollView ?? findInnerScrollView(in: pdfView)
    print("[material-restore-v2] t=\(ProcessInfo.processInfo.systemUptime) phase=\(phase) attempt=\(viewportRestoreAttempts) complete=\(restorationComplete) restoring=\(isRestoringViewport) target=\(String(describing: pendingInitialViewport)) actual=\(String(describing: actual)) bounds=\(pdfView.bounds) documentBounds=\(String(describing: pdfView.documentView?.bounds)) offset=\(String(describing: scroll?.contentOffset)) total=\(document?.pageCount ?? 0)")
    #endif
  }
  private static let maxViewportRestoreAttempts = 3
  private var viewportEmitWorkItem: DispatchWorkItem?

  let onPageChanged = EventDispatcher()
  let onLoadComplete = EventDispatcher()
  let onViewportChanged = EventDispatcher()
  let onError = EventDispatcher()
  let onAnnotationsChanged = EventDispatcher()
  let onEraserGestureEnded = EventDispatcher()
  let onTextAnnotationAction = EventDispatcher()
  let onSelectionChanged = EventDispatcher()
  let onSelectionMoved = EventDispatcher()
  let onShapeEdited = EventDispatcher()
  let onSelectionScaled = EventDispatcher()
  /// Pencil touched down / lifted (ink tools). JS holds heavy prop pushes while active.
  let onPencilActivity = EventDispatcher()
  /// Draw-and-hold reached with an eligible stroke. JS runs the shared recognizer and answers with applyShapeSnap.
  let onShapeHold = EventDispatcher()
  let onViewportDiagnostic = EventDispatcher()

  var fileUri: String? {
    didSet { if fileUri != oldValue { loadDocumentIfNeeded() } }
  }

  var initialPage: Int = 1 {
    didSet {
      #if DEBUG
      print("[material-viewport] native prop initialPage=\(initialPage) oldValue=\(oldValue) hasAppliedInitialPage=\(hasAppliedInitialPage)")
      #endif
      if initialPage != oldValue { applyInitialPageIfPossible() }
    }
  }

  var initialViewport: [String: Any]? {
    didSet {
      #if DEBUG
      print("[material-viewport] native prop initialViewport-didSet raw=\(String(describing: initialViewport)) restorationCompleteBefore=\(restorationComplete)")
      #endif
      guard let value = initialViewport,
            Self.double(value["version"]) == 1,
            let page = Self.double(value["pageIndex"]),
            let scale = Self.double(value["scaleFactor"]),
            let x = Self.double(value["anchorX"]), let y = Self.double(value["anchorY"])
      else {
        #if DEBUG
        print("[material-viewport] native prop initialViewport-didSet REJECTED (invalid/nil payload)")
        #endif
        return
      }
      let parsed = (
        pageIndex: max(1, Int(page)),
        scale: max(0.01, CGFloat(scale)),
        anchor: CGPoint(x: max(0, x), y: max(0, y))
      )

      // Re-applying the SAME restore target must be a no-op — this guard is
      // the exact counterpart of initialPage's `if initialPage != oldValue`
      // above, which this property was missing.
      //
      // `initialViewport` is frozen at mount on the JS side (useState with no
      // setter, see app/lecture-material/[lectureId]/[materialId].tsx), so its
      // value is "the viewport this screen was OPENED at" and never changes
      // for the life of the screen. But under the New Architecture the prop
      // setter runs again on every re-render of that screen, and without an
      // equality check this didSet then cleared restorationComplete and
      // re-entered applyInitialViewportIfPossible() — which is otherwise
      // guarded by `!restorationComplete` and therefore safe to call from
      // layout/document paths. That re-armed a full restore back to the
      // MOUNT viewport, discarding wherever the user had since scrolled to.
      //
      // Proven physically (forensic trace, seq 407 -> 408): a committed
      // Pencil stroke at page 7 / offsetY 4842 with restorationComplete=true
      // was followed immediately by restorationComplete=false, restoring=true
      // at page 1 / offsetY -45. Both reported repros reduce to "the screen
      // re-rendered": a stroke commit (annotation store update + viewport
      // persist-write) and an Apple Pencil double-tap (annotationMode state
      // change) are simply two different causes of the same re-render, which
      // is why the jump is not stroke-content-specific.
      if let pending = pendingInitialViewport,
         pending.pageIndex == parsed.pageIndex,
         pending.scale == parsed.scale,
         pending.anchor == parsed.anchor {
        #if DEBUG
        print("[material-viewport] native prop initialViewport-didSet IGNORED (target unchanged) pending=\(String(describing: pendingInitialViewport))")
        #endif
        return
      }

      pendingInitialViewport = parsed
      restorationComplete = false
      restoreVerified = false
      #if DEBUG
      print("[material-viewport] native prop initialViewport-didSet ACCEPTED pendingInitialViewport=\(String(describing: pendingInitialViewport))")
      traceViewportMutation("native-prop-initialViewport-rearm", reason: "new restore target page=\(parsed.pageIndex)", force: true)
      #endif
      applyInitialViewportIfPossible()
    }
  }

  /// "scroll", "pen", "highlighter", or "eraser". Forwarded into the overlay's rendering mode AND
  /// flips the Pencil gesture + PDFView's pan-touch-type restriction.
  var annotationMode: String = "scroll" {
    didSet {
      if annotationMode != oldValue {
        #if DEBUG
        armViewportTrace("annotationMode \(oldValue) -> \(annotationMode)")
        traceViewportMutation("native-prop-mode", reason: "React tool update", force: true)
        armPostStrokeWatch(reason: "annotationMode \(oldValue) -> \(annotationMode)")
        #endif
        annotationOverlay.mode = annotationMode
        updateGestureMode()
        if annotationMode != "select" { selectionToolChanged() }
        // Leaving "text" mode (e.g. switching to Pen) must never leave an
        // inline editor dangling open — commit whatever was being typed
        // first, exactly as if the user had tapped away.
        if annotationMode != "text" {
          commitInlineTextEditorIfNeeded()
        }
        // Drop the eraser cursor the moment the mode leaves "eraser" — this
        // covers manual tool switches AND the Apple Pencil double-tap path
        // (temporary eraser returns to Pen / Highlighter by flipping the
        // annotationMode prop back from JS).
        if annotationMode != "eraser" {
          annotationOverlay.hideEraserPreview()
        }
        #if DEBUG
        print("[PdfAnnotationView] annotationMode → \(annotationMode), pencilGesture.isEnabled=\(pencilGesture.isEnabled)")
        #endif
      }
    }
  }

  var selectionShape: String = "lasso" {
    didSet { if selectionShape != oldValue { annotationOverlay.cancelRegion() } }
  }

  func setSelection(pageNumber: Int, ids: [String]) {
    annotationOverlay.setSelection(pageNumber: pageNumber, ids: ids)
    onSelectionChanged(["pageNumber": ids.isEmpty ? 0 : pageNumber, "strokeIds": ids])
  }

  func clearSelection() {
    annotationOverlay.clearSelection()
    onSelectionChanged(["pageNumber": 0, "strokeIds": []])
  }

  /// Leaving the Select tool is one of the explicit deselection events.
  private func selectionToolChanged() {
    annotationOverlay.toolChanged(to: annotationMode)
    onSelectionChanged(["pageNumber": 0, "strokeIds": []])
  }

  var penColor: String = "#061B34" {
    didSet { annotationOverlay.penColor = penColor }
  }

  var penWidth: Double = 2.4 {
    didSet { annotationOverlay.penWidth = penWidth }
  }

  var highlighterColor: String = "#FFE066" {
    didSet { annotationOverlay.highlighterColor = highlighterColor }
  }

  var highlighterWidth: Double = 18 {
    didSet { annotationOverlay.highlighterWidth = highlighterWidth }
  }

  var eraserRadius: Double = 26 {
    didSet { annotationOverlay.eraserRadius = eraserRadius }
  }

  var shapeSnapEnabled: Bool = false {
    didSet { annotationOverlay.shapeSnapEnabled = shapeSnapEnabled }
  }
  var shapeSnapHoldMs: Double = 650 {
    didSet { annotationOverlay.shapeSnapHoldSeconds = shapeSnapHoldMs / 1000 }
  }
  var shapeSnapTolerancePt: Double = 3.5 {
    didSet { annotationOverlay.shapeSnapTolerancePt = shapeSnapTolerancePt }
  }

  func applyShapeSnap(token: Int, points: [[Double]], shape: [String: Any]? = nil) {
    annotationOverlay.applyShapeSnap(
      token: token,
      points: points.compactMap { $0.count == 2 ? CGPoint(x: $0[0], y: $0[1]) : nil },
      shape: StrokeShape.parse(shape))
  }

  /// Strokes to render, keyed by 1-based page number. Coords in PDF page space.
  var annotationsByPage: [String: Any]? {
    didSet {
      #if DEBUG
      traceViewportMutation("native-prop-annotations-before", reason: "React annotationsByPage update")
      #endif
      annotationOverlay.loadAnnotations(annotationsByPage)
      #if DEBUG
      traceViewportMutation("native-prop-annotations-after", reason: "React annotationsByPage update")
      #endif
    }
  }

  /// Number of stable, Youmi-owned blank pages after the immutable source PDF.
  var appendedBlankPageCount: Int = 0 {
    didSet {
      guard appendedBlankPageCount != oldValue else { return }
      rebuildCompositeDocument(preservingCurrentPage: true)
    }
  }

  var textAnnotationsByPage: [String: Any]? {
    didSet {
      MaterialTextTrace.log("prop-text-annotations") {
        "pages=\(textAnnotationsByPage?.keys.sorted() ?? [])"
      }
      annotationOverlay.loadTextAnnotations(textAnnotationsByPage)
      completeInlineTextHandoffIfReady()
    }
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = Self.workspaceCanvasColor

    pdfView.translatesAutoresizingMaskIntoConstraints = false
    // autoScales = false on purpose. With autoScales = true PDFView resets
    // the scale to "fit" on any bounds-derived layout pass, which steps on
    // user pinch state and breaks pinch-in / zoom-out. We apply the initial
    // fit explicitly once the document loads (and again only when the
    // outer view's bounds.size actually changes — see layoutSubviews).
    pdfView.autoScales = false
    pdfView.displayMode = .singlePageContinuous
    pdfView.displayDirection = .vertical
    pdfView.usePageViewController(false, withViewOptions: nil)
    pdfView.backgroundColor = Self.workspaceCanvasColor
    pdfView.displaysPageBreaks = true
    pdfView.pageBreakMargins = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
    // min/max scale are configured once `scaleFactorForSizeToFit` is meaningful,
    // i.e. after the document is set and the view has non-zero bounds.

    addSubview(pdfView)
    NSLayoutConstraint.activate([
      pdfView.leadingAnchor.constraint(equalTo: leadingAnchor),
      pdfView.trailingAnchor.constraint(equalTo: trailingAnchor),
      pdfView.topAnchor.constraint(equalTo: topAnchor),
      pdfView.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])

    addSubview(annotationOverlay)
    NSLayoutConstraint.activate([
      annotationOverlay.leadingAnchor.constraint(equalTo: leadingAnchor),
      annotationOverlay.trailingAnchor.constraint(equalTo: trailingAnchor),
      annotationOverlay.topAnchor.constraint(equalTo: topAnchor),
      annotationOverlay.bottomAnchor.constraint(equalTo: bottomAnchor)
    ])
    bringSubviewToFront(annotationOverlay)

    // The temporary editor is above the inert overlay; committed text lives
    // in documentView and has no persistent manipulation controls.
    addSubview(inlineTextEditor)

    // Attach Pencil-only gesture recognizer to PDFView. allowedTouchTypes
    // is the OS-level filter that actually works (vs the hitTest dance).
    pdfView.addGestureRecognizer(pencilGesture)
    pdfView.addGestureRecognizer(selectionGesture)
    pdfView.addGestureRecognizer(selectionFingerGesture)
    pdfView.addGestureRecognizer(selectionTapGesture)
    annotationOverlay.onSelectionReconciled = { [weak self] page, ids in
      self?.onSelectionChanged(["pageNumber": page, "strokeIds": ids])
    }
    let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleFingerLongPress(_:)))
    longPress.minimumPressDuration = 0.45
    longPress.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    longPress.delegate = self
    pdfView.addGestureRecognizer(longPress)
    textTapGesture.require(toFail: longPress)
    pdfView.addGestureRecognizer(textTapGesture)
    applyWorkspaceCanvasColors()

    NotificationCenter.default.addObserver(
      self, selector: #selector(handlePageChanged(_:)),
      name: Notification.Name.PDFViewPageChanged, object: pdfView
    )
    NotificationCenter.default.addObserver(
      self, selector: #selector(handleAnnotationLayoutChange),
      name: Notification.Name.PDFViewScaleChanged, object: pdfView
    )
    NotificationCenter.default.addObserver(
      self, selector: #selector(handleAnnotationLayoutChange),
      name: Notification.Name.PDFViewVisiblePagesChanged, object: pdfView
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    stopObservingScroll()
  }

  public override func layoutSubviews() {
    #if DEBUG
    traceViewportMutation("layoutSubviews-before", reason: "native layout")
    #endif
    traceRestore("layout-before-super")
    super.layoutSubviews()
    traceRestore("layout-after-super")
    // Only re-apply the scale window when the outer bounds actually change
    // (orientation, splitview, modal resize). Per-frame layout passes during
    // a pinch must NOT touch scaleFactor or recompute min — that's what
    // previously made zoom-out feel stuck.
    if document != nil,
       bounds.width > 0, bounds.height > 0,
       bounds.size != lastBoundsSize {
      lastBoundsSize = bounds.size
      applyScaleSettings(forceFit: false)
    }
    applyWorkspaceCanvasColors()
    applyPdfGestureTouchPolicy()
    bringSubviewToFront(annotationOverlay)
    if !inlineTextEditor.isHidden { bringSubviewToFront(inlineTextEditor) }
    annotationOverlay.setNeedsDisplay()
    completeInlineTextHandoffIfReady()
    applyInitialViewportIfPossible()
    #if DEBUG
    traceViewportMutation("layoutSubviews-after", reason: "native layout")
    #endif
  }

  private static func double(_ value: Any?) -> Double? {
    if let number = value as? NSNumber { return number.doubleValue }
    if let number = value as? Double { return number }
    if let number = value as? Int { return Double(number) }
    return nil
  }

  /// Apply the scale window for the current bounds.
  ///
  ///   - `forceFit == true` (initial document load): set scaleFactor = page-fit.
  ///   - `forceFit == false` (on size change): leave the user's manual scale
  ///     alone unless it's now outside the new [min, max] window, in which
  ///     case clamp it. PDFView's own pinch state is preserved otherwise.
  private func applyScaleSettings(forceFit: Bool) {
    #if DEBUG
    traceViewportMutation("scale-settings-before", reason: "forceFit=\(forceFit)")
    #endif
    traceRestore("scale-settings forceFit=\(forceFit)")
    guard document != nil else { return }
    guard pdfView.bounds.width > 0, pdfView.bounds.height > 0 else { return }
    let fit = pdfView.scaleFactorForSizeToFit
    guard fit > 0 else { return }
    // Allow zooming OUT below page-fit (Notability-style "page floats in canvas").
    // 0.4 × fit lets the page shrink to ~40% of the view while still being
    // tappable — going much lower makes the page hard to interact with.
    pdfView.minScaleFactor = fit * Self.minScaleFraction
    pdfView.maxScaleFactor = max(fit * 5.0, 5.0)
    if forceFit {
      pdfView.scaleFactor = fit
    } else if pdfView.scaleFactor < pdfView.minScaleFactor {
      pdfView.scaleFactor = pdfView.minScaleFactor
    } else if pdfView.scaleFactor > pdfView.maxScaleFactor {
      pdfView.scaleFactor = pdfView.maxScaleFactor
    }
    #if DEBUG
    traceViewportMutation("scale-settings-after", reason: "forceFit=\(forceFit)")
    #endif
    #if DEBUG
    print("[PdfAnnotationView] applyScaleSettings forceFit=\(forceFit) fit=\(fit) min=\(pdfView.minScaleFactor) max=\(pdfView.maxScaleFactor) current=\(pdfView.scaleFactor)")
    #endif
  }

  // MARK: - Visual constants

  /// Fraction of page-fit that the user is allowed to shrink the PDF down to.
  /// Tunable single value — Notability lives around 0.35–0.5 in practice; 0.4
  /// keeps the page comfortably interactive while still giving "floating on
  /// canvas" feel.
  private static let minScaleFraction: CGFloat = 0.4

  /// Light Youmi workspace canvas (#F6F9FC) behind/around the PDF page.
  /// Matches the JS-side root background so the RN screen and the PDFKit
  /// surround blend seamlessly — no visible rectangle between them.
  /// PDFKit's subtle page-edge shadow gives just enough definition when
  /// the user zooms out below page-fit and the page floats inside this
  /// canvas. White paper, soft ice-blue desk — Youmi study-tool feel
  /// rather than Notability dark-reader feel.
  private static let workspaceCanvasColor: UIColor = UIColor(
    red: 246.0 / 255.0,
    green: 249.0 / 255.0,
    blue: 252.0 / 255.0,
    alpha: 1.0
  )

  func setPage(_ pageNumber: Int) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.goToPage(pageNumber, reason: "setPage(JS-imperative)")
    }
  }

  /// See AnnotationOverlay.markStrokeRemovalIntent's doc comment — the
  /// JS-initiated side-channel that closes the Undo/Redo race with
  /// `pendingLocalStrokeIds`. Must run before the caller's next
  /// `annotationsByPage` prop update reaches this view; JS calls this
  /// synchronously ahead of that state change, and both a view command and
  /// a prop update are delivered to the same queue in the order issued, so
  /// no explicit synchronization beyond that ordering is needed.
  func markStrokeRemovalIntent(ids: [String]) {
    DispatchQueue.main.async { [weak self] in
      self?.annotationOverlay.markStrokeRemovalIntent(ids: ids)
    }
  }

  /// Counterpart to `markStrokeRemovalIntent`: an Undo of a native erase
  /// intentionally restores these ids, so it must clear the erase tombstone
  /// before React sends the restored page snapshot back to this view.
  func markStrokeRestorationIntent(ids: [String]) {
    DispatchQueue.main.async { [weak self] in
      self?.annotationOverlay.markStrokeRestorationIntent(ids: ids)
    }
  }

  // MARK: - Document loading

  private func loadDocumentIfNeeded() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      guard let fileUri = self.fileUri, !fileUri.isEmpty else { return }
      guard fileUri != self.loadedFileUri else { return }

      guard let url = self.url(from: fileUri) else {
        self.emitError("The PDF file path is invalid."); return
      }
      guard FileManager.default.fileExists(atPath: url.path) else {
        self.emitError("The PDF file could not be found on this device."); return
      }
      guard let pdfDocument = PDFDocument(url: url) else {
        self.emitError("The PDF could not be opened."); return
      }

      self.sourceDocument = pdfDocument
      self.sourcePageCount = pdfDocument.pageCount
      self.loadedFileUri = fileUri
      self.hasAppliedInitialPage = false
      self.lastEmittedPage = nil
      // A genuinely new document means starting the restore-trust state
      // fresh — whatever verification/interaction happened for a
      // previously-loaded document (if this view instance is reused) has no
      // bearing on this one.
      self.restoreVerified = false
      self.userHasInteracted = false
      self.rebuildCompositeDocument(preservingCurrentPage: false)
      // Apply the initial page-fit scale + min/max window. autoScales stays
      // off so subsequent layout passes don't fight user pinch.
      self.lastBoundsSize = self.bounds.size
      self.applyScaleSettings(forceFit: true)
      self.applyInitialPageIfPossible()
      self.startObservingScroll()
      self.applyWorkspaceCanvasColors()
      // PDFView's internal scrollView only exists after the document loads,
      // so apply the gesture mode here (which writes to its panGestureRecognizer).
      self.updateGestureMode()
      self.applyPdfGestureTouchPolicy()
      self.annotationOverlay.setNeedsDisplay()
      self.onLoadComplete(["totalPages": self.document?.pageCount ?? pdfDocument.pageCount, "sourcePageCount": self.sourcePageCount])
      self.emitCurrentPage()
      self.applyInitialViewportIfPossible()
    }
  }

  /// The source `PDFDocument` lives only in memory; appending/removing the
  /// generated pages never writes to its URL. We rebuild from a fresh source
  /// load so a prop update cannot accidentally accumulate blank pages.
  private func rebuildCompositeDocument(preservingCurrentPage: Bool) {
    #if DEBUG
    traceViewportMutation("document-rebuild-before", reason: "preserving=\(preservingCurrentPage)")
    #endif
    traceRestore("rebuild preserving=\(preservingCurrentPage) appended=\(appendedBlankPageCount)")
    guard let fileUri = loadedFileUri, let url = url(from: fileUri),
          let freshSource = PDFDocument(url: url) else { return }

    // Capture enough state to restore the EXACT visual position across the
    // rebuild, not just the page number. Appending trailing blank pages
    // never changes the geometry of any earlier page (the source PDF is
    // reloaded byte-identical every time), so a PDF-space anchor point —
    // whatever is currently sitting at the viewport's top-left corner —
    // still means the same thing after the composite document is rebuilt.
    // The previous code only called goToPage(), which restores the page
    // number but resets scroll-within-page to the top, producing the
    // reported "viewport jumps while writing near the bottom" defect.
    let oldPage: Int
    var restoreScale: CGFloat?
    var restoreAnchor: (pageIndex: Int, point: CGPoint)?
    if preservingCurrentPage, let currentDocument = document, let currentPage = pdfView.currentPage {
      oldPage = max(1, currentDocument.index(for: currentPage) + 1)
      restoreScale = pdfView.scaleFactor
      if let anchorPage = pdfView.page(for: .zero, nearest: true) {
        restoreAnchor = (currentDocument.index(for: anchorPage), pdfView.convert(.zero, to: anchorPage))
      }
    } else {
      oldPage = initialPage
    }

    sourceDocument = freshSource
    sourcePageCount = freshSource.pageCount
    let blankBounds = freshSource.page(at: max(0, sourcePageCount - 1))?.bounds(for: .mediaBox)
      ?? CGRect(x: 0, y: 0, width: 612, height: 792)
    for _ in 0..<max(0, appendedBlankPageCount) {
      let blank = PDFPage()
      // A bare, programmatically-constructed PDFPage has no page-tree to
      // inherit box geometry from — only setting .mediaBox left every OTHER
      // box type (.cropBox, .bleedBox, .trimBox, .artBox) at PDFKit's own
      // degenerate default. PDFView.displayBox is never overridden anywhere
      // in this file, so it stays at PDFKit's default, .cropBox — which is
      // what continuous-mode layout/rendering actually measures each page
      // by. The blank page therefore laid out as a near-zero-height sliver
      // ("too short to write on") despite .mediaBox being fully correct and
      // unused for layout. Setting every box to the same full-page bounds
      // closes this regardless of which one PDFKit consults.
      blank.setBounds(blankBounds, for: .mediaBox)
      blank.setBounds(blankBounds, for: .cropBox)
      blank.setBounds(blankBounds, for: .bleedBox)
      blank.setBounds(blankBounds, for: .trimBox)
      blank.setBounds(blankBounds, for: .artBox)
      freshSource.insert(blank, at: freshSource.pageCount)
    }
    document = freshSource
    pdfView.document = freshSource
    #if DEBUG
    traceViewportMutation("document-reassignment", reason: "composite document assigned")
    #endif
    annotationOverlay.setNeedsDisplay()

    guard preservingCurrentPage else { return }
    if let restoreScale { pdfView.scaleFactor = restoreScale }
    if let restoreAnchor, restoreAnchor.pageIndex < freshSource.pageCount,
       let page = freshSource.page(at: restoreAnchor.pageIndex) {
      pdfView.go(to: PDFDestination(page: page, at: restoreAnchor.point))
      #if DEBUG
      traceViewportMutation("goTo", reason: "rebuildCompositeDocument anchor restore")
      #endif
      emitCurrentPage()
    } else {
      // Defensive fallback only — e.g. the anchor page no longer exists.
      goToPage(oldPage, reason: "rebuildCompositeDocument-anchorFallback")
    }
  }

  private func applyInitialPageIfPossible() {
    guard !hasAppliedInitialPage else {
      #if DEBUG
      print("[material-viewport] native applyInitialPageIfPossible SKIP (hasAppliedInitialPage already true)")
      #endif
      return
    }
    guard document != nil else {
      #if DEBUG
      print("[material-viewport] native applyInitialPageIfPossible SKIP (document nil) initialPage=\(initialPage)")
      #endif
      return
    }
    hasAppliedInitialPage = true
    #if DEBUG
    print("[material-viewport] native applyInitialPageIfPossible APPLYING page=\(initialPage)")
    #endif
    goToPage(initialPage, reason: "applyInitialPageIfPossible")
  }

  /// Restore only after the composed PDF and its first layout are both real.
  /// A next-main-turn layout pass is PDFKit's own destination/layout boundary,
  /// not a time delay; until it completes every default event remains silent.
  ///
  /// Reentrancy-guarded (`isRestoringViewport`): layoutSubviews() calls this
  /// function on every layout pass, and the restore steps below (go(to:), a
  /// large scaleFactor change, go(to:) again) each trigger further layout
  /// passes on pdfView before the async completion below runs — an
  /// unguarded reentrant call here raced the original one and could leave
  /// PDFKit settled on the wrong page (see the property's doc comment).
  ///
  /// Verified-before-complete: PDFKit can defer layout/re-tiling work after
  /// a large scaleFactor change past this function's synchronous return, so
  /// restorationComplete is only set once the ACTUAL settled page/scale/
  /// anchor is independently confirmed to match the target — not merely on
  /// the next run-loop turn. A mismatch retries the restore once more
  /// (bounded by maxViewportRestoreAttempts, never an unbounded loop);
  /// exhausting the bound still completes restoration with whatever PDFKit
  /// actually settled on, so the view can never get stuck suppressed.
  private func applyInitialViewportIfPossible() {
    // Layout readiness is the INNER pdfView's bounds, not this custom
    // container view's own bounds. The outer view can already have a valid
    // (non-zero) frame while pdfView — a subview laid out on a later pass —
    // is still 0×0; proven from a physical repro where restore attempts ran
    // with pdfView.bounds == .zero, wasting retry budget on state where
    // page(for:nearest:)/convert(_:to:) cannot report anything meaningful.
    // Returning here before touching isRestoringViewport/viewportRestoreAttempts
    // means a premature call costs nothing — layoutSubviews() re-invokes this
    // on every later layout pass, so the real attempt starts fresh once
    // pdfView actually has a size.
    guard !restorationComplete, !isRestoringViewport, let document,
          pdfView.bounds.width > 0, pdfView.bounds.height > 0 else {
      #if DEBUG
      print("[material-viewport] native applyInitialViewportIfPossible SKIP restorationComplete=\(restorationComplete) isRestoringViewport=\(isRestoringViewport) hasDocument=\(document != nil) pdfViewBounds=\(pdfView.bounds)")
      #endif
      return
    }
    let saved = pendingInitialViewport
    let pageIndex = min(document.pageCount, max(1, saved?.pageIndex ?? initialPage))
    guard let page = document.page(at: pageIndex - 1) else { return }
    #if DEBUG
    let savedPageDescription = saved.map { String($0.pageIndex) } ?? "none"
    let savedScaleDescription = saved.map { String(describing: $0.scale) } ?? "none"
    print("[material-viewport] native restore target=\(pageIndex) total=\(document.pageCount) savedPage=\(savedPageDescription) savedScale=\(savedScaleDescription) initialPageProp=\(initialPage) attempt=\(viewportRestoreAttempts)")
    #endif
    isRestoringViewport = true
    restorationComplete = false
    traceRestore("attempt-before-page")
    pdfView.go(to: page)
    #if DEBUG
    traceViewportMutation("goTo", reason: "viewport restore page")
    #endif
    traceRestore("attempt-after-page")
    if let saved {
      pdfView.scaleFactor = min(pdfView.maxScaleFactor, max(pdfView.minScaleFactor, saved.scale))
      #if DEBUG
      traceViewportMutation("scale-assignment", reason: "viewport restore")
      #endif
      traceRestore("attempt-after-scale")
      pdfView.go(to: PDFDestination(page: page, at: saved.anchor))
      #if DEBUG
      traceViewportMutation("goTo", reason: "viewport restore anchor")
      #endif
      traceRestore("attempt-after-anchor")
    }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.document === document else { return }
      let matches = self.currentViewportMatchesTarget(pageIndex: pageIndex, saved: saved)
      self.traceRestore("verify matches=\(matches)")
      #if DEBUG
      print("[material-viewport] native restore VERIFY matches=\(matches) attempt=\(self.viewportRestoreAttempts)")
      #endif
      if !matches, self.viewportRestoreAttempts < Self.maxViewportRestoreAttempts {
        self.viewportRestoreAttempts += 1
        self.isRestoringViewport = false
        self.applyInitialViewportIfPossible()
        return
      }
      self.isRestoringViewport = false
      self.viewportRestoreAttempts = 0
      self.restorationComplete = true
      // CRITICAL: restorationComplete only means "stopped attempting" — it
      // does NOT mean "trust what's on screen". That trust bit is
      // restoreVerified, and it is ONLY true on an actual match. Exhausting
      // the retry budget without a match must NOT unlock emission — that
      // was the exact bug: a failed verification still flipped
      // restorationComplete, which was the ONLY gate emitCurrentPage/
      // emitViewportSnapshot/captureViewportPayload checked, so a later
      // synthetic (layout-driven, not user-driven) page/scale change could
      // sail through and get persisted over the known-good saved viewport.
      self.restoreVerified = matches
      self.traceRestore("complete matches=\(matches)")
      #if DEBUG
      let confirmedPage = self.pdfView.page(for: .zero, nearest: true).map { self.document?.index(for: $0).description ?? "?" } ?? "none"
      print("[material-viewport] native restore CONFIRMED restorationComplete=true restoreVerified=\(matches) nearestPageIndex0based=\(confirmedPage)")
      #endif
      self.emitCurrentPage()
    }
  }

  /// Compares PDFKit's ACTUAL current page/scale to the restore target —
  /// the only reliable way to know the settled state matches what was
  /// requested, since a large scaleFactor change can defer PDFKit's own
  /// layout/re-tiling past this function's synchronous return.
  private func currentViewportMatchesTarget(
    pageIndex: Int,
    saved: (pageIndex: Int, scale: CGFloat, anchor: CGPoint)?
  ) -> Bool {
    guard let current = currentViewport(), current.pageIndex == pageIndex else { return false }
    guard let saved else { return true }
    let scaleTolerance = max(0.01, saved.scale * 0.05)
    guard abs(current.scale - saved.scale) <= scaleTolerance else { return false }
    // Y only, deliberately. displayDirection is .vertical with
    // .singlePageContinuous, and this document's pages are narrower than
    // pdfView's own bounds (proven from a physical repro: documentBounds
    // width 363pt vs pdfView.bounds width 1194pt) — PDFKit horizontally
    // CENTERS a page that doesn't fill the view, so `anchor.x` from
    // pdfView.convert(.zero, to: page) reports how far left of the page's
    // centered left edge the viewport's origin sits, a function of the
    // current zoom/centering math, not of anything the user scrolled to.
    // Comparing it as if it were a real horizontal scroll position produced
    // a spurious mismatch (target x=0.0 vs actual x=-111.14) even though
    // the page, scale, and vertical position were all already correct.
    return abs(current.anchor.y - saved.anchor.y) <= 20
  }

  private func currentViewport() -> (pageIndex: Int, scale: CGFloat, anchor: CGPoint)? {
    guard let document, document.pageCount > 0,
          let page = pdfView.page(for: .zero, nearest: true) else { return nil }
    let pageIndex = document.index(for: page) + 1
    guard pageIndex > 0 else { return nil }
    let anchor = pdfView.convert(CGPoint.zero, to: page)
    return (pageIndex, pdfView.scaleFactor, anchor)
  }

  private func emitViewportSnapshot() {
    // viewportTrustedForEmission (not restorationComplete alone) is the
    // gate: a failed restore that exhausted its retry budget still flips
    // restorationComplete (to stop attempting), but must not let a
    // subsequent synthetic layout-driven change masquerade as a real
    // navigation and overwrite the saved-good viewport. Only an actually
    // verified restore, or genuine user interaction, unlocks this.
    guard restorationComplete, viewportTrustedForEmission, let snapshot = currentViewport() else { return }
    onViewportChanged([
      "version": 1,
      "pageIndex": snapshot.pageIndex,
      "scaleFactor": snapshot.scale,
      "anchorX": snapshot.anchor.x,
      "anchorY": snapshot.anchor.y,
    ])
  }

  private func scheduleViewportSnapshot() {
    guard restorationComplete, viewportTrustedForEmission else { return }
    viewportEmitWorkItem?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.emitViewportSnapshot() }
    viewportEmitWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
  }

  func flushViewport() {
    viewportEmitWorkItem?.cancel()
    viewportEmitWorkItem = nil
    #if DEBUG
    if let snapshot = currentViewport() {
      print("[material-viewport] native flush page=\(snapshot.pageIndex) scale=\(snapshot.scale) anchor=(\(snapshot.anchor.x),\(snapshot.anchor.y)) restored=\(restorationComplete) trusted=\(viewportTrustedForEmission)")
    } else {
      print("[material-viewport] native flush viewport=unavailable restored=\(restorationComplete) trusted=\(viewportTrustedForEmission)")
    }
    #endif
    emitViewportSnapshot()
  }

  /// Direct diagnostic/read path used at navigation teardown. Unlike the
  /// normal EventDispatcher path this returns PDFKit's current state to the
  /// caller, so it can prove whether a delayed bridge snapshot is stale.
  ///
  /// Gated the same way as normal emission: an unverified, un-interacted-
  /// with restore has nothing trustworthy to report yet. Returning empty
  /// here (rather than the raw, possibly-mid-restore state) makes the JS
  /// caller fall back to its own last-known-good snapshot instead of
  /// persisting a synthetic in-flight value on leave.
  func captureViewportPayload() -> [String: Any] {
    #if DEBUG
    // One-shot leave-time forensic snapshot — checkpoints A-F for the
    // "rapid scroll then immediate leave" investigation. Bounded by the
    // same restoreTraceRemaining budget as traceRestore, so this cannot
    // spam on repeated leave attempts.
    if restoreTraceRemaining > 0 {
      restoreTraceRemaining -= 1
      let scroll = observedScrollView ?? findInnerScrollView(in: pdfView)
      func pageNumber(for pdfPage: PDFPage?) -> String {
        guard let pdfPage, let document else { return "nil" }
        return "\(document.index(for: pdfPage) + 1)"
      }
      let currentPageProp = pageNumber(for: pdfView.currentPage)
      let centerPoint = CGPoint(x: pdfView.bounds.midX, y: pdfView.bounds.midY)
      let centerPage = pageNumber(for: pdfView.page(for: centerPoint, nearest: true))
      let topLeftPage = pageNumber(for: pdfView.page(for: .zero, nearest: true))
      print("[material-leave-capture] A.pdfViewCurrentPage=\(currentPageProp) B.lastEmittedPage=\(String(describing: lastEmittedPage)) C.contentOffset=\(String(describing: scroll?.contentOffset)) D.topLeftResolvedPage=\(topLeftPage) E.centerResolvedPage=\(centerPage) restorationComplete=\(restorationComplete) restoreVerified=\(restoreVerified) userHasInteracted=\(userHasInteracted) isDecelerating=\(String(describing: scroll?.isDecelerating)) isDragging=\(String(describing: scroll?.isDragging)) isTracking=\(String(describing: scroll?.isTracking))")
    }
    #endif
    guard viewportTrustedForEmission, let snapshot = currentViewport() else {
      #if DEBUG
      print("[material-viewport] native capture SUPPRESSED (not yet trusted) restored=\(restorationComplete) verified=\(restoreVerified) userInteracted=\(userHasInteracted)")
      #endif
      return [:]
    }
    #if DEBUG
    print("[material-viewport] native capture F.anchor page=\(snapshot.pageIndex) scale=\(snapshot.scale) anchor=(\(snapshot.anchor.x),\(snapshot.anchor.y)) restored=\(restorationComplete)")
    #endif
    return [
      "version": 1,
      "pageIndex": snapshot.pageIndex,
      "scaleFactor": snapshot.scale,
      "anchorX": snapshot.anchor.x,
      "anchorY": snapshot.anchor.y,
    ]
  }

  private func goToPage(_ pageNumber: Int, reason: String) {
    guard let document else {
      #if DEBUG
      print("[material-viewport] native goToPage SKIP (document nil) requested=\(pageNumber) reason=\(reason)")
      #endif
      return
    }
    let clampedPage = max(1, min(pageNumber, document.pageCount))
    guard let page = document.page(at: clampedPage - 1) else { return }
    #if DEBUG
    print("[material-viewport] native goToPage requested=\(pageNumber) clamped=\(clampedPage) reason=\(reason)")
    #endif
    pdfView.go(to: page)
    #if DEBUG
    traceViewportMutation("goTo", reason: reason)
    #endif
    emitCurrentPage()
  }

  // MARK: - Gesture mode management

  private func updateGestureMode() {
    selectionGesture.isEnabled = annotationMode == "select"
    // Finger manipulation of an existing selection (and finger tap select/deselect) works while Select, Pen or
    // Highlighter is active. Both fail at touch-down unless a selection exists and the touch is inside it.
    let selectionTouchModes = annotationMode == "select" || annotationMode == "pen" || annotationMode == "highlighter"
    selectionFingerGesture.isEnabled = selectionTouchModes
    selectionTapGesture.isEnabled = selectionTouchModes
    let isInkTool = annotationMode == "pen" || annotationMode == "highlighter" || annotationMode == "eraser"
    let isAnnotationTool = isInkTool || annotationMode == "select"
    pencilGesture.isEnabled = isInkTool
    applyPdfGestureTouchPolicy()

    guard let scrollView = observedScrollView ?? findInnerScrollView(in: pdfView) else {
      // Document may not be loaded yet — we'll re-apply after load. Until
      // then the gesture recognizer's allowedTouchTypes is enough to prevent
      // finger touches from drawing; PDFView's pan is at its default.
      return
    }

    let finger = NSNumber(value: UITouch.TouchType.direct.rawValue)
    if defaultPanAllowedTouchTypes == nil {
      // Capture the default once (Apple sets this to "any" by default).
      defaultPanAllowedTouchTypes = scrollView.panGestureRecognizer.allowedTouchTypes as? [NSNumber]
    }

    if isAnnotationTool {
      // Restrict PDFView's pan to finger only so Pencil drag doesn't scroll.
      scrollView.panGestureRecognizer.allowedTouchTypes = [finger]
    } else {
      // Restore default so Pencil scroll works in scroll mode.
      scrollView.panGestureRecognizer.allowedTouchTypes =
        defaultPanAllowedTouchTypes ?? [finger,
                                        NSNumber(value: UITouch.TouchType.pencil.rawValue),
                                        NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
    }

    #if DEBUG
    print("[PdfAnnotationView] updateGestureMode mode=\(annotationMode) pencilGesture.isEnabled=\(pencilGesture.isEnabled) panAllowedTouchTypes=\(String(describing: scrollView.panGestureRecognizer.allowedTouchTypes))")
    #endif
  }

  /// Pencil-down inside the current selection drags it; anywhere else it
  /// starts a new selection region. Both are Pencil-only, so a finger always
  /// remains PDF navigation.
  private var isMovingSelection = false
  private var isDraggingShapeHandle = false
  private let inkRecorder = InkPerfRecorder()

  @objc private func handleSelectionGesture(_ recognizer: PageSelectionGestureRecognizer) {
    guard annotationMode == "select" else { return }
    switch recognizer.state {
    case .began:
      setNonPencilGesturesEnabled(false)
      let start = recognizer.location(in: pdfView)
      if annotationOverlay.beginHandleDragIfHit(at: start) {
        isDraggingShapeHandle = true
        isMovingSelection = false
      } else if annotationOverlay.beginMoveIfHit(at: start) {
        isMovingSelection = true
      } else {
        isMovingSelection = false
        annotationOverlay.beginSelection(at: start, shape: selectionShape)
      }
    case .changed:
      if isDraggingShapeHandle {
        if let point = recognizer.confirmedPoints.last { annotationOverlay.updateHandleDrag(at: point) }
      } else if isMovingSelection {
        if let point = recognizer.confirmedPoints.last { annotationOverlay.updateMove(at: point) }
      } else {
        for point in recognizer.confirmedPoints { annotationOverlay.appendSelection(at: point) }
      }
    case .ended:
      if isDraggingShapeHandle {
        let end = recognizer.confirmedPoints.last ?? recognizer.location(in: pdfView)
        if let edit = annotationOverlay.finishHandleDrag(at: end) {
          onShapeEdited(["pageNumber": edit.pageNumber, "strokeId": edit.strokeId, "handleIndex": edit.handleIndex,
                         "x": Double(edit.x), "y": Double(edit.y)])
        }
      } else if isMovingSelection {
        if let point = recognizer.confirmedPoints.last { annotationOverlay.updateMove(at: point) }
        if let moved = annotationOverlay.finishMove() {
          onSelectionMoved(moved.payload)
        }
      } else {
        for point in recognizer.confirmedPoints { annotationOverlay.appendSelection(at: point) }
        if let result = annotationOverlay.finishSelection() {
          onSelectionChanged(["pageNumber": result.pageNumber, "strokeIds": result.strokeIds])
        } else {
          // The state machine already cleared it for an explicit reason (blank tap / empty region).
          onSelectionChanged(["pageNumber": 0, "strokeIds": []])
        }
      }
      isMovingSelection = false
      isDraggingShapeHandle = false
      setNonPencilGesturesEnabled(true)
    case .cancelled, .failed:
      // A cancelled/failed gesture is NOT a deselection: it only abandons what it was doing.
      if isDraggingShapeHandle { annotationOverlay.cancelHandleDrag() }
      else if isMovingSelection { annotationOverlay.cancelMove() } else { annotationOverlay.cancelRegion() }
      isMovingSelection = false
      isDraggingShapeHandle = false
      setNonPencilGesturesEnabled(true)
    default: break
    }
  }

  // MARK: - Pencil gesture callback

  private var fingerSelectionMode = AnnotationOverlay.FingerManipulation.none

  /// One finger inside the selection moves it; two fingers inside scale it. The page is left alone:
  /// a finger that began elsewhere never reaches this handler (the recogniser fails at touch-down).
  @objc private func handleSelectionFingerGesture(_ recognizer: SelectionFingerGestureRecognizer) {
    guard annotationMode == "select" || annotationMode == "pen" || annotationMode == "highlighter" else { return }
    let points = recognizer.points
    switch recognizer.state {
    case .began:
      setNonPencilGesturesEnabled(false)   // PDFView pan/pinch stand down for this touch sequence only
      // Same arbitration as Notebook (lib/selectionTransform.routeSelectionTouch): a handle beats the body.
      fingerSelectionMode = annotationOverlay.beginFingerManipulation(at: points)
    case .changed:
      if fingerSelectionMode == .move, points.count >= 2, annotationOverlay.beginScale(at: points[0], and: points[1]) {
        fingerSelectionMode = .scale   // the second finger joined: the move upgrades to a scale
      }
      switch fingerSelectionMode {
      case .handle: if let first = points.first { annotationOverlay.updateHandleDrag(at: first) }
      case .move: if let first = points.first { annotationOverlay.updateMove(at: first) }
      case .scale: if points.count >= 2 { annotationOverlay.updateScale(at: points[0], and: points[1]) }
      case .none: break
      }
    case .ended:
      switch fingerSelectionMode {
      case .handle:
        if let end = points.first, let edit = annotationOverlay.finishHandleDrag(at: end) {
          onShapeEdited(["pageNumber": edit.pageNumber, "strokeId": edit.strokeId, "handleIndex": edit.handleIndex,
                         "x": Double(edit.x), "y": Double(edit.y)])
        } else {
          annotationOverlay.cancelHandleDrag()
        }
      case .move:
        if let first = points.first { annotationOverlay.updateMove(at: first) }
        if let moved = annotationOverlay.finishMove() {
          onSelectionMoved(moved.payload)
        }
      case .scale:
        if points.count >= 2, let scaled = annotationOverlay.finishScale(at: points[0], and: points[1]) {
          onSelectionScaled(["pageNumber": scaled.pageNumber, "strokeIds": scaled.strokeIds, "factor": Double(scaled.factor),
                             "centerX": Double(scaled.centerX), "centerY": Double(scaled.centerY)])
        } else {
          annotationOverlay.cancelScale()
        }
      case .none: break
      }
      fingerSelectionMode = .none
      setNonPencilGesturesEnabled(true)
    case .cancelled, .failed:
      // Abandons the manipulation only; the selection itself is untouched.
      switch fingerSelectionMode {
      case .handle: annotationOverlay.cancelHandleDrag()
      case .move: annotationOverlay.cancelMove()
      case .scale: annotationOverlay.cancelScale()
      case .none: break
      }
      if fingerSelectionMode != .none || recognizer.state == .cancelled { setNonPencilGesturesEnabled(true) }
      fingerSelectionMode = .none
    default: break
    }
  }

  @objc private func handleSelectionTap(_ recognizer: UITapGestureRecognizer) {
    guard annotationMode == "select" || annotationMode == "pen" || annotationMode == "highlighter", recognizer.state == .ended else { return }
    let point = recognizer.location(in: pdfView)
    if annotationOverlay.fingerHitsSelection(at: point) { return }   // inside the selection: never a deselect
    if let hit = annotationOverlay.fingerTap(at: point) {
      onSelectionChanged(["pageNumber": hit.pageNumber, "strokeIds": hit.strokeIds])
    } else {
      onSelectionChanged(["pageNumber": 0, "strokeIds": []])
    }
  }

  @objc private func handlePencilGesture(_ recognizer: PencilDrawGestureRecognizer) {
    switch recognizer.state {
    case .began:
      // A structured shape is directly interactive whichever drawing tool is active: the Pencil on a HANDLE of the
      // selected shape reshapes it (no ink). Any other Pencil-down releases a selection (blank touch) and writes.
      if annotationMode == "pen" || annotationMode == "highlighter" {
        let downPoint = recognizer.location(in: pdfView)
        if annotationOverlay.beginHandleDragIfHit(at: downPoint) {
          isDraggingShapeHandle = true
          setNonPencilGesturesEnabled(false)
          return
        }
        if annotationOverlay.penDownDeselectIfElsewhere(at: downPoint) {
          onSelectionChanged(["pageNumber": 0, "strokeIds": []])
        }
      }
      // Exclusive interaction priority while a Pencil stroke is physically
      // in progress: a resting palm or stray finger is `.direct`-type touch,
      // which the mode-level allowedTouchTypes restriction above already
      // permits for panning between strokes — so without this, palm contact
      // during an active stroke can still drive PDFView's own pan/pinch and
      // move the viewport out from under the hand that's writing. Disabling
      // every other recognizer for the duration of just this one stroke
      // (restored in .ended/.cancelled/.failed below) blocks that without
      // touching intentional finger scroll/pinch between strokes.
      #if DEBUG
      pencilStrokeActive = true
      strokeJustEnded = false
      strokeFirstSampleSeen = false
      armViewportTrace("Pencil began")
      traceViewportMutation("pencil-begin", reason: "before non-Pencil disable", force: true)
      #endif
      onPencilActivity(["active": true])
      let toggleStart = ProcessInfo.processInfo.systemUptime
      setNonPencilGesturesEnabled(false)
      inkRecorder.beginStroke(toggleMs: (ProcessInfo.processInfo.systemUptime - toggleStart) * 1000, overlay: annotationOverlay, mode: annotationMode)
      #if DEBUG
      traceViewportMutation("non-pencil-gestures", reason: "disabled for Pencil", force: true)
      #endif
      let p = recognizer.location(in: pdfView)
      let overlayPoint = recognizer.location(in: annotationOverlay)
      #if DEBUG
      print("[PdfAnnotationView] pencil .began at pdfViewPoint=\(p)")
      #endif
      if annotationMode == "eraser" {
        // The erase hit-test uses PDFView coordinates, while the preview is
        // drawn directly by the overlay in its own coordinate space.
        annotationOverlay.showEraserPreview(at: overlayPoint)
        annotationOverlay.beginErase(at: p)
      } else if annotationMode == "highlighter" {
        annotationOverlay.beginStroke(
          at: p,
          tool: "highlighter",
          color: highlighterColor,
          width: highlighterWidth
        )
      } else {
        annotationOverlay.beginStroke(at: p, tool: "pen", color: penColor, width: penWidth)
      }

    case .changed:
      if isDraggingShapeHandle {
        if let point = recognizer.confirmedPoints.last { annotationOverlay.updateHandleDrag(at: point) }
        return
      }
      let p = recognizer.location(in: pdfView)
      let overlayPoint = recognizer.location(in: annotationOverlay)
      if annotationMode == "eraser" {
        annotationOverlay.showEraserPreview(at: overlayPoint)
        annotationOverlay.continueErase(at: p)
      } else {
        #if DEBUG
        if !strokeFirstSampleSeen {
          strokeFirstSampleSeen = true
          traceViewportMutation("pencil-first-sample", reason: "confirmed samples=\(recognizer.confirmedPoints.count)")
        }
        #endif
        annotationOverlay.appendPoints(at: recognizer.confirmedPoints)
        inkRecorder.noteEvent(coalesced: recognizer.confirmedPoints.count)
      }

    case .ended:
      if isDraggingShapeHandle {
        let end = recognizer.confirmedPoints.last ?? recognizer.location(in: pdfView)
        if let edit = annotationOverlay.finishHandleDrag(at: end) {
          onShapeEdited(["pageNumber": edit.pageNumber, "strokeId": edit.strokeId, "handleIndex": edit.handleIndex,
                         "x": Double(edit.x), "y": Double(edit.y)])
        }
        isDraggingShapeHandle = false
        setNonPencilGesturesEnabled(true)
        return
      }
      setNonPencilGesturesEnabled(true)
      defer { onPencilActivity(["active": false]) }
      #if DEBUG
      pencilStrokeActive = false
      strokeJustEnded = true
      traceViewportMutation("pencil-end", reason: "after non-Pencil enable", force: true)
      traceViewportMutation("non-pencil-gestures", reason: "enabled after Pencil", force: true)
      armPostStrokeWatch(reason: "pencil gesture \(recognizer.state.rawValue)")
      #endif
      if annotationMode == "eraser" {
        for replacement in annotationOverlay.endErase() {
          emitPageReplacement(replacement.strokes, pageNumber: replacement.pageNumber)
        }
        annotationOverlay.cancelStroke()
        annotationOverlay.hideEraserPreview()
        emitEraserGestureEnded(at: recognizer.location(in: pdfView))
      } else {
        annotationOverlay.appendPoints(at: recognizer.confirmedPoints)
        // TAP vs DRAW, decided once at Pencil-up: a quick tap on an existing structured shape selects it and
        // suppresses the dot; a drag/slow press/snap/blank tap keeps ordinary Pen behavior (dots included).
        if let tapped = annotationOverlay.penTapShapeTarget() {
          annotationOverlay.cancelStroke()
          annotationOverlay.selectShapeFromPenTap(tapped.stroke, pageNumber: tapped.pageNumber)
          onSelectionChanged(["pageNumber": tapped.pageNumber, "strokeIds": [tapped.stroke.id]])
          inkRecorder.cancel()
          return
        }
        let commitStart = ProcessInfo.processInfo.systemUptime
        let committedStroke = annotationOverlay.endStroke()
        if let commit = committedStroke {
        #if DEBUG
        traceViewportMutation("annotation-committed", reason: "page=\(commit.pageNumber) points=\(commit.stroke.points.count)", force: true)
        print("[PdfAnnotationView] pencil .ended commit page=\(commit.pageNumber) points=\(commit.stroke.points.count)")
        #endif
        emitStrokeCommitted(commit.stroke, pageNumber: commit.pageNumber)
        if annotationOverlay.clearSelectionAfterInk() { onSelectionChanged(["pageNumber": 0, "strokeIds": []]) }
        inkRecorder.endStroke(commitMs: (ProcessInfo.processInfo.systemUptime - commitStart) * 1000, overlay: annotationOverlay)
        } else {
        inkRecorder.cancel()
        #if DEBUG
        print("[PdfAnnotationView] pencil .ended NO commit (empty stroke)")
        #endif
        }
      }

    case .cancelled, .failed:
      if isDraggingShapeHandle {
        annotationOverlay.cancelHandleDrag()
        isDraggingShapeHandle = false
        setNonPencilGesturesEnabled(true)
        return
      }
      setNonPencilGesturesEnabled(true)
      onPencilActivity(["active": false])
      inkRecorder.cancel()
      #if DEBUG
      pencilStrokeActive = false
      strokeJustEnded = true
      traceViewportMutation("pencil-terminal", reason: "state=\(recognizer.state.rawValue) after enable", force: true)
      traceViewportMutation("non-pencil-gestures", reason: "enabled after terminal Pencil", force: true)
      armPostStrokeWatch(reason: "pencil gesture \(recognizer.state.rawValue)")
      #endif
      if annotationMode == "eraser" {
        for replacement in annotationOverlay.endErase() {
          emitPageReplacement(replacement.strokes, pageNumber: replacement.pageNumber)
        }
        emitEraserGestureEnded(at: recognizer.location(in: pdfView))
      }
      annotationOverlay.cancelStroke()
      // Always clear the cursor on gesture end, regardless of mode at the
      // moment — defensive in case the mode flipped between .began and now.
      annotationOverlay.hideEraserPreview()

    default:
      break
    }
  }

  // MARK: - Notifications + KVO

  @objc private func handlePageChanged(_ notification: Notification) {
    #if DEBUG
    traceViewportMutation("PDFViewPageChanged", reason: "PDFKit notification")
    #endif
    traceRestore("PDFViewPageChanged")
    emitCurrentPage()
    annotationOverlay.setNeedsDisplay()
    scheduleViewportSnapshot()
  }

  @objc private func handleAnnotationLayoutChange() {
    #if DEBUG
    traceViewportMutation("annotation-layout-change", reason: "PDFKit scale/visible pages notification")
    #endif
    annotationOverlay.setNeedsDisplay()
    annotationOverlay.refreshSelectionChrome()
    if inlineTextEditingContext != nil || pendingInlineTextHandoff != nil { scheduleInlineTextEditorReposition() }
    completeInlineTextHandoffIfReady()
    scheduleViewportSnapshot()
  }

  private func startObservingScroll() {
    guard observedScrollView == nil else { return }
    if let scroll = findInnerScrollView(in: pdfView) {
      scroll.addObserver(self, forKeyPath: "bounds", options: [.new], context: nil)
      scroll.addObserver(self, forKeyPath: "contentOffset", options: [.new], context: nil)
      // Explicit user-navigation signal, independent of PDFViewPageChanged
      // (which PDFKit also fires during layout/restore, not only real
      // touches). Adding a target here observes the gesture without taking
      // over it — PDFKit's own handling on these recognizers is untouched.
      scroll.panGestureRecognizer.addTarget(self, action: #selector(handleUserScrollGesture(_:)))
      scroll.pinchGestureRecognizer?.addTarget(self, action: #selector(handleUserScrollGesture(_:)))
      observedScrollView = scroll
      applyWorkspaceCanvasColors()
    }
  }

  private func stopObservingScroll() {
    if let scroll = observedScrollView {
      scroll.removeObserver(self, forKeyPath: "bounds")
      scroll.removeObserver(self, forKeyPath: "contentOffset")
      scroll.panGestureRecognizer.removeTarget(self, action: #selector(handleUserScrollGesture(_:)))
      scroll.pinchGestureRecognizer?.removeTarget(self, action: #selector(handleUserScrollGesture(_:)))
    }
    observedScrollView = nil
  }

  /// Fires on the user's own pan/pinch gesture beginning on the PDF's
  /// internal scroll view. This is the ONLY thing that lifts a
  /// failed-verification restore's protection on the saved viewport — see
  /// viewportTrustedForEmission's doc comment for why PDFViewPageChanged
  /// itself is not a safe substitute for this.
  @objc private func handleUserScrollGesture(_ recognizer: UIGestureRecognizer) {
    guard recognizer.state == .began, !userHasInteracted else { return }
    userHasInteracted = true
    #if DEBUG
    print("[material-viewport] native userHasInteracted=true (gesture began) — restore protection lifted if it had failed")
    #endif
  }

  private func findInnerScrollView(in view: UIView) -> UIScrollView? {
    if let scroll = view as? UIScrollView { return scroll }
    for sub in view.subviews {
      if let found = findInnerScrollView(in: sub) { return found }
    }
    return nil
  }

  private func allGestureRecognizers(in view: UIView) -> [UIGestureRecognizer] {
    var recognizers = view.gestureRecognizers ?? []
    for subview in view.subviews {
      recognizers.append(contentsOf: allGestureRecognizers(in: subview))
    }
    return recognizers
  }

  /// Toggles every gesture recognizer in the PDFView hierarchy EXCEPT the
  /// Pencil recognizer itself. Used to give an active Pencil stroke
  /// exclusive interaction priority — see the .began/.ended/.cancelled
  /// call sites in handlePencilGesture. Disabling cancels anything already
  /// tracking; re-enabling only affects the NEXT touch, so this never
  /// resurrects a gesture that was cancelled mid-recognition.
  private func setNonPencilGesturesEnabled(_ enabled: Bool) {
    #if DEBUG
    traceViewportMutation("setNonPencilGesturesEnabled-before", reason: "enabled=\(enabled)")
    #endif
    for recognizer in allGestureRecognizers(in: pdfView) where recognizer !== pencilGesture && recognizer !== selectionGesture && recognizer !== selectionFingerGesture && recognizer !== selectionTapGesture {
      recognizer.isEnabled = enabled
    }
    #if DEBUG
    traceViewportMutation("setNonPencilGesturesEnabled-after", reason: "enabled=\(enabled)")
    #endif
  }

  private func applyPdfGestureTouchPolicy() {
    let isAnnotationTool = annotationMode == "pen" || annotationMode == "highlighter" || annotationMode == "eraser" || annotationMode == "select"
    let fingerTouchTypes = [
      NSNumber(value: UITouch.TouchType.direct.rawValue),
      NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)
    ]

    for recognizer in allGestureRecognizers(in: pdfView) {
      if recognizer === pencilGesture || recognizer === selectionGesture || recognizer === selectionFingerGesture || recognizer === selectionTapGesture { continue }
      let key = ObjectIdentifier(recognizer)
      if defaultAllowedTouchTypesByRecognizer[key] == nil {
        defaultAllowedTouchTypesByRecognizer[key] = recognizer.allowedTouchTypes as? [NSNumber] ?? []
      }

      if isAnnotationTool {
        recognizer.allowedTouchTypes = fingerTouchTypes
      } else {
        recognizer.allowedTouchTypes = defaultAllowedTouchTypesByRecognizer[key] ?? []
      }
    }
  }

  /// PDFKit owns several private inner views. Setting only `PDFView.backgroundColor`
  /// is not enough: the visible gap around pages can come from the internal
  /// `UIScrollView` / document container instead, which is why the workspace
  /// still appeared dark after the outer view was already light. Keep every
  /// safe canvas layer on Youmi's pale blue-white. The PDF page drawing itself
  /// remains PDFKit-owned, so white PDF paper stays white.
  private func applyWorkspaceCanvasColors() {
    backgroundColor = Self.workspaceCanvasColor
    pdfView.backgroundColor = Self.workspaceCanvasColor

    if let scrollView = observedScrollView ?? findInnerScrollView(in: pdfView) {
      scrollView.backgroundColor = Self.workspaceCanvasColor
      scrollView.indicatorStyle = .black
    }

    if let documentView = pdfView.documentView {
      documentView.backgroundColor = Self.workspaceCanvasColor
    }

    applyWorkspaceCanvasColorRecursively(in: pdfView)
  }

  private func applyWorkspaceCanvasColorRecursively(in view: UIView) {
    for subview in view.subviews {
      if subview === annotationOverlay { continue }
      if subview is UIScrollView || subview === pdfView.documentView {
        subview.backgroundColor = Self.workspaceCanvasColor
      }
      applyWorkspaceCanvasColorRecursively(in: subview)
    }
  }

  public override func observeValue(
    forKeyPath keyPath: String?,
    of object: Any?,
    change: [NSKeyValueChangeKey: Any]?,
    context: UnsafeMutableRawPointer?
  ) {
    annotationOverlay.setNeedsDisplay()
    if keyPath == "contentOffset" || keyPath == "bounds" {
      scheduleViewportSnapshot()
      if inlineTextEditingContext != nil || pendingInlineTextHandoff != nil { scheduleInlineTextEditorReposition() }
      completeInlineTextHandoffIfReady()
    }
    #if DEBUG
    if keyPath == "contentOffset" {
      traceViewportMutation("contentOffset", reason: "KVO")
    } else if keyPath == "bounds" {
      traceViewportMutation("scroll-bounds", reason: "KVO")
    }
    if keyPath == "contentOffset", let until = postStrokeWatchUntil, let baseline = postStrokeWatchBaseline {
      if Date() > until {
        postStrokeWatchUntil = nil
        postStrokeWatchBaseline = nil
      } else if let current = observedScrollView?.contentOffset, hypot(current.x - baseline.x, current.y - baseline.y) > 0.5 {
        print("[PdfAnnotationView] scroll-after-unlock baseline=\(baseline) current=\(current) deltaX=\(current.x - baseline.x) deltaY=\(current.y - baseline.y)")
        postStrokeWatchUntil = nil
        postStrokeWatchBaseline = nil
      }
    }
    #endif
  }

  // MARK: - Event helpers

  private func emitCurrentPage() {
    guard restorationComplete else {
      #if DEBUG
      print("[material-viewport] native emitCurrentPage SUPPRESSED (restorationComplete=false)")
      #endif
      return
    }
    guard let document, let currentPage = pdfView.currentPage else { return }
    let pageNumber = document.index(for: currentPage) + 1
    guard pageNumber > 0 else { return }
    if lastEmittedPage == pageNumber { return }
    lastEmittedPage = pageNumber
    #if DEBUG
    print("[material-viewport] native emitCurrentPage SENT pageNumber=\(pageNumber) totalPages=\(document.pageCount)")
    #endif
    onPageChanged([
      "pageNumber": pageNumber,
      "totalPages": document.pageCount
    ])
  }

  private func emitError(_ message: String) {
    onError(["message": message])
  }

  private func emitStrokeCommitted(_ stroke: AnnotationStroke, pageNumber: Int) {
    onAnnotationsChanged([
      "pageNumber": pageNumber,
      "stroke": serializeStroke(stroke)
    ])
  }

  private func emitPageReplacement(_ strokes: [AnnotationStroke], pageNumber: Int) {
    onAnnotationsChanged([
      "pageNumber": pageNumber,
      "action": "replacePage",
      "strokes": strokes.map { serializeStroke($0) }
    ])
  }

  private func emitEraserGestureEnded(at viewPoint: CGPoint) {
    var payload: [String: Any] = [:]
    if let document,
       let page = pdfView.page(for: viewPoint, nearest: true) {
      let pageNumber = document.index(for: page) + 1
      if pageNumber > 0 {
        payload["pageNumber"] = pageNumber
      }
    }
    onEraserGestureEnded(payload)
  }

  // MARK: - Finger text annotations

  @objc private func handleFingerLongPress(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .began, annotationMode == "scroll" else { return }
    let point = recognizer.location(in: pdfView)
    guard let document, let page = pdfView.page(for: point, nearest: false) else { return }
    let pageNumber = document.index(for: page) + 1
    let pagePoint = pdfView.convert(point, to: page)
    if let existing = annotationOverlay.textAnnotation(at: point) {
      presentTextActions(existing, from: recognizer.view ?? pdfView)
      return
    }
    let clipboard = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !clipboard.isEmpty else { return }
    let menu = UIAlertController(title: "Course Material", message: nil, preferredStyle: .actionSheet)
    menu.addAction(UIAlertAction(title: "Paste", style: .default) { [weak self] _ in
      self?.commitInlineTextEditorIfNeeded()
      self?.beginInlineTextCreation(at: pagePoint, pageNumber: pageNumber, page: page, initialText: clipboard)
    })
    menu.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    present(menu, from: recognizer.view ?? pdfView)
  }

  /// Text mode persists between pages. Commit reuses the original page anchor.
  @objc private func handleTextTap(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended, annotationMode == "text" else { return }
    let point = recognizer.location(in: pdfView)
    guard let document, let page = pdfView.page(for: point, nearest: false) else { return }
    let pageNumber = document.index(for: page) + 1
    let pagePoint = pdfView.convert(point, to: page)
    commitInlineTextEditorIfNeeded()
    if let existing = annotationOverlay.textAnnotation(at: point) {
      beginInlineTextEditing(existing)
    } else {
      beginInlineTextCreation(at: pagePoint, pageNumber: pageNumber, page: page)
    }
  }

  // MARK: - Native inline text editing

  /// Begins a brand-new annotation at `pagePoint`. Nothing is committed to
  /// the store until the editor commits with non-empty text — an empty
  /// commit (tapped, typed nothing, tapped away) creates nothing.
  private func beginInlineTextCreation(at pagePoint: CGPoint, pageNumber: Int, page: PDFPage, initialText: String = "") {
    completeInlineTextHandoffIfReady()
    guard pendingInlineTextHandoff == nil else { return }
    let pageWidth = page.bounds(for: .mediaBox).width
    let availableWidth = max(80, pageWidth - pagePoint.x - 24)
    let fontSize = Double(MaterialTextGeometry.defaultFontSize)
    inlineTextEditingContext = (
      id: nil, pageNumber: pageNumber,
      originX: Double(pagePoint.x), originY: Double(pagePoint.y),
      fontSize: fontSize, width: Double(availableWidth), anchor: "top-left"
    )
    MaterialTextTrace.log("editor-create-begin") {
      "page=\(pageNumber) pdfX=\(pagePoint.x) pdfY=\(pagePoint.y) width=\(availableWidth) scale=\(pdfView.scaleFactor)"
    }
    inlineTextEditor.text = initialText
    showInlineTextEditorAndFocus()
  }

  /// Begins editing an EXISTING annotation in place, pre-filled with its
  /// current text. Suppresses it from drawing/hit-testing for the duration
  /// (see AnnotationOverlay.editingTextAnnotationId) so the live editor is
  /// the only visible/interactive copy until commit.
  private func beginInlineTextEditing(_ hit: TextAnnotationHit) {
    completeInlineTextHandoffIfReady()
    guard pendingInlineTextHandoff == nil else { return }
    inlineTextEditingContext = (id: hit.id, pageNumber: hit.pageNumber, originX: hit.x, originY: hit.y, fontSize: hit.fontSize, width: hit.width, anchor: hit.anchor)
    annotationOverlay.editingTextAnnotationId = hit.id
    inlineTextEditor.text = hit.text
    MaterialTextTrace.log("editor-edit-begin") {
      "id=\(hit.id) page=\(hit.pageNumber) pdfX=\(hit.x) pdfY=\(hit.y) width=\(hit.width) font=\(hit.fontSize) scale=\(pdfView.scaleFactor)"
    }
    showInlineTextEditorAndFocus()
  }

  private func showInlineTextEditorAndFocus() {
    repositionInlineTextEditor()
    inlineTextEditor.isHidden = false
    bringSubviewToFront(inlineTextEditor)
    inlineTextEditor.becomeFirstResponder()
  }

  /// Keeps one transient editing surface anchored to one persisted PDF-page
  /// coordinate. KVO may fire repeatedly during a single PDFKit layout pass;
  /// a single next-main-turn conversion observes the settled transform without
  /// introducing an arbitrary timer or retaining a second render owner.
  private func scheduleInlineTextEditorReposition() {
    guard inlineTextEditingContext != nil || pendingInlineTextHandoff != nil,
          !inlineEditorRepositionScheduled else { return }
    inlineEditorRepositionScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.inlineEditorRepositionScheduled = false
      guard self.inlineTextEditingContext != nil || self.pendingInlineTextHandoff != nil else { return }
      self.repositionInlineTextEditor()
    }
  }

  /// Recomputes the editor's frame from `inlineTextEditingContext` and the
  /// editor's OWN current text — called on every keystroke and whenever the
  /// viewport changes (scroll/zoom) while active, so it always tracks the
  /// exact PDF-page anchor under scroll/zoom/viewport-restore. Sizing logic
  /// mirrors drawTextAnnotation's own NSString.boundingRect math (same
  /// zero-inset/zero-padding config on the editor) so committing never
  /// visibly jumps.
  private func repositionInlineTextEditor() {
    guard let context = inlineTextEditingContext ?? pendingInlineTextHandoff?.context, let document,
          context.pageNumber >= 1, context.pageNumber <= document.pageCount,
          let page = document.page(at: context.pageNumber - 1)
    else { return }
    // Shared document-space measurement for editor, static glyphs, hit-test and export.
    // No editor-frame or viewport offset ever enters persistence.
    let rect = MaterialTextGeometry.pageRect(
      text: inlineTextEditor.text ?? "", x: context.originX, y: context.originY,
      width: context.width, fontSize: context.fontSize, anchor: context.anchor
    )
    let placement = MaterialTextGeometry.editorPlacement(rect: rect, page: page, pdfView: pdfView, container: self)
    inlineTextEditor.font = UIFont.systemFont(ofSize: CGFloat(context.fontSize))
    inlineTextEditor.transform = .identity
    inlineTextEditor.bounds = CGRect(origin: .zero, size: rect.size)
    inlineTextEditor.center = placement.center
    // UIKit text grows down; PDF-page geometry grows up. Counter-reflect ONCE,
    // just like the CATextLayer child, including PDFKit's page rotation/zoom.
    inlineTextEditor.transform = placement.transform
  }

  /// Atomically hands the editor to document text BEFORE hiding/clearing it.
  /// A brand-new annotation only emits "create" when non-empty — an
  /// existing one always emits "edit" (even empty), reusing JS's existing,
  /// already-tested edit-vs-delete-on-empty logic. Coordinates are NEVER
  /// recomputed here: the anchor captured at begin-time is reused exactly,
  /// since typing never moves it (see inlineTextEditingContext's doc comment).
  private func commitInlineTextEditorIfNeeded() {
    guard let context = inlineTextEditingContext else { return }
    let finalText = (inlineTextEditor.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let id = context.id ?? UUID().uuidString
    // Clear the edit SESSION before resigning, not the visible text. UIKit's
    // synchronous textViewDidEndEditing re-entry must not emit a second commit.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    inlineTextEditingContext = nil
    if context.id != nil || !finalText.isEmpty {
      let annotation = finalText.isEmpty ? nil : TextAnnotation(
        id: id, text: finalText, x: context.originX, y: context.originY,
        width: context.width, fontSize: context.fontSize, anchor: context.anchor
      )
      annotationOverlay.stageTextCommit(id: id, pageNumber: context.pageNumber, annotation: annotation)
      pendingInlineTextHandoff = (id, context)
      completeInlineTextHandoffIfReady()
    } else {
      inlineTextEditor.isHidden = true
      inlineTextEditor.text = ""
    }
    if inlineTextEditor.isFirstResponder { inlineTextEditor.resignFirstResponder() }
    CATransaction.commit()
    MaterialTextTrace.log(context.id == nil ? "editor-create-commit" : "editor-edit-commit") {
      "id=\(context.id ?? "new") page=\(context.pageNumber) pdfX=\(context.originX) pdfY=\(context.originY) width=\(context.width) font=\(context.fontSize)"
    }
    if let id = context.id {
      onTextAnnotationAction(["action": "edit", "pageNumber": context.pageNumber, "annotationId": id, "text": finalText])
    } else if !finalText.isEmpty {
      onTextAnnotationAction([
        "action": "create", "annotationId": id, "pageNumber": context.pageNumber, "text": finalText,
        "x": context.originX, "y": context.originY, "width": context.width, "fontSize": context.fontSize,
        "anchor": "top-left"
      ])
    }
  }

  private func completeInlineTextHandoffIfReady() {
    guard let pending = pendingInlineTextHandoff else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if annotationOverlay.renderCommittedTextIfPossible(id: pending.id, pageNumber: pending.context.pageNumber) {
      // Static glyphs have been built AND displayed at the same page geometry.
      // Visibility swaps in this single transaction; there is no bridge gap.
      inlineTextEditor.isHidden = true
      inlineTextEditor.text = ""
      pendingInlineTextHandoff = nil
    }
    CATransaction.commit()
  }

  func setTextHistoryIntent(pageNumber: Int, annotations: [[String: Any]]) {
    annotationOverlay.setTextHistoryIntent(pageNumber: pageNumber, annotations: annotations)
  }

  private func presentTextActions(_ annotation: TextAnnotationHit, from source: UIView) {
    let menu = UIAlertController(title: "Text", message: nil, preferredStyle: .actionSheet)
    menu.addAction(UIAlertAction(title: "Edit", style: .default) { [weak self] _ in
      self?.beginInlineTextEditing(annotation)
    })
    menu.addAction(UIAlertAction(title: "Copy", style: .default) { [weak self] _ in
      UIPasteboard.general.string = annotation.text
    })
    menu.addAction(UIAlertAction(title: "Delete", style: .destructive) { [weak self] _ in
      self?.onTextAnnotationAction(["action": "delete", "pageNumber": annotation.pageNumber, "annotationId": annotation.id])
    })
    menu.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    present(menu, from: source)
  }

  private func present(_ controller: UIAlertController, from source: UIView) {
    var responder: UIResponder? = self
    var owner: UIViewController?
    while let next = responder?.next {
      if let controller = next as? UIViewController { owner = controller; break }
      responder = next
    }
    guard let owner else { return }
    if let popover = controller.popoverPresentationController {
      popover.sourceView = source
      popover.sourceRect = CGRect(x: source.bounds.midX, y: source.bounds.midY, width: 1, height: 1)
    }
    owner.present(controller, animated: true)
  }

  private func serializeStroke(_ stroke: AnnotationStroke) -> [String: Any] {
    var payload: [String: Any] = [
      "id": stroke.id,
      "tool": stroke.tool,
      "color": stroke.color,
      "width": stroke.width,
      "opacity": stroke.opacity,
      "points": stroke.points.map { [$0.x, $0.y] },
      "createdAt": stroke.createdAt
    ]
    if let shape = stroke.shape { payload["shape"] = shape.json }
    return payload
  }

  private func url(from fileUri: String) -> URL? {
    if fileUri.hasPrefix("file://") { return URL(string: fileUri) }
    return URL(fileURLWithPath: fileUri)
  }
}

// MARK: - UIGestureRecognizerDelegate

extension PdfAnnotationView: UIGestureRecognizerDelegate {
  // Keep the pre-existing Pencil/PDFView simultaneous recognition behavior.
  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    // The selection recognisers (Pencil region/move, finger move/scale) never share touches with PDFView's own.
    let owned: [UIGestureRecognizer] = [selectionGesture, selectionFingerGesture]
    return !owned.contains { $0 === gestureRecognizer || $0 === otherGestureRecognizer }
  }

  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldReceive touch: UITouch
  ) -> Bool {
    guard gestureRecognizer === textTapGesture else { return true }
    return annotationMode == "text"
  }
}

// MARK: - UITextViewDelegate (native inline text editing)

extension PdfAnnotationView: UITextViewDelegate {
  /// Re-grows the editor's frame on every keystroke — one edit SESSION is
  /// still exactly one history action (see commitInlineTextEditorIfNeeded),
  /// this only ever adjusts live on-screen size/position, nothing is
  /// committed or emitted per character.
  public func textViewDidChange(_ textView: UITextView) {
    repositionInlineTextEditor()
  }

  /// Tapping away moves focus elsewhere in the app/keyboard without
  /// necessarily going through handleTextTap first (e.g. dismissing via the
  /// keyboard's own controls) — commit here too so no edit is ever silently
  /// lost. commitInlineTextEditorIfNeeded is a no-op if already committed.
  public func textViewDidEndEditing(_ textView: UITextView) {
    commitInlineTextEditorIfNeeded()
  }
}

// MARK: - PencilDrawGestureRecognizer

/// Pencil-only selection samples. One touch owns one PDF page for the
/// complete gesture; multi-touch is rejected so a pinch cannot become a lasso.
final class PageSelectionGestureRecognizer: UIGestureRecognizer {
  private(set) var confirmedPoints: [CGPoint] = []
  private var activeTouch: UITouch?

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard isEnabled, activeTouch == nil, touches.count == 1,
          let touch = touches.first, touch.type == .pencil else {
      state = .failed; return
    }
    activeTouch = touch
    confirmedPoints = [touch.location(in: view)]
    state = .began
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard let touch = activeTouch, touches.contains(touch) else { return }
    confirmedPoints = (event.coalescedTouches(for: touch) ?? [touch]).map { $0.location(in: view) }
    state = .changed
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    guard let touch = activeTouch, touches.contains(touch) else { return }
    confirmedPoints = [touch.location(in: view)]
    activeTouch = nil
    state = .ended
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    activeTouch = nil
    confirmedPoints = []
    state = .cancelled
  }

  override func reset() {
    super.reset()
    activeTouch = nil
    confirmedPoints = []
  }
}

/// Finger recogniser for manipulating the CURRENT selection. It begins only when the first touch lands inside the
/// selected region (`beginsInside`); otherwise it fails at once and PDFView's own pan/pinch handle the touch. A
/// second finger that also lands inside upgrades the gesture to a two-finger scale.
final class SelectionFingerGestureRecognizer: UIGestureRecognizer {
  var beginsInside: ((CGPoint) -> Bool)?
  private var tracked: [UITouch] = []
  /// Locations of the tracked touches (in the attached view's coordinates), first finger first.
  private(set) var points: [CGPoint] = []

  private func refreshPoints() {
    guard let view else { return }
    points = tracked.map { $0.location(in: view) }
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard isEnabled, let view else { state = .failed; return }
    for touch in touches.sorted(by: { $0.timestamp < $1.timestamp }) where touch.type == .direct && tracked.count < 2 {
      guard beginsInside?(touch.location(in: view)) == true else {
        if tracked.isEmpty { state = .failed; return }
        continue   // a second finger outside the region is ignored
      }
      tracked.append(touch)
    }
    guard !tracked.isEmpty else { state = .failed; return }
    refreshPoints()
    state = state == .possible ? .began : .changed
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard tracked.contains(where: { touches.contains($0) }) else { return }
    refreshPoints()
    state = .changed
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    guard tracked.contains(where: { touches.contains($0) }) else { return }
    refreshPoints()
    state = .ended
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    guard tracked.contains(where: { touches.contains($0) }) else { return }
    state = .cancelled
  }

  override func reset() {
    super.reset()
    tracked.removeAll()
    points = []
  }
}

/// Pencil-only gesture recognizer. `allowedTouchTypes = [.pencil]` is the
/// OS-level filter that reliably routes only Apple Pencil touches to us.
final class PencilDrawGestureRecognizer: UIGestureRecognizer {
  private(set) var confirmedPoints: [CGPoint] = []
  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard isEnabled else { state = .failed; return }
    // Defense in depth: allowedTouchTypes should already have filtered, but
    // re-check anyway.
    guard let touch = touches.first, touch.type == .pencil else {
      state = .failed; return
    }
    confirmedPoints = [touch.location(in: view)]
    state = .began
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard state == .began || state == .changed else { return }
    guard let touch = touches.first, touch.type == .pencil else { return }
    confirmedPoints = (event.coalescedTouches(for: touch) ?? [touch]).map { $0.location(in: view) }
    state = .changed
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    confirmedPoints = touches.filter { $0.type == .pencil }.map { $0.location(in: view) }
    state = (state == .began || state == .changed) ? .ended : .failed
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    confirmedPoints = []
    state = .cancelled
  }
}

// MARK: - AnnotationOverlay (pure rendering)

/// Ink geometry policy = Notebook's production `strokeToPath`
/// (lib/notebookStroke.ts): M s0, then `Q s[i] mid(s[i], s[i+1])` for every
/// interior sample, then `L last`. Live and committed strokes go through this
/// same class, so a stroke never changes shape when it is committed.
///
/// Each CAShapeLayer chunk holds at most 32 curves: assigning its CGPath never
/// copies the entire stroke. The parent opacity composites chunk joins
/// uniformly. A whole touch event's coalesced samples are applied in ONE
/// CATransaction with ONE path assignment.
final class PageInkStrokeLayer: CALayer {
  private let inkColor: CGColor
  private let inkWidth: CGFloat
  private var chunk = CAShapeLayer()
  private var committed = CGMutablePath()
  private var curveEnd = CGPoint.zero
  private var curvesInChunk = 0
  private var last: CGPoint?
  private var sampleCount = 0
  private var dot: CAShapeLayer?

  init(color: String, width: Double, opacity: Double) {
    inkColor = (UIColor(annotationHex: color) ?? .black).cgColor
    inkWidth = CGFloat(width)
    super.init()
    self.opacity = Float(opacity)
    allowsGroupOpacity = true
    masksToBounds = false
    startChunk(at: nil)
  }
  override init(layer: Any) {
    let source = layer as! PageInkStrokeLayer
    inkColor = source.inkColor
    inkWidth = source.inkWidth
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  private func startChunk(at start: CGPoint?) {
    chunk = CAShapeLayer()
    chunk.strokeColor = inkColor
    chunk.fillColor = nil
    chunk.lineWidth = inkWidth
    chunk.lineCap = .round
    chunk.lineJoin = .round
    chunk.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull()]
    addSublayer(chunk)
    committed = CGMutablePath()
    curvesInChunk = 0
    if let start { committed.move(to: start) }
  }

  func append(_ point: CGPoint) { append(contentsOf: [point]) }

  func append(contentsOf points: [CGPoint]) {
    guard !points.isEmpty else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    var changed = false
    for point in points {
      if point == last { continue }
      guard let previous = last else {
        let first = CAShapeLayer()
        first.fillColor = inkColor
        first.path = CGPath(ellipseIn: CGRect(x: point.x - inkWidth / 2, y: point.y - inkWidth / 2,
                                              width: inkWidth, height: inkWidth), transform: nil)
        addSublayer(first)
        dot = first
        committed.move(to: point)
        curveEnd = point
        last = point
        sampleCount = 1
        continue
      }
      if sampleCount >= 2 {
        if curvesInChunk >= 32 {
          chunk.path = committed
          startChunk(at: curveEnd)
        }
        let mid = CGPoint(x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2)
        committed.addQuadCurve(to: mid, control: previous)
        curveEnd = mid
        curvesInChunk += 1
      }
      last = point
      sampleCount += 1
      changed = true
    }
    if changed, let tip = last {
      let drawn = committed.mutableCopy() ?? CGMutablePath()
      drawn.addLine(to: tip)
      chunk.path = drawn
      dot?.removeFromSuperlayer()
      dot = nil
    }
    CATransaction.commit()
  }
}

/// Committed material text belongs to the PDF document, not to the viewer's
/// viewport.  This page-local layer receives the same PDF-page ->
/// `PDFView.documentView` transform as Pencil ink, so PDFKit owns the scroll,
/// pinch, continuous-page, and rotation motion.  UIKit views are reserved for
/// the one temporary inline editor only.
final class PageTextAnnotationLayer: CALayer {
  private var renderedSignature = ""

  override init() {
    super.init()
    anchorPoint = .zero
    masksToBounds = false
    contentsScale = UIScreen.main.scale
  }

  override init(layer: Any) {
    super.init(layer: layer)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  func render(_ annotations: [TextAnnotation]) {
    let signature = annotations.map {
      "\($0.id)|\($0.text)|\($0.x)|\($0.y)|\($0.width)|\($0.fontSize)|\($0.anchor ?? "legacy-bottom")"
    }.joined(separator: "\u{1f}")
    guard signature != renderedSignature else { return }
    renderedSignature = signature

    sublayers?.forEach { $0.removeFromSuperlayer() }
    for annotation in annotations {
      let font = UIFont.systemFont(ofSize: CGFloat(annotation.fontSize))
      let frame = Self.annotationFrame(annotation)

      let text = CATextLayer()
      text.name = annotation.id
      text.frame = frame
      text.contentsScale = UIScreen.main.scale
      text.foregroundColor = UIColor.label.cgColor
      text.font = font
      text.fontSize = CGFloat(annotation.fontSize)
      text.alignmentMode = .left
      text.truncationMode = .none
      text.isWrapped = true
      text.string = NSAttributedString(string: annotation.text, attributes: MaterialTextGeometry.attributes(fontSize: annotation.fontSize))
      // `PageTextAnnotationLayer` is intentionally in PDF-page coordinates.
      // Its parent transform has a reflected Y basis because PDF page space is
      // y-up while the document view is UIKit y-down. Geometry-only Pencil
      // paths are unaffected by that handedness change, but glyph rasterization
      // is not: without this local counter-flip CATextLayer inherits the page
      // reflection and every committed character is upside-down. Flipping only
      // this child around its center preserves its document-space frame and
      // lets the page's existing rotation/zoom transform remain authoritative.
      text.setAffineTransform(CGAffineTransform(scaleX: 1, y: -1))
      text.actions = ["position": NSNull(), "bounds": NSNull(), "contents": NSNull()]
      addSublayer(text)
    }
  }

  /// The exact PDF-page-local frame passed to CATextLayer. Kept centralized so
  /// physical QA can compare this frame with the editor and final PDFView
  /// position without a second, approximate height calculation.
  static func annotationFrame(_ annotation: TextAnnotation) -> CGRect {
    MaterialTextGeometry.pageRect(
      text: annotation.text, x: annotation.x, y: annotation.y,
      width: annotation.width, fontSize: annotation.fontSize, anchor: annotation.anchor
    )
  }
}

/// Transparent UIView that draws committed + in-progress strokes on top of
/// the PDF. NOT a touch surface — `isUserInteractionEnabled = false`. The
/// owning `PdfAnnotationView` calls beginStroke / appendPoint / endStroke
/// from its Pencil gesture handler.
final class AnnotationOverlay: UIView {
  weak var pdfView: PDFView?

  var mode: String = "scroll" {
    didSet { if mode != oldValue { setNeedsDisplay() } }
  }

  var penColor: String = "#061B34"
  var penWidth: Double = 2.4
  var highlighterColor: String = "#FFE066"
  var highlighterWidth: Double = 18
  var eraserRadius: Double = 26

  // ---- Shape Snap (draw-and-hold) ----
  // Bounded by design: per accepted sample it is one distance compare; ONE
  // main-runloop Timer per stroke re-arms itself for the remaining time (never
  // reset per sample); recognition itself is shared TS and only runs when the
  // hold fires (one event out, one answer back). Nothing here touches props,
  // loadAnnotations, the overlay's draw pass, or file IO.
  var shapeSnapEnabled = false
  var shapeSnapHoldSeconds = 0.65
  var shapeSnapTolerancePt = 3.5
  var onShapeHold: ((Int, Int, [CGPoint]) -> Void)?
  private var holdTimer: Timer?
  private var holdAnchor = CGPoint.zero
  private var holdAnchorUptime = 0.0
  private var holdLast = CGPoint.zero
  private var holdFired = false
  private var holdSamples = 0
  private var holdTravelPt = 0.0
  private var strokeToken = 0
  private var snapFrozen = false

  /// Committed strokes loaded from JS, keyed by 1-based page number.
  private var pagedStrokes: [Int: [AnnotationStroke]] = [:]
  /// IDs of strokes committed here (via `endStroke`) that a subsequent
  /// `loadAnnotations` snapshot has not yet echoed back. JS rebuilds and
  /// re-sends the whole `annotationsByPage` prop asynchronously after each
  /// commit; a snapshot captured before that round-trip completes is stale
  /// and must not be allowed to delete a stroke the user can already see.
  /// Once a snapshot DOES contain the id, JS becomes canonical again for it
  /// (including a real edit or delete), and the id is dropped from this set.
  private var pendingLocalStrokeIds: Set<String> = []
  /// Native erases are visually immediate, while JS receives the final page
  /// replacement asynchronously. Suppress an older prop snapshot that still
  /// contains one of these ids until a snapshot acknowledges its absence.
  /// Without this deletion-side counterpart to pendingLocalStrokeIds, erased
  /// ink can flash back for one frame during dense Pencil erasing.
  private var pendingLocalEraseIds: Set<String> = []
  private var pageInkLayers: [Int: CALayer] = [:]
  private var savedInkLayers: [String: PageInkStrokeLayer] = [:]
  private var liveInkLayer: PageInkStrokeLayer?
  private weak var inkDocumentView: UIView?
  private var pageTextLayers: [Int: PageTextAnnotationLayer] = [:]
  private weak var textDocumentView: UIView?
  private var pagedTextAnnotations: [Int: [TextAnnotation]] = [:]
  private var selectionPageNumber: Int?
  private var selectionShape = "lasso"
  private var selectionPoints: [CGPoint] = []
  private var selectedStrokeIds: Set<String> = []
  private var selectionLayer: CAShapeLayer?
  /// Region being drawn (Box/Lasso) lives on its OWN page layer, separate from the selection outline,
  /// so the previous selection can stay visible until the drag proves it is a new region.
  private var regionPageNumber: Int?
  private var regionLayer: CAShapeLayer?
  private var regionDragged = false
  /// The ONE authoritative selection state machine; `selectedStrokeIds` is its projection.
  private var machine: SelectionState = .idle
  var selectionStateKind: String { machine.kind }
  /// Ids selected programmatically that native has not seen yet (Duplicate copies still in flight).
  private var unseenSelectedIds: Set<String> = []
  /// Called when a reload/undo/redo changed what is selected (JS keeps its Duplicate/Delete state in sync).
  var onSelectionReconciled: ((Int, [String]) -> Void)?
  private struct ScaleSession {
    let pageNumber: Int
    let originals: [AnnotationStroke]
    let center: CGPoint
    let startDistance: CGFloat
    let span: CGFloat
    var factor: CGFloat
  }
  private var scaleSession: ScaleSession?
  private var scalePreviewLayers: [String: CAShapeLayer] = [:]
  private var scalePreviewBounds: CGRect?
  private var moveStartPagePoint: CGPoint?
  /// Page whose ink layer is lifted above its siblings during a drag (see setMoveElevation).
  private var elevatedPageNumber: Int?
  /// Cheap always-on counters (fixture + DEV recorder read them).
  var perf = InkPerfCounters()
  private var moveOffset: CGPoint = .zero
  /// Native visual commits, keyed by the SAME id JS persists. An older prop
  /// cannot remove/revert the glyph during the asynchronous persistence echo.
  /// This is transient render reconciliation, not another persisted annotation.
  private var pendingTextCommits: [String: (pageNumber: Int, annotation: TextAnnotation?)] = [:]
  /// Id of the text annotation currently open in the native inline editor
  /// (PdfAnnotationView.inlineTextEditor), if any. Suppressed from BOTH
  /// drawing and hit-testing while set — the live UITextView is the sole
  /// visual/interactive surface for it until the edit commits and this
  /// clears. Never written into pagedTextAnnotations.
  var editingTextAnnotationId: String? { didSet { setNeedsDisplay() } }

  // In-progress stroke state.
  private var inProgressStrokeId: String?
  private var inProgressPageNumber: Int?
  private var inProgressPoints: [CGPoint] = []
  private var inProgressTool: String = "pen"
  private var inProgressColor: String = "#061B34"
  private var inProgressWidth: Double = 2.4
  private var inProgressOpacity: Double = 1
  /// Structured shape produced by a Shape Snap for the live stroke (committed with it on lift).
  private var inProgressShape: StrokeShape?
  /// Start of the live Pen/Highlighter stroke: a TAP is decided from extent + duration at Pencil-up (never per sample).
  private var penStrokeStartUptime = 0.0
  /// Mirrors lib/penTapSelect.ts (PEN_TAP_MAX_DURATION_MS).
  static let penTapMaxDurationSeconds = 0.45

  // ---- Structured shape editing (Shape System Phase 2) ----
  // Handles are UI only: page-space CAShapeLayers sized `screenPt / scale`, redrawn with the
  // selection chrome. A handle drag runs entirely natively on a lightweight preview layer
  // (exact primitives) and emits ONE event on release; no props, no per-sample JS.
  private static let handleRadiusPt: CGFloat = 9
  private static let handleHitPt: CGFloat = 24
  private static let tapSelectPt: CGFloat = 16
  private static let tapMaxExtentPt: CGFloat = 10
  private var handleLayer: CAShapeLayer?
  private var shapePreviewLayer: CAShapeLayer?
  private struct ShapeHandleDrag {
    let strokeId: String
    let pageNumber: Int
    let index: Int
    let grabOffset: CGPoint
    let original: StrokeShape
    var geometry: StrokeShapeGeometry
    var changed: Bool
  }
  private var handleDrag: ShapeHandleDrag?
  /// Set from release until JS echoes the edited stroke (or the fallback fires).
  var shapeEditAwaitingId: String?
  private var shapeEditOverrideGeometry: StrokeShapeGeometry?
  private var shapeEditFallback: Timer?
  /// The stored ink layer hidden while its live preview stands in for it.
  private var hiddenInkStrokeId: String?

  var annotationCount: Int { pagedStrokes.values.reduce(0) { $0 + $1.count } }

  @discardableResult
  private func dispatch(_ event: SelectionEvent) -> String? {
    let (next, cleared) = SelectionMachine.reduce(machine, event)
    machine = next
    selectedStrokeIds = Set(SelectionMachine.selectedIds(next))
    if selectedStrokeIds.isEmpty { dropSelectionVisuals() }
    return cleared
  }

  /// Removes the selection outline / handles. Only ever called when the machine holds no selection.
  private func dropSelectionVisuals() {
    abortManipulations()
    selectionPageNumber = nil
    unseenSelectedIds.removeAll()
    selectionLayer?.removeFromSuperlayer()
    selectionLayer = nil
    handleLayer?.removeFromSuperlayer()
    handleLayer = nil
  }

  /// Cancels any in-flight move / scale / handle drag WITHOUT touching the selection itself.
  private func abortManipulations() {
    if moveStartPagePoint != nil { applyMoveTransforms(.zero) }
    moveStartPagePoint = nil
    moveOffset = .zero
    setMoveElevation(false)
    if handleDrag != nil { cancelHandleDrag() }
    if scaleSession != nil { cancelScale() }
    clearShapeEditPreview()
  }

  private func regionCleanup() {
    selectionPoints.removeAll()
    regionPageNumber = nil
    regionDragged = false
    regionLayer?.removeFromSuperlayer()
    regionLayer = nil
  }

  /// Explicit cancel (also what JS uses after Delete). Ambient events never call this.
  func clearSelection() {
    abortManipulations()
    regionCleanup()
    dispatch(.cancel)
    dropSelectionVisuals()
  }

  /// Leaving the Select tool is one of the explicit deselection events.
  func toolChanged(to mode: String) {
    guard mode != "select" else { return }
    abortManipulations()
    regionCleanup()
    dispatch(.toolChange(mode))
    dropSelectionVisuals()
  }

  /// A Pencil gesture that began as a new region was cancelled: the previous selection is restored, never lost.
  func cancelRegion() {
    dispatch(.regionCancelled)
    regionCleanup()
    if selectionPageNumber != nil { drawSelectionChrome() }
  }

  /// The single selected structured stroke, if the selection is exactly one shape.
  private func selectedShapeStroke() -> (stroke: AnnotationStroke, pageNumber: Int)? {
    guard let number = selectionPageNumber, selectedStrokeIds.count == 1,
          let stroke = (pagedStrokes[number] ?? []).first(where: { selectedStrokeIds.contains($0.id) }),
          stroke.shape != nil else { return nil }
    return (stroke, number)
  }

  private func outlineDistance(_ points: [CGPoint], to p: CGPoint) -> CGFloat {
    var best = CGFloat.infinity
    if points.count == 1 { return hypot(points[0].x - p.x, points[0].y - p.y) }
    for index in 1..<max(1, points.count) {
      let a = points[index - 1], b = points[index]
      let dx = b.x - a.x, dy = b.y - a.y
      let len2 = dx * dx + dy * dy
      let t = len2 == 0 ? 0 : max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
      best = min(best, hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)))
    }
    return best
  }

  /// The structured stroke whose outline is within `tolerance` (page units) of `p`; topmost wins ties.
  private func structuredStroke(onPage number: Int, near p: CGPoint, tolerance: CGFloat) -> AnnotationStroke? {
    var best: AnnotationStroke?
    var bestDistance = tolerance
    for stroke in pagedStrokes[number] ?? [] where stroke.shape != nil {
      let d = outlineDistance(stroke.points, to: p)
      if d <= bestDistance { bestDistance = d; best = stroke }
    }
    return best
  }

  /// Union of the selected strokes' page-space points (before any live drag offset).
  private func selectedPageBounds() -> CGRect {
    guard let number = selectionPageNumber else { return .null }
    if let preview = scalePreviewBounds { return preview }
    var bounds = CGRect.null
    for stroke in pagedStrokes[number] ?? [] where selectedStrokeIds.contains(stroke.id) {
      for point in stroke.points { bounds = bounds.union(CGRect(origin: point, size: .zero)) }
    }
    return bounds
  }

  /// Starts dragging when the Pencil lands inside the selected ink's bounds.
  func beginMoveIfHit(at viewPoint: CGPoint, padPt: CGFloat = SelectionLimits.pencilPadPt) -> Bool {
    guard !selectedStrokeIds.isEmpty, selectionPoints.isEmpty, scaleSession == nil,
          let number = selectionPageNumber, let pdfView, let document = pdfView.document,
          let page = document.page(at: number - 1), pdfView.page(for: viewPoint, nearest: false) === page else { return false }
    let bounds = selectedPageBounds()
    guard !bounds.isNull else { return false }
    let pad = padPt / max(0.01, pdfView.scaleFactor)
    let point = pdfView.convert(viewPoint, to: page)
    guard bounds.insetBy(dx: -pad, dy: -pad).contains(point) else { return false }
    // The Pencil touching ANOTHER structured shape's outline is a (tap-)select of that shape, not a move.
    // A finger inside the selected region always belongs to the selection.
    if padPt == SelectionLimits.pencilPadPt {
      let tapTolerance = Self.tapSelectPt / max(0.01, pdfView.scaleFactor)
      if let other = structuredStroke(onPage: number, near: point, tolerance: tapTolerance), !selectedStrokeIds.contains(other.id) {
        return false
      }
    }
    moveStartPagePoint = point
    moveOffset = .zero
    dispatch(.beginMove)
    setMoveElevation(true)
    return true
  }

  /// A finger TAP outside the selected region: selects the structured shape under it, otherwise it is
  /// an explicit deselect (blank tap). Returns the new selection, or nil when nothing is selected.
  func fingerTap(at viewPoint: CGPoint) -> (pageNumber: Int, strokeIds: [String])? {
    guard scaleSession == nil, handleDrag == nil, regionPageNumber == nil, let pdfView, let document = pdfView.document else { return nil }
    if let page = pdfView.page(for: viewPoint, nearest: false) {
      let number = document.index(for: page) + 1
      let point = pdfView.convert(viewPoint, to: page)
      let unit = 1 / max(0.01, pdfView.scaleFactor)
      if number > 0, let hit = structuredStroke(onPage: number, near: point, tolerance: Self.tapSelectPt * unit) {
        selectionPageNumber = number
        unseenSelectedIds.removeAll()
        dispatch(.tapShape(hit.id))
        drawSelectionChrome()
        return (number, [hit.id])
      }
    }
    dispatch(.tapBlank)
    return nil
  }

  /// True when a FINGER touch-down at `viewPoint` lands inside the selected region (screen-point tolerance),
  /// i.e. the touch belongs to the selection; anywhere else it belongs to the page.
  func fingerHitsSelection(at viewPoint: CGPoint) -> Bool {
    guard !selectedStrokeIds.isEmpty, regionPageNumber == nil, scaleSession == nil, handleDrag == nil,
          let number = selectionPageNumber, let pdfView, let document = pdfView.document,
          let page = document.page(at: number - 1), pdfView.page(for: viewPoint, nearest: true) === page else { return false }
    let bounds = selectedPageBounds()
    guard !bounds.isNull else { return false }
    let pad = SelectionLimits.touchPadPt / max(0.01, pdfView.scaleFactor)
    return bounds.insetBy(dx: -pad, dy: -pad).contains(pdfView.convert(viewPoint, to: page))
  }

  /// The delta is computed in the selection page's own space, so zoom, scroll
  /// and page rotation cannot skew it. It is clamped so ink stays on its page.
  func updateMove(at viewPoint: CGPoint) {
    guard let start = moveStartPagePoint, let number = selectionPageNumber,
          let pdfView, let document = pdfView.document, let page = document.page(at: number - 1) else { return }
    // Deliberately NOT clamped to the source page: selected content is movable content and may follow the finger
    // across the page boundary. Converting through the SOURCE page is a rigid document-space translation, so the
    // live preview stays exact over the gap and the next page. Release resolves the destination page and clamps.
    let point = pdfView.convert(viewPoint, to: page)
    let dx = point.x - start.x, dy = point.y - start.y
    moveOffset = CGPoint(x: dx, y: dy)
    applyMoveTransforms(moveOffset)
    drawSelectionChrome()
  }

  private func applyMoveTransforms(_ offset: CGPoint) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for id in selectedStrokeIds {
      savedInkLayers[id]?.setAffineTransform(CGAffineTransform(translationX: offset.x, y: offset.y))
    }
    CATransaction.commit()
  }

  /// One completed drag. `toPageNumber`/`transform` are set only when the release landed on a DIFFERENT PDF page:
  /// `transform` is the exact source-page -> destination-page affine (CGAffineTransform order a,b,c,d,tx,ty) that
  /// native applied, so JS can persist the identical result from its own authoritative page buckets.
  struct MoveResult {
    let pageNumber: Int
    let strokeIds: [String]
    let dx: CGFloat
    let dy: CGFloat
    var toPageNumber: Int? = nil
    var transform: [Double]? = nil

    var payload: [String: Any] {
      var event: [String: Any] = ["pageNumber": pageNumber, "strokeIds": strokeIds, "dx": Double(dx), "dy": Double(dy)]
      if let toPageNumber, let transform {
        event["toPageNumber"] = toPageNumber
        event["transform"] = transform
      }
      return event
    }
  }

  /// The selection's reference point is the CENTER of its bounds after the drag (one point for the whole group, so
  /// a multi-stroke selection can never scatter across pages). The page under it decides ownership; a release in the
  /// gap or beyond the document resolves to the NEAREST page (PDFKit `page(for:nearest:)`), never to nothing.
  private func transferDestination(from number: Int, dx: CGFloat, dy: CGFloat) -> (page: PDFPage, number: Int)? {
    guard let pdfView, let document = pdfView.document, let source = document.page(at: number - 1) else { return nil }
    let bounds = selectedPageBounds()
    guard !bounds.isNull else { return nil }
    let reference = CGPoint(x: bounds.midX + dx, y: bounds.midY + dy)
    guard let target = pdfView.page(for: pdfView.convert(reference, from: source), nearest: true), target !== source else { return nil }
    let targetNumber = document.index(for: target) + 1
    return targetNumber > 0 ? (target, targetNumber) : nil
  }

  /// Source-page space -> destination-page space, through PDFView space, with the drag applied. Three basis points
  /// carry crop origins, page rotation and continuous-layout offsets exactly (same technique as `pageInkLayer`).
  private func transferTransform(from source: PDFPage, to target: PDFPage, dx: CGFloat, dy: CGFloat) -> CGAffineTransform? {
    guard let pdfView else { return nil }
    func map(_ q: CGPoint) -> CGPoint {
      pdfView.convert(pdfView.convert(CGPoint(x: q.x + dx, y: q.y + dy), from: source), to: target)
    }
    let o = map(.zero), x = map(CGPoint(x: 1, y: 0)), y = map(CGPoint(x: 0, y: 1))
    return CGAffineTransform(a: x.x - o.x, b: x.y - o.y, c: y.x - o.x, d: y.y - o.y, tx: o.x, ty: o.y)
  }

  /// Same-page rule (unchanged product behavior): ink may not be released off its own page.
  private func clampedMove(_ dx: CGFloat, _ dy: CGFloat, page: PDFPage) -> (CGFloat, CGFloat) {
    let bounds = selectedPageBounds(), box = page.bounds(for: .mediaBox)
    var dx = dx, dy = dy
    if !bounds.isNull {
      if bounds.width <= box.width { dx = min(max(dx, box.minX - bounds.minX), box.maxX - bounds.maxX) }
      if bounds.height <= box.height { dy = min(max(dy, box.minY - bounds.minY), box.maxY - bounds.maxY) }
    }
    return (dx, dy)
  }

  /// Lifts the SOURCE page's ink layer above its siblings for the duration of a drag, so the content stays visible
  /// while it crosses the page gap and passes over the next page's layers.
  private func setMoveElevation(_ on: Bool) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if let previous = elevatedPageNumber { pageInkLayers[previous]?.zPosition = 0 }
    elevatedPageNumber = nil
    if on, let number = selectionPageNumber, let layer = pageInkLayer(number) {
      layer.zPosition = 10_000
      elevatedPageNumber = number
    }
    CATransaction.commit()
  }

  /// Commits the drag into the native model at once (so no stale prop can
  /// snap the ink back) and reports ONE page-space delta for JS history. A release on
  /// another PDF page moves the whole selected GROUP into that page's bucket (same ids) atomically.
  func finishMove() -> MoveResult? {
    guard moveStartPagePoint != nil, let number = selectionPageNumber else { return nil }
    dispatch(.endMove)
    var dx = moveOffset.x, dy = moveOffset.y
    // The drag is over: the live offset must be zero BEFORE the strokes are
    // rebuilt at their moved coordinates and the outline is recomputed from
    // them, otherwise the offset would be applied to the outline twice.
    moveStartPagePoint = nil
    moveOffset = .zero
    setMoveElevation(false)
    guard abs(dx) >= 0.5 || abs(dy) >= 0.5 else {
      applyMoveTransforms(.zero)
      drawSelectionChrome()
      return nil
    }
    let ids = selectedStrokeIds
    if let destination = transferDestination(from: number, dx: dx, dy: dy) {
      return commitTransfer(from: number, to: destination, ids: ids, dx: dx, dy: dy)
    }
    if let page = pdfView?.document?.page(at: number - 1) { (dx, dy) = clampedMove(dx, dy, page: page) }
    guard abs(dx) >= 0.5 || abs(dy) >= 0.5 else {
      applyMoveTransforms(.zero)
      drawSelectionChrome()
      return nil
    }
    pagedStrokes[number] = (pagedStrokes[number] ?? []).map { stroke in
      guard ids.contains(stroke.id) else { return stroke }
      return AnnotationStroke(
        id: stroke.id, tool: stroke.tool, color: stroke.color, width: stroke.width,
        opacity: stroke.opacity, points: stroke.points.map { CGPoint(x: $0.x + dx, y: $0.y + dy) },
        createdAt: stroke.createdAt,
        shape: stroke.shape.map { StrokeShape(origin: $0.origin, geometry: $0.geometry.translated(dx: dx, dy: dy)) })
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for id in ids { savedInkLayers.removeValue(forKey: id)?.removeFromSuperlayer() }
    syncPageInk()
    CATransaction.commit()
    drawSelectionChrome()
    return MoveResult(pageNumber: number, strokeIds: ids.sorted(), dx: dx, dy: dy)
  }

  private func commitTransfer(from number: Int, to destination: (page: PDFPage, number: Int), ids: Set<String>, dx: CGFloat, dy: CGFloat) -> MoveResult? {
    guard let pdfView, let document = pdfView.document, let source = document.page(at: number - 1),
          var transform = transferTransform(from: source, to: destination.page, dx: dx, dy: dy) else {
      applyMoveTransforms(.zero)
      drawSelectionChrome()
      return nil
    }
    let moving = (pagedStrokes[number] ?? []).filter { ids.contains($0.id) }
    let groupBounds = selectedPageBounds()
    guard !moving.isEmpty, !groupBounds.isNull else {
      applyMoveTransforms(.zero)
      drawSelectionChrome()
      return nil
    }
    // The released group stays fully on its destination page (same rule as a same-page release).
    let landed = groupBounds.applying(transform), box = destination.page.bounds(for: .mediaBox)
    if landed.width <= box.width {
      if landed.minX < box.minX { transform.tx += box.minX - landed.minX } else if landed.maxX > box.maxX { transform.tx += box.maxX - landed.maxX }
    }
    if landed.height <= box.height {
      if landed.minY < box.minY { transform.ty += box.minY - landed.minY } else if landed.maxY > box.maxY { transform.ty += box.maxY - landed.maxY }
    }
    let placed = moving.map { stroke in
      AnnotationStroke(
        id: stroke.id, tool: stroke.tool, color: stroke.color, width: stroke.width,
        opacity: stroke.opacity, points: stroke.points.map { $0.applying(transform) },
        createdAt: stroke.createdAt,
        shape: stroke.shape.map { StrokeShape(origin: $0.origin, geometry: $0.geometry.transformed(transform)) })
    }
    let remaining = (pagedStrokes[number] ?? []).filter { !ids.contains($0.id) }
    if remaining.isEmpty { pagedStrokes.removeValue(forKey: number) } else { pagedStrokes[number] = remaining }
    pagedStrokes[destination.number] = (pagedStrokes[destination.number] ?? []) + placed
    selectionPageNumber = destination.number
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for id in ids { savedInkLayers.removeValue(forKey: id)?.removeFromSuperlayer() }
    syncPageInk()
    CATransaction.commit()
    drawSelectionChrome()
    return MoveResult(
      pageNumber: number, strokeIds: ids.sorted(), dx: dx, dy: dy, toPageNumber: destination.number,
      transform: [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].map(Double.init))
  }

  func cancelMove() {
    dispatch(.manipulationCancelled)
    moveStartPagePoint = nil
    moveOffset = .zero
    setMoveElevation(false)
    applyMoveTransforms(.zero)
    drawSelectionChrome()
  }

  // MARK: Direct shape tap from a drawing tool (Pen / Highlighter)

  /// The structured shape a just-finished Pen/Highlighter stroke TAPPED, or nil when it is ordinary writing / a
  /// dot on blank paper. Same rule as lib/penTapSelect.ts: tiny extent, short duration, not hold-snapped, and it
  /// lands on a shape outline (screen-point tolerance). Evaluated once at Pencil-up.
  func penTapShapeTarget() -> (stroke: AnnotationStroke, pageNumber: Int)? {
    guard inProgressStrokeId != nil, !snapFrozen, inProgressShape == nil, let number = inProgressPageNumber, let pdfView,
          let first = inProgressPoints.first else { return nil }
    guard ProcessInfo.processInfo.systemUptime - penStrokeStartUptime <= Self.penTapMaxDurationSeconds else { return nil }
    let extent = inProgressPoints.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
    let unit = 1 / max(0.01, pdfView.scaleFactor)
    guard max(extent.width, extent.height) < Self.tapMaxExtentPt * unit else { return nil }
    guard let hit = structuredStroke(onPage: number, near: first, tolerance: Self.tapSelectPt * unit) else { return nil }
    return (hit, number)
  }

  /// Selects the tapped shape (SELECTED_SHAPE, handles appear). The drawing tool, colour and width are untouched.
  func selectShapeFromPenTap(_ stroke: AnnotationStroke, pageNumber: Int) {
    selectionPageNumber = pageNumber
    unseenSelectedIds.removeAll()
    dispatch(.tapShape(stroke.id))
    drawSelectionChrome()
  }

  /// A Pencil-down with a drawing tool while a shape is selected: the shape's handles and outline stay (a re-tap /
  /// reshape); anywhere else it is an explicit "blank" touch and the selection is released. Returns true if cleared.
  func penDownDeselectIfElsewhere(at viewPoint: CGPoint) -> Bool {
    guard !selectedStrokeIds.isEmpty, let number = selectionPageNumber, let pdfView,
          let page = pdfView.document?.page(at: number - 1), pdfView.page(for: viewPoint, nearest: true) === page else { return false }
    let point = pdfView.convert(viewPoint, to: page)
    let unit = 1 / max(0.01, pdfView.scaleFactor)
    if let selected = selectedShapeStroke() {
      if selected.stroke.shape?.geometry.nearestHandle(to: point, radius: Self.handleHitPt * unit) != nil { return false }
      if outlineDistance(selected.stroke.points, to: point) <= Self.tapSelectPt * unit { return false }
    }
    dispatch(.tapBlank)
    return true
  }

  /// Real ink was committed while a shape was selected: writing elsewhere releases the selection. Returns true if cleared.
  func clearSelectionAfterInk() -> Bool {
    guard !selectedStrokeIds.isEmpty else { return false }
    dispatch(.tapBlank)
    return true
  }

  // MARK: Finger arbitration

  enum FingerManipulation { case none, handle, move, scale }

  /// What a finger touch-down on the current selection becomes. Mirrors lib/selectionTransform.routeSelectionTouch,
  /// which is the product contract Notebook follows: TWO fingers both inside -> scale; ONE finger -> a handle of the
  /// single selected structured shape (live reshape) beats the selection body (move); otherwise `.none` and the touch
  /// stays with the page. Every begin* below is what the accepted Pencil paths already use, so hit radii, page-space
  /// conversion and the state machine are identical for a finger.
  func beginFingerManipulation(at points: [CGPoint]) -> FingerManipulation {
    if points.count >= 2, beginScale(at: points[0], and: points[1]) { return .scale }
    guard let first = points.first else { return .none }
    if beginHandleDragIfHit(at: first) { return .handle }
    if beginMoveIfHit(at: first, padPt: SelectionLimits.touchPadPt) { return .move }
    return .none
  }

  // MARK: Structured shape handle drag

  /// Pencil-down on a handle of the single selected structured shape starts a live reshape.
  func beginHandleDragIfHit(at viewPoint: CGPoint) -> Bool {
    guard selectionPoints.isEmpty, handleDrag == nil, let (stroke, number) = selectedShapeStroke(),
          let shape = stroke.shape, let pdfView, let document = pdfView.document,
          let page = document.page(at: number - 1), pdfView.page(for: viewPoint, nearest: true) === page else { return false }
    let point = pdfView.convert(viewPoint, to: page)
    let radius = Self.handleHitPt / max(0.01, pdfView.scaleFactor)
    guard let index = shape.geometry.nearestHandle(to: point, radius: radius) else { return false }
    let handle = shape.geometry.handles[index]
    handleDrag = ShapeHandleDrag(
      strokeId: stroke.id, pageNumber: number, index: index,
      grabOffset: CGPoint(x: handle.x - point.x, y: handle.y - point.y),
      original: shape, geometry: shape.geometry, changed: false)
    clearShapeEditPreview()
    dispatch(.beginHandle)
    return true
  }

  private func handleDragTarget(at viewPoint: CGPoint) -> CGPoint? {
    guard let drag = handleDrag, let pdfView, let document = pdfView.document,
          let page = document.page(at: drag.pageNumber - 1) else { return nil }
    let point = pdfView.convert(viewPoint, to: page)
    return CGPoint(x: point.x + drag.grabOffset.x, y: point.y + drag.grabOffset.y)
  }

  func updateHandleDrag(at viewPoint: CGPoint) {
    guard var drag = handleDrag, let target = handleDragTarget(at: viewPoint), let pdfView else { return }
    let unit = 1 / max(0.01, pdfView.scaleFactor)
    if !drag.changed {
      let original = drag.original.geometry.handles[drag.index]
      if hypot(target.x - original.x, target.y - original.y) < 1.5 * unit { return }
      drag.changed = true
    }
    drag.geometry = drag.original.geometry.dragged(handle: drag.index, to: target, minAxis: 2 * unit)
    handleDrag = drag
    shapeEditOverrideGeometry = drag.geometry
    drawShapeEditPreview(for: drag)
    drawSelectionChrome()
  }

  /// Ends the drag. Returns the event payload when the shape actually changed; the preview
  /// then stays until JS echoes the edited stroke (or the fallback restores the original).
  func finishHandleDrag(at viewPoint: CGPoint) -> (pageNumber: Int, strokeId: String, handleIndex: Int, x: CGFloat, y: CGFloat)? {
    updateHandleDrag(at: viewPoint)
    guard let drag = handleDrag else { return nil }
    // The pointer target the handle followed (line/polygon: the vertex; ellipse: resolved along its axis by JS).
    let target = handleDragTarget(at: viewPoint)
    handleDrag = nil
    // A completed handle edit returns to SELECTED_SHAPE: same shape, handles still visible.
    dispatch(.endHandle)
    guard drag.changed, let target else {
      clearShapeEditPreview()
      drawSelectionChrome()
      return nil
    }
    shapeEditAwaitingId = drag.strokeId
    shapeEditFallback?.invalidate()
    let timer = Timer(timeInterval: 1.5, repeats: false) { [weak self] _ in
      self?.clearShapeEditPreview()
    }
    RunLoop.main.add(timer, forMode: .common)
    shapeEditFallback = timer
    return (drag.pageNumber, drag.strokeId, drag.index, target.x, target.y)
  }

  func cancelHandleDrag() {
    dispatch(.manipulationCancelled)
    handleDrag = nil
    clearShapeEditPreview()
    drawSelectionChrome()
  }

  private func drawShapeEditPreview(for drag: ShapeHandleDrag) {
    guard let stroke = (pagedStrokes[drag.pageNumber] ?? []).first(where: { $0.id == drag.strokeId }),
          let pageLayer = pageInkLayer(drag.pageNumber) else { return }
    let layer = shapePreviewLayer ?? CAShapeLayer()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    savedInkLayers[drag.strokeId]?.isHidden = true
    hiddenInkStrokeId = drag.strokeId
    layer.path = drag.geometry.previewPath
    layer.fillColor = UIColor.clear.cgColor
    layer.strokeColor = (UIColor(annotationHex: stroke.color) ?? .black).cgColor
    layer.lineWidth = CGFloat(stroke.width)
    layer.lineCap = .round
    layer.lineJoin = .round
    layer.opacity = Float(stroke.opacity)
    if layer.superlayer !== pageLayer { pageLayer.addSublayer(layer) }
    CATransaction.commit()
    shapePreviewLayer = layer
  }

  /// Removes the live preview and restores the (possibly re-created) stored ink layer.
  func clearShapeEditPreview() {
    shapeEditFallback?.invalidate()
    shapeEditFallback = nil
    let hadPreview = shapePreviewLayer != nil || shapeEditAwaitingId != nil || shapeEditOverrideGeometry != nil || hiddenInkStrokeId != nil
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    shapePreviewLayer?.removeFromSuperlayer()
    shapePreviewLayer = nil
    if let id = hiddenInkStrokeId { savedInkLayers[id]?.isHidden = false }
    hiddenInkStrokeId = nil
    CATransaction.commit()
    shapeEditAwaitingId = nil
    shapeEditOverrideGeometry = nil
    if hadPreview { refreshSelectionChrome() }
  }

  // MARK: Two-finger scale of the selection

  /// Ink geometry policy shared with `PageInkStrokeLayer`: M s0, `Q s[i-1] mid(s[i-1], s[i])` for i >= 2, L last.
  private static func inkPath(_ points: [CGPoint]) -> CGPath {
    let path = CGMutablePath()
    guard let first = points.first else { return path }
    path.move(to: first)
    if points.count == 1 { path.addLine(to: first); return path }
    if points.count >= 3 {
      for index in 2..<points.count {
        let previous = points[index - 1], point = points[index]
        path.addQuadCurve(to: CGPoint(x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2), control: previous)
      }
    }
    path.addLine(to: points[points.count - 1])
    return path
  }

  private static func scaled(_ stroke: AnnotationStroke, about center: CGPoint, by factor: CGFloat) -> AnnotationStroke {
    // Geometry scales; identity, colour, tool, opacity and PEN WIDTH are preserved.
    AnnotationStroke(
      id: stroke.id, tool: stroke.tool, color: stroke.color, width: stroke.width, opacity: stroke.opacity,
      points: stroke.points.map { CGPoint(x: center.x + ($0.x - center.x) * factor, y: center.y + ($0.y - center.y) * factor) },
      createdAt: stroke.createdAt,
      shape: stroke.shape.map { StrokeShape(origin: $0.origin, geometry: $0.geometry.scaled(about: center, by: factor)) })
  }

  private func pagePoint(_ viewPoint: CGPoint, page number: Int) -> CGPoint? {
    guard let pdfView, let document = pdfView.document, let page = document.page(at: number - 1) else { return nil }
    return pdfView.convert(viewPoint, to: page)
  }

  /// Two fingers on the selected content start a scale. Everything is computed in PAGE space from the
  /// ORIGINAL geometry captured here: the live factor never accumulates from already-scaled points.
  func beginScale(at v1: CGPoint, and v2: CGPoint) -> Bool {
    guard scaleSession == nil, handleDrag == nil, regionPageNumber == nil, !selectedStrokeIds.isEmpty,
          let number = selectionPageNumber,
          let p1 = pagePoint(v1, page: number), let p2 = pagePoint(v2, page: number) else { return false }
    let originals = (pagedStrokes[number] ?? []).filter { selectedStrokeIds.contains($0.id) }
    guard !originals.isEmpty else { return false }
    // Any move preview is discarded: the scale always starts from the original geometry.
    if moveStartPagePoint != nil { applyMoveTransforms(.zero) }
    moveStartPagePoint = nil
    moveOffset = .zero
    var bounds = CGRect.null
    for stroke in originals { for point in stroke.points { bounds = bounds.union(CGRect(origin: point, size: .zero)) } }
    guard !bounds.isNull else { return false }
    let distance = hypot(p2.x - p1.x, p2.y - p1.y)
    guard distance > 0.001 else { return false }
    scaleSession = ScaleSession(
      pageNumber: number, originals: originals, center: CGPoint(x: bounds.midX, y: bounds.midY),
      startDistance: distance, span: max(bounds.width, bounds.height), factor: 1)
    dispatch(.beginScale)
    return true
  }

  /// Live factor, clamped by the shared semantic limits (screen-point based, not document units).
  func updateScale(at v1: CGPoint, and v2: CGPoint) {
    guard var session = scaleSession, let pdfView,
          let p1 = pagePoint(v1, page: session.pageNumber), let p2 = pagePoint(v2, page: session.pageNumber) else { return }
    let raw = hypot(p2.x - p1.x, p2.y - p1.y) / session.startDistance
    session.factor = SelectionLimits.clamp(raw, spanUnits: session.span, unitsPerPt: 1 / max(0.01, pdfView.scaleFactor))
    scaleSession = session
    drawScalePreview(session)
    drawSelectionChrome()
  }

  private func drawScalePreview(_ session: ScaleSession) {
    guard let pageLayer = pageInkLayer(session.pageNumber) else { return }
    var bounds = CGRect.null
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for original in session.originals {
      let scaledStroke = Self.scaled(original, about: session.center, by: session.factor)
      for point in scaledStroke.points { bounds = bounds.union(CGRect(origin: point, size: .zero)) }
      let layer = scalePreviewLayers[original.id] ?? CAShapeLayer()
      layer.path = Self.inkPath(scaledStroke.points)
      layer.fillColor = UIColor.clear.cgColor
      layer.strokeColor = (UIColor(annotationHex: original.color) ?? .black).cgColor
      layer.lineWidth = CGFloat(original.width)
      layer.lineCap = .round
      layer.lineJoin = .round
      layer.opacity = Float(original.opacity)
      savedInkLayers[original.id]?.isHidden = true
      if layer.superlayer !== pageLayer { pageLayer.addSublayer(layer) }
      scalePreviewLayers[original.id] = layer
    }
    CATransaction.commit()
    scalePreviewBounds = bounds.isNull ? nil : bounds
    if session.originals.count == 1, let shape = session.originals[0].shape {
      shapeEditOverrideGeometry = shape.geometry.scaled(about: session.center, by: session.factor)
    }
  }

  private func tearDownScalePreview() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (id, layer) in scalePreviewLayers {
      layer.removeFromSuperlayer()
      savedInkLayers[id]?.isHidden = false
    }
    CATransaction.commit()
    scalePreviewLayers.removeAll()
    scalePreviewBounds = nil
    shapeEditOverrideGeometry = nil
  }

  /// Commits the pinch into the native model at once (so no stale prop can snap the ink back) and
  /// reports ONE page-space transform for JS history. The selection stays active.
  func finishScale(at v1: CGPoint, and v2: CGPoint) -> (pageNumber: Int, strokeIds: [String], factor: CGFloat, centerX: CGFloat, centerY: CGFloat)? {
    updateScale(at: v1, and: v2)
    guard let session = scaleSession else { return nil }
    scaleSession = nil
    dispatch(.endScale)
    guard abs(session.factor - 1) >= 0.005 else {
      tearDownScalePreview()
      drawSelectionChrome()
      return nil
    }
    let ids = Set(session.originals.map(\.id))
    pagedStrokes[session.pageNumber] = (pagedStrokes[session.pageNumber] ?? []).map { stroke in
      ids.contains(stroke.id) ? Self.scaled(stroke, about: session.center, by: session.factor) : stroke
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for id in ids { savedInkLayers.removeValue(forKey: id)?.removeFromSuperlayer() }
    tearDownScalePreview()
    syncPageInk()
    CATransaction.commit()
    drawSelectionChrome()
    return (session.pageNumber, ids.sorted(), session.factor, session.center.x, session.center.y)
  }

  func cancelScale() {
    scaleSession = nil
    dispatch(.manipulationCancelled)
    tearDownScalePreview()
    drawSelectionChrome()
  }

  /// Programmatic selection (Duplicate re-selects its copies). Ids may not have
  /// reached native yet; they are tracked as "unseen" so a stale reload cannot drop them,
  /// and the chrome is recomputed when `loadAnnotations` lands.
  func setSelection(pageNumber: Int, ids: [String]) {
    guard pageNumber > 0, !ids.isEmpty else { clearSelection(); return }
    abortManipulations()
    regionCleanup()
    selectionPageNumber = pageNumber
    let strokes = pagedStrokes[pageNumber] ?? []
    unseenSelectedIds = Set(ids).subtracting(strokes.map(\.id))
    if ids.count == 1, strokes.first(where: { $0.id == ids[0] })?.shape != nil {
      dispatch(.tapShape(ids[0]))
    } else {
      dispatch(.selectInk(ids))
    }
    drawSelectionChrome()
  }

  /// A Pencil-down that is not a handle/move starts a NEW region. The previous selection is NOT
  /// cleared here: it stays until the drag proves this is a region (`.regionDragged`) or the
  /// tap ends on blank paper (`.tapBlank`) — so a cancelled/failed gesture can never lose it.
  func beginSelection(at viewPoint: CGPoint, shape: String) {
    abortManipulations()
    regionCleanup()
    selectionShape = shape
    dispatch(.beginRegion(shape))
    guard let pdfView, let document = pdfView.document,
          let page = pdfView.page(for: viewPoint, nearest: false) else { return }
    let number = document.index(for: page) + 1
    guard number > 0 else { return }
    regionPageNumber = number
    selectionPoints = [pdfView.convert(viewPoint, to: page)]
    drawRegion()
  }

  func appendSelection(at viewPoint: CGPoint) {
    guard let pdfView, let document = pdfView.document,
          let number = regionPageNumber,
          let page = document.page(at: number - 1) else { return }
    // Stay in the page chosen at touch-down. Converting every sample through
    // that same PDFPage handles zoom, scroll, rotation and continuous layout.
    let point = pdfView.convert(viewPoint, to: page)
    let bounds = page.bounds(for: .mediaBox)
    let clamped = CGPoint(x: min(max(point.x, bounds.minX), bounds.maxX),
                          y: min(max(point.y, bounds.minY), bounds.maxY))
    if selectionPoints.last != clamped { selectionPoints.append(clamped) }
    if !regionDragged {
      let extent = selectionPoints.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
      if max(extent.width, extent.height) >= Self.tapMaxExtentPt / max(0.01, pdfView.scaleFactor) {
        regionDragged = true
        dispatch(.regionDragged)   // explicit "new selection": the previous one is dropped now
      }
    }
    drawRegion()
  }

  func finishSelection() -> (pageNumber: Int, strokeIds: [String])? {
    defer { regionCleanup() }
    guard let number = regionPageNumber, let pdfView else {
      dispatch(.regionCancelled)
      dispatch(.tapBlank)
      return nil
    }
    let extent = selectionPoints.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
    let unit = 1 / max(0.01, pdfView.scaleFactor)
    if max(extent.width, extent.height) < Self.tapMaxExtentPt * unit {
      // A TAP: selects the structured shape under it (handles appear), otherwise blank paper (explicit deselect).
      if let first = selectionPoints.first,
         let hit = structuredStroke(onPage: number, near: first, tolerance: Self.tapSelectPt * unit) {
        selectionPageNumber = number
        unseenSelectedIds.removeAll()
        dispatch(.tapShape(hit.id))
        drawSelectionChrome()
        return (number, [hit.id])
      }
      dispatch(.regionCancelled)
      dispatch(.tapBlank)
      return nil
    }
    var ids: [String] = []
    let bounds = selectionShape == "rect" ? boxBetweenFirstAndLastSelectionPoints() : extent
    if selectionPoints.count >= 2, bounds.width >= 3, bounds.height >= 3,
       selectionShape == "rect" || selectionPoints.count >= 3 {
      let isRect = selectionShape == "rect"
      ids = (pagedStrokes[number] ?? []).filter { stroke in
        stroke.points.contains { point in
          isRect ? bounds.contains(point) : Self.pointInPolygon(point, selectionPoints)
        }
      }.map(\.id)
    }
    if !regionDragged { dispatch(.regionDragged) }
    dispatch(.regionComplete(ids))
    guard !ids.isEmpty else { return nil }
    selectionPageNumber = number
    unseenSelectedIds.removeAll()
    if ids.count == 1, (pagedStrokes[number] ?? []).first(where: { $0.id == ids[0] })?.shape != nil {
      dispatch(.tapShape(ids[0]))
    }
    drawSelectionChrome()
    return (number, ids.sorted())
  }

  /// Box selection is corner-to-corner: Pencil-down is corner A and the latest
  /// Pencil point is corner B, never the bounds of the whole trajectory.
  private func boxBetweenFirstAndLastSelectionPoints() -> CGRect {
    guard let a = selectionPoints.first, let b = selectionPoints.last else { return .null }
    return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
  }

  private static func pointInPolygon(_ point: CGPoint, _ polygon: [CGPoint]) -> Bool {
    guard polygon.count >= 3 else { return false }
    var inside = false
    var previous = polygon.count - 1
    for index in polygon.indices {
      let a = polygon[index], b = polygon[previous]
      if (a.y > point.y) != (b.y > point.y),
         point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x { inside.toggle() }
      previous = index
    }
    return inside
  }

  /// The Box/Lasso region being drawn, on the REGION's own page layer.
  private func drawRegion() {
    guard let number = regionPageNumber, let pageLayer = pageInkLayer(number), !selectionPoints.isEmpty else {
      regionLayer?.removeFromSuperlayer()
      regionLayer = nil
      return
    }
    let path = UIBezierPath()
    if selectionShape == "rect" {
      path.append(UIBezierPath(rect: boxBetweenFirstAndLastSelectionPoints()))
    } else {
      path.move(to: selectionPoints[0])
      for point in selectionPoints.dropFirst() { path.addLine(to: point) }
    }
    let layer = regionLayer ?? CAShapeLayer()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.path = path.cgPath
    layer.fillColor = UIColor.clear.cgColor
    layer.strokeColor = UIColor.systemBlue.cgColor
    layer.lineWidth = 1.5 / max(0.01, pdfView?.scaleFactor ?? 1)
    layer.lineDashPattern = [5, 3]
    if layer.superlayer !== pageLayer { pageLayer.addSublayer(layer) }
    CATransaction.commit()
    regionLayer = layer
  }

  /// The selection outline / handles, derived from CURRENT PREVIEW geometry (model + live drag
  /// offset, or the live scale preview) so it stays attached during move, scale and handle drag.
  private func drawSelectionChrome() {
    guard let number = selectionPageNumber, !selectedStrokeIds.isEmpty, let pageLayer = pageInkLayer(number) else {
      selectionLayer?.removeFromSuperlayer()
      selectionLayer = nil
      handleLayer?.removeFromSuperlayer()
      handleLayer = nil
      return
    }
    let path = UIBezierPath()
    // A single structured shape shows HANDLES instead of the dashed bounding box.
    let shapeSelection = selectedShapeStroke()
    var selectionBounds = selectedPageBounds()
    if !selectionBounds.isNull, shapeSelection == nil {
      // moveOffset is always zero while a scale preview is live (beginScale discards any move preview).
      selectionBounds = selectionBounds.offsetBy(dx: moveOffset.x, dy: moveOffset.y)
      path.append(UIBezierPath(rect: selectionBounds.insetBy(dx: -5, dy: -5)))
    }
    drawShapeHandles(shapeSelection, on: pageLayer)
    let layer = selectionLayer ?? CAShapeLayer()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.path = path.cgPath
    layer.fillColor = UIColor.clear.cgColor
    layer.strokeColor = UIColor.systemBlue.cgColor
    layer.lineWidth = 1.5 / max(0.01, pdfView?.scaleFactor ?? 1)
    layer.lineDashPattern = [5, 3]
    if layer.superlayer !== pageLayer { pageLayer.addSublayer(layer) }
    CATransaction.commit()
    selectionLayer = layer
  }

  /// Handles (UI only, never stored): circles sized `screenPt / scale` in page space, following
  /// the live edit geometry and any live body-drag offset.
  private func drawShapeHandles(_ selection: (stroke: AnnotationStroke, pageNumber: Int)?, on pageLayer: CALayer) {
    guard let shape = selection?.stroke.shape, let pdfView else {
      handleLayer?.removeFromSuperlayer()
      handleLayer = nil
      return
    }
    let unit = 1 / max(0.01, pdfView.scaleFactor)
    let geometry = shapeEditOverrideGeometry ?? shape.geometry
    let path = UIBezierPath()
    for handle in geometry.handles {
      let center = CGPoint(x: handle.x + moveOffset.x, y: handle.y + moveOffset.y)
      path.append(UIBezierPath(arcCenter: center, radius: Self.handleRadiusPt * unit, startAngle: 0, endAngle: .pi * 2, clockwise: true))
    }
    let layer = handleLayer ?? CAShapeLayer()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.path = path.cgPath
    layer.fillColor = UIColor.white.cgColor
    layer.strokeColor = UIColor.systemBlue.cgColor
    layer.lineWidth = 2 * unit
    layer.lineDashPattern = nil
    if layer.superlayer !== pageLayer { pageLayer.addSublayer(layer) } else { layer.removeFromSuperlayer(); pageLayer.addSublayer(layer) }
    CATransaction.commit()
    handleLayer = layer
  }

  func refreshSelectionChrome() {
    guard selectionPageNumber != nil else { return }
    drawSelectionChrome()
  }

  /// Eraser cursor — current Pencil location in overlay coordinates. Drawn as
  /// a circular outline on top of the ink so the user can see where the
  /// eraser is and how large its hit area is. Pure presentation: never
  /// persisted, never emitted to JS, never read by the eraser hit-test path.
  private var eraserPreviewPoint: CGPoint?
  private var lastEraserViewPoint: CGPoint?
  private var eraseChangedPages: Set<Int> = []

  init(pdfView: PDFView) {
    self.pdfView = pdfView
    super.init(frame: .zero)
    isOpaque = false
    isUserInteractionEnabled = false   // pure rendering
    contentScaleFactor = UIScreen.main.scale
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// PDFKit owns the enclosing scroll/zoom transform. Three basis points
  /// account for crop origins and rotated PDF pages without per-sample remaps.
  private func pageInkLayer(_ pageNumber: Int) -> CALayer? {
    guard let pdfView, let host = pdfView.documentView,
          let page = pdfView.document?.page(at: pageNumber - 1) else { return nil }
    if inkDocumentView !== host {
      pageInkLayers.values.forEach { $0.removeFromSuperlayer() }
      pageInkLayers.removeAll()
      savedInkLayers.removeAll()
      inkDocumentView = host
    }
    let layer = pageInkLayers[pageNumber] ?? CALayer()
    if layer.superlayer == nil {
      layer.anchorPoint = .zero
      host.layer.addSublayer(layer)
      pageInkLayers[pageNumber] = layer
    }
    func mapped(_ p: CGPoint) -> CGPoint { host.convert(pdfView.convert(p, from: page), from: pdfView) }
    let origin = mapped(.zero), x = mapped(CGPoint(x: 1, y: 0)), y = mapped(CGPoint(x: 0, y: 1))
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.setAffineTransform(CGAffineTransform(a: x.x - origin.x, b: x.y - origin.y,
      c: y.x - origin.x, d: y.y - origin.y, tx: origin.x, ty: origin.y))
    CATransaction.commit()
    return layer
  }

  private func syncPageInk() {
    guard pdfView?.documentView != nil else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let retainedIds = Set(pagedStrokes.values.flatMap { $0.map { $0.id } })
    for id in Array(savedInkLayers.keys) where !retainedIds.contains(id) {
      savedInkLayers.removeValue(forKey: id)?.removeFromSuperlayer()
    }
    for (number, strokes) in pagedStrokes {
      guard let pageLayer = pageInkLayer(number) else { continue }
      for stroke in strokes {
        if let existing = savedInkLayers[stroke.id] {
          if existing.superlayer !== pageLayer { pageLayer.addSublayer(existing) }
          continue
        }
        let ink = PageInkStrokeLayer(color: stroke.color, width: stroke.width, opacity: stroke.opacity)
        stroke.points.forEach { ink.append($0) }
        pageLayer.addSublayer(ink)
        savedInkLayers[stroke.id] = ink
      }
    }
    if let number = inProgressPageNumber, let liveInkLayer, let pageLayer = pageInkLayer(number),
       liveInkLayer.superlayer !== pageLayer { pageLayer.addSublayer(liveInkLayer) }
    CATransaction.commit()
  }

  /// Mirrors `syncPageInk`, but keeps static text out of the fixed
  /// `AnnotationOverlay` viewport.  It deliberately has no scroll-offset
  /// arithmetic: the owning document view is transformed by PDFKit itself.
  private func pageTextLayer(_ pageNumber: Int) -> PageTextAnnotationLayer? {
    guard let pdfView, let host = pdfView.documentView,
          let page = pdfView.document?.page(at: pageNumber - 1) else { return nil }
    if textDocumentView !== host {
      pageTextLayers.values.forEach { $0.removeFromSuperlayer() }
      pageTextLayers.removeAll()
      textDocumentView = host
    }
    let layer = pageTextLayers[pageNumber] ?? PageTextAnnotationLayer()
    if layer.superlayer == nil {
      host.layer.addSublayer(layer)
      pageTextLayers[pageNumber] = layer
    }
    func mapped(_ point: CGPoint) -> CGPoint {
      host.convert(pdfView.convert(point, from: page), from: pdfView)
    }
    let origin = mapped(.zero)
    let x = mapped(CGPoint(x: 1, y: 0))
    let y = mapped(CGPoint(x: 0, y: 1))
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let transform = CGAffineTransform(
      a: x.x - origin.x, b: x.y - origin.y,
      c: y.x - origin.x, d: y.y - origin.y,
      tx: origin.x, ty: origin.y
    )
    layer.setAffineTransform(transform)
    CATransaction.commit()
    MaterialTextTrace.log("document-text-transform") {
      let bounds = page.bounds(for: .mediaBox)
      return "page=\(pageNumber) rotation=\(page.rotation) pageBounds=\(bounds) layerBounds=\(layer.bounds) anchor=\(layer.anchorPoint) affine=(a:\(transform.a),b:\(transform.b),c:\(transform.c),d:\(transform.d),tx:\(transform.tx),ty:\(transform.ty)) determinant=\(transform.a * transform.d - transform.b * transform.c)"
    }
    return layer
  }

  private func syncPageText() {
    guard pdfView?.documentView != nil else { return }
    let retainedPages = Set(pagedTextAnnotations.keys)
    for pageNumber in Array(pageTextLayers.keys) where !retainedPages.contains(pageNumber) {
      pageTextLayers.removeValue(forKey: pageNumber)?.removeFromSuperlayer()
    }
    for (pageNumber, annotations) in pagedTextAnnotations {
      let rendered = annotations.filter { $0.id != editingTextAnnotationId }
      guard let layer = pageTextLayer(pageNumber) else { continue }
      layer.render(rendered)
    }
  }

  // MARK: - Stroke API (called by PdfAnnotationView's gesture handler)

  /// `viewPoint` is in the host PDFView's coordinate space; since the overlay
  /// is constraint-pinned to the same frame the values are identical.
  func beginStroke(at viewPoint: CGPoint, tool: String, color: String, width: Double) {
    guard let pdfView, let document = pdfView.document else { return }
    guard let page = pdfView.page(for: viewPoint, nearest: true) else {
      #if DEBUG
      print("[AnnotationOverlay] beginStroke FAILED — no page at \(viewPoint)")
      #endif
      return
    }
    let pagePoint = pdfView.convert(viewPoint, to: page)
    let pageNumber = document.index(for: page) + 1
    inProgressStrokeId = UUID().uuidString
    inProgressPageNumber = pageNumber
    inProgressPoints = [pagePoint]
    inProgressTool = tool == "highlighter" ? "highlighter" : "pen"
    inProgressColor = color
    inProgressWidth = width
    inProgressOpacity = tool == "highlighter" ? 0.34 : 1
    strokeToken += 1
    snapFrozen = false
    penStrokeStartUptime = ProcessInfo.processInfo.systemUptime
    beginHold(at: pagePoint)
    if let pageLayer = pageInkLayer(pageNumber) {
      let ink = PageInkStrokeLayer(color: color, width: width, opacity: inProgressOpacity)
      pageLayer.addSublayer(ink)
      ink.append(pagePoint)
      liveInkLayer = ink
    }
    #if DEBUG
    print("[AnnotationOverlay] beginStroke page=\(pageNumber) viewPoint=\(viewPoint) pagePoint=\(pagePoint)")
    #endif
  }

  func appendPoint(at viewPoint: CGPoint) { appendPoints(at: [viewPoint]) }

  /// Applies one touch event's coalesced samples as ONE batch. Samples closer
  /// than 1.8 screen points to the previous accepted one are dropped, matching
  /// Notebook's NOTEBOOK_MIN_POINT_DISTANCE filter.
  func appendPoints(at viewPoints: [CGPoint]) {
    if snapFrozen { return }
    guard let pdfView, let document = pdfView.document else { return }
    guard let pageNumber = inProgressPageNumber else { return }
    guard let page = document.page(at: pageNumber - 1) else { return }
    let minimumDistance = 1.8 / max(0.01, pdfView.scaleFactor)
    var accepted: [CGPoint] = []
    for viewPoint in viewPoints {
      let pagePoint = pdfView.convert(viewPoint, to: page)
      if let reference = accepted.last ?? inProgressPoints.last,
         hypot(pagePoint.x - reference.x, pagePoint.y - reference.y) < minimumDistance {
        perf.filteredSamples += 1
        continue
      }
      accepted.append(pagePoint)
    }
    perf.acceptedSamples += accepted.count
    guard !accepted.isEmpty else { return }
    inProgressPoints.append(contentsOf: accepted)
    liveInkLayer?.append(contentsOf: accepted)
    if shapeSnapEnabled { for point in accepted { noteHoldSample(point, scale: pdfView.scaleFactor) } }
  }

  // MARK: - Shape Snap hold tracking

  private func beginHold(at pagePoint: CGPoint) {
    holdTimer?.invalidate()
    holdTimer = nil
    guard shapeSnapEnabled else { return }
    holdAnchor = pagePoint; holdLast = pagePoint
    holdAnchorUptime = ProcessInfo.processInfo.systemUptime
    holdFired = false; holdSamples = 1; holdTravelPt = 0
    scheduleHoldTimer(after: shapeSnapHoldSeconds)
  }

  private func noteHoldSample(_ point: CGPoint, scale: CGFloat) {
    holdSamples += 1
    holdTravelPt += Double(hypot(point.x - holdLast.x, point.y - holdLast.y) * scale)
    holdLast = point
    if Double(hypot(point.x - holdAnchor.x, point.y - holdAnchor.y) * scale) > shapeSnapTolerancePt {
      holdAnchor = point
      holdAnchorUptime = ProcessInfo.processInfo.systemUptime
      holdFired = false
      if holdTimer == nil { scheduleHoldTimer(after: shapeSnapHoldSeconds) }
    }
  }

  private func scheduleHoldTimer(after seconds: Double) {
    holdTimer?.invalidate()
    let timer = Timer(timeInterval: max(0.016, seconds), repeats: false) { [weak self] _ in self?.holdTimerFired() }
    RunLoop.main.add(timer, forMode: .common)
    holdTimer = timer
  }

  private func holdTimerFired() {
    holdTimer = nil
    guard shapeSnapEnabled, inProgressStrokeId != nil, !snapFrozen, let pageNumber = inProgressPageNumber else { return }
    let remaining = shapeSnapHoldSeconds - (ProcessInfo.processInfo.systemUptime - holdAnchorUptime)
    if remaining > 0.008 { scheduleHoldTimer(after: remaining); return }
    guard !holdFired, holdSamples >= 8, holdTravelPt >= 30 else { return }
    holdFired = true
    onShapeHold?(strokeToken, pageNumber, inProgressPoints)
  }

  /// Replaces the LIVE stroke with the recognized clean geometry (page space). Nothing is
  /// committed here: the snapped points are what `endStroke` commits when the Pencil lifts.
  @discardableResult
  func applyShapeSnap(token: Int, points: [CGPoint], shape: StrokeShape? = nil) -> Bool {
    guard token == strokeToken, inProgressStrokeId != nil, !snapFrozen, points.count >= 2,
          let pageNumber = inProgressPageNumber, let pageLayer = pageInkLayer(pageNumber) else { return false }
    holdTimer?.invalidate(); holdTimer = nil
    snapFrozen = true
    inProgressShape = shape
    inProgressPoints = points
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    liveInkLayer?.removeFromSuperlayer()
    let ink = PageInkStrokeLayer(color: inProgressColor, width: inProgressWidth, opacity: inProgressOpacity)
    ink.append(contentsOf: points)
    pageLayer.addSublayer(ink)
    liveInkLayer = ink
    CATransaction.commit()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    return true
  }

  /// Returns the committed stroke + its page number, or nil if the stroke
  /// is empty (e.g. a missed tap).
  func endStroke() -> (stroke: AnnotationStroke, pageNumber: Int)? {
    guard let id = inProgressStrokeId,
          let pageNumber = inProgressPageNumber,
          !inProgressPoints.isEmpty
    else {
      clearInProgress()
      return nil
    }
    let stroke = AnnotationStroke(
      id: id,
      tool: inProgressTool,
      color: inProgressColor,
      width: inProgressWidth,
      opacity: inProgressOpacity,
      points: inProgressPoints,
      createdAt: AnnotationOverlay.isoFormatter.string(from: Date()),
      shape: inProgressShape
    )
    pagedStrokes[pageNumber, default: []].append(stroke)
    pendingLocalStrokeIds.insert(id)
    if let liveInkLayer { savedInkLayers[id] = liveInkLayer }
    liveInkLayer = nil
    clearInProgress()
    setNeedsDisplay()
    return (stroke, pageNumber)
  }

  func cancelStroke() {
    clearInProgress()
    setNeedsDisplay()
  }

  private func clearInProgress() {
    holdTimer?.invalidate()
    holdTimer = nil
    snapFrozen = false
    inProgressShape = nil
    liveInkLayer?.removeFromSuperlayer()
    liveInkLayer = nil
    inProgressStrokeId = nil
    inProgressPageNumber = nil
    inProgressPoints = []
    inProgressTool = "pen"
    inProgressOpacity = 1
  }

  // MARK: - Eraser cursor preview (no persistence, no JS event)

  /// Position the eraser cursor at the given overlay-space point and trigger
  /// a redraw. Called on every Pencil `.began` / `.changed` while in eraser
  /// mode (manual or temporary).
  func showEraserPreview(at viewPoint: CGPoint) {
    eraserPreviewPoint = viewPoint
    setNeedsDisplay()
  }

  /// Clear the eraser cursor. Called on every Pencil `.ended` / `.cancelled`
  /// / `.failed`, and when the JS-driven annotationMode leaves "eraser"
  /// (e.g. tool switch, double-tap returning to Pen).
  func hideEraserPreview() {
    guard eraserPreviewPoint != nil else { return }
    eraserPreviewPoint = nil
    setNeedsDisplay()
  }

  /// Start a native-only erase gesture. Ink is removed from Core Animation at
  /// once; the one final JS/store replacement is emitted by `endErase()`.
  func beginErase(at viewPoint: CGPoint) {
    eraseChangedPages.removeAll()
    lastEraserViewPoint = viewPoint
    eraseSweep(from: viewPoint, to: viewPoint)
  }

  /// Evaluate the entire swept Pencil segment. Gesture recognizers can
  /// coalesce samples, so checking only `to` would let a fast eraser jump
  /// over narrow handwriting.
  func continueErase(at viewPoint: CGPoint) {
    let previous = lastEraserViewPoint ?? viewPoint
    lastEraserViewPoint = viewPoint
    eraseSweep(from: previous, to: viewPoint)
  }

  /// Final page snapshots for one gesture. There is deliberately no bridge
  /// traffic or AsyncStorage/store write for every Pencil move.
  func endErase() -> [(pageNumber: Int, strokes: [AnnotationStroke])] {
    defer {
      eraseChangedPages.removeAll()
      lastEraserViewPoint = nil
    }
    return eraseChangedPages.sorted().map { pageNumber in
      (pageNumber: pageNumber, strokes: pagedStrokes[pageNumber] ?? [])
    }
  }

  private func eraseSweep(from start: CGPoint, to end: CGPoint) {
    guard let pdfView, let document = pdfView.document else { return }
    let startPage = pdfView.page(for: start, nearest: true)
    let endPage = pdfView.page(for: end, nearest: true)
    let startPageNumber = startPage.map { document.index(for: $0) + 1 }
    let endPageNumber = endPage.map { document.index(for: $0) + 1 }
    let candidatePages = [startPage, endPage].compactMap { $0 }
    var seenPages = Set<Int>()
    for page in candidatePages {
      let pageNumber = document.index(for: page) + 1
      guard pageNumber > 0, seenPages.insert(pageNumber).inserted,
            var strokes = pagedStrokes[pageNumber], !strokes.isEmpty
      else { continue }
      // PDFKit's cross-page coordinate conversion can project an endpoint far
      // beyond this page. A sweep is meaningful only when both samples are
      // on the same page; on a page boundary we test each local endpoint
      // independently so an erase gesture cannot reach ink on another page.
      let pageStart = pageNumber == startPageNumber ? start : end
      let pageEnd = pageNumber == endPageNumber ? end : start
      let usesSinglePoint = startPageNumber != endPageNumber
      let localEnd = usesSinglePoint ? pageStart : pageEnd
      let radius = CGFloat(max(4, eraserRadius))
      let removedIds = strokes
        .filter { strokeHitsEraser($0, page: page, eraserStart: pageStart, eraserEnd: localEnd, radius: radius) }
        .map(\.id)
      guard !removedIds.isEmpty else { continue }

      // Intentional erase wins over both an unacknowledged local add and an
      // older JS prop snapshot. The latter stays suppressed until JS echoes a
      // page that omits it, preventing the physical one-frame resurrection.
      pendingLocalStrokeIds.subtract(removedIds)
      pendingLocalEraseIds.formUnion(removedIds)
      let removed = Set(removedIds)
      strokes.removeAll { removed.contains($0.id) }
      pagedStrokes[pageNumber] = strokes
      eraseChangedPages.insert(pageNumber)
    }
    if !eraseChangedPages.isEmpty { setNeedsDisplay() }
  }

  /// The JS-initiated counterpart to the erase-path fix directly above.
  ///
  /// `eraseStroke` can clear `pendingLocalStrokeIds` itself because erase is
  /// NATIVE-initiated — it knows exactly which id it just removed, in the
  /// same call. Undo/Redo are JS-initiated: they only ever reach this view
  /// as a new `annotationsByPage` prop snapshot with the stroke missing,
  /// indistinguishable from a snapshot that simply predates that stroke's
  /// own round-trip echo (the exact case `pendingLocalStrokeIds` exists to
  /// protect against). Without this side-channel, tapping Undo immediately
  /// after finishing a Pencil stroke could be silently reverted by that same
  /// protection — the stroke would stay on screen despite the JS store
  /// already having removed it, until the original round-trip eventually
  /// caught up and cleared the id on its own (an unpredictable delay, not a
  /// missed tap).
  ///
  /// Called from JS just before it sends the snapshot that excludes these
  /// ids, so `loadAnnotations` no longer has any reason to treat their
  /// absence as staleness. Never touches `pagedStrokes` or any drawn ink —
  /// purely clears entries from the pending set.
  func markStrokeRemovalIntent(ids: [String]) {
    guard !ids.isEmpty else { return }
    pendingLocalStrokeIds.subtract(ids)
  }

  /// JS calls this immediately before an Undo restores strokes removed by a
  /// native eraser gesture. This is deliberately a command rather than an
  /// inference from the next prop snapshot: a stale snapshot must remain
  /// suppressed, while an intentional Undo must be allowed to redraw.
  func markStrokeRestorationIntent(ids: [String]) {
    guard !ids.isEmpty else { return }
    pendingLocalEraseIds.subtract(ids)
  }

  // MARK: - Loading committed strokes from JS

  func loadAnnotations(_ annotationsByPage: [String: Any]?) {
    let loadStart = ProcessInfo.processInfo.systemUptime
    defer {
      let now = ProcessInfo.processInfo.systemUptime
      let points = pagedStrokes.values.reduce(0) { $0 + $1.reduce(0) { $0 + $1.points.count } }
      perf.recentLoads.append((loadStart, (now - loadStart) * 1000, pagedStrokes.values.reduce(0) { $0 + $1.count }, points))
      if perf.recentLoads.count > 8 { perf.recentLoads.removeFirst() }
    }
    var loaded: [Int: [AnnotationStroke]] = [:]
    if let dict = annotationsByPage {
      for (key, value) in dict {
        guard let pageNumber = Int(key) else { continue }
        guard let array = value as? [[String: Any]] else { continue }
        var strokes: [AnnotationStroke] = []
        for item in array {
          guard let id = item["id"] as? String else { continue }
          let tool = ((item["tool"] as? String) == "highlighter") ? "highlighter" : "pen"
          let color = (item["color"] as? String) ?? "#061B34"
          let width = AnnotationOverlay.coerceDouble(item["width"]) ?? 2.4
          let opacity = AnnotationOverlay.coerceDouble(item["opacity"]) ?? (tool == "highlighter" ? 0.34 : 1)
          let createdAt = (item["createdAt"] as? String)
            ?? AnnotationOverlay.isoFormatter.string(from: Date())
          let points = AnnotationOverlay.parsePoints(item["points"])
          guard !points.isEmpty else { continue }
          strokes.append(AnnotationStroke(
            id: id, tool: tool, color: color, width: width, opacity: opacity,
            points: points, createdAt: createdAt, shape: StrokeShape.parse(item["shape"])
          ))
        }
        if !strokes.isEmpty { loaded[pageNumber] = strokes }
      }
    }

    // Stale-snapshot protection (see pendingLocalStrokeIds' doc comment).
    // Any pending id present in this snapshot is now acknowledged by JS;
    // any pending id ABSENT from it means this snapshot predates that
    // stroke's round-trip, so the currently-held local copy is re-injected
    // rather than dropped. This never creates a duplicate (only ids missing
    // from `loaded` are re-added) and never blocks a real delete (an
    // intentional erase removes the id from pendingLocalStrokeIds first).
    let loadedIds = Set(loaded.values.flatMap { $0.map(\.id) })
    pendingLocalStrokeIds.subtract(loadedIds)

    // The deletion-side equivalent is intentionally asymmetric: while an
    // older React snapshot still contains an erased id, that id remains
    // suppressed. Its absence acknowledges the final page replacement and
    // clears the tombstone. This prevents native ink from flashing back
    // between immediate removal and the one final JS/store update.
    let acknowledgedEraseIds = pendingLocalEraseIds.subtracting(loadedIds)
    pendingLocalEraseIds.subtract(acknowledgedEraseIds)
    if !pendingLocalEraseIds.isEmpty {
      for pageNumber in Array(loaded.keys) {
        loaded[pageNumber] = loaded[pageNumber]?.filter { !pendingLocalEraseIds.contains($0.id) }
      }
    }

    if !pendingLocalStrokeIds.isEmpty {
      for (pageNumber, strokes) in pagedStrokes {
        let survivors = strokes.filter { pendingLocalStrokeIds.contains($0.id) }
        guard !survivors.isEmpty else { continue }
        loaded[pageNumber, default: []].append(contentsOf: survivors)
      }
    }

    // Reuse identical native layers through the JS acknowledgement; invalidate
    // only changed strokes (same-id move/style edits must not retain stale ink).
    let prior = Dictionary(pagedStrokes.values.flatMap { $0 }.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    for stroke in loaded.values.flatMap({ $0 }) {
      if let old = prior[stroke.id],
         old.points == stroke.points && old.color == stroke.color &&
         old.width == stroke.width && old.opacity == stroke.opacity && old.tool == stroke.tool &&
         old.shape == stroke.shape { continue }
      savedInkLayers.removeValue(forKey: stroke.id)?.removeFromSuperlayer()
      // The edited geometry has arrived from JS: the live handle-drag preview has done its job.
      if shapeEditAwaitingId == stroke.id { clearShapeEditPreview() }
    }
    perf.loadCalls += 1
    // A prop resend with identical content (e.g. unrelated store churn) must
    // not invalidate the overlay: that full redraw competes with live ink.
    if loaded == pagedStrokes {
      perf.loadSkipped += 1
      return
    }
    pagedStrokes = loaded
    reconcileSelectionAfterLoad()
    refreshSelectionChrome()
    setNeedsDisplay()
  }

  /// Undo / redo / store echo / reload: keep every selected object that still exists; drop only what is
  /// gone (`.contentChanged`). Ids never yet seen natively (Duplicate copies in flight) are kept.
  private func reconcileSelectionAfterLoad() {
    guard let number = selectionPageNumber, !selectedStrokeIds.isEmpty else { return }
    let present = Set((pagedStrokes[number] ?? []).map(\.id))
    unseenSelectedIds.subtract(present)
    let before = machine
    dispatch(.contentChanged(Array(present.union(unseenSelectedIds))))
    if machine != before {
      let ids = SelectionMachine.selectedIds(machine).sorted()
      onSelectionReconciled?(ids.isEmpty ? 0 : number, ids)
    }
  }

  func stageTextCommit(id: String, pageNumber: Int, annotation: TextAnnotation?) {
    pendingTextCommits[id] = (pageNumber, annotation)
    var annotations = pagedTextAnnotations[pageNumber] ?? []
    if let annotation {
      if let index = annotations.firstIndex(where: { $0.id == id }) { annotations[index] = annotation }
      else { annotations.append(annotation) }
    } else { annotations.removeAll { $0.id == id } }
    pagedTextAnnotations[pageNumber] = annotations
    editingTextAnnotationId = nil
  }

  func renderCommittedTextIfPossible(id: String, pageNumber: Int) -> Bool {
    guard pdfView?.documentView != nil, let layer = pageTextLayer(pageNumber) else { return false }
    syncPageText()
    layer.sublayers?.forEach { $0.displayIfNeeded() }
    let expected = pagedTextAnnotations[pageNumber]?.contains { $0.id == id } == true
    return (layer.sublayers?.contains { $0.name == id } == true) == expected
  }

  /// Explicit existing Undo/Redo intent must beat an unacknowledged commit;
  /// a missing id in an ordinary stale prop alone is not deletion intent.
  func setTextHistoryIntent(pageNumber: Int, annotations: [[String: Any]]) {
    let next = annotations.compactMap(Self.parseTextAnnotation)
    let ids = Set((pagedTextAnnotations[pageNumber] ?? []).map { $0.id } + next.map { $0.id })
    for id in ids {
      pendingTextCommits[id] = (pageNumber, next.first { $0.id == id })
    }
    pagedTextAnnotations[pageNumber] = next
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    syncPageText()
    CATransaction.commit()
    setNeedsDisplay()
  }

  private static func parseTextAnnotation(_ item: [String: Any]) -> TextAnnotation? {
    guard let id = item["id"] as? String, let text = item["text"] as? String,
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let x = coerceDouble(item["x"]), let y = coerceDouble(item["y"])
    else { return nil }
    return TextAnnotation(id: id, text: text, x: x, y: y,
      width: max(40, coerceDouble(item["width"]) ?? 180),
      fontSize: max(8, coerceDouble(item["fontSize"]) ?? 16),
      anchor: item["anchor"] as? String == "top-left" ? "top-left" : nil)
  }

  func loadTextAnnotations(_ annotationsByPage: [String: Any]?) {
    var loaded: [Int: [TextAnnotation]] = [:]
    for (key, value) in annotationsByPage ?? [:] {
      guard let pageNumber = Int(key), let values = value as? [[String: Any]] else { continue }
      let annotations = values.compactMap(Self.parseTextAnnotation)
      if !annotations.isEmpty { loaded[pageNumber] = annotations }
    }
    for (id, pending) in Array(pendingTextCommits) {
      let echoed = loaded[pending.pageNumber]?.first { $0.id == id }
      if echoed == pending.annotation {
        pendingTextCommits.removeValue(forKey: id)
      } else {
        var annotations = loaded[pending.pageNumber] ?? []
        if let annotation = pending.annotation {
          if let index = annotations.firstIndex(where: { $0.id == id }) { annotations[index] = annotation }
          else { annotations.append(annotation) }
        } else { annotations.removeAll { $0.id == id } }
        loaded[pending.pageNumber] = annotations
      }
    }
    // The JS-side prop can be resent with byte-identical content on a
    // cadence tied to unrelated app activity (recording autosave, any other
    // unrelated store update — see the JS caller's own doc comment). Without
    // this check, every resend redraws every committed text annotation even
    // though nothing about it changed — the exact mechanism behind pasted/
    // committed text visually flashing independent of anything the user did
    // on this screen. Defense-in-depth: correct even if a future caller ever
    // sends this prop unmemoized.
    let textLoadEqual = loaded == pagedTextAnnotations
    MaterialTextTrace.log(textLoadEqual ? "native-text-load-skip-equal" : "native-text-load-apply") {
      let entries = loaded.flatMap { page, annotations in
        annotations.map { "id=\($0.id),p=\(page),x=\($0.x),y=\($0.y),w=\($0.width),f=\($0.fontSize)" }
      }.sorted().joined(separator: ";")
      return "count=\(loaded.values.reduce(0) { $0 + $1.count }) equal=\(textLoadEqual) [\(entries)]"
    }
    if loaded == pagedTextAnnotations { return }
    pagedTextAnnotations = loaded
    refreshSelectionChrome()
    setNeedsDisplay()
  }

  func textAnnotation(at viewPoint: CGPoint) -> TextAnnotationHit? {
    guard let pdfView, let document = pdfView.document,
          let page = pdfView.page(for: viewPoint, nearest: true) else { return nil }
    let pageNumber = document.index(for: page) + 1
    let pagePoint = pdfView.convert(viewPoint, to: page)
    for annotation in (pagedTextAnnotations[pageNumber] ?? []).reversed() {
      // An annotation currently open in the inline editor is not hit-testable —
      // the live UITextView is the sole interactive surface for it until commit,
      // so a drag/tap can never act on its stale pre-edit position underneath.
      if annotation.id == editingTextAnnotationId { continue }
      if PageTextAnnotationLayer.annotationFrame(annotation).insetBy(dx: -3, dy: -3).contains(pagePoint) {
        return TextAnnotationHit(
          id: annotation.id, text: annotation.text, pageNumber: pageNumber,
          x: annotation.x, y: annotation.y, width: annotation.width, fontSize: annotation.fontSize, anchor: annotation.anchor
        )
      }
    }
    return nil
  }

  // MARK: - Drawing

  override func draw(_ rect: CGRect) {
    perf.drawPasses += 1
    guard let ctx = UIGraphicsGetCurrentContext(),
          let pdfView,
          pdfView.document != nil
    else { return }

    syncPageInk()
    syncPageText()


    // Eraser cursor sits on top of everything else so it's always readable.
    if let previewPoint = eraserPreviewPoint {
      #if DEBUG
      print("[AnnotationOverlay] draw eraserPreviewPoint=\(previewPoint)")
      #endif
      drawEraserPreview(
        at: previewPoint,
        radius: CGFloat(max(4, eraserRadius)),
        in: ctx
      )
    }
  }

  /// Soft Youmi-style cursor: light fill so it shows on both the white PDF
  /// page and the light ice-blue surround, with a deep-navy outline + small
  /// center dot for precision. Radius matches the eraser hit-test radius
  /// (`max(4, eraserRadius)`) so the visible circle is exactly the area
  /// that will be erased.
  private func drawEraserPreview(at point: CGPoint, radius: CGFloat, in ctx: CGContext) {
    let rect = CGRect(
      x: point.x - radius,
      y: point.y - radius,
      width: radius * 2,
      height: radius * 2
    )
    ctx.saveGState()
    ctx.setBlendMode(.normal)

    // Soft blue fill — visible on white PDF pages and Youmi's light canvas.
    ctx.setFillColor(UIColor(
      red: 120.0 / 255.0,
      green: 214.0 / 255.0,
      blue: 255.0 / 255.0,
      alpha: 0.22
    ).cgColor)
    ctx.fillEllipse(in: rect)

    // Outline — deep navy with enough contrast to read over text.
    let navy = UIColor(
      red: 6.0 / 255.0,
      green: 27.0 / 255.0,
      blue: 52.0 / 255.0,
      alpha: 0.88
    )
    ctx.setStrokeColor(navy.cgColor)
    ctx.setLineWidth(2.0)
    ctx.strokeEllipse(in: rect)

    // Tiny center dot — anchors the cursor visually so the user always
    // knows the exact Pencil location even when the outer ring is large.
    let dotRadius: CGFloat = 2.4
    ctx.setFillColor(navy.cgColor)
    ctx.fillEllipse(in: CGRect(
      x: point.x - dotRadius,
      y: point.y - dotRadius,
      width: dotRadius * 2,
      height: dotRadius * 2
    ))

    ctx.restoreGState()
  }

  private func drawStroke(_ stroke: AnnotationStroke, page: PDFPage, in ctx: CGContext) {
    guard !stroke.points.isEmpty, let pdfView else { return }
    let viewPoints: [CGPoint] = stroke.points.map { pdfView.convert($0, from: page) }
    let color = UIColor(annotationHex: stroke.color) ?? UIColor.black
    let drawWidth = CGFloat(stroke.width) * pdfView.scaleFactor
    ctx.saveGState()
    ctx.setAlpha(CGFloat(stroke.opacity))
    if stroke.tool == "highlighter" {
      ctx.setBlendMode(.multiply)
    } else {
      ctx.setBlendMode(.normal)
    }

    ctx.setStrokeColor(color.cgColor)
    ctx.setLineWidth(drawWidth)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)

    if viewPoints.count == 1 {
      let p = viewPoints[0]
      ctx.setFillColor(color.cgColor)
      ctx.fillEllipse(in: CGRect(
        x: p.x - drawWidth / 2, y: p.y - drawWidth / 2,
        width: drawWidth, height: drawWidth
      ))
      ctx.restoreGState()
      return
    }

    ctx.beginPath()
    ctx.move(to: viewPoints[0])
    if viewPoints.count == 2 {
      ctx.addLine(to: viewPoints[1])
    } else {
      for i in 1..<(viewPoints.count - 1) {
        let mid = CGPoint(
          x: (viewPoints[i].x + viewPoints[i + 1].x) / 2,
          y: (viewPoints[i].y + viewPoints[i + 1].y) / 2
        )
        ctx.addQuadCurve(to: mid, control: viewPoints[i])
      }
      if let last = viewPoints.last { ctx.addLine(to: last) }
    }
    ctx.strokePath()
    ctx.restoreGState()
  }

  private func strokeHitsEraser(
    _ stroke: AnnotationStroke,
    page: PDFPage,
    eraserStart: CGPoint,
    eraserEnd: CGPoint,
    radius: CGFloat
  ) -> Bool {
    guard let pdfView, !stroke.points.isEmpty else { return false }
    // Convert the two eraser endpoints once. The previous implementation
    // converted every point of every candidate stroke back into view space on
    // every sample, creating substantial allocation/work in dense pages.
    let start = pdfView.convert(eraserStart, to: page)
    let end = pdfView.convert(eraserEnd, to: page)
    let scale = max(0.0001, pdfView.scaleFactor)
    let threshold = radius / scale + max(1, CGFloat(stroke.width) / 2)

    if stroke.points.count == 1 {
      return AnnotationOverlay.distanceFromPoint(stroke.points[0], toSegmentStart: start, end: end) <= threshold
    }

    for i in 0..<(stroke.points.count - 1) {
      if AnnotationOverlay.distanceBetweenSegments(start, end, stroke.points[i], stroke.points[i + 1]) <= threshold {
        return true
      }
    }
    return false
  }

  // MARK: - Helpers

  private static let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()

  fileprivate static func coerceDouble(_ value: Any?) -> Double? {
    if let d = value as? Double { return d }
    if let i = value as? Int { return Double(i) }
    if let n = value as? NSNumber { return n.doubleValue }
    return nil
  }

  private static func parsePoints(_ raw: Any?) -> [CGPoint] {
    var points: [CGPoint] = []
    if let arr = raw as? [[Double]] {
      for pair in arr where pair.count >= 2 {
        points.append(CGPoint(x: pair[0], y: pair[1]))
      }
    } else if let arr = raw as? [[NSNumber]] {
      for pair in arr where pair.count >= 2 {
        points.append(CGPoint(x: pair[0].doubleValue, y: pair[1].doubleValue))
      }
    } else if let arr = raw as? [[String: Any]] {
      for entry in arr {
        if let x = coerceDouble(entry["x"]), let y = coerceDouble(entry["y"]) {
          points.append(CGPoint(x: x, y: y))
        }
      }
    }
    return points
  }

  private static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
    hypot(a.x - b.x, a.y - b.y)
  }

  private static func distanceFromPoint(_ p: CGPoint, toSegmentStart a: CGPoint, end b: CGPoint) -> CGFloat {
    let dx = b.x - a.x
    let dy = b.y - a.y
    let lengthSquared = dx * dx + dy * dy
    if lengthSquared <= 0.0001 { return distance(p, a) }
    let t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
    let projection = CGPoint(x: a.x + t * dx, y: a.y + t * dy)
    return distance(p, projection)
  }

  private static func orientation(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint) -> CGFloat {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  }

  private static func point(_ point: CGPoint, liesOnSegmentFrom a: CGPoint, to b: CGPoint) -> Bool {
    let epsilon: CGFloat = 0.0001
    return abs(orientation(a, b, point)) <= epsilon
      && point.x >= min(a.x, b.x) - epsilon && point.x <= max(a.x, b.x) + epsilon
      && point.y >= min(a.y, b.y) - epsilon && point.y <= max(a.y, b.y) + epsilon
  }

  private static func segmentsIntersect(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ d: CGPoint) -> Bool {
    let abC = orientation(a, b, c)
    let abD = orientation(a, b, d)
    let cdA = orientation(c, d, a)
    let cdB = orientation(c, d, b)
    let epsilon: CGFloat = 0.0001
    if ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
      && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon)) {
      return true
    }
    return point(c, liesOnSegmentFrom: a, to: b)
      || point(d, liesOnSegmentFrom: a, to: b)
      || point(a, liesOnSegmentFrom: c, to: d)
      || point(b, liesOnSegmentFrom: c, to: d)
  }

  private static func distanceBetweenSegments(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint, _ d: CGPoint) -> CGFloat {
    if segmentsIntersect(a, b, c, d) { return 0 }
    return min(
      distanceFromPoint(a, toSegmentStart: c, end: d),
      distanceFromPoint(b, toSegmentStart: c, end: d),
      distanceFromPoint(c, toSegmentStart: a, end: b),
      distanceFromPoint(d, toSegmentStart: a, end: b)
    )
  }
}

// MARK: - Types

/// Structured shape geometry (Shape System Phase 2), PDF page space. Mirrors
/// `lib/annotationShape.ts`: the TS model is authoritative for edit semantics and point
/// generation; native only parses/serializes it, hit-tests handles, and previews a live
/// handle drag from exact primitives. `dragged` is pinned against the TS results by a fixture.
enum StrokeShapeGeometry: Equatable {
  case line(a: CGPoint, b: CGPoint)
  case polygon([CGPoint])
  /// ax / ay are semi-axis VECTORS from the center; handles: [top, right, bottom, left].
  case ellipse(center: CGPoint, ax: CGPoint, ay: CGPoint)

  private static func point(_ raw: Any?) -> CGPoint? {
    guard let d = raw as? [String: Any], let x = AnnotationOverlay.coerceDouble(d["x"]),
          let y = AnnotationOverlay.coerceDouble(d["y"]) else { return nil }
    return CGPoint(x: x, y: y)
  }
  private static func json(_ p: CGPoint) -> [String: Any] { ["x": Double(p.x), "y": Double(p.y)] }

  static func parse(_ raw: Any?) -> StrokeShapeGeometry? {
    guard let d = raw as? [String: Any], let kind = d["kind"] as? String else { return nil }
    switch kind {
    case "line":
      guard let a = point(d["a"]), let b = point(d["b"]) else { return nil }
      return .line(a: a, b: b)
    case "polygon":
      guard let raw = d["vertices"] as? [Any] else { return nil }
      let vertices = raw.compactMap { point($0) }
      return vertices.count == raw.count && (3...4).contains(vertices.count) ? .polygon(vertices) : nil
    case "ellipse":
      guard let c = point(d["center"]), let ax = point(d["ax"]), let ay = point(d["ay"]) else { return nil }
      return .ellipse(center: c, ax: ax, ay: ay)
    default: return nil
    }
  }

  var json: [String: Any] {
    switch self {
    case let .line(a, b): return ["kind": "line", "a": Self.json(a), "b": Self.json(b)]
    case let .polygon(v): return ["kind": "polygon", "vertices": v.map { Self.json($0) }]
    case let .ellipse(c, ax, ay): return ["kind": "ellipse", "center": Self.json(c), "ax": Self.json(ax), "ay": Self.json(ay)]
    }
  }

  var handles: [CGPoint] {
    switch self {
    case let .line(a, b): return [a, b]
    case let .polygon(v): return v
    case let .ellipse(c, ax, ay):
      return [CGPoint(x: c.x - ay.x, y: c.y - ay.y), CGPoint(x: c.x + ax.x, y: c.y + ax.y),
              CGPoint(x: c.x + ay.x, y: c.y + ay.y), CGPoint(x: c.x - ax.x, y: c.y - ax.y)]
    }
  }

  func nearestHandle(to p: CGPoint, radius: CGFloat) -> Int? {
    var best: Int?
    var bestDistance = radius
    for (index, h) in handles.enumerated() {
      let d = hypot(h.x - p.x, h.y - p.y)
      if d <= bestDistance { bestDistance = d; best = index }
    }
    return best
  }

  func translated(dx: CGFloat, dy: CGFloat) -> StrokeShapeGeometry {
    func move(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x + dx, y: p.y + dy) }
    switch self {
    case let .line(a, b): return .line(a: move(a), b: move(b))
    case let .polygon(v): return .polygon(v.map(move))
    case let .ellipse(c, ax, ay): return .ellipse(center: move(c), ax: ax, ay: ay)
    }
  }

  /// Page-to-page transfer (lib/annotationShape.transformGeometry): points map through the full affine, an
  /// ellipse's axis VECTORS only through its linear part. A same-orientation transfer is a pure translation.
  func transformed(_ t: CGAffineTransform) -> StrokeShapeGeometry {
    func linear(_ v: CGPoint) -> CGPoint { CGPoint(x: t.a * v.x + t.c * v.y, y: t.b * v.x + t.d * v.y) }
    switch self {
    case let .line(a, b): return .line(a: a.applying(t), b: b.applying(t))
    case let .polygon(v): return .polygon(v.map { $0.applying(t) })
    case let .ellipse(c, ax, ay): return .ellipse(center: c.applying(t), ax: linear(ax), ay: linear(ay))
    }
  }

  /// Same semantics as TS `dragShapeHandle`: only what the handle controls changes.
  func dragged(handle index: Int, to p: CGPoint, minAxis: CGFloat = 2) -> StrokeShapeGeometry {
    switch self {
    case let .line(a, b): return index == 0 ? .line(a: p, b: b) : .line(a: a, b: p)
    case let .polygon(v):
      return .polygon(v.enumerated().map { $0.offset == index ? p : $0.element })
    case let .ellipse(c, ax, ay):
      let horizontal = index == 1 || index == 3
      let axis = horizontal ? ax : ay
      let length = hypot(axis.x, axis.y)
      guard length > 1e-9 else { return self }
      let u = CGPoint(x: axis.x / length, y: axis.y / length)
      let positive = index == 1 || index == 2
      let anchor = positive ? CGPoint(x: c.x - axis.x, y: c.y - axis.y) : CGPoint(x: c.x + axis.x, y: c.y + axis.y)
      let along = (p.x - anchor.x) * u.x + (p.y - anchor.y) * u.y
      let full = max(2 * minAxis, positive ? along : -along)
      let half = CGPoint(x: u.x * full / 2, y: u.y * full / 2)
      let center = positive ? CGPoint(x: anchor.x + half.x, y: anchor.y + half.y)
                            : CGPoint(x: anchor.x - half.x, y: anchor.y - half.y)
      return horizontal ? .ellipse(center: center, ax: half, ay: ay) : .ellipse(center: center, ax: ax, ay: half)
    }
  }

  /// Exact primitive for the live handle-drag preview (no sampled points involved).
  var previewPath: CGPath {
    switch self {
    case let .line(a, b):
      let path = CGMutablePath(); path.move(to: a); path.addLine(to: b); return path
    case let .polygon(v):
      let path = CGMutablePath(); path.addLines(between: v); path.closeSubpath(); return path
    case let .ellipse(c, ax, ay):
      var transform = CGAffineTransform(a: ax.x, b: ax.y, c: ay.x, d: ay.y, tx: c.x, ty: c.y)
      return CGPath(ellipseIn: CGRect(x: -1, y: -1, width: 2, height: 2), transform: &transform)
    }
  }
}

struct StrokeShape: Equatable {
  let origin: String
  let geometry: StrokeShapeGeometry

  static func parse(_ raw: Any?) -> StrokeShape? {
    guard let d = raw as? [String: Any], let geometry = StrokeShapeGeometry.parse(d["geometry"]) else { return nil }
    return StrokeShape(origin: (d["origin"] as? String) ?? "line", geometry: geometry)
  }
  var json: [String: Any] { ["origin": origin, "geometry": geometry.json] }
}

// MARK: - Selection state machine (mirrors lib/selectionMachine.ts case for case)

/// The ONE authoritative model of what is selected. Selection changes only through explicit
/// events; ambient things (gesture ended/cancelled, store echo, prop reload, Pencil lift,
/// finger touching the selection, rerender, handle-drag completion) are `.noop` and can never
/// clear it. The same case table (scripts/fixtures/selection-machine-cases.json) is replayed
/// against this reducer by the native fixture.
enum SettledSelection: Equatable {
  case ink([String])
  case shape(String)
}

indirect enum SelectionState: Equatable {
  case idle
  case selecting(shape: String, previous: SettledSelection?)
  case selectedInk([String])
  case selectedShape(String)
  case moving(SettledSelection)
  case scaling(SettledSelection)
  case editingHandle(String)

  var kind: String {
    switch self {
    case .idle: return "IDLE"
    case .selecting: return "SELECTING"
    case .selectedInk: return "SELECTED_INK"
    case .selectedShape: return "SELECTED_SHAPE"
    case .moving: return "MOVING_SELECTION"
    case .scaling: return "SCALING_SELECTION"
    case .editingHandle: return "EDITING_SHAPE_HANDLE"
    }
  }
}

enum SelectionEvent {
  case beginRegion(String)
  case regionDragged
  case regionComplete([String])
  case regionCancelled
  case tapShape(String)
  case tapBlank
  case selectInk([String])
  case beginMove, endMove, beginScale, endScale, beginHandle, endHandle, manipulationCancelled
  case toolChange(String)
  case delete
  case pageChange(valid: Bool)
  case contentChanged([String])
  case cancel
  case noop(String)
}

enum SelectionMachine {
  static func settled(_ state: SelectionState) -> SettledSelection? {
    switch state {
    case let .selectedInk(ids): return .ink(ids)
    case let .selectedShape(id): return .shape(id)
    case let .moving(s), let .scaling(s): return s
    case let .editingHandle(id): return .shape(id)
    case let .selecting(_, previous): return previous
    case .idle: return nil
    }
  }

  static func selectedIds(_ state: SelectionState) -> [String] {
    switch settled(state) {
    case let .ink(ids)?: return ids
    case let .shape(id)?: return [id]
    case nil: return []
    }
  }

  static func isManipulating(_ state: SelectionState) -> Bool {
    switch state {
    case .moving, .scaling, .editingHandle: return true
    default: return false
    }
  }

  private static func state(_ settled: SettledSelection) -> SelectionState {
    switch settled {
    case let .ink(ids): return .selectedInk(ids)
    case let .shape(id): return .selectedShape(id)
    }
  }

  private static func clear(_ reason: String, _ current: SelectionState) -> (SelectionState, String?) {
    current == .idle ? (current, nil) : (.idle, reason)
  }

  static func reduce(_ state: SelectionState, _ event: SelectionEvent) -> (SelectionState, String?) {
    let settled = self.settled(state)
    switch event {
    case .noop: return (state, nil)
    case let .beginRegion(shape): return (.selecting(shape: shape, previous: settled), nil)
    case .regionDragged:
      guard case let .selecting(shape, previous) = state, previous != nil else { return (state, nil) }
      return (.selecting(shape: shape, previous: nil), "new-selection")
    case let .regionComplete(ids):
      guard case let .selecting(_, previous) = state else { return (state, nil) }
      if ids.isEmpty { return previous != nil ? (.idle, "region-empty") : (.idle, nil) }
      return (.selectedInk(ids), nil)
    case .regionCancelled:
      guard case let .selecting(_, previous) = state else { return (state, nil) }
      return (previous.map(self.state) ?? .idle, nil)
    case let .tapShape(id): return (.selectedShape(id), nil)
    case .tapBlank: return clear("blank-tap", settled != nil ? state : .idle)
    case let .selectInk(ids): return ids.isEmpty ? clear("region-empty", state) : (.selectedInk(ids), nil)
    case .beginMove:
      if let settled, !isManipulating(state) { return (.moving(settled), nil) }
      return (state, nil)
    case .endMove:
      if case let .moving(s) = state { return (self.state(s), nil) }
      return (state, nil)
    case .beginScale:
      if let settled {
        if case .editingHandle = state { return (state, nil) }
        if case .scaling = state { return (state, nil) }
        return (.scaling(settled), nil)
      }
      return (state, nil)
    case .endScale:
      if case let .scaling(s) = state { return (self.state(s), nil) }
      return (state, nil)
    case .beginHandle:
      if case let .selectedShape(id) = state { return (.editingHandle(id), nil) }
      return (state, nil)
    case .endHandle:
      if case let .editingHandle(id) = state { return (.selectedShape(id), nil) }
      return (state, nil)
    case .manipulationCancelled:
      return isManipulating(state) ? (settled.map(self.state) ?? .idle, nil) : (state, nil)
    case let .toolChange(tool): return tool == "select" ? (state, nil) : clear("tool-change", state)
    case .delete: return clear("deleted", state)
    case let .pageChange(valid): return valid ? (state, nil) : clear("page-change", state)
    case .cancel: return clear("explicit-cancel", state)
    case let .contentChanged(existingIds):
      guard let settled else { return (state, nil) }
      let existing = Set(existingIds)
      switch settled {
      case let .shape(id):
        return existing.contains(id) ? (state, nil) : clear("object-removed", state)
      case let .ink(ids):
        let kept = ids.filter { existing.contains($0) }
        if kept.isEmpty { return clear("object-removed", state) }
        if kept.count == ids.count { return (state, nil) }
        let next = SettledSelection.ink(kept)
        switch state {
        case .selectedInk: return (self.state(next), nil)
        case .moving: return (.moving(next), nil)
        case .scaling: return (.scaling(next), nil)
        case let .selecting(shape, _): return (.selecting(shape: shape, previous: next), nil)
        default: return (self.state(next), nil)
        }
      }
    }
  }
}

/// Shared selection-manipulation limits (mirror lib/selectionTransform.ts; semantic, not document units).
enum SelectionLimits {
  static let scaleMin: CGFloat = 0.2
  static let scaleMax: CGFloat = 5
  static let minSpanPt: CGFloat = 24
  static let maxSpanPt: CGFloat = 6000
  static let touchPadPt: CGFloat = 28
  static let pencilPadPt: CGFloat = 18

  /// Clamps a relative pinch factor so the result neither collapses, inverts nor explodes.
  static func clamp(_ factor: CGFloat, spanUnits: CGFloat, unitsPerPt: CGFloat) -> CGFloat {
    guard factor.isFinite, factor > 0 else { return 1 }
    var f = min(scaleMax, max(scaleMin, factor))
    if spanUnits > 0, unitsPerPt > 0 {
      f = max(f, minSpanPt * unitsPerPt / spanUnits)
      f = min(f, maxSpanPt * unitsPerPt / spanUnits)
      if spanUnits < minSpanPt * unitsPerPt { f = max(f, 1) }
    }
    return f
  }
}

extension StrokeShapeGeometry {
  /// Same semantics as TS `scaleGeometry`: everything scales about `center`; ellipse axis vectors scale too.
  func scaled(about center: CGPoint, by factor: CGFloat) -> StrokeShapeGeometry {
    func s(_ p: CGPoint) -> CGPoint { CGPoint(x: center.x + (p.x - center.x) * factor, y: center.y + (p.y - center.y) * factor) }
    switch self {
    case let .line(a, b): return .line(a: s(a), b: s(b))
    case let .polygon(v): return .polygon(v.map(s))
    case let .ellipse(c, ax, ay):
      return .ellipse(center: s(c), ax: CGPoint(x: ax.x * factor, y: ax.y * factor), ay: CGPoint(x: ay.x * factor, y: ay.y * factor))
    }
  }
}

struct AnnotationStroke: Equatable {
  let id: String
  let tool: String
  let color: String
  let width: Double
  let opacity: Double
  let points: [CGPoint]
  let createdAt: String
  /// Structured shape (authoritative geometry; `points` are derived by JS). nil for ordinary ink.
  var shape: StrokeShape? = nil

  /// Render identity: `createdAt` never affects ink, and legacy strokes may lack it
  /// (parse then stamps "now"), so it must not defeat the no-op reload guard.
  static func == (a: AnnotationStroke, b: AnnotationStroke) -> Bool {
    a.id == b.id && a.tool == b.tool && a.color == b.color && a.width == b.width &&
      a.opacity == b.opacity && a.points == b.points && a.shape == b.shape
  }
}

struct TextAnnotation: Equatable {
  let id: String
  let text: String
  let x: Double
  let y: Double
  let width: Double
  let fontSize: Double
  let anchor: String?
}

struct TextAnnotationHit {
  let id: String
  let text: String
  let pageNumber: Int
  /// Immutable PDF-page origin, preserved while editing.
  let x: Double
  let y: Double
  /// Carried through so the inline editor can be sized/positioned identically
  /// to how this annotation currently renders — no second lookup needed.
  let width: Double
  let fontSize: Double
  let anchor: String?
}

private extension UIColor {
  /// Tolerant hex parser (#RGB, #RRGGBB, with or without leading `#`).
  convenience init?(annotationHex: String) {
    var hex = annotationHex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    if hex.hasPrefix("#") { hex.removeFirst() }
    if hex.count == 3 {
      hex = hex.map { "\($0)\($0)" }.joined()
    }
    guard hex.count == 6 else { return nil }
    var rgb: UInt64 = 0
    Scanner(string: hex).scanHexInt64(&rgb)
    self.init(
      red: CGFloat((rgb >> 16) & 0xFF) / 255.0,
      green: CGFloat((rgb >> 8) & 0xFF) / 255.0,
      blue: CGFloat(rgb & 0xFF) / 255.0,
      alpha: 1
    )
  }
}


// MARK: - Ink performance counters + bounded DEV recorder

struct InkPerfCounters {
  var drawPasses = 0
  var loadCalls = 0
  var loadSkipped = 0
  var acceptedSamples = 0
  var filteredSamples = 0
  /// Most recent prop deliveries (uptime, main-thread ms inside loadAnnotations, strokes, points).
  var recentLoads: [(at: Double, ms: Double, strokes: Int, points: Int)] = []
}

/// Writes ONE short line per finished Pencil stroke to Library/Caches/ink-perf.log,
/// only in the Dev bundle (`.dev` bundle id), capped at ~48 KB. The hot input path
/// only captures raw numbers; formatting and ALL file IO run on a background
/// utility queue so the recorder cannot add main-thread latency to the ink it
/// measures. Source surface is always Course Material (native PDF overlay).
final class InkPerfRecorder {
  static let enabled = Bundle.main.bundleIdentifier?.hasSuffix(".dev") == true
  private static let queue = DispatchQueue(label: "youmi.ink-perf", qos: .utility)
  private var link: CADisplayLink?
  private var linkTarget: InkLinkTarget?
  private var startUptime = 0.0, lastEventUptime = 0.0
  private var events = 0, coalescedTotal = 0, maxCoalesced = 0
  private var intervalTotal = 0.0, maxInterval = 0.0, maxIntervalAt = 0.0
  private var toggleMs = 0.0, mode = "pen"
  private var base = InkPerfCounters()

  func beginStroke(toggleMs: Double, overlay: AnnotationOverlay, mode: String) {
    guard Self.enabled else { return }
    self.toggleMs = toggleMs
    self.mode = mode
    base = overlay.perf
    events = 0; coalescedTotal = 0; maxCoalesced = 0; intervalTotal = 0; maxInterval = 0; maxIntervalAt = 0
    startUptime = ProcessInfo.processInfo.systemUptime
    lastEventUptime = startUptime
    let target = InkLinkTarget()
    let displayLink = CADisplayLink(target: target, selector: #selector(InkLinkTarget.tick(_:)))
    displayLink.add(to: .main, forMode: .common)
    link = displayLink
    linkTarget = target
  }

  func cancel() {
    link?.invalidate(); link = nil
    linkTarget = nil
  }

  func noteEvent(coalesced: Int) {
    guard Self.enabled else { return }
    let now = ProcessInfo.processInfo.systemUptime
    let gap = now - lastEventUptime
    lastEventUptime = now
    events += 1
    intervalTotal += gap
    if gap > maxInterval { maxInterval = gap; maxIntervalAt = now - startUptime }
    coalescedTotal += coalesced
    maxCoalesced = max(maxCoalesced, coalesced)
  }

  func endStroke(commitMs: Double, overlay: AnnotationOverlay) {
    guard Self.enabled else { return }
    link?.invalidate(); link = nil
    let frames = linkTarget?.frames ?? 0, longFrames = linkTarget?.longFrames ?? 0
    let maxFrameMs = (linkTarget?.maxGap ?? 0) * 1000
    let maxFrameAt = ((linkTarget?.maxGapAt ?? startUptime) - startUptime) * 1000
    linkTarget = nil
    let p = overlay.perf
    let now = ProcessInfo.processInfo.systemUptime
    let durationMs = (now - startUptime) * 1000
    // Loads that landed inside this stroke, as "at+offset ms/duration ms(strokes,points)".
    let loads = p.recentLoads.filter { $0.at >= startUptime && $0.at <= now }
      .map { String(format: "@%.0fms/%.1fms(%ds,%dp)", ($0.at - startUptime) * 1000, $0.ms, $0.strokes, $0.points) }
      .joined(separator: ",")
    let snapshot = (mode, durationMs, events, intervalTotal, maxInterval * 1000, maxIntervalAt * 1000,
                    coalescedTotal, maxCoalesced, p.acceptedSamples - base.acceptedSamples,
                    p.filteredSamples - base.filteredSamples, frames, longFrames, maxFrameMs, maxFrameAt,
                    p.drawPasses - base.drawPasses, p.loadCalls - base.loadCalls, p.loadSkipped - base.loadSkipped,
                    toggleMs, commitMs, loads)
    Self.queue.async {
      let s = snapshot
      let line = String(format: "%@ surface=material mode=%@ dur=%.0fms events=%d avgGap=%.1fms maxGap=%.1fms@%.0fms coalesced(avg=%.1f,max=%d) accepted=%d filtered=%d frames=%d long(>25ms)=%d maxFrame=%.1fms@%.0fms draws=%d loads=%d skipped=%d toggle=%.1fms commit=%.1fms loadsInStroke=[%@]\n",
        ISO8601DateFormatter().string(from: Date()), s.0, s.1, s.2,
        s.2 > 0 ? s.3 / Double(s.2) * 1000 : 0, s.4, s.5,
        s.2 > 0 ? Double(s.6) / Double(s.2) : 0, s.7, s.8, s.9, s.10, s.11, s.12, s.13,
        s.14, s.15, s.16, s.17, s.18, s.19)
      guard let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
      let url = dir.appendingPathComponent("ink-perf.log")
      var existing = (try? Data(contentsOf: url)) ?? Data()
      if existing.count > 48 * 1024 { existing = existing.suffix(24 * 1024) }
      existing.append(Data(line.utf8))
      try? existing.write(to: url, options: .atomic)
    }
  }
}

final class InkLinkTarget: NSObject {
  var frames = 0, longFrames = 0
  var maxGap = 0.0, maxGapAt = 0.0
  private var previous = 0.0
  @objc func tick(_ link: CADisplayLink) {
    if previous > 0 {
      let gap = link.timestamp - previous
      frames += 1
      if gap > maxGap { maxGap = gap; maxGapAt = link.timestamp }
      if gap > 0.025 { longFrames += 1 }
    }
    previous = link.timestamp
  }
}
