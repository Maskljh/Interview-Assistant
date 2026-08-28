package wps

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// Drive 是 WPS 云文档的驱动盘（文件空间）。
type Drive struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// File 是 WPS 云文档中的文件/文件夹。
type File struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"` // file / folder / shortcut
	DriveID  string `json:"drive_id"`
	ParentID string `json:"parent_id"`
	LinkURL  string `json:"link_url"`
	Ctime    int64  `json:"ctime"`
	Mtime    int64  `json:"mtime"`
	Size     int64  `json:"size"` // 文件大小（字节）；部分接口不返回时为 0
}

type driveList struct {
	Items []Drive `json:"items"`
}

type fileList struct {
	Items []File `json:"items"`
}

type downloadData struct {
	URL string `json:"url"`
}

// searchFileItem 是 /v7/files/search 返回的条目结构：真正的文件对象包在 file 字段内。
// （与盘列表接口不同，搜索结果条目还含 file_src / highlights / otime 等元信息。）
type searchFileItem struct {
	File File `json:"file"`
}

type searchFileList struct {
	Items []searchFileItem `json:"items"`
}

// ListDrives 获取用户自己的驱动盘列表（我的云文档等），用于浏览/选择文件。
func (c *Client) ListDrives(ctx context.Context, token string) ([]Drive, error) {
	q := url.Values{}
	q.Set("allotee_type", "user")
	q.Set("page_size", "50")
	var out driveList
	if err := c.do(ctx, token, http.MethodGet, "/v7/drives", q, nil, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

// ListFolderFiles 列出指定目录下的子文件；filterExts 为逗号分隔的小写扩展名（如 "pdf,docx"）。
func (c *Client) ListFolderFiles(ctx context.Context, token, driveID, parentID, filterExts string, pageSize int) ([]File, error) {
	if pageSize <= 0 {
		pageSize = 50
	}
	path := fmt.Sprintf("/v7/drives/%s/files/%s/children", url.PathEscape(driveID), url.PathEscape(parentID))
	q := url.Values{}
	if filterExts != "" {
		q.Set("filter_exts", filterExts)
	}
	q.Set("page_size", strconv.Itoa(pageSize))
	q.Set("order_by", "mtime")
	q.Set("order", "desc")
	var out fileList
	if err := c.do(ctx, token, http.MethodGet, path, q, nil, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

// SearchFiles 按文件名/类型搜索云文档；fileExts 为逗号分隔扩展名。
func (c *Client) SearchFiles(ctx context.Context, token, keyword, fileExts string, pageSize int) ([]File, error) {
	if pageSize <= 0 {
		pageSize = 20
	}
	q := url.Values{}
	q.Set("type", "file_name")
	if keyword != "" {
		q.Set("keyword", keyword)
	}
	if fileExts != "" {
		q.Set("file_exts", fileExts)
	}
	q.Set("page_size", strconv.Itoa(pageSize))
	var out searchFileList
	if err := c.do(ctx, token, http.MethodGet, "/v7/files/search", q, nil, &out); err != nil {
		return nil, err
	}
	files := make([]File, 0, len(out.Items))
	for _, it := range out.Items {
		files = append(files, it.File)
	}
	return files, nil
}

// GetFileDownload 获取指定文件的临时下载地址。
func (c *Client) GetFileDownload(ctx context.Context, token, driveID, fileID string) (string, error) {
	path := fmt.Sprintf("/v7/drives/%s/files/%s/download", url.PathEscape(driveID), url.PathEscape(fileID))
	var out downloadData
	if err := c.do(ctx, token, http.MethodGet, path, nil, nil, &out); err != nil {
		return "", err
	}
	if out.URL == "" {
		return "", fmt.Errorf("wps download url empty")
	}
	return out.URL, nil
}

// DownloadFile 下载文件内容（下载地址由 GetFileDownload 返回）。
// WPS 的下载地址仍需携带用户 token 鉴权，否则返回 403 userNotLogin。
// DownloadFile 下载文件内容（下载地址由 GetFileDownload 返回）。
// maxBytes > 0 时，通过响应头 Content-Length 在读取正文前预检大小，超限立即报错，
// 避免把超大文件整个下载下来（20MB 上限的前端预检兜底）。
func (c *Client) DownloadFile(ctx context.Context, downloadURL, token string, maxBytes int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.httpDo(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: http %d", resp.StatusCode)
	}
	if maxBytes > 0 && resp.ContentLength > maxBytes {
		return nil, fmt.Errorf("file too large: %d bytes exceeds limit %d", resp.ContentLength, maxBytes)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if maxBytes > 0 && int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("file too large: exceeds limit %d", maxBytes)
	}
	return data, nil
}
