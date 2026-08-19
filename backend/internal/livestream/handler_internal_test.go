package livestream

import (
	"context"
	"sync"
	"testing"
	"time"
)

// 内部测试：直接构造 handler，验证驱动会话 TTL 清理（可注入时钟/短 TTL）。

type ttlFakeSession struct {
	mu     sync.Mutex
	closed bool
}

func (f *ttlFakeSession) StreamURL() string                            { return "https://example.com/stream.mp4" }
func (f *ttlFakeSession) Speak(ctx context.Context, text string) error { return nil }
func (f *ttlFakeSession) Close() error {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	return nil
}

func (f *ttlFakeSession) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

func newTestHandler() *handler {
	return &handler{
		sessions: make(map[string]*sessionEntry),
		ttl:      time.Minute,
		stopReap: make(chan struct{}),
	}
}

func TestReapStaleClosesIdleSession(t *testing.T) {
	h := newTestHandler()
	stale := &ttlFakeSession{}
	fresh := &ttlFakeSession{}
	now := time.Now()
	h.mu.Lock()
	h.sessions["stale"] = &sessionEntry{sess: stale, lastActivity: now.Add(-2 * time.Minute)}
	h.sessions["fresh"] = &sessionEntry{sess: fresh, lastActivity: now}
	h.mu.Unlock()

	h.reapStale(now, time.Minute)

	if !stale.isClosed() {
		t.Fatal("stale session should be closed")
	}
	if fresh.isClosed() {
		t.Fatal("fresh session should not be closed")
	}
	h.mu.Lock()
	_, staleOK := h.sessions["stale"]
	_, freshOK := h.sessions["fresh"]
	h.mu.Unlock()
	if staleOK {
		t.Fatal("stale session should be removed from map")
	}
	if !freshOK {
		t.Fatal("fresh session should remain in map")
	}
}

func TestReapStaleKeepsActiveWithinTTL(t *testing.T) {
	h := newTestHandler()
	s := &ttlFakeSession{}
	now := time.Now()
	h.mu.Lock()
	h.sessions["active"] = &sessionEntry{sess: s, lastActivity: now.Add(-30 * time.Second)}
	h.mu.Unlock()

	h.reapStale(now, time.Minute)

	if s.isClosed() {
		t.Fatal("session within TTL should not be closed")
	}
}

func TestTouchUpdatesLastActivity(t *testing.T) {
	h := newTestHandler()
	s := &ttlFakeSession{}
	old := time.Now().Add(-time.Hour)
	h.mu.Lock()
	h.sessions["s"] = &sessionEntry{sess: s, lastActivity: old}
	h.mu.Unlock()

	h.touch("s")

	h.mu.Lock()
	e := h.sessions["s"]
	h.mu.Unlock()
	if e == nil {
		t.Fatal("session should still exist")
	}
	if !e.lastActivity.After(old) {
		t.Fatalf("lastActivity should be updated: got %v, want after %v", e.lastActivity, old)
	}
}
