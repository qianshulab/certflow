<div align="center">

<img src="web/brand.svg" width="72" height="72" alt="CertFlow 图标">

# CertFlow

**自托管 HTTPS 证书管理工作台**

申请、续期、导出与本地部署，在一个深色工作台中完成。

[![Verify and build](https://github.com/qianshulab/certflow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/qianshulab/certflow/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.4.1-ff6633)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-43853d)](package.json)
[![Docker platform](https://img.shields.io/badge/Docker-linux%2Famd64-2496ed)](Dockerfile)

[快速部署](#快速部署) · [使用文档](#文档) · [问题反馈](https://github.com/qianshulab/certflow/issues) · [构建记录](https://github.com/qianshulab/certflow/actions)

</div>

![CertFlow 深色证书管理工作台（0.4.0 版本界面）](docs/gui-preview.jpg)

CertFlow 基于 [lego](https://github.com/go-acme/lego) 与 Let's Encrypt，为个人服务器、NAS 和自托管服务提供统一的证书管理界面。支持 Windows 本机运行和 Linux Docker 部署；配置、ACME 账户、证书与 DNS 凭据保存在运行设备上，无需外部数据库。

## 功能

| 能力 | 说明 |
| --- | --- |
| **证书管理** | 多任务、多域名、通配符；搜索、状态筛选与任务详情 |
| **自动申请与续期** | DNS-01 / HTTP-01 验证、周期检查、失败退避、重启恢复调度 |
| **DNS 凭据管理** | DNSPod ID / Token、腾讯云 DNSPod、Cloudflare、阿里云 DNS；支持加密长期保存 |
| **导出与部署** | 四种 PEM 文件、整套 ZIP 下载；本地目录更新、配置检查、服务重载与失败回滚 |
| **运行检查** | 申请前检查客户端、凭据格式、目录权限、运行锁与本地状态 |
| **日常操作** | 单任务暂停、部署重试、活动记录、表单校验与未保存草稿保护 |

暂停的任务不会参与自动续期或“检查全部”，仍可单独手动执行。运行检查不创建 DNS 记录，不申请证书，也不执行服务重载。

## 快速部署

### NAS / Docker

需要支持 **Linux amd64** 的 Docker 主机和 Docker Compose。容器包含 Node.js 与 Linux 版 lego，NAS 无需安装 Windows `.exe` 或额外运行时。

**1. 准备部署文件**

将 [compose.yaml](compose.yaml) 和 [.env.example](.env.example) 放入同一个专用目录，也可在 NAS 终端下载：

```sh
mkdir -p certflow
cd certflow
curl -fsSLO https://raw.githubusercontent.com/qianshulab/certflow/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/qianshulab/certflow/main/.env.example
cp .env.example .env
```

**2. 编辑 `.env`**

使用文本编辑器填写以下配置，再启动服务：

| 配置项 | 要求 |
| --- | --- |
| `CERTFLOW_PUBLIC_URL` | 必填。浏览器实际访问地址，例如 `http://192.168.1.100:3390`；替换为实际 NAS 地址 |
| `CERTFLOW_ADMIN_PASSWORD` | 必填。自行设置至少 12 位管理密码；无默认密码 |
| `CERTFLOW_IMAGE` | 默认固定为 `ghcr.io/qianshulab/certflow:0.4.1` |
| `CERTFLOW_PORT` | 默认 `3390`；修改后同步调整访问地址中的端口 |

访问地址必须与浏览器使用的协议、主机和端口一致。`.env.example` 中的密码为空，未配置时 Compose 会拒绝启动。

**3. 启动并登录**

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

在浏览器打开配置的 `CERTFLOW_PUBLIC_URL`，使用管理密码登录。UGOS 也可通过 Docker「项目」导入 Compose，详细步骤见 [NAS Docker 部署指南](docs/docker-nas.md)。

默认使用命名卷 **`certflow-data`** 保存数据，普通容器重建会继续使用原数据。服务采用 `restart: unless-stopped`；关闭浏览器不会停止后台续期。镜像发布与架构信息以 [GHCR 包页面](https://github.com/users/qianshulab/packages/container/package/certflow)及 [Actions](https://github.com/qianshulab/certflow/actions/workflows/ci.yml)记录为准。

### Windows / 本机运行

需要 **Node.js 22+** 与 **lego v5.5.2**。从 [lego 官方发布页](https://github.com/go-acme/lego/releases/tag/v5.5.2)下载匹配系统的程序，核对发布页提供的校验和，将其加入 `PATH`，或在界面高级设置中指定路径。

下载源码或克隆仓库，进入项目目录后运行：

```sh
npm start
```

打开 `http://127.0.0.1:3390`。Windows 可直接双击 [`启动图形界面.cmd`](启动图形界面.cmd)，通过 [`停止图形界面.cmd`](停止图形界面.cmd)退出服务。

应用运行时无 npm 第三方依赖，无需执行 `npm install`。本机模式默认仅监听 `127.0.0.1`；网络部署必须设置管理密码与访问地址。Windows 启动器不会注册开机启动任务，长期运行建议使用 Docker。

## 首次申请

1. 在 **DNS 凭据** 中选择服务商，保存对应凭据。
2. 在 **证书配置** 中填写联系邮箱、域名和验证方式，阅读并确认 CA 服务条款。
3. 保持 **测试环境**，先执行“检查运行环境”，再申请测试证书验证完整流程。
4. 测试成功后切换到 **正式环境**，申请受浏览器信任的证书。
5. 在 **导出与部署** 中下载文件，或配置本地自动部署；开启自动续期。

`example.com` 与 `*.example.com` 覆盖范围不同，通配符不包含主域名。DNS 验证适用于内网服务，无需开放 NAS 的公网 80 端口；HTTP 验证需要公网 80 端口可访问 webroot，且不支持通配符。

> 测试证书不受浏览器信任。测试与正式环境的数据分开保存，测试环境禁止自动部署。

### DNSPod 凭据选择

| 创建位置 | 界面选项 | 凭据类型 |
| --- | --- | --- |
| [DNSPod 控制台 → 创建 Token](https://console.dnspod.cn/account/token/token) | **DNSPod · ID / Token** | 数字 Token ID 与 Token，分开填写 |
| [腾讯云访问管理 → API 密钥](https://console.cloud.tencent.com/cam/capi) | **腾讯云 DNSPod · 云 API** | SecretId 与 SecretKey |

两种凭据不能混用。DNSPod Token 模式对应 `dnspod-token`；腾讯云模式对应 `tencentcloud`。其他服务商及环境变量配置见 [DNS 验证参考](docs/configuration.md#dns-验证)。

<details>
<summary>查看 DNS 凭据管理界面</summary>

![CertFlow DNS 凭据管理](docs/gui-credentials.jpg)

</details>

## 续期与部署

续期会签发一张新证书，原证书的有效期不会延长。服务需要加载新文件，客户端才能使用更新后的证书。

| 使用场景 | 更新方式 |
| --- | --- |
| **绿联 UGOS 管理页面** | 下载新证书，在控制面板导入，并在服务配置中选用；每次续期后需重新导入 |
| **Nginx / 宝塔站点** | 配置可访问的证书目录、检查命令与重载命令，签发或续期后自动更新 |
| **Docker 中的服务** | 挂载专用证书目录，按实际环境配置检查与重载方式 |
| **其他设备或托管平台** | 下载 PEM / ZIP 文件后，通过目标平台的证书管理入口安装 |

导出包含 `cert.pem`、`chain.pem`、`fullchain.pem` 和 `privkey.pem`。同一次签发的证书与私钥应成套使用；具体字段映射见 [证书导出与安装](docs/configuration.md#证书导出与安装)。

自动部署在运行 CertFlow 的环境中执行命令。默认 Docker 配置不挂载 Docker socket，也不控制其他容器；跨主机分发、宝塔面板 API 与 UGOS 管理页面自动导入未提供。

## 数据与运行边界

- **数据持久化**：Docker 数据保存在 `/data`，包含配置、ACME 账户、私钥、DNS 凭据及续期设置。备份应覆盖整个数据卷，升级前保留完整备份。
- **凭据保护**：Windows 使用当前用户 DPAPI；Linux 使用 AES-256-GCM 与受权限保护的本地密钥。可读取密文和密钥的系统用户仍可解密；备份需要同等保护。
- **访问控制**：网络模式要求管理员登录，访问地址按 `CERTFLOW_PUBLIC_URL` 校验。HTTP 管理地址用于受信任局域网；远程访问应配置 HTTPS 反向代理或受保护的内网连接。
- **持续运行**：自动续期要求服务在线、DNS 凭据有效，并能访问 CA、DNS API 与解析服务。Windows DPAPI 凭据迁移到 Linux 时需要重新保存。
- **部署结果**：界面显示本地文件和历史运行状态，不代表已验证公网服务当前呈现的证书。部署采用逐文件替换，不提供证书与私钥的同时原子切换。
- **集成范围**：DNS 权限、公网连通性、UGOS 版本及目标服务重载需在实际部署环境验证；自动化测试不构成真实域名签发或 NAS 兼容性认证。

## 文档

| 文档 | 内容 |
| --- | --- |
| [NAS Docker 部署](docs/docker-nas.md) | UGOS 项目导入、持久化、反向代理、备份、升级与镜像发布 |
| [配置与运维参考](docs/configuration.md) | DNS / HTTP 验证、CLI、调度、Nginx 部署与故障恢复 |
| [配置示例](cert-config.example.json) | 默认测试环境与任务结构 |
| [Docker Nginx 示例](examples/nginx-docker-config.json) | 宿主机部署目录及容器重载命令 |
| [安全说明](SECURITY.md) | 凭据、数据目录与管理入口保护 |
| [版本验收记录](docs/RELEASE-0.4.1.md) | v0.4.1 的检查项目、测试证据与验证范围 |

## 开发

```sh
git clone https://github.com/qianshulab/certflow.git
cd certflow
npm run check
node scripts/setup-test-lego.mjs
npm test
```

测试要求 Node.js 22。`setup-test-lego.mjs` 下载并校验固定版本客户端；CI 在 Windows 与 Linux 上运行测试，并对 Linux amd64 镜像进行隔离容器检查。平台不适用的检查会单独标记，具体结果见工作流日志。

本地容器检查需要安装 Docker：

```sh
docker build --platform linux/amd64 -t certflow:local .
node scripts/docker-smoke.mjs certflow:local
```

问题报告请提交到 [Issues](https://github.com/qianshulab/certflow/issues)，附上版本、部署方式与脱敏后的复现步骤。请勿上传 `.env`、DNS Token、证书私钥或完整数据备份。发布流程见 [构建与发布维护](docs/docker-nas.md#构建与发布维护)。
