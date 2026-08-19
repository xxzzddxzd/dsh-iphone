import ActivityKit
import SwiftUI
import WidgetKit

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
private struct DSHActivityLockScreenView: View {
  let context: ActivityViewContext<DSHActivityAttributes>

  private var startedAt: Date {
    Date(timeIntervalSince1970: Double(context.state.startedAtMilliseconds) / 1_000)
  }

  private var sessionURL: URL? {
    var components = URLComponents(string: "http://127.0.0.1:3080/")
    components?.queryItems = [URLQueryItem(name: "session", value: context.state.sessionID)]
    return components?.url
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
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
        Spacer(minLength: 8)
        VStack(alignment: .trailing, spacing: 2) {
          Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
            .font(.subheadline.monospacedDigit().weight(.semibold))
          Text(context.state.step > 0 ? "第 \(context.state.step) 步" : "准备中")
            .font(.caption2)
            .foregroundColor(.secondary)
        }
      }

      HStack(spacing: 8) {
        if context.state.totalItems > 0 {
          ProgressView(
            value: Double(context.state.completedItems),
            total: Double(context.state.totalItems))
        } else {
          ProgressView()
            .progressViewStyle(.circular)
        }
        Text(context.state.detail)
          .font(.caption)
          .foregroundColor(.secondary)
          .lineLimit(2)
        Spacer(minLength: 0)
        if context.state.totalItems > 0 {
          Text("\(context.state.completedItems)/\(context.state.totalItems)")
            .font(.caption.monospacedDigit())
            .foregroundColor(.secondary)
        }
      }
    }
    .padding(14)
    .activityBackgroundTint(Color(white: 0.98))
    .activitySystemActionForegroundColor(.black)
    .widgetURL(sessionURL)
  }
}

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
          Text("第\(max(context.state.step, 1))步")
            .font(.caption2.monospacedDigit())
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(context.state.detail).font(.caption2).lineLimit(1)
        }
      } compactLeading: {
        DSHWhale(size: 20)
      } compactTrailing: {
        Text(context.state.waitingForUser ? "待确认" : "运行中")
          .font(.caption2)
      } minimal: {
        DSHWhale(size: 18)
      }
      .keylineTint(.black)
    }
  }
}

@main
@available(iOS 16.1, *)
struct DSHLiveActivityWidgetBundle: WidgetBundle {
  var body: some Widget {
    DSHLiveActivityWidget()
  }
}
