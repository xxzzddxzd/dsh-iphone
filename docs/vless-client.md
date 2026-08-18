# 独立 VLESS 客户端

这个可选组件只提供一个 `127.0.0.1:18080` HTTP 代理，由 Xray 通过 VLESS 连接固定出口。它不创建 TUN、不修改系统代理或路由，也不依赖 Shadowrocket。DSH 侧仍需把 OpenAI 域名白名单显式交给该端口；DeepSeek、其他模型和 Bash/Python 流量不会自动进入它。

## 构建

Mac 需要 Xcode iPhoneOS SDK 和 Go。Xray v26.3.27 声明 Go 1.26；较旧的 Go 会通过标准 `GOTOOLCHAIN=auto` 下载锁定工具链。

```bash
./scripts/fetch-xray.sh
./scripts/build-xray.sh
./scripts/package-xray.sh
```

产物为：

```text
dist/dsh-vless_26.3.27-1_iphoneos-arm64.deb
```

构建脚本要求 `CGO_ENABLED=1`，使用 iPhoneOS clang 外部链接，并验证最终 Mach-O 的 `platform IOS` 和最低系统 15.0。包安装时使用最小 jailbreak entitlement 重新签名；不包含 Node 所需的 JIT 权限。

## 配置和部署

软件包本身不保存服务器、UUID 或密钥。先复制与节点传输方式匹配的配置；仓库提供 VLESS + WebSocket + TLS 示例：

```bash
cp config/xray/vless-ws-tls.json.example /安全路径/dsh-vless.json
chmod 600 /安全路径/dsh-vless.json
```

替换全部 `REPLACE_` 值。若节点使用 Reality、gRPC 或 XHTTP，可以修改 `streamSettings`，但以下边界不可改变：

- 唯一入站必须为 `dsh-http`、`127.0.0.1:18080`、HTTP。
- 第一个出站必须为 `vless-out`、VLESS。
- 不允许 `freedom` 直连出站。
- access log 固定为 `/var/root/dsh-vless-access.log`。

校验并部署：

```bash
VLESS_CONFIG_PATH=/安全路径/dsh-vless.json \
DEVICE_HOST=10.99.6.77 DEVICE_PORT=22 \
./scripts/deploy-vless.sh
```

脚本会先在 Mac 上检查回环与 fail-closed 边界，再把配置作为候选文件上传；设备上的 Xray `run -test` 成功后才替换活动配置。旧配置保留为 `config.json.previous`。随后脚本重新加载 launchd 并检查 18080 端口。

如果只安装 `.deb` 而不部署凭据，`postinst` 会创建一个只含 `blackhole` 出站的默认配置。端口可以启动，但请求不会直连泄漏。

## 实机检查

```bash
ssh -p 22 root@10.99.6.77 'launchctl print user/foreground/ai.deepseek.dsh-vless | head -80'
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/lib/dsh-vless/xray version'
ssh -p 22 root@10.99.6.77 'tail -n 100 /var/root/dsh-vless-error.log; tail -n 100 /var/root/dsh-vless-access.log'
```

Shadowrocket 关闭时，Xray 的 VLESS socket 直接使用手机当前 Wi-Fi 或蜂窝网络。Shadowrocket 开启时，该 socket 可能再次进入 Shadowrocket 的系统隧道，形成代理套代理，因此固定出口运行时建议关闭 Shadowrocket。

通过 `127.0.0.1:18080` 显式发出的出口探测可以验证 VLESS 节点；模型调用 Bash 执行的普通 `curl ipify.org` 仍属工具流量并保持直连，不能据此判断 GPT 通道出口。GPT 请求是否命中代理应以 `dsh-vless-access.log` 和 DSH dispatcher 日志共同确认。

## 停止与回滚

停止服务不会改变系统路由：

```bash
ssh -p 22 root@10.99.6.77 'launchctl bootout user/foreground/ai.deepseek.dsh-vless'
```

配置损坏时，可先测试再恢复上一份：

```bash
ssh -p 22 root@10.99.6.77 '/var/jb/usr/local/lib/dsh-vless/xray run -test -config /var/root/.config/dsh-vless/config.json.previous'
```
