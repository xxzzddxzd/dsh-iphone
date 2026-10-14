# DSH 与 Safari 16 兼容层

DSH 0.2.0-rc.2 要求 Node 22，但它的 npm 闭包和 Web 前端默认面向桌面系统及更新浏览器。本项目只修改发布包，不修改或伪装官方 Git 子模块。

可选 Provider bundle 的已验证配套版本为 `dsh-codex 0.2.9`；该版锁定
pi-ai `1.2.0`，提供 GPT-6.1 Sol、GPT-6 Astra、Grok 4.6 与 xAI Imagine 2.0 / Quality。旧的
`0.2.5-iphone.*` 已停止维护平台分支。该版本的 Google
Code Assist 路由复用 `@kelvinwww/dsh-oauth 0.1.1`，并强制其 gaxios 传输使用
Node 原生 fetch，以接入 DSH 的 provider 级 VLESS dispatcher。Kelvin 的 Google
实现和 Google 客户端在构建时内联，所有 DSH 接口保持 external，避免它依赖的旧版
模块被 pnpm 安装到 0.2.0 profile。

Provider bundle 使用独立路由 `provider-codex`、`provider-xai` 与
`provider-google`；“模型”页配置的 `openai-codex`、`xai` API Key 路由保持原名，
两套认证可以同时存在，不会再由同名 adapter 抢占请求。未登录的 OAuth Provider
不会出现在聊天模型选择器中，登录和退出会即时加入或移除对应模型路由。

## 服务端兼容

Provider 子页支持逐模型显示开关、上下文窗口和最大输出 tokens，设置持久化于 `dsh_codex_provider_models` storage domain。留空恢复默认；Codex 的输出上限受其后端限制，不能保证按该值截断。

| 组件 | iOS 问题 | 处理方式 |
| --- | --- | --- |
| `sharp` | 官方 native/libvips 产物不能在 iPhoneOS 加载 | 用 [`ios-sharp-shim.mjs`](../shims/ios-sharp-shim.mjs) 接到原生 ImageIO/CoreGraphics helper，实现 DSH 使用的校验、方向、缩放、色彩与编码调用面 |
| `koffi` | Win32 FFI 模块没有 iOS native binding | 上游改为首次 Win32 操作时才加载；保留官方延迟加载和平台隔离，不再给运行时安装 stub |
| `flock` | `node-addon-system` 只接受 linux/darwin；随包的 darwin-arm64 `system.node` 是 macOS Mach-O，iOS 上 `dlopen` 失败，session resume 报 `flock is not supported on ios-arm64` | 用官方 `flock.c` 交叉编译 iPhoneOS arm64 的 `prebuilds/ios-arm64/system.node`，并让 `loadBinding()` 在 `platform === "ios"` 时加载它 |
| `node-addon-require-builtin` | 新版 profile loader 需要 Node 内部模块加载器，npm 没有 iOS 原生产物 | 从锁定的官方 0.1.6 源码编译 N-API v9，安装到官方 loader 支持的 iOS local-build 路径，并由 postinst 签名 |
| profile HMR | CLI 的 HMR 实现已拆入 `dsh-hmr` | 使用官方实现，移除旧 `profile-boot` loader guard |
| node-pty | npm 未提供 iPhoneOS native 产物，SDK 未声明 `openpty` | 使用上游 Apple `posix_spawn` 后端，为 iPhoneOS 编译 `pty.node` 和 `spawn-helper`，并补充缺失的 SDK 声明 |
| Bash 默认路径 | 新版 terminal-bash 默认启动 `/bin/bash`，rootless iOS 没有此路径 | iOS 默认启动 `/var/jb/bin/bash`；显式指定的 shell 路径继续优先 |
| subprocess terminal inspector | 新版只接受 linux/darwin/win32，Bash 在 iOS 创建 PTY 前失败 | iOS 使用设备 `/bin/ps` 已验证的 BSD `pid/ppid/lstart/tpgid` 字段，复用官方 POSIX inspector；保留 PID 与启动时间配对、进程树和信号前身份复核 |
| HTML 缓存 | Safari 会继续使用旧入口或旧 module graph | index 与 SPA fallback 返回 no-cache header，并给 bundle 增加 compatibility 查询参数 |
| 通知深链接 | 通知 URL 只知道 session，Web 默认恢复上次选择 | compatibility 17 在 module 启动前把 URL 参数写入 `dsh.sessions.current` |
| 主屏幕图标 | Safari 只看到通用 favicon 时会生成模糊或不合适的快捷方式图标 | 提供 180px 白底黑鲸鱼 `apple-touch-icon`，由 iOS 应用主屏幕圆角 |

