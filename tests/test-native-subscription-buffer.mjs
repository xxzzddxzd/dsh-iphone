#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercise the production send, ordered write, bounded buffer, disconnect and
// failure methods. The socket alone is inert; the separate transport suite
// covers real URLSession WebSockets and asynchronous credential preparation.
const checkout = process.argv[2] ?? process.env.NATIVE_APP_SOURCE;
if (!checkout) throw new Error('Pass the reviewed Whaleness source directory');
const source = await readFile(join(resolve(checkout), 'DeepSeekHarnessMobile/Core/GatewayClient.swift'), 'utf8');
function method(signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing production method: ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 1, end = open + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw new Error(`Unbalanced production method: ${signature}`);
  return source.slice(start, end);
}
const properties = source.split('\n').filter(line =>
  /^\s*private var (?:subscription\w*|pendingSubscriptionID|desiredSubscriptionID)\b/.test(line)).join('\n');
const methods = [
  'private func cancelSubscriptionTimeout()', 'private func startSubscriptionTimeout()',
  'func resetSubscriptionRequests()', 'func acceptSubscriptionAck(sessionID:',
  'func subscribe(sessionId:', 'func sendRequestPayload(',
  'private func send(_ object:', 'private func write(_ payload:',
  'private func deferUntilConversationHello(', 'nonisolated static func usesConversationChannel(',
  'func disconnect(reconnect:', 'private func fail(_ detail:',
].map(method).join('\n');
const flushStart = source.indexOf('let pending = pendingConversationPayloads', source.indexOf('private func receiveLoop('));
const flushTerminator = 'for payload in pending { sendRequestPayload(payload) }';
const flushEnd = source.indexOf(flushTerminator, flushStart) + flushTerminator.length;
if (flushStart < 0 || flushEnd < flushStart) throw new Error('Missing production hello buffer flush');
const temp = await mkdtemp(join(tmpdir(), 'dsh-native-subscription-buffer-'));
try {
  const swift = join(temp, 'Tests.swift');
  await writeFile(swift, `import Foundation
struct GatewayFrame {
    let kind: String
    var sessionId: String? = nil
    var code: String? = nil
    var message: String? = nil
    var requestType: String? = nil
    var requestId: String? = nil
    var transferId: String? = nil
}
struct MobileConversationTarget { let parentSessionId: String? }
enum ConnectionState {
    case disconnected, connecting, connected, failed(String)
    var isConnected: Bool { if case .connected = self { return true }; return false }
}
struct NoopLogger { func info(_ message: String) {} }
func gatewayApprovalTrace(_ message: String) {}
actor NoopNativeSettings { func invalidate() {} }
@MainActor final class NoopRecovery { func cancel() {} }
@MainActor final class URLSessionWebSocketTask {
    enum Message { case string(String) }
    enum CloseCode { case normalClosure, goingAway }
    var sent: [String] = []
    func send(_ message: Message) async throws {
        try await Task.sleep(for: .milliseconds(1))
        if case let .string(value) = message { sent.append(value) }
    }
    func cancel(with: CloseCode, reason: Data?) {}
}
@MainActor final class GatewayClient {
    ${properties}
    let channel: String
    let subscriptionTimeoutInterval = Duration.seconds(60)
    var state: ConnectionState
    var socket: URLSessionWebSocketTask?
    var conversationClient: GatewayClient?
    var outboundTask: Task<Void, Never>?
    var pendingConversationPayloads: [String] = []
    var pendingConversationBytes = 0
    var requestDecorator: ((String) -> String?)?
    var conversationTarget: ((String) -> MobileConversationTarget?)?
    var onFrame: ((GatewayFrame) -> Void)?
    var isApplicationInBackground = false
    var wantsConnection = true
    var failures: [String] = []
    private var connectionGeneration = UUID()
    private var connectionPreparationTask: Task<Void, Never>?
    private var onConnectionInvalidated: (() -> Void)?
    private var nativeSettingsAvailable = false
    private let nativeSettings = NoopNativeSettings()
    private var networkRecovery = NoopRecovery()
    private var reconnectTask: Task<Void, Never>?
    private var connectionTimeoutTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var foregroundProbeTask: Task<Void, Never>?
    private var foregroundProbeSequence = 0
    private var receiveTask: Task<Void, Never>?
    private var pairingCode: String?
    private var isManualPairingAttempt = false
    private var serverPort: Int?
    private var clientCount: Int?
    private var onTransportFailure: ((String, Bool) -> Void)?
    private var lastReportedFailure: String?
    private var onConnectionFailure: ((String) -> Void)?
    private var probeOnly = false
    private var reconnectAttempt = 0
    private var endpoint: URL?
    private var trustedEndpoints: [String] = []
    static let presetLogger = NoopLogger()
    struct RequestEnvelope: Decodable { let type: String }
    init(_ channel: String, socket: URLSessionWebSocketTask? = nil, state: ConnectionState = .connecting) {
        self.channel = channel; self.socket = socket; self.state = state
        onConnectionFailure = { [weak self] in self?.failures.append($0) }
    }
    private func failSessionCreations() {}
    private func traceLifecycle(_ event: String) {}
    private func beginConnection(to: String, pairingCode: String?, resetReportedFailure: Bool) {}
    private func handleFailure(_ error: Error, socket: URLSessionWebSocketTask? = nil) async { failures.append(error.localizedDescription) }
    func receiveHelloForTesting() {
        state = .connected
        ${source.slice(flushStart, flushEnd)}
    }
    func requestHistoryForTesting(_ sessionID: String) { send(["type": "history", "sessionId": sessionID, "maxMessages": 50]) }
    func reconnectForTesting() { wantsConnection = true; state = .connecting }
    func failForTesting() { fail("synthetic failure", shouldReconnect: false) }
    var pendingForTesting: Bool { subscriptionPending }
    ${methods}
}
@main struct Tests {
    @MainActor static func expect(_ condition: @autoclosure () -> Bool, _ message: String) { precondition(condition(), message) }
    @MainActor static func envelope(_ value: String) -> [String: Any] { try! JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any] }
    static func waitForWrites() async throws { try await Task.sleep(for: .milliseconds(100)) }
    @MainActor static func main() async throws {
        var scenarios = 0
        // This used to drop subscribe before Keychain assigned child.socket,
        // leaving only the later history on the wire and a root ACK timer.
        do {
            let control = URLSessionWebSocketTask(), conversation = URLSessionWebSocketTask()
            let root = GatewayClient("control", socket: control, state: .connected)
            let child = GatewayClient("conversation")
            root.conversationClient = child
            root.subscribe(sessionId: "early-session")
            root.requestHistoryForTesting("early-session")
            expect(root.pendingForTesting, "single-flight was not set")
            expect(child.pendingConversationPayloads.count == 2, "no-socket credential preparation lost subscribe/history")
            expect(child.failures.isEmpty, "valid connection preparation was marked failed")
            child.socket = conversation; child.receiveHelloForTesting()
            try await waitForWrites()
            expect(control.sent.isEmpty, "conversation request went to control")
            expect(conversation.sent.map { envelope($0)["type"] as! String } == ["subscribe", "history"], "subscribe/history lost or reordered")
            expect(envelope(conversation.sent[0])["assistantStream"] as? Bool == true, "subscribe wire flag missing")
            expect(root.acceptSubscriptionAck(sessionID: "early-session"), "matching ACK rejected")
            expect(!root.pendingForTesting, "ACK did not finish root single-flight")
            root.disconnect(); scenarios += 1
        }
        // The 64-message cap fails and clears the generation rather than
        // leaving an unbounded or partially replayable backlog.
        do {
            let client = GatewayClient("conversation")
            for i in 0..<64 { client.requestHistoryForTesting("queued-\\(i)") }
            expect(client.pendingConversationPayloads.count == 64, "64-message boundary rejected early")
            client.requestHistoryForTesting("overflow")
            expect(client.failures.count == 1 && !client.wantsConnection, "message overflow did not fail connection")
            expect(client.pendingConversationPayloads.isEmpty && client.pendingConversationBytes == 0, "overflow retained payloads")
            client.requestHistoryForTesting("after-failure")
            expect(client.pendingConversationPayloads.isEmpty, "failed channel accumulated new payloads")
            scenarios += 1
        }
        // Verify the byte cap using valid JSON at its exact UTF-8 boundary.
        do {
            let client = GatewayClient("conversation")
            let prefix = #"{"type":"history","pad":""#
            let suffix = #""}"#
            let budget = 16 * 1024 * 1024
            let payload = prefix + String(repeating: "x", count: budget-prefix.utf8.count-suffix.utf8.count) + suffix
            client.sendRequestPayload(payload)
            expect(client.pendingConversationBytes == budget && client.pendingConversationPayloads.count == 1, "byte limit rejected at boundary")
            client.sendRequestPayload(#"{"type":"history"}"#)
            expect(client.failures.count == 1 && !client.wantsConnection, "byte overflow did not fail connection")
            expect(client.pendingConversationPayloads.isEmpty && client.pendingConversationBytes == 0, "byte overflow retained payloads")
            scenarios += 1
        }
        for failure in [false, true] {
            let client = GatewayClient("conversation")
            client.requestHistoryForTesting("old-generation")
            if failure { client.failForTesting() } else { client.disconnect() }
            expect(client.pendingConversationPayloads.isEmpty && client.pendingConversationBytes == 0, "invalidation retained queue")
            client.requestHistoryForTesting("while-stopped")
            expect(client.pendingConversationPayloads.isEmpty, "stopped channel accumulated a payload")
            let socket = URLSessionWebSocketTask()
            client.reconnectForTesting()
            client.requestHistoryForTesting("new-generation")
            client.socket = socket; client.receiveHelloForTesting()
            try await waitForWrites()
            expect(socket.sent.count == 1 && envelope(socket.sent[0])["sessionId"] as? String == "new-generation", "invalidation replayed stale payloads")
            client.disconnect(); scenarios += 1
        }
        // The owner's explicit disconnect clears child buffering and its own
        // in-flight subscription even before the child has a socket.
        do {
            let root = GatewayClient("control", socket: URLSessionWebSocketTask(), state: .connected)
            let child = GatewayClient("conversation")
            root.conversationClient = child
            root.subscribe(sessionId: "owner-stopped")
            expect(child.pendingConversationPayloads.count == 1, "owner request was not buffered")
            root.disconnect()
            expect(!root.pendingForTesting && root.conversationClient == nil, "owner subscription survived disconnect")
            expect(!child.wantsConnection && child.pendingConversationPayloads.isEmpty && child.pendingConversationBytes == 0, "owner disconnect retained child buffer")
            scenarios += 1
        }
        print("\\(scenarios) production subscription buffer/ordering/invalidation scenarios passed")
    }
}
`);
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', swift, '-o', join(temp, 'Tests')], { stdio: 'inherit' });
  execFileSync(join(temp, 'Tests'), [], { stdio: 'inherit' });
} finally { await rm(temp, { recursive: true, force: true }); }
