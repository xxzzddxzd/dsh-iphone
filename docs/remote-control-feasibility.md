# DSH 远程控制可行性评估

> 状态：**评估稿（未实现、未验证）**。目标是在两个已配对的 DSH 实例之间，跨任意网络查看对方任务执行状态并发送指令，类似 Codex 的远程控制。
>
> 本文只做可行性判断与方案设计，不含代码改动。所有“可复用”结论都标注了上游文件路径；标“需实测”的项尚未在真机验证。

## 0. 结论

**技术上可行，且 DSH 的架构比预期友好。** 理由：

1. DSH 的 Client→Host 调用层（Typert Remote）在设计上就是**传输无关**的：上游明确写着 “Replacing the Connection carrier does not require changes to Remote descriptors or the Client programming interface”（`upstream/deepseek-harness/docs/api-gateway.md`）。Electron 桌面版已经用 IPC 替换了 WebSocket，证明非浏览器载具存在先例（`apps/desktop/README.md`、`apps/desktop-host/src/wire.ts`）。
2. **“查看状态 + 发送指令”的动作词表已经存在**，不需要新造业务能力：`session/list`、`session/page`、`session/follow`、`session/control`、`session/prompt`、`session/cancel`、`session/create`、`session/fork`、`session/updateQueue` 等（`packages/api/session-controller/src/index.ts`）。
3. **审批/问答也可远程化**：`approval/request` 与 `user-questions/request` 是有序 waterfall，Host 侧插件可以注册成 answerer（`packages/interaction/user-approval/src/index.ts`、`packages/interaction/user-questions/src/index.ts`）。
4. **配对与密钥存储已有现成 seam**：`ctx.authorization.registerFlow()`（人机对话式取得凭据）+ `ctx.credentials`（原子持久化到 `$DSH_HOME/.credentials.yaml`）。
5. **手机侧的状态展示已经做好了一半**：iOS 通知与 Live Activity 已覆盖 turn 结束、审批、提问、goal 完成/阻塞（`dsh-iphone/docs/notifications.md`）。
6. **依赖已就位**：`ws` 已随 `dsh-api-gateway` 打进 iPhone 运行时；iOS Node 自带 OpenSSL（`--openssl-no-asm`），TLS/X25519/AES-GCM 理论可用（需实测）。

**真正的难点不是“能不能看到会话”，而是三件事：**

- **网络安全模型**：DSH 的 `/api` 是 RCE 级接口（bash、文件读写、设置、凭据），项目已**故意禁止** `--host 0.0.0.0`（`packages/bundle/web-app/src/startup.ts`）。绝不能靠“把 3080 暴露到公网”来实现。
- **任意网络的连通性**：两端大概率都在 NAT/运营商大内网之后，需要中继（relay）或隧道；DSH 本身没有中继、没有 TLS。
- **UI 工作面**：浏览器端是**单 Host 假设**（`ctx.connection` 单例、单 generation source），要在一个 GUI 里看两个 DSH，必须做桥接或加法式 UI 层。

一句话：**能力齐备，缺的是“一条受控的、配对后的、窄接口的链路”和“一个加法式的远程面板”。**

## 1. 需求拆解

| 需求 | 说明 | 对应 DSH 现有能力 |
| --- | --- | --- |
| 配对 | 两端通过一次性码/二维码互认，之后长期免配置 | `ctx.authorization` + `ctx.credentials` |
| 任意网络 | 不依赖同一 LAN、不依赖公网入站端口 | 需新建（relay/隧道），DSH 无此能力 |
| 查看任务状态 | 会话列表、运行中/空闲、当前工具、最近输出、goal | `session/list`、`session/follow`、`session/control`、`agent/status`、`api-session/status` |
| 发送指令 | 发新 prompt、追加/纠偏、取消 | `session/prompt`、`session/updateQueue`、`session/cancel` |
| 处理阻塞 | 审批、提问、计划确认 | `approval/request`、`user-questions/request` waterfall |
| 通知到手机 | 后台/锁屏也能看到进展 | 已有本地通知 + Live Activity；跨设备需链路转发 |

## 2. 现有地基（可复用，附证据）

