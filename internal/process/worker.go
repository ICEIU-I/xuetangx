package process

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sync"
	"sync/atomic"
	"xuetangx/internal/fault"
	"xuetangx/internal/learning"
	"xuetangx/internal/platform/wire"
)

func Worker(input io.Reader, output io.Writer) error {
	w := &writer{out: output}
	if e := w.send(Message{Type: "ready"}); e != nil {
		return e
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), MaxMessage)
	if !scanner.Scan() {
		return io.ErrUnexpectedEOF
	}
	var init Message
	if e := json.Unmarshal(scanner.Bytes(), &init); e != nil || init.Version != Version || init.Type != "init" {
		return fault.New("IPC_INVALID", "无效初始化消息")
	}
	var in learning.Input
	if e := json.Unmarshal(init.Payload, &in); e != nil {
		return e
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	pending := map[uint64]chan Message{}
	var sequence atomic.Uint64
	wake := make(chan struct{}, 1)
	go func() {
		defer cancel()
		for scanner.Scan() {
			var msg Message
			if json.Unmarshal(scanner.Bytes(), &msg) != nil || msg.Version != Version {
				return
			}
			if msg.Generation != init.Generation {
				continue
			}
			switch msg.Type {
			case "cancel":
				return
			case "answer-ready", "answers-complete":
				select {
				case wake <- struct{}{}:
				default:
				}
			case "rpc-result":
				mu.Lock()
				ch := pending[msg.ID]
				delete(pending, msg.ID)
				mu.Unlock()
				if ch != nil {
					ch <- msg
				}
			}
		}
	}()
	runner := learning.Runner{Wake: wake, Progress: func(p learning.Progress) {
		if e := w.send(Message{Type: "progress", Generation: init.Generation, Payload: wire.JSON(p)}); e != nil {
			cancel()
		}
	}, Call: func(ctx context.Context, method string, args, out any) error {
		id := sequence.Add(1)
		ch := make(chan Message, 1)
		mu.Lock()
		pending[id] = ch
		mu.Unlock()
		defer func() { mu.Lock(); delete(pending, id); mu.Unlock() }()
		if e := w.send(Message{Type: "rpc", ID: id, Generation: init.Generation, Method: method, Payload: wire.JSON(args)}); e != nil {
			return e
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg := <-ch:
			if msg.Error != nil {
				return msg.Error
			}
			return json.Unmarshal(msg.Payload, out)
		}
	}}
	result, e := runner.Run(ctx, in)
	if e != nil {
		return w.send(Message{Type: "failed", Generation: init.Generation, Error: &fault.Error{Code: fault.Code(e), Message: fault.Public(e)}})
	}
	return w.send(Message{Type: "result", Generation: init.Generation, Payload: wire.JSON(result)})
}
