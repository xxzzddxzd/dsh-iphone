import ActivityKit
import SwiftUI
import WidgetKit

@available(iOS 16.1, *)
private func dshStartedAt(_ state: DSHActivityAttributes.ContentState) -> Date {
  Date(timeIntervalSince1970: Double(state.startedAtMilliseconds) / 1_000)
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
    state.waitingForUser ? .orange : .blue
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
      Text(startedAt, style: .timer)
        .font(.system(size: 10, weight: .semibold, design: .rounded))
        .monospacedDigit()
        .multilineTextAlignment(.center)
        .lineLimit(1)
        .minimumScaleFactor(0.58)
        .frame(width: 40, height: 40, alignment: .center)
    }
    .frame(width: 48, height: 48)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(max(state.agentCount, 1)) 个 Agent，执行时长")
  }
}

@available(iOS 16.1, *)
private struct DSHActivityDetailRow: View {
  let label: String
  let text: String
  let tint: Color

  var body: some View {
    HStack(spacing: 6) {
      Text(label)
        .font(.system(size: 8, weight: .bold, design: .rounded))
        .foregroundColor(tint)
        .frame(width: 52, alignment: .leading)
      Text(text.isEmpty ? "—" : text)
        .font(.caption)
        .foregroundColor(.secondary)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(tint.opacity(0.07)))
  }
}

@available(iOS 16.1, *)
private struct DSHActivityLockScreenView: View {
  let context: ActivityViewContext<DSHActivityAttributes>

  private var sessionURL: URL? {
    var components = URLComponents(string: "http://127.0.0.1:3080/")
    components?.queryItems = [URLQueryItem(name: "session", value: context.state.sessionID)]
    return components?.url
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        DSHWhale()
        VStack(alignment: .leading, spacing: 2) {
          Text(context.state.title)
            .font(.headline)
            .lineLimit(1)
          Text(context.state.phase)
            .font(.subheadline.weight(.medium))
            .foregroundColor(context.state.waitingForUser ? .orange : .secondary)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        Text(context.state.waitingForUser ? "待确认" : "运行中")
          .font(.caption2)
          .foregroundColor(context.state.waitingForUser ? .orange : .secondary)
          .lineLimit(1)
      }

      HStack(spacing: 8) {
        DSHAgentDotsRing(state: context.state)
        VStack(spacing: 4) {
          DSHActivityDetailRow(
            label: "ASSISTANT",
            text: context.state.assistantDetail,
            tint: .blue)
          DSHActivityDetailRow(
            label: "TOOL",
            text: context.state.toolDetail,
            tint: context.state.waitingForUser ? .orange : .purple)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(14)
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
          Text(
            dshStartedAt(context.state),
            style: .timer)
            .font(.caption2.monospacedDigit())
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 2) {
            Text("A  \(context.state.assistantDetail)").font(.caption2).lineLimit(1)
            Text("T  \(context.state.toolDetail)").font(.caption2).lineLimit(1)
          }
        }
      } compactLeading: {
        DSHWhale(size: 20)
      } compactTrailing: {
        Text(
          dshStartedAt(context.state),
          style: .timer)
          .font(.caption2)
      } minimal: {
        DSHWhale(size: 18)
      }
      .keylineTint(.black)
    }
  }
}
