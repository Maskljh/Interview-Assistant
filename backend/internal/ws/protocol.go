package ws

type ClientMsg struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

type ServerMsg struct {
	Type    string `json:"type"` // session_started|question|follow_up|status|done
	Content string `json:"content,omitempty"`
	Progress *struct {
		Current int `json:"current"`
		Total   int `json:"total"`
	} `json:"progress,omitempty"`
}
