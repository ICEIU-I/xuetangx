package fault

import "errors"

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string       { return e.Message }
func New(code, message string) error { return &Error{code, message} }
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return "INTERNAL_ERROR"
}
func Public(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Message
	}
	return "服务暂时不可用，请稍后重试"
}
