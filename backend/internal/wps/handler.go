package wps

import (
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
)

// 简历候选文件的扩展名过滤（WPS 云文档选简历时列出这些类型）。
const resumeFilterExts = "pdf,docx,txt,md"

// 从云文档导入的简历大小上限（20MB），避免 base64 传输过大。
const maxImportBytes = 20 * 1024 * 1024

// Handler 提供「从 WPS 云文档选简历」与「报告发送到邮箱」的 REST 端点。
type Handler struct {
	client *Client
	tokens TokenProvider
}

// NewHandler 构造 Handler；tokens 负责提供用户当前可用的 WPS access_token。
func NewHandler(client *Client, tokens TokenProvider) *Handler {
	return &Handler{client: client, tokens: tokens}
}

// RegisterRoutes 在 /api/wps 下挂载受登录保护的端点。
func RegisterRoutes(r *gin.Engine, secret string, tokens TokenProvider) {
	h := NewHandler(NewClient(), tokens)
	g := r.Group("/api/wps")
	g.Use(auth.Middleware(secret))
	g.GET("/cloud-files", h.ListCloudFiles)
	g.POST("/cloud-files/import", h.ImportCloudFile)
}

func userID(c *gin.Context) (int64, bool) {
	v, ok := c.Get("userID")
	if !ok {
		return 0, false
	}
	id, ok := v.(int64)
	return id, ok
}

func (h *Handler) wpsToken(c *gin.Context) (string, bool) {
	uid, ok := userID(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return "", false
	}
	token, err := h.tokens.TokenForUser(c.Request.Context(), uid)
	if err != nil || token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "WPS 账号未授权或登录已过期，请重新登录"})
		return "", false
	}
	return token, true
}

// cloudFile 是返回给前端的云文档简历候选文件。
type cloudFile struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	DriveID string `json:"drive_id"`
	LinkURL string `json:"link_url"`
	Mtime   int64  `json:"mtime"`
}

// ListCloudFiles 列出用户云文档中的简历候选文件。
// 优先列出各盘根目录文件；传 keyword 时再叠加文件搜索（需要 kso.file.search 权限）。
func (h *Handler) ListCloudFiles(c *gin.Context) {
	token, ok := h.wpsToken(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	keyword := strings.TrimSpace(c.Query("keyword"))

	var result []File

	if keyword != "" {
		// 搜索模式：只展示搜索命中的简历文件，不混入无关的盘根目录文件。
		if items, searchErr := h.client.SearchFiles(ctx, token, keyword, resumeFilterExts, 30); searchErr == nil {
			seen := map[string]bool{}
			for _, f := range items {
				if f.Type != "" && f.Type != "file" {
					continue
				}
				if seen[f.ID] {
					continue
				}
				seen[f.ID] = true
				result = append(result, f)
			}
		} else {
			// 搜索失败（权限未开通、token scope 不足、网络异常等）直接透出错误，
			// 避免被前端误判为「未找到匹配」。
			log.Printf("[wps] search files: %v", searchErr)
			msg := searchErr.Error()
			if len(msg) > 200 {
				msg = msg[:200]
			}
			c.JSON(http.StatusOK, gin.H{"items": []cloudFile{}, "error": "云文档搜索失败：" + msg})
			return
		}
	}
	// 默认模式（无关键词）：不预取文件，返回空列表，由前端提示输入关键词搜索。

	out := make([]cloudFile, 0, len(result))
	for _, f := range result {
		out = append(out, cloudFile{
			ID:      f.ID,
			Name:    f.Name,
			DriveID: f.DriveID,
			LinkURL: f.LinkURL,
			Mtime:   f.Mtime,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

// importCloudFileReq 是导入云文档简历的请求体。
type importCloudFileReq struct {
	FileID  string `json:"file_id"`
	DriveID string `json:"drive_id"`
	Name    string `json:"name"`
}

// ImportCloudFile 下载云文档文件并以 base64 返回，前端复用现有解析逻辑提取简历文本。
func (h *Handler) ImportCloudFile(c *gin.Context) {
	token, ok := h.wpsToken(c)
	if !ok {
		return
	}
	var req importCloudFileReq
	if err := c.ShouldBindJSON(&req); err != nil || req.FileID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少文件信息"})
		return
	}
	if req.DriveID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少云盘信息"})
		return
	}
	ctx := c.Request.Context()

	downloadURL, err := h.client.GetFileDownload(ctx, token, req.DriveID, req.FileID)
	if err != nil {
		h.writeWpsError(c, err, "获取云文档下载地址失败")
		return
	}
	data, err := h.client.DownloadFile(ctx, downloadURL, token)
	if err != nil {
		h.writeWpsError(c, err, "下载云文档失败")
		return
	}
	if len(data) > maxImportBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "云文档文件过大，无法导入（上限 20MB）"})
		return
	}

	name := req.Name
	if name == "" {
		name = "云文档简历"
	}
	c.JSON(http.StatusOK, gin.H{
		"name":      name,
		"base64":    base64.StdEncoding.EncodeToString(data),
		"mime_type": http.DetectContentType(data),
		"size":      len(data),
	})
}

// writeWpsError 把 WPS API 错误映射为 HTTP 状态；权限类错误给出「权限未开通」引导。
func (h *Handler) writeWpsError(c *gin.Context, err error, fallback string) {
	var ae *APIError
	if errors.As(err, &ae) {
		msg := ae.Error()
		if ae.Code == http.StatusForbidden || strings.Contains(msg, "权限") {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "WPS 云文档/邮箱权限未开通，请在 WPS 开放平台为应用申请云文档与邮箱权限后重试",
			})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("%s：%s", fallback, msg)})
		return
	}
	c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("%s：%v", fallback, err)})
}
