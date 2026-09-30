# 配置与运维参考

[返回首页](../README.md) · [NAS Docker 部署](docker-nas.md)

本页说明原生运行、证书任务、DNS 凭据、导出部署和故障恢复。Docker 安装、登录、数据卷及升级步骤见 [NAS Docker 部署指南](docker-nas.md)。

## 运行环境与启动

原生运行要求 Node.js 22+ 和 lego v5.5.2；Linux 还须安装提供 `flock` 的 `util-linux`。客户端应从 [lego 官方发布页](https://github.com/go-acme/lego/releases/tag/v5.5.2)下载，并按发布页校验和核对；可加入 `PATH`，或通过 `legoPath` 指定绝对路径。lego v4 的命令和数据布局不受支持，参见 [lego 安装说明](https://go-acme.github.io/lego/install/)。

```sh
node cli.mjs init
node cli.mjs plan
npm start
```

`init` 创建 `cert-config.json`，不会覆盖已有文件。`plan` 与 `status` 只读取本地状态，不申请证书、不修改 DNS、不重载服务。默认浏览器入口为 `http://127.0.0.1:3390`；原生模式仅监听本机。

指定配置文件或端口：

```sh
npm start -- --port 3391 --config /absolute/path/cert-config.json
npm run cli -- plan --config /absolute/path/cert-config.json
```

Windows 双击 `启动图形界面.cmd` 会后台启动服务并打开浏览器；重复启动会复用同端口的现有服务。`停止图形界面.cmd` 会停止调度并等待当前任务结束。启动器不会关闭占用端口的其他程序，也不会注册开机启动任务。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\launch-gui.ps1 -Port 3391 -Config .\cert-config.json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\launch-gui.ps1 -Port 3391 -Config .\cert-config.json -Stop
```

启动器的相对配置路径以项目目录为基准。后台输出保存在 `data/gui-server.stdout.log` 与 `data/gui-server.stderr.log`。终端运行时使用 Ctrl+C 退出；关闭浏览器不会停止服务。

## 配置结构

示例：

```json
{
  "email": "admin@example.com",
  "acceptTerms": false,
  "environment": "staging",
  "legoPath": "lego",
  "dataDir": "./data",
  "jobs": [
    {
      "id": "my-site",
      "enabled": true,
      "domains": ["example.com", "*.example.com"],
      "challenge": { "type": "dns", "provider": "dnspod-token" },
      "deployment": null
    }
  ]
}
```

示例邮箱和域名必须替换为实际值。阅读并同意 [Let's Encrypt 订阅者协议](https://letsencrypt.org/repository/)后，才可将 `acceptTerms` 设为 `true`。默认配置不接受条款，也不触发申请。

| 字段 | 含义 |
| --- | --- |
| `email` | ACME 账户联系邮箱；DNSPod 传统 Token 模式要求 ASCII 格式 |
| `environment` | `staging` 为测试环境，`production` 为正式环境；数据分别保存 |
| `legoPath` | lego 可执行文件名或绝对路径 |
| `dataDir` | 账户、证书、私钥及任务状态目录 |
| `jobs[].id` | 唯一任务 ID；1–64 位小写字母、数字、短横线或下划线，不能使用系统保留名称 |
| `jobs[].enabled` | 默认 `true`；`false` 时跳过自动调度和全部执行，仍可通过 `--only` 单独执行 |
| `jobs[].domains` | 证书覆盖的域名列表；每项只填写域名，不包含协议、端口或路径 |
| `jobs[].challenge` | DNS 或 HTTP 验证方式 |
| `jobs[].deployment` | `null` 表示仅导出；自动部署仅限正式环境 |

相对文件路径以配置文件所在目录为基准。修改任务 ID 会使用新的证书存储目录。普通域名与通配符是不同的覆盖范围：`*.example.com` 不包含 `example.com` 本身。

界面保存配置不会触发申请。正在执行任务时配置与凭据暂时不可修改；调度已启用但处于空闲时可正常编辑。不要让图形界面与 CLI `watch` 同时调度同一份配置。

## DNS 验证

### 服务商与环境变量

| 服务商 | `provider` | 环境变量 |
| --- | --- | --- |
| DNSPod ID / Token | `dnspod-token` | `DNSPOD_API_ID`、`DNSPOD_API_TOKEN` |
| 腾讯云 DNSPod | `tencentcloud` | `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY` |
| 阿里云 DNS | `alidns` | `ALICLOUD_ACCESS_KEY`、`ALICLOUD_SECRET_KEY` |
| Cloudflare | `cloudflare` | `CF_DNS_API_TOKEN` |

DNS 凭据可通过界面保存，也可由进程环境注入；不应写入配置 JSON 或命令行参数。Linux 可通过受限权限的 `EnvironmentFile` 注入，Windows 可由凭据管理方案注入启动进程。原生运行不自动读取 `.env`；Docker 的 `.env` 由 Compose 处理。

Cloudflare Token 需包含目标区域的 Zone Read 与 DNS Edit 权限。服务商权限及更多客户端选项参见 [腾讯云](https://go-acme.github.io/lego/dns/tencentcloud/)、[阿里云](https://go-acme.github.io/lego/dns/alidns/)及 [Cloudflare](https://go-acme.github.io/lego/dns/cloudflare/)官方客户端文档。

### DNSPod 两种凭据

在 [DNSPod 控制台](https://console.dnspod.cn/account/token/token)创建的凭据使用 `dnspod-token`，数字 ID 与 Token 分开填写。不要将 `ID,Token` 整段填入 Token 字段。腾讯云访问管理中的 SecretId / SecretKey 使用 `tencentcloud`，两种模式不能混用。

传统 Token 模式通过 lego exec 调用 [DNSPod 传统 API](https://docs.dnspod.cn/api/api-public-request/)。验证时创建 TXT 记录；清理时核对本次创建返回的记录 ID 后删除。lego 负责 CNAME 处理与 DNS 传播检查。为兼容旧配置，`dnspod` 仍是 `tencentcloud` 的别名，新配置应明确填写 `dnspod-token`。

验证记录凭单保存在 `data/<environment>/<任务ID>/dnspod-challenges`。进程异常退出或远端记录被修改时，凭单会保留并产生待清理提示。工具不会按记录名称批量删除其他 TXT 记录；签发成功后仍应处理清理警告。

### 凭据持久化

界面默认加密长期保存，也可选择仅在当前服务会话中使用。读取优先级为：**当前会话 → 已保存凭据 → 进程环境变量**。移除凭据会删除会话值和持久值；进程环境变量仍存在时继续生效。CLI `run` / `watch` 也会读取同目录的已保存凭据。

凭据、加密密钥、调度偏好与活动记录位于配置文件旁的 `.certflow/`。密钥不会写入配置 JSON，也不会回填浏览器输入框。Windows 使用当前用户 DPAPI；Linux 使用 AES-256-GCM 和受文件权限保护的本地密钥。能读取密文与密钥的系统用户可以解密，因此整个目录及其备份均需保护。

Windows DPAPI 文件不能直接在 Linux 解密。迁移到 NAS 后应重新保存 DNS 凭据；Linux 恢复时需保留同一套密文与密钥，不能只恢复其中一个文件。

## HTTP 验证

已有站点可将 `challenge` 配置为：

```json
{
  "type": "http",
  "webroot": "/var/www/html"
}
```

证书机构需要通过公网 80 端口访问该目录中的 `/.well-known/acme-challenge/` 文件。域名解析、防火墙与反向代理需允许该路径访问。HTTP 验证不支持通配符，参见 [Let's Encrypt 验证方式](https://letsencrypt.org/docs/challenge-types/)。

## 申请与自动续期

```sh
node cli.mjs run
node cli.mjs status
```

先在 `staging` 验证完整流程，再切换 `production` 申请正式证书。测试证书不受浏览器信任，测试环境不能自动部署。后续续期依赖已有账户、证书和任务状态，应持续保留这些数据。

图形界面的自动续期开关长期保存，服务重启后恢复。CLI 可使用：

```sh
node cli.mjs watch --config /absolute/path/cert-config.json
```

启动后立即执行一轮，正常情况下每 12 小时加最多 30 分钟随机延时检查一次。失败任务按最近的退避到期时间提前重试，并加入最多 30 秒随机延时；配置或运行锁等整轮异常约 5 分钟后重试。每轮重新读取配置，单轮失败不会终止后续调度。

是否续期由证书状态和 ACME 客户端判断，检查不等于强制重新签发，证书有效期也不固定为某一天数。续期后必须更新使用证书的服务，原证书的有效期不会变化。

自动续期要求服务持续运行、机器在线且凭据有效。可采用以下一种方式维护进程：

- Docker：使用附带 Compose 的 `restart: unless-stopped`。
- Linux 原生：使用 systemd 维护 `watch` 进程，指定绝对 `ExecStart`、工作目录、专用账户和受限环境文件。
- Windows 原生：通过任务计划程序定时执行 `node.exe /project/cli.mjs run --config /config/cert-config.json`，配置工作目录，并禁止重复启动已有实例。

Ctrl+C 或 SIGTERM 会停止后续调度并等待当前一轮结束。界面保留最近 100 条活动记录与任务最后错误、重试时间；当前未接入邮件或即时通信通知。

### 命令速查

```sh
node cli.mjs --help
node cli.mjs init --config cert-config.json
node cli.mjs plan --config cert-config.json
node cli.mjs status --config cert-config.json
node cli.mjs run --config cert-config.json
node cli.mjs run --only my-site
node cli.mjs run --only my-site --retry
node cli.mjs watch --config cert-config.json
```

`--retry` 只忽略失败退避，不强制签发。一次性 `run` 有任务失败时返回非零退出码。`--only` 可以单独运行已暂停任务。

## 证书导出与安装

每次成功执行后，结果的 `exportFiles` 包含导出路径；也可通过 `status` 的 `state.exportFiles` 查询。默认目录：

```text
data/<environment>/<任务ID>/exports/<证书SHA-256>/
```

每张证书使用独立目录。下载和手动导入时，应选择最近一次成功的正式环境结果，并从同一目录取文件，避免混用不同签发批次的证书与私钥。

| 文件 | 内容 | `exportFiles` 字段 |
| --- | --- | --- |
| `cert.pem` | 域名证书 | `certificate` |
| `chain.pem` | 中间证书链 | `chain` |
| `fullchain.pem` | 域名证书与中间证书链 | `fullchain` |
| `privkey.pem` | 无口令保护的证书私钥 | `privateKey` |
| `cert.crt` | `cert.pem` 的同内容别名 | `certificateCrt` |
| `privkey.key` | `privkey.pem` 的同内容别名 | `privateKeyKey` |

图形界面同时提供整套 PEM 的 ZIP 下载（前四项，不重复收录别名），以及复制 PEM 文本。无效、过期或无法确认完整性的证书不可导出。

### 绿联 UGOS 管理页面

按 [绿联官方证书说明](https://support.ugnas.com/detail/article/zh-CN/107)，进入 **控制面板 → 安全性 → 证书** 并选择导入。独立字段分别选择 `cert.pem`（证书）、`privkey.pem`（私钥）和 `chain.pem`（中间证书）。仅要求完整证书链时使用 `fullchain.pem`。

导入后在 **服务配置** 中为管理页面等目标服务选择新证书。随后使用证书覆盖的域名访问，并核对浏览器证书有效期；通过局域网 IP 访问时，域名证书通常不匹配该 IP。

UGOS 界面名称与导入字段以安装版本为准。工具不会改写 UGOS 内部证书文件，续期后的导入与服务关联需要手动完成。

## Nginx 与宝塔本地部署

本节仅适用于 CertFlow 进程能够直接写入目标目录、并能在同一运行环境执行检查与重载命令的情况；NAS 中的标准镜像无法直接控制另一台服务器或任意容器。跨主机推荐使用[目标侧 HTTPS 拉取](remote-pull.md)，宝塔也可在站点 SSL 页面手动粘贴 `fullchain.pem` 与 `privkey.pem` 的内容。确认目标站点实际使用的证书路径，备份现有证书与 Nginx 配置，并避免多个工具同时更新同一份证书。正式环境的任务可配置：

```json
"deployment": {
  "directory": "/www/server/panel/vhost/cert/site-name",
  "checkCommand": ["/www/server/nginx/sbin/nginx", "-t"],
  "reloadCommand": ["/www/server/nginx/sbin/nginx", "-s", "reload"]
}
```

以上是常见宝塔路径示例，必须按实际服务器调整。普通 Nginx 可使用 `/etc/nginx/ssl/site-name`，检查和重载命令指向本机 Nginx 可执行文件。

部署文件名固定为 `fullchain.pem` 和 `privkey.pem`，Nginx 配置分别使用：

```nginx
ssl_certificate     /etc/nginx/ssl/site-name/fullchain.pem;
ssl_certificate_key /etc/nginx/ssl/site-name/privkey.pem;
```

两个命令均为非空参数数组，不经过 shell，不支持直接使用 `&&`、管道或变量展开。需要脚本时，指定解释器和脚本路径；子进程可读取 `CERT_FULLCHAIN` 和 `CERT_PRIVATE_KEY` 环境变量。运行账户需要目标目录写权限和检查、重载权限。

部署先备份并替换文件，然后检查配置，检查成功后重载服务；失败时尝试回滚并保留恢复信息。两份文件采用逐文件替换，**并非证书与私钥同时原子切换**。更新期间应由单一工具控制重载，避免在文件切换间隙加载不一致内容。

已签发但部署失败的证书可直接重试部署，无需重新申请。图形界面的“上次部署成功”表示历史记录，不能替代对目标服务当前证书的检查。

## Docker 中的 Nginx 服务

以下示例适用于 CertFlow 运行在 Docker 宿主机、能够访问证书目录并执行 Docker 命令的环境：

```json
"deployment": {
  "directory": "/srv/https-certs/my-site",
  "checkCommand": ["docker", "exec", "web-nginx", "nginx", "-t"],
  "reloadCommand": ["docker", "exec", "web-nginx", "nginx", "-s", "reload"]
}
```

路径与容器名需替换为实际值，完整结构见 [配置示例](../examples/nginx-docker-config.json)。附带的 CertFlow Compose 不包含 Docker socket 或跨容器控制权限，不能直接套用此命令执行方式；容器部署需额外配置可用的检查与重载通道。

将**整个证书部署目录**只读绑定至 Nginx 容器，避免单文件绑定在替换后仍指向旧文件：

```text
--mount type=bind,src=/srv/https-certs/my-site,dst=/etc/nginx/certs,readonly
```

源目录需在 Docker daemon 所在宿主机上预先存在。只读挂载限制 Nginx 容器写入，不影响宿主机更新文件，参见 [Docker 绑定挂载文档](https://docs.docker.com/engine/storage/bind-mounts/)。Nginx 对应配置：

```nginx
ssl_certificate     /etc/nginx/certs/fullchain.pem;
ssl_certificate_key /etc/nginx/certs/privkey.pem;
```

首次部署先保持 `deployment: null` 完成正式签发，将同一导出目录的完整链与私钥放入固定目录，再启动 Nginx 容器。确认服务正常后启用自动部署。[`docker exec` 只能用于运行中的容器](https://docs.docker.com/reference/cli/docker/container/exec/)，容器停止时检查或重载会失败并进入重试。

## 故障恢复

### 遗留运行锁

Linux 上的 `.run.lock` 与 `.cert-deploy.lock` 是长期保留的内核锁标记文件，**不要删除**。进程正常或异常退出后，内核会释放互斥锁；下次运行可继续使用同一文件。若出现 `.run.lock.unsafe` 或 `.cert-deploy.lock.unsafe`，表示上次无法确认子进程树已停止。先检查相关 Node、lego 和部署子进程，确认它们全部结束后，仅移除对应的 `.unsafe` 标记，再运行检查以完成恢复。Linux 原生部署应由能在服务退出时清理整个进程组的服务管理器托管；Docker 容器重启会清理旧容器进程。

Windows 原生运行仍使用独占创建的运行锁文件。异常退出后若提示遗留锁，应先确认相关进程全部结束，再按错误信息移除对应锁文件。正常任务失败无需手动删锁，其他任务仍在运行时不得删除锁。

### 证书、私钥或状态损坏

界面区分未签发、证书不可读、私钥缺失、不匹配和过期等状态，不会仅按有效期判断证书可用。单个任务状态损坏不会阻塞其他任务，原文件保留供恢复。

有完整匹配备份时，先停止服务、保留当前目录，再恢复该任务的证书、私钥与状态。没有匹配私钥时，可暂停原任务并使用新的任务 ID 申请替代证书；如果原任务配置过自动部署，应先解除旧绑定，避免两个任务指向同一目标目录。

不要通过删除私钥反复触发普通续期，客户端的续期判断不保证强制重发。断电或部署中断后再次执行 `run`，并验证服务实际呈现的证书；本地 `status` 不等于公网证书探测结果。
