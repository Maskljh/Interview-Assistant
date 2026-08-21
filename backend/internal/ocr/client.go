package ocr

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const defaultEndpoint = "https://ocr-api.cn-hangzhou.aliyuncs.com/"

type Client interface {
	Recognize(ctx context.Context, image []byte) (string, error)
}

type Config struct {
	AccessKeyID     string
	AccessKeySecret string
	Endpoint        string
}

type aliyunClient struct {
	cfg        Config
	httpClient *http.Client
}

func NewClient(cfg Config) (Client, error) {
	if cfg.AccessKeyID == "" || cfg.AccessKeySecret == "" {
		return nil, fmt.Errorf("aliyun ocr credentials required")
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = defaultEndpoint
	}
	return &aliyunClient{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func NewFakeClient() Client {
	return &fakeClient{}
}

type fakeClient struct{}

func (f *fakeClient) Recognize(ctx context.Context, image []byte) (string, error) {
	return "OCR fake text", nil
}

func (c *aliyunClient) Recognize(ctx context.Context, image []byte) (string, error) {
	params := map[string]string{
		"AccessKeyId":      c.cfg.AccessKeyID,
		"Action":           "RecognizeGeneral",
		"Version":          "2021-07-07",
		"Format":           "JSON",
		"RegionId":         "cn-hangzhou",
		"Timestamp":        time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureVersion": "1.0",
		"SignatureNonce":   randomHex(),
	}
	params["Signature"] = popSignature(params, c.cfg.AccessKeySecret)

	query := url.Values{}
	for k, v := range params {
		query.Set(k, v)
	}
	payload, err := json.Marshal(map[string]string{"body": base64.StdEncoding.EncodeToString(image)})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.Endpoint+"?"+query.Encode(), bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("aliyun ocr http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out struct {
		Code string `json:"code"`
		Data struct {
			WordsResult []struct {
				Words string `json:"words"`
			} `json:"wordsResult"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.Code != "" && out.Code != "200" {
		return "", fmt.Errorf("aliyun ocr code %s", out.Code)
	}
	var lines []string
	for _, w := range out.Data.WordsResult {
		if strings.TrimSpace(w.Words) != "" {
			lines = append(lines, strings.TrimSpace(w.Words))
		}
	}
	if len(lines) == 0 {
		return "", fmt.Errorf("aliyun ocr returned no text")
	}
	return strings.Join(lines, "\n"), nil
}

func popSignature(params map[string]string, secret string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, percentEncode(k)+"="+percentEncode(params[k]))
	}
	canonicalized := strings.Join(parts, "&")
	stringToSign := "GET&%2F&" + percentEncode(canonicalized)

	mac := hmac.New(sha1.New, []byte(secret+"&"))
	_, _ = mac.Write([]byte(stringToSign))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func percentEncode(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&0x0f])
	}
	return b.String()
}

func randomHex() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}
