package webassets

import (
	"embed"
	"io/fs"
)

//go:embed all:assets
var embedded embed.FS

func FS() (fs.FS, error) {
	assets, e := fs.Sub(embedded, "assets")
	if e != nil {
		return nil, e
	}
	if _, e = fs.Stat(assets, "index.html"); e != nil {
		return nil, e
	}
	return assets, nil
}
