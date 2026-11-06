# MailHarbor（邮件港）

[![CI](https://github.com/Zac-Linley/dsh-plugin-mailharbor/actions/workflows/ci.yml/badge.svg)](https://github.com/Zac-Linley/dsh-plugin-mailharbor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zaclinley/dsh-mailharbor.svg)](https://www.npmjs.com/package/@zaclinley/dsh-mailharbor)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-4B67B4)](https://github.com/Zac-Linley/dsh-plugin-mailharbor)

**把多个 IMAP/SMTP 邮箱接进 [DeepSeek Harness](https://github.com/Zac-Linley/dsh-plugin-mailharbor) 的邮件工作区。**

MailHarbor 在 DSH 左侧栏加一个「邮件」入口，主面板里是完整的收发邮件工作区：浏览本地备份或
服务器实时邮件、搜索、安全地渲染 HTML 正文、写邮件与回复、保存草稿，也可以让模型通过
`mail_*` 工具直接读信。每个账号有独立的数据目录、草稿和已读状态。

- 包名：`@zaclinley/dsh-mailharbor`
- 要求：**DSH `>=0.2.2-0 <0.3.0`**，Node **>=24.9**（DSH 自带运行时即可）
- 许可证：MIT
- 状态：**v0.1.0 — 核心邮件工作区**。OAuth2、AI 动作和 CalDAV 在路线图中（见[路线图](#路线图)）。

## 功能

| 区域       | 能做什么                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| 账号       | 任意 IMAP/SMTP 邮箱；密码或应用专用密码；每账号独立数据目录；顶栏切换账号                             |
| 本地备份   | 增量 IMAP → SQLite：UIDVALIDITY 处理、分批事务、内容寻址附件、trigram 全文索引                        |
| 浏览       | 文件夹、分页、按主题/发件人/收件人/正文/附件名搜索                                                    |
| 服务器实时 | 直接从 IMAP 读取最新邮件，每行标注「已备份 / 未备份」                                                 |
| 阅读       | sandbox iframe + 严格 CSP 渲染 HTML，远程图片默认拦截，纯文本回退，附件下载                           |
| 写邮件     | 富文本正文、附件（8 MB）、回复/全部回复/转发（`In-Reply-To` 与 `References`）、存草稿、二次确认后发送 |
| 凭据       | macOS 钥匙串、Linux libsecret、Windows Credential Locker；密码不写入 `config.json`                    |
| Agent 工具 | `mail_status`、`mail_list`、`mail_read`、`mail_search`、`mail_drafts`、`mail_draft`、`mail_backup`    |
| 设置页     | DSH 设置里的「MailHarbor」：账号与服务器、连接检查、签名、已读行为、列表数量、AI 模型                 |
| 工程化     | 真实构建链、GitHub Actions CI、Changesets 版本管理、npm provenance                                    |

## 安装

```bash
dsh plugin --profile desktop add @zaclinley/dsh-mailharbor
```

安装后重新加载窗口（或重启 DSH），浏览器端插件包才会加载。包内的 `cordis.patch.yml`
会自动插入 `mailharbor` 这一行。

从本地仓库安装：

```bash
git clone https://github.com/Zac-Linley/dsh-plugin-mailharbor.git
cd dsh-plugin-mailharbor
npm ci && npm run build
dsh plugin --profile desktop add link:$PWD
```

> 如果之前装过旧的 `dsh-plugin-mail`，请先移除那一行：两个插件都占用 `/mail-plugin`
> 的 HTTP 前缀，只能有一个生效。

## 第一次使用

1. 从左侧栏打开 **MailHarbor**。
2. 添加账号：邮箱地址 + 密码（或应用专用密码）。「高级设置」里可改 IMAP/SMTP 主机、端口和 TLS；
   保存前会真实连接一次 IMAP 校验。
3. 先浏览 **本地备份**；点顶部「备份」把服务器邮件同步下来。
4. 切到 **服务器实时** 看最新邮件，点「写邮件」开始写信。

### Gmail、Outlook 与其他服务商

- Gmail：在 Gmail 设置里启用 IMAP，使用**应用专用密码**（需先开启两步验证）。OAuth2 登录在 v0.2 提供。
- Microsoft 365：基本认证已停用；只有租户仍允许 IMAP AUTH 时才能用应用专用密码，否则等 OAuth2 版本。
- Yahoo：应用专用密码。自建邮箱：任何支持 STARTTLS 或隐式 TLS 的 IMAP/SMTP 都可以。

## 数据与隐私

| 内容             | 位置                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| 插件状态         | `~/.dsh/mailharbor`（`DSH_MAILHARBOR_DATA_DIR`）                      |
| 配置（不含密码） | `~/.dsh/mailharbor/config.json`（`DSH_MAILHARBOR_CONFIG`）            |
| 每账号备份库     | `~/.dsh/mailharbor/accounts/<id>/mail.db` + `attachments/`            |
| 草稿 / 已读      | `<account>/drafts.json`、`<account>/read-state.json`                  |
| 密码             | 只进系统凭据库；脚本化场景可用 `DSH_MAILHARBOR_PASSWORD_<ACCOUNT_ID>` |

- 面板和工具以**只读**方式打开备份库，只有备份引擎会写入。
- HTML 邮件在 `sandbox` iframe 中渲染，CSP 为 `default-src 'none'`；脚本、表单不执行，远程图片默认不加载。
- HTTP 接口只监听 DSH 自己的回环端口，跨站写请求返回 `403`。
- `mail_*` 工具不能发信：没有 `mail_send`，发送必须由用户在面板里确认。

## Agent 工具

| 工具                         | 用途                                         |
| ---------------------------- | -------------------------------------------- |
| `mail_status`                | 账号、登录状态、本地邮件数、上次备份         |
| `mail_list`                  | 列出本地或服务器邮件（文件夹、关键词、条数） |
| `mail_read`                  | 读一封邮件全文，带附件元数据                 |
| `mail_search`                | 本地备份全文搜索                             |
| `mail_drafts` / `mail_draft` | 列出、新建或更新本地草稿——永不发送           |
| `mail_backup`                | 后台启动一次增量备份                         |

## 开发

```bash
npm ci
npm run build        # lib/index.js（Host）+ lib/client.js（浏览器包）
npm run dev          # 监听改动，DSH 自动热重载
npm run typecheck
npm run lint
npm test             # Vitest：单元 + HTTP 集成 + 构建产物契约
npm run check        # typecheck + lint + build + test + pack 检查
```

目录结构：

```
src/host/       Node 端：配置、凭据、IMAP、SMTP、SQLite、备份、HTTP API、工具
src/client/     浏览器端：面板、阅读页、写信、设置、样式
src/shared/     两端共享的协议类型
scripts/        build.mjs（esbuild）、sync-version.mjs
test/           Vitest 测试（fixture 自动生成，不需要真实邮箱）
```

浏览器包由 esbuild 构建成 DSH 的模块加载格式
（`window.__ModuleLoader__.load({ id, factory })`），`id` 必须等于包名。React / React DOM
来自宿主共享模块表，不打进包里。

### 发布

版本用 [Changesets](https://github.com/changesets/changesets) 管理：

```bash
npx changeset          # 描述改动并选择 bump 级别
npm run version        # 写 CHANGELOG.md，更新 package.json 与 VERSION 常量
```

CI 会在 `main` 上通过 `.github/workflows/release.yml` 发布；仓库需要配置有 `@zaclinley/*`
发布权限的 `NPM_TOKEN` secret。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 路线图

| 版本      | 范围                                                                  |
| --------- | --------------------------------------------------------------------- |
| **0.1.x** | 核心邮件工作区、备份、工具、设置、发布流水线                          |
| 0.2       | OAuth2 + XOAUTH2（Gmail loopback/PKCE、Microsoft 设备码）、token 刷新 |
| 0.3       | AI 摘要、起草辅助、自然语言搜索、写作风格档案                         |
| 0.4       | CalDAV 任务、Markdown/PDF 报告                                        |
| 以后      | 导出/导入、引导流程、更完整的附件支持                                 |

## 许可证

[MIT](LICENSE) © 2026 Zac Linley
