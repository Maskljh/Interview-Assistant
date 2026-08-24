package ocr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	ocrsdk "github.com/alibabacloud-go/ocr-api-20210707/client"
	"github.com/alibabacloud-go/tea/tea"
)

const defaultEndpoint = "ocr-api.cn-hangzhou.aliyuncs.com"

type Client interface {
	Recognize(ctx context.Context, image []byte) (string, error)
}

type Config struct {
	AccessKeyID     string
	AccessKeySecret string
	Endpoint        string
}

type aliyunClient struct {
	inner *ocrsdk.Client
}

func NewClient(cfg Config) (Client, error) {
	if cfg.AccessKeyID == "" || cfg.AccessKeySecret == "" {
		return nil, fmt.Errorf("aliyun ocr credentials required")
	}
	endpoint := cfg.Endpoint
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	sdkCfg := &openapi.Config{
		AccessKeyId:     tea.String(cfg.AccessKeyID),
		AccessKeySecret: tea.String(cfg.AccessKeySecret),
		Endpoint:        tea.String(endpoint),
	}
	inner, err := ocrsdk.NewClient(sdkCfg)
	if err != nil {
		return nil, fmt.Errorf("aliyun ocr sdk: %w", err)
	}
	return &aliyunClient{inner: inner}, nil
}

func NewFakeClient() Client {
	return &fakeClient{}
}

type fakeClient struct{}

func (f *fakeClient) Recognize(ctx context.Context, image []byte) (string, error) {
	return "OCR fake text", nil
}

// ocrData mirrors the JSON payload returned in RecognizeGeneralResponseBody.Data.
type ocrData struct {
	Content        string `json:"content"`
	PrismWordsInfo []struct {
		Word string `json:"word"`
	} `json:"prism_wordsInfo"`
}

// extractText parses the RecognizeGeneral Data JSON string into joined text.
func extractText(dataStr string) string {
	var sb strings.Builder
	if dataStr != "" {
		var data ocrData
		if err := json.Unmarshal([]byte(dataStr), &data); err == nil {
			for _, w := range data.PrismWordsInfo {
				if wd := strings.TrimSpace(w.Word); wd != "" {
					sb.WriteString(wd)
					sb.WriteString("\n")
				}
			}
			if sb.Len() == 0 {
				sb.WriteString(strings.TrimSpace(data.Content))
			}
		} else {
			sb.WriteString(dataStr)
		}
	}
	return strings.TrimSpace(sb.String())
}

func (c *aliyunClient) Recognize(ctx context.Context, image []byte) (string, error) {
	type result struct {
		text string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		req := &ocrsdk.RecognizeGeneralRequest{Body: bytes.NewReader(image)}
		resp, err := c.inner.RecognizeGeneral(req)
		if err != nil {
			ch <- result{err: err}
			return
		}
		if resp == nil || resp.Body == nil {
			ch <- result{err: fmt.Errorf("aliyun ocr returned empty response")}
			return
		}
		if code := tea.StringValue(resp.Body.Code); code != "" && code != "200" {
			ch <- result{err: fmt.Errorf("aliyun ocr code %s: %s", code, tea.StringValue(resp.Body.Message))}
			return
		}
		text := extractText(tea.StringValue(resp.Body.Data))
		if text == "" {
			ch <- result{err: fmt.Errorf("aliyun ocr returned no text")}
			return
		}
		ch <- result{text: text}
	}()

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case r := <-ch:
		if r.err != nil {
			return "", fmt.Errorf("aliyun ocr: %w", r.err)
		}
		return r.text, nil
	}
}
