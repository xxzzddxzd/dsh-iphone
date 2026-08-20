# 部署与运行排障

以下命令默认设备为 `10.99.6.77:22`，服务端口为 3080，Mac 转发端口为 3082。

## 先检查服务

```bash
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/node22 --version; launchctl print user/foreground/ai.deepseek.dsh | head -80'
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/node22 -e '\''require("node:http").get("http://127.0.0.1:3080/", response => { console.log(response.statusCode); response.resume(); }).on("error", error => { console.error(error.message); process.exit(1); })'\'''
ssh -p 22 root@10.99.6.77 'tail -n 200 /var/root/dsh.log'
```

重新加载服务：

```bash
ssh -p 22 root@10.99.6.77 'launchctl bootout user/foreground/ai.deepseek.dsh >/dev/null 2>&1 || true; while launchctl print user/foreground/ai.deepseek.dsh >/dev/null 2>&1; do sleep 1; done; launchctl bootstrap system /var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist; launchctl kickstart -k user/foreground/ai.deepseek.dsh'
```

如果 `launchctl bootstrap` 报服务已存在，先执行 `bootout`；如果持续退出，日志中的第一条 JavaScript 或 dyld 错误比 KeepAlive 的重复输出更有用。

## Mac 无法打开页面

确认设备 SSH 和本地端口：

```bash
nc -vz 10.99.6.77 22
lsof -nP -iTCP:3082 -sTCP:LISTEN
```

重建转发：

```bash
DEVICE_HOST=10.99.6.77 DEVICE_PORT=22 ./scripts/start-tunnel.sh
```

打开：

```text
http://127.0.0.1:3082/?ioscompat=7
```

## Mac 有回复，iPhone 没有回复

Safari 和 iOS Chrome 共用 WebKit。不要靠更换 Chrome 处理 JavaScript 兼容问题。先确认 compatibility 7 入口：

```bash
curl -sS 'http://127.0.0.1:3082/?ioscompat=7' | rg 'dsh-ios-compat|ioscompat=7'
```

如果 Mac 能看到新消息而手机仍保留空白或旧内容：

1. 关闭对应页面的所有标签页。
2. 清除 `127.0.0.1` 的网站数据，或重置刚打开的 Safari Experimental Features。
3. 重新打开带 `?ioscompat=7` 的地址。
4. 确认服务返回 `Cache-Control: no-store`。

```bash
curl -i 'http://127.0.0.1:3082/?ioscompat=7' | head -30
```

如果整个页面在打开实验功能后无法显示，先恢复 Safari 实验功能默认值，再清理网站数据；服务端无需重新安装。

## JavaScript API 报错

出现以下内容说明浏览器仍拿到了旧入口或旧 bundle：

```text
AbortSignal.any is not a function
authorityMessages.toReversed is not a function
Array.prototype.toSpliced is not a function
Invalid regular expression: invalid group specifier name
```

检查部署文件：

```bash
ssh -p 22 root@10.99.6.77 "grep -nE 'dsh-ios-compat|ioscompat=7' /var/jb/usr/local/lib/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html"
```

本地重新生成并部署 DSH 包：

```bash
./scripts/package-dsh.sh
DEVICE_HOST=10.99.6.77 DEVICE_PORT=22 ./scripts/deploy.sh
```

## permission preset read-only

`read-only` 是有效预设，但它只适合对话、分析和不依赖进程沙箱的读取。iOS 没有 DSH 当前支持的 `bubblewrap`、Landlock、`sandbox-exec` 或 Windows ACL 后端，所以 `Workspace Write` 中的 Bash 会报 `no sandbox backend is usable on this host`，即使命令本身只读。确实需要 Bash 时，由用户明确选择 `Full access` 或批准单次提升；服务端不应自动绕过权限边界。

## prompt reject (agent-busy)

当前会话上一轮仍在运行。等待其完成，或新建会话；不要连续重复提交同一个 prompt。若状态长期不释放，先看 `/var/root/dsh.log` 是否有未处理异常，再重启 launchd 服务。

## node-pty 或终端失败

确认两个原生产物是 iPhoneOS arm64 且已签名：

```bash
ssh -p 22 root@10.99.6.77 'file /var/jb/usr/local/lib/dsh/node_modules/node-pty/prebuilds/ios-arm64/pty.node /var/jb/usr/local/lib/dsh/node_modules/node-pty/prebuilds/ios-arm64/spawn-helper'
ssh -p 22 root@10.99.6.77 'ldid -e /var/jb/usr/local/lib/dsh/node_modules/node-pty/prebuilds/ios-arm64/pty.node'
```

本地重新编译：

```bash
./scripts/prepare-dsh.sh
./scripts/build-node-pty.sh
```

## pnpm 或插件安装失败

确认 pnpm 固定使用 Node 22，而不是系统 Node 18：

```bash
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/pnpm --version; /var/jb/usr/local/lib/nodejs22/node --version'
```

`dsh plugin` 会把参数原样转发给由 Node 22 直接加载的 `pnpm.cjs`，并在成功后更新 profile bundle 列表。安装 registry 中的预构建 bundle 不需要设备上的 `curl` 或 `gzip`；pnpm 通过 Node HTTPS 自行下载和解包。若直接运行包装器成功，但 `dsh plugin` 报 `spawnSync pnpm EPERM`，说明 DSH 包没有包含当前仓库的 iOS pnpm 启动补丁，应重新构建并安装 DSH deb。若失败信息指向 `node-gyp`、不支持的 `os`/`cpu` 或缺少原生产物，则是目标插件没有适配 iPhoneOS，不是 pnpm 本身不可运行。

profile 的 store 和 lockfile 位于 `/var/root/.dsh/profiles/<profile>` 所管理的 pnpm 状态中。不要删除整个 profile 来修复单个插件；先运行：

```bash
ssh -t -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/dsh22 plugin --profile web why <package>'
```

## 独立 VLESS 服务失败

服务固定注册在 Dopamine 的 `user/foreground` domain；即使通过 `launchctl bootstrap system` 加载，也要用以下标识查询和重启：

```bash
ssh -p 22 root@10.99.6.77 'launchctl print user/foreground/ai.deepseek.dsh-vless | head -100'
ssh -p 22 root@10.99.6.77 'tail -n 100 /var/root/dsh-vless-error.log; tail -n 100 /var/root/dsh-vless-launchd.log'
```

出现 `EX_CONFIG` 时，先确认 plist 通过 `/var/jb/bin/sh` 启动包装器，并检查 `/var/root/.config/dsh-vless/config.json` 是否为 root 可读的 0600 文件。直接校验配置：

```bash
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/lib/dsh-vless/xray run -test -config /var/root/.config/dsh-vless/config.json'
```

如果 Xray 被 `SIGKILL` 且没有错误日志，检查 entitlement。空的 `ldid -S` 签名不足；正式包应包含 `platform-application` 和 `com.apple.private.security.no-sandbox`。若端口正常但 GPT 请求没有 access log，问题在 DSH 的域名分流，而不是 VLESS 服务。

## Node 构建时间过长

首次构建需要编译 V8、OpenSSL、ICU 和 Node 核心，耗时显著高于 DSH 打包。提高并发前先确认 Mac 内存和散热：

```bash
JOBS=8 ./scripts/build-node.sh
```

中断后可直接重跑，`make` 会复用 `build/node-v22.23.2/out` 中已完成的目标。不要删除该目录，除非补丁预像或 configure 参数已经改变。
