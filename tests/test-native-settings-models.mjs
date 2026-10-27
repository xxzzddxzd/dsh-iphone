#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root = resolve(process.argv[2] ?? process.env.NATIVE_APP_SOURCE ?? '');
if (!process.argv[2] && !process.env.NATIVE_APP_SOURCE) throw new Error('Pass the reviewed Whaleness source directory');
const base = join(root,'DeepSeekHarnessMobile');
const modelSource = await readFile(join(base,'Core/GatewayModels.swift'),'utf8');
const json = modelSource.slice(modelSource.indexOf('enum JSONValue:'),modelSource.indexOf('@propertyWrapper'));
const generic = await readFile(join(base,'Views/NativePluginSettingsView.swift'),'utf8');
const editor = generic.slice(generic.indexOf('struct NativeSchemaGraph'),generic.indexOf('struct NativePluginSettingsView:')) + generic.slice(generic.indexOf('struct NativeCredentialPolicy'), generic.indexOf('struct NativeCredentialView:'));
const provider = await readFile(join(base,'Views/NativeSettingsViews.swift'),'utf8');
const homeSource=provider.slice(provider.indexOf('struct NativeSettingsHomeView:'),provider.indexOf('struct NativeProviderDetailView:'));
assert.match(homeSource,/\.task\(id: gateway\.nativeSettingsAvailable\) \{ await load\(\) \}/,'Cold-open capability must restart the Provider overview load');
const nativePage=provider.slice(provider.indexOf('@MainActor\nfinal class NativeSettingsPage:'),provider.indexOf('private struct NativeSettingsLifecycle:'));
const draft = provider.slice(provider.indexOf('private struct NativeModelDraft:'),provider.indexOf('struct NativeProviderModelsView:'));
const cline = await readFile(join(base,'Views/NativeClineSettingsView.swift'),'utf8');
function method(source, signature) {
 const begin=source.indexOf(signature);if(begin<0)throw Error('Missing production method '+signature);
 const open=source.indexOf('{',begin);let depth=1,end=open+1;while(depth){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;end++;if(end>source.length)throw Error('Unbalanced method');}
 return source.slice(begin,end);
}
const temp = await mkdtemp(join(tmpdir(),'dsh-native-settings-models-'));
try {
 await writeFile(join(temp,'Types.swift'),`import Foundation\n${json}\nextension JSONEncoder { static var pretty: JSONEncoder { JSONEncoder() } }\n`);
 await writeFile(join(temp,'Tests.swift'),`import Foundation\nimport SwiftUI\n${editor}\n${draft}\n${nativePage}\n@MainActor final class HomeGateway { var nativeSettingsAvailable=false }\n@MainActor final class HomeProbe { let gateway=HomeGateway();let page:NativeSettingsPage;var overview:JSONValue = .null;init(_ page:NativeSettingsPage){self.page=page};func run()async{await load()};${method(homeSource,'private func load() async')} }\nstruct AuthProbe { ${method(provider,'static func acceptsAuthorizationURL')} }\nstruct QuotaProbe { ${method(provider,'static func windowLabel')} }\n`+String.raw`
actor HomeWire {
 var frames:[JSONValue]=[]
 func send(_ data:Data)throws{frames.append(try JSONDecoder().decode(JSONValue.self,from:data))}
 func count()->Int{frames.count}
 func frame(_ index:Int)async throws->JSONValue{for _ in 0..<200{if frames.count>index{return frames[index]};try await Task.sleep(for:.milliseconds(5))};throw TestFailure(message:"Overview request missing")}
}
func homeReply(_ client:NativeSettingsClient,_ request:JSONValue,_ value:JSONValue)async throws{
 await client.receive(try JSONEncoder().encode(JSONValue.object(["kind":.string("native-settings"),"requestId":request["requestId"]!,"scope":request["scope"]!,"action":request["action"]!,"value":value])))
}
struct TestFailure: Error { let message: String }
func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws { if !condition() { throw TestFailure(message: message) } }
@MainActor final class FakePage {
 var error: String?;var notice: String?
 var state: JSONValue
 var calls: [(String,[String:JSONValue])] = []
 init(_ state: JSONValue) { self.state=state }
 func call(_ scope: NativeSettingsClient.Scope,_ action:String,_ payload:[String:JSONValue]=[:]) async -> JSONValue? {
  calls.append((action,payload));return action=="state" ? state : .object([:])
 }
}
@MainActor final class AccountProbe {
 var name="";var label="";var baseURL="";let page:FakePage
 init(_ page:FakePage){self.page=page}
 func run(_ input:String="") async { await addAccount(key:input) }
`+method(cline,'private func addAccount(key input: String) async')+String.raw`
}
@main @MainActor struct Tests {
 static func main() async throws {
  // Exercise the actual Home.load + NativeSettingsPage + RPC actor across
  // initial unavailable, hello-ready, in-flight invalidation and reconnect.
  // The keyed SwiftUI modifier is checked above; no live App/server is touched.
  let homeWire=HomeWire();let homeClient=NativeSettingsClient(transport:{try await homeWire.send($0)})
  let homePage=NativeSettingsPage(homeClient);let home=HomeProbe(homePage)
  await home.run();let initialCount=await homeWire.count()
  try expect(initialCount==0 && home.overview == .null,"Unavailable cold-open page sent a request")
  home.gateway.nativeSettingsAvailable=true
  let readyTask=Task {await home.run()};let readyRequest=try await homeWire.frame(0)
  let readyValue:JSONValue = .object(["settingsReady":.bool(true),"providers":.array([.object(["id":.string("provider-codex")])])])
  try await homeReply(homeClient,readyRequest,readyValue);await readyTask.value
  try expect(home.overview==readyValue && !homePage.busy,"Hello-ready overview did not appear")
  let pending=Task{await home.run()};let canceledRequest=try await homeWire.frame(1)
  home.gateway.nativeSettingsAvailable=false;pending.cancel();await pending.value
  try expect(home.overview==readyValue && homePage.error==nil && !homePage.busy,"Connection invalidation lost overview or left loading/error")
  try await homeReply(homeClient,canceledRequest,.object(["settingsReady":.bool(false)]))
  await home.run();let inactiveCount=await homeWire.count()
  try expect(inactiveCount==2 && home.overview==readyValue,"Unavailable page retried or accepted a late stale response")
  home.gateway.nativeSettingsAvailable=true
  let reconnected=Task{await home.run()};let freshRequest=try await homeWire.frame(2)
  try await homeReply(homeClient,freshRequest,readyValue);await reconnected.value
  try expect(home.overview==readyValue && !homePage.busy,"Reconnected overview stayed empty or busy")
  let graph:JSONValue = .object(["uid":.number(1),"refs":.object([
   "1":.object(["type":.string("object"),"dict":.object(["enabled":.number(2),"count":.number(3),"mode":.number(4),"rows":.number(7),"key":.number(9)])]),
   "2":.object(["type":.string("boolean"),"meta":.object(["default":.bool(true)])]),
   "3":.object(["type":.string("number"),"meta":.object(["min":.number(1),"max":.number(10),"step":.number(1)])]),
   "4":.object(["type":.string("union"),"list":.array([.number(5),.number(6)])]),
   "5":.object(["type":.string("const"),"value":.string("direct")]),
   "6":.object(["type":.string("const"),"value":.string("vless")]),
   "7":.object(["type":.string("array"),"inner":.number(8)]),
   "8":.object(["type":.string("object"),"dict":.object(["secret":.number(9)])]),
   "9":.object(["type":.string("string"),"meta":.object(["role":.string("secret")])])
  ])])
  let namespace:JSONValue = .object(["ns":.string("example"),"revision":.number(12),"schema":graph,
   "value":.object(["enabled":.bool(true),"count":.number(4),"rows":.array([.object(["keep":.string("original")])])]),
   "base":.object(["count":.number(2)]),"secrets":.array([.object(["path":.array([.string("key")]),"set":.bool(true)])])])
  let resolver=NativeSchemaGraph(envelope:graph)
  try expect(resolver.fields(resolver.root).count==5,"Schemastery ref/object graph not rendered")
  try expect(resolver.choices(resolver.resolve(.number(4))) == [.string("direct"),.string("vless")],"Union const enum not resolved")
  try expect(resolver.containsSecret(resolver.resolve(.number(7))),"Nested array secret not detected")
  let editor=NativePluginEditor();editor.reset(namespace)
  editor.setNumber(["count"],"bad",node:resolver.resolve(.number(3)))
  try expect(!editor.errors.isEmpty && editor.operations.isEmpty,"Invalid number became a write")
  editor.setNumber(["count"],"5.5",node:resolver.resolve(.number(3)))
  try expect(!editor.errors.isEmpty,"Integer constraint ignored")
  editor.setNumber(["count"],"7",node:resolver.resolve(.number(3)))
  try expect(editor.errors.isEmpty && editor.operations.first?["value"] == .number(7),"Valid typed edit failed")
  editor.unset(["count"])
  try expect(editor.operations.first?["op"] == .string("unset") && editor.value(["count"]) == .number(2),"Default reset lost base")
  editor.reset(namespace);editor.setSecret(["key"],"temporary-test-value");editor.setSecret(["key"],"")
  try expect(editor.operations.isEmpty,"Blank secret became a secret deletion")
  editor.set(["rows"],.array([.object(["keep":.string("draft")])]))
  editor.setSecret(["rows","0","secret"],"temporary-test-value")
  editor.setSecret(["rows","0","secret"],"")
  let encoded=String(decoding:try JSONEncoder().encode(editor.operations),as:UTF8.self)
  try expect(!encoded.contains("temporary-test-value") && editor.operations.isEmpty,"Cleared secret survived in ancestor write")
  try expect(editor.value(["rows","0","keep"]) == .string("original"),"Unsafe parent draft not restored")
  editor.setSecret(["key"],"temporary-test-value");editor.clearSensitive()
  try expect(editor.operations.isEmpty && editor.secretText.isEmpty,"Leaving page retained a secret write")
  for ref in ["API_KEY", "_local1", "GROK2API_KEY"] { try expect(NativeCredentialPolicy.isValidReference(ref),"Valid credential reference refused") }
  for ref in ["", "API-KEY", "../token", " API_KEY", "API_KEY\n", String(repeating:"A",count:129)] { try expect(!NativeCredentialPolicy.isValidReference(ref),"Invalid credential reference accepted") }
  let refNamespace=namespace.nativeReplacing(at:["value","apiKeyEnv"],with:.string("ORIGINAL_REF"))
  editor.reset(refNamespace);editor.set(["apiKeyEnv"],.string("UNSAVED_NEW_REF"))
  try expect(editor.effectiveCredentialReference(["apiKeyEnv"])=="ORIGINAL_REF","Unsaved draft retargeted credential writes")
  let projection=NativeCredentialPolicy.publicStatus(.object(["configured":.bool(true),"writable":.bool(true),"source":.string("env"),"value":.string("temporary-test-value"),"hint":.string("not-for-display")]))
  try expect(Set(projection?.objectValue?.keys.map{$0} ?? []) == ["configured","writable","source"],"Credential status retained a returned secret field")
  try expect(NativeCredentialPolicy.publicStatus(.object(["configured":.bool(true)]))==nil,"Unknown credential permissions inferred writable")
  let quota:[(Double?,String)] = [(300,"5 分钟"),(3600,"1 小时"),(86400,"1 天"),(45,"45 秒"),(nil,"未提供")]
  for (seconds,label) in quota { try expect(QuotaProbe.windowLabel(seconds)==label,"Quota window truncation") }
  try expect(AuthProbe.acceptsAuthorizationURL(URL(string:"https://auth.openai.com/oauth/authorize")!,provider:"provider-codex"),"Official auth URL refused")
  for raw in ["http://auth.openai.com/","https://auth.openai.com.attacker.invalid/","https://name:password@auth.openai.com/","javascript:alert(1)"] {
   try expect(!AuthProbe.acceptsAuthorizationURL(URL(string:raw)!,provider:"provider-codex"),"Unsafe auth URL accepted")
  }
  let page=FakePage(.object(["accounts":.array([.object(["key":.string("existing")])])]))
  let account=AccountProbe(page);account.name="existing";await account.run()
  try expect(page.calls.map(\.0)==["state"] && page.error != nil,"Add account overwrote an existing account")
  let blank=FakePage(.object(["accounts":.array([])]));let add=AccountProbe(blank);add.name="new";await add.run()
  try expect(blank.calls.count==2 && Set(blank.calls[1].1.keys)==["name"],"Blank fields were sent as destructive upsert defaults")
  let model=NativeModelDraft(.object(["id":.string("model"),"name":.string("Example"),"visible":.bool(false),"contextWindow":.number(123)]))
  try expect(model.hasOverride,"Non-default model settings lost")
  let payload=try model.payload()
  try expect(payload["name"]==nil && payload["contextWindow"] == .number(123),"Read-only model metadata was sent")
  print("Native form graph, safe edits, ancestor secret cleanup, account-create and quota/auth policy scenarios passed")
 }
}
`);
 execFileSync('xcrun',['swiftc','-swift-version','5','-parse-as-library','-framework','SwiftUI',join(temp,'Types.swift'),join(base,'Core/NativeSettingsClient.swift'),join(temp,'Tests.swift'),'-o',join(temp,'Tests')],{stdio:'pipe'});
 execFileSync(join(temp,'Tests'),[],{stdio:'inherit'});
} finally { await rm(temp,{recursive:true,force:true}); }
