# 远程证书拉取与部署

[返回首页](../README.md) · [NAS Docker 部署](docker-nas.md) · [证书导出说明](configuration.md#证书导出与安装)

CertFlow 统一申请和续期证书。其他 Linux 服务器可运行目标侧脚本，通过 HTTPS 拉取**指定任务**的证书 ZIP，检查域名、有效期、证书链组成及私钥配对，成功后切换到新版本并按需检查、重载服务。CertFlow 不需要目标服务器的 SSH、Docker socket 或宝塔管理员凭据。

这种分发方式适合能自行运行 Python 3、OpenSSL 和定时任务的 Nginx / Docker 主机。绿联 UGOS 管理页面没有经过验证的自动导入接口，仍需续期后手动导入。宝塔面板可以手动粘贴证书文本；目标侧自动拉取只适用于站点允许引用受管证书路径、且面板不会在保存配置时覆盖该路径的部署。

## 先决条件

- CertFlow 已按 [NAS HTTPS 指南](docker-nas.md#管理入口-https-与自动续期)启用**内置 HTTPS**，管理域名从目标主机可解析、可连接；目标主机信任其服务器证书。拉取接口不接受 HTTP、重定向或跳过证书校验。
- 要分发的任务已在正式环境签发有效证书，并启用自动续期。目标主机只需要访问 CertFlow 的 HTTPS 端口，不需要直接访问 DNSPod 或证书机构。
- 目标主机安装 Python 3 和 OpenSSL，能运行 [`scripts/certflow-pull.py`](../scripts/certflow-pull.py)。脚本只依赖 Python 标准库与 OpenSSL，证书目录及令牌文件由执行账户独占。
- 确认服务实际需要的域名列表。脚本要求以 `--domain` **完整列出证书的 DNS SAN**，包含通配符时必须加引号，例如 `--domain '*.example.com'`。

## 创建与保存只读令牌

在 CertFlow 的**导出与部署 → 远程拉取**中，为每个目标服务器分别创建一个有名称、到期时间的只读令牌。默认有效期为 365 天，可选 90 天或 30 天；工作台会提示 30 天内到期的令牌。到期前创建新令牌并更新目标端的私有文件，确认拉取成功后撤销旧令牌。令牌只在创建时显示一次；列表只显示标识、任务、创建/到期时间及状态。将令牌放进该目标主机的专用文件，建议由负责运行脚本的账户拥有，目录权限为 `700`、文件权限为 `600`。不要把令牌写进命令行、定时任务、服务配置、镜像或 Git 仓库。

例如以 root 运行目标侧脚本时：

```sh
sudo install -d -m 700 /etc/certflow /etc/certflow/certs
sudo install -m 600 /dev/null /etc/certflow/pull.token
sudoedit /etc/certflow/pull.token
sudo chmod 600 /etc/certflow/pull.token
```

一份令牌只授权一个证书任务，不能申请证书、修改配置或读取 DNS 凭据。撤销令牌后目标主机下一次拉取会失败；删除任务或更改其环境、域名也会使旧令牌失效。暂停任务会暂时停止拉取，恢复任务后未撤销且未过期的令牌仍可使用；若需永久切断某台目标主机的访问，应撤销其令牌。令牌泄露时先在界面撤销，再为目标主机创建新令牌并更新其私有文件。

## 首次拉取

把脚本安装在目标 Linux 主机，例如 `/usr/local/libexec/certflow-pull.py`。以下示例的管理域名、任务 ID、SAN 和路径须替换为实际值；`--server` 是 HTTPS **origin**，不带 API 路径：

```sh
sudo install -m 700 scripts/certflow-pull.py /usr/local/libexec/certflow-pull.py
sudo python3 /usr/local/libexec/certflow-pull.py \
  --server https://certflow.example.com:3390 \
  --job site-example \
  --domain example.com \
  --domain '*.example.com' \
  --token-file /etc/certflow/pull.token \
  --target /etc/certflow/certs/site-example \
  --check-command '["nginx","-t"]' \
  --reload-command '["nginx","-s","reload"]'
```

首次执行前，Nginx 配置必须已引用脚本将维护的路径；如果该站点仍使用旧证书路径，请先完成一次**不带**检查/重载命令的拉取，修改站点配置并验证，再增加这两个命令。`--reload-command` 必须与 `--check-command` 一同提供。两个参数是 JSON 参数数组，脚本直接运行程序，不经 shell 解释，不支持 `&&`、管道或变量展开；命令需在执行账户权限下实际可用。脚本只在 ZIP 内容变化后运行检查与重载，重复拉取不会重复重载。

Nginx 站点配置指向整个受管目录内的 `current` 链接：

```nginx
ssl_certificate     /etc/certflow/certs/site-example/current/fullchain.pem;
ssl_certificate_key /etc/certflow/certs/site-example/current/privkey.pem;
```

脚本通过 `GET /api/pull/site-example/bundle.zip` 拉取四个文件：`cert.pem`、`chain.pem`、`fullchain.pem`、`privkey.pem`。它不会把令牌放进 URL。每套文件保存在 `versions/<内容哈希>/`，`current` 在完整验证后原子切换；检查或重载失败时尝试恢复上一套，并保留旧版本供排查。每张证书的版本目录和私钥文件默认分别仅对执行账户开放（`700` / `600`）。执行账户和目标服务必须具有读取新证书及重载服务的实际权限；示例中的 Nginx 通常由 root 主进程读取私钥。

### Docker 中的 Nginx

将**整个受管目录**只读挂载到服务容器，避免单文件挂载在版本切换后仍指向旧文件。例如在目标主机的 Nginx Compose 中：

```yaml
services:
  nginx:
    volumes:
      - /etc/certflow/certs/site-example:/etc/nginx/certflow/site-example:ro
```

容器中的 Nginx 配置使用 `/etc/nginx/certflow/site-example/current/fullchain.pem` 和 `/etc/nginx/certflow/site-example/current/privkey.pem`。在**目标主机**执行脚本，并将检查/重载命令按实际容器名改成 JSON 参数数组，例如 `'["docker","exec","web-nginx","nginx","-t"]'` 和 `'["docker","exec","web-nginx","nginx","-s","reload"]'`。当前 CertFlow 容器不会直接控制该 Nginx 容器。若目标容器以非 root 用户读取私钥，需额外设计只授予该服务的文件读取权限；不能为了使挂载可读而把整个 CertFlow 数据卷共享给服务。

### 宝塔站点

手动安装时，在 CertFlow 的导出区复制**同一次签发**的 `fullchain.pem` 内容到宝塔 SSL 的证书文本框，把 `privkey.pem` 内容放入私钥文本框，保存后核对站点实际呈现的证书。另有 `cert.crt` 和 `privkey.key` 下载；`cert.crt` 只含域名证书，与 `cert.pem` 相同，**不等于**包含中间证书的 `fullchain.pem`。不要把 `chain.pem` 单独当作域名证书，也不要混用不同签发批次。

若站点配置可稳定引用受管目录，也可以在宝塔服务器上运行本脚本。宝塔面板后续保存站点 SSL 设置可能改写 Nginx 路径，自动拉取能更新文件并不保证面板仍在使用它们；首次配置及面板升级后应再次检查 Nginx 配置与线上证书。当前版本没有宝塔面板 API 自动导入。

## 定时执行与状态检查

目标侧拉取可以由 systemd timer、cron 或其他受控调度器执行。以下示例每天检查两次，错过的检查会在开机后补跑；CertFlow 自身的自动续期开关仍须开启。

创建只包含命令和非秘密参数的 `/usr/local/sbin/pull-site-cert.sh`，设为 `700`：

```sh
#!/bin/sh
set -eu
exec /usr/bin/python3 /usr/local/libexec/certflow-pull.py \
  --server https://certflow.example.com:3390 \
  --job site-example \
  --domain example.com \
  --domain '*.example.com' \
  --token-file /etc/certflow/pull.token \
  --target /etc/certflow/certs/site-example \
  --check-command '["nginx","-t"]' \
  --reload-command '["nginx","-s","reload"]'
```

```ini
# /etc/systemd/system/certflow-pull-site.service
[Unit]
Description=Pull site-example certificate from CertFlow
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pull-site-cert.sh
```

```ini
# /etc/systemd/system/certflow-pull-site.timer
[Unit]
Description=Check site-example certificate twice daily

[Timer]
OnCalendar=*-*-* 03:30:00
OnCalendar=*-*-* 15:30:00
RandomizedDelaySec=15m
Persistent=true
Unit=certflow-pull-site.service

[Install]
WantedBy=timers.target
```

```sh
sudo chmod 700 /usr/local/sbin/pull-site-cert.sh
sudo systemctl daemon-reload
sudo systemctl enable --now certflow-pull-site.timer
sudo systemctl start certflow-pull-site.service
sudo systemctl status certflow-pull-site.service
```

首次拉取后检查目标目录、`nginx -t` 和站点实际呈现的证书域名与到期时间。脚本成功仅表示目标侧文件与配置检查/重载命令按预期完成，不能替代对外服务探测。令牌到期、NAS 离线或网络故障时，目标侧保留上一张证书；应同时关注 CertFlow 的续期状态和目标定时任务失败状态。

## 安全与故障恢复

- 拉取脚本强制验证 HTTPS 主机名和证书，不跟随重定向，也不使用环境中的 HTTP 代理。若管理端使用受信任的私有 CA，可用 `--ca-bundle /path/to/ca.pem` 提供可信根证书；不要关闭 TLS 校验。目标目录、令牌文件和自定义 CA 文件均应放在受控路径，不能经过符号链接或位于 `/tmp` 等共享可写目录。目标主机到 NAS 的防火墙规则只开放所需地址和端口。
- ZIP 含未加密私钥。脚本限制下载大小、文件名单和权限，检查证书/私钥配对、完整 SAN 集合及有效期。只给需要证书的目标主机分配令牌；各目标使用不同令牌以便单独撤销。
- `.pull.lock` 是持久锁文件，进程退出会自动释放锁；**不要删除它**。版本目录不会自动清理，备份与磁盘容量规划应包含旧版本。备份目标目录时，也要保护其中的私钥和令牌文件。
- 如果检查或重载失败，脚本会尝试把 `current` 恢复到上一套并再次重载。首次安装没有上一套可恢复；服务进程收到信号、主机断电或回滚失败时，脚本会保留 `.transaction.json`，后续拉取在联网前停止。此时先查看该文件记录的 `previous` / `next` 和 `current` 指向，核对服务实际证书，选择旧版或新版，手工验证并重载后再移除日志文件。不要直接删除日志后盲目重试，也不要删除 `versions` 中的证书材料。
- 目标任务域名或环境改变后重新签发并重新授权，目标脚本的全部 `--domain` 参数也要同步更新。无法取得新证书时保留现有版本并排查 CertFlow 的任务状态、DNS 凭据和令牌状态。
