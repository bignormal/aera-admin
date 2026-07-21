package webui

import (
	"io/fs"
	"net/http"
)

var embeddedAssets fs.FS

func EmbeddedHandler() http.Handler {
	return newAtRoot(embeddedAssets)
}
