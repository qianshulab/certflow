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

## 发布与 NAS 验收结果

| 检查 | 结果 |
| --- | --- |
| 本地验证 | `npm run check`、`npm test`（186 项测试、179 通过、7 项按平台跳过）、`git diff --check` 及 Windows NAS ZIP 打包均通过。 |
| GitHub Actions | [主分支检查](https://github.com/qianshulab/certflow/actions/runs/36745418528)与 [v0.5.2 发布运行](https://github.com/qianshulab/certflow/actions/runs/36745732699)均成功；Windows、Ubuntu、隔离容器冒烟及 GHCR 发布通过。最初一次主分支运行因缺少打包脚本要求的 `RELEASE-0.5.2.md` 失败，补齐后重新通过。 |
| 公开镜像 | `ghcr.io/qianshulab/certflow:0.5.2`，`linux/amd64`；固定摘要 `sha256:635424eea56be457a12d6c2651a44d7ec0775fb72ca92174809e62e0b911a64f`。匿名清单请求 HTTP 200，摘要与 GitHub 发布运行记录一致。 |
| NAS 备份与升级 | 升级前将 `.env` 和数据卷备份到 `/volume1/docker/certflow/backups/pre-v0.5.2-ihhOQw8M/`，文件权限均为 `600`，数据归档可列出 56 个条目。保留 `compose.yaml`、`compose.host-network.yaml`、`compose.dns-compat.yaml` 和 `certflow-data` 卷；将 `.env` 的镜像引用改为上述固定摘要后重建 CertFlow。 |
| NAS 运行与访问 | DXP4800 容器报告 `running`、`healthy`，内部版本为 `0.5.2`，数据卷仍有 31 个文件。使用管理域名和严格 TLS 校验请求 `/api/health` 返回 HTTP 200、验证结果 0；镜像中确认包含新的完整链导出提示。 |
| 生产下载与状态 | 使用容器内已有的管理凭据经 HTTPS 完成登录，实际请求 WebDAV 任务的单文件 `fullchain.pem` 和 ZIP。完整链包含 4 张证书，ZIP 含相同完整链；页面脚本包含更新后的 UGOS 提示。状态接口显示 2 个任务、自动续期开启、1 个已保存的 DNS 凭据服务商。测试后已退出临时会话；没有输出凭据或私钥。 |
| UGOS WebDAV 回归 | 升级后原生 WebDAV 仍发送 4 张证书，OpenSSL 验证结果为 0。此次 CertFlow 容器升级没有更改 UGOS 的服务绑定。 |

尚未观察到下一次真实 ACME 续期后 UGOS 的重新导入；手动导入不会随 CertFlow 自动续期同步。浏览器中的下载按钮未另行点击，服务端下载已通过生产实例的真实认证请求和回归测试验证。
