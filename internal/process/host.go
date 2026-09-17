package process

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
	"xuetangx/internal/fault"
	"xuetangx/internal/learning"
	"xuetangx/internal/platform/wire"
)

type Handler func(context.Context, string, json.RawMessage) (any, error)
type Host struct {
	Executable string
	Args       []string
}

func (h Host) Run(ctx context.Context, generation int64, in learning.Input, call Handler, progress func(learning.Progress) error, wake <-chan string) (learning.Result, error) {
	executable := h.Executable
	if executable == "" {
		var e error
		executable, e = os.Executable()
		if e != nil {
			return learning.Result{}, e
		}
	}
	args := h.Args
	if len(args) == 0 {
		args = []string{"worker"}
	}
	cmd := exec.Command(executable, args...)
	cmd.Env = []string{}
	for _, key := range []string{"PATH", "LANG", "TMPDIR", "TEMP"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.Stderr = io.Discard
	stdin, e := cmd.StdinPipe()
	if e != nil {
		return learning.Result{}, e
	}
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return learning.Result{}, e
	}
	if e = cmd.Start(); e != nil {
		return learning.Result{}, fault.New("WORKER_CRASH", "无法启动任务子进程")
	}
	w := &writer{out: stdin}
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	defer stdin.Close()
	go func() {
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				_ = w.send(Message{Type: "cancel", Generation: generation})
				timer := time.NewTimer(2 * time.Second)
				defer timer.Stop()
				select {
				case <-done:
				case <-timer.C:
					_ = cmd.Process.Kill()
				}
				return
			case kind := <-wake:
				_ = w.send(Message{Type: kind, Generation: generation})
			}
		}
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), MaxMessage)
	var wg sync.WaitGroup
	var result learning.Result
	var failure error
	finished := false
	var seen sync.Map
	for scanner.Scan() {
		var m Message
		if json.Unmarshal(scanner.Bytes(), &m) != nil || m.Version != Version {
			failure = fault.New("IPC_INVALID", "子进程消息格式无效")
			_ = cmd.Process.Kill()
			break
		}
		if m.Type == "ready" {
			if e = w.send(Message{Type: "init", Generation: generation, Payload: wire.JSON(in)}); e != nil {
				failure = e
				_ = cmd.Process.Kill()
				break
			}
			continue
		}
		if m.Generation != generation {
			continue
		}
		switch m.Type {
		case "rpc":
			if m.ID == 0 {
				failure = fault.New("IPC_INVALID", "请求编号无效")
				_ = cmd.Process.Kill()
				break
			}
			if _, loaded := seen.LoadOrStore(m.ID, true); loaded {
				failure = fault.New("IPC_INVALID", "请求编号重复")
				_ = cmd.Process.Kill()
				break
			}
			wg.Add(1)
			go func(m Message) {
				defer wg.Done()
				response, err := call(workerCtx, m.Method, m.Payload)
				reply := Message{Type: "rpc-result", ID: m.ID, Generation: generation, Payload: wire.JSON(response)}
				if err != nil {
					reply.Error = &fault.Error{Code: fault.Code(err), Message: fault.Public(err)}
					reply.Payload = nil
				}
				_ = w.send(reply)
			}(m)
		case "progress":
			var p learning.Progress
			if e = json.Unmarshal(m.Payload, &p); e == nil && progress != nil {
				e = progress(p)
			}
			if e != nil {
				failure = e
				cancel()
				_ = cmd.Process.Kill()
			}
		case "result":
			if e = json.Unmarshal(m.Payload, &result); e != nil {
				failure = e
			} else {
				finished = true
			}
		case "failed":
			if m.Error == nil {
				failure = fault.New("WORKER_CRASH", "子进程失败")
			} else {
				failure = m.Error
			}
			finished = true
		}
	}
	cancel()
	waitErr := cmd.Wait()
	wg.Wait()
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	if failure != nil {
		return result, failure
	}
	if e = scanner.Err(); e != nil {
		return result, e
	}
	if !finished || waitErr != nil {
		return result, fault.New("WORKER_CRASH", "任务子进程意外退出")
	}
	return result, nil
}
