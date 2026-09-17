package platform

import (
	"net/url"
	"regexp"
	"strconv"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
)

var coursePattern = regexp.MustCompile(`^/learn/space/([^/]+)/([^/]+)/([0-9]+)(?:/(?:video|article|discussion|exercise|exam)/[0-9]+)?/?$`)

func ParseCourse(value string) (domain.Course, error) {
	u, e := url.Parse(value)
	bad := fault.New("INVALID_INPUT", "请填写有效的学堂在线课程学习页 HTTPS 链接")
	if e != nil || u.Scheme != "https" || (u.Host != "www.xuetangx.com" && u.Host != "xuetangx.com") || u.User != nil {
		return domain.Course{}, bad
	}
	m := coursePattern.FindStringSubmatch(u.EscapedPath())
	if m == nil {
		return domain.Course{}, bad
	}
	id, e := strconv.ParseInt(m[3], 10, 64)
	if e != nil || id <= 0 || id > 9007199254740991 {
		return domain.Course{}, bad
	}
	sign, e := url.PathUnescape(m[1])
	if e != nil {
		return domain.Course{}, bad
	}
	other, e := url.PathUnescape(m[2])
	if e != nil {
		return domain.Course{}, bad
	}
	return domain.Course{ClassroomID: id, Sign: sign, CourseSign: other, URL: "https://www.xuetangx.com/learn/space/" + m[1] + "/" + m[2] + "/" + m[3]}, nil
}
