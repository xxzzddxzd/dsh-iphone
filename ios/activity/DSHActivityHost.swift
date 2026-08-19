import Darwin
import Dispatch
import UIKit

// ActivityKit may briefly wake the containing application when a Live Activity
// ends. The real lifecycle owner is DSHActivityOp; this hidden container must
// never compete with the launchd broker for its socket or present UI.
@main
private final class DSHActivityApplicationDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    DispatchQueue.main.async {
      Darwin.exit(0)
    }
    return true
  }
}
