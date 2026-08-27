package wpsoauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Config 是 WPS 开放平台 OAuth 所需的配置项，全部来自环境变量。
type Config struct {
	ClientID         string
	ClientSecret     string
	RedirectURI      string
	Scope            string
	FrontendRedirect string
	AuthEndpoint     string // https://openapi.wps.cn/oauth2/auth
	TokenEndpoint    string // https://openapi.wps.cn/oauth2/token
	UserEndpoint     string // https://openapi.wps.cn/v7/users/current
}

// WPSUser 是 WPS 开放平台用户基础信息（从 v7/users/current 解析，兼容多种字段名）。
// OpenID 是应用级唯一标识（登录匹配用），UserID 是 WPS 账号全局数字 ID（个人中心可见，展示用）。
type WPSUser struct {
	UserID   string
	OpenID   string
	LegacyID string
	Name     string
	Avatar   string
}

// Client 封装对 WPS 开放平台的 HTTP 调用。
type Client struct {
	cfg    Config
	httpDo func(req *http.Request) (*http.Response, error) // 可注入以便测试
}

func NewClient(cfg Config) *Client {
	return &Client{cfg: cfg, httpDo: http.DefaultClient.Do}
}

// BuildAuthURL 构造授权页地址（每次调用生成随机 state 防 CSRF）。
func (c *Client) BuildAuthURL(state string) string {
	params := url.Values{}
	params.Set("client_id", c.cfg.ClientID)
	params.Set("response_type", "code")
	params.Set("redirect_uri", c.cfg.RedirectURI)
	params.Set("scope", c.cfg.Scope)
	params.Set("state", state)
	return c.cfg.AuthEndpoint + "?" + params.Encode()
}

// ExchangeCode 用授权码换取 access_token（WPS 要求 Basic Auth 携带 client 凭证）。
// 返回 access_token、refresh_token 及有效时长（秒）；expiresIn<=0 表示未知。
func (c *Client) ExchangeCode(ctx context.Context, code string) (accessToken, refreshToken string, expiresIn int64, err error) {
	body := url.Values{}
	body.Set("grant_type", "authorization_code")
	body.Set("code", code)
	body.Set("redirect_uri", c.cfg.RedirectURI)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.TokenEndpoint, strings.NewReader(body.Encode()))
	if err != nil {
		return "", "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Basic "+basicAuth(c.cfg.ClientID, c.cfg.ClientSecret))

	resp, err := c.httpDo(req)
	if err != nil {
		return "", "", 0, fmt.Errorf("wps token request: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", 0, err
	}
	var data struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Error        string `json:"error"`
		Msg          string `json:"msg"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", "", 0, fmt.Errorf("wps token response: %s", truncate(string(raw), 200))
	}
	if data.AccessToken == "" {
		detail := data.Error
		if detail == "" {
			detail = data.Msg
		}
		if detail == "" {
			detail = truncate(string(raw), 200)
		}
		return "", "", 0, fmt.Errorf("换取 token 失败: %s", detail)
	}
	return data.AccessToken, data.RefreshToken, data.ExpiresIn, nil
}

// FetchUser 用 access_token 拉取当前用户信息，兼容不同返回结构。
func (c *Client) FetchUser(ctx context.Context, accessToken string) (*WPSUser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.UserEndpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := c.httpDo(req)
	if err != nil {
		return nil, fmt.Errorf("wps user request: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("获取用户信息失败: http %d %s", resp.StatusCode, truncate(string(raw), 200))
	}
	var envelope struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("用户信息解析失败: %s", truncate(string(raw), 200))
	}
	if envelope.Code != 0 && envelope.Code != 200 {
		return nil, fmt.Errorf("获取用户信息失败: code=%d msg=%s", envelope.Code, envelope.Msg)
	}
	// 兼容 {code,msg,data:{...}} 与直接返回用户对象两种结构
	var u map[string]any
	if len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, &u); err != nil {
			return nil, fmt.Errorf("用户信息解析失败: %s", truncate(string(raw), 200))
		}
	} else if err := json.Unmarshal(raw, &u); err != nil {
		return nil, fmt.Errorf("用户信息解析失败: %s", truncate(string(raw), 200))
	}

	// user_id / ex_user_id 是 WPS 账号全局数字 ID（个人中心可见）；openid 是应用级标识。
	user := &WPSUser{
		UserID:   firstString(u, "user_id", "ex_user_id", "id"),
		OpenID:   firstString(u, "openid"),
		LegacyID: firstString(u, "id", "user_id", "userId", "ex_user_id", "openid"),
		Name:     firstString(u, "name", "username", "nickname", "nickName", "user_name"),
		Avatar:   firstString(u, "avatar", "avatar_url", "avatarUrl"),
	}
	if user.OpenID == "" {
		// 旧接口可能只有 id 而没有独立 openid 字段：此时用 id 兜底作 openid
		user.OpenID = firstString(u, "id")
	}
	if user.OpenID == "" {
		return nil, errors.New("用户信息缺少 id")
	}
	if user.Name == "" {
		user.Name = "WPS 用户"
	}
	return user, nil
}

// RefreshToken 用 refresh_token 换取新的 access_token，同时返回新的 refresh_token 与有效时长。
func (c *Client) RefreshToken(ctx context.Context, refreshToken string) (accessToken, newRefreshToken string, expiresIn int64, err error) {
	body := url.Values{}
	body.Set("grant_type", "refresh_token")
	body.Set("refresh_token", refreshToken)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.TokenEndpoint, strings.NewReader(body.Encode()))
	if err != nil {
		return "", "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Basic "+basicAuth(c.cfg.ClientID, c.cfg.ClientSecret))

	resp, err := c.httpDo(req)
	if err != nil {
		return "", "", 0, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", 0, err
	}
	var data struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Error        string `json:"error"`
		Msg          string `json:"msg"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", "", 0, fmt.Errorf("wps refresh response: %s", truncate(string(raw), 200))
	}
	if data.AccessToken == "" {
		detail := data.Error
		if detail == "" {
			detail = data.Msg
		}
		if detail == "" {
			detail = truncate(string(raw), 200)
		}
		return "", "", 0, fmt.Errorf("刷新 token 失败: %s", detail)
	}
	return data.AccessToken, data.RefreshToken, data.ExpiresIn, nil
}

func basicAuth(clientID, clientSecret string) string {
	return base64.StdEncoding.EncodeToString([]byte(clientID + ":" + clientSecret))
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
