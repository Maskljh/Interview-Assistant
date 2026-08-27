package wpsoauth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

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
