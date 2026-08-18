package digitalhuman

import "context"

type Status string

const (
	StatusPending    Status = "pending"
	StatusProcessing Status = "processing"
	StatusCompleted  Status = "completed"
	StatusFailed     Status = "failed"
)

type Config struct {
	ProviderName string
	APIKey       string
	Secret       string
	AvatarID     string
	Voice        string
}

// Provider 提交文本口播任务并查询渲染结果。视频生成在服务商侧排队渲染，
// 渲染时长通常 20~60 秒，调用方需轮询 Result。
type Provider interface {
	Submit(ctx context.Context, text string) (taskID string, err error)
	Result(ctx context.Context, taskID string) (Status, string, error)
}
