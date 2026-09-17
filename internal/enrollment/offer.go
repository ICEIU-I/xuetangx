// Package enrollment parses the official course page's free-enrollment contract.
package enrollment

import (
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
)

type Offer struct{ ProductID, SKUID int64 }

func Select(c domain.Course, product, classrooms, pricing wire.Object) (Offer, error) {
	invalid := func() (Offer, error) {
		return Offer{}, fault.New("ENROLLMENT_REQUIRED", "无法确认对应班级的免费加入选项")
	}
	pid, err := wire.ID(product["id"])
	if err != nil || wire.String(product["sign"]) != c.Sign || wire.String(product["course_sign"]) != c.CourseSign {
		return invalid()
	}
	matched := false
	for _, key := range []string{"current", "history"} {
		for _, v := range wire.Array(classrooms[key]) {
			id, _ := wire.Int(wire.Obj(v)["classroom_id"])
			if id == c.ClassroomID {
				matched = true
			}
		}
	}
	if !matched {
		return invalid()
	}
	pricingProduct, pe := wire.ID(pricing["product_id"])
	if pe != nil || pricingProduct != pid {
		return invalid()
	}
	list, ok := pricing["sku_info"].([]any)
	if !ok {
		return invalid()
	}
	for _, v := range list {
		x := wire.Obj(v)
		price, ok := wire.Number(x["current_price"])
		status, valid := wire.Int(x["status"])
		sku, err := wire.ID(x["sku_id"])
		// Only the exact zero-price join button is eligible. Paid upgrades, trial
		// promotions, absent prices, closed classes and login prompts are excluded.
		if !ok || price != 0 || !valid || (status != 5 && status != 6) || err != nil {
			continue
		}
		if id, has := x["classroom_id"]; has {
			n, e := wire.ID(id)
			if e != nil || n != c.ClassroomID {
				return invalid()
			}
		}
		return Offer{pid, sku}, nil
	}
	return Offer{}, fault.New("NO_FREE_ENROLLMENT", "对应班级没有可用的免费加入选项，已跳过付费或未开放课程")
}
