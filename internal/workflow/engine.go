package workflow

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"sync"
	"sync/atomic"
	"time"
	"xuetangx/internal/accounts"
	"xuetangx/internal/bank"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/jobs"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/process"
	"xuetangx/internal/store"
)

type actor struct {
	cancel     context.CancelFunc
	wake       chan string
	account    domain.Account
	generation int64
}
type Engine struct {
	DB                     *store.Store
	Accounts               *accounts.Service
	Bank                   *bank.Service
	Catalog                *catalog.Service
	Broker                 *platform.Broker
	Ops                    *operations.Service
	Jobs                   *jobs.Repository
	Host                   process.Host
	GlobalLimit, UserLimit int
	ctx                    context.Context
	cancel                 context.CancelFunc
	mu                     sync.Mutex
	actors                 map[string]*actor
	preparing              map[string]context.CancelFunc
	preparingCollectors    map[string]domain.Account
	owners                 map[string]string
	ready                  atomic.Bool
	wg                     sync.WaitGroup
	done                   chan struct{}
	leader                 *pgxpool.Conn
	lastOwner              string
}

func New(ctx context.Context, db *store.Store, a *accounts.Service, b *bank.Service, c *catalog.Service, broker *platform.Broker, ops *operations.Service, global, user int) (*Engine, error) {
	conn, e := db.Pool.Acquire(ctx)
	if e != nil {
		return nil, e
	}
	var locked bool
	if e = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':' || current_schema(),782361908))").Scan(&locked); e != nil || !locked {
		conn.Release()
		return nil, fault.New("LEADER_UNAVAILABLE", "已有主调度器运行")
	}
	background, cancel := context.WithCancel(context.Background())
	engine := &Engine{DB: db, Accounts: a, Bank: b, Catalog: c, Broker: broker, Ops: ops, Jobs: &jobs.Repository{DB: db}, GlobalLimit: global, UserLimit: user, ctx: background, cancel: cancel, actors: map[string]*actor{}, preparing: map[string]context.CancelFunc{}, owners: map[string]string{}, done: make(chan struct{}), leader: conn}
	if e = engine.Jobs.Recover(ctx); e != nil {
		conn.Exec(ctx, "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || current_schema(),782361908))")
		conn.Release()
		cancel()
		return nil, e
	}
	engine.preparingCollectors = map[string]domain.Account{}
	engine.ready.Store(true)
	broker.Ready = engine.Ready
	a.OnChange = engine.AccountChanged
	go engine.loop()
	return engine, nil
}
func (e *Engine) Ready() bool { return e.ready.Load() && e.ctx.Err() == nil }
func (e *Engine) Close() {
	e.cancel()
	<-e.done
	e.wg.Wait()
	e.Broker.Close()
	_ = e.Jobs.Recover(context.Background())
	e.leader.Exec(context.Background(), "SELECT pg_advisory_unlock(hashtextextended(current_database() || ':' || current_schema(),782361908))")
	e.leader.Release()
}
func (e *Engine) loop() {
	defer close(e.done)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	health := time.NewTicker(time.Second)
	defer health.Stop()
	for {
		select {
		case <-e.ctx.Done():
			e.ready.Store(false)
			e.mu.Lock()
			for _, a := range e.actors {
				a.cancel()
			}
			for _, cancel := range e.preparing {
				cancel()
			}
			e.mu.Unlock()
			return
		case <-health.C:
			ctx, cancel := context.WithTimeout(e.ctx, 3*time.Second)
			err := e.leader.Ping(ctx)
			cancel()
			if err != nil {
				e.ready.Store(false)
				e.cancel()
			}
		case <-tick.C:
			if e.Ready() {
				if err := e.dispatch(); err != nil {
					e.ready.Store(false)
					e.cancel()
					continue
				}
				_ = e.deliverAnswers()
			}
		}
	}
}
func (e *Engine) dispatch() error {
	rows, err := e.DB.Pool.Query(e.ctx, `SELECT j.id,j.owner_id FROM jobs j JOIN users u ON u.id=j.owner_id WHERE j.status IN ('queued','running') AND u.verified AND NOT u.disabled AND EXISTS(SELECT 1 FROM job_modules m WHERE m.job_id=j.id AND m.status='queued') ORDER BY j.created_at`)
	if err != nil {
		return err
	}
	type candidate struct{ id, owner string }
	pending := []candidate{}
	for rows.Next() {
		var c candidate
		if err = rows.Scan(&c.id, &c.owner); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// Rotate owners, retaining FIFO within each owner and reserving a slot per active course.
	for len(pending) > 0 {
		index := 0
		for i, c := range pending {
			if c.owner != e.lastOwner {
				index = i
				break
			}
		}
		c := pending[index]
		pending = append(pending[:index], pending[index+1:]...)
		e.mu.Lock()
		_, preparing := e.preparing[c.id]
		_, active := e.owners[c.id]
		ownCount := 0
		for _, owner := range e.owners {
			if owner == c.owner {
				ownCount++
			}
		}
		if preparing || (!active && (len(e.owners) >= e.GlobalLimit || ownCount >= e.UserLimit)) {
			e.mu.Unlock()
			continue
		}
		ctx, cancel := context.WithCancel(e.ctx)
		e.preparing[c.id] = cancel
		e.owners[c.id] = c.owner
		e.lastOwner = c.owner
		e.wg.Add(1)
		e.mu.Unlock()
		go func() {
			defer e.wg.Done()
			defer cancel()
			if _, err := e.DB.Pool.Exec(ctx, "UPDATE jobs SET status='running' WHERE id=$1 AND owner_id=$2 AND status IN ('queued','running')", c.id, c.owner); err == nil {
				e.prepare(ctx, c.owner, c.id)
			}
			e.mu.Lock()
			delete(e.preparing, c.id)
			e.mu.Unlock()
			e.settle(c.owner, c.id)
		}()
	}
	return nil
}
func (e *Engine) settle(owner, id string) {
	e.mu.Lock()
	busy := e.preparing[id] != nil
	for key := range e.actors {
		if len(key) > len(id) && key[:len(id)+1] == id+":" {
			busy = true
		}
	}
	if !busy {
		delete(e.owners, id)
	}
	e.mu.Unlock()
	if !busy {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(e.ctx), 5*time.Second)
		defer cancel()
		_ = e.Jobs.Aggregate(ctx, owner, id)
	}
}
func (e *Engine) Start(ctx context.Context, owner string, input domain.Start) (domain.Job, error) {
	if !e.Ready() {
		return domain.Job{}, fault.New("UNAVAILABLE", "主调度器暂不可用")
	}
	a, err := e.Accounts.Require(ctx, owner, "primary")
	if err != nil {
		return domain.Job{}, err
	}
	target, err := platform.ParseCourse(input.CourseURL)
	if err != nil {
		return domain.Job{}, err
	}
	course, err := e.Catalog.Authorize(ctx, a, target)
	if err != nil {
		return domain.Job{}, err
	}
	id, err := e.Jobs.Create(ctx, a, course, input)
	if err != nil {
		return domain.Job{}, err
	}
	return e.Jobs.Get(ctx, owner, id)
}
func (e *Engine) Control(ctx context.Context, owner, id, action, kind string) (domain.Job, error) {
	if err := e.Jobs.Control(ctx, owner, id, action, kind); err != nil {
		return domain.Job{}, err
	}
	e.mu.Lock()
	if kind == "" {
		if c := e.preparing[id]; c != nil {
			c()
		}
	}
	for key, a := range e.actors {
		if (kind != "" && key == id+":"+kind) || (kind == "" && len(key) > len(id) && key[:len(id)+1] == id+":") {
			a.cancel()
		}
	}
	e.mu.Unlock()
	return e.Jobs.Get(ctx, owner, id)
}
func (e *Engine) Disable(owner string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, _, err := e.Jobs.List(ctx, owner, 100, 0)
	if err != nil {
		return
	}
	for _, j := range list {
		if j.Status == "running" || j.Status == "queued" || j.Status == "waiting_input" {
			_, _ = e.Control(ctx, owner, j.ID, "pause", "")
		}
	}
}
