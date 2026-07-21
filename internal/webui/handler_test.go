package webui

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestHandlerServesIndexForClientRoute(t *testing.T) {
	handler := New(testAssets())
	response := request(handler, http.MethodGet, "/dashboard")
	if response.Code != http.StatusOK || response.Body.String() != "<!doctype html><title>Aera Admin</title>" {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/html") {
		t.Fatalf("Content-Type = %q", contentType)
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("Cache-Control = %q", cacheControl)
	}
}

func TestHandlerServesBuiltAssetsWithImmutableCache(t *testing.T) {
	handler := New(testAssets())
	response := request(handler, http.MethodGet, "/assets/app-a1b2c3.js")
	if response.Code != http.StatusOK || response.Body.String() != "console.log('aera')" {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", cacheControl)
	}
}

func TestHandlerDoesNotFallbackForMissingAsset(t *testing.T) {
	response := request(New(testAssets()), http.MethodGet, "/assets/missing.js")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", response.Code)
	}
}

func TestHandlerRejectsStateChangingMethods(t *testing.T) {
	response := request(New(testAssets()), http.MethodPost, "/dashboard")
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", response.Code)
	}
}

func testAssets() fs.FS {
	return fstest.MapFS{
		"dist/index.html":           {Data: []byte("<!doctype html><title>Aera Admin</title>")},
		"dist/assets/app-a1b2c3.js": {Data: []byte("console.log('aera')")},
	}
}

func request(handler http.Handler, method, path string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
