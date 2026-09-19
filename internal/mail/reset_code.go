package mail

import (
	"bytes"
	_ "embed"
	"fmt"
	"html/template"
	"strings"
)

//go:embed templates/reset_code.html
var resetCodeHTML string

var resetCodeTemplate = template.Must(template.New("reset-code").Parse(resetCodeHTML))

// ResetCode renders the site's paper/ink/pixel branding without external
// images, SVG, fonts, scripts or tracking. Plain text remains a full fallback.
func ResetCode(code string) (subject, plain, html string, err error) {
	if len(code) != 6 || strings.IndexFunc(code, func(r rune) bool { return r < '0' || r > '9' }) != -1 {
		return "", "", "", fmt.Errorf("invalid reset code format")
	}
	var output bytes.Buffer
	err = resetCodeTemplate.Execute(&output, struct {
		Code  string
		Brand template.HTML
	}{code, pixelBrand()})
	if err != nil {
		return "", "", "", err
	}
	plain = "CCF · 密码重置\n\n你的验证码：" + code + "\n\n请回到 CCF 的找回密码页面输入验证码。\n10 分钟内有效，仅可使用一次。\n\n请勿将验证码分享给任何人。\n如果这不是你的操作，请忽略此邮件，你的密码不会改变。\n\nCCF · 账号安全通知\n此邮件由系统自动发送，无需回复。\n"
	return "CCF · 密码重置验证码", plain, output.String(), nil
}

// Use the same 5x7 glyphs and colors as web/src/shared/brand.js. Table cells
// work when mail clients strip SVG and external assets. Only fixed literals
// enter the trusted markup; no user-supplied HTML is accepted.
func pixelBrand() template.HTML {
	glyphs := []string{"01111/11000/11000/11000/11000/11000/01111", "01111/11000/11000/11000/11000/11000/01111", "11111/11000/11000/11110/11000/11000/11000"}
	colors := []string{"#ef5858", "#409bd3", "#e8ac20"}
	var b strings.Builder
	b.WriteString(`<table role="img" aria-label="CCF" cellpadding="0" cellspacing="0" border="0" width="133" style="width:133px;table-layout:fixed;border-collapse:collapse;">`)
	for y := 0; y < 7; y++ {
		b.WriteString("<tr>")
		for i, glyph := range glyphs {
			if i > 0 {
				b.WriteString(`<td width="14" height="7" style="width:14px;height:7px;padding:0;font-size:0;line-height:0;">&nbsp;</td>`)
			}
			for _, pixel := range strings.Split(glyph, "/")[y] {
				color := "#fdf1d6"
				if pixel == '1' {
					color = colors[i]
				}
				fmt.Fprintf(&b, `<td width="7" height="7" bgcolor="%s" style="width:7px;height:7px;padding:0;font-size:0;line-height:0;background-color:%s;">&nbsp;</td>`, color, color)
			}
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</table>")
	return template.HTML(b.String())
}
