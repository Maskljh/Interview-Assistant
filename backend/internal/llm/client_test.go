package llm_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/interview-assistant/backend/internal/llm"
)

func TestChatJSONParsesResponse(t *testing.T) {
	want := llm.GenQuestionsOut{
		Questions: []llm.GenQuestion{
			{Seq: 1, Question: "Tell me about yourself", Intent: "warmup"},
		},
	}
	payload, _ := json.Marshal(want)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"content": string(payload)}},
			},
		})
	}))
	defer srv.Close()

	client := llm.NewDeepSeekClient("test-key", srv.URL, "deepseek-chat")
	var out llm.GenQuestionsOut
	if err := client.ChatJSON(context.Background(), "system", "user", &out); err != nil {
		t.Fatalf("ChatJSON: %v", err)
	}
	if len(out.Questions) != 1 || out.Questions[0].Question != want.Questions[0].Question {
		t.Fatalf("got %+v, want %+v", out, want)
	}
}

func TestChatJSONStripsMarkdownFences(t *testing.T) {
	inner := `{"questions":[{"seq":1,"question":"Q","intent":"i"}]}`
	content := "```json\n" + inner + "\n```"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"content": content}},
			},
		})
	}))
	defer srv.Close()

	client := llm.NewDeepSeekClient("test-key", srv.URL, "deepseek-chat")
	var out llm.GenQuestionsOut
	if err := client.ChatJSON(context.Background(), "system", "user", &out); err != nil {
		t.Fatalf("ChatJSON: %v", err)
	}
	if len(out.Questions) != 1 {
		t.Fatalf("got %d questions", len(out.Questions))
	}
}

func TestChatJSONRetriesOnce(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"content": `{"questions":[{"seq":1,"question":"Q","intent":"i"}]}`}},
			},
		})
	}))
	defer srv.Close()

	client := llm.NewDeepSeekClient("test-key", srv.URL, "deepseek-chat")
	var out llm.GenQuestionsOut
	if err := client.ChatJSON(context.Background(), "system", "user", &out); err != nil {
		t.Fatalf("ChatJSON: %v", err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, want 2", calls)
	}
}
