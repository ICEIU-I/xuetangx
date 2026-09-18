package operations

import (
	"context"
	"fmt"
	"net/url"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/enrollment"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
)

// EnrollFree is only called by the parent scheduler for missing answers. No
// payment endpoint is reachable here, and an uncertain join is never replayed.
func (s *Service) EnrollFree(ctx context.Context, a domain.Account, c domain.Course) error {
	if !a.Shared {
		return fault.New("FORBIDDEN", "自动加入课程仅用于全站答案采集账号")
	}
	return s.enrollFree(ctx, a, c, false)
}

// EnrollFreeForUser is used only by the unified workflow for its fixed
// course. It accepts the platform's current zero-price trial SKU (status 12)
// while EnrollFree retains the narrower collector contract.
func (s *Service) EnrollFreeForUser(ctx context.Context, a domain.Account, c domain.Course) error {
	if a.Shared || a.Role != "primary" || !catalog.IsFixedCourse(c) {
		return fault.New("FORBIDDEN", "自动加入课程仅用于正式账号")
	}
	return s.enrollFree(ctx, a, c, true)
}

func (s *Service) enrollFree(ctx context.Context, a domain.Account, c domain.Course, userTrial bool) error {
	key := Key("enrollment", a, c, 0, 0, "free")
	result := s.group.DoChan(key+":check", func() (any, error) {
		_, err := s.Catalog.Authorize(ctx, a, c)
		if err == nil {
			return nil, s.confirmEnrollment(ctx, a, c, key)
		}
		if fault.Code(err) != "ENROLLMENT_REQUIRED" {
			return nil, err
		}
		product, err := s.Catalog.Data(ctx, a, "GET", "/api/v1/lms/product/get_product_basic_info/?sign="+url.QueryEscape(c.Sign), nil)
		if err != nil {
			return nil, err
		}
		classes, err := s.Catalog.Data(ctx, a, "GET", "/api/v1/lms/product/classroom/?sign="+url.QueryEscape(c.Sign), nil)
		if err != nil {
			return nil, err
		}
		pricing, err := s.Catalog.Data(ctx, a, "GET", fmt.Sprintf("/api/v1/lms/product/sku_pay_detail/?cid=%d&sign=%s", c.ClassroomID, url.QueryEscape(c.Sign)), nil)
		if err != nil {
			return nil, err
		}
		var offer enrollment.Offer
		if userTrial {
			offer, err = enrollment.SelectForUser(c, product, classes, pricing)
		} else {
			offer, err = enrollment.Select(c, product, classes, pricing)
		}
		if err != nil {
			return nil, err
		}
		_, sendErr := s.Effect(ctx, a, c, 0, "enrollment", "free", "POST", fmt.Sprintf("/api/v1/lms/order/entries_free_sku/%d/?sid=%d", offer.ProductID, offer.SKUID), wire.Object{})
		// A success response alone is insufficient, including a resumed posted record.
		_, err = s.Catalog.Authorize(ctx, a, c)
		if err == nil {
			return nil, s.confirmEnrollment(ctx, a, c, key)
		}
		if sendErr != nil {
			return nil, sendErr
		}
		return nil, fault.New("ENROLLMENT_REQUIRED", "免费加入尚未获得课程列表确认，请稍后继续回查")
	})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case r := <-result:
		return r.Err
	}
}
func (s *Service) confirmEnrollment(ctx context.Context, a domain.Account, c domain.Course, key string) error {
	r, err := s.Journal.Load(ctx, key, "enrollment", a, c, 0, 0, "free")
	if err != nil {
		return err
	}
	if r.State == "confirmed" {
		return nil
	}
	return s.Journal.Save(ctx, &r, "confirmed", r.Retries, false, wire.Object{"enrolled": true})
}
