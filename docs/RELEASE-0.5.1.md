# CertFlow v0.5.1 发布验收记录

v0.5.1 是针对 [v0.5.0 已知问题](RELEASE-0.5.0.md#已知问题与升级说明)的可靠性修复版本。本记录区分自动化测试、NAS 现场观察与未来续期事件；测试通过不等于已经观察到真实自动续期。

| 发布项 | 记录 |
| --- | --- |
| 源代码标签与提交 | [v0.5.1](https://github.com/qianshulab/certflow/tree/v0.5.1)，[03da73044a3f834625d6898724b3af0b92c675da](https://github.com/qianshulab/certflow/commit/03da73044a3f834625d6898724b3af0b92c675da) |
| Windows / Ubuntu CI 及容器冒烟 | [GitHub Actions 发布运行 #36715447976](https://github.com/qianshulab/certflow/actions/runs/36715447976)：三项作业均成功。Ubuntu 185 项、184 通过、1 项按平台跳过；Windows 185 项、180 通过、5 项按平台条件跳过；两平台均 0 失败。 |
| GHCR 镜像与固定摘要 | `ghcr.io/qianshulab/certflow:0.5.1`，`linux/amd64`；`ghcr.io/qianshulab/certflow@sha256:0d1ca17ef69e677dee7f18b0eaa18e80fcea722a62a70703e64381465c1bff6a`。匿名清单请求 HTTP 200，发布后又独立核对摘要。 |
| NAS 升级版本与容器健康 | 绿联 DXP4800，按上述摘要在主机网络运行；容器健康。 |
| 验收日期 | 2026-09-30 |

## 修复范围与验收条件

| 项目 | 预期行为 | 当前证据 |
| --- | --- | --- |
| Linux 运行与部署锁 | 使用内核 `flock` 约束同一环境的并发签发及同一目录的并发部署。运行进程异常终止后锁由系统释放，下一次调度不因保留的锁标记文件而永久受阻；仍在运行的另一实例必须拒绝并发。进程树清理无法确认时保留 `.unsafe` 标记，等待人工核查。 | 通过：Linux 回归覆盖活锁互斥、受控 SIGKILL 后恢复、部署事务回滚和无法确认子进程清理的保守阻断；NAS 实际检查后标记文件保留且权限为 `600`，无 `.unsafe` 标记。未在生产容器中人为制造崩溃。 |
| 环境检查 | Linux 上只读探测保留的锁标记是否实际被占用，已释放的标记不误报；活动锁、旧版标记与 `.unsafe` 状态继续阻止启动新任务。探测不得新建或移除锁文件。 | 通过：Linux 回归覆盖四种状态；NAS 实际管理任务检查前后，环境检查均返回 HTTP 200、`ok: true`，运行锁项为 `pass`。 |
| 管理证书 TLS 热更新 | 新证书已签发并通过证书、私钥、域名和有效期校验时，即使同一任务后续可选部署失败，内置 HTTPS 也加载新证书；任务失败与部署错误仍须清晰呈现。无效证书或 TLS 更新失败时保留旧的有效上下文。 | 自动化通过：HTTPS 回归覆盖后续部署失败仍热加载有效证书、无效材料与上下文替换失败保留旧证书。NAS 上真实续期仍须另行观察。 |
| 容器运行时依赖 | 发布镜像安装提供 `flock` 的 `util-linux`；镜像构建与容器冒烟应验证命令存在，并确认非 root、只读根文件系统及数据卷持久化要求保持成立。 | 通过：发布工作流通过 Linux 镜像与隔离容器冒烟；NAS 镜像中的 `flock` 为 util-linux 2.38.1。 |
| 现有功能回归 | DNSPod ID / Token、证书任务、调度、导出、HTTPS 拉取及令牌撤销继续通过 Windows / Ubuntu 测试；镜像仅在完整流水线通过后发布。 | 通过：两平台测试及容器冒烟均成功，公开镜像仅在发布流水线通过后生成。 |

## NAS 现场复核

| 检查 | 结果 | 证据或限制 |
| --- | --- | --- |
| 升级前备份与原数据保持 | 通过 | 私有数据卷与环境文件备份位于 `/volume1/docker/certflow/backups/pre-v0.5.1-20260930.tgz` 和 `pre-v0.5.1.env`，文件权限均为 `600`。升级后原 WebDAV 任务和管理任务证书仍有效；受保护状态接口显示 DNSPod ID / Token 凭据已保存，不返回明文。 |
| v0.5.1 镜像、健康检查与 HTTPS 握手 | 通过 | 容器按固定摘要运行且健康；内置健康探针通过。使用管理域名、SNI 和严格证书校验连接 NAS，`/api/health` 返回 HTTP 200、TLS 验证结果 0。管理证书域名为 `certflow.appvuln.fun`，有效期到 `2026-12-29T10:15:18Z`。 |
| 自动调度与实际检查 | 已配置并检查 | NAS 重建后调度器仍启用，保存的 DNSPod 凭据自动载入。管理任务实际检查返回 `ok: true`、`action: unchanged`，证书不需要续期；下一次检查时间为 `2026-10-01T01:04:46Z`。这不能证明未来到期窗口的续期结果。 |
| 异常退出后的锁恢复 | 隔离测试通过；生产未注入故障 | Linux 测试用受控子进程的 SIGKILL 验证内核锁释放、随后再次执行成功；生产 NAS 没有为了测试而中断正在签发的任务。 |

管理证书的下一次真实续期、TLS 热更新以及其他服务器实际拉取并重载 Nginx/Docker，均需在发生后单独记录。发布时不应把单次签发、模拟续期或接口拉取成功写成这些事件已经完成。本机 Clash Verge 的 fake-IP DNS 将管理域名解析为 `198.18.0.64`，Chrome 直开仍会连接失败；显式解析到 NAS 地址时，域名和证书校验正常。该客户端须配置管理域名直连或修正 DNS 规则后再做浏览器视觉验收。

Linux 原生安装应确保服务管理器在主进程异常退出时清理其子进程；若旧的 lego 或部署子进程可能继续运行，须先人工确认后再启动新一轮任务。NAS 的 Docker 重建会清理旧容器进程。Linux 的 `.run.lock` 和 `.cert-deploy.lock` 是长期保留的锁标记文件，不应删除。

## 发布后打包核验

Windows PowerShell 5 读取不带 BOM 的 UTF-8 脚本时，中文文件名可能被错误解码。主分支提交 [2a5247d](https://github.com/qianshulab/certflow/commit/2a5247df8ab75c3dcf12d24311371027e861e058) 修正了 NAS ZIP 打包脚本，并在 [后续 CI 运行 #36718136296](https://github.com/qianshulab/certflow/actions/runs/36718136296) 中通过 Windows 打包、双平台测试和 Linux 容器冒烟。该提交晚于 v0.5.1 标签，不改变已发布镜像；从源代码重新生成 ZIP 时请使用主分支。当前本地生成的 `CertFlow-NAS-v0.5.1.zip` 的 SHA-256 为 `C93BDEEFA3FFFE93CBFC225D4B5AB52AE61C0ECC8EA4EA9A871B3AACE5F89F33`。
