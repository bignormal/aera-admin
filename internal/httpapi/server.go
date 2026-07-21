package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

const readinessTimeout = 2 * time.Second

type HealthChecker interface {
	Ping(context.Context) error
}

type Dependencies struct {
	PostgreSQL HealthChecker
	Redis      HealthChecker
	API        http.Handler
	Web        http.Handler
	Production bool
}

func New(dependencies Dependencies) http.Handler {
	router := chi.NewRouter()
	router.Get("/health/live", func(response http.ResponseWriter, _ *http.Request) {
		writeStatus(response, http.StatusOK, "ok")
	})
	router.Get("/health/ready", func(response http.ResponseWriter, request *http.Request) {
		if dependencies.PostgreSQL == nil || dependencies.Redis == nil {
			writeStatus(response, http.StatusServiceUnavailable, "unavailable")
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), readinessTimeout)
		defer cancel()
		if dependencies.PostgreSQL.Ping(ctx) != nil || dependencies.Redis.Ping(ctx) != nil {
			writeStatus(response, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeStatus(response, http.StatusOK, "ok")
	})
	if dependencies.API != nil {
		router.Mount("/api/v1", http.StripPrefix("/api/v1", dependencies.API))
	}
	router.NotFound(func(response http.ResponseWriter, request *http.Request) {
		if dependencies.Web == nil || servicePath(request.URL.Path) {
			http.NotFound(response, request)
			return
		}
		dependencies.Web.ServeHTTP(response, request)
	})
	return securityHeaders(dependencies.Production, router)
}

func securityHeaders(production bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:")
		response.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		response.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		response.Header().Set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()")
		response.Header().Set("Referrer-Policy", "no-referrer")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("X-Frame-Options", "DENY")
		if production {
			response.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(response, request)
	})
}

func servicePath(raw string) bool {
	trimmed := strings.TrimPrefix(raw, "/")
	first, _, _ := strings.Cut(trimmed, "/")
	return first == "api" || first == "health"
}

func writeStatus(response http.ResponseWriter, statusCode int, status string) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(statusCode)
	_ = json.NewEncoder(response).Encode(map[string]string{"status": status})
}
