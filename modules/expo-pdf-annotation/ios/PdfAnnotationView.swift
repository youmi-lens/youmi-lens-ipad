import ExpoModulesCore
import PDFKit
import UIKit

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

  private var document: PDFDocument?
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

  let onPageChanged = EventDispatcher()
  let onLoadComplete = EventDispatcher()
  let onError = EventDispatcher()
  let onAnnotationsChanged = EventDispatcher()
  let onEraserGestureEnded = EventDispatcher()

  var fileUri: String? {
    didSet { if fileUri != oldValue { loadDocumentIfNeeded() } }
  }

  var initialPage: Int = 1 {
    didSet { if initialPage != oldValue { applyInitialPageIfPossible() } }
  }

  /// "scroll", "pen", "highlighter", or "eraser". Forwarded into the overlay's rendering mode AND
  /// flips the Pencil gesture + PDFView's pan-touch-type restriction.
  var annotationMode: String = "scroll" {
    didSet {
      if annotationMode != oldValue {
        annotationOverlay.mode = annotationMode
        updateGestureMode()
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
    didSet { annotationOverlay.loadAnnotations(annotationsByPage) }
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

    // Attach Pencil-only gesture recognizer to PDFView. allowedTouchTypes
    // is the OS-level filter that actually works (vs the hitTest dance).
    pdfView.addGestureRecognizer(pencilGesture)
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
    super.layoutSubviews()
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
    annotationOverlay.setNeedsDisplay()
  }

  /// Apply the scale window for the current bounds.
  ///
  ///   - `forceFit == true` (initial document load): set scaleFactor = page-fit.
  ///   - `forceFit == false` (on size change): leave the user's manual scale
  ///     alone unless it's now outside the new [min, max] window, in which
  ///     case clamp it. PDFView's own pinch state is preserved otherwise.
  private func applyScaleSettings(forceFit: Bool) {
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
      self.goToPage(pageNumber)
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

      self.document = pdfDocument
      self.loadedFileUri = fileUri
      self.hasAppliedInitialPage = false
      self.lastEmittedPage = nil
      self.pdfView.document = pdfDocument
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
      self.onLoadComplete(["totalPages": pdfDocument.pageCount])
      self.emitCurrentPage()
    }
  }

  private func applyInitialPageIfPossible() {
    guard !hasAppliedInitialPage else { return }
    guard document != nil else { return }
    hasAppliedInitialPage = true
    goToPage(initialPage)
  }

  private func goToPage(_ pageNumber: Int) {
    guard let document else { return }
    let clampedPage = max(1, min(pageNumber, document.pageCount))
    guard let page = document.page(at: clampedPage - 1) else { return }
    pdfView.go(to: page)
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
      let p = recognizer.location(in: pdfView)
      let overlayPoint = recognizer.location(in: annotationOverlay)
      #if DEBUG
      print("[PdfAnnotationView] pencil .began at pdfViewPoint=\(p)")
      #endif
      if annotationMode == "eraser" {
        #if DEBUG
        print("[PdfAnnotationView] eraser began location=\(p) overlayLocation=\(overlayPoint)")
        #endif
        // The erase hit-test uses PDFView coordinates, while the preview is
        // drawn directly by the overlay in its own coordinate space.
        annotationOverlay.showEraserPreview(at: overlayPoint)
        if let replacement = annotationOverlay.eraseStroke(at: p) {
          emitPageReplacement(replacement.strokes, pageNumber: replacement.pageNumber)
        }
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
        #if DEBUG
        print("[PdfAnnotationView] eraser changed location=\(p) overlayLocation=\(overlayPoint)")
        #endif
        annotationOverlay.showEraserPreview(at: overlayPoint)
        if let replacement = annotationOverlay.eraseStroke(at: p) {
          emitPageReplacement(replacement.strokes, pageNumber: replacement.pageNumber)
        }
      } else {
        annotationOverlay.appendPoint(at: p)
      }

    case .ended:
      if annotationMode == "eraser" {
        #if DEBUG
        print("[PdfAnnotationView] eraser ended")
        #endif
        annotationOverlay.cancelStroke()
        annotationOverlay.hideEraserPreview()
        emitEraserGestureEnded(at: recognizer.location(in: pdfView))
      } else if let commit = annotationOverlay.endStroke() {
        #if DEBUG
        print("[PdfAnnotationView] pencil .ended commit page=\(commit.pageNumber) points=\(commit.stroke.points.count)")
        #endif
        emitStrokeCommitted(commit.stroke, pageNumber: commit.pageNumber)
      } else {
        #if DEBUG
        print("[PdfAnnotationView] pencil .ended NO commit (empty stroke)")
        #endif
      }

    case .cancelled, .failed:
      if annotationMode == "eraser" {
        #if DEBUG
        print("[PdfAnnotationView] eraser ended state=\(recognizer.state.rawValue)")
        #endif
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
    emitCurrentPage()
    annotationOverlay.setNeedsDisplay()
  }

  @objc private func handleAnnotationLayoutChange() {
    annotationOverlay.setNeedsDisplay()
  }

  private func startObservingScroll() {
    guard observedScrollView == nil else { return }
    if let scroll = findInnerScrollView(in: pdfView) {
      scroll.addObserver(self, forKeyPath: "bounds", options: [.new], context: nil)
      scroll.addObserver(self, forKeyPath: "contentOffset", options: [.new], context: nil)
      observedScrollView = scroll
      applyWorkspaceCanvasColors()
    }
  }

  private func stopObservingScroll() {
    if let scroll = observedScrollView {
      scroll.removeObserver(self, forKeyPath: "bounds")
      scroll.removeObserver(self, forKeyPath: "contentOffset")
    }
    observedScrollView = nil
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
  }

  // MARK: - Event helpers

  private func emitCurrentPage() {
    guard let document, let currentPage = pdfView.currentPage else { return }
    let pageNumber = document.index(for: currentPage) + 1
    guard pageNumber > 0 else { return }
    if lastEmittedPage == pageNumber { return }
    lastEmittedPage = pageNumber
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
  // competing for the same touch (Pencil → us, finger → PDFView).
  public func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    return true
  }
}

// MARK: - PencilDrawGestureRecognizer

/// Pencil-only gesture recognizer. `allowedTouchTypes = [.pencil]` is the
/// OS-level filter that reliably routes only Apple Pencil touches to us.
final class PencilDrawGestureRecognizer: UIGestureRecognizer {
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
    #if DEBUG
    print("[PencilDrawGestureRecognizer] touchesBegan touch.type=\(touch.type.rawValue) (.pencil=\(UITouch.TouchType.pencil.rawValue))")
    #endif
    state = .began
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesMoved(touches, with: event)
    guard state == .began || state == .changed else { return }
    guard let touch = touches.first, touch.type == .pencil else { return }
    state = .changed
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesEnded(touches, with: event)
    state = (state == .began || state == .changed) ? .ended : .failed
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesCancelled(touches, with: event)
    state = .cancelled
  }
}

