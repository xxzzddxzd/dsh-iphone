# DSH 与 Safari 16 兼容层

DSH 0.1.5-rc.1 要求 Node 22，但它的 npm 闭包和 Web 前端默认面向桌面系统及更新浏览器。本项目只修改发布包，不修改或伪装官方 Git 子模块。

可选 Provider bundle 的已验证配套版本为 `dsh-codex 0.2.6`；该版锁定
pi-ai `0.85.1`，提供 GPT-6 Astra、Grok 4.6 与 xAI Imagine 2.0 / Quality。旧的
`0.2.5-iphone.*` 已停止维护平台分支。该版本的 Google
Code Assist 路由复用 `@kelvinwww/dsh-oauth 0.1.1`，并强制其 gaxios 传输使用
Node 原生 fetch，以接入 DSH 的 provider 级 VLESS dispatcher。Kelvin 的 Google
实现和 Google 客户端在构建时内联，所有 DSH 接口保持 external，避免它依赖的旧版
模块被 pnpm 安装到 0.1.5 profile。

Provider bundle 使用独立路由 `provider-codex`、`provider-xai` 与
`provider-google`；“模型”页配置的 `openai-codex`、`xai` API Key 路由保持原名，
两套认证可以同时存在，不会再由同名 adapter 抢占请求。未登录的 OAuth Provider
不会出现在聊天模型选择器中，登录和退出会即时加入或移除对应模型路由。

## 服务端兼容

Provider 子页支持逐模型显示开关、上下文窗口和最大输出 tokens，设置持久化于 `provider-models` 命名空间。留空恢复默认；Codex 的输出上限受其后端限制，不能保证按该值截断。

| 组件 | iOS 问题 | 处理方式 |
| --- | --- | --- |
| `sharp` | 官方 native/libvips 产物不能在 iPhoneOS 加载 | 用 [`ios-sharp-shim.mjs`](../shims/ios-sharp-shim.mjs) 接到原生 ImageIO/CoreGraphics helper，实现 DSH 使用的校验、方向、缩放、色彩与编码调用面 |
| `koffi` | Win32 FFI 模块没有 iOS native binding | Win32-only 路径改用 fail-closed 的 [`ios-koffi-stub.mjs`](../shims/ios-koffi-stub.mjs) |
| `flock` | `node-addon-system` 只接受 linux/darwin；随包的 darwin-arm64 `system.node` 是 macOS Mach-O，iOS 上 `dlopen` 失败，session resume 报 `flock is not supported on ios-arm64` | 用官方 `flock.c` 交叉编译 iPhoneOS arm64 的 `prebuilds/ios-arm64/system.node`，并让 `loadBinding()` 在 `platform === "ios"` 时加载它 |
| profile HMR | 部分 iOS 启动组合没有 `ctx.loader.internal` | 未挂载 internal loader 时跳过 HMR watcher 初始化 |
| node-pty | npm 未提供 iPhoneOS native 产物，SDK 未声明 `openpty` | 使用上游 Apple `posix_spawn` 后端，为 iPhoneOS 编译 `pty.node` 和 `spawn-helper`，并补充缺失的 SDK 声明 |
| HTML 缓存 | Safari 会继续使用旧入口或旧 module graph | index 与 SPA fallback 返回 no-cache header，并给 bundle 增加 compatibility 查询参数 |
| 通知深链接 | 通知 URL 只知道 session，Web 默认恢复上次选择 | compatibility 13 在 module 启动前把 URL 参数写入 `dsh.sessions.current` |
| 主屏幕图标 | Safari 只看到通用 favicon 时会生成模糊或不合适的快捷方式图标 | 提供 180px 白底黑鲸鱼 `apple-touch-icon`，由 iOS 应用主屏幕圆角 |

图片兼容层使用包内的 ImageIO/CoreGraphics helper 完成 PNG、JPEG、WebP 和 GIF 解码、方向校正、sRGB 转换、缩放以及 PNG/JPEG 编码。透明图片保留为 PNG；不透明图片按上游预算选择 PNG 或 JPEG。该后端只实现 DSH 附件模块当前使用的 `sharp` 调用面，升级附件模块时必须重新核对。

Node iOS 构建报告 `process.platform === "ios"`，因此两个 node-pty 产物安装到 `prebuilds/ios-arm64/`，不能只放在 macOS 使用的 `darwin-arm64/`。

## Safari 16 兼容

iOS 上的 Chrome 仍使用 WebKit，因此更换 Chrome 不能绕过 Safari 16 的 JavaScript 能力边界。compatibility 13 入口在任何 DSH module 执行前提供：

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

另外，GFM email autolink 中的 RegExp lookbehind 会让 Safari 16 在解析整个 vendor bundle 时失败。补丁去除该 lookbehind，同时保留调用方已有的 email 边界检查。主 bundle 对 vendor 的 import 使用 `?ioscompat=13`，避免旧 module cache 继续返回解析失败的文件。

0.1.5 主 bundle 和文档预览 bundle 使用 class static block，Safari 16.1 无法解析。构建时使用锁定的 esbuild 0.27.0 转成 `safari16.1` 语法；从锁定的官方产物重现输出并进行比较。文档预览还在初始化时访问 `Iterator.prototype`，入口先加载 core-js 3.50.0 的标准 API polyfill，再启动官方 module graph。依赖锁文件位于 `tools/frontend`。

布局、侧栏、对话和设置组件直接使用 DSH 0.1.5 官方产物，验证脚本逐字节比较 staging tree 与锁定 npm 包。`web/mobile-shell.js` 和 `.css` 恢复原有手机交互：1024px 以下的浮动抽屉、单一鲸鱼入口、完整对话宽度、遮罩/Escape 收起、安全区留白，以及窄屏设置面板。桌面宽度保持官方布局。升级时检查 mobile shell 依赖的 CSS module 类名，并在真机验证收起/展开后的对话宽度及触摸目标。

入口还识别 `session`、`parent` 与 `mode` 查询参数。合法参数会同步写入 Web runtime 已有的 `dsh.sessions.current` localStorage 项，然后从地址栏清除；module graph 随后按普通的恢复选择流程打开根 session 或带父地址的 subagent session。URL 不含设置、凭据或消息正文。

这几类历史错误应由兼容层消除：

```text
AbortSignal.any is not a function
authorityMessages.toReversed is not a function
Array.prototype.toSpliced is not a function
Invalid regular expression: invalid group specifier name
```

首次使用先完成 [Web 认证](./web-authentication.md)。入口自身携带 compatibility 13 资源版本，认证后可直接访问：

```text
http://127.0.0.1:3081/
```

Safari 会长期缓存已添加到主屏幕的图标。图标资源升级后，现有快捷方式通常不会自动换图；删除旧快捷方式，再从带当前 compatibility 参数的页面重新“添加到主屏幕”即可。

## 严格补丁器

[`scripts/patch-dsh.mjs`](../scripts/patch-dsh.mjs) 先验证以下版本，再对每个预像执行“一次且仅一次”替换：

```text
@deepseek-ai/dsh 0.1.5-rc.1
@deepseek-ai/dsh-* 0.1.5-rc.2
node-pty 1.2.0-beta.15
node-addon-api 7.1.1
```

它还锁定 0.1.5 的 hashed bundle 文件名和原始 `index.html` SHA-256。脚本可以重复运行；已修改文件只会被验证，不会重复插入。验证现有 staging tree：

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
