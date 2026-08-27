package wpsoauth

import (
	"database/sql"
	"os"
	"testing"

	"github.com/interview-assistant/backend/internal/db"
)

func TestUpsertWPSUserMigratesLegacyOpenID(t *testing.T) {
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		dsn = "root:123456@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
	}
	sqlDB, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}

	const email = "test-wps-legacy-user@example.com"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec("DELETE FROM users WHERE email = ?", email)
	})
	_, _ = sqlDB.Exec("DELETE FROM users WHERE email = ?", email)

	result, err := sqlDB.Exec(`
		INSERT INTO users (email, password_hash, username, wps_openid, user_id, nickname, avatar_url)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		email, "$2a$10$not-a-real-password", "旧名字", "legacy-open-id", "old-global-id", "旧昵称", "old-avatar.png",
	)
	if err != nil {
		t.Fatalf("insert legacy user: %v", err)
	}
	legacyID, err := result.LastInsertId()
	if err != nil {
		t.Fatalf("get legacy id: %v", err)
	}

	repo := NewRepo(sqlDB)
	user, err := repo.UpsertWPSUser("new-open-id", "legacy-open-id", "global-user-id", "新名字", "new-avatar.png")
	if err != nil {
		t.Fatalf("UpsertWPSUser() error = %v", err)
	}
	if user.ID != legacyID {
		t.Fatalf("user ID = %d, want legacy user %d", user.ID, legacyID)
	}

	var openid, userID, username string
	var nickname, avatar sql.NullString
	err = sqlDB.QueryRow(
		"SELECT wps_openid, user_id, username, nickname, avatar_url FROM users WHERE id = ?",
		legacyID,
	).Scan(&openid, &userID, &username, &nickname, &avatar)
	if err != nil {
		t.Fatalf("load migrated user: %v", err)
	}
	if openid != "new-open-id" {
		t.Fatalf("wps_openid = %q, want new-open-id", openid)
	}
	if userID != "global-user-id" {
		t.Fatalf("user_id = %q, want global-user-id", userID)
	}
	if username != "新名字" || !nickname.Valid || nickname.String != "新名字" {
		t.Fatalf("username/nickname = %q/%+v, want 新名字", username, nickname)
	}
	if !avatar.Valid || avatar.String != "new-avatar.png" {
		t.Fatalf("avatar = %+v, want new-avatar.png", avatar)
	}
}
