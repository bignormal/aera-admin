//go:build release

package webui

import (
	"embed"
	"io/fs"
)

//go:embed dist/*
var releaseAssets embed.FS

func init() {
	embeddedAssets, _ = fs.Sub(releaseAssets, "dist")
}
