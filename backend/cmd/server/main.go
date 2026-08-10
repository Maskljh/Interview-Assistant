package main

import (
	"log"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	r := gin.Default()
	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	log.Fatal(r.Run(cfg.HTTPAddr))
}
