import ExpoModulesCore

public final class ExpoPdfAnnotationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoPdfAnnotation")

    View(PdfAnnotationView.self) {
      Events(
        "onPageChanged",
        "onLoadComplete",
        "onError",
        "onAnnotationsChanged",
        "onEraserGestureEnded"
      )

      Prop("fileUri") { (view: PdfAnnotationView, fileUri: String?) in
        view.fileUri = fileUri
      }

      Prop("initialPage") { (view: PdfAnnotationView, initialPage: Int?) in
        view.initialPage = initialPage ?? 1
      }

      Prop("annotationMode") { (view: PdfAnnotationView, mode: String?) in
        view.annotationMode = mode ?? "scroll"
      }

      Prop("penColor") { (view: PdfAnnotationView, color: String?) in
        view.penColor = color ?? "#061B34"
      }

      Prop("penWidth") { (view: PdfAnnotationView, width: Double?) in
        view.penWidth = width ?? 2.4
      }

      Prop("highlighterColor") { (view: PdfAnnotationView, color: String?) in
        view.highlighterColor = color ?? "#FFE066"
      }

      Prop("highlighterWidth") { (view: PdfAnnotationView, width: Double?) in
        view.highlighterWidth = width ?? 18
      }

      Prop("eraserRadius") { (view: PdfAnnotationView, radius: Double?) in
        view.eraserRadius = radius ?? 26
      }

      Prop("annotationsByPage") { (view: PdfAnnotationView, value: [String: Any]?) in
        view.annotationsByPage = value
      }

      AsyncFunction("setPageAsync") { (view: PdfAnnotationView, pageNumber: Int) in
        view.setPage(pageNumber)
      }
    }
  }
}
