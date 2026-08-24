package ocr

import (
	"testing"
)

func TestExtractText(t *testing.T) {
	cases := []struct {
		name string
		data string
		want string
	}{
		{
			name: "prism words info joined by newline",
			data: `{"algo_version":"","content":"","prism_wordsInfo":[{"word":"面试题一"},{"word":"面试题二"}]}`,
			want: "面试题一\n面试题二",
		},
		{
			name: "falls back to content when no words info",
			data: `{"content":"整段识别文本","prism_wordsInfo":[]}`,
			want: "整段识别文本",
		},
		{
			name: "skips blank words",
			data: `{"prism_wordsInfo":[{"word":"  a  "},{"word":""},{"word":"b"}]}`,
			want: "a\nb",
		},
		{
			name: "invalid json returns raw string",
			data: `not-json`,
			want: "not-json",
		},
		{
			name: "empty data returns empty",
			data: ``,
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractText(tc.data); got != tc.want {
				t.Fatalf("extractText = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNewClientRequiresCredentials(t *testing.T) {
	if _, err := NewClient(Config{}); err == nil {
		t.Fatal("expected error when credentials missing")
	}
}

func TestNewFakeClient(t *testing.T) {
	c := NewFakeClient()
	text, err := c.Recognize(t.Context(), []byte("x"))
	if err != nil {
		t.Fatalf("fake recognize: %v", err)
	}
	if text != "OCR fake text" {
		t.Fatalf("fake text = %q, want OCR fake text", text)
	}
}
