//go:build !release

package webui

import (
	"embed"
	"io/fs"
)

//go:embed fallback/*
var developmentAssets embed.FS

func init() {
	embeddedAssets, _ = fs.Sub(developmentAssets, "fallback")
}
