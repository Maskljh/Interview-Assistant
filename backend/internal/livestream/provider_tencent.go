package livestream

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const (
	ivhBaseURL     = "https://gw.tvs.qq.com"
	ivhPollTimeout = 40 * time.Second
	ivhPollEvery   = 2 * time.Second
)

// reqID 生成腾讯 IVH 所需的 32 位 hex ReqId。
// IVH 网关拒绝 randomID() 的 16 位 hex（Code 100001 Invalid ReqId）；
// 32 位 hex（crypto/rand 16 字节）实测可用（createsession/command/closesession）。
func reqID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

type tencentProvider struct {
	appKey      string
	accessToken string
	projectID   string
	httpClient  *http.Client
}

func newTencentProvider(cfg Config) Provider {
	return &tencentProvider{
		appKey:      cfg.APIKey,
		accessToken: cfg.Secret,
		projectID:   cfg.AvatarID,
		httpClient:  &http.Client{Timeout: 15 * time.Second},
	}
}

// ivhCall 调用腾讯 IVH REST：query 带 appkey/timestamp/signature，body 为 Header+Payload 信封。
func (p *tencentProvider) ivhCall(ctx context.Context, path string, payload map[string]any) (map[string]any, error) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	query := url.Values{}
	query.Set("appkey", p.appKey)
	query.Set("timestamp", timestamp)
	query.Set("signature", rawIVHSignature(p.appKey, timestamp, p.accessToken))
	reqURL := ivhBaseURL + path + "?" + query.Encode()

	bodyMap := map[string]any{"Header": map[string]any{}, "Payload": payload}
	body, err := json.Marshal(bodyMap)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json;charset=utf-8")
	resp, err := p.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Header struct {
			Code    int    `json:"Code"`
			Message string `json:"Message"`
		} `json:"Header"`
		Payload map[string]any `json:"Payload"`
	}
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		return nil, fmt.Errorf("ivh decode: %w", err)
	}
	if envelope.Header.Code != 0 {
		return nil, fmt.Errorf("ivh error %d: %s", envelope.Header.Code, envelope.Header.Message)
	}
	return envelope.Payload, nil
}

func (p *tencentProvider) StartSession(ctx context.Context, avatarID string) (Session, error) {
	payload, err := p.ivhCall(ctx, "/v2/ivh/sessionmanager/sessionmanagerservice/createsession", map[string]any{
		"ReqId":               reqID(),
		"VirtualmanProjectId": p.projectID,
		"UserId":              fmt.Sprintf("interview-%d", time.Now().UnixNano()),
		"Protocol":            "rtmp",
		"DriverType":          1,
	})
	if err != nil {
		return nil, fmt.Errorf("ivh createsession: %w", err)
	}
	sessionID, _ := payload["SessionId"].(string)
	if sessionID == "" {
		return nil, fmt.Errorf("ivh createsession: missing SessionId")
	}
	// 轮询 statsession 直到会话就绪（SessionStatus==1 且 IsSessionStarted=true，实测约 15s），
	// 再调 startsession；缺失这两步时 command(SEND_TEXT) 会返回 110016 APaasStreamSessionNotStart。
	if err := p.waitSessionReady(ctx, sessionID); err != nil {
		return nil, err
	}
	if _, err := p.ivhCall(ctx, "/v2/ivh/sessionmanager/sessionmanagerservice/startsession", map[string]any{
		"ReqId":     reqID(),
		"SessionId": sessionID,
	}); err != nil {
		return nil, fmt.Errorf("ivh startsession: %w", err)
	}
	return &tencentSession{provider: p, sessionID: sessionID}, nil
}

// waitSessionReady 轮询 statsession 直到会话可驱动（SessionStatus==1 且 IsSessionStarted=true）。
// 上限 ivhPollTimeout（40s），每次间隔 ivhPollEvery（2s），尊重 ctx 取消。
func (p *tencentProvider) waitSessionReady(ctx context.Context, sessionID string) error {
	deadline := time.Now().Add(ivhPollTimeout)
	for {
		payload, err := p.ivhCall(ctx, "/v2/ivh/sessionmanager/sessionmanagerservice/statsession", map[string]any{
			"ReqId":     reqID(),
			"SessionId": sessionID,
		})
		if err != nil {
			return fmt.Errorf("ivh statsession: %w", err)
		}
		status, _ := payload["SessionStatus"].(float64)
		started, _ := payload["IsSessionStarted"].(bool)
		if status == 1 && started {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("ivh statsession: session not ready within %s (SessionStatus=%v IsSessionStarted=%v)", ivhPollTimeout, status, started)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("ivh statsession: %w", ctx.Err())
		case <-time.After(ivhPollEvery):
		}
	}
}

type tencentSession struct {
	provider  *tencentProvider
	sessionID string
}

func (s *tencentSession) StreamURL() string { return "" } // 播放由前端 SDK 自建，后端不提供流地址

func (s *tencentSession) Speak(ctx context.Context, text string) error {
	_, err := s.provider.ivhCall(ctx, "/v2/ivh/interactdriver/interactdriverservice/command", map[string]any{
		"ReqId":     reqID(),
		"SessionId": s.sessionID,
		"Command":   "SEND_TEXT",
		"Data": map[string]any{
			"Text":      text,
			"Interrupt": false,
		},
	})
	return err
}

func (s *tencentSession) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := s.provider.ivhCall(ctx, "/v2/ivh/sessionmanager/sessionmanagerservice/closesession", map[string]any{
		"ReqId":     reqID(),
		"SessionId": s.sessionID,
	})
	return err
}
