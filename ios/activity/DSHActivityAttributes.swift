import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct DSHActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var sessionID: String
    var title: String
    var phase: String
    var detail: String
    var startedAtMilliseconds: Int64
    var step: Int
    var completedItems: Int
    var totalItems: Int
    var waitingForUser: Bool
  }

  var source: String
}
