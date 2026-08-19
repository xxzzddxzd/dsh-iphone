import Darwin
import Dispatch
import UIKit

// ActivityKit may briefly wake the containing application when a Live Activity
// ends. The real lifecycle owner is DSHActivityOp; this hidden container must
// never compete with the launchd broker for its socket or present UI. When the
// user taps a Live Activity, however, WidgetKit launches this container with the
// widget URL. Hand that URL to the default browser before exiting.
@main
private final class DSHActivityApplicationDelegate: UIResponder, UIApplicationDelegate {
  private var pendingExit: DispatchWorkItem?

  private func scheduleExit(after delay: TimeInterval) {
    pendingExit?.cancel()
    let work = DispatchWorkItem {
      Darwin.exit(0)
    }
    pendingExit = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func isAllowedBrowserURL(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
      return false
    }
    guard let host = url.host?.lowercased(), host == "127.0.0.1" || host == "localhost" else {
      return false
    }
    guard url.port == nil || url.port == 3080 else {
      return false
    }
    return URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?
      .contains(where: { $0.name == "session" && !($0.value ?? "").isEmpty }) == true
  }

  private func openInDefaultBrowser(_ url: URL, application: UIApplication) -> Bool {
    guard isAllowedBrowserURL(url) else {
      NSLog("[DSHActivityHost] rejected invalid Live Activity URL: %@", url.absoluteString)
      scheduleExit(after: 0.1)
      return false
    }

    pendingExit?.cancel()
    NSLog("[DSHActivityHost] forwarding Live Activity URL: %@", url.absoluteString)
    // Arm the fallback first. If UIKit invokes its completion synchronously,
    // the shorter completion exit must remain the last scheduled work item.
    scheduleExit(after: 5)
    application.open(url, options: [:]) { [weak self] accepted in
      NSLog(
        "[DSHActivityHost] default browser open %@: %@",
        accepted ? "accepted" : "rejected",
        url.absoluteString)
      self?.scheduleExit(after: 0.2)
    }
    // UIKit normally calls the completion handler immediately after handing the
    // URL to its target. Keep a bounded fallback in case that callback is lost.
    return true
  }

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL {
      _ = openInDefaultBrowser(url, application: application)
    } else {
      // URL delivery can follow didFinishLaunching. Leave a short window for
      // application(_:open:options:) before treating this as a background wake.
      scheduleExit(after: 2)
    }
    return true
  }

  func application(
    _ application: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    openInDefaultBrowser(url, application: application)
  }

  func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard let url = userActivity.webpageURL else {
      scheduleExit(after: 0.1)
      return false
    }
    return openInDefaultBrowser(url, application: application)
  }
}
