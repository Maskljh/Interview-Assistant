package config

import (
	"fmt"
	"os"
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
}

func Load() (*Config, error) {
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
