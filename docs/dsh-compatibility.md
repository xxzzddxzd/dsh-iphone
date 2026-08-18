# DSH 与 Safari 16 兼容层

DSH 0.1.0-rc.6 要求 Node 22，但它的 npm 闭包和 Web 前端默认面向桌面系统及更新浏览器。本项目只修改发布包，不修改或伪装官方 Git 子模块。

## 服务端兼容

| 组件 | iOS 问题 | 处理方式 |
| --- | --- | --- |
| `sharp` | 官方 native/libvips 产物不能在 iPhoneOS 加载 | 用 [`ios-sharp-shim.mjs`](../shims/ios-sharp-shim.mjs) 实现 DSH 使用的 metadata/validation 接口 |
| `koffi` | Win32 FFI 模块没有 iOS native binding | Win32-only 路径改用 fail-closed 的 [`ios-koffi-stub.mjs`](../shims/ios-koffi-stub.mjs) |
| profile HMR | 部分 iOS 启动组合没有 `ctx.loader.internal` | 未挂载 internal loader 时跳过 HMR watcher 初始化 |
| node-pty | macOS 分支依赖 `posix_spawn` helper 语义 | iOS 改用 `forkpty`，并为 iPhoneOS 编译 `pty.node` 和 `spawn-helper` |
| HTML 缓存 | Safari 会继续使用旧入口或旧 module graph | index 与 SPA fallback 返回 no-cache header，并给 bundle 增加 compatibility 查询参数 |

图片 shim 支持 DSH 当前接收的 PNG、JPEG、WebP 和 GIF 元数据与结构检查，不提供 resize、转码或颜色处理。它是上传准入校验器，不是 `sharp` 的通用替代品；升级附件模块时必须重新核对调用面。

Node iOS 构建报告 `process.platform === "ios"`，因此两个 node-pty 产物安装到 `prebuilds/ios-arm64/`，不能只放在 macOS 使用的 `darwin-arm64/`。

## Safari 16 兼容

iOS 上的 Chrome 仍使用 WebKit，因此更换 Chrome 不能绕过 Safari 16 的 JavaScript 能力边界。compatibility 4 入口在任何 DSH module 执行前提供：

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

另外，GFM email autolink 中的 RegExp lookbehind 会让 Safari 16 在解析整个 vendor bundle 时失败。补丁去除该 lookbehind，同时保留调用方已有的 email 边界检查。主 bundle 对 vendor 的 import 使用 `?ioscompat=4`，避免旧 module cache 继续返回解析失败的文件。

这几类历史错误应由兼容层消除：

```text
AbortSignal.any is not a function
authorityMessages.toReversed is not a function
Array.prototype.toSpliced is not a function
Invalid regular expression: invalid group specifier name
```

浏览器应始终访问带版本参数的地址：

```text
http://127.0.0.1:3082/?ioscompat=4
```

## 严格补丁器

[`scripts/patch-dsh.mjs`](../scripts/patch-dsh.mjs) 先验证以下版本，再对每个预像执行“一次且仅一次”替换：

```text
@deepseek-ai/dsh 0.1.0-rc.6
node-pty 1.1.0
node-addon-api 7.1.1
```

它还锁定 rc.6 的 hashed bundle 文件名和原始 `index.html` SHA-256。脚本可以重复运行；已修改文件只会被验证，不会重复插入。验证现有 staging tree：

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