| 能力 | 位置 | 可复用程度 |
| --- | --- | --- |
| Remote 传输无关 | `docs/api-gateway.md`；`packages/client/connection/src/rpc.ts` 的 `ClientConnectionRpc.call/open` | 高：只需换载具 |
| 非浏览器载具先例 | `apps/desktop/README.md`（无监听端口、framed pipe）；`apps/desktop-host/src/wire.ts` | 高：抄它的思路 |
| 会话控制 API | `packages/api/session-controller/src/index.ts`（`@Remote` 标注处） | 高：白名单直接复用 |
| 实时状态流 | `session/follow`、`session/control`（`SessionControlFrame`: baseline/queue/jobs/projection） | 高 |
| 审批 answerer | `packages/interaction/user-approval/src/index.ts`（`ctx.waterfall(...,'approval/request',...)`） | 高：Host 侧即可接管 |
| 提问 answerer | `packages/interaction/user-questions/src/index.ts` | 高 |
| 配对/凭据 | `packages/credentials/authorization/README.md`、`ctx.credentials` | 高 |
| 路由注册 | `packages/host/webserver/src/index.ts`（`register` / `registerUpgrade`） | 高：可挂独立链路端点 |
| 浏览器事件转发 | `packages/api/remotes/src/remote-events.ts`（`$events` 白名单） | 中：参考其取舍 |
| 手机状态展示 | `dsh-iphone/docs/notifications.md`（通知 + Live Activity + 深链接） | 中高：可扩展为展示远程会话 |
| 加法式 UI 层 | `dsh-iphone/web/mobile-shell.js`（DOM 观察，不改官方 bundle）、`web/index.ios.html` | 高：远程面板可走同一 seam |

## 3. 关键约束（决定了不能怎么干）

1. **`--host 0.0.0.0` 被故意封禁**
   `packages/bundle/web-app/src/startup.ts` 明确报错：`it would expose remote code execution to the network`。配置层虽可绑全网卡，但那是绕开守卫，不该作为方案基础。

2. **`/api` 的暴露面 = 目标机器的完全控制**
   除会话外还包括 `bash`、文件读写（`/api/file?path=` 可读任意文件）、设置与凭据命名空间、Cordis 动态包等。把它开给网络，等于把目标机交出去。

3. **认证是浏览器 Cookie，不是 Bearer**
   `packages/client/connection/README.md` 与 `dsh-iphone/docs/web-authentication.md`：`/api` 不接受 query token 或 Authorization 头；Cookie 绑定 hostname+port。**headless 的 peer 客户端无法复用这套认证**，必须另设设备密钥。

4. **DSH 不带 TLS**
   `packages/host/webserver/README.md`：server 自身不提供 TLS/认证/来源策略。任何跨公网直连都需要外部 TLS 终结。

5. **浏览器端单 Host**
   `ctx.connection` 是单例、单 generation source；`ctx.remote` 挂载的是单一 Host 的命名空间。让浏览器同时直连两个 DSH，需要改核心 client 包，与 iphoneds “不覆盖官方 UI/逻辑” 的原则冲突。

6. **iPhone 没有服务端推送通道**
   现有通知是**本机进程观察本地会话事件**后发的本地通知，没有 APNs。跨设备推送需要服务器 + 证书，是另一个量级的工程。

## 4. 三种候选架构

| 方案 | 做法 | 工作量 | 安全性 | iPhone 适配 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A. 反向代理远程 GUI** | 用隧道/中继把 B 的 3080 暴露出去，A 的浏览器直接打开 B 的 GUI | 低 | **差**：暴露完整 RCE 面 + Cookie 认证 | 一般 | 只适合临时调试，不做产品 |
| **B. 窄接口对等互联（推荐）** | 两端各装一个 link 插件；B 只对配对 peer 暴露“会话状态 + 指令 + 审批”白名单；A 把 peer 会话搬进自己的远程面板 | 中高 | 好：不碰 `/api`，E2E，可撤销 | 好：复用通知/UI seam | **推荐** |
| **C. 复用完整 Remote 协议** | A 的 Host 内跑一套 DSH client 图，直连 B 的 `/api`，再整体代理给浏览器 | 高 | 中：等于把 `/api` 给了 peer，且 client 图是 web 平台限定 | 差（依赖上游内部结构） | 不推荐 |

**为什么排除 C**：`@deepseek-ai/dsh-client-connection` / `dsh-api-remotes/client` 都声明 `platform: "web"`，在 Host（Node）里跑属于越界用法；且上游 Typert 生成物没有稳定性承诺，iphoneds 每次升级都要重新审计（`docs/updating.md`），耦合越深越难维护。

## 5. 推荐方案：DSH Link（窄接口对等互联）

### 5.1 目标端 B：link-host 插件

