package wpsoauth

import (
	"testing"
	"time"
)

func TestRefreshedPreservesRefreshTokenWhenResponseOmitsIt(t *testing.T) {
	oldExpiry := time.Date(2026, 8, 27, 10, 0, 0, 0, time.UTC)
	token := WPSToken{
		AccessToken:  "old-access",
		RefreshToken: "old-refresh",
		ExpiresAt:    oldExpiry,
	}

	next := token.refreshed("new-access", "", time.Date(2026, 8, 27, 11, 0, 0, 0, time.UTC))

	if next.AccessToken != "new-access" {
		t.Fatalf("AccessToken = %q, want new-access", next.AccessToken)
	}
	if next.RefreshToken != "old-refresh" {
		t.Fatalf("RefreshToken = %q, want old-refresh", next.RefreshToken)
	}
}
