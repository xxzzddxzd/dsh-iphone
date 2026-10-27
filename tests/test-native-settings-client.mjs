#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const source = process.argv[2] ?? process.env.NATIVE_APP_SOURCE;
if (!source) throw new Error('Pass the reviewed Whaleness source directory');
const root = resolve(source);
const models = await readFile(join(root, 'DeepSeekHarnessMobile/Core/GatewayModels.swift'), 'utf8');
const json = models.slice(models.indexOf('enum JSONValue:'), models.indexOf('@propertyWrapper'));
if (!json.startsWith('enum JSONValue:')) throw new Error('JSONValue source moved; audit fixture boundary');
const temp = await mkdtemp(join(tmpdir(), 'dsh-native-settings-client-'));
try {
 await writeFile(join(temp, 'Types.swift'), `import Foundation\n${json}\nextension JSONEncoder { static var pretty: JSONEncoder { JSONEncoder() } }\n`);
 await writeFile(join(temp, 'Tests.swift'), String.raw`import Foundation
struct TestFailure: Error { let message: String }
func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws { if !condition() { throw TestFailure(message: message) } }
actor Wire {
 var frames: [JSONValue] = []
 var refreshes = 0
 func send(_ data: Data) throws { frames.append(try JSONDecoder().decode(JSONValue.self, from: data)) }
 func refreshed() { refreshes += 1 }
 func refreshCount() -> Int { refreshes }
 func frame(_ index: Int) async throws -> JSONValue {
  for _ in 0..<200 { if frames.count > index { return frames[index] }; try await Task.sleep(for: .milliseconds(5)) }
  throw TestFailure(message: "No request reached the transport")
 }
}
func reply(_ client: NativeSettingsClient, _ request: JSONValue, _ value: JSONValue = .object(["ok": .bool(true)]), action: String? = nil) async throws {
 let frame: JSONValue = .object(["kind": .string("native-settings"), "requestId": request["requestId"]!, "scope": request["scope"]!, "action": action.map(JSONValue.string) ?? request["action"]!, "value": value])
 await client.receive(try JSONEncoder().encode(frame))
}
@main struct Tests {
 static func main() async throws {
  var cases = 0
  do {
   let wire = Wire(); let client = NativeSettingsClient(transport: { try await wire.send($0) })
   let task = Task { try await client.request(.provider, "models.get", payload: ["provider": .string("provider-codex")]) }
   let frame = try await wire.frame(0)
   try expect(frame["type"] == .string("native-settings") && frame["scope"] == .string("provider"), "Wrong request envelope")
   try expect(frame["payload"]?["provider"] == .string("provider-codex"), "Payload changed")
   try await reply(client, frame, .object(["models": .array([])]))
   let value = try await task.value; try expect(value["models"] == .array([]), "Value was not unwrapped")
   cases += 1
  }
  do {
   let wire = Wire(); let client = NativeSettingsClient(transport: { try await wire.send($0) })
   let first = Task { try await client.request(.provider, "images.get") }; let a = try await wire.frame(0)
   let second = Task { try await client.request(.plugin, "describe") }; let b = try await wire.frame(1)
   try await reply(client, b, .string("second")); try await reply(client, a, .string("first"))
   let bv = try await second.value, av = try await first.value
   try expect(av == .string("first") && bv == .string("second"), "Out-of-order correlation failed")
   cases += 1
  }
  do {
   let wire = Wire(); let client = NativeSettingsClient(transport: { try await wire.send($0) })
   let task = Task { try await client.request(.provider, "images.get") }; let frame = try await wire.frame(0)
   try await reply(client, frame, action: "responses.get")
   do { _ = try await task.value; throw TestFailure(message: "Mismatched action accepted") }
   catch is NativeSettingsClient.Failure { }
   cases += 1
  }
  do {
   let client = NativeSettingsClient(timeout: .milliseconds(35), transport: { _ in })
   do { _ = try await client.request(.provider, "images.get"); throw TestFailure(message: "Missing timeout") }
   catch NativeSettingsClient.Failure.timedOut { }
   cases += 1
  }
  do {
   let wire = Wire(); let client = NativeSettingsClient(transport: { try await wire.send($0) })
   let task = Task { try await client.request(.clinePass, "state") }; let frame = try await wire.frame(0)
   task.cancel()
   do { _ = try await task.value; throw TestFailure(message: "Canceled request returned a value") } catch is CancellationError { }
   try await reply(client, frame)
   cases += 1
  }
  do {
   let wire = Wire(); let client = NativeSettingsClient(transport: { try await wire.send($0) })
   let first = Task { try await client.request(.provider, "images.get") }; _ = try await wire.frame(0)
   let second = Task { try await client.request(.plugin, "describe") }; _ = try await wire.frame(1)
   await client.invalidate()
   for task in [first, second] {
    do { _ = try await task.value; throw TestFailure(message: "Disconnected request survived") } catch NativeSettingsClient.Failure.disconnected { }
   }
   cases += 1
  }
  do {
   let client = NativeSettingsClient(transport: { _ in throw NativeSettingsClient.Failure.disconnected })
   do { _ = try await client.request(.provider, "images.get"); throw TestFailure(message: "Transport failure hidden") }
   catch NativeSettingsClient.Failure.disconnected { }
   cases += 1
  }
  do {
   let wire = Wire(); let client = NativeSettingsClient(transport: { try await wire.send($0) })
   let task = Task { try await client.request(.provider, "vless.configure") }; let frame = try await wire.frame(0)
   let error: JSONValue = .object(["kind": .string("error"), "requestType": .string("native-settings"), "requestId": frame["requestId"]!, "message": .string("failed vless://private-value token=private-token")])
   let data = try JSONEncoder().encode(error)
   try expect(NativeSettingsClient.consumes(data), "Settings error leaked to generic frame routing")
   await client.receive(data)
   do { _ = try await task.value; throw TestFailure(message: "Remote error accepted") }
   catch NativeSettingsClient.Failure.rejected(let message) {
    try expect(!message.contains("private-value") && !message.contains("private-token"), "Sensitive error was not redacted")
   }
   cases += 1
  }
  do {
   let wire = Wire(); let client = NativeSettingsClient(catalogChanged: { await wire.refreshed() }, transport: { try await wire.send($0) })
   for index in 0..<2 {
    let task = Task { try await client.request(.provider, "auth.status", payload: ["provider": .string("provider-codex")]) }
    let frame = try await wire.frame(index); try await reply(client, frame, .object(["status": .string("signed-in")]))
    _ = try await task.value
   }
   try await Task.sleep(for: .milliseconds(20)); let count = await wire.refreshCount()
   try expect(count == 1, "Signed-in status polling repeatedly refreshed models")
   cases += 1
  }
  do {
   let wire=Wire();let client=NativeSettingsClient(catalogChanged:{await wire.refreshed()},transport:{try await wire.send($0)})
   let task=Task {try await client.request(.plugin,"credentials.set",payload:["ref":.string("GROK2API_KEY"),"value":.string("temporary-test-value")])}
   let frame=try await wire.frame(0)
   try expect(frame["payload"]?["value"] == .string("temporary-test-value"),"Credential was not sent only in the write payload")
   try await reply(client,frame,.object(["stored":.bool(true)]));let value=try await task.value
   try expect(value == .object(["stored":.bool(true)]),"Credential write result echoed original input")
   try await Task.sleep(for:.milliseconds(20));let refresh=await wire.refreshCount()
   try expect(refresh==1,"Credential write did not refresh model catalog")
   let canceled=Task {try await client.request(.plugin,"credentials.set",payload:["ref":.string("GROK2API_KEY"),"value":.string("another-test-value")])}
   let late=try await wire.frame(1);canceled.cancel()
   do {_=try await canceled.value;throw TestFailure(message:"Credential request survived page cancellation")} catch is CancellationError {}
   try await reply(client,late,.object(["stored":.bool(true)]))
   let count=await wire.frames.count;try expect(count==2,"Canceled credential request retried itself")
   cases+=1
  }
  do {
   let ordinary = Data(#"{"kind":"error","requestType":"history"}"#.utf8)
   try expect(!NativeSettingsClient.consumes(ordinary), "Unrelated errors were intercepted")
   let nested: JSONValue = .object(["rows": .array([.object(["enabled": .bool(true), "keep": .string("original")])])])
   let changed = nested.nativeReplacing(at: ["rows", "0", "enabled"], with: .bool(false))
   try expect(changed.nativeValue(at: ["rows", "0", "enabled"]) == .bool(false), "Array field edit failed")
   try expect(changed.nativeValue(at: ["rows", "0", "keep"]) == .string("original"), "Unchanged sibling was lost")
   cases += 1
  }
  print("\(cases) native settings actor/transport scenarios passed")
 }
}
`);
 execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', join(temp,'Types.swift'), join(root,'DeepSeekHarnessMobile/Core/NativeSettingsClient.swift'), join(temp,'Tests.swift'), '-o', join(temp,'Tests')], {stdio:'pipe'});
 execFileSync(join(temp,'Tests'), [], {stdio:'inherit'});
} finally { await rm(temp,{recursive:true,force:true}); }
