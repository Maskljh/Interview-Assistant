package livestream_test

import (
	"context"
	"errors"
	"testing"

	"github.com/interview-assistant/backend/internal/livestream"
)

func TestNewProviderEmptyIsNil(t *testing.T) {
	p, err := livestream.NewProvider(livestream.Config{ProviderName: ""})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p != nil {
		t.Fatalf("provider = %v, want nil", p)
	}
}

func TestNewProviderStub(t *testing.T) {
	p, err := livestream.NewProvider(livestream.Config{
		ProviderName: "stub",
		StreamURL:    "https://example.com/stream.mp4",
	})
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	sess, err := p.StartSession(context.Background(), "")
	if err != nil {
		t.Fatalf("start session: %v", err)
	}
	if sess.StreamURL() != "https://example.com/stream.mp4" {
		t.Fatalf("streamURL = %q", sess.StreamURL())
	}
	if err := sess.Speak(context.Background(), "请介绍一下你自己"); err != nil {
		t.Fatalf("speak: %v", err)
	}
	if err := sess.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestStubStartWithoutStreamURLErrors(t *testing.T) {
	p, err := livestream.NewProvider(livestream.Config{ProviderName: "stub"})
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	_, err = p.StartSession(context.Background(), "")
	if !errors.Is(err, livestream.ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

func TestNewProviderUnsupported(t *testing.T) {
	_, err := livestream.NewProvider(livestream.Config{ProviderName: "vendor"})
	if err == nil {
		t.Fatal("expected error for unsupported provider")
	}
}
