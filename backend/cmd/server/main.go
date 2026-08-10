package main

import (
	"log"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/config"
	"github.com/interview-assistant/backend/internal/db"
	"github.com/interview-assistant/backend/internal/interview"
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
	r := gin.Default()
	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	user.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	interview.RegisterRoutes(r, sqlDB, cfg.JWTSecret)
	log.Fatal(r.Run(cfg.HTTPAddr))
}
