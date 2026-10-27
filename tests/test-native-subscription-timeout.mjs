#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compile the production subscription and scene-lifecycle methods verbatim.
// Only UIKit/network/logging collaborators are replaced by inert test doubles;
// no phone, server, App process, credentials or user content are accessed.
const path = process.argv[2];
if (!path) throw new Error("usage: test-native-subscription-timeout.mjs /path/to/whaleness/DeepSeekHarnessMobile/Core/GatewayClient.swift");
const source = await readFile(path, "utf8");
function method(signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing production method: ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 1, end = open + 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  if (depth) throw new Error(`Unbalanced production method: ${signature}`);
  return source.slice(start, end);
}
const properties = source.split("\n").filter(line =>
  /^\s*private var (?:subscription\w*|pendingSubscriptionID|desiredSubscriptionID)\b/.test(line));
const methods = [
  "private func cancelSubscriptionTimeout()", "private func startSubscriptionTimeout()",
  "func resetSubscriptionRequests()", "func acceptSubscriptionAck(sessionID:",
  "func applicationDidEnterBackground()", "func applicationDidBecomeActive()", "func subscribe(sessionId:",
  "private func fail(_ detail:",
].map(method).join("\n");
const root = await mkdtemp(join(tmpdir(), "dsh-subscription-timeout-"));
try {
  const swift = join(root, "SubscriptionTests.swift");
  await writeFile(swift, `import Foundation
struct GatewayFrame {
    let kind: String
    let sessionId: String?
    let code: String
    let message: String
    let requestType: String
}
func gatewayApprovalTrace(_ message: String) {}
@MainActor final class NoopRecovery { func cancel() {} }
@MainActor final class NoopSocket {
    enum CloseCode { case goingAway }
    func cancel(with: CloseCode, reason: Data?) {}
}
enum ConnectionState {
    case connected, failed(String)
    var isConnected: Bool { if case .connected = self { return true }; return false }
}
@MainActor final class GatewayClient {
    ${properties.join("\n")}
    private let subscriptionTimeoutInterval: Duration
    init(subscriptionTimeoutInterval: Duration = .milliseconds(250)) {
        self.subscriptionTimeoutInterval = subscriptionTimeoutInterval
    }
    var onFrame: ((GatewayFrame) -> Void)?
    var requests: [[String: Any]] = []
    private var isApplicationInBackground = false
    private var networkRecovery = NoopRecovery()
    private var foregroundProbeTask: Task<Void, Never>?
    private var foregroundProbeSequence = 0
    private var backgroundEnteredAt: Date?
    private var isRecoveringFromBackground = false
    private var conversationClient: GatewayClient?
    private var wantsConnection = true
    private var isManualPairingAttempt = false
    private var probeOnly = false
    private var reconnectAttempt = 0
    private var endpoint: URL?
    private var reconnectTask: Task<Void, Never>?
    private var pairingCode: String?
    private var state = ConnectionState.connected
    private var connectionGeneration = UUID()
    private var connectionPreparationTask: Task<Void, Never>?
    private var onConnectionInvalidated: (() -> Void)?
    private var outboundTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var pendingConversationPayloads: [String] = []
    private var pendingConversationBytes = 0
    private var connectionTimeoutTask: Task<Void, Never>?
    private var socket: NoopSocket?
    private var receiveTask: Task<Void, Never>?
    private var onTransportFailure: ((String, Bool) -> Void)?
    private var lastReportedFailure: String?
    private var onConnectionFailure: ((String) -> Void)?
    private let channel = "control"
    private var trustedEndpoints: [String] = []
    private func failSessionCreations() {}
    private func disconnect() { resetSubscriptionRequests() }
    func invalidateForTesting(reconnect: Bool) {
        fail("synthetic transport failure", shouldReconnect: reconnect, reportFailure: false)
    }
    private func traceLifecycle(_ event: String) {}
    private func probeForegroundConnection() {}
    private func beginConnection(to: String, pairingCode: String?, resetReportedFailure: Bool) {}
    private func send(_ payload: [String: Any]) { requests.append(payload) }
    ${methods}
}
@MainActor final class Fixture {
    let client = GatewayClient()
    var failures: [GatewayFrame] = []
    init() { client.onFrame = { [weak self] in self?.failures.append($0) } }
}
@main struct SubscriptionTests {
    @MainActor static func expect(_ value: @autoclosure () -> Bool, _ message: String) {
        precondition(value(), message)
    }
    static func wait(_ milliseconds: Int) async throws {
        try await Task.sleep(for: .milliseconds(milliseconds))
    }
    @MainActor static func main() async throws {
        // An in-flight request survives suspension, with a full foreground
        // window after resume, and its ACK cancels the resumed deadline.
        do {
            let f = Fixture()
            f.client.subscribe(sessionId: "a")
            try await wait(50)
            f.client.applicationDidEnterBackground()
            try await wait(500)
            expect(f.failures.isEmpty, "background time consumed subscription timeout")
            f.client.applicationDidBecomeActive()
            try await wait(50)
            expect(f.failures.isEmpty, "resumed request did not get a fresh response window")
            expect(f.client.acceptSubscriptionAck(sessionID: "a"), "ACK lost across background/resume")
            try await wait(350)
            expect(f.failures.isEmpty, "ACK failed to cancel resumed deadline")
            expect(f.client.requests.count == 1, "resume duplicated a live subscription")
        }
        // Pausing must retain pending A and merge B/C into the latest intent.
        do {
            let f = Fixture()
            f.client.subscribe(sessionId: "a")
            f.client.subscribe(sessionId: "b")
            f.client.subscribe(sessionId: "c")
            expect(f.client.requests.count == 1, "subscriptions stopped being single-flight")
            f.client.applicationDidEnterBackground()
            try await wait(350)
            expect(!f.client.acceptSubscriptionAck(sessionID: "b"), "wrong ACK accepted")
            f.client.applicationDidBecomeActive()
            expect(!f.client.acceptSubscriptionAck(sessionID: "a"), "intermediate ACK exposed stale intent")
            expect(f.client.requests.count == 2 && f.client.requests.last?["sessionId"] as? String == "c",
                   "latest C intent was lost or intermediate B was sent")
            expect(!f.client.acceptSubscriptionAck(sessionID: "a"), "stale A ACK accepted for C")
            expect(f.client.acceptSubscriptionAck(sessionID: "c"), "latest C ACK rejected")
            try await wait(350)
            expect(f.failures.isEmpty, "old/resumed timer survived latest ACK")
        }
        // The gateway acknowledges unsubscribe with subscribed(sessionId:nil).
        do {
            let f = Fixture()
            f.client.subscribe(sessionId: "a")
            f.client.subscribe(sessionId: nil)
            expect(!f.client.acceptSubscriptionAck(sessionID: "a"), "pending unsubscribe was lost")
            expect(f.client.requests.last?["type"] as? String == "unsubscribe", "unsubscribe not sent")
            expect(f.client.acceptSubscriptionAck(sessionID: nil), "nil unsubscribe ACK rejected")
            try await wait(350)
            expect(f.failures.isEmpty, "unsubscribe ACK failed to cancel timeout")
        }
        // An ACK received while backgrounded must not be rearmed on resume.
        do {
            let f = Fixture()
            f.client.subscribe(sessionId: "a")
            f.client.applicationDidEnterBackground()
            expect(f.client.acceptSubscriptionAck(sessionID: "a"), "background ACK rejected")
            f.client.applicationDidBecomeActive()
            try await wait(350)
            expect(f.failures.isEmpty, "completed request was rearmed on resume")
        }
        // Reset/cancellation invalidates a paused request. A new request must
        // have its own timer and reject the cancelled request's stale ACK.
        do {
            let f = Fixture()
            f.client.subscribe(sessionId: "a")
            f.client.applicationDidEnterBackground()
            f.client.resetSubscriptionRequests()
            f.client.applicationDidBecomeActive()
            try await wait(350)
            expect(f.failures.isEmpty, "reset request was rearmed")
            f.client.subscribe(sessionId: "b")
            expect(!f.client.acceptSubscriptionAck(sessionID: "a"), "reset ACK consumed a new request")
            expect(f.client.acceptSubscriptionAck(sessionID: "b"), "new request's ACK rejected")
            try await wait(350)
            expect(f.failures.isEmpty, "cancelled timer affected a later request")
        }
        // Missing ACKs still produce exactly one real foreground timeout.
        do {
            let f = Fixture()
            f.client.subscribe(sessionId: "missing")
            try await wait(350)
            expect(f.failures.count == 1 && f.failures[0].code == "subscription-timeout" &&
                   f.failures[0].sessionId == "missing", "real foreground timeout was suppressed")
            try await wait(300)
            expect(f.failures.count == 1, "timeout emitted repeatedly")
            f.client.subscribe(sessionId: "next")
            expect(f.client.requests.count == 2 && f.client.acceptSubscriptionAck(sessionID: "next"),
                   "timeout did not reset single-flight state")
        }
        // Repeated active notifications must not indefinitely extend a timer.
        do {
            let f = Fixture()
            f.client.subscribe(sessionId: "missing")
            try await wait(150)
            f.client.applicationDidBecomeActive()
            try await wait(150)
            expect(f.failures.count == 1, "already-active notification restarted the timeout")
        }
        // Subscriptions requested while backgrounded start timing on resume.
        do {
            let f = Fixture()
            f.client.applicationDidEnterBackground()
            f.client.subscribe(sessionId: "background")
            try await wait(350)
            expect(f.failures.isEmpty, "background-originated request armed a timer")
            f.client.applicationDidBecomeActive()
            try await wait(350)
            expect(f.failures.count == 1 && f.failures[0].sessionId == "background",
                   "resumed missing ACK never timed out")
        }
        // Transport failure invalidates pending state immediately, including
        // the reconnect delay before disconnect() would otherwise clear it.
        for reconnect in [false, true] {
            let f = Fixture()
            f.client.subscribe(sessionId: "old")
            f.client.subscribe(sessionId: "queued")
            f.client.invalidateForTesting(reconnect: reconnect)
            try await wait(350)
            expect(f.failures.isEmpty, "failed transport retained its old subscription timer")
            f.client.applicationDidEnterBackground()
            f.client.applicationDidBecomeActive()
            try await wait(350)
            expect(f.failures.isEmpty, "resume rearmed a failed transport request")
            f.client.subscribe(sessionId: "new")
            expect(f.client.requests.count == 2 && f.client.requests.last?["sessionId"] as? String == "new",
                   "transport invalidation retained stale pending/latest intent")
            expect(f.client.acceptSubscriptionAck(sessionID: "new"), "new request blocked after failure")
        }
        print("10 production Swift subscription lifecycle scenarios passed")
    }
}
`);
  const binary = join(root, "SubscriptionTests");
  execFileSync("xcrun", ["swiftc", "-parse-as-library", swift, "-o", binary]);
  process.stdout.write(execFileSync(binary, [], { encoding: "utf8", timeout: 30_000 }));
} finally { await rm(root, { recursive: true, force: true }); }
