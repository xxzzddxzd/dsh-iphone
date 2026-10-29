# Grok2API 客户端取消与冷却修复

适用于本机 `chenyme/grok2api` v3.0.6、commit `c7b4a51aa0d3e3724654fdaf94c7b89236ecf27d` 的四个原始文件。补丁只修改 HTTP 流错误分类、Finalize 的账号健康判定、冷却提示及对应回归，不包含账号、配置或数据库。

客户端取消也会中止上游 Read。原逻辑将它记为 `upstream_stream_interrupted`，再用独立 Background Context 处罚账号。修复后记为 `request_canceled`；Finalize 对已取消的请求不处罚账号，真正上游 Read/不完整 EOF 仍按原规则冷却。冷却消息补充与 `Retry-After` 相同的等待秒数，状态码及错误码保持兼容。

更新前先按 `manifest.json` 校验四个完整预像，再执行 `git apply --check client-cancel-cooling.patch`，保留其余本地修改。源码不匹配时重新审计，不强行应用。对包含既有本地修改的工作树建立隔离候选、执行全部 Go 测试与新增 race 回归后构建；停止托管服务、备份二进制/配置/一致性 SQLite 快照后替换，并只启动一个实例。

DSH 的本机 `llm-pi-ai.providers.xai` 使用 normal 重试策略，`retryableCodes` 为 `EMPTY_RESPONSE`、`SERVER`、`TIMEOUT`、`TRANSPORT`，不自动重试 `RATE_LIMIT`。同时设 `dsh-purge.config.autoRetry: false`，避免插件在 Core 停止重试后再次补发。其他网络和服务器临时错误仍保留 Core 的五次重试。必须在现有 Provider 字典上按字段修改，不能整行覆盖其他路由。

来源项目：[chenyme/grok2api](https://github.com/chenyme/grok2api)。原项目许可保持适用；本目录仅分发该基线的修复差异及测试。部署与实测见 `docs/updating.md`。
