package mail

import (
	"fmt"
	"html/template"
	"strings"
)

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
