# 部署与运行排障

以下命令默认设备为 `10.99.6.77:22`，服务端口为 3080，Mac 转发端口为 3082。

## 先检查服务

```bash
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/bin/node22 --version; launchctl print system/ai.deepseek.dsh | head -80'
ssh -p 22 root@10.99.6.77 'curl -i http://127.0.0.1:3080/'
ssh -p 22 root@10.99.6.77 'tail -n 200 /var/root/dsh.log'
```

重新加载服务：

```bash
ssh -p 22 root@10.99.6.77 'launchctl bootout system/ai.deepseek.dsh >/dev/null 2>&1 || true; launchctl bootstrap system /var/jb/Library/LaunchDaemons/ai.deepseek.dsh.plist; launchctl kickstart -k system/ai.deepseek.dsh'
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
http://127.0.0.1:3082/?ioscompat=4
```

## Mac 有回复，iPhone 没有回复

Safari 和 iOS Chrome 共用 WebKit。不要靠更换 Chrome 处理 JavaScript 兼容问题。先确认 compatibility 4 入口：

```bash
curl -sS 'http://127.0.0.1:3082/?ioscompat=4' | rg 'dsh-ios-compat|ioscompat=4'
```

如果 Mac 能看到新消息而手机仍保留空白或旧内容：

1. 关闭对应页面的所有标签页。
2. 清除 `127.0.0.1` 的网站数据，或重置刚打开的 Safari Experimental Features。
3. 重新打开带 `?ioscompat=4` 的地址。
4. 确认服务返回 `Cache-Control: no-store`。

```bash
curl -i 'http://127.0.0.1:3082/?ioscompat=4' | head -30
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
ssh -p 22 root@10.99.6.77 "grep -nE 'dsh-ios-compat|ioscompat=4' /var/jb/usr/local/lib/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html"
```

本地重新生成并部署 DSH 包：

```bash
./scripts/package-dsh.sh
DEVICE_HOST=10.99.6.77 DEVICE_PORT=22 ./scripts/deploy.sh
```

## permission preset read-only

`read-only` 是有效预设，但它只适合读取、分析和无写入工具。需要改文件或执行会改变状态的命令时，切换到允许该操作的权限预设。服务端不应绕过用户选择的权限边界。

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

## Node 构建时间过长

首次构建需要编译 V8、OpenSSL、ICU 和 Node 核心，耗时显著高于 DSH 打包。提高并发前先确认 Mac 内存和散热：

```bash
JOBS=8 ./scripts/build-node.sh
```

中断后可直接重跑，`make` 会复用 `build/node-v22.23.2/out` 中已完成的目标。不要删除该目录，除非补丁预像或 configure 参数已经改变。