- **不修改 DSH webserver 绑定**，也**不碰 `/api`**。链路走**独立监听端口**（`ctx.webServer.registerUpgrade()` 另开一条路径，或插件自己起一个 `node:http` 监听），默认仍是回环；只有链路端口在需要时对外。
- **优先出站（outbound-only）**：B 主动连 A 或连中继，天然穿 NAT，不需要公网入站端口。也支持“B 监听、A 连入”的直连模式（同 LAN/VPN/隧道场景）。
- **暴露的能力白名单**（全部复用 Host 侧服务，不新增业务逻辑）：
  - `listSessions` → `ctx.sessionController` 列表（标题、运行中/空闲、当前工具、最近可见文本、goal、更新时间）
  - `followSession(id)` → `session/follow` + `session/control` 的投影，产出精简状态增量
  - `prompt(id, content)` / `steer(id, content)` / `cancel(id)` → `session/prompt` / `updateQueue` / `cancel`
  - `createSession(...)` / `fork(id)` → 可选
  - `approve(decision)` / `answerQuestion(...)` / `confirmPlan(...)` → 注册 `approval/request`、`user-questions/request` 的 waterfall listener，把问题转发给 peer 并等待回答；**超时/断线一律回落到 `unavailable`（fail-closed）**
  - 明确**不暴露**：bash、fs、settings、credentials、cordis、directory-picker
- **审计**：每次远程 prompt / 审批决定都写一条本机可查的会话事件或日志。

### 5.2 控制端 A：link-client 插件 + 远程面板

- link-client 维护到 B（或中继）的出站 WebSocket，缓存 peer 的会话摘要与状态流。
- **对浏览器只暴露 A 自己的窄接口**（两种实现都行）：
  - 定义一个新的 Typert Remote 命名空间（走官方 codegen，类型最好，但要动构建）；
  - 或走 `connection` 的 exact Fetch 路由 + SSE（`packages/api/README.md` 提到 feature 包可注册非 JSON/流式路由），**v1 更省事**。
- **UI 用加法式 seam**，沿用 iphoneds 现有做法（`web/mobile-shell.js` + `index.ios.html`）：新增一个“远程 / Peers”面板，展示：
  - peer 列表与在线状态；
  - peer 会话列表（运行中/空闲/阻塞/等待审批）；
  - 选中后的实时状态流与对话摘要；
  - 输入框（发送指令）、取消按钮、审批/提问的应答按钮。
- 若要走官方侧栏 slot（`ui-slots`/`ui-sidebar`）也可，但需要进 client 插件图；DOM 层方案与 iphoneds 现状一致、升级风险更低。

### 5.3 配对

1. B 侧发起 `ctx.authorization.registerFlow({ key: credentialKey('dsh-link', peerId), ... })`，生成一次性配对码。
2. A 侧输入/扫码，双方用 X25519 ECDH 建立共享密钥（`node:crypto`）。
3. 双方把对方设备公钥 + 昵称 + 中继房间写在 `ctx.credentials`（`dsh-link/<peer>`），支持列示与撤销。
4. 之后握手即用长期设备密钥（可加 TLS 或 Noise 风格握手），配对码仅用于首次。

### 5.4 任意网络的连通性选择

| 选项 | 说明 | 代价 | 适用 |
| --- | --- | --- | --- |
| **N1 中继服务** | 一个极小的 WS 中继（自建 VPS / Cloudflare Worker+Durable Object / 甚至第三个 DSH 作 hub）；两端都出站连它，消息 E2E 加密，中继只见密文 | 需要一台常在线机器 | **推荐**，最稳、穿 NAT |
| **N2 叠加网** | Tailscale/WireGuard 组私有网，链路直接互联 | Mac 侧简单；iOS 需 NetworkExtension，本项目明确无 TUN | Mac↔Mac 可以；iPhone 困难 |
| **N3 反向隧道** | 用现成隧道（Cloudflare Tunnel / frp / SSH -R）把链路端口发布出去 | 依赖第三方，需 TLS 终结 | v1 快速验证可以，长期不如 N1 |

**建议**：链路协议从一开始就设计成“可直连、可中继”，v1 先用 N3/同 LAN 打通正确性，v2 补 N1。

## 6. 安全模型（必须写进设计）

1. **远程 prompt = 间接 RCE**。即使只暴露 `session/prompt`，peer 也能让目标 agent 执行 bash/改文件。因此：
   - B 的 `approval` 策略必须保持权威，**不允许 peer 绕过审批**；
   - 建议给“来自 peer 的会话/指令”绑定受限 permission preset / sandbox（`dsh-permission-presets`、`dsh-sandbox-policy`）；
   - 是否允许 peer 自主创建新会话，应由 B 侧用户显式开关。
