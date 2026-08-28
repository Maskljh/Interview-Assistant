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
	WPSClientID           string
	WPSClientSecret       string
	WPSRedirectURI        string
	WPSCallbackAddr       string
	WPSScope              string
	WPSFrontendRedirect   string
	WPSAuthEndpoint       string
	WPSTokenEndpoint      string
	WPSUserEndpoint       string
	DeepSeekAPIKey        string
	DeepSeekBaseURL       string
	DeepSeekModel         string
	AliyunAccessKeyID     string
	AliyunAccessKeySecret string
	AliyunNLSAppKey       string
	OCRAccessKeyID        string
	OCRAccessKeySecret    string
	OCREndpoint           string
	OSSBucket             string
	OSSRegion             string
	OSSEndpoint           string
	OSSAccessKeyID        string
	OSSAccessKeySecret    string
}

func Load() (*Config, error) {
	// Load repo-root .env when present (cwd may be backend/ or repo root).
	_ = godotenv.Load(".env")
	_ = godotenv.Load("../.env")

	cfg := &Config{
		HTTPAddr:              getenv("HTTP_ADDR", ":18080"),
		MySQLDSN:              getenv("MYSQL_DSN", "root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4&loc=Local"),
		RedisAddr:             getenv("REDIS_ADDR", "127.0.0.1:6379"),
		JWTSecret:             os.Getenv("JWT_SECRET"),
		WPSClientID:           os.Getenv("WPS_CLIENT_ID"),
		WPSClientSecret:       os.Getenv("WPS_CLIENT_SECRET"),
		WPSRedirectURI:        getenv("WPS_REDIRECT_URI", "http://127.0.0.1:18365/callback"),
		WPSCallbackAddr:       getenv("WPS_CALLBACK_ADDR", ":18365"),
		WPSScope:              getenv("WPS_SCOPE", "kso.user_base.read"),
		WPSFrontendRedirect:   getenv("WPS_FRONTEND_REDIRECT", "http://localhost:5174"),
		WPSAuthEndpoint:       getenv("WPS_AUTH_ENDPOINT", "https://openapi.wps.cn/oauth2/auth"),
		WPSTokenEndpoint:      getenv("WPS_TOKEN_ENDPOINT", "https://openapi.wps.cn/oauth2/token"),
		WPSUserEndpoint:       getenv("WPS_USER_ENDPOINT", "https://openapi.wps.cn/v7/users/current"),
		DeepSeekAPIKey:        os.Getenv("DEEPSEEK_API_KEY"),
		DeepSeekBaseURL:       getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
		DeepSeekModel:         getenv("DEEPSEEK_MODEL", "deepseek-chat"),
		AliyunAccessKeyID:     os.Getenv("ALIYUN_ACCESS_KEY_ID"),
		AliyunAccessKeySecret: os.Getenv("ALIYUN_ACCESS_KEY_SECRET"),
		AliyunNLSAppKey:       os.Getenv("ALIYUN_NLS_APP_KEY"),
		OCRAccessKeyID:        getenv("ALIYUN_OCR_ACCESS_KEY_ID", os.Getenv("ALIYUN_ACCESS_KEY_ID")),
		OCRAccessKeySecret:    getenv("ALIYUN_OCR_ACCESS_KEY_SECRET", os.Getenv("ALIYUN_ACCESS_KEY_SECRET")),
		OCREndpoint:           os.Getenv("ALIYUN_OCR_ENDPOINT"),
		OSSBucket:             os.Getenv("OSS_BUCKET"),
		OSSRegion:             os.Getenv("OSS_REGION"),
		OSSEndpoint:           os.Getenv("OSS_ENDPOINT"),
		OSSAccessKeyID:        os.Getenv("OSS_ACCESS_KEY_ID"),
		OSSAccessKeySecret:    os.Getenv("OSS_ACCESS_KEY_SECRET"),
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
