package operations_test

import (
	"context"
	"strings"
	"testing"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/testkit"
)

func TestProgressEffectRecoversOnlyAfterCheckingPlatform(t *testing.T) {
	for _, kind := range []string{"video", "article"} {
		for _, initial := range []string{"new", "unknown", "pending", "posted"} {
			for _, accepted := range []bool{false, true} {
				t.Run(kind+"/"+initial+"/"+map[bool]string{true: "accepted", false: "missing"}[accepted], func(t *testing.T) {
					db := testkit.Database(t)
					a, c := testkit.Seed(t, db)
					ctx := context.Background()
					journal := &operations.Journal{DB: db}
					rec, err := journal.Load(ctx, operations.Key(kind, a, c, 34, 0, "batch"), kind, a, c, 34, 0, "batch")
					if err != nil {
						t.Fatal(err)
					}
					if initial != "new" {
						if err = journal.Save(ctx, &rec, initial, 0, false, nil); err != nil {
							t.Fatal(err)
						}
					}
					writes, reads := 0, 0
					complete := initial != "new" && accepted
					call := func(_ context.Context, _ domain.Account, method, path string, _ any) (platform.Response, error) {
						d := wire.Object{}
						switch {
						case strings.Contains(path, "leaf_info"):
							reads++
							d = wire.Object{"id": 34, "classroom_id": c.ClassroomID, "course_id": 99, "user_id": a.UserID, "finish": complete}
						case strings.Contains(path, "get_video_watch_progress"):
							reads++
							d = wire.Object{"34": wire.Object{"completed": complete}}
						default:
							writes++
							if initial == "new" && writes == 1 {
								complete = accepted
								return platform.Response{}, &platform.TransportError{Connected: true, Transient: true}
							}
							if reads == 0 {
								t.Fatal("replayed before reading upstream progress")
							}
							complete = true
						}
						return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": d}}, nil
					}
					op := operations.New(journal, nil, nil, call)
					op.Wait = func(context.Context, time.Duration) error { return nil }
					if _, err = op.Effect(ctx, a, c, 34, kind, "batch", "POST", "/progress", nil); err != nil {
						t.Fatal(err)
					}
					want := 0
					if initial == "new" {
						want++
					}
					if !accepted {
						want++
					}
					if writes != want || reads == 0 {
						t.Fatalf("writes=%d want=%d reads=%d", writes, want, reads)
					}
					// A new service instance also reads completion, never blindly resends.
					restarted := operations.New(journal, nil, nil, call)
					if _, err = restarted.Effect(ctx, a, c, 34, kind, "batch", "POST", "/progress", nil); err != nil {
						t.Fatal(err)
					}
					if writes != want {
						t.Fatal("confirmed progress replayed", writes)
					}
				})
			}
		}
	}
}

func TestProgressMissingStateAndOtherEffectsNeverBlindlyReplay(t *testing.T) {
	for _, kind := range []string{"video", "article", "discussion", "enrollment"} {
		t.Run(kind, func(t *testing.T) {
			db := testkit.Database(t)
			a, c := testkit.Seed(t, db)
			ctx := context.Background()
			j := &operations.Journal{DB: db}
			r, err := j.Load(ctx, operations.Key(kind, a, c, 34, 0, ""), kind, a, c, 34, 0, "")
			if err != nil {
				t.Fatal(err)
			}
			if err = j.Save(ctx, &r, "unknown", 0, false, nil); err != nil {
				t.Fatal(err)
			}
			op := operations.New(j, nil, nil, func(_ context.Context, _ domain.Account, method, path string, _ any) (platform.Response, error) {
				if method != "GET" {
					t.Fatal("ambiguous effect was replayed")
				}
				return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{"id": 34, "classroom_id": c.ClassroomID, "user_id": a.UserID, "course_id": 99}}}, nil
			})
			_, err = op.Effect(ctx, a, c, 34, kind, "", "POST", "/mock", nil)
			if fault.Code(err) != "INVALID_METADATA" && fault.Code(err) != "REVIEW_REQUIRED" {
				t.Fatal(err)
			}
		})
	}
}

func TestRateLimitedEffectsContinuePastFormerLimitAndCancel(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{true: "cancel", false: "recover"}[cancelled], func(t *testing.T) {
			db := testkit.Database(t)
			a, c := testkit.Seed(t, db)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			op := operations.New(&operations.Journal{DB: db}, nil, nil, func(context.Context, domain.Account, string, string, any) (platform.Response, error) {
				calls++
				if calls <= 6 {
					return platform.Response{Status: 429}, nil
				}
				return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{}}}, nil
			})
			waits := 0
			op.Wait = func(ctx context.Context, d time.Duration) error {
				if d <= 0 {
					t.Fatal("busy retry")
				}
				waits++
				if cancelled && waits == 6 {
					cancel()
				}
				return ctx.Err()
			}
			_, err := op.Effect(ctx, a, c, 34, "discussion", "", "POST", "/mock", nil)
			if cancelled {
				if err == nil {
					t.Fatal("cancel ignored")
				}
			} else if err != nil || calls != 7 {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}
