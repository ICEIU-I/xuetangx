package platform

import "time"

// CooldownState contains no account identity and can be shown to users of a shared collector.
type CooldownState struct {
	Source  string `json:"source"`
	Scope   string `json:"scope,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Blocked bool   `json:"blocked"`
	ReadyAt *int64 `json:"readyAt"`
}

type LimitState struct {
	UserID int64 `json:"userId"`
	CooldownState
}

func (b *Broker) State(userID int64) LimitState { return b.state(userID, true) }

func (b *Broker) state(userID int64, submission bool) LimitState {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	s := LimitState{UserID: userID, CooldownState: CooldownState{Source: "server"}}
	until := b.accessCooldowns[userID]
	if until.After(now) {
		s.Scope, s.Reason = "account", "access_denied"
	} else {
		delete(b.accessCooldowns, userID)
	}
	rate := b.cooldowns[userID]
	if !rate.After(now) {
		delete(b.cooldowns, userID)
	} else if submission && rate.After(until) {
		until = rate
		s.Scope, s.Reason = "submissions", "rate_limited"
	}
	if until.After(now) {
		s.Blocked = true
		n := until.UnixMilli()
		s.ReadyAt = &n
	}
	return s
}

func (b *Broker) recordCooldown(o outcome) {
	if o.err == nil && (o.response.Status == 403 || (o.entry.submission && RateLimited(o.response))) {
		b.mu.Lock()
		target := b.cooldowns
		if o.response.Status == 403 {
			target = b.accessCooldowns
		}
		until := Cooldown(o.response, time.Now())
		if until.After(target[o.entry.account.UserID]) {
			target[o.entry.account.UserID] = until
		}
		b.mu.Unlock()
	}
	if b.OnLimit != nil && (o.entry.submission || o.response.Status == 403) {
		b.OnLimit(o.entry.account, b.State(o.entry.account.UserID))
	}
}
