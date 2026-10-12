#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { UpgradeHost, compareBaseline, validateSmokeFrames } from "./upgrade-host.mjs";

const target = process.argv[2];
if (!["mac", "iphone"].includes(target) || process.argv.length !== 3) throw new Error("usage: smoke-upgrade-host.mjs mac|iphone");
const sessionId = `session-upgrade-${target}-${randomUUID()}`;
const marker = `DSH_UPGRADE_SMOKE_${randomUUID().replaceAll("-", "")}`;
let host, originalPermission, permissionChanged = false, restored = false;
try {
  host = await UpgradeHost.connect(target);
  const before = await host.health();
  if (before.running) throw new Error("Host has active sessions; wait before validation");
  await host.rpc("session/create", { request: { cwd: "/tmp", sessionId, agentPreset: "minimal" } });
  await host.rpc("session/rename", { request: { sessionId, title: `DSH ${target} 升级验收` } });
  const snapshot = await host.snapshot(sessionId);
  originalPermission = snapshot.projections?.values?.permissions?.currentValue;
  if (typeof originalPermission !== "string" || !/^[a-z][a-z0-9-]*$/.test(originalPermission) || originalPermission === "custom") throw new Error("Cannot restore the new test session's permission preset safely");
  const command = async preset => {
    const result = await host.rpc("commands/execute", { agentId: sessionId, line: `/permission ${preset}`, submittedAttachments: [] });
    if (result?.result.kind !== "success") throw new Error("Test-session permission command failed");
  };
  if (target === "iphone" && originalPermission !== "danger-full-access") {
    await command("danger-full-access");
    permissionChanged = true;
  }
  const frames = [];
  let snapshotReady, rejectSnapshot;
  const ready = new Promise((resolve, reject) => { snapshotReady = resolve; rejectSnapshot = reject; });
  const follow = host.stream("session/follow", { request: {
    address: { kind: "session", sessionId }, maxMessages: 1, assistantStream: true,
  } }, frame => {
    frames.push(frame);
    if (frame.type === "snapshot") snapshotReady();
    if (frame.type === "event" && frame.event.type === "turn/end") return true;
  }, 240000);
  follow.result.catch(rejectSnapshot);
  await ready;
  const bash = `printf '%s\\n' '${marker}'; exit`;
  await host.rpc("session/prompt", { request: {
    requestId: randomUUID(), sessionId, mode: "queue", clientTimeZone: "Asia/Shanghai",
    content: [{ type: "text", text: `这是升级验收。请只调用一次 Bash，执行以下命令，然后简短回复结果：\n${bash}\n不要读写其他文件、联网、创建目标或子代理。exit 用于关闭本次测试的 shell。` }],
  } });
  await follow.result;
  const result = validateSmokeFrames(frames, marker);
  if (permissionChanged) { await command(originalPermission); restored = true; }
  compareBaseline(before, await host.health());
  console.log(JSON.stringify({ target, status: "passed", sessionId, ...result, permissionsRestored: !permissionChanged || restored }));
} catch (error) {
  console.error(JSON.stringify({ target, status: "failed", sessionId, reason: error.message }));
  process.exitCode = 1;
} finally {
  if (permissionChanged && !restored && host) {
    try {
      const result = await host.rpc("commands/execute", { agentId: sessionId, line: `/permission ${originalPermission}`, submittedAttachments: [] });
      if (result?.result.kind !== "success") throw new Error("permission restore rejected");
    } catch {
      console.error(`Only test session ${sessionId} needs cleanup: close its PTY, then restore /permission ${originalPermission}.`);
      process.exitCode = 1;
    }
  }
  host?.close();
}
