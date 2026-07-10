import ExpoModulesCore
import UIKit

public final class ExpoNativeWordLookupModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoNativeWordLookup")

    Function("isAvailable") { () -> Bool in
      true
    }

    AsyncFunction("openAsync") { (rawTerm: String) -> Bool in
      let term = rawTerm.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !term.isEmpty else { return false }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        return false
      }

      let lookupController = UIReferenceLibraryViewController(term: term)
      lookupController.modalPresentationStyle = .pageSheet

      if let popover = lookupController.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(
          x: presenter.view.bounds.midX,
          y: presenter.view.bounds.midY,
          width: 0,
          height: 0
        )
        popover.permittedArrowDirections = []
      }

      presenter.present(lookupController, animated: true)
      return true
    }.runOnQueue(.main)
  }
}