图片兼容层使用包内的 ImageIO/CoreGraphics helper 完成 PNG、JPEG、WebP 和 GIF 解码、方向校正、sRGB 转换、缩放以及 PNG/JPEG 编码。透明图片保留为 PNG；不透明图片按上游预算选择 PNG 或 JPEG。该后端只实现 DSH 附件模块当前使用的 `sharp` 调用面，升级附件模块时必须重新核对。

Node iOS 构建报告 `process.platform === "ios"`，因此两个 node-pty 产物安装到 `prebuilds/ios-arm64/`，不能只放在 macOS 使用的 `darwin-arm64/`。

`node-addon-require-builtin` 使用独立锁定的 `node-addon-api 8.9.0` 头文件，与 node-pty 的 7.1.1 分开构建。官方源码、N-API ABI 校验和运行时探测保持原样，不猜测 Node 内部偏移。rootless iOS 阻止从 `/var/tmp` 映射可执行代码，`dsh22` 使用官方 `NARB_DISABLE_NATIVE_CACHE=1` 开关直接加载 `/var/jb` 下的签名模块，并移除旧的 `--expose-internals` 参数。Mac 继续使用官方 macOS 产物。

## Safari 16 兼容

iOS 上的 Chrome 仍使用 WebKit，因此更换 Chrome 不能绕过 Safari 16 的 JavaScript 能力边界。compatibility 17 入口在任何 DSH module 执行前提供：

- `Promise.withResolvers`
- `Array.prototype.toSpliced`
- `Array.prototype.toReversed`
- `Array.prototype.toSorted`
- `Array.prototype.with`
- `Array.prototype.findLast` 与 `findLastIndex`
- `AbortSignal.timeout`
- `AbortSignal.any`
- `structuredClone`
- `crypto.randomUUID`

另外，GFM email autolink 中的 RegExp lookbehind 会让 Safari 16 在解析整个 vendor bundle 时失败。补丁去除该 lookbehind，同时保留调用方已有的 email 边界检查。主 bundle 对 vendor 的 import 使用 `?ioscompat=17`，避免旧 module cache 继续返回解析失败的文件。

0.2.0 主 bundle 和文档预览 bundle 使用 class static block，Safari 16.1 无法解析。构建时使用锁定的 esbuild 0.27.0 转成 `safari16.1` 语法；从锁定的官方产物重现输出并进行比较。文档预览还在初始化时访问 `Iterator.prototype`，入口先加载 core-js 3.50.0 的标准 API polyfill，再启动官方 module graph。依赖锁文件位于 `tools/frontend`。

布局、侧栏、对话和设置组件直接使用 DSH 0.2.0 官方产物，验证脚本逐字节比较 staging tree 与锁定 npm 包。`web/mobile-shell.js` 和 `.css` 恢复原有手机交互：1024px 以下的浮动抽屉、单一鲸鱼入口、完整对话宽度、遮罩/Escape 收起、安全区留白，以及窄屏设置面板。桌面宽度保持官方布局。升级时检查 mobile shell 依赖的 CSS module 类名，并在真机验证收起/展开后的对话宽度及触摸目标。

compatibility 17 将手机输入控件的字号下限设为 16px，避免 iOS 聚焦小字输入框时自动放大，同时保留更大的用户字号和手动缩放。发送操作清空草稿后收起键盘，并在键盘动画结束时恢复输入前的页面位置；中文候选确认、Shift+Enter 换行和仍保留草稿的操作不触发发送后的收起。

`web/connection-recovery.js` 为 iOS 页面补充连接恢复：回到前台、恢复缓存页面或网络返回时，通过官方 `connection.reconnect()` 重建事件订阅；页面可见且已连接时，每 15 秒在同一条 WebSocket 上打开只读的 `session/control` 流，收到首个 baseline 后立即取消。5 秒内无响应则触发重连，由官方会话游标补齐历史。后台期间暂停检测，正常握手和退避期间也不另起重连。恢复保留页面和输入草稿，不重新提交用户消息。浏览器的离线提示不再暂停与手机本机 Host 的连接。

