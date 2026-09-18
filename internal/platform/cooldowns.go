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

// SetMinimumAccessCooldown changes the lower bound used for HTTP 403
// backoff. Production wiring leaves the default at one minute; tests can
// inject a short value without reaching into Broker's synchronization state.
func (b *Broker) SetMinimumAccessCooldown(delay time.Duration) {
	if delay < 0 {
		delay = 0
	}
	b.mu.Lock()
	b.minimumAccessCooldown = delay
	b.mu.Unlock()
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
		now := time.Now()
		until := Cooldown(o.response, now)
		if o.response.Status == 403 {
			minimum := now.Add(b.minimumAccessCooldown)
			if until.Before(minimum) {
				until = minimum
			}
		}
		if until.After(target[o.entry.account.UserID]) {
			target[o.entry.account.UserID] = until
		}
		b.mu.Unlock()
	}
	if b.OnLimit != nil && (o.entry.submission || o.response.Status == 403) {
		b.OnLimit(o.entry.account, b.State(o.entry.account.UserID))
	}
}

// Repeated denials grow the account-wide wait without shortening a server hint.
func (b *Broker) extendAccessCooldown(userID int64, attempt int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delay := min(b.minimumAccessCooldown*time.Duration(1<<min(attempt, 5)), 30*time.Minute)
	until := time.Now().Add(delay)
	if until.After(b.accessCooldowns[userID]) {
		b.accessCooldowns[userID] = until
	}
}
