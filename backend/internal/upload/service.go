package upload

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aliyun/aliyun-oss-go-sdk/oss"
)

const (
	MaxFileSize = 10 * 1024 * 1024 // 10MB
	PutURLTTL   = 5 * time.Minute

	KindResume = "resume"
	KindJD     = "jd"
)

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

func validateSignRequest(kind, filename, contentType string, size int64) error {
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
	userID int64
}

func NewService(cfg OSSConfig, userID int64) *Service {
	return &Service{cfg: cfg, userID: userID}
}

func (s *Service) SignUpload(kind, filename, contentType string, size int64) (key, putURL, objectURL string, expiresIn int, err error) {
	if s.cfg.Endpoint == "" || s.cfg.Bucket == "" || s.cfg.AccessKeyID == "" {
		return "", "", "", 0, errors.New("oss not configured")
	}
	if err = validateSignRequest(kind, filename, contentType, size); err != nil {
		return "", "", "", 0, err
	}
	client, err := oss.New(s.cfg.Endpoint, s.cfg.AccessKeyID, s.cfg.AccessKeySecret)
	if err != nil {
		return "", "", "", 0, err
	}
	bucket, err := client.Bucket(s.cfg.Bucket)
	if err != nil {
		return "", "", "", 0, err
	}

	dot := strings.LastIndexByte(filename, '.')
	ext := strings.ToLower(filename[dot:])
	key = fmt.Sprintf("uploads/%d/%d%s", s.userID, time.Now().UnixNano(), ext)

	putURL, err = bucket.SignURL(key, oss.HTTPPut, int64(PutURLTTL.Seconds()))
	if err != nil {
		return "", "", "", 0, err
	}
	objectURL = s.cfg.Endpoint + "/" + key
	return key, putURL, objectURL, int(PutURLTTL.Seconds()), nil
}
