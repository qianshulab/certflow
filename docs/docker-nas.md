# 在绿联 DXP4800 上长期运行 CertFlow

工具运行在 NAS 的 Docker 容器中，浏览器负责操作。关闭电脑或网页不会影响 NAS 上的自动续期。DNSPod 的 ID / Token 可在界面中加密保存；容器重建后继续使用同一个数据卷即可恢复。

Windows 目录中的 `lego.exe` 只供电脑本机使用。NAS 部署包不包含这个 EXE；Docker 构建会自动下载 Linux 版 lego，并把 Node.js 与网页管理服务放进容器，NAS 上无需双击任何程序。

镜像地址为 **`ghcr.io/qianshulab/certflow:0.5.1`**，源代码在 [GitHub](https://github.com/qianshulab/certflow)。镜像使用 Node.js 22 与已校验 SHA-256 的 lego v5.5.2，目标架构为 DXP4800 使用的 Linux amd64。每个版本由 GitHub Actions 在 Windows / Linux 上运行测试，再构建 Linux 镜像并验证容器登录、加密凭据与重启持久化；全部通过后才发布到 GHCR。构建状态见 [Actions](https://github.com/qianshulab/certflow/actions/workflows/ci.yml)。

## 首次部署

1. 在 UGOS 中安装并启动 Docker 应用。在 NAS 上创建专用文件夹，例如 `docker/certflow`，放入项目中的 `compose.yaml` 和 `.env.example`。使用已构建的镜像时，无需复制其余源码或 Windows EXE。
2. 将 `.env.example` 复制为同目录下的 `.env`，设置以下两项：

   ```dotenv
   CERTFLOW_PUBLIC_URL=http://192.168.1.100:3390
   CERTFLOW_ADMIN_PASSWORD='在这里填写自己设置的至少12位密码'
   ```

   把 IP 改成 NAS 的实际局域网 IP。这个地址必须与浏览器访问地址完全一致，包括协议、主机和端口；不能保留示例 IP。建议为 NAS 设置固定局域网地址。
3. 在 NAS 的终端或 SSH 中进入刚才的项目文件夹，执行一次：

   ```sh
   docker compose --env-file .env config --quiet
   docker compose --env-file .env pull
   docker compose --env-file .env up -d
   ```

   镜像拉取需要 NAS 能访问 `ghcr.io`。无需在 NAS 主机上安装 Node.js、lego 或 Git。
4. 在同一局域网的浏览器打开 `.env` 中填写的地址，使用管理密码登录。

UGOS 的 Docker 应用支持“项目”形式管理 Compose。也可以通过“项目 → 创建”导入 `compose.yaml`；确保该项目的工作目录中已有 `.env`，再部署。不同 UGOS 版本的目录选择入口可能不同；如果向导只导入 YAML，请先把 `.env` 放到它生成的项目目录。项目启动后，可在 UGOS 的 Docker 界面查看状态、日志和重启。参见[绿联 Docker 项目说明](https://support.ugnas.com/detail/article/en-US/411)。

若 NAS 的 3390 端口已占用，在 `.env` 中同时设置 `CERTFLOW_PORT=3391` 和 `CERTFLOW_PUBLIC_URL=http://你的NAS地址:3391`。容器内部端口始终是 3390，Compose 会完成端口映射。建议使用固定版本标签，便于升级前备份和问题回滚。

## 主机网络备用方案

默认 `compose.yaml` 使用 Docker 桥接网络。如果 NAS 主机可以访问 DNSPod API 和 ACME 服务，但容器访问超时，可以改用项目提供的 `compose.host-network.yaml` 覆盖文件。将该文件放在 `compose.yaml` 所在目录。先确认镜像版本包含此覆盖文件所需的具体 IPv4 监听与健康检查支持；旧版 `0.4.1` 不支持，不能仅复制覆盖文件给旧容器使用。

在 `.env` 中把 `CERTFLOW_BIND_IP` 改为 NAS 的**实际局域网 IPv4**，例如：

```dotenv
CERTFLOW_BIND_IP=192.168.1.100
CERTFLOW_PUBLIC_URL=http://192.168.1.100:3390
CERTFLOW_PORT=3390
```

`CERTFLOW_BIND_IP` 不能是 `0.0.0.0`、环回地址或主机名；主机网络模式会拒绝这些值。主机网络模式下，进程直接占用 NAS 的 `CERTFLOW_PORT`，Docker 不再做端口映射；这个端口须未被其他服务使用。覆盖文件会让 Node.js 优先使用 IPv4，并让证书管理服务只监听指定 NAS 地址；登录密码与浏览器来源校验仍然生效。无需开放 22、80 或 443 端口供 ACME DNS 验证使用。

先检查合并后的配置，再重建服务：

```sh
docker compose --env-file .env -f compose.yaml -f compose.host-network.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.host-network.yaml up -d
docker compose --env-file .env -f compose.yaml -f compose.host-network.yaml ps
```

此模式使用与默认部署相同的 `certflow-data` 数据卷，不需重新输入已保存的 DNS 凭据。以后查看日志、重启或升级时仍须同时指定这两个 `-f` 文件。恢复桥接模式时，仅使用 `compose.yaml` 再执行 `up -d`；保留相同项目目录及数据卷。若主机网络模式仍超时，应分别检查 NAS 的 DNS、出站 HTTPS、代理与防火墙。

## DNS 传播检查兼容方案

如果 DNSPod 已建立 `_acme-challenge` TXT 记录，选定的递归解析器也能查到它，但 lego 一直等待权威 DNS 检查并最终超时，可临时使用 `compose.dns-compat.yaml`。将该文件放在 `compose.yaml` 所在目录。此文件只关闭 lego 对**所有权威名称服务器**的本地传播等待；递归解析器的 TXT 检查仍会执行，Let's Encrypt 也会从自己的网络独立验证域名。此设置不能修复错误的公共 DNS 委派；若其他公共解析器持续返回 NXDOMAIN，证书机构仍可能拒绝签发。选用前应检查并修复域名的权威 DNS 配置。参见 [lego 的 DNS-01 选项说明](https://go-acme.github.io/lego/references/ref-flags/#flags-related-to-the-dns-01-challenge)。

把一个**从容器可访问、且能查询到该 TXT 记录**的递归解析器写入 `.env`，地址须包含端口；多个解析器用逗号分隔。下例地址仅用于说明，需替换为实际核验过的解析器：

```dotenv
CERTFLOW_DNS_RESOLVERS=192.168.1.1:53
```

若同时使用前述主机网络方案，按以下顺序合并三个文件；桥接网络正常时省略中间的 `-f compose.host-network.yaml`。后续升级或重建也应使用相同的 `-f` 组合。

```sh
docker compose --env-file .env -f compose.yaml -f compose.host-network.yaml -f compose.dns-compat.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.host-network.yaml -f compose.dns-compat.yaml up -d
```

DNS 恢复正常后，去掉 `-f compose.dns-compat.yaml` 再执行 `up -d`，即可恢复默认的权威和递归双重传播检查；原数据卷和已保存的 DNS 凭据不受影响。

## 从源码构建（可选）

想修改源码时，复制或克隆整个项目，在同一个目录完成 `.env` 配置后运行：

```sh
docker compose --env-file .env -f compose.yaml -f compose.build.yaml up -d --build
```

这个覆盖文件会使用本地 `certflow:local` 镜像。构建需要访问 Docker 镜像源、Debian 软件源和 GitHub Release。后续对该项目运行 `ps`、`logs`、`stop` 等命令时也可带上这两个 `-f` 参数以保持配置一致。

## 第一次申请证书

1. 进入 DNS 凭据，选择 **DNSPod（ID / Token）**，分别填写 DNSPod 控制台生成的 ID 与 Token 并保存。不要选择腾讯云 SecretId / SecretKey。
2. 在证书配置中填写自己的邮箱、域名及验证方式，阅读并确认 CA 服务条款。
3. 先使用测试环境验证 DNS 配置。测试证书不受浏览器信任；流程成功后切到正式环境申请可用证书。
4. 开启自动续期。开关状态会保存，NAS/容器重启后自动恢复；界面中可查看最近结果和下一次检查时间。

DNS 验证不需要把 NAS 的 80 或 443 端口开放到公网。NAS 需能访问证书机构、DNSPod API 和 DNS 解析服务。管理页面首次启动使用局域网 HTTP 地址，签发专用管理域名的正式证书后可切换为内置 HTTPS。

HTTP 管理地址仅用于受信任局域网内的首次配置。管理会话有效期为 12 小时，退出登录不会停止后台续期。停止整个工具请在 Docker 中停止项目。

## 管理入口 HTTPS 与自动续期

内置 HTTPS 使用 CertFlow 自己管理的一张正式环境证书。它与应用共用已配置的 `CERTFLOW_PORT`，无需占用 UGOS 正在使用的 443 端口。证书任务续期成功后，进程会校验新证书和私钥并更新 TLS 上下文；新连接使用新证书，已有连接自然结束。证书申请失败时继续使用上一张有效证书，并在界面显示错误。请同时开启界面的自动续期，确保 NAS 持续运行。

1. 保持现有局域网 HTTP 地址登录 CertFlow，为专用管理域名建立一个**启用的 DNS 验证任务**，例如任务 ID `certflow-management`、域名 `certflow.example.com`。使用正式环境完成一次签发，确认状态为有效。证书任务的域名必须覆盖后续 HTTPS 地址中的主机名；IP 地址不适合作为此处的证书域名。
2. 确保使用者和目标服务器能把该管理域名解析到 NAS 的可达地址。局域网可在受控的内部 DNS 中配置记录；仅完成 DNS-01 的 TXT 验证不等于浏览器能解析并连接管理域名。浏览器访问地址仍包含端口，例如 `https://certflow.example.com:3390`。
3. 同时修改 `.env` 两项，保留已有管理密码、卷和镜像配置：

   ```dotenv
   CERTFLOW_PUBLIC_URL=https://certflow.example.com:3390
   CERTFLOW_TLS_JOB_ID=certflow-management
   ```

4. 在项目目录检查 Compose 配置并重建。默认桥接网络使用下列命令；已启用主机网络或 DNS 兼容覆盖文件的部署，必须继续在命令中带上相同的 `-f` 文件。

   ```sh
   docker compose --env-file .env config --quiet
   docker compose --env-file .env up -d
   docker compose --env-file .env ps
   ```

5. 用域名和 HTTPS 地址重新登录，核对浏览器展示的证书域名与有效期，以及界面中的自动续期状态。旧的 HTTP 地址不再由该端口提供服务。CertFlow 启动时若找不到匹配、有效的证书或私钥，会拒绝启用 HTTPS；先恢复 `.env` 的局域网 HTTP 地址并清空 `CERTFLOW_TLS_JOB_ID`，修复或续签管理证书后再切换。不要通过关闭浏览器证书校验来绕过证书错误。

管理域名证书续期不依赖其 A/AAAA 记录指向公网，因为 DNS-01 使用 TXT 记录；但管理界面和拉取客户端访问仍需要正确的域名解析与网络路由。只为实际使用的受信任网络开放管理端口，配合 NAS 防火墙限制来源。跨主机拉取接口仅在 CertFlow 自身接收 HTTPS 连接时开放；仅在外部反向代理终止 TLS、代理到 CertFlow 的 HTTP 端口，不会开放该接口。启用拉取时应直接连接内置 HTTPS，或让反向代理也以 HTTPS 连接 CertFlow。

证书到期前若管理任务失败，先在界面检查 DNS 凭据、CA 连接及运行结果。证书已经过期且服务无法以 HTTPS 启动时，可按第 5 步临时恢复局域网 HTTP，用同一任务重新申请有效证书，再重新启用 HTTPS。恢复过程应只在受信任的局域网进行；此时跨主机令牌拉取不可用。

## 数据保存在哪里

默认使用 Docker 命名卷 **`certflow-data`**，挂载到容器 `/data`。容器以 UID/GID `1000:1000` 运行，新命名卷会继承镜像中 `/data` 的所有者与权限。Docker 卷独立于容器生命周期，普通重建会继续使用原数据。参见 [Docker 数据卷说明](https://docs.docker.com/engine/storage/volumes/)。

| 容器内路径 | 内容 |
| --- | --- |
| `/data/cert-config.json` | 邮箱、域名和部署配置 |
| `/data/.certflow/` | 加密凭据、加密密钥、自动续期开关与运行历史 |
| `/data/data/` | ACME 账户、证书、私钥、导出文件和运行状态 |

Linux 上凭据采用 AES-256-GCM 加密，密钥文件由系统文件权限保护：目录 `700`、密钥与凭据文件 `600`。能同时读取密钥文件和密文的人可以解密，因此请把整个数据卷和备份视为私密资料。浏览器不会得到已保存的 Token。

从 Windows 迁移时，Windows DPAPI 加密的凭据不能直接在 Linux 解密。请在 NAS 上重新输入并保存一次 DNS 凭据；不要用 Windows 的 `.certflow/credentials.vault.json` 覆盖 NAS 已建立的凭据文件。

## 使用 NAS 可见目录代替命名卷（可选）

默认命名卷不要求手工配置 NAS 共享目录权限。如果需要通过 NAS 文件管理器备份，可改成专用宿主机目录挂载。以下路径仅为示例，先根据自己的存储位置确认实际绝对路径，并创建一个空目录：

```sh
sudo mkdir -p /volume1/docker/certflow-data
sudo chown 1000:1000 /volume1/docker/certflow-data
sudo chmod 700 /volume1/docker/certflow-data
```

将 Compose 中该服务的 `volumes` 改成：

```yaml
volumes:
  - /volume1/docker/certflow-data:/data
```

只对这一个专用目录设置权限，不要对整个共享目录递归修改。空目录第一次启动会生成配置；如果已有命名卷数据，需要先停止服务并完整迁移数据，再切换挂载，否则看起来会像全新安装。

## 备份、升级与恢复

在没有正在执行的申请/续期任务时停止项目，然后备份整个 `/data`，同时保留项目中的 `.env`。**必须把 `.certflow/credentials.key` 与 `.certflow/credentials.vault.json` 一起备份**，并包含 ACME 账户和私钥。不要只备份导出的证书。备份完成后重新启动项目。

使用命名卷时，可在项目目录执行以下命令，把完整数据写入当前目录的 `certflow-backup.tar`；它包含私钥和凭据密钥，需自行妥善存放。下列备份与升级命令以默认桥接网络为例；如果正在使用主机网络或 DNS 兼容覆盖文件，请给**每条** `docker compose` 命令加上部署时相同的 `-f` 文件组合，避免意外改变运行模式：

```sh
docker compose stop certflow
docker compose run --rm --no-deps -T certflow tar -C /data -cf - . > certflow-backup.tar
docker compose start certflow
```

此示例适用于 NAS 的 Linux 终端。先确认 `certflow-backup.tar` 不存在，避免覆盖已有备份。恢复前先停止服务、保存现状；将备份完整恢复到选定的专用数据目录，保持 UID/GID `1000:1000` 与原有文件权限，再启动。

升级前先备份。将 `.env` 中 `CERTFLOW_IMAGE` 改为所需的已发布版本，在同一项目目录执行：

```sh
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

不要勾选“同时删除数据卷”，也不要执行 `docker compose down -v`，否则会删除命名卷中的证书和账户。正常停止会等待正在进行的申请/续期结束，Compose 留有 35 分钟退出时间；重启后界面中的自动续期开关会恢复原值。

回滚时将 `CERTFLOW_IMAGE` 改回之前使用的版本，再执行同样的命令。跨版本数据格式若不兼容，应配合升级前的完整备份恢复；不要直接让两个版本同时挂载并写入同一个数据卷。

如果修改管理密码或访问地址，也要重新执行 `up -d` 以重新创建容器，单纯重启不会重新读取 `.env`。已经登录的会话随服务重启失效。

## 导入绿联 NAS 管理页面

在“导出与部署”中下载正式环境的 `fullchain.pem` 和 `privkey.pem`，到 UGOS 的“控制面板 → 安全性 → 证书”导入，并在服务配置中选用。某些版本分别要求服务器证书、私钥和中间证书时，分别使用 `cert.pem`、`privkey.pem` 和 `chain.pem`。参见[绿联证书说明](https://support.ugnas.com/detail/article/zh-CN/107)。

当前工具会自动申请、续期并更新导出文件；**UGOS 管理页面仍需在续期后重新导入并选用新证书**。尚未接入未经验证的 NAS 私有接口。

后续给 Docker / Nginx 服务部署时，可给指定服务额外挂载一个专用证书输出目录，并配置该服务实际可执行的检查和重载方式。不要把整个 `/data` 暴露给其他服务，其中包含所有账户、私钥及 DNS 凭据密钥。当前 Compose 没有挂载 Docker socket，也不会直接重启其他容器。

对于**其他服务器**，在目标主机安装 [`certflow-pull.py`](../scripts/certflow-pull.py)，给该证书任务创建独立的只读令牌，并由目标侧定时通过内置 HTTPS 拉取、验证和安装证书。脚本仅在内容更新后执行指定的配置检查与重载命令；一个目标失效时可单独撤销其令牌。完整配置、权限和 Nginx / Docker 示例见 [远程证书拉取](remote-pull.md)。宝塔的手动导入可把同批次的 `fullchain.pem` 内容粘贴到证书框、`privkey.pem` 内容粘贴到私钥框；面板保存后的实际文件路径及重载行为需按站点核对。

## 常见问题

| 现象 | 检查事项 |
| --- | --- |
| 拉取镜像失败 | NAS 是否能访问 `ghcr.io`，版本标签是否已经发布；该镜像仅支持 amd64 |
| 源码构建失败 | NAS 是否能访问镜像源、Debian 软件源与 GitHub，是否使用了 `compose.build.yaml` |
| 页面无法访问 | 容器是否运行、3390 是否冲突、NAS 防火墙是否允许局域网访问 |
| 地址或来源校验失败 | 浏览器地址是否与 `CERTFLOW_PUBLIC_URL` 完全一致；修改后是否重新创建容器 |
| 提示凭据无法解密 | 是否完整恢复同一套 vault 和 key；是否误复制了 Windows DPAPI 文件 |
| 数据目录无权限 | 自定义挂载目录是否由 UID/GID `1000:1000` 所有，`.certflow` 权限是否为 `700` |
| 证书已续期但 NAS 仍提示即将过期 | UGOS 使用的仍是旧证书，需要重新导入并在服务配置选用新证书 |
| 看到遗留运行锁 | 先确认没有其他实例或仍在执行的任务，再按[故障恢复说明](configuration.md#故障恢复)处理 |

运行状态可在 UGOS Docker 界面查看，或执行 `docker compose ps`。诊断日志可用 `docker compose logs --tail=100 certflow`；不要公开 `.env`、数据目录或完整备份。

## 构建与发布维护

推送代码到 `main` 或发起 PR 会运行自动检查和 Docker 冒烟测试。推送与 `package.json` 对应的版本标签（例如 `v0.5.1`）会在全部检查通过后发布 `0.5.1` 和 `latest` 两个镜像标签。也可在 GitHub Actions 的 **Verify and build → Run workflow** 中选择 `main`，勾选 `publish` 手动构建并发布当前版本。GHCR 使用工作流的 `GITHUB_TOKEN`，无需向仓库添加个人访问 Token。

**维护者首次发布后需单独确认包的公开状态。** GHCR 新包默认 private，公开 GitHub 仓库不会自动保证匿名拉取。进入 [CertFlow 包页面](https://github.com/users/qianshulab/packages/container/package/certflow)的 **Package settings → Change visibility → Public**。工作流汇总会记录匿名访问结果；若显示未验证，确认可见性及网络后运行：

```sh
node scripts/verify-registry.mjs ghcr.io/qianshulab/certflow 0.5.1
```

该命令不读取 Docker 登录信息或个人 Token，成功才表示版本 manifest 可匿名读取，并输出其 SHA-256 digest。也可加上工作流记录的 `ghcr.io/qianshulab/certflow@sha256:...` 作为第四个参数，检查公开镜像与测试镜像一致。包权限与仓库权限分别管理，参见 [GitHub 容器仓库说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

每次 Actions 运行还会保留两份平台测试日志和 `container-image-evidence` 工件，后者包含容器测试日志、JSON 验收记录和 Markdown 汇总。记录包含源代码 commit、版本、平台、镜像 ID 和发布 digest。固定部署镜像时，可以把 `.env` 中的 `CERTFLOW_IMAGE` 设为这条完整的 digest 地址。平台不适用的 Windows DPAPI / Linux 权限测试会跳过，但真实 lego 桥接集成在两个平台均为必需项目。

容器冒烟脚本可在安装 Docker 的开发电脑上复用：

```sh
docker build --platform linux/amd64 -t certflow:local .
node scripts/docker-smoke.mjs certflow:local
```

脚本只建立独立的临时容器和数据卷，使用虚构 DNS 凭据，验证 3391 内部端口的健康检查、非 root 只读运行、登录与退出、凭据加密和两次重启后的保存/删除结果。测试容器采用 `--network none`，不会连接 DNSPod 或证书机构；完成后只清理它自身创建的测试资源。真实域名签发仍应先使用测试环境验证。
