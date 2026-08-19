package livestream

import (
	"context"
	"errors"
	"fmt"
)

// ErrNotConfigured 表示实时数字人服务商未配置（或 stub 未设流地址），
// 调用方（handler/前端）应降级到 V14 预生成视频/TTS。
var ErrNotConfigured = errors.New("livestream provider not configured")

type Config struct {
	ProviderName string
	APIKey       string
	Secret       string
	AvatarID     string
	StreamURL    string
}

// Session 代表一场实时数字人会话。StreamURL 供前端 <video> 播放，
// Speak 驱动面试官口播文本。
type Session interface {
	StreamURL() string
	Speak(ctx context.Context, text string) error
	Close() error
}

// Provider 创建实时数字人会话。
type Provider interface {
	StartSession(ctx context.Context, avatarID string) (Session, error)
}

// NewProvider 按配置构造 Provider。ProviderName 为空时返回 (nil, nil)，
// 由调用方降级。服务商（腾讯云数智人 / 讯飞智作等）开通后，新增一个
// Provider 实现（例如 provider_vendor.go）并在本 switch 注册。
func NewProvider(cfg Config) (Provider, error) {
	if cfg.ProviderName == "" {
		return nil, nil
	}
	switch cfg.ProviderName {
	case "stub":
		return &stubProvider{streamURL: cfg.StreamURL}, nil
	case "tencent":
		return newTencentProvider(cfg), nil
	default:
		return nil, fmt.Errorf("livestream provider %q not supported", cfg.ProviderName)
	}
}
