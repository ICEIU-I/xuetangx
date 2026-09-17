package process

import (
	"encoding/json"
	"io"
	"sync"
	"xuetangx/internal/fault"
)

const Version = 1
const MaxMessage = 8 * 1024 * 1024

type Message struct {
	Version    int             `json:"version"`
	Type       string          `json:"type"`
	ID         uint64          `json:"requestId,omitempty"`
	Generation int64           `json:"generation"`
	Method     string          `json:"method,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	Error      *fault.Error    `json:"error,omitempty"`
}
type writer struct {
	mu  sync.Mutex
	out io.Writer
}

func (w *writer) send(m Message) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	m.Version = Version
	b, e := json.Marshal(m)
	if e != nil {
		return e
	}
	if len(b) > MaxMessage {
		return fault.New("IPC_LIMIT", "任务消息过大")
	}
	_, e = w.out.Write(append(b, '\n'))
	return e
}
