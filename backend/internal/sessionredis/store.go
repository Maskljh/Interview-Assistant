package sessionredis

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const keyPrefix = "interview:live:"

type LiveState struct {
	SessionID          int64  `json:"session_id"`
	QuestionIndex      int    `json:"question_index"`
	FollowUpsOnCurrent int    `json:"follow_ups_on_current"`
	TurnCount          int    `json:"turn_count"`
	PendingKind        string `json:"pending_kind"` // question | follow_up
	PendingText        string `json:"pending_text"`
}

type Store interface {
	Get(ctx context.Context, sessionID int64) (*LiveState, error)
	Save(ctx context.Context, state *LiveState, ttl time.Duration) error
	Delete(ctx context.Context, sessionID int64) error
}

type RedisStore struct {
	client *redis.Client
}

func NewRedisStore(client *redis.Client) *RedisStore {
	return &RedisStore{client: client}
}

func (s *RedisStore) key(sessionID int64) string {
	return fmt.Sprintf("%s%d", keyPrefix, sessionID)
}

func (s *RedisStore) Get(ctx context.Context, sessionID int64) (*LiveState, error) {
	data, err := s.client.Get(ctx, s.key(sessionID)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var state LiveState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

func (s *RedisStore) Save(ctx context.Context, state *LiveState, ttl time.Duration) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, s.key(state.SessionID), data, ttl).Err()
}

func (s *RedisStore) Delete(ctx context.Context, sessionID int64) error {
	return s.client.Del(ctx, s.key(sessionID)).Err()
}
