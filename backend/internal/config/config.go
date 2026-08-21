package config

import (
	"fmt"
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	HTTPAddr              string
	MySQLDSN              string
	RedisAddr             string
	JWTSecret             string
	DeepSeekAPIKey        string
	DeepSeekBaseURL       string
	DeepSeekModel         string
	AliyunAccessKeyID     string
	AliyunAccessKeySecret string
	AliyunNLSAppKey       string
	OSSBucket             string
	OSSRegion             string
	OSSEndpoint           string
	OSSAccessKeyID        string
	OSSAccessKeySecret    string
	DigitalHumanProvider  string
	DigitalHumanAPIKey    string
	DigitalHumanSecret    string
	DigitalHumanAvatarID  string
	DigitalHumanVoice     string
	LivestreamProvider    string
	LivestreamStreamURL   string
	TencentAppKey         string
	TencentAccessToken    string
	TencentProjectID      string
}

func Load() (*Config, error) {
	// Load repo-root .env when present (cwd may be backend/ or repo root).
	_ = godotenv.Load(".env")
	_ = godotenv.Load("../.env")

	cfg := &Config{
		HTTPAddr:              getenv("HTTP_ADDR", ":8080"),
		MySQLDSN:              getenv("MYSQL_DSN", "root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"),
		RedisAddr:             getenv("REDIS_ADDR", "127.0.0.1:6379"),
		JWTSecret:             os.Getenv("JWT_SECRET"),
		DeepSeekAPIKey:        os.Getenv("DEEPSEEK_API_KEY"),
		DeepSeekBaseURL:       getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
		DeepSeekModel:         getenv("DEEPSEEK_MODEL", "deepseek-chat"),
		AliyunAccessKeyID:     os.Getenv("ALIYUN_ACCESS_KEY_ID"),
		AliyunAccessKeySecret: os.Getenv("ALIYUN_ACCESS_KEY_SECRET"),
		AliyunNLSAppKey:       os.Getenv("ALIYUN_NLS_APP_KEY"),
		OSSBucket:             os.Getenv("OSS_BUCKET"),
		OSSRegion:             os.Getenv("OSS_REGION"),
		OSSEndpoint:           os.Getenv("OSS_ENDPOINT"),
		OSSAccessKeyID:        os.Getenv("OSS_ACCESS_KEY_ID"),
		OSSAccessKeySecret:    os.Getenv("OSS_ACCESS_KEY_SECRET"),
		DigitalHumanProvider:  os.Getenv("DIGITAL_HUMAN_PROVIDER"),
		DigitalHumanAPIKey:    os.Getenv("DIGITAL_HUMAN_API_KEY"),
		DigitalHumanSecret:    os.Getenv("DIGITAL_HUMAN_SECRET"),
		DigitalHumanAvatarID:  os.Getenv("DIGITAL_HUMAN_AVATAR_ID"),
		DigitalHumanVoice:     os.Getenv("DIGITAL_HUMAN_VOICE"),
		LivestreamProvider:    os.Getenv("LIVESTREAM_PROVIDER"),
		LivestreamStreamURL:   os.Getenv("LIVESTREAM_STREAM_URL"),
		TencentAppKey:         os.Getenv("TENCENT_APPKEY"),
		TencentAccessToken:    os.Getenv("TENCENT_ACCESSTOKEN"),
		TencentProjectID:      os.Getenv("TENCENT_PROJECT_ID"),
	}
	if cfg.JWTSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET required")
	}
	return cfg, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
