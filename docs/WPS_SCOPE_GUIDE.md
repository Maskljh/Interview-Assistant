# WPS 开放平台权限（Scope）申请操作指南

> 用途：为「面试助手」新增的两个功能开通所需的 WPS 365 开放平台用户授权权限：
> 1. **从 WPS 云文档选择简历** —— 需要云文档的读/搜索权限
> 2. **面试报告发送到用户邮箱** —— 需要邮箱的读/写权限

---

## 一、需要申请的权限

| Scope | 说明 | 对应功能 |
|-------|------|---------|
| `kso.drive.readwrite` | 云盘列表（我的云文档）| 从 WPS 云文档选简历 |
| `kso.file.read` | 读取云文档文件列表、获取下载信息 | 从 WPS 云文档选简历 |
| `kso.file_search.readwrite` | 按文件名搜索云文档（**不是 kso.file.search**）| 云文档搜索 |
| `kso.mail.readwrite` | 创建并发送邮件 | 报告发送到邮箱 |
| `kso.mailbox.read` | 获取邮箱列表 | 报告发送到邮箱 |

> 最终 `WPS_SCOPE=kso.user_base.read,kso.drive.readwrite,kso.file.read,kso.file_search.readwrite,kso.mail.readwrite,kso.mailbox.read`（当前 .env 已按此配置，功能已全部测试通过）

> 说明：这是**用户授权**（User Authorization）类权限，用户登录应用时会看到授权确认页，同意后应用获得该用户自己的云文档与邮箱操作能力，不会越权访问他人数据。

---

## 二、申请步骤

### 1. 登录开发者后台
访问 [open.wps.cn](https://open.wps.cn)，使用 WPS 企业账号登录开发者后台。

### 2. 进入应用管理
找到「面试助手」对应的应用（与 `.env` 中 `WPS_CLIENT_ID` 一致的应用）。

### 3. 申请权限 Scope
进入应用的**权限管理**页面，依次搜索并申请以下用户授权权限：
- `kso.file.read`
- `kso.file.search`
- `kso.mail.readwrite`
- `kso.mailbox.read`

### 4. 创建版本并发布
在**版本管理**中创建新版本，填写变更说明（例如「新增云文档选简历与报告发送邮箱功能，申请对应用户权限」），提交发布。

### 5. 企业管理员审批
发布申请会进入**企业管理员审批**流程，需要 WPS 企业管理员在管理后台同意后，权限才会正式生效。

### 6. 更新本地配置
审批通过后，将项目根目录 `.env` 中的 `WPS_SCOPE` 更新为完整权限列表：

```dotenv
WPS_SCOPE=kso.user_base.read,kso.file.read,kso.file.search,kso.mail.readwrite,kso.mailbox.read
```

> 当前项目的 `.env` 已按此配置。若应用因其他原因被重置，请按上面格式重新填写。

---



---

## 四、生效与验证

1. **重新登录生效**：权限变更后，用户需要**退出并重新登录**一次，授权页会新增云文档/邮箱权限的授权确认。
2. **验证云文档选简历**：创建面试 → 简历「上传」→「从 WPS 云文档选择」→ 应能看到云文档中的简历文件（.pdf/.docx/.txt/.md）。
3. **验证报告发邮箱**：面试报告页点击「发送报告到我的邮箱」→ 提示已发送至你的 WPS 邮箱；登录 [mail.wps.cn](https://mail.wps.cn) 查收。

---

## 四、常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 登录授权页报「权限不存在/未开通」 | scope 尚未在开发者后台申请或未通过审批 | 按上文完成申请 + 版本发布 + 管理员审批 |
| 云文档列表为空 | 云盘中确实没有简历文件；或 `kso.file.read` 未生效 | 先在 WPS 云盘上传简历；确认权限生效后重新登录 |
| 发送邮箱提示权限未开通 | `kso.mail.readwrite` / `kso.mailbox.read` 未生效 | 确认审批通过并重新登录 |
| 接口返回 502 | access_token 过期且刷新失败 | 重新登录一次即可（token 已实现自动刷新） |
