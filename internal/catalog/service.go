package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"net/url"
	"sort"
	"strconv"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/store"
)

type Request func(context.Context, domain.Account, string, string, any) (platform.Response, error)
type Service struct {
	DB      *store.Store
	Request Request
}

func (s *Service) Data(ctx context.Context, a domain.Account, method, path string, body any) (wire.Object, error) {
	r, e := s.Request(ctx, a, method, path, body)
	if e != nil {
		return nil, e
	}
	return r.Data()
}
func (s *Service) Courses(ctx context.Context, a domain.Account) ([]domain.Course, error) {
	out := []domain.Course{}
	seen := map[int64]bool{}
	pages := int64(1)
	for page := int64(1); page <= pages; page++ {
		d, e := s.Data(ctx, a, "GET", fmt.Sprintf("/api/v1/lms/user/user-courses/?status=1&page=%d", page), nil)
		if e != nil {
			return nil, e
		}
		list, ok := d["product_list"].([]any)
		if !ok {
			return nil, fault.New("REMOTE_ERROR", "课程列表格式无效")
		}
		if v, has := d["pages"]; has {
			var valid bool
			pages, valid = wire.Int(v)
			if !valid || pages < 0 || pages > 100 {
				return nil, fault.New("REMOTE_ERROR", "课程分页无效")
			}
		}
		for _, item := range list {
			v := wire.Obj(item)
			id, e := wire.ID(v["classroom_id"])
			if e != nil {
				return nil, e
			}
			sign, other := wire.String(v["sign"]), wire.String(v["course_sign"])
			if sign == "" || other == "" {
				return nil, fault.New("REMOTE_ERROR", "课程缺少标识")
			}
			if seen[id] {
				continue
			}
			seen[id] = true
			c := domain.Course{ClassroomID: id, Sign: sign, CourseSign: other, Title: wire.String(v["name"]), URL: fmt.Sprintf("%s/learn/space/%s/%s/%d", platform.Origin, url.PathEscape(sign), url.PathEscape(other), id)}
			e = s.DB.Pool.QueryRow(ctx, `INSERT INTO courses(id,classroom_id,sign,course_sign,title,url) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(classroom_id) DO UPDATE SET sign=excluded.sign,course_sign=excluded.course_sign,title=excluded.title,url=excluded.url,updated_at=now() RETURNING id`, uuid.NewString(), id, sign, other, c.Title, c.URL).Scan(&c.ID)
			if e != nil {
				return nil, e
			}
			if _, e = s.DB.Pool.Exec(ctx, `INSERT INTO account_courses(account_id,course_id) VALUES($1,$2) ON CONFLICT(account_id,course_id) DO UPDATE SET checked_at=now()`, a.ID, c.ID); e != nil {
				return nil, e
			}
			out = append(out, c)
		}
	}
	return out, nil
}
func (s *Service) Authorize(ctx context.Context, a domain.Account, target domain.Course) (domain.Course, error) {
	courses, e := s.Courses(ctx, a)
	if e != nil {
		return domain.Course{}, e
	}
	for _, c := range courses {
		if c.ClassroomID == target.ClassroomID && (target.Sign == "" || c.Sign == target.Sign) && (target.CourseSign == "" || c.CourseSign == target.CourseSign) {
			return c, nil
		}
	}
	return domain.Course{}, fault.New("ENROLLMENT_REQUIRED", "请先在平台加入同一课程班级")
}
func (s *Service) Discover(ctx context.Context, a domain.Account, courseURL string) (domain.Inventory, error) {
	target, e := platform.ParseCourse(courseURL)
	if e != nil {
		return domain.Inventory{}, e
	}
	c, e := s.Authorize(ctx, a, target)
	if e != nil {
		return domain.Inventory{}, e
	}
	inv := domain.Inventory{Course: c, Units: []domain.Unit{}, Exercises: []domain.Exercise{}}
	q := url.Values{"cid": {strconv.FormatInt(c.ClassroomID, 10)}, "sign": {c.Sign}}.Encode()
	directory, e := s.Data(ctx, a, "GET", "/api/v1/lms/learn/course/chapter?"+q, nil)
	if e != nil {
		return inv, e
	}
	if _, ok := directory["course_chapter"].([]any); !ok {
		return inv, fault.New("REMOTE_ERROR", "课程目录格式无效")
	}
	schedule, e := s.Data(ctx, a, "GET", "/api/v1/lms/learn/course/schedule?"+q, nil)
	if e != nil {
		return inv, e
	}
	if schedule["leaf_schedules"] == nil {
		return inv, fault.New("REMOTE_ERROR", "课程进度格式无效")
	}
	progress := wire.Obj(schedule["leaf_schedules"])
	found := map[int64]bool{}
	var visit func(any) error
	visit = func(node any) error {
		switch n := node.(type) {
		case []any:
			for _, v := range n {
				if e := visit(v); e != nil {
					return e
				}
			}
		case map[string]any:
			if typ, ok := wire.Int(n["leaf_type"]); ok {
				kind := map[int64]string{0: "video", 3: "article", 4: "discussion", 5: "homework", 6: "homework"}[typ]
				if kind != "" {
					id, e := wire.ID(n["id"])
					if e != nil {
						return e
					}
					if !found[id] {
						p, _ := wire.Number(progress[strconv.FormatInt(id, 10)])
						inv.Units = append(inv.Units, domain.Unit{ID: id, Kind: kind, LeafType: int(typ), Title: wire.String(n["name"]), Progress: p, Locked: wire.Truthy(n["is_locked"])})
						found[id] = true
					}
				}
			}
			for _, v := range n {
				if e := visit(v); e != nil {
					return e
				}
			}
		}
		return nil
	}
	if e = visit(directory["course_chapter"]); e != nil {
		return inv, e
	}
	sort.Slice(inv.Units, func(i, j int) bool { return inv.Units[i].ID < inv.Units[j].ID })
	for _, u := range inv.Units {
		var unitID string
		e = s.DB.Pool.QueryRow(ctx, `INSERT INTO course_units(id,course_id,leaf_id,kind,leaf_type,title) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(course_id,leaf_id) DO UPDATE SET title=excluded.title,kind=excluded.kind,leaf_type=excluded.leaf_type,active=true RETURNING id`, uuid.NewString(), c.ID, u.ID, u.Kind, u.LeafType, u.Title).Scan(&unitID)
		if e != nil {
			return inv, e
		}
		if _, e = s.DB.Pool.Exec(ctx, `INSERT INTO account_unit_states(account_id,unit_id,progress,locked) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,unit_id) DO UPDATE SET progress=excluded.progress,locked=excluded.locked,checked_at=now()`, a.ID, unitID, u.Progress, u.Locked); e != nil {
			return inv, e
		}
	}
	return inv, nil
}
func (s *Service) Exercises(ctx context.Context, a domain.Account, inv *domain.Inventory) error {
	for _, u := range inv.Units {
		if u.Kind != "homework" {
			continue
		}
		ex, e := s.Exercise(ctx, a, inv.Course, u)
		if e != nil {
			if ctx.Err() != nil || fault.Code(e) == "ACCOUNT_REQUIRED" || fault.Code(e) == "ACCESS_DENIED" {
				return e
			}
			ex.Error = fault.Public(e)
		}
		inv.Exercises = append(inv.Exercises, ex)
	}
	return nil
}
func (s *Service) Exercise(ctx context.Context, a domain.Account, c domain.Course, u domain.Unit) (domain.Exercise, error) {
	ex := domain.Exercise{LeafID: u.ID, Title: u.Title, Problems: []domain.Problem{}}
	leaf, e := s.Leaf(ctx, a, c, u)
	if e != nil {
		return ex, e
	}
	ex.ExerciseID, e = wire.ID(wire.Obj(leaf["content_info"])["leaf_type_id"])
	if e != nil {
		return ex, e
	}
	ex.SKUID, e = wire.ID(leaf["sku_id"])
	if e != nil {
		return ex, e
	}
	ex.Problems, e = s.Problems(ctx, a, ex)
	return ex, e
}
func (s *Service) Problems(ctx context.Context, a domain.Account, ex domain.Exercise) ([]domain.Problem, error) {
	r, e := s.Request(ctx, a, "GET", fmt.Sprintf("/api/v1/lms/exercise/get_exercise_list/%d/%d/", ex.ExerciseID, ex.SKUID), nil)
	if e != nil {
		return nil, e
	}
	d, e := r.Data()
	if e != nil {
		return nil, e
	}
	var envelope struct {
		Data struct {
			Problems []domain.Problem `json:"problems"`
		} `json:"data"`
	}
	if len(r.Raw) > 0 {
		e = json.Unmarshal(r.Raw, &envelope)
	} else {
		e = json.Unmarshal(wire.JSON(d["problems"]), &envelope.Data.Problems)
	}
	if e != nil || envelope.Data.Problems == nil {
		return nil, fault.New("REMOTE_ERROR", "无法识别习题列表")
	}
	for _, p := range envelope.Data.Problems {
		content, _ := wire.Decode(p.Content)
		if p.ID <= 0 || wire.String(content["Type"]) == "" {
			return nil, fault.New("REMOTE_ERROR", "题目参数缺失")
		}
	}
	return envelope.Data.Problems, nil
}
func (s *Service) Leaf(ctx context.Context, a domain.Account, c domain.Course, u domain.Unit) (wire.Object, error) {
	d, e := s.Data(ctx, a, "GET", fmt.Sprintf("/api/v1/lms/learn/leaf_info/%d/%d/?sign=%s", c.ClassroomID, u.ID, url.QueryEscape(c.Sign)), nil)
	if e != nil {
		return nil, e
	}
	id, _ := wire.Int(d["id"])
	cid, _ := wire.Int(d["classroom_id"])
	typ, _ := wire.Int(d["leaf_type"])
	if id != u.ID || cid != c.ClassroomID || int(typ) != u.LeafType {
		return nil, fault.New("INVALID_METADATA", "学习单元与课程不匹配")
	}
	for _, k := range []string{"is_deleted", "is_locked", "locked_reason", "upgrade_sku_id"} {
		if wire.Truthy(d[k]) {
			return nil, fault.New("LOCKED", "学习单元未开放或无权访问")
		}
	}
	return d, nil
}
