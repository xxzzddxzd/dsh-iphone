import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
// Compile production request, queue, subscription and connection-preparation
// methods verbatim; use a real URLSessionWebSocketTask and local ACK server.
// The credential store deliberately suspends before the socket exists. Only
// platform logging/UI and the incoming frame decoder are fixture collaborators.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const input=process.argv[2] ?? process.env.NATIVE_APP_SOURCE;
if(!input)throw Error('Pass the reviewed Whaleness source directory or GatewayClient.swift');
const sourcePath=input.endsWith('.swift')?resolve(input):join(resolve(input),'DeepSeekHarnessMobile/Core/GatewayClient.swift');
const temp=await mkdtemp(join(tmpdir(),'dsh-native-subscription-transport-'));
const require=createRequire(root+'/dsh-runtime/package.json');
const {WebSocketServer}=require('ws');
const source=await readFile(sourcePath,'utf8');
function method(signature){let s=source.indexOf(signature);if(s<0)throw Error(signature);let p=source.indexOf('{',s),n=1,e=p+1;while(n){if(source[e]==='{')n++;if(source[e]==='}')n--;e++;}return source.slice(s,e);}
const methods=['private func cancelSubscriptionTimeout()', 'private func startSubscriptionTimeout()', 'func resetSubscriptionRequests()', 'func acceptSubscriptionAck(sessionID:', 'func subscribe(sessionId:', 'func sendRequestPayload(', 'private func send(', 'private func write(', 'private func deferUntilConversationHello(', 'nonisolated static func usesConversationChannel(', 'private func beginConnection(', 'private func openConversationChannel('].map(method).join('\n');
const properties=source.split('\n').filter(l=>/^\s*private var (?:subscription\w*|pendingSubscriptionID|desiredSubscriptionID)\b/.test(l)).join('\n');
const swift=`import Foundation
struct MobileConversationTarget { let parentSessionId:String? }
struct GatewayFrame { let kind:String;var sessionId:String?=nil;var code:String?=nil;var message:String?=nil;var requestType:String?=nil;var requestId:String?=nil;var transferId:String?=nil }
func gatewayApprovalTrace(_ message:String) {}
struct Log { func info(_ value:String){} }
struct UIDevice { static let current=UIDevice();let name="Fixture" }
enum ConnectionState { case disconnected,connecting,connected,failed(String);var isConnected:Bool{if case .connected=self{return true};return false} }
protocol GatewayCredentialStoring:Sendable {func loadOrCreateDeviceID()async throws->String;func loadToken(for:URL)async throws->String?}
actor Credentials:GatewayCredentialStoring { let delay:Duration;init(_ delay:Duration){self.delay=delay};func loadOrCreateDeviceID()async throws->String { try await Task.sleep(for:delay);return "fixture" };func loadToken(for:URL)async throws->String?{"fixture"} }
@MainActor final class GatewayClient {
 ${properties}
 private static let presetLogger=Log()
 private static let maximumIncomingMessageSize=64*1024*1024
 private let channel:String
 private let credentials:any GatewayCredentialStoring
 private let heartbeatInterval:Duration
 private let probeTimeout:Duration
 private let subscriptionTimeoutInterval:Duration
 private var state:ConnectionState = .disconnected
 private var isApplicationInBackground=false
 private var wantsConnection=false
 private var isManualPairingAttempt=false
 private var reconnectAttempt=0
 private var probeOnly=false
 private var isRecoveringFromBackground=false
 private var pairingCode:String?
 private var lastReportedFailure:String?
 private var endpoint:URL?
 private var credentialID:String?
 private var expectedGatewayID:String?
 private var trustedEndpoints:[String]=[]
 private var conversationClient:GatewayClient?
 private var connectionPreparationTask:Task<Void,Never>?
 private var connectionTimeoutTask:Task<Void,Never>?
 private var receiveTask:Task<Void,Never>?
 private var outboundTask:Task<Void,Never>?
 private var connectionGeneration=UUID()
 private var pendingConversationPayloads:[String]=[]
 private var pendingConversationBytes=0
 private var socket:URLSessionWebSocketTask?
 private let transportSession=URLSession(configuration:.ephemeral)
 private var onTransportFailure:((String,Bool)->Void)?
 var requestDecorator:((String)->String?)?
 var conversationTarget:((String)->MobileConversationTarget?)?
 var onFrame:((GatewayFrame)->Void)?
 var helloReceived=false
 var acknowledgements:[String?]=[]
 var incomingHistory=0
 var timedOut:[String]=[]
 private struct RequestEnvelope:Decodable{let type:String}
 init(channel:String="control",credentials:(any GatewayCredentialStoring)?=nil,heartbeatInterval:Duration = .seconds(30),probeTimeout:Duration = .seconds(5),subscriptionTimeoutInterval:Duration = .milliseconds(700)) {self.channel=channel;self.credentials=credentials ?? Credentials(.zero);self.heartbeatInterval=heartbeatInterval;self.probeTimeout=probeTimeout;self.subscriptionTimeoutInterval=subscriptionTimeoutInterval}
 func setupControl(_ url:URL) { endpoint=url;state = .connected;wantsConnection=true;onFrame={ [weak self] frame in guard let self else{return};if frame.kind=="subscribed" { acknowledgements.append(frame.sessionId);_ = acceptSubscriptionAck(sessionID:frame.sessionId) };if frame.code=="subscription-timeout" { timedOut.append(frame.sessionId ?? "nil") } } }
 func openSplit(){openConversationChannel()}
 func close(){conversationClient?.disconnect(reconnect:false);disconnect(reconnect:false)}
 func waitHello()async {for _ in 0..<100 {if conversationClient?.helloReceived==true{return};try? await Task.sleep(for:.milliseconds(10))}}
 func history(_ id:String){send(["type":"history","sessionId":id])}
 func snapshot()->(Bool,Int,Int){(conversationClient?.helloReceived==true,acknowledgements.count,timedOut.count)}
 private func traceLifecycle(_ event:String){}
 private func startMonitoringNetworkChanges(){}
 private func credentialURL(_ url:URL)->URL{url}
 private func canRetryCredentialAccess(_ e:Error)->Bool{false}
 private func startConnectionTimeout(for socket:URLSessionWebSocketTask){}
 private func applicationDidEnterBackground(){isApplicationInBackground=true}
 private func connect(to raw:String){beginConnection(to:raw,pairingCode:nil,resetReportedFailure:true)}
 private func disconnect(reconnect:Bool=false){connectionGeneration=UUID();connectionPreparationTask?.cancel();connectionPreparationTask=nil;socket?.cancel(with:.normalClosure,reason:nil);socket=nil;state = .disconnected;resetSubscriptionRequests();pendingConversationPayloads=[];pendingConversationBytes=0}
 private func fail(_ text:String,shouldReconnect:Bool,reportFailure:Bool=true){state = .failed(text)}
 private func handleFailure(_ e:Error,socket:URLSessionWebSocketTask)async{print("transport failure",e.localizedDescription)}
 private func receiveLoop(_ socket:URLSessionWebSocketTask)async { do {while !Task.isCancelled {let message=try await socket.receive();let data:Data;switch message {case .string(let text):data=Data(text.utf8);case .data(let value):data=value;@unknown default:continue};let v=try JSONSerialization.jsonObject(with:data) as! [String:Any];let kind=v["kind"] as! String;if kind=="hello"{state = .connected;helloReceived=true;let pending=pendingConversationPayloads;pendingConversationPayloads=[];pendingConversationBytes=0;for payload in pending{sendRequestPayload(payload)}};onFrame?(GatewayFrame(kind:kind,sessionId:v["sessionId"] as? String))}}catch{}}
 ${methods}
}
@main struct Repro {
 @MainActor static func main()async throws {let url=URL(string:CommandLine.arguments[1])!;let mode=CommandLine.arguments[2];let client=GatewayClient(credentials:Credentials(mode.hasSuffix("cold") ? .milliseconds(150):.zero));client.setupControl(url);client.requestDecorator={ payload in
    if mode=="reject" {return nil}
    if mode=="child-cold", var object=try? JSONSerialization.jsonObject(with:Data(payload.utf8)) as? [String:Any],object["sessionId"] != nil {
     object["parentSessionId"]="fixture-parent";object["subagentMode"]="continuable";object.removeValue(forKey:"workspaceId")
     return String(decoding:try! JSONSerialization.data(withJSONObject:object),as:UTF8.self)
    };return payload
   };client.openSplit();if mode=="warm" || mode=="reject" {await client.waitHello()};if mode=="socket-before-hello" {try await Task.sleep(for:.milliseconds(40))};
   if mode=="unsubscribe-cold" {client.subscribe(sessionId:nil)} else {client.subscribe(sessionId:"fixture-session")}
   if mode=="rapid-cold" {client.subscribe(sessionId:"fixture-intermediate");client.subscribe(sessionId:"fixture-latest")}
   client.history("fixture-session");await client.waitHello();try await Task.sleep(for:.milliseconds(850));let snapshot=client.snapshot();print("RESULT mode=\\(mode) hello=\\(snapshot.0) ack=\\(snapshot.1) timeout=\\(snapshot.2)");client.close()}
}
`;
const swiftPath=join(temp,'Repro.swift');const executable=join(temp,'repro');
await writeFile(swiftPath,swift);
execFileSync('swiftc',['-parse-as-library','-swift-version','5',swiftPath,'-o',executable]);
const server=createServer();const ws=new WebSocketServer({server});const requests=[];
ws.on('connection',socket=>{
 const hello=setTimeout(()=>{if(socket.readyState===1)socket.send(JSON.stringify({kind:'hello'}));},100);
 socket.once('close',()=>clearTimeout(hello));
 socket.on('message',raw=>{
  const value=JSON.parse(raw.toString());requests.push(value);
  const kind=['subscribe','unsubscribe'].includes(value.type)?'subscribed':'history';
  socket.send(JSON.stringify({kind,sessionId:value.sessionId??null}));
 });
});
server.listen(0,'127.0.0.1');await once(server,'listening');
try {
 for(const mode of ['warm','cold','socket-before-hello','child-cold','rapid-cold','unsubscribe-cold','reject']){
  requests.length=0;
  const {stdout}=await promisify(execFile)(executable,[`ws://127.0.0.1:${server.address().port}/ws`,mode]);
  assert.match(stdout,/hello=true/,'Conversation hello never completed');
  const expected=mode==='rapid-cold'?2:1;
  if(mode==='reject'){
   assert.match(stdout,/ack=0 timeout=1/,'Installed decorator rejection was bypassed');assert.equal(requests.length,0);
  }else{
   assert.match(stdout,new RegExp(`ack=${expected} timeout=0`),`Subscription lost or timed out (${mode}): ${stdout}`);
   assert.deepEqual(requests.map(value=>value.type),mode==='rapid-cold'?['subscribe','history','subscribe']:mode==='unsubscribe-cold'?['unsubscribe','history']:['subscribe','history'],`FIFO request order changed (${mode})`);
   if(mode==='child-cold')for(const value of requests){assert.equal(value.parentSessionId,'fixture-parent');assert.equal(value.subagentMode,'continuable');}
   if(mode==='rapid-cold')assert.deepEqual(requests.filter(value=>value.type==='subscribe').map(value=>value.sessionId),['fixture-session','fixture-latest'],'Latest intent did not supersede the intermediate target');
  }
  console.log(`PASS native subscription real transport: ${mode}`);
 }
}finally{
 for(const socket of ws.clients)socket.terminate();await new Promise(resolve=>ws.close(resolve));await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});
}
