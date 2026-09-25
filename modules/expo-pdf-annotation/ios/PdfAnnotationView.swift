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

  /// Finger tap on a text annotation (select) or, in "text" mode, on empty
  /// page space (create). Requires the existing long-press to fail first —
  /// see the delegate section below — so a genuine long-press always wins
  /// and still opens the Move/Edit/Copy/Delete sheet exactly as before.
  private lazy var textTapGesture: UITapGestureRecognizer = {
    let g = UITapGestureRecognizer(target: self, action: #selector(handleTextTap(_:)))
    g.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    g.delegate = self
    return g
  }()

  /// Finger drag that repositions the CURRENTLY SELECTED text annotation.
  /// Gated (via the UIGestureRecognizerDelegate methods below) to only ever
  /// receive a touch that starts on that selected annotation while in
  /// "scroll" or "text" mode — every other touch is left completely alone,
  /// so normal PDF panning is untouched and Pen/Highlighter drawing (a
  /// distinct Pencil-only touch type, see pencilGesture) can never be
  /// affected by this. Also requires the long-press to fail, matching
  /// textTapGesture, so a held touch always resolves as the existing
  /// action-sheet flow instead of starting a drag.
  private lazy var textDragGesture: UIPanGestureRecognizer = {
    let g = UIPanGestureRecognizer(target: self, action: #selector(handleTextDrag(_:)))
    g.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    g.maximumNumberOfTouches = 1
    g.delegate = self
    return g
  }()

  /// Set for the duration of one textDragGesture, from `.began` to
  /// `.ended`/`.cancelled`. `startPagePoint` + `originX`/`originY` are the
  /// drag's anchor: every `.changed` computes a fresh page-space delta from
  /// `startPagePoint` and applies it to the ORIGINAL origin, rather than
  /// accumulating per-frame deltas, so rounding never drifts across a long
  /// drag.
  private var textDragContext: (id: String, pageNumber: Int, startPagePoint: CGPoint, originX: Double, originY: Double)?

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

  /// Small, restrained delete affordance shown whenever a text annotation is
  /// selected (editing or not) — the only way to delete text in "text" mode
  /// without the removed long-press-only action sheet. Positioned at the
  /// selected annotation's own rect; hidden whenever nothing is selected.
  private lazy var textDeleteButton: UIButton = {
    let button = UIButton(type: .system)
    button.isHidden = true
    button.tintColor = .systemRed
    button.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.92)
    button.layer.cornerRadius = 12
    button.layer.shadowColor = UIColor.black.cgColor
    button.layer.shadowOpacity = 0.18
    button.layer.shadowRadius = 3
    button.layer.shadowOffset = CGSize(width: 0, height: 1)
    button.setImage(UIImage(systemName: "trash.circle.fill"), for: .normal)
    button.addTarget(self, action: #selector(handleTextDeleteButtonTap), for: .touchUpInside)
    return button
  }()

  /// Set for the duration of one inline text edit/create session. `id == nil`
  /// means a brand-new annotation (nothing committed to the store yet);
  /// non-nil means editing an existing one (suppressed from drawing/hit-
  /// testing for the duration — see AnnotationOverlay.editingTextAnnotationId).
  /// originX/originY/fontSize/width are the ANCHOR the final commit reuses
  /// unchanged — typing more text only grows the visual box, it never moves
  /// the anchor (matches drawTextAnnotation's existing bottom-anchored
  /// convention, so paste/created/edited text all render identically).
  private var inlineTextEditingContext: (id: String?, pageNumber: Int, originX: Double, originY: Double, fontSize: Double, width: Double)?
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
  private var pendingTextMove: (id: String, pageNumber: Int)?
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
        // Leaving "text" mode (e.g. switching to Pen) must never leave an
        // inline editor dangling open — commit whatever was being typed
        // first, exactly as if the user had tapped away.
        if annotationMode != "text" {
          commitInlineTextEditorIfNeeded()
        }
        // The delete button is a real interactive subview that would
        // otherwise sit on top of the page and could swallow a Pencil touch
        // landing on it — only relevant while selecting/editing text is
        // even possible (scroll/text mode), so it must disappear the moment
        // a draw tool becomes active, never lingering as a stray hit target.
        if annotationMode != "scroll" && annotationMode != "text" {
          textDeleteButton.isHidden = true
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
    }
  }

  var selectedTextAnnotationId: String? {
    didSet {
      annotationOverlay.selectedTextAnnotationId = selectedTextAnnotationId
      repositionTextDeleteButton()
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

    // Manually-framed (not Auto Layout) — position is computed per-edit from
    // PDF-page-coordinate conversion, the same pattern drawTextAnnotation
    // already uses. Added above the overlay so they're both visible and
    // touchable; layoutSubviews() keeps them frontmost while active.
    addSubview(inlineTextEditor)
    addSubview(textDeleteButton)

    // Attach Pencil-only gesture recognizer to PDFView. allowedTouchTypes
    // is the OS-level filter that actually works (vs the hitTest dance).
    pdfView.addGestureRecognizer(pencilGesture)
    let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleFingerLongPress(_:)))
    longPress.minimumPressDuration = 0.45
    longPress.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    longPress.delegate = self
    pdfView.addGestureRecognizer(longPress)
    textTapGesture.require(toFail: longPress)
    textDragGesture.require(toFail: longPress)
    pdfView.addGestureRecognizer(textTapGesture)
    pdfView.addGestureRecognizer(textDragGesture)
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
    if !textDeleteButton.isHidden { bringSubviewToFront(textDeleteButton) }
    annotationOverlay.setNeedsDisplay()
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
    let isAnnotationTool = annotationMode == "pen" || annotationMode == "highlighter" || annotationMode == "eraser"
    pencilGesture.isEnabled = isAnnotationTool
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

  // MARK: - Pencil gesture callback

  @objc private func handlePencilGesture(_ recognizer: PencilDrawGestureRecognizer) {
    switch recognizer.state {
    case .began:
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
      setNonPencilGesturesEnabled(false)
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
        for point in recognizer.confirmedPoints { annotationOverlay.appendPoint(at: point) }
      }

    case .ended:
      setNonPencilGesturesEnabled(true)
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
        for point in recognizer.confirmedPoints { annotationOverlay.appendPoint(at: point) }
        if let commit = annotationOverlay.endStroke() {
        #if DEBUG
        traceViewportMutation("annotation-committed", reason: "page=\(commit.pageNumber) points=\(commit.stroke.points.count)", force: true)
        print("[PdfAnnotationView] pencil .ended commit page=\(commit.pageNumber) points=\(commit.stroke.points.count)")
        #endif
        emitStrokeCommitted(commit.stroke, pageNumber: commit.pageNumber)
        } else {
        #if DEBUG
        print("[PdfAnnotationView] pencil .ended NO commit (empty stroke)")
        #endif
        }
      }

    case .cancelled, .failed:
      setNonPencilGesturesEnabled(true)
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
    if inlineTextEditingContext != nil { scheduleInlineTextEditorReposition() }
    if selectedTextAnnotationId != nil { repositionTextDeleteButton() }
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
    for recognizer in allGestureRecognizers(in: pdfView) where recognizer !== pencilGesture {
      recognizer.isEnabled = enabled
    }
    #if DEBUG
    traceViewportMutation("setNonPencilGesturesEnabled-after", reason: "enabled=\(enabled)")
    #endif
  }

  private func applyPdfGestureTouchPolicy() {
    let isAnnotationTool = annotationMode == "pen" || annotationMode == "highlighter" || annotationMode == "eraser"
    let fingerTouchTypes = [
      NSNumber(value: UITouch.TouchType.direct.rawValue),
      NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)
    ]

    for recognizer in allGestureRecognizers(in: pdfView) {
      if recognizer === pencilGesture { continue }
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
      if inlineTextEditingContext != nil { scheduleInlineTextEditorReposition() }
      if selectedTextAnnotationId != nil { repositionTextDeleteButton() }
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
    guard let document, let page = pdfView.page(for: point, nearest: true) else { return }
    let pageNumber = document.index(for: page) + 1
    let pagePoint = pdfView.convert(point, to: page)
    if let pending = pendingTextMove {
      pendingTextMove = nil
      onTextAnnotationAction(["action": "move", "pageNumber": pageNumber, "annotationId": pending.id, "x": pagePoint.x, "y": pagePoint.y])
      return
    }
    if let existing = annotationOverlay.textAnnotation(at: point) {
      onTextAnnotationAction(["action": "select", "pageNumber": existing.pageNumber, "annotationId": existing.id])
      presentTextActions(existing, from: recognizer.view ?? pdfView)
      return
    }
    let clipboard = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !clipboard.isEmpty else { return }
    let menu = UIAlertController(title: "Course Material", message: nil, preferredStyle: .actionSheet)
    menu.addAction(UIAlertAction(title: "Paste", style: .default) { [weak self] _ in
      self?.onTextAnnotationAction(["action": "paste", "pageNumber": pageNumber, "text": clipboard, "x": pagePoint.x, "y": pagePoint.y])
    })
    menu.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    present(menu, from: recognizer.view ?? pdfView)
  }

  /// Quick tap (not a hold — see textTapGesture.require(toFail:) on the
  /// long-press above): in "text" mode, tapping existing text selects AND
  /// immediately opens it in the inline editor (caret + keyboard, directly
  /// on the canvas — no modal); tapping empty space begins a brand-new
  /// inline annotation there. In "scroll" mode a tap only selects (editing
  /// stays a deliberate long-press action there, unchanged). Any tap while
  /// the inline editor is already open commits it first, so the new tap is
  /// evaluated against the just-settled state.
  @objc private func handleTextTap(_ recognizer: UITapGestureRecognizer) {
    guard recognizer.state == .ended, annotationMode == "scroll" || annotationMode == "text" else { return }
    let point = recognizer.location(in: pdfView)
    guard let document, let page = pdfView.page(for: point, nearest: true) else { return }
    let pageNumber = document.index(for: page) + 1
    let pagePoint = pdfView.convert(point, to: page)

    commitInlineTextEditorIfNeeded()

    if let existing = annotationOverlay.textAnnotation(at: point) {
      onTextAnnotationAction(["action": "select", "pageNumber": existing.pageNumber, "annotationId": existing.id])
      if annotationMode == "text" {
        beginInlineTextEditing(existing)
      }
      return
    }

    if annotationMode == "text" {
      beginInlineTextCreation(at: pagePoint, pageNumber: pageNumber, page: page)
      return
    }

    if selectedTextAnnotationId != nil {
      onTextAnnotationAction(["action": "deselect", "pageNumber": pageNumber])
    }
  }

  /// Repositions the currently-selected text annotation. Only ever begins
  /// for a touch that starts on that exact annotation while in "scroll" or
  /// "text" mode — see gestureRecognizer(_:shouldReceive:) below, which is
  /// the actual gate; everything here can assume that precondition already
  /// held at `.began`. Tracks visually via annotationOverlay.liveDraggedTextPosition
  /// and emits exactly ONE "move" mutation at `.ended`/`.cancelled` — the
  /// same event type the existing long-press Move flow already emits, so no
  /// new JS-side handling is needed beyond capturing a "before" position for
  /// history.
  @objc private func handleTextDrag(_ recognizer: UIPanGestureRecognizer) {
    let point = recognizer.location(in: pdfView)
    switch recognizer.state {
    case .began:
      guard let document, let page = pdfView.page(for: point, nearest: true),
            let selectedId = selectedTextAnnotationId,
            let hit = annotationOverlay.textAnnotation(at: point), hit.id == selectedId
      else { return }
      let pageNumber = document.index(for: page) + 1
      let pagePoint = pdfView.convert(point, to: page)
      textDragContext = (id: hit.id, pageNumber: pageNumber, startPagePoint: pagePoint, originX: hit.x, originY: hit.y)
      annotationOverlay.liveDraggedTextPosition = (id: hit.id, x: hit.x, y: hit.y)

    case .changed:
      guard let context = textDragContext, let page = document?.page(at: context.pageNumber - 1) else { return }
      let currentPagePoint = pdfView.convert(point, to: page)
      let dx = currentPagePoint.x - context.startPagePoint.x
      let dy = currentPagePoint.y - context.startPagePoint.y
      annotationOverlay.liveDraggedTextPosition = (id: context.id, x: context.originX + dx, y: context.originY + dy)

    case .ended:
      guard let context = textDragContext, let page = document?.page(at: context.pageNumber - 1) else {
        textDragContext = nil; annotationOverlay.liveDraggedTextPosition = nil
        return
      }
      let currentPagePoint = pdfView.convert(point, to: page)
      let dx = currentPagePoint.x - context.startPagePoint.x
      let dy = currentPagePoint.y - context.startPagePoint.y
      let finalX = context.originX + dx
      let finalY = context.originY + dy
      textDragContext = nil
      annotationOverlay.liveDraggedTextPosition = nil
      onTextAnnotationAction(["action": "move", "pageNumber": context.pageNumber, "annotationId": context.id, "x": finalX, "y": finalY])

    case .cancelled, .failed:
      // Abandoned mid-drag (e.g. a second touch interrupts it) — drop back to
      // the committed position. No mutation was ever emitted, so there is
      // nothing to undo; the overlay simply stops showing the live override.
      textDragContext = nil
      annotationOverlay.liveDraggedTextPosition = nil

    default:
      break
    }
  }

  // MARK: - Native inline text editing

  /// Begins a brand-new annotation at `pagePoint`. Nothing is committed to
  /// the store until the editor commits with non-empty text — an empty
  /// commit (tapped, typed nothing, tapped away) creates nothing.
  private func beginInlineTextCreation(at pagePoint: CGPoint, pageNumber: Int, page: PDFPage) {
    let pageWidth = page.bounds(for: .mediaBox).width
    let availableWidth = max(80, pageWidth - pagePoint.x - 24)
    let fontSize = 16.0
    inlineTextEditingContext = (
      id: nil, pageNumber: pageNumber,
      originX: Double(pagePoint.x), originY: Double(pagePoint.y),
      fontSize: fontSize, width: Double(availableWidth)
    )
    MaterialTextTrace.log("editor-create-begin") {
      "page=\(pageNumber) pdfX=\(pagePoint.x) pdfY=\(pagePoint.y) width=\(availableWidth) scale=\(pdfView.scaleFactor)"
    }
    inlineTextEditor.text = ""
    showInlineTextEditorAndFocus()
  }

  /// Begins editing an EXISTING annotation in place, pre-filled with its
  /// current text. Suppresses it from drawing/hit-testing for the duration
  /// (see AnnotationOverlay.editingTextAnnotationId) so the live editor is
  /// the only visible/interactive copy until commit.
  private func beginInlineTextEditing(_ hit: TextAnnotationHit) {
    inlineTextEditingContext = (id: hit.id, pageNumber: hit.pageNumber, originX: hit.x, originY: hit.y, fontSize: hit.fontSize, width: hit.width)
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
    guard inlineTextEditingContext != nil, !inlineEditorRepositionScheduled else { return }
    inlineEditorRepositionScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.inlineEditorRepositionScheduled = false
      guard self.inlineTextEditingContext != nil else { return }
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
    guard let context = inlineTextEditingContext, let document,
          context.pageNumber >= 1, context.pageNumber <= document.pageCount,
          let page = document.page(at: context.pageNumber - 1)
    else { return }
    let scale = max(0.01, pdfView.scaleFactor)
    let width = CGFloat(context.width) * scale
    let font = UIFont.systemFont(ofSize: CGFloat(context.fontSize) * scale)
    inlineTextEditor.font = font
    let measured = inlineTextEditor.text.isEmpty ? " " : inlineTextEditor.text!
    let fitSize = (measured as NSString).boundingRect(
      with: CGSize(width: width, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: [.font: font],
      context: nil
    ).size
    let height = max(font.lineHeight, ceil(fitSize.height)) + 4
    // Bottom-anchored, matching drawTextAnnotation: the stored (x, y) is the
    // bottom-left of the rendered block, so growth extends the box UPWARD,
    // never moving the anchor the final commit reuses unchanged.
    let origin = pdfView.convert(CGPoint(x: context.originX, y: context.originY), from: page)
    inlineTextEditor.frame = CGRect(x: origin.x, y: origin.y - height, width: width, height: height)
    MaterialTextTrace.log("editor-frame") {
      "id=\(context.id ?? "new") page=\(context.pageNumber) pdfX=\(context.originX) pdfY=\(context.originY) viewX=\(origin.x) viewY=\(origin.y) frame=\(inlineTextEditor.frame) scale=\(scale)"
    }
  }

  /// Commits whatever is currently in the editor (if any is open) and hides
  /// it. A brand-new annotation only emits "create" when non-empty — an
  /// existing one always emits "edit" (even empty), reusing JS's existing,
  /// already-tested edit-vs-delete-on-empty logic. Coordinates are NEVER
  /// recomputed here: the anchor captured at begin-time is reused exactly,
  /// since typing never moves it (see inlineTextEditingContext's doc comment).
  private func commitInlineTextEditorIfNeeded() {
    guard let context = inlineTextEditingContext else { return }
    // Clear ALL state before emitting or resigning first responder.
    // resignFirstResponder() below synchronously triggers
    // textViewDidEndEditing → commitInlineTextEditorIfNeeded again (UIKit
    // re-entrancy) — with inlineTextEditingContext already nil at that
    // point, that re-entrant call's own guard no-ops immediately instead of
    // re-emitting the same action a second time.
    let finalText = (inlineTextEditor.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    inlineTextEditor.isHidden = true
    inlineTextEditor.text = ""
    annotationOverlay.editingTextAnnotationId = nil
    inlineTextEditingContext = nil
    if inlineTextEditor.isFirstResponder { inlineTextEditor.resignFirstResponder() }
    MaterialTextTrace.log(context.id == nil ? "editor-create-commit" : "editor-edit-commit") {
      "id=\(context.id ?? "new") page=\(context.pageNumber) pdfX=\(context.originX) pdfY=\(context.originY) width=\(context.width) font=\(context.fontSize)"
    }
    if let id = context.id {
      onTextAnnotationAction(["action": "edit", "pageNumber": context.pageNumber, "annotationId": id, "text": finalText])
    } else if !finalText.isEmpty {
      onTextAnnotationAction([
        "action": "create", "pageNumber": context.pageNumber, "text": finalText,
        "x": context.originX, "y": context.originY, "width": context.width, "fontSize": context.fontSize
      ])
    }
  }

  @objc private func handleTextDeleteButtonTap() {
    guard let id = selectedTextAnnotationId else { return }
    // If the deleted annotation is the one currently being edited, discard
    // the in-flight edit instead of committing it — deleting supersedes it.
    if inlineTextEditingContext?.id == id {
      inlineTextEditingContext = nil
      inlineTextEditor.isHidden = true
      inlineTextEditor.text = ""
      if inlineTextEditor.isFirstResponder { inlineTextEditor.resignFirstResponder() }
      annotationOverlay.editingTextAnnotationId = nil
    }
    guard let pageNumber = pagedTextAnnotationPageNumber(for: id) else { return }
    onTextAnnotationAction(["action": "delete", "pageNumber": pageNumber, "annotationId": id])
    textDeleteButton.isHidden = true
  }

  private func pagedTextAnnotationPageNumber(for id: String) -> Int? {
    annotationOverlay.pageNumber(forTextAnnotationId: id)
  }

  /// Shows/hides/positions the delete button at the currently SELECTED
  /// annotation's rect (independent of whether it's also being edited).
  /// Called from selectedTextAnnotationId's didSet and from every viewport
  /// change while a selection is active.
  private func repositionTextDeleteButton() {
    guard let id = selectedTextAnnotationId,
          let pageNumber = pagedTextAnnotationPageNumber(for: id),
          let rect = annotationOverlay.textAnnotationRect(id: id, pageNumber: pageNumber),
          let document, let page = document.page(at: pageNumber - 1)
    else {
      textDeleteButton.isHidden = true
      return
    }
    let topRight = pdfView.convert(CGPoint(x: rect.maxX, y: rect.maxY), from: page)
    let size: CGFloat = 26
    textDeleteButton.frame = CGRect(x: topRight.x - size / 2, y: topRight.y - size / 2, width: size, height: size)
    textDeleteButton.isHidden = false
    bringSubviewToFront(textDeleteButton)
  }

  private func presentTextActions(_ annotation: TextAnnotationHit, from source: UIView) {
    let menu = UIAlertController(title: "Text", message: nil, preferredStyle: .actionSheet)
    menu.addAction(UIAlertAction(title: "Move", style: .default) { [weak self] _ in
      self?.pendingTextMove = (annotation.id, annotation.pageNumber)
      self?.onTextAnnotationAction(["action": "move", "pageNumber": annotation.pageNumber, "annotationId": annotation.id])
    })
    menu.addAction(UIAlertAction(title: "Edit", style: .default) { [weak self] _ in
      self?.beginInlineTextEditing(annotation)
    })
    menu.addAction(UIAlertAction(title: "Copy", style: .default) { [weak self] _ in
      UIPasteboard.general.string = annotation.text
      self?.onTextAnnotationAction(["action": "copy", "pageNumber": annotation.pageNumber, "annotationId": annotation.id])
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
    return [
      "id": stroke.id,
      "tool": stroke.tool,
      "color": stroke.color,
      "width": stroke.width,
      "opacity": stroke.opacity,
      "points": stroke.points.map { [$0.x, $0.y] },
      "createdAt": stroke.createdAt
    ]
  }

  private func url(from fileUri: String) -> URL? {
    if fileUri.hasPrefix("file://") { return URL(string: fileUri) }
    return URL(fileURLWithPath: fileUri)
  }
}

// MARK: - UIGestureRecognizerDelegate

extension PdfAnnotationView: UIGestureRecognizerDelegate {
  // Allow our Pencil gesture to recognize simultaneously with PDFView's own
  // pan/pinch — `allowedTouchTypes` on each gesture keeps them from actually
  // competing for the same touch (Pencil → us, finger → PDFView). textDragGesture
  // is the one deliberate exception: once it has decided (via shouldReceive
  // below) to track a touch, PDFView's own pan must NOT also try to scroll
  // using that same touch — that's exactly the "drag must not accidentally
  // scroll the PDF simultaneously" failure mode. Every other pair keeps the
  // original permissive behavior.
  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    if gestureRecognizer === textDragGesture || otherGestureRecognizer === textDragGesture {
      return false
    }
    return true
  }

  // Narrow admission gate for the two new finger gestures — everything else
  // (Pencil drawing, PDFView's own pan/pinch/text-selection) is completely
  // unaffected since this delegate method only governs whether THESE two
  // recognizers see a given touch at all.
  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldReceive touch: UITouch
  ) -> Bool {
    guard gestureRecognizer === textTapGesture || gestureRecognizer === textDragGesture else { return true }
    guard annotationMode == "scroll" || annotationMode == "text" else { return false }
    let point = touch.location(in: pdfView)
    if gestureRecognizer === textTapGesture {
      // The tap handles both "select a text annotation" and, in "text" mode,
      // "create one on empty space" — it always wants the touch while the
      // mode allows it at all.
      return true
    }
    // textDragGesture: only ever receive a touch that starts on the
    // annotation that is ALREADY selected. Anything else — empty space, a
    // different annotation, no selection at all — is left for PDFView's own
    // pan (normal scroll) to handle untouched.
    guard let selectedId = selectedTextAnnotationId,
          let hit = annotationOverlay.textAnnotation(at: point),
          hit.id == selectedId
    else { return false }
    return true
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

/// Each live chunk has at most 32 samples: assigning its CGPath never copies
/// the entire stroke. The parent opacity composites chunk joins uniformly.
final class PageInkStrokeLayer: CALayer {
  private let inkColor: CGColor
  private let inkWidth: CGFloat
  private var chunk = CAShapeLayer()
  private var path = CGMutablePath()
  private var sampleCount = 0
  private var lastPoint: CGPoint?
  private var dot: CAShapeLayer?

  init(color: String, width: Double, opacity: Double) {
    inkColor = (UIColor(annotationHex: color) ?? .black).cgColor
    inkWidth = CGFloat(width)
    super.init()
    self.opacity = Float(opacity)
    allowsGroupOpacity = true
    masksToBounds = false
    startChunk()
  }
  override init(layer: Any) {
    let source = layer as! PageInkStrokeLayer
    inkColor = source.inkColor
    inkWidth = source.inkWidth
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  private func startChunk() {
    chunk = CAShapeLayer()
    chunk.strokeColor = inkColor
    chunk.fillColor = nil
    chunk.lineWidth = inkWidth
    chunk.lineCap = .round
    chunk.lineJoin = .round
    chunk.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull()]
    addSublayer(chunk)
    path = CGMutablePath()
    sampleCount = 0
    if let lastPoint { path.move(to: lastPoint) }
  }

  func append(_ point: CGPoint) {
    if point == lastPoint { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if lastPoint == nil {
      let first = CAShapeLayer()
      first.fillColor = inkColor
      first.path = CGPath(ellipseIn: CGRect(x: point.x - inkWidth / 2, y: point.y - inkWidth / 2,
                                            width: inkWidth, height: inkWidth), transform: nil)
      addSublayer(first)
      dot = first
      path.move(to: point)
    } else {
      if sampleCount >= 32 { startChunk() }
      path.addLine(to: point)
      chunk.path = path
      dot?.removeFromSuperlayer()
      dot = nil
    }
    sampleCount += 1
    lastPoint = point
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

  func render(_ annotations: [TextAnnotation], selectedId: String?) {
    let signature = annotations.map {
      "\($0.id)|\($0.text)|\($0.x)|\($0.y)|\($0.width)|\($0.fontSize)|\(selectedId == $0.id)"
    }.joined(separator: "\u{1f}")
    guard signature != renderedSignature else { return }
    renderedSignature = signature

    sublayers?.forEach { $0.removeFromSuperlayer() }
    for annotation in annotations {
      let font = UIFont.systemFont(ofSize: CGFloat(annotation.fontSize))
      let attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .paragraphStyle: paragraphStyle,
      ]
      let height = (annotation.text as NSString).boundingRect(
        with: CGSize(width: CGFloat(annotation.width), height: .greatestFiniteMagnitude),
        options: [.usesLineFragmentOrigin, .usesFontLeading],
        attributes: attributes,
        context: nil
      ).height
      let frame = CGRect(
        x: annotation.x,
        y: annotation.y - Double(height),
        width: annotation.width,
        height: Double(height) + 4
      )

      if selectedId == annotation.id {
        let selection = CAShapeLayer()
        selection.frame = frame.insetBy(dx: -4, dy: -3)
        selection.path = CGPath(rect: selection.bounds, transform: nil)
        selection.fillColor = UIColor.systemBlue.withAlphaComponent(0.10).cgColor
        selection.strokeColor = UIColor.systemBlue.withAlphaComponent(0.9).cgColor
        selection.lineWidth = 1
        selection.actions = ["path": NSNull(), "position": NSNull(), "bounds": NSNull()]
        addSublayer(selection)
      }

      let text = CATextLayer()
      text.frame = frame
      text.contentsScale = UIScreen.main.scale
      text.foregroundColor = UIColor.label.cgColor
      text.font = font
      text.fontSize = CGFloat(annotation.fontSize)
      text.alignmentMode = .left
      text.truncationMode = .none
      text.isWrapped = true
      text.string = annotation.text
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

  private var paragraphStyle: NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    return style
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
  var selectedTextAnnotationId: String? { didSet { setNeedsDisplay() } }

  /// Purely visual, in-flight drag position for the selected text annotation.
  /// Set for the duration of one drag gesture (PdfAnnotationView.handleTextDrag)
  /// and cleared at drag end — never written into pagedTextAnnotations, so a
  /// mid-drag `annotationsByPage` prop update (or this drag being cancelled)
  /// can never leave a stale coordinate behind. The committed position only
  /// ever changes via the normal loadTextAnnotations path, once JS echoes back
  /// the single "move" mutation this drag emits at `.ended`.
  var liveDraggedTextPosition: (id: String, x: Double, y: Double)? { didSet { setNeedsDisplay() } }

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

  var annotationCount: Int { pagedStrokes.values.reduce(0) { $0 + $1.count } }

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
      let rendered = annotations.compactMap { annotation -> TextAnnotation? in
        guard annotation.id != editingTextAnnotationId else { return nil }
        guard liveDraggedTextPosition?.id == annotation.id else { return annotation }
        return TextAnnotation(
          id: annotation.id,
          text: annotation.text,
          x: liveDraggedTextPosition?.x ?? annotation.x,
          y: liveDraggedTextPosition?.y ?? annotation.y,
          width: annotation.width,
          fontSize: annotation.fontSize
        )
      }
      guard let layer = pageTextLayer(pageNumber) else { continue }
      layer.render(rendered, selectedId: selectedTextAnnotationId)
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

  func appendPoint(at viewPoint: CGPoint) {
    guard let pdfView, let document = pdfView.document else { return }
    guard let pageNumber = inProgressPageNumber else { return }
    guard let page = document.page(at: pageNumber - 1) else { return }
    let pagePoint = pdfView.convert(viewPoint, to: page)
    if inProgressPoints.last == pagePoint { return }
    inProgressPoints.append(pagePoint)
    liveInkLayer?.append(pagePoint)
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
      createdAt: AnnotationOverlay.isoFormatter.string(from: Date())
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
            points: points, createdAt: createdAt
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
         old.width == stroke.width && old.opacity == stroke.opacity && old.tool == stroke.tool { continue }
      savedInkLayers.removeValue(forKey: stroke.id)?.removeFromSuperlayer()
    }
    pagedStrokes = loaded
    setNeedsDisplay()
  }

  func loadTextAnnotations(_ annotationsByPage: [String: Any]?) {
    var loaded: [Int: [TextAnnotation]] = [:]
    for (key, value) in annotationsByPage ?? [:] {
      guard let pageNumber = Int(key), let values = value as? [[String: Any]] else { continue }
      let annotations = values.compactMap { item -> TextAnnotation? in
        guard let id = item["id"] as? String, let text = item["text"] as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let x = AnnotationOverlay.coerceDouble(item["x"]), let y = AnnotationOverlay.coerceDouble(item["y"])
        else { return nil }
        return TextAnnotation(id: id, text: text, x: x, y: y,
          width: max(40, AnnotationOverlay.coerceDouble(item["width"]) ?? 180),
          fontSize: max(8, AnnotationOverlay.coerceDouble(item["fontSize"]) ?? 16))
      }
      if !annotations.isEmpty { loaded[pageNumber] = annotations }
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
      let height = annotation.estimatedHeight
      if CGRect(x: annotation.x, y: annotation.y - height, width: annotation.width, height: height + 8).contains(pagePoint) {
        return TextAnnotationHit(
          id: annotation.id, text: annotation.text, pageNumber: pageNumber,
          x: annotation.x, y: annotation.y, width: annotation.width, fontSize: annotation.fontSize
        )
      }
    }
    return nil
  }

  /// Which page a given text annotation id currently lives on — used by the
  /// delete button/inline editor to resolve page context from just an id
  /// (e.g. after a selection round-trip), without a screen-point hit-test.
  func pageNumber(forTextAnnotationId id: String) -> Int? {
    for (pageNumber, annotations) in pagedTextAnnotations where annotations.contains(where: { $0.id == id }) {
      return pageNumber
    }
    return nil
  }

  /// Current PDF-page-space rect for a text annotation, in the SAME
  /// (x, y - height, width, height + 8) convention textAnnotation(at:) hit-
  /// tests against — used to position the delete button at its actual
  /// on-screen bounds.
  func textAnnotationRect(id: String, pageNumber: Int) -> CGRect? {
    guard let annotation = pagedTextAnnotations[pageNumber]?.first(where: { $0.id == id }) else { return nil }
    let height = annotation.estimatedHeight
    return CGRect(x: annotation.x, y: annotation.y - height, width: annotation.width, height: height + 8)
  }

  // MARK: - Drawing

  override func draw(_ rect: CGRect) {
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

  private static func coerceDouble(_ value: Any?) -> Double? {
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

struct AnnotationStroke {
  let id: String
  let tool: String
  let color: String
  let width: Double
  let opacity: Double
  let points: [CGPoint]
  let createdAt: String
}

struct TextAnnotation: Equatable {
  let id: String
  let text: String
  let x: Double
  let y: Double
  let width: Double
  let fontSize: Double
  var estimatedHeight: Double { max(fontSize * 1.5, ceil(Double(text.count) / max(1, width / (fontSize * 0.55))) * fontSize * 1.35) }
}

struct TextAnnotationHit {
  let id: String
  let text: String
  let pageNumber: Int
  /// Current PDF-page-space origin, carried through so a drag's `.began` can
  /// anchor on it directly instead of a second lookup back into pagedTextAnnotations.
  let x: Double
  let y: Double
  /// Carried through so the inline editor can be sized/positioned identically
  /// to how this annotation currently renders — no second lookup needed.
  let width: Double
  let fontSize: Double
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
