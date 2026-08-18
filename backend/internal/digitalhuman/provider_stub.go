package digitalhuman

import (
	"context"
	"errors"
	"fmt"
)

var ErrNotConfigured = errors.New("digital human provider not configured")

// NewProvider 按配置构造 Provider。ProviderName 为空时返回 (nil, nil)，
// 由调用方（handler/前端）降级到 TTS 播报。
//
// 服务商（硅基智能 / 腾讯云智影 / 讯飞智作）账号开通后，按各自 API 文档
// 新增一个 Provider 实现（例如 provider_silicon.go）并在本 switch 注册，
// 同时在 handler 的 503 语义下正常返回任务 ID 与视频 URL。当前只有 stub。
func NewProvider(cfg Config) (Provider, error) {
	if cfg.ProviderName == "" {
		return nil, nil
	}
	switch cfg.ProviderName {
	case "stub":
		return &stubProvider{}, nil
	default:
		return nil, fmt.Errorf("digital human provider %q not supported", cfg.ProviderName)
	}
}

type stubProvider struct{}

func (p *stubProvider) Submit(ctx context.Context, text string) (string, error) {
	return "", ErrNotConfigured
}

func (p *stubProvider) Result(ctx context.Context, taskID string) (Status, string, error) {
	return "", "", ErrNotConfigured
}
