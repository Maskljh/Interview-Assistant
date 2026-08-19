package main

import (
	"context"
	"log"
	"net/url"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/analysis"
	"github.com/interview-assistant/backend/internal/analytics"
	"github.com/interview-assistant/backend/internal/config"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/digitalhuman"
	"github.com/interview-assistant/backend/internal/expression"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/livestream"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/precheck"
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

	var dhProvider digitalhuman.Provider
	if cfg.DigitalHumanProvider != "" {
		dhProvider, err = digitalhuman.NewProvider(digitalhuman.Config{
			ProviderName: cfg.DigitalHumanProvider,
			APIKey:       cfg.DigitalHumanAPIKey,
			Secret:       cfg.DigitalHumanSecret,
			AvatarID:     cfg.DigitalHumanAvatarID,
			Voice:        cfg.DigitalHumanVoice,
		})
		if err != nil {
			log.Fatalf("digital human provider: %v", err)
		}
		log.Println("digital human provider enabled")
	} else {
		log.Println("warning: DIGITAL_HUMAN_PROVIDER not set; /api/digital-human/videos return 503")
	}

	var lsProvider livestream.Provider
	if cfg.LivestreamProvider != "" {
		lsProvider, err = livestream.NewProvider(livestream.Config{
			ProviderName: cfg.LivestreamProvider,
			StreamURL:    cfg.LivestreamStreamURL,
		})
		if err != nil {
			log.Fatalf("livestream provider: %v", err)
		}
		log.Println("livestream provider enabled")
	} else {
		log.Println("warning: LIVESTREAM_PROVIDER not set; /api/livestream/sessions return 503")
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
	question.RegisterRoutes(r, sqlDB, cfg.JWTSecret, llmClient)
	analytics.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	profile.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	precheck.RegisterRoutes(r, llmClient, cfg.JWTSecret)
	speech.RegisterRoutes(r, cfg.JWTSecret, speechClient)
	analysis.RegisterRoutes(r, sqlDB, cfg.JWTSecret, llmClient, cfg.DeepSeekModel)
	expression.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	digitalhuman.RegisterRoutes(r, cfg.JWTSecret, dhProvider)
	livestream.RegisterRoutes(r, cfg.JWTSecret, lsProvider, &livestream.Config{
		ProviderName: cfg.LivestreamProvider,
		StreamURL:    cfg.LivestreamStreamURL,
	})
	ws.RegisterRoutes(r, svc, cfg.JWTSecret)
	log.Fatal(r.Run(cfg.HTTPAddr))
}

var allowedOrigins = map[string]bool{
	"http://localhost:5173": true,
	"http://127.0.0.1:5173": true,
	"http://localhost:5174": true,
	"http://127.0.0.1:5174": true,
	"http://localhost":       true, // Capacitor Android WebView origin
	"https://localhost":      true,
}

// originAllowed reports whether a browser Origin header may call this API.
// Exact localhost origins are whitelisted; any origin on this app's dev port
// (5174) is allowed so phones can reach the backend via the machine's LAN IP
// (e.g. http://10.213.211.101:5174), which changes per network.
func originAllowed(origin string) bool {
	if allowedOrigins[origin] {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Scheme == "http" && u.Port() == "5174"
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if originAllowed(origin) {
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
