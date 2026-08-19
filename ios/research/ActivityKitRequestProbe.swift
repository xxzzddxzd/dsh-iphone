import ActivityKit
import Foundation

private func describeError(_ error: Error) -> String {
  let nsError = error as NSError
  var lines = [
    "error=\(String(reflecting: error))",
    "domain=\(nsError.domain) code=\(nsError.code)",
    "userInfo=\(nsError.userInfo)",
  ]
  if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
    lines.append(
      "underlying domain=\(underlying.domain) code=\(underlying.code) " +
      "userInfo=\(underlying.userInfo)")
  }
  return lines.joined(separator: "\n")
}

@main
private struct ActivityKitRequestProbe {
  static func main() async {
    print("pid=\(ProcessInfo.processInfo.processIdentifier)")
    print("bundlePath=\(Bundle.main.bundlePath)")
    print("bundleIdentifier=\(Bundle.main.bundleIdentifier ?? "(nil)")")
    guard #available(iOS 16.1, *) else {
      print("ActivityKit unavailable")
      return
    }
    do {
      let activity = try Activity<DSHActivityAttributes>.request(
        attributes: .init(source: "session-assertion-probe"),
        contentState: .init(
          sessionID: "session-assertion-probe",
          title: "DSH private ActivityKit probe",
          phase: "running",
          detail: "SpringBoard-targeted request assertion",
          startedAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000),
          step: 1,
          agentCount: 1,
          completedItems: 0,
          totalItems: 1,
          waitingForUser: false),
        pushType: nil)
      print("created=\(activity.id)")
      await activity.end(using: nil, dismissalPolicy: .immediate)
      print("ended=\(activity.id)")
    } catch {
      print(describeError(error))
    }
  }
}
