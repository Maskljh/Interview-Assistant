package speech

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
	"sync"
	"time"
)

const (
	aliyunTokenURL = "https://nls-meta.cn-shanghai.aliyuncs.com/"
	aliyunGateway  = "https://nls-gateway-cn-shanghai.aliyuncs.com"
	aliyunRegion   = "cn-shanghai"
)

type aliyunClient struct {
	cfg        AliyunConfig
	httpClient *http.Client

	mu          sync.Mutex
	token       string
	tokenExpiry time.Time
}

func newAliyunClient(cfg AliyunConfig) (Client, error) {
	if cfg.AccessKeyID == "" || cfg.AccessKeySecret == "" || cfg.NLSAppKey == "" {
		return nil, fmt.Errorf("aliyun speech credentials required")
	}
	return &aliyunClient{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (c *aliyunClient) Transcribe(ctx context.Context, audio []byte, format string) (string, error) {
	if format == "" {
		format = "pcm"
	}
	token, err := c.getToken(ctx)
	if err != nil {
		return "", err
	}
	query := url.Values{}
	query.Set("appkey", c.cfg.NLSAppKey)
	query.Set("format", format)
	query.Set("sample_rate", "16000")
	query.Set("enable_punctuation_prediction", "true")
	endpoint := aliyunGateway + "/stream/v1/asr?" + query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(audio))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-NLS-Token", token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("aliyun asr http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out struct {
		Status int64  `json:"status"`
		Result string `json:"result"`
		Msg    string `json:"message"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.Status != 20000000 {
		return "", fmt.Errorf("aliyun asr status %d: %s", out.Status, out.Msg)
	}
	return strings.TrimSpace(out.Result), nil
}

func (c *aliyunClient) Synthesize(ctx context.Context, text string) ([]byte, error) {
	token, err := c.getToken(ctx)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(map[string]any{
		"appkey":      c.cfg.NLSAppKey,
		"token":       token,
		"text":        text,
		"format":      "mp3",
		"sample_rate": 16000,
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, aliyunGateway+"/stream/v1/tts", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 5<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("aliyun tts http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if len(body) == 0 {
		return nil, fmt.Errorf("aliyun tts returned empty audio")
	}
	return body, nil
}

func (c *aliyunClient) getToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.token != "" && time.Now().Before(c.tokenExpiry) {
		token := c.token
		c.mu.Unlock()
		return token, nil
	}
	c.mu.Unlock()

	token, expireAt, err := c.fetchToken(ctx)
	if err != nil {
		return "", err
	}

	c.mu.Lock()
	c.token = token
	c.tokenExpiry = expireAt
	c.mu.Unlock()
	return token, nil
}

func (c *aliyunClient) fetchToken(ctx context.Context) (string, time.Time, error) {
	params := map[string]string{
		"AccessKeyId":      c.cfg.AccessKeyID,
		"Action":           "CreateToken",
		"Version":          "2019-02-28",
		"Format":           "JSON",
		"RegionId":         aliyunRegion,
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, aliyunTokenURL+"?"+query.Encode(), nil)
	if err != nil {
		return "", time.Time{}, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", time.Time{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return "", time.Time{}, fmt.Errorf("aliyun token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var out struct {
		Token struct {
			ID         string `json:"Id"`
			ExpireTime int64  `json:"ExpireTime"`
		} `json:"Token"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", time.Time{}, err
	}
	if out.Token.ID == "" {
		return "", time.Time{}, fmt.Errorf("aliyun token response missing token id")
	}
	expireAt := time.Unix(out.Token.ExpireTime, 0)
	if expireAt.Sub(time.Now()) > 5*time.Minute {
		expireAt = time.Now().Add(5 * time.Minute)
	}
	return out.Token.ID, expireAt, nil
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
