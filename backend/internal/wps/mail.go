package wps

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// Mailbox 是用户的 WPS 邮箱（一个用户可能有多个邮箱账号）。
type Mailbox struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	EmailAddress string `json:"email_address"`
	IsPrimary    bool   `json:"is_primary"`
}

type mailboxList struct {
	Items []Mailbox `json:"items"`
}

type createMessageResp struct {
	MessageID string `json:"message_id"`
}

// mailRecipient 是邮件收件人。
type mailRecipient struct {
	EmailAddress string `json:"email_address"`
	Name         string `json:"name,omitempty"`
}

// createMailMessageBody 是创建邮件草稿的请求体。
type createMailMessageBody struct {
	Subject      string          `json:"subject"`
	Body         string          `json:"body"`
	ToRecipients []mailRecipient `json:"to_recipients,omitempty"`
	CCRecipients []mailRecipient `json:"cc_recipients,omitempty"`
	BCCRecipients []mailRecipient `json:"bcc_recipients,omitempty"`
}

// ListMailboxes 获取用户的邮箱列表。
func (c *Client) ListMailboxes(ctx context.Context, token string) ([]Mailbox, error) {
	q := url.Values{}
	q.Set("page_size", "100")
	var out mailboxList
	if err := c.do(ctx, token, http.MethodGet, "/v7/mailboxes", q, nil, &out); err != nil {
		return nil, err
	}
	return out.Items, nil
}

// CreateMailMessage 在指定邮箱下创建邮件草稿，返回 message_id。
func (c *Client) CreateMailMessage(ctx context.Context, token, mailboxID, subject, body string, to []string) (string, error) {
	recipients := make([]mailRecipient, 0, len(to))
	for _, addr := range to {
		if addr != "" {
			recipients = append(recipients, mailRecipient{EmailAddress: addr})
		}
	}
	reqBody := createMailMessageBody{
		Subject:      subject,
		Body:         body,
		ToRecipients: recipients,
	}
	path := fmt.Sprintf("/v7/mailboxes/%s/messages/create", url.PathEscape(mailboxID))
	var out createMessageResp
	if err := c.do(ctx, token, http.MethodPost, path, nil, reqBody, &out); err != nil {
		return "", err
	}
	if out.MessageID == "" {
		return "", fmt.Errorf("wps create mail: empty message_id")
	}
	return out.MessageID, nil
}

// SendMailMessage 发送指定邮箱下的草稿邮件。
func (c *Client) SendMailMessage(ctx context.Context, token, mailboxID, messageID string) error {
	path := fmt.Sprintf("/v7/mailboxes/%s/messages/%s/send", url.PathEscape(mailboxID), url.PathEscape(messageID))
	return c.do(ctx, token, http.MethodPost, path, nil, nil, nil)
}
