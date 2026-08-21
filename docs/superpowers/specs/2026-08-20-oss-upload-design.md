# 简历 / JD 文件上传 OSS — 设计文档

日期：2026-08-20 · 版本：v1

## 背景与目标

创建面试页当前仅支持：简历**前端本地解析**为文本（`extractResumeText`）、JD **粘贴文本**。没有文件存档能力。

目标：支持将简历 / JD **原文件上传到阿里云 OSS** 存档。面试创建时仍使用解析出的文本（现有逻辑不变），但 OSS 文件 URL 存入数据库，详情页可查看/下载原文件。

## 架构

**前端直传阿里云 OSS + 后端预签名**。文件不经过应用服务器，后端仅提供签名接口，避免服务器带宽/大小限制。

## 数据流

1. 创建面试页：用户选择简历 / JD 文件（均可选，文本粘贴/前端解析保留）。
2. 前端调后端 `POST /api/uploads/sign`（携带文件名、类型、大小、用途 resume|jd）→ 后端返回：预签名 PUT URL、最终对象 key。
3. 前端用 `PUT` 直传文件到 OSS（显示进度），成功后持有对象 URL。
4. 前端把 OSS 对象 URL + 解析文本一起提交 `POST /api/interviews`。
5. 后端在 `interview_sessions` 存文件 URL（新增列）。
6. 详情页显示「查看简历原文件 / 查看 JD 原文件」，新窗口打开 OSS URL。

## 后端改动

| 模块 | 改动 |
| --- | --- |
| `internal/config/config.go` | 新增 `OSSBucket`、`OSSRegion`、`OSSEndpoint`、`OSSAccessKeyID`、`OSSAccessKeySecret`，从 `.env` 读取 `OSS_BUCKET`、`OSS_REGION`、`OSS_ENDPOINT`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` |
| 新 `internal/upload/` | `handler.go`：`POST /api/uploads/sign`（JWT 保护）；`service.go`：用阿里云 AK/SK + bucket 生成预签名 PUT URL（aliyun-oss-go-sdk） |
| `cmd/server/main.go` | 注册 upload 路由 |
| 新 `migrations/010_oss_urls.sql` | `interview_sessions` 新增 `resume_file_url VARCHAR(1024) NULL`、`jd_file_url VARCHAR(1024) NULL` |
| `internal/interview/` | `createRequest` 增 `resume_file_url`、`jd_file_url`；`Session` 模型、`sessionResponse`、`repo.go` SQL、`service.go` Create 相应扩展 |

### 签名接口设计

`POST /api/uploads/sign`
请求体：
```json
{
  "kind": "resume" | "jd",
  "filename": "my-resume.pdf",
  "content_type": "application/pdf",
  "size": 204800
}
```
响应：
```json
{
  "key": "uploads/{userId}/{uuid}.pdf",
  "put_url": "https://test-ljh.oss-cn-beijing.aliyuncs.com/uploads/{userId}/{uuid}.pdf?OSSAccessKeyId=...&Signature=...&Expires=...",
  "object_url": "https://test-ljh.oss-cn-beijing.aliyuncs.com/uploads/{userId}/{uuid}.pdf",
  "expires_in": 300
}
```
- 对象 key 前缀 `uploads/{userId}/`，文件名用 UUID 重命名，保留原扩展名。
- PUT URL 有效期 300 秒。
- 校验：登录用户（JWT）、`kind` 仅允许 resume|jd、`size` ≤ 10MB、扩展名在允许集（`.txt .md .pdf .docx`）、`content_type` 白名单。

## 前端改动

| 文件 | 改动 |
| --- | --- |
| `frontend/src/api/uploads.ts`（新） | `signUpload(kind, file)` 调签名接口 |
| `frontend/src/lib/ossUpload.ts`（新） | `uploadToOSS(putUrl, file, onProgress)` 用 fetch PUT 直传 |
| `frontend/src/pages/CreateInterviewPage.tsx` | 简历文件选择后：现有 `extractResumeText` 解析文本 + 新上传 OSS 并存 URL；JD 增加文件上传选项（解析文本为 JD + 上传文件）；提交 `createInterview` 时带两个 URL；显示上传进度与文件名 |
| `frontend/src/api/interviews.ts` | `createInterview` 请求体加 `resume_file_url`/`jd_file_url` |
| `frontend/src/pages/InterviewDetailPage.tsx` | 有 URL 时显示「查看简历原文件」「查看 JD 原文件」链接（`target="_blank"`） |

## 非目标

- 不改前端本地解析逻辑（`extractResumeText` 保留，文本仍用于匹配度检测与 AI 出题）。
- 不做 OSS 文件删除/生命周期管理（本次仅上传+存档）。
- 不做 STS 临时凭证（直接预签名 PUT，AK/SK 在后端不暴露给前端）。
- 不改按钮 UI / 删除 Modal（独立计划，后续）。
- JD 文件上传为可选增强；JD 仍以文本为核心。

## 配置（写 .env，不入 git）

```
OSS_BUCKET=test-ljh
OSS_REGION=oss-cn-beijing
OSS_ENDPOINT=https://oss-cn-beijing.aliyuncs.com
OSS_ACCESS_KEY_ID=<专用 AK>
OSS_ACCESS_KEY_SECRET=<专用 SK>
```
（用户已提供以上配置；凭据仅写入 `.env`，该文件已被 `.gitignore` 忽略。）

## 验收标准

- [ ] `config` 读取 OSS 配置；缺失时上传接口返回 503「OSS 未配置」
- [ ] `POST /api/uploads/sign` 返回预签名 PUT URL 与对象 key
- [ ] 前端直传文件到 OSS 成功，详情页能打开 OSS 原文件
- [ ] 创建面试带 `resume_file_url`/`jd_file_url` 时，数据库正确存储，详情接口返回
- [ ] 不选文件时行为与现状完全一致（无回归）
- [ ] `go test ./...`、`npm test`、`npm run build` 通过
