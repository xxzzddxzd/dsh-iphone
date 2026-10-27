import Foundation

enum DSHNavigation {
  static func isNativeSessionURL(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == "dshmobile", url.host?.lowercased() == "session",
      url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/",
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      items.count == 2, Set(items.map(\.name)) == Set(["gateway", "id"]),
      let gateway = items.first(where: { $0.name == "gateway" })?.value,
      UUID(uuidString: gateway) != nil,
      let session = items.first(where: { $0.name == "id" })?.value,
      session.range(of: "^[A-Za-z0-9._:-]{1,512}$", options: .regularExpression) != nil
    else { return false }
    return true
  }
}
