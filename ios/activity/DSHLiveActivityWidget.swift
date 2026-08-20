import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

private let dshActivityLabelWidth: CGFloat = 30

@available(iOS 16.1, *)
private func dshMarkdownText(_ source: String) -> AttributedString {
  let fallback = source
    .replacingOccurrences(of: "**", with: "")
    .replacingOccurrences(of: "__", with: "")
    .replacingOccurrences(of: "~~", with: "")
    .replacingOccurrences(of: "`", with: "")
  return (try? AttributedString(
    markdown: source,
    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
    ?? AttributedString(fallback)
}

@available(iOS 16.1, *)
private struct DSHMarkdownText: View {
  let text: String

  var body: some View {
    Text(dshMarkdownText(text.isEmpty ? "—" : text))
  }
}

@available(iOS 16.1, *)
private func dshStartedAt(_ state: DSHActivityAttributes.ContentState) -> Date {
  Date(timeIntervalSince1970: Double(state.startedAtMilliseconds) / 1_000)
}

@available(iOS 16.1, *)
private func dshElapsedText(_ state: DSHActivityAttributes.ContentState) -> String {
  let elapsed = max(
    0,
    (state.finishedAtMilliseconds - state.startedAtMilliseconds) / 1_000)
  if elapsed >= 3_600 {
    return String(format: "%lld:%02lld:%02lld", elapsed / 3_600, (elapsed / 60) % 60, elapsed % 60)
  }
  return String(format: "%lld:%02lld", elapsed / 60, elapsed % 60)
}

@available(iOS 16.1, *)
private func dshActivityTint(_ state: DSHActivityAttributes.ContentState) -> Color {
  if state.finishedAtMilliseconds > 0 {
    switch state.phase {
    case "已完成": return .green
    case "运行失败": return .red
    default: return .orange
    }
  }
  return state.waitingForUser ? .orange : .blue
}

@available(iOS 16.1, *)
private struct DSHWhale: View {
  var size: CGFloat = 34

  var body: some View {
    Image("DSHWhale", bundle: .main)
      .resizable()
      .scaledToFit()
      .frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
  }
}

@available(iOS 16.1, *)
private struct DSHAgentDotsRing: View {
  let state: DSHActivityAttributes.ContentState

  private var startedAt: Date {
    dshStartedAt(state)
  }

  private var tint: Color {
    dshActivityTint(state)
  }

  private var visibleAgentCount: Int {
    min(max(state.agentCount, 1), 24)
  }

  private var dotSize: CGFloat {
    switch visibleAgentCount {
    case 1...8: return 5
    case 9...16: return 4
    default: return 3
    }
  }

  var body: some View {
    ZStack {
      Circle()
        .stroke(Color.secondary.opacity(0.12), lineWidth: 1)
        .frame(width: 40, height: 40)
      ForEach(0..<visibleAgentCount, id: \.self) { index in
        Circle()
          .fill(tint)
          .frame(width: dotSize, height: dotSize)
          .offset(y: -20)
          .rotationEffect(
            .degrees(Double(index) * 360 / Double(visibleAgentCount)))
      }
      if state.finishedAtMilliseconds > 0 {
        Text(dshElapsedText(state))
          .font(.system(size: 10, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .minimumScaleFactor(0.58)
          .lineLimit(1)
          .frame(width: 40, height: 40, alignment: .center)
      } else {
        Text(startedAt, style: .timer)
          .font(.system(size: 10, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .multilineTextAlignment(.center)
          .lineLimit(1)
          .minimumScaleFactor(0.58)
          .frame(width: 40, height: 40, alignment: .center)
      }
    }
    .frame(width: 48, height: 48)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(max(state.agentCount, 1)) 个 Agent，执行时长")
  }
}

@available(iOS 16.1, *)
private struct DSHProgressDetailBlock: View {
  let text: String
  let hasGoal: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 6) {
      Text("进展")
        .font(.system(size: 8, weight: .bold, design: .rounded))
        .foregroundColor(.blue)
        .frame(width: dshActivityLabelWidth, alignment: .leading)
      DSHMarkdownText(text: text)
        .font(.system(size: 10.5))
        .foregroundColor(.secondary)
        .multilineTextAlignment(.leading)
        .lineLimit(hasGoal ? 3 : 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(
      maxWidth: .infinity,
      minHeight: hasGoal ? 42 : 54,
      alignment: .topLeading)
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(Color.blue.opacity(0.07)))
  }
}

@available(iOS 16.1, *)
private struct DSHGoalDetailRow: View {
  let text: String

  var body: some View {
    HStack(spacing: 6) {
      Text("GOAL")
        .font(.system(size: 8, weight: .bold, design: .rounded))
        .foregroundColor(.green)
        .frame(width: dshActivityLabelWidth, alignment: .leading)
      Text(text)
        .font(.system(size: 10.5, weight: .medium))
        .foregroundColor(.secondary)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(Color.green.opacity(0.07)))
  }
}

@available(iOS 16.1, *)
private struct DSHToolDetailRow: View {
  let text: String
  let tint: Color
  let actionLabel: String?

  var body: some View {
    HStack(spacing: 6) {
      Text("TOOL")
        .font(.system(size: 8, weight: .bold, design: .rounded))
        .foregroundColor(tint)
        .frame(width: dshActivityLabelWidth, alignment: .leading)
      Text(text.isEmpty ? "—" : text)
        .font(.system(size: 10.5))
        .foregroundColor(.secondary)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let actionLabel {
        Text(actionLabel)
          .font(.system(size: 9, weight: .semibold, design: .rounded))
          .foregroundColor(tint)
          .lineLimit(1)
          .padding(.horizontal, 6)
          .padding(.vertical, 3)
          .background(Capsule().fill(tint.opacity(0.12)))
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(tint.opacity(0.07)))
  }
}

@available(iOS 16.1, *)
private struct DSHActivityLockScreenView: View {
  let context: ActivityViewContext<DSHActivityAttributes>

  private var isFinished: Bool {
    context.state.finishedAtMilliseconds > 0
  }

  private var statusText: String {
    let phase = context.state.phase.trimmingCharacters(in: .whitespacesAndNewlines)
    if !phase.isEmpty { return phase }
    if isFinished { return "已结束" }
    return context.state.waitingForUser ? "待确认" : "运行中"
  }

  private var statusColor: Color {
    if isFinished || context.state.waitingForUser {
      return dshActivityTint(context.state)
    }
    return .secondary
  }

  private var actionLabel: String? {
    if context.state.waitingForUser { return "打开处理" }
    if isFinished { return "查看结果" }
    return nil
  }

  private var sessionURL: URL? {
    var components = URLComponents(string: "http://127.0.0.1:3080/")
    components?.queryItems = [URLQueryItem(name: "session", value: context.state.sessionID)]
    return components?.url
  }

  private var hasGoal: Bool {
    !context.state.goalDetail.isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .center, spacing: 8) {
        DSHWhale(size: 32)
        Text(context.state.title)
          .font(.headline)
          .lineLimit(1)
          .layoutPriority(1)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(statusText)
          .font(.caption2.weight(.semibold))
          .foregroundColor(statusColor)
          .lineLimit(1)
      }

      HStack(spacing: 8) {
        DSHAgentDotsRing(state: context.state)
        VStack(spacing: 4) {
          if hasGoal {
            DSHGoalDetailRow(text: context.state.goalDetail)
          }
          DSHProgressDetailBlock(
            text: context.state.detail,
            hasGoal: hasGoal)
          DSHToolDetailRow(
            text: context.state.toolDetail,
            tint: isFinished || context.state.waitingForUser
              ? dshActivityTint(context.state)
              : .purple,
            actionLabel: actionLabel)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .activityBackgroundTint(Color(white: 0.98))
    .activitySystemActionForegroundColor(.black)
    .widgetURL(sessionURL)
  }
}

@main
@available(iOS 16.1, *)
struct DSHLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: DSHActivityAttributes.self) { context in
      DSHActivityLockScreenView(context: context)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          DSHWhale(size: 28)
        }
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 2) {
            Text(context.state.title).font(.caption.weight(.semibold)).lineLimit(1)
            Text(context.state.phase).font(.caption2).lineLimit(1)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          if context.state.finishedAtMilliseconds > 0 {
            Text(dshElapsedText(context.state)).font(.caption2.monospacedDigit())
          } else {
            Text(dshStartedAt(context.state), style: .timer)
              .font(.caption2.monospacedDigit())
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 2) {
            if !context.state.goalDetail.isEmpty {
              Text("G  \(context.state.goalDetail)").font(.caption2).lineLimit(1)
            }
            HStack(alignment: .top, spacing: 4) {
              Text("进展")
              DSHMarkdownText(text: context.state.detail)
            }
            .font(.caption2)
            .lineLimit(2)
            Text("T  \(context.state.toolDetail)").font(.caption2).lineLimit(1)
          }
        }
      } compactLeading: {
        DSHWhale(size: 20)
      } compactTrailing: {
        if context.state.finishedAtMilliseconds > 0 {
          Text(dshElapsedText(context.state)).font(.caption2)
        } else {
          Text(dshStartedAt(context.state), style: .timer).font(.caption2)
        }
      } minimal: {
        DSHWhale(size: 18)
      }
      .keylineTint(.black)
    }
  }
}
