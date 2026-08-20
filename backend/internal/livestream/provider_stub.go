package livestream

import "context"

// stubProvider 返回配置的模拟流地址，Speak/Close 为 no-op。
// 无 LIVESTREAM_STREAM_URL 时 StartSession 返回 ErrNotConfigured，
// 便于前端验证降级路径。
type stubProvider struct {
	streamURL string
}

func (p *stubProvider) StartSession(ctx context.Context, avatarID string) (Session, error) {
	if p.streamURL == "" {
		return nil, ErrNotConfigured
	}
	return &stubSession{streamURL: p.streamURL}, nil
}

type stubSession struct {
	streamURL string
}

func (s *stubSession) StreamURL() string { return s.streamURL }

func (s *stubSession) Speak(ctx context.Context, text string) error { return nil }

func (s *stubSession) Close() error { return nil }

func (p *stubProvider) CloseSession(ctx context.Context, sessionID string) error { return nil }
