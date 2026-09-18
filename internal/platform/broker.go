package platform

import (
	"context"
	"sync"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
)

type Credentials interface {
	Credential(context.Context, string, string, int64) (domain.Account, string, error)
	Invalidate(context.Context, string, string, int64) error
}
type request struct {
	ctx          context.Context
	account      domain.Account
	method, path string
	body         any
	submission   bool
	result       chan outcome
}
type outcome struct {
	response Response
	err      error
	entry    *request
}
type Broker struct {
	credentials     Credentials
	transport       Transport
	ctx             context.Context
	cancel          context.CancelFunc
	requests        chan *request
	results         chan outcome
	done            chan struct{}
	mu              sync.Mutex
	cooldowns       map[int64]time.Time
	accessCooldowns map[int64]time.Time
	OnLimit         func(domain.Account, LimitState)
	Ready           func() bool
}

func NewBroker(credentials Credentials, transport Transport) *Broker {
	ctx, cancel := context.WithCancel(context.Background())
	b := &Broker{credentials: credentials, transport: transport, ctx: ctx, cancel: cancel, requests: make(chan *request, 256), results: make(chan outcome, 64), done: make(chan struct{}), cooldowns: map[int64]time.Time{}, accessCooldowns: map[int64]time.Time{}}
	go b.run()
	return b
}
func (b *Broker) Close() { b.cancel(); <-b.done }
func (b *Broker) Request(ctx context.Context, a domain.Account, method, path string, body any) (Response, error) {
	r := &request{ctx: ctx, account: a, method: method, path: path, body: body, submission: method == "POST" && path == SubmitPath, result: make(chan outcome, 1)}
	select {
	case b.requests <- r:
	case <-ctx.Done():
		return Response{}, ctx.Err()
	case <-b.ctx.Done():
		return Response{}, fault.New("UNAVAILABLE", "请求调度器已关闭")
	}
	select {
	case result := <-r.result:
		return result.response, result.err
	case <-ctx.Done():
		return Response{}, ctx.Err()
	case <-b.ctx.Done():
		return Response{}, fault.New("UNAVAILABLE", "请求调度器已关闭")
	}
}
func (b *Broker) run() {
	defer close(b.done)
	queue := []*request{}
	active := map[int64]int{}
	total, streak := 0, 0
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	var wg sync.WaitGroup
	defer wg.Wait()
	execute := func(r *request) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithCancel(r.ctx)
			stop := context.AfterFunc(b.ctx, cancel)
			defer stop()
			defer cancel()
			o := outcome{entry: r}
			if b.Ready != nil && !b.Ready() {
				o.err = fault.New("UNAVAILABLE", "主调度器暂不可用")
			} else {
				a, cookie, e := b.credentials.Credential(ctx, r.account.Owner, r.account.ID, r.account.Revision)
				if e != nil {
					o.err = e
				} else {
					o.response, o.err = b.transport.Do(ctx, r.method, r.path, r.body, cookie)
					if o.err == nil && o.response.Status == 401 {
						_ = b.credentials.Invalidate(ctx, a.Owner, a.ID, a.Revision)
					}
				}
			}
			select {
			case b.results <- o:
			case <-b.ctx.Done():
				r.result <- outcome{err: b.ctx.Err()}
			}
		}()
	}
	for {
		select {
		case <-b.ctx.Done():
			for _, r := range queue {
				r.result <- outcome{err: b.ctx.Err()}
			}
			return
		case r := <-b.requests:
			queue = append(queue, r)
		case o := <-b.results:
			total--
			if o.entry.submission {
				active[o.entry.account.UserID]--
			}
			b.recordCooldown(o)
			o.entry.result <- o
		case <-ticker.C:
		}
		for total < 64 && len(queue) > 0 {
			normal, write := -1, -1
			for i := 0; i < len(queue); {
				r := queue[i]
				if r.ctx.Err() != nil {
					r.result <- outcome{err: r.ctx.Err()}
					queue = append(queue[:i], queue[i+1:]...)
					continue
				}
				if b.state(r.account.UserID, r.submission).Blocked {
					i++
					continue
				}
				if r.submission {
					if write < 0 && active[r.account.UserID] < 3 {
						write = i
					}
				} else if normal < 0 {
					normal = i
				}
				i++
			}
			index := write
			if normal >= 0 && (write < 0 || streak >= 2) {
				index = normal
			}
			if index < 0 {
				break
			}
			r := queue[index]
			queue = append(queue[:index], queue[index+1:]...)
			total++
			if r.submission {
				active[r.account.UserID]++
				streak++
			} else {
				streak = 0
			}
			execute(r)
		}
	}
}