2. **最小暴露面**：只开白名单方法，绝不代理 `/api`。
3. **认证与加密**：设备密钥 + E2E（X25519 + HKDF + AES-256-GCM）；中继零知识。DSH 无 TLS，公网直连必须外部终结或直接 E2E。
4. **撤销与审计**：`ctx.credentials` 删记录即撤销；每次远程操作在本机留痕。
5. **默认关闭**：link 插件默认不监听、不出站，必须显式配对后才工作；与 DSH “fail-closed” 的既有姿态一致。
6. **升级纪律**：新插件必须按 `docs/updating.md` 的 SOP 随上游版本重新审计；只依赖稳定的 Host 服务（`sessionController`、`authorization`、`credentials`、`webServer`）与事件，不依赖 Typert 生成物内部结构。

## 7. iPhone 侧约束与需实测项

| 项 | 现状 | 待验证 |
| --- | --- | --- |
| 常驻 | rootless launchd `ai.deepseek.dsh`，`KeepAlive` + `ProcessType Interactive`（`device-scripts/ai.deepseek.dsh.plist`） | 长连接出站是否稳定 |
| 后台/锁屏 | 现有认证文档要求“保持手机解锁” | 锁屏后 WS 是否被挂起、重连表现 |
| crypto/TLS | iOS Node 自带 OpenSSL（`--openssl-no-asm`，`device-scripts/build-node22-ios.sh`） | X25519/HKDF/AES-GCM 与出站 TLS 实测 |
| WebSocket | `ws@8` 已在 `dsh-runtime/node_modules`，官方 gateway 在用 | 复用即可 |
| 状态展示 | 通知 + Live Activity + session 深链接已实现 | 是否把“远程 peer 状态”也接入通知 |
| 前端兼容 | Safari 16.1 兼容层 13 | 新面板不能引入不支持语法 |
| 推送 | 无 APNs，仅本地通知 | 跨设备“后台推送”本期不承诺 |

## 8. 工作量与里程碑（粗略，单人）

| 阶段 | 内容 | 估计 |
| --- | --- | --- |
| M0 前置验证 | iOS Node 上 X25519/AES-GCM + 长连接 WS 冒烟；确认 `sessionController` 在插件内可读列表/流 | 2–4 天 |
| M1 直连对等 | Mac↔Mac（或同 LAN）link-host/link-client + 配对 + 列表/状态/发指令（无审批） | 1–2 周 |
| M2 远程面板 | 加法式 UI 面板（peer 列表、会话列表、状态流、输入框、取消） | 1–2 周 |
| M3 审批/问答 | 把审批与提问接到 peer，含超时 fail-closed | 3–5 天 |
| M4 任意网络 | 中继服务 + E2E + 重连/漫游 + TLS 终结 | 2–4 周 |
| M5 iPhone 验收 | 真机常驻、锁屏、通知接入、升级 SOP | 1–2 周 |

整体：**M1–M2 是“可演示”的门槛（约 3–4 周）**；到“任意网络 + 手机稳定可用”大约 **2–3 个月**，并且需要一台常在线中继。

## 9. 主要风险

- **安全**：远程 prompt 的间接 RCE，若审批策略设计不当，等于给 peer 开了后门。
- **上游耦合**：目标运行时已升级到 DSH 0.2.0-rc.2；远程控制方案需按 v4 会话及当前内部服务、事件验证；升级需要重新审计（项目已有严格 SOP）。
- **网络成本**：真正“任意网络”需要中继，多一台机器与运维。
- **iOS 不确定性**：后台长连接、锁屏网络、crypto 实测结果可能改变设计。
- **与官方 UI 的兼容**：DOM 层方案轻但脆弱（依赖 class 名），官方 slot 方案稳但要进插件图。

## 10. 需要确认的问题

1. **拓扑**：主要是 iPhone→Mac，还是 Mac↔Mac，还是要任意两端互相控制？
2. **中继**：有没有一台可控的常在线机器/VPS？能否接受部署一个极小的中继？还是先用 Tailscale/隧道？
3. **权限范围**：peer 只允许“看 + 对已有会话发指令”，还是也能新建会话、审批、fork？
4. **是否坚持窄接口**：如果不接受远程 prompt 触发的间接 RCE 风险，是否要求所有 peer 会话默认只读/需本机逐条审批？
5. **UI 形态**：可以接受 iphoneds 现在这种加法式 DOM 面板，还是必须做成官方插件侧栏？

---

### 附：本评估未能覆盖的部分

- 未能联网核对 OpenAI Codex “远程控制”的**确切**产品形态（本机 `web_search` 走的 Codex provider 未登录，`dsh openai-codex login` 后可复查）。本文按需求描述（配对、跨网、看状态、发指令）建模，而非逐条对齐 Codex。
- 未做任何真机/协议实验，M0 的验证项都还是假设。
