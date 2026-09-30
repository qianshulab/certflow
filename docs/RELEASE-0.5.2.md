# CertFlow v0.5.2 发布验收记录

v0.5.2 改进完整证书链的下载入口和绿联 UGOS WebDAV 导入说明。`fullchain.pem` 的生成、单文件下载及 ZIP 打包能力在此前版本已存在；本版将它置于导出列表首位，明确区分仅含域名证书的 `cert.pem`、中间证书链 `chain.pem` 与完整链 `fullchain.pem`。

## 变更与验收范围

| 项目 | 验收条件 |
| --- | --- |
| 完整链下载 | 选择有效证书任务后可单独下载 `fullchain.pem`；ZIP 同时包含 `cert.pem`、`chain.pem`、`fullchain.pem` 和 `privkey.pem`。 |
| 续期后的导出 | 即使旧签发批次仍保留，新下载应使用当前证书与私钥；回归测试同时检查单文件与 ZIP。 |
| UGOS WebDAV 导入 | DXP4800 实测：证书字段使用 `fullchain.pem`、私钥字段使用同批次 `privkey.pem`、中间证书字段留空，随后在服务配置中选用新记录。目标服务应发送完整链且严格 TLS 校验通过。其他 UGOS 服务和版本需分别验证。 |
| 自动续期边界 | CertFlow 自动更新自身导出文件；UGOS 手动导入的是副本，每次续期后仍须重新导入并重新绑定服务。 |
| 发布与升级 | Windows / Linux 测试、NAS 打包检查、容器冒烟通过后发布 GHCR 镜像；NAS 升级保留数据卷与现有 Compose 覆盖文件，并核对镜像摘要及容器健康。 |

本地开发环境已通过 `npm run check`、`npm test`（186 项测试、179 通过、7 项按平台跳过）和 `git diff --check`。GitHub Actions 的跨平台检查、镜像摘要以及 NAS 升级结果将在发布完成后记录；本文件不将计划中的检查写成已完成。
