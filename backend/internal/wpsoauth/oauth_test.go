package wpsoauth

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseAidFromToken(t *testing.T) {
	// 构造 JWT payload: {"aid":1856762351,...}
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"aid":1856762351,"atp":"user"}`))
	token := "header." + payload + ".sig"
	if got := ParseAidFromToken(token); got != "1856762351" {
		t.Fatalf("ParseAidFromToken() = %q, want 1856762351", got)
	}
	// 非 JWT 结构
	if got := ParseAidFromToken("not-a-jwt"); got != "" {
		t.Fatalf("ParseAidFromToken(not-a-jwt) = %q, want empty", got)
	}
	// JWT 但没有 aid 字段
	noid := base64.RawURLEncoding.EncodeToString([]byte(`{"atp":"user"}`))
	if got := ParseAidFromToken("h." + noid + ".s"); got != "" {
		t.Fatalf("ParseAidFromToken(no aid) = %q, want empty", got)
	}
}

func TestFetchUserKeepsLegacyAndOpenID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"code": 200,
			"data": {
				"id": "legacy-id",
				"user_id": "global-user-id",
				"openid": "open-id",
				"name": "罗杰豪",
				"avatar": "https://example.com/avatar.png"
			}
		}`))
	}))
	defer server.Close()

	client := NewClient(Config{UserEndpoint: server.URL})
	user, err := client.FetchUser(t.Context(), "access-token")
	if err != nil {
		t.Fatalf("FetchUser() error = %v", err)
	}
	if user.OpenID != "open-id" {
		t.Fatalf("OpenID = %q, want open-id", user.OpenID)
	}
	if user.UserID != "global-user-id" {
		t.Fatalf("UserID = %q, want global-user-id", user.UserID)
	}
	if user.LegacyID != "legacy-id" {
		t.Fatalf("LegacyID = %q, want legacy-id", user.LegacyID)
	}
}
