package project

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/interview-assistant/backend/internal/auth"
	"github.com/interview-assistant/backend/internal/llm"
)

// Handler exposes project-related endpoints.
type Handler struct {
	llm   llm.Client
	token string // GitHub personal access token (optional, raises rate limit)
}

// RegisterRoutes mounts all /api/projects endpoints under r.
func RegisterRoutes(r *gin.Engine, llmClient llm.Client, secret string, githubToken string) {
	h := &Handler{llm: llmClient, token: githubToken}
	g := r.Group("/api/projects", auth.Middleware(secret))
	g.POST("/analyze", h.Analyze)
}

// AnalyzeRequest is the expected request body.
type AnalyzeRequest struct {
	GitHubURL string `json:"github_url" binding:"required"`
	JobTitle  string `json:"job_title"`
}

// GeneratedQuestion is a single question produced from the project analysis.
type GeneratedQuestion struct {
	Question  string `json:"question"`
	Dimension string `json:"dimension"`
}

// AnalyzeResponse is the full response returned to the frontend.
type AnalyzeResponse struct {
	Project   ProjectMeta          `json:"project"`
	Questions []GeneratedQuestion  `json:"questions"`
}

// ProjectMeta is a small summary shown in the UI before question preview.
type ProjectMeta struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Language    string   `json:"language"`
	Topics      []string `json:"topics"`
	Stars       int      `json:"stars"`
}

// Analyze fetches the GitHub repo, sends it to the LLM, and returns generated questions.
func (h *Handler) Analyze(c *gin.Context) {
	var req AnalyzeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请提供有效的 GitHub 项目链接"})
		return
	}

	// 1. Fetch repo info from GitHub API.
	info, err := FetchRepoInfo(req.GitHubURL, h.token)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无法读取 GitHub 项目: " + err.Error()})
		return
	}

	// 2. Call LLM to generate interview questions.
	system := llm.GenerateProjectQuestionsSystem()
	projectInfo := &llm.ProjectInfo{
		Name:        info.Name,
		Description: info.Description,
		Language:    info.Language,
		Topics:      info.Topics,
		Stars:       info.Stars,
		Readme:      info.Readme,
	}
	user := llm.GenerateProjectQuestionsUser(projectInfo, req.JobTitle)

	var out llm.GenQuestionsOut
	if err := h.llm.ChatJSON(c.Request.Context(), system, user, &out); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "AI 生成题目失败，请稍后重试"})
		return
	}

	// 3. Map to response format.
	questions := make([]GeneratedQuestion, 0, len(out.Questions))
	for _, q := range out.Questions {
		questions = append(questions, GeneratedQuestion{
			Question:  q.Question,
			Dimension: q.Intent,
		})
	}

	c.JSON(http.StatusOK, AnalyzeResponse{
		Project: ProjectMeta{
			Name:        info.Name,
			Description: info.Description,
			Language:    info.Language,
			Topics:      info.Topics,
			Stars:       info.Stars,
		},
		Questions: questions,
	})
}
