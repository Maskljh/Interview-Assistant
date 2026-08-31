package upload

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
)

const (
	MaxFileSize = 10 * 1024 * 1024 // 10MB
	// PutURLTTL 保留：前端不再直连 OSS，但作为上传窗口的超时参考保留。
	PutURLTTL = 5 * time.Minute

	KindResume = "resume"
	KindJD     = "jd"

	uploadDir = "uploads" // OSS 对象前缀
)

// ErrNotConfigured is returned when OSS is not configured
// (missing endpoint/bucket/access key). Handlers map it to 503.
var ErrNotConfigured = errors.New("oss not configured")

var allowedExts = map[string]bool{
	".txt": true, ".md": true, ".pdf": true, ".docx": true,
}

var allowedContentTypes = map[string]bool{
	"text/plain":      true,
	"text/markdown":   true,
	"application/pdf": true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
	"application/msword": true,
}

func validateUpload(kind, filename, contentType string, size int64) error {
	if kind != KindResume && kind != KindJD {
		return fmt.Errorf("invalid kind")
	}
	if size <= 0 || size > MaxFileSize {
		return fmt.Errorf("invalid size")
	}
	dot := strings.LastIndexByte(filename, '.')
	if dot < 0 {
		return fmt.Errorf("unsupported file type")
	}
	ext := strings.ToLower(filename[dot:])
	if !allowedExts[ext] {
		return fmt.Errorf("unsupported file type")
	}
	if contentType != "" && !allowedContentTypes[contentType] {
		return fmt.Errorf("unsupported content type")
	}
	return nil
}

type OSSConfig struct {
	Bucket          string
	Region          string
	Endpoint        string
	AccessKeyID     string
	AccessKeySecret string
}

type Service struct {
	cfg    OSSConfig
	client *http.Client
}

func NewService(cfg OSSConfig) *Service {
	return &Service{
		cfg:    cfg,
		client: &http.Client{Timeout: 60 * time.Second},
	}
}

// ready reports whether OSS is fully configured.
func (s *Service) ready() bool {
	return s.cfg.Endpoint != "" && s.cfg.Bucket != "" && s.cfg.AccessKeyID != ""
}

// regionHost returns the virtual-hosted-style OSS host, e.g. bucket.oss-cn-beijing.aliyuncs.com
func (s *Service) regionHost() string {
	region := s.cfg.Region
	if region == "" {
		region = "oss-cn-hangzhou"
	}
	region = strings.TrimPrefix(region, "https://")
	region = strings.TrimPrefix(region, "http://")
	region = strings.TrimSuffix(region, ".aliyuncs.com")
	if !strings.HasPrefix(region, "oss-") {
		region = "oss-" + region
	}
	return fmt.Sprintf("%s.%s.aliyuncs.com", s.cfg.Bucket, region)
}

// sign computes the OSS V1 header signature (HMAC-SHA1 + Base64).
// stringToSign = method + "\n" + contentMD5 + "\n" + contentType + "\n" + date + "\n" + resource
func (s *Service) sign(method, contentType, date, resource string) string {
	stringToSign := method + "\n\n" + contentType + "\n" + date + "\n" + resource
	mac := hmac.New(sha1.New, []byte(s.cfg.AccessKeySecret))
	mac.Write([]byte(stringToSign))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// Upload streams the uploaded file to OSS and returns the object key and a
// same-origin URL (served through /api/uploads/object) so browsers never touch OSS directly.
func (s *Service) Upload(userID int64, kind, filename, contentType string, r io.Reader, size int64) (key, objectURL string, err error) {
	if !s.ready() {
		return "", "", ErrNotConfigured
	}
	if err = validateUpload(kind, filename, contentType, size); err != nil {
		return "", "", err
	}

	dot := strings.LastIndexByte(filename, '.')
	ext := strings.ToLower(filename[dot:])
	key = fmt.Sprintf("%s/%d/%d%s", uploadDir, userID, time.Now().UnixNano(), ext)

	host := s.regionHost()
	date := time.Now().UTC().Format(http.TimeFormat)
	resource := "/" + s.cfg.Bucket + "/" + key
	sig := s.sign("PUT", contentType, date, resource)

	req, err := http.NewRequest(http.MethodPut, "https://"+host+"/"+key, r)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Date", date)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "OSS "+s.cfg.AccessKeyID+":"+sig)

	resp, err := s.client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", "", fmt.Errorf("oss upload failed (status %d): %s", resp.StatusCode, string(body))
	}

	objectURL = "/api/uploads/object?key=" + key
	return key, objectURL, nil
}

// Proxy streams an OSS object back to the client through the API server
// (keeps the object private and avoids browser CORS to OSS).
// userID 归属校验：对象 key 必须属于当前用户（uploads/{userID}/...），
// 防止越权读取其他用户上传的简历/JD 原文件（IDOR）。
func (s *Service) Proxy(c http.ResponseWriter, userID int64, key string) error {
	if !s.ready() {
		return ErrNotConfigured
	}
	key = strings.TrimSpace(key)
	key = strings.TrimPrefix(path.Clean("/"+key), "/")
	ownedPrefix := fmt.Sprintf("%s/%d/", uploadDir, userID)
	if key == "" || strings.Contains(key, "..") || !strings.HasPrefix(key, ownedPrefix) {
		return errors.New("invalid key")
	}

	host := s.regionHost()
	date := time.Now().UTC().Format(http.TimeFormat)
	resource := "/" + s.cfg.Bucket + "/" + key
	sig := s.sign("GET", "", date, resource)

	req, err := http.NewRequest(http.MethodGet, "https://"+host+"/"+key, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Date", date)
	req.Header.Set("Authorization", "OSS "+s.cfg.AccessKeyID+":"+sig)

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("oss fetch error (status %d): %s", resp.StatusCode, string(body))
	}

	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	c.Header().Set("Content-Type", ct)
	c.Header().Set("Cache-Control", "private, max-age=300")
	_, _ = io.Copy(c, resp.Body)
	return nil
}
