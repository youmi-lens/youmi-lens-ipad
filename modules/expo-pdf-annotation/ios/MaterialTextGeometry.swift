import UIKit
import PDFKit

/// One PDF-page-space box for editor, committed text, hit-testing and export.
/// PDF Y grows up; UIKit glyph Y grows down. This controls geometry, not glyph flips.
enum MaterialTextGeometry {
  static let defaultFontSize: CGFloat = 16

  static func editorPlacement(rect: CGRect, page: PDFPage, pdfView: PDFView,
                              container: UIView) -> (center: CGPoint, transform: CGAffineTransform) {
    func mapped(_ point: CGPoint) -> CGPoint {
      container.convert(pdfView.convert(point, from: page), from: pdfView)
    }
    let origin = mapped(.zero)
    let xBasis = mapped(CGPoint(x: 1, y: 0))
    let yBasis = mapped(CGPoint(x: 0, y: 1))
    return (mapped(CGPoint(x: rect.midX, y: rect.midY)), CGAffineTransform(
      a: xBasis.x - origin.x, b: xBasis.y - origin.y,
      c: origin.x - yBasis.x, d: origin.y - yBasis.y, tx: 0, ty: 0
    ))
  }

  static func attributes(fontSize: Double) -> [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byWordWrapping
    return [.font: UIFont.systemFont(ofSize: CGFloat(fontSize)),
            .foregroundColor: UIColor.label, .paragraphStyle: paragraph]
  }

  static func pageRect(text: String, x: Double, y: Double, width: Double,
                       fontSize: Double, anchor: String?) -> CGRect {
    let font = UIFont.systemFont(ofSize: CGFloat(fontSize))
    let measured = (text.isEmpty ? " " : text) as NSString
    let height = max(font.lineHeight, measured.boundingRect(
      with: CGSize(width: width, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      attributes: attributes(fontSize: fontSize), context: nil
    ).height) + 4
    // New taps are the TOP-left of content. Unmarked saved annotations retain
    // their existing BOTTOM-left anchor and exact x/y; no migration or Y offset.
    return CGRect(x: x, y: anchor == "top-left" ? y - Double(height) : y,
                  width: width, height: height)
  }
}
