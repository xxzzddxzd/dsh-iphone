# DSH 与 Safari 16 兼容层

DSH 0.1.1-rc.2 要求 Node 22，但它的 npm 闭包和 Web 前端默认面向桌面系统及更新浏览器。本项目只修改发布包，不修改或伪装官方 Git 子模块。

可选 Provider bundle 的已验证配套版本为 `dsh-codex 0.2.5-iphone.7`；旧的
`0.2.5-iphone.4` 只适配 DSH 0.1.0，不能继续加载到 rc.2。该版本的 Google
Code Assist 路由复用 `@kelvinwww/dsh-oauth 0.1.1`，并强制其 gaxios 传输使用
Node 原生 fetch，以接入 DSH 的 provider 级 VLESS dispatcher。Kelvin 的 Google
实现和 Google 客户端在构建时内联，所有 DSH 接口保持 external，避免它依赖的 rc.8
模块被 pnpm 提升并污染 rc.2 profile。

## 服务端兼容

| 组件 | iOS 问题 | 处理方式 |
| --- | --- | --- |
| `sharp` | 官方 native/libvips 产物不能在 iPhoneOS 加载 | 用 [`ios-sharp-shim.mjs`](../shims/ios-sharp-shim.mjs) 接到原生 ImageIO/CoreGraphics helper，实现 DSH 使用的校验、方向、缩放、色彩与编码调用面 |
| `koffi` | Win32 FFI 模块没有 iOS native binding | Win32-only 路径改用 fail-closed 的 [`ios-koffi-stub.mjs`](../shims/ios-koffi-stub.mjs) |
| profile HMR | 部分 iOS 启动组合没有 `ctx.loader.internal` | 未挂载 internal loader 时跳过 HMR watcher 初始化 |
| node-pty | npm 未提供 iPhoneOS native 产物，SDK 未声明 `openpty` | 使用上游 Apple `posix_spawn` 后端，为 iPhoneOS 编译 `pty.node` 和 `spawn-helper`，并补充缺失的 SDK 声明 |
| HTML 缓存 | Safari 会继续使用旧入口或旧 module graph | index 与 SPA fallback 返回 no-cache header，并给 bundle 增加 compatibility 查询参数 |
| 通知深链接 | 通知 URL 只知道 session，Web 默认恢复上次选择 | compatibility 9 在 module 启动前把 URL 参数写入 `dsh.sessions.current` |
| 移动端侧栏 | 收起后仍占对话宽度，展开时挤压对话区 | compatibility 9 在标题栏保留单一鲸鱼入口，展开层覆盖对话区 |
| 主屏幕图标 | Safari 只看到通用 favicon 时会生成模糊或不合适的快捷方式图标 | 提供 180px 白底黑鲸鱼 `apple-touch-icon`，由 iOS 应用主屏幕圆角 |

图片兼容层使用包内的 ImageIO/CoreGraphics helper 完成 PNG、JPEG、WebP 和 GIF 解码、方向校正、sRGB 转换、缩放以及 PNG/JPEG 编码。透明图片保留为 PNG；不透明图片按上游预算选择 PNG 或 JPEG。该后端只实现 DSH 附件模块当前使用的 `sharp` 调用面，升级附件模块时必须重新核对。

Node iOS 构建报告 `process.platform === "ios"`，因此两个 node-pty 产物安装到 `prebuilds/ios-arm64/`，不能只放在 macOS 使用的 `darwin-arm64/`。

## Safari 16 兼容

iOS 上的 Chrome 仍使用 WebKit，因此更换 Chrome 不能绕过 Safari 16 的 JavaScript 能力边界。compatibility 9 入口在任何 DSH module 执行前提供：

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

另外，GFM email autolink 中的 RegExp lookbehind 会让 Safari 16 在解析整个 vendor bundle 时失败。补丁去除该 lookbehind，同时保留调用方已有的 email 边界检查。主 bundle 对 vendor 的 import 使用 `?ioscompat=9`，避免旧 module cache 继续返回解析失败的文件。

窄于 1024px 时，对话区保持全宽。收起状态只在会话标题栏左侧显示一个鲸鱼入口，标题与“对话/轨迹”标签为它保留安全区；新会话、工作区、会话列表、附加动作和设置均在抽屉展开后显示，不再保留左下设置浮层。打开侧栏后以遮罩层覆盖对话，点击遮罩或按 Escape 可关闭。桌面宽屏仍保留官方三栏和拖拽行为。

窄于 681px 时，设置页改为避让 iOS 安全区的近全屏面板：原有左侧导航变为顶部横向分页，内容使用完整宽度并独立纵向滚动；分页过多时只滚动分页栏，不会再次压缩设置正文。关闭按钮扩大为 44px 触控区域；窄于 391px 时，通用设置中的说明和选择器自动改为上下排列。桌面设置布局保持不变。

移动布局在发布 bundle 中固定使用传统的 `@media (max-width: 1023px)`。不能让压缩器改写成 Media Queries Level 4 的 `(width <= 1023px)`：该范围语法到 Safari 16.4 才支持，iOS 16.1 会忽略整条规则，表现为真机没有鲸鱼入口，而新版 Mac Safari 的响应式预览正常。

入口还识别 `session`、`parent` 与 `mode` 查询参数。合法参数会同步写入 Web runtime 已有的 `dsh.sessions.current` localStorage 项，然后从地址栏清除；module graph 随后按普通的恢复选择流程打开根 session 或带父地址的 subagent session。URL 不含设置、凭据或消息正文。

这几类历史错误应由兼容层消除：

```text
AbortSignal.any is not a function
authorityMessages.toReversed is not a function
Array.prototype.toSpliced is not a function
Invalid regular expression: invalid group specifier name
```

浏览器应始终访问带版本参数的地址：

```text
http://127.0.0.1:3081/?ioscompat=9
```

Safari 会长期缓存已添加到主屏幕的图标。图标资源升级后，现有快捷方式通常不会自动换图；删除旧快捷方式，再从带当前 compatibility 参数的页面重新“添加到主屏幕”即可。

## 严格补丁器

[`scripts/patch-dsh.mjs`](../scripts/patch-dsh.mjs) 先验证以下版本，再对每个预像执行“一次且仅一次”替换：

```text
@deepseek-ai/dsh 0.1.1-rc.2
node-pty 1.2.0-beta.15
node-addon-api 7.1.1
```

它还锁定 rc.2 的 hashed bundle 文件名和原始 `index.html` SHA-256。脚本可以重复运行；已修改文件只会被验证，不会重复插入。验证现有 staging tree：

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
ssh -p 22 root@10.99.6.77 'cp -a /var/root/.dsh /var/root/.dsh.before-node22'
```