// MARK: - AnnotationOverlay (pure rendering)

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

  // In-progress stroke state.
  private var inProgressStrokeId: String?
  private var inProgressPageNumber: Int?
  private var inProgressPoints: [CGPoint] = []
  private var inProgressTool: String = "pen"
  private var inProgressColor: String = "#061B34"
  private var inProgressWidth: Double = 2.4
  private var inProgressOpacity: Double = 1

  /// Eraser cursor — current Pencil location in overlay coordinates. Drawn as
  /// a circular outline on top of the ink so the user can see where the
  /// eraser is and how large its hit area is. Pure presentation: never
  /// persisted, never emitted to JS, never read by the eraser hit-test path.
  private var eraserPreviewPoint: CGPoint?

  init(pdfView: PDFView) {
    self.pdfView = pdfView
    super.init(frame: .zero)
    isOpaque = false
    isUserInteractionEnabled = false   // pure rendering
    contentScaleFactor = UIScreen.main.scale
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

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
    #if DEBUG
    print("[AnnotationOverlay] beginStroke page=\(pageNumber) viewPoint=\(viewPoint) pagePoint=\(pagePoint)")
    #endif
    setNeedsDisplay()
  }

  func appendPoint(at viewPoint: CGPoint) {
    guard let pdfView, let document = pdfView.document else { return }
    guard let pageNumber = inProgressPageNumber else { return }
    guard let page = document.page(at: pageNumber - 1) else { return }
    let pagePoint = pdfView.convert(viewPoint, to: page)
    inProgressPoints.append(pagePoint)
    setNeedsDisplay()
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
    clearInProgress()
    setNeedsDisplay()
    return (stroke, pageNumber)
  }

  func cancelStroke() {
    clearInProgress()
    setNeedsDisplay()
  }

  private func clearInProgress() {
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
    #if DEBUG
    print("[AnnotationOverlay] showEraserPreview point=\(viewPoint) radius=\(eraserRadius) bounds=\(bounds) hidden=\(isHidden) alpha=\(alpha)")
    #endif
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

  func eraseStroke(at viewPoint: CGPoint) -> (pageNumber: Int, strokes: [AnnotationStroke])? {
    guard let pdfView, let document = pdfView.document else { return nil }
    guard let page = pdfView.page(for: viewPoint, nearest: true) else { return nil }
    let pageNumber = document.index(for: page) + 1
    guard pageNumber > 0, var strokes = pagedStrokes[pageNumber], !strokes.isEmpty else { return nil }

    let radius = CGFloat(max(4, eraserRadius))
    guard let eraseIndex = strokes.lastIndex(where: { stroke in
      strokeHitsEraser(stroke, page: page, eraserPoint: viewPoint, radius: radius)
    }) else {
      return nil
    }

    strokes.remove(at: eraseIndex)
    pagedStrokes[pageNumber] = strokes
    setNeedsDisplay()
    return (pageNumber, strokes)
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
    pagedStrokes = loaded
    setNeedsDisplay()
  }

  // MARK: - Drawing

  override func draw(_ rect: CGRect) {
    guard let ctx = UIGraphicsGetCurrentContext(),
          let pdfView,
          let document = pdfView.document
    else { return }

    for (pageNumber, strokes) in pagedStrokes {
      guard pageNumber > 0, pageNumber <= document.pageCount,
            let page = document.page(at: pageNumber - 1)
      else { continue }
      for stroke in strokes where stroke.tool == "highlighter" {
        drawStroke(stroke, page: page, in: ctx)
      }
      for stroke in strokes where stroke.tool != "highlighter" {
        drawStroke(stroke, page: page, in: ctx)
      }
    }

    if let pageNumber = inProgressPageNumber,
       !inProgressPoints.isEmpty,
       let page = document.page(at: pageNumber - 1) {
      let live = AnnotationStroke(
        id: inProgressStrokeId ?? "live",
        tool: inProgressTool,
        color: inProgressColor,
        width: inProgressWidth,
        opacity: inProgressOpacity,
        points: inProgressPoints,
        createdAt: ""
      )
      drawStroke(live, page: page, in: ctx)
    }

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
    eraserPoint: CGPoint,
    radius: CGFloat
  ) -> Bool {
    guard let pdfView, !stroke.points.isEmpty else { return false }
    let viewPoints = stroke.points.map { pdfView.convert($0, from: page) }
    let strokeHalfWidth = max(1, CGFloat(stroke.width) * pdfView.scaleFactor / 2)
    let threshold = radius + strokeHalfWidth

    if viewPoints.count == 1 {
      return AnnotationOverlay.distance(eraserPoint, viewPoints[0]) <= threshold
    }

    for i in 0..<(viewPoints.count - 1) {
      if AnnotationOverlay.distanceFromPoint(eraserPoint, toSegmentStart: viewPoints[i], end: viewPoints[i + 1]) <= threshold {
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
