package analysis

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/interview-assistant/backend/internal/wps"
)

// emailBodyLimit 是 WPS 邮箱创建邮件正文的长度上限（开放平台接口约束）。
const emailBodyLimit = 1024

// EmailReporter 通过用户自己的 WPS 邮箱，把面试报告摘要发送给该用户。
type EmailReporter struct {
	svc    *Service
	wps    *wps.Client
	tokens wps.TokenProvider
}

func NewEmailReporter(svc *Service, client *wps.Client, tokens wps.TokenProvider) *EmailReporter {
	return &EmailReporter{svc: svc, wps: client, tokens: tokens}
}

// SendReportEmail 生成报告摘要并发送到当前用户的 WPS 邮箱；返回收件地址。
func (e *EmailReporter) SendReportEmail(ctx context.Context, userID, sessionID int64) (string, error) {
	if e.tokens == nil {
		return "", errors.New("WPS 邮箱功能未配置")
	}
	report, err := e.svc.GetReport(ctx, userID, sessionID)
	if err != nil {
		return "", err
	}
	if !report.Available || report.Feedback == nil {
		return "", errors.New("报告尚未生成")
	}
	token, err := e.tokens.TokenForUser(ctx, userID)
	if err != nil || token == "" {
		return "", errors.New("WPS 账号未授权或登录已过期，请重新登录")
	}

	// 取岗位名与日期，用于邮件标题。
	session, err := e.svc.repo.GetByID(sessionID)
	if err != nil {
		return "", err
	}
	jobTitle := "面试"
	if session.JobTitle != nil && strings.TrimSpace(*session.JobTitle) != "" {
		jobTitle = strings.TrimSpace(*session.JobTitle)
	} else if first := firstNonEmptyLine(session.JobJD); first != "" {
		jobTitle = first
	}
	subject := fmt.Sprintf("【面试报告】%s 综合表现 %d/100", jobTitle, report.Feedback.TotalScore)

	body := buildReportSummary(report.Feedback)
	if runeLen(body) > emailBodyLimit {
		body = trimTo(body, emailBodyLimit)
	}

	// 找用户自己的主邮箱作为收件人。
	mailboxes, err := e.wps.ListMailboxes(ctx, token)
	if err != nil {
		return "", fmt.Errorf("获取邮箱列表失败：%w", err)
	}
	if len(mailboxes) == 0 {
		return "", errors.New("未找到可用的 WPS 邮箱")
	}
	target := mailboxes[0]
	for _, mb := range mailboxes {
		if mb.IsPrimary {
			target = mb
			break
		}
	}
	if target.EmailAddress == "" {
		return "", errors.New("WPS 邮箱地址为空")
	}

	messageID, err := e.wps.CreateMailMessage(ctx, token, target.ID, subject, body, []string{target.EmailAddress})
	if err != nil {
		return "", fmt.Errorf("创建邮件失败：%w", err)
	}
	if err := e.wps.SendMailMessage(ctx, token, target.ID, messageID); err != nil {
		return "", fmt.Errorf("发送邮件失败：%w", err)
	}
	return target.EmailAddress, nil
}

// buildReportSummary 生成精简的报告摘要（纯文本，适配邮件正文长度限制）。
func buildReportSummary(fb *Feedback) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("综合表现：%d/100\n", fb.TotalScore))
	if strings.TrimSpace(fb.Summary) != "" {
		b.WriteString("总评：" + strings.TrimSpace(fb.Summary) + "\n")
	}
	b.WriteString(fmt.Sprintf("能力维度：表达 %d | 逻辑 %d | 内容 %d | 岗位匹配 %d\n",
		fb.Dimensions.Expression, fb.Dimensions.Logic, fb.Dimensions.Content, fb.Dimensions.JobMatch))
	b.WriteString("\n本场亮点：\n")
	appendList(&b, fb.Strengths, "暂无")
	b.WriteString("\n优先改进：\n")
	appendList(&b, fb.Weaknesses, "暂无")
	b.WriteString("\n下一轮训练建议：\n")
	appendList(&b, fb.Suggestions, "暂无")
	return b.String()
}

func appendList(b *strings.Builder, items []string, empty string) {
	if len(items) == 0 {
		b.WriteString("- " + empty + "\n")
		return
	}
	for _, it := range items {
		line := strings.TrimSpace(it)
		if line != "" {
			b.WriteString("- " + line + "\n")
		}
	}
}

func firstNonEmptyLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			r := []rune(t)
			if len(r) > 20 {
				return string(r[:20]) + "…"
			}
			return t
		}
	}
	return ""
}

func runeLen(s string) int {
	return len([]rune(s))
}

func trimTo(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
