package enrollment_test

import (
	"testing"
	"xuetangx/internal/domain"
	"xuetangx/internal/enrollment"
	"xuetangx/internal/platform/wire"
)

func TestOnlyExactFreeJoin(t *testing.T) {
	for _, tc := range []struct {
		name    string
		price   any
		status  int
		class   int64
		product int64
		want    bool
	}{
		{"free", 0, 5, 12, 99, true}, {"free_future", 0, 6, 12, 99, true}, {"paid", 299, 5, 12, 99, false}, {"missing_price", nil, 5, 12, 99, false}, {"false_is_not_zero", false, 5, 12, 99, false}, {"closed", 0, 9, 12, 99, false}, {"login_prompt", 0, 12, 12, 99, false}, {"different_class", 0, 5, 13, 99, false}, {"different_product", 0, 5, 12, 100, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := domain.Course{ClassroomID: 12, Sign: "s", CourseSign: "c"}
			product := wire.Object{"id": 99, "sign": "s", "course_sign": "c"}
			classes := wire.Object{"current": []any{wire.Object{"classroom_id": tc.class}}}
			pricing := wire.Object{"product_id": tc.product, "sku_info": []any{wire.Object{"sku_id": 22, "current_price": tc.price, "status": tc.status}}}
			got, err := enrollment.Select(c, product, classes, pricing)
			if (err == nil) != tc.want {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
}
