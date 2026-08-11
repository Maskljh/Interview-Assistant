package speech

import "context"

// Client transcribes short audio and synthesizes speech for voice interviews.
type Client interface {
	Transcribe(ctx context.Context, audio []byte, format string) (string, error)
	Synthesize(ctx context.Context, text string) ([]byte, error)
}

type AliyunConfig struct {
	AccessKeyID     string
	AccessKeySecret string
	NLSAppKey       string
}

func NewAliyunClient(cfg AliyunConfig) (Client, error) {
	return newAliyunClient(cfg)
}

func NewFakeClient() Client {
	return &fakeClient{}
}
