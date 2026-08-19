package livestream_test

import (
	"testing"

	"github.com/interview-assistant/backend/internal/livestream"
)

func TestNewProviderTencent(t *testing.T) {
	p, err := livestream.NewProvider(livestream.Config{
		ProviderName: "tencent",
		APIKey:       "test-appkey",
		Secret:       "test-token",
		AvatarID:     "test-project",
	})
	if err != nil {
		t.Fatalf("new provider: %v", err)
	}
	if p == nil {
		t.Fatal("provider is nil")
	}
}
