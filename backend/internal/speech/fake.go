package speech

import "context"

type fakeClient struct{}

func (f *fakeClient) Transcribe(ctx context.Context, audio []byte, format string) (string, error) {
	return "你好", nil
}

func (f *fakeClient) Synthesize(ctx context.Context, text string) ([]byte, error) {
	return []byte("fake-mp3"), nil
}
