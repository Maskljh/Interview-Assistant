package main

import (
	"log"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/config"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
	"github.com/interview-assistant/backend/internal/llm"
	"github.com/interview-assistant/backend/internal/user"
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
	var llmClient llm.Client
	if cfg.DeepSeekAPIKey != "" {
		llmClient = llm.NewDeepSeekClient(cfg.DeepSeekAPIKey, cfg.DeepSeekBaseURL, cfg.DeepSeekModel)
		log.Println("DeepSeek LLM client enabled")
	} else {
		log.Println("warning: DEEPSEEK_API_KEY not set; interview start will return 502")
	}

	r := gin.Default()
	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	user.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	interview.RegisterRoutes(r, sqlDB, cfg.JWTSecret, llmClient)
	log.Fatal(r.Run(cfg.HTTPAddr))
}
