import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct DSHActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var sessionID: String
    var title: String
    var phase: String
    var detail: String
    var goalDetail: String
    var assistantDetail: String
    var toolDetail: String
    var startedAtMilliseconds: Int64
    var finishedAtMilliseconds: Int64
    var step: Int
    var agentCount: Int
    var completedItems: Int
    var totalItems: Int
    var waitingForUser: Bool
  }

  var source: String
}
