package operations_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"xuetangx/internal/bank"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/testkit"
)

func TestFreeEnrollmentConfirmationAndUnknownRecovery(t *testing.T) {
	for _, mode := range []string{"success", "paid", "accepted_disconnect", "unconfirmed_disconnect", "wrong_class"} {
		t.Run(mode, func(t *testing.T) {
			db := testkit.Database(t)
			a, c := testkit.Seed(t, db)
			a.Shared = true
			ctx := context.Background()
			writes := 0
			enrolled := false
			call := func(_ context.Context, _ domain.Account, method, path string, body any) (platform.Response, error) {
				data := wire.Object{}
				switch {
				case strings.Contains(path, "user-courses"):
					items := []any{}
					if enrolled {
						items = append(items, wire.Object{"classroom_id": c.ClassroomID, "sign": c.Sign, "course_sign": c.CourseSign, "name": c.Title})
					}
					data = wire.Object{"pages": 1, "product_list": items}
				case strings.Contains(path, "get_product_basic_info"):
					data = wire.Object{"id": 99, "sign": c.Sign, "course_sign": c.CourseSign}
				case strings.Contains(path, "product/classroom"):
					id := c.ClassroomID
					if mode == "wrong_class" {
						id++
					}
					data = wire.Object{"current": []any{wire.Object{"classroom_id": id}}}
				case strings.Contains(path, "sku_pay_detail"):
					price := 0
					if mode == "paid" {
						price = 299
					}
					data = wire.Object{"product_id": 99, "sku_info": []any{wire.Object{"sku_id": 22, "current_price": price, "status": 5}}}
				case path == "/api/v1/lms/order/entries_free_sku/99/?sid=22" && method == "POST":
					var state string
					if err := db.Pool.QueryRow(ctx, "SELECT state FROM operations WHERE kind='enrollment'").Scan(&state); err != nil || state != "pending" {
						t.Fatalf("sent before journal commit: %s %v", state, err)
					}
					writes++
					enrolled = mode != "unconfirmed_disconnect"
					if strings.Contains(mode, "disconnect") {
						return platform.Response{}, errors.New("connection lost")
					}
				default:
					t.Fatalf("unexpected platform request %s %s", method, path)
				}
				return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": data}}, nil
			}
			newOps := func() *operations.Service {
				return operations.New(&operations.Journal{DB: db}, &bank.Service{DB: db}, &catalog.Service{DB: db, Request: call}, call)
			}
			op := newOps()
			err := op.EnrollFree(ctx, a, c)
			switch mode {
			case "paid", "wrong_class":
				if err == nil || writes != 0 {
					t.Fatal("ineligible enrollment sent", err, writes)
				}
			case "unconfirmed_disconnect":
				if err == nil || writes != 1 {
					t.Fatal(err, writes)
				}
				if err = newOps().EnrollFree(ctx, a, c); fault.Code(err) != "REVIEW_REQUIRED" || writes != 1 {
					t.Fatal("unknown replayed", err, writes)
				}
				enrolled = true
				if err = newOps().EnrollFree(ctx, a, c); err != nil {
					t.Fatal(err)
				}
			default:
				if err != nil || writes != 1 {
					t.Fatal(err, writes)
				}
				if err = newOps().EnrollFree(ctx, a, c); err != nil || writes != 1 {
					t.Fatal("confirmed replayed", err, writes)
				}
			}
		})
	}
}
func TestConcurrentFreeEnrollmentJoinsOnce(t *testing.T) {
	db := testkit.Database(t)
	a, c := testkit.Seed(t, db)
	a.Shared = true
	ctx := context.Background()
	var mu sync.Mutex
	joined := false
	writes := 0
	call := func(_ context.Context, _ domain.Account, method, path string, _ any) (platform.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		d := wire.Object{}
		switch {
		case strings.Contains(path, "user-courses"):
			items := []any{}
			if joined {
				items = append(items, wire.Object{"classroom_id": c.ClassroomID, "sign": c.Sign, "course_sign": c.CourseSign, "name": "c"})
			}
			d = wire.Object{"pages": 1, "product_list": items}
		case strings.Contains(path, "get_product_basic_info"):
			d = wire.Object{"id": 99, "sign": c.Sign, "course_sign": c.CourseSign}
		case strings.Contains(path, "product/classroom"):
			d = wire.Object{"current": []any{wire.Object{"classroom_id": c.ClassroomID}}}
		case strings.Contains(path, "sku_pay_detail"):
			d = wire.Object{"product_id": 99, "sku_info": []any{wire.Object{"sku_id": 22, "current_price": 0, "status": 5}}}
		case method == "POST" && strings.Contains(path, "entries_free_sku"):
			writes++
			joined = true
		default:
			t.Errorf("unexpected %s", path)
		}
		return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": d}}, nil
	}
	op := operations.New(&operations.Journal{DB: db}, &bank.Service{DB: db}, &catalog.Service{DB: db, Request: call}, call)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := op.EnrollFree(ctx, a, c); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if writes != 1 {
		t.Fatal(writes)
	}
}
