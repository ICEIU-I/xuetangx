package mail

import (
	"bytes"
	_ "embed"
	"fmt"
	"html/template"
	"strings"
)

//go:embed templates/verification_code.html
var verificationHTML string
var verificationTemplate = template.Must(template.New("verification-code").Parse(verificationHTML))

type codeMessage struct {
	Subject, Preheader, Eyebrow, Heading, Intro, Instruction, Notice, Code string
	Brand                                                                  template.HTML
}

func ResetCode(code string) (string, string, string, error) {
	return renderCode(code, codeMessage{Subject: "CCF · 密码重置验证码", Preheader: "你的 CCF 密码重置验证码已准备好，10 分钟内有效。请勿向他人分享。", Eyebrow: "PASSWORD RESET", Heading: "重置你的密码", Intro: "你正在重置 CCF 账号密码。", Instruction: "请回到刚才的页面，输入下方验证码。", Notice: "如果这不是你的操作，请忽略此邮件，你的密码不会改变。"})
}
func RegistrationCode(code string) (string, string, string, error) {
	return renderCode(code, codeMessage{Subject: "CCF · 注册验证码", Preheader: "你的 CCF 注册验证码已准备好，10 分钟内有效。请勿向他人分享。", Eyebrow: "VERIFY YOUR EMAIL", Heading: "验证你的邮箱", Intro: "你正在注册 CCF 账号。", Instruction: "请回到注册页面，输入下方验证码。", Notice: "如果这不是你的操作，请忽略此邮件。只有完成注册后才会创建账号。"})
}
func renderCode(code string, data codeMessage) (string, string, string, error) {
	if len(code) != 6 || strings.IndexFunc(code, func(r rune) bool { return r < '0' || r > '9' }) != -1 {
		return "", "", "", fmt.Errorf("invalid verification code format")
	}
	data.Code = code
	data.Brand = pixelBrand()
	var output bytes.Buffer
	if err := verificationTemplate.Execute(&output, data); err != nil {
		return "", "", "", err
	}
	plain := data.Subject + "\n\n你的验证码：" + code + "\n\n" + data.Intro + "\n" + data.Instruction + "\n10 分钟内有效，仅可使用一次。\n\n请勿将验证码分享给任何人。\n" + data.Notice + "\n\nCCF · 账号安全通知\n此邮件由系统自动发送，无需回复。\n"
	return data.Subject, plain, output.String(), nil
}
