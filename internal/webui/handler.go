package webui

import (
	"bytes"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

const immutableCache = "public, max-age=31536000, immutable"

type handler struct {
	files     fs.FS
	indexHTML []byte
	err       error
}

func New(files fs.FS) http.Handler {
	if files == nil {
		return &handler{err: errors.New("web assets are unavailable")}
	}
	dist, err := fs.Sub(files, "dist")
	if err != nil {
		return &handler{err: errors.New("web asset root is unavailable")}
	}
	return newAtRoot(dist)
}

func newAtRoot(files fs.FS) http.Handler {
	indexHTML, err := fs.ReadFile(files, "index.html")
	if err != nil {
		return &handler{err: errors.New("web index is unavailable")}
	}
	return &handler{files: files, indexHTML: indexHTML}
}

func (h *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", "GET, HEAD")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h == nil || h.err != nil || h.files == nil {
		http.Error(response, "web interface unavailable", http.StatusServiceUnavailable)
		return
	}
	cleaned := path.Clean("/" + request.URL.Path)
	if strings.HasPrefix(cleaned, "/assets/") {
		h.serveAsset(response, request, strings.TrimPrefix(cleaned, "/"))
		return
	}
	if path.Ext(cleaned) != "" {
		http.NotFound(response, request)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeContent(response, request, "index.html", time.Time{}, bytes.NewReader(h.indexHTML))
}

func (h *handler) serveAsset(response http.ResponseWriter, request *http.Request, name string) {
	info, err := fs.Stat(h.files, name)
	if err != nil || info.IsDir() {
		http.NotFound(response, request)
		return
	}
	content, err := fs.ReadFile(h.files, name)
	if err != nil {
		http.Error(response, "web asset unavailable", http.StatusServiceUnavailable)
		return
	}
	response.Header().Set("Cache-Control", immutableCache)
	if mediaType := mime.TypeByExtension(path.Ext(name)); mediaType != "" {
		response.Header().Set("Content-Type", mediaType)
	}
	http.ServeContent(response, request, path.Base(name), info.ModTime(), bytes.NewReader(content))
}