DSH 0.2.0 已修复 WebKit 的 JSON 原型校验：原生构造函数与同一引擎的 intrinsic 比较。该校验保持官方发布包原样；删除旧的源码字符串空白归一化补丁。`tests/test-ios-json-values.mjs` 在真实发布包校验器上验证 Safari/V8、跨 realm 对象及非法值拒绝行为。

入口还识别 `session`、`parent` 与 `mode` 查询参数。合法参数会同步写入 Web runtime 已有的 `dsh.sessions.current` localStorage 项，然后从地址栏清除；module graph 随后按普通的恢复选择流程打开根 session 或带父地址的 subagent session。URL 不含设置、凭据或消息正文。

这几类历史错误应由兼容层消除：

```text
AbortSignal.any is not a function
authorityMessages.toReversed is not a function
Array.prototype.toSpliced is not a function
Invalid regular expression: invalid group specifier name
```

首次使用先完成 [Web 认证](./web-authentication.md)。入口自身携带 compatibility 17 资源版本，认证后可直接访问：

```text
http://127.0.0.1:3081/
```

Safari 会长期缓存已添加到主屏幕的图标。图标资源升级后，现有快捷方式通常不会自动换图；删除旧快捷方式，再从带当前 compatibility 参数的页面重新“添加到主屏幕”即可。

## 严格补丁器

[`scripts/patch-dsh.mjs`](../scripts/patch-dsh.mjs) 先验证以下版本，再对每个预像执行“一次且仅一次”替换：

```text
@deepseek-ai/dsh 0.2.0-rc.2
@deepseek-ai/dsh-* 0.2.0-rc.2
node-pty 1.2.0-beta.15
node-addon-api 7.1.1
```

它还锁定 0.2.0 的 hashed bundle 文件名和原始 `index.html` SHA-256。脚本可以重复运行；已修改文件只会被验证，不会重复插入。验证现有 staging tree：

```bash
node scripts/patch-dsh.mjs --root build/dsh-runtime --check
```

## 权限与并发提示

`permission preset read-only` 不是 iOS 兼容错误。`read-only` 预设允许对话和不依赖进程沙箱的读取，但会拒绝写文件或提升权限操作。iOS 没有 DSH 当前支持的 `bubblewrap`、Landlock、`sandbox-exec` 或 Windows ACL 后端，因此 `Workspace Write` 下的 Bash 会拒绝无沙箱执行。确实需要 Bash 时，只能由用户明确选择 `Full access` 或批准单次提升；本项目不会静默绕过该权限边界。

`prompt reject (agent-busy)` 表示该会话中的 agent 仍在处理上一轮请求。等待当前轮结束，或新建独立会话；重复点击发送不会提高并发能力。

## Node 18 会话迁移

Node 本身不持有 DSH 会话。只要 DSH 版本和持久化格式兼容，Node 18 与 Node 22 的启动器可共同使用 `/var/root/.dsh`。本项目不包含 Node 18 时期的 `zstd`、TypeScript strip 或 Node API polyfill，因为它们在 Node 22 主路径中不再需要。

迁移前备份：

```bash
ssh -p 22 root@10.99.1.41 'cp -a /var/root/.dsh /var/root/.dsh.before-node22'
```

## Provider 设置与历史迁移

`dsh-codex 0.2.9` 对齐全部 DSH peer 为 `0.2.0-rc.2`，锁定 pi-ai `1.2.0`。Provider 模型显示、容量、图片工具和 VLESS 设置使用官方 `storage.domain`，消费者同时注入 `storage` 与 `storageDomain`，防止真实插件作用域拒绝访问存储 hub。首次从 `settings.yaml` 或官方重命名后的 `settings.yaml.imported` 导入，后续写入等待持久化完成，保留原文档。组件端点报告持久化设置就绪状态，部署必须通过实际保存与重读检查。Cline Pass 使用已支持 Config volatile 字段的 `0.2.8`。

官方 Session writer 为 v4。历史恢复工具使用当前发布包提供的冻结 `historicalSessionFormatCatalog` 生成 v3 中间世代，再由官方持久化层收集真实子会话事实并完成 v3 → v4，不向缺少子会话事实的迁移器传入伪造的空数组。

Provider 安装包包含从共享 checkout 的 pnpm lock 生成的生产依赖闭包；只包含 JavaScript 依赖，DSH peer 仍由当前 Host 提供。手机使用 `--offline` 安装，不再依赖设备端 npm 连通性。新版官方 PTC 调度器统一将图片结果加入模型上下文，Provider 移除旧的重复注入。
