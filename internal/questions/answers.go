package questions

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

func Content(p domain.Problem) wire.Object { v, _ := wire.Decode(p.Content); return v }
func Kind(p domain.Problem) string {
	switch wire.String(Content(p)["Type"]) {
	case "SingleChoice":
		return "choice"
	case "MultipleChoice", "MultiChoice":
		return "multi"
	case "Judgement":
		return "judge"
	case "FillBlank":
		return "fill"
	}
	return "reference"
}
func BlankCount(p domain.Problem) int {
	c := Content(p)
	a := wire.Array(c["Blanks"])
	if len(a) == 0 {
		a = wire.Array(c["blanks"])
	}
	return len(a)
}
func Options(p domain.Problem) []wire.Object {
	out := []wire.Object{}
	for _, v := range wire.Array(Content(p)["Options"]) {
		out = append(out, wire.Obj(v))
	}
	return out
}
func Values(v any) []any {
	if v == nil {
		return nil
	}
	if a, ok := v.([]any); ok {
		return a
	}
	return []any{v}
}
func Extract(p domain.Problem, source wire.Object) (domain.Answer, bool) {
	a := domain.Answer{Type: Kind(p)}
	if source["is_show_answer"] != true {
		return a, false
	}
	values := Values(source["answer"])
	switch a.Type {
	case "choice", "multi":
		keys := map[string]bool{}
		for _, o := range Options(p) {
			keys[wire.String(o["key"])] = true
		}
		if len(values) == 0 || (a.Type == "choice" && len(values) != 1) {
			return a, false
		}
		seen := map[string]bool{}
		for _, v := range values {
			k := wire.String(v)
			if k == "" || !keys[k] {
				return a, false
			}
			if !seen[k] {
				a.Answers = append(a.Answers, k)
				seen[k] = true
			}
		}
		if a.Type == "choice" {
			a.Answer = a.Answers[0]
			a.Answers = nil
		} else {
			sort.Strings(a.Answers)
		}
	case "judge":
		if len(values) == 0 {
			return a, false
		}
		switch wire.String(values[0]) {
		case "true", "1", "正确":
			a.Answer = "正确"
		case "false", "0", "错误":
			a.Answer = "错误"
		default:
			return a, false
		}
	case "fill":
		m := wire.Obj(source["answers"])
		if len(m) == 0 || (BlankCount(p) > 0 && len(m) != BlankCount(p)) {
			return a, false
		}
		a.Accepted = map[string][]string{}
		for i := 1; i <= len(m); i++ {
			key := strconv.Itoa(i)
			list := Values(m[key])
			if len(list) == 0 {
				return a, false
			}
			for _, v := range list {
				s := wire.String(v)
				if s == "" {
					return a, false
				}
				a.Accepted[key] = append(a.Accepted[key], s)
			}
			a.Answers = append(a.Answers, a.Accepted[key][0])
		}
	default:
		return a, false
	}
	return a, true
}
func Body(a domain.Answer) wire.Object {
	if a.Type == "fill" {
		values := wire.Object{}
		for i, v := range a.Answers {
			values[strconv.Itoa(i+1)] = v
		}
		return wire.Object{"answer": "", "answers": values}
	}
	values := a.Answers
	if a.Type == "choice" {
		values = []string{a.Answer}
	}
	if a.Type == "judge" {
		s := "false"
		if a.Answer == "正确" {
			s = "true"
		}
		values = []string{s}
	}
	return wire.Object{"answer": values, "answers": wire.Object{}}
}
func Probe(p domain.Problem) (wire.Object, bool) {
	switch Kind(p) {
	case "choice", "multi":
		o := Options(p)
		if len(o) == 0 {
			return nil, false
		}
		return wire.Object{"answer": []string{wire.String(o[0]["key"])}, "answers": wire.Object{}}, true
	case "judge":
		return wire.Object{"answer": []string{"true"}, "answers": wire.Object{}}, true
	case "fill":
		n := BlankCount(p)
		if n < 1 {
			return nil, false
		}
		a := domain.Answer{Type: "fill", Answers: make([]string, n)}
		for i := range a.Answers {
			a.Answers[i] = "0"
		}
		return Body(a), true
	}
	return nil, false
}
func Count(p domain.Problem) (int64, error) {
	u, e := wire.Decode(p.User)
	if e != nil {
		return 0, e
	}
	n, valid := wire.Int(u["my_count"])
	if !valid || n < 0 {
		return 0, fmt.Errorf("缺少有效的作答次数")
	}
	return n, nil
}
func AnswerSource(a domain.Answer) wire.Object {
	source := wire.Object{"is_show_answer": true}
	if a.Type == "fill" {
		if len(a.Accepted) > 0 {
			source["answers"] = wire.ObjFromJSON(a.Accepted)
		} else {
			m := wire.Object{}
			for i, v := range a.Answers {
				m[strconv.Itoa(i+1)] = []any{v}
			}
			source["answers"] = m
		}
	} else if a.Type == "multi" {
		v := []any{}
		for _, s := range a.Answers {
			v = append(v, s)
		}
		source["answer"] = v
	} else {
		source["answer"] = a.Answer
	}
	return source
}
func DecodeProblems(raw any) ([]domain.Problem, error) {
	b, e := json.Marshal(raw)
	if e != nil {
		return nil, e
	}
	var result []domain.Problem
	e = json.Unmarshal(b, &result)
	if result == nil && e == nil {
		e = fmt.Errorf("无法识别习题列表")
	}
	return result, e
}
