# iPhone 本机 Mobile Gateway

DSH 仍由原 `ai.deepseek.dsh` launchd 服务运行，Web 保持 `127.0.0.1:3080`。此包在同一个进程中增加 `/ws/mobile`；Whaleness 使用 `ws://127.0.0.1:3080/ws/mobile`，不依赖 Wi-Fi IP 或第二个 LAN listener。

## 构建与安装

```bash
./scripts/package-mobile-gateway.sh
```

输入是精确固定的 npm `dsh-plugin-mobile-gateway@0.11.1` 与生产 lock；输出为 `dist/dsh-plugin-mobile-gateway-0.11.1+iphone.1.tgz`，版本中的 build metadata 保留上游 `0.11.1` 的兼容性语义。包含纯 JavaScript 生产闭包，不带 DSH peers 或 Linux setup/init 命令。补丁先验证所有上游完整文件 hash，源码变化时拒绝应用。

手机安装必须在按主项目 SOP 确认空闲、停止服务并备份后执行。上传 tarball，再用 `dsh22 plugin --profile web add --workspace-root --offline <tarball>`，最后由 launchd 启动一次。不要使用上游 `setup/init`；不要从网关界面另起 DSH。此变体禁用 fork 重启/停止服务能力和桌面 Tunnel，不根据 `process.platform` 猜测 iPhone 身份。

`cordis.patch.yml` 自带本机配置。已有网关运行模式会优先于启动配置，若状态为 disabled，通过本机管理接口设置 persistent；不要删除身份文件。备份和迁移时保留 `/var/root/.dsh/mobile-gateway-devices.json` 与 `mobile-gateway-state.json`。

## 配对和验收

1. 使用现有 DSH 浏览器会话认证，读取 `GET /mgw/status`，确认版本 `0.11.1+iphone.1`、`gatewayMode=persistent`、`lan.enabled=false`、`cloudflare.supported=false`、`tools.restartWeb=false` 和 `tools.stopWeb=false`。
2. 如需开启，`POST /mgw/gateway`，JSON 为 `{"mode":"persistent"}`。
3. `POST /mgw/pair`，JSON 为 `{"publicUrl":"ws://127.0.0.1:3080/ws/mobile"}`。写请求的 Origin 与实际 HTTP 访问地址一致。
4. 将返回的 `qrPayload` 交给 Whaleness 的手动配对/扫码入口。它含短期一次性配对码，不能打印到共享日志或提交仓库；只保存在权限 0600 的临时文件中，用完删除。App 的长期设备凭据由其 Keychain 保存。
5. WS 首次连接使用 `dsh-mobile-v1` 和 `dsh-pair.<code>`，附 `X-DSH-Device-ID`；之后用设备 token。验证未配对连接被拒绝，撤销设备后旧 token 无效。
6. 检查 `hello.protocol=3`、Session format 4、`assistant-stream-v1` 和文件上传能力；读取原会话，在唯一测试会话中验证回复、Bash、图片、普通文件上传、审批/问答和前后台重连。关闭 App 后原 DSH 服务与网页仍须可用。

原生上传复用官方附件存储及会话专属 receipt，不直接写客户端指定的主机路径。会话搜索使用原 Node 内置 `node:sqlite` 的按需内存索引，仍需在新核心上验收真实搜索。
