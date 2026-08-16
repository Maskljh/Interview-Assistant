package main

import (
	"context"
	"log"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/analysis"
	"github.com/interview-assistant/backend/internal/analytics"
	"github.com/interview-assistant/backend/internal/config"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/profile"
	"github.com/interview-assistant/backend/internal/question"
	"github.com/interview-assistant/backend/internal/sessionredis"
	"github.com/interview-assistant/backend/internal/speech"
	"github.com/interview-assistant/backend/internal/user"
	"github.com/interview-assistant/backend/internal/ws"
	"github.com/redis/go-redis/v9"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	sqlDB, err := db.Open(cfg.MySQLDSN)
	if err != nil {
		log.Fatal(err)
	}
	defer sqlDB.Close()

	redisClient := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr})
	if err := redisClient.Ping(context.Background()).Err(); err != nil {
		log.Fatalf("redis ping: %v", err)
	}
	store := sessionredis.NewRedisStore(redisClient)

	var llmClient llm.Client
	if cfg.DeepSeekAPIKey != "" {
		llmClient = llm.NewDeepSeekClient(cfg.DeepSeekAPIKey, cfg.DeepSeekBaseURL, cfg.DeepSeekModel)
		log.Println("DeepSeek LLM client enabled")
	} else {
		log.Println("warning: DEEPSEEK_API_KEY not set; interview start will return 502")
	}

	var speechClient speech.Client
	if cfg.AliyunAccessKeyID != "" && cfg.AliyunAccessKeySecret != "" && cfg.AliyunNLSAppKey != "" {
		sc, err := speech.NewAliyunClient(speech.AliyunConfig{
			AccessKeyID:     cfg.AliyunAccessKeyID,
			AccessKeySecret: cfg.AliyunAccessKeySecret,
			NLSAppKey:       cfg.AliyunNLSAppKey,
		})
		if err != nil {
			log.Fatalf("aliyun speech client: %v", err)
		}
		speechClient = sc
		log.Println("Aliyun NLS speech client enabled")
	} else {
		log.Println("warning: Aliyun speech keys not set; /api/speech/asr and /api/speech/tts return 502")
	}

	svc := interview.NewService(sqlDB, llmClient, store)
	analysisSvc := analysis.NewService(sqlDB, llmClient, cfg.DeepSeekModel)
	svc.SetEvaluator(analysisSvc)
	svc.SetProfileProvider(profile.NewService(sqlDB))

	r := gin.Default()
	r.Use(corsMiddleware())
	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	user.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	interview.RegisterRoutes(r, cfg.JWTSecret, svc)
	question.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	analytics.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	profile.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	speech.RegisterRoutes(r, cfg.JWTSecret, speechClient)
	analysis.RegisterRoutes(r, sqlDB, cfg.JWTSecret, llmClient, cfg.DeepSeekModel)
	ws.RegisterRoutes(r, svc, cfg.JWTSecret)
	log.Fatal(r.Run(cfg.HTTPAddr))
}

var allowedOrigins = map[string]bool{
	"http://localhost:5173": true,
	"http://127.0.0.1:5173": true,
	"http://localhost:5174": true,
	"http://127.0.0.1:5174": true,
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if allowedOrigins[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
		}
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	}
}
