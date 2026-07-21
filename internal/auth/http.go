package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
)

const maximumAuthJSONBody = 64 << 10

type HTTPService interface {
	BeginLogin(context.Context, string, string, RequestMeta) (LoginChallenge, error)
	CompleteLogin(context.Context, CompleteLoginRequest) (LoginResult, error)
	StepUp(context.Context, string, string, RequestMeta) (AuthenticatedSession, error)
	Logout(context.Context, string, RequestMeta) error
}

func NewHandler(service HTTPService) http.Handler {
	router := chi.NewRouter()
	router.Post("/auth/login", beginLoginHTTP(service))
	router.Post("/auth/totp/verify", completeLoginHTTP(service))
	router.Post("/auth/step-up", stepUpHTTP(service))
	router.Post("/auth/logout", logoutHTTP(service))
	router.Get("/me", meHTTP)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		router.ServeHTTP(response, request)
	})
}

func beginLoginHTTP(service HTTPService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		meta, ok := RequestMetaFromContext(request.Context())
		if !ok {
			writeAuthError(response, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "认证服务暂时不可用")
			return
		}
		var payload struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := decodeAuthJSON(response, request, &payload); err != nil {
			writeAuthError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		challenge, err := service.BeginLogin(request.Context(), payload.Email, payload.Password, meta)
		payload.Email = ""
		payload.Password = ""
		if err != nil {
			writeAuthDomainError(response, err)
			return
		}
		writeAuthJSON(response, http.StatusOK, challenge)
	}
}

func completeLoginHTTP(service HTTPService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		meta, ok := RequestMetaFromContext(request.Context())
		if !ok {
			writeAuthError(response, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "认证服务暂时不可用")
			return
		}
		var payload struct {
			ChallengeID  string `json:"challenge_id"`
			TOTPCode     string `json:"totp_code"`
			RecoveryCode string `json:"recovery_code"`
		}
		if err := decodeAuthJSON(response, request, &payload); err != nil {
			writeAuthError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		result, err := service.CompleteLogin(request.Context(), CompleteLoginRequest{
			ChallengeID: payload.ChallengeID, TOTPCode: payload.TOTPCode, RecoveryCode: payload.RecoveryCode, Meta: meta,
		})
		payload.ChallengeID = ""
		payload.TOTPCode = ""
		payload.RecoveryCode = ""
		if err != nil {
			writeAuthDomainError(response, err)
			return
		}
		setSessionCookie(response, result.RawSessionToken, result.AbsoluteExpiresAt)
		writeAuthJSON(response, http.StatusOK, sessionDocument{
			CSRFToken: result.CSRFToken, Principal: result.Principal, DisplayName: result.DisplayName,
			AbsoluteExpiresAt: result.AbsoluteExpiresAt,
		})
	}
}

func stepUpHTTP(service HTTPService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		meta, metaOK := RequestMetaFromContext(request.Context())
		state, sessionOK := browserSessionFromContext(request.Context())
		if !metaOK || !sessionOK {
			writeAuthError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		var payload struct {
			TOTPCode string `json:"totp_code"`
		}
		if err := decodeAuthJSON(response, request, &payload); err != nil {
			writeAuthError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
			return
		}
		result, err := service.StepUp(request.Context(), state.rawToken, payload.TOTPCode, meta)
		payload.TOTPCode = ""
		if err != nil {
			writeAuthDomainError(response, err)
			return
		}
		writeAuthJSON(response, http.StatusOK, sessionDocument{
			CSRFToken: result.CSRFToken, Principal: result.Principal, DisplayName: result.DisplayName,
			AbsoluteExpiresAt: result.AbsoluteExpiresAt,
		})
	}
}

func logoutHTTP(service HTTPService) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		meta, metaOK := RequestMetaFromContext(request.Context())
		state, sessionOK := browserSessionFromContext(request.Context())
		if !metaOK || !sessionOK {
			clearSessionCookie(response)
			writeAuthError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
			return
		}
		err := service.Logout(request.Context(), state.rawToken, meta)
		clearSessionCookie(response)
		if err != nil && !errors.Is(err, ErrInvalidSession) {
			writeAuthDomainError(response, err)
			return
		}
		writeAuthJSON(response, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func meHTTP(response http.ResponseWriter, request *http.Request) {
	state, ok := browserSessionFromContext(request.Context())
	if !ok {
		writeAuthError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
		return
	}
	writeAuthJSON(response, http.StatusOK, sessionDocument{
		CSRFToken: state.session.CSRFToken, Principal: state.session.Principal, DisplayName: state.session.DisplayName,
		AbsoluteExpiresAt: state.session.AbsoluteExpiresAt,
	})
}

type sessionDocument struct {
	CSRFToken         string    `json:"csrf_token"`
	Principal         Principal `json:"administrator"`
	DisplayName       string    `json:"display_name"`
	AbsoluteExpiresAt time.Time `json:"absolute_expires_at"`
}

func decodeAuthJSON(response http.ResponseWriter, request *http.Request, target any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return ErrInvalidRequest
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximumAuthJSONBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrInvalidRequest
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ErrInvalidRequest
	}
	return nil
}

func writeAuthDomainError(response http.ResponseWriter, err error) {
	var rateLimit *RateLimitError
	switch {
	case errors.As(err, &rateLimit):
		seconds := int(math.Ceil(rateLimit.RetryAfter.Seconds()))
		if seconds < 1 {
			seconds = 1
		}
		if seconds > int(attemptWindow/time.Second) {
			seconds = int(attemptWindow / time.Second)
		}
		response.Header().Set("Retry-After", strconv.Itoa(seconds))
		writeAuthError(response, http.StatusTooManyRequests, "RATE_LIMITED", "尝试过于频繁，请稍后重试")
	case errors.Is(err, ErrInvalidCredentials):
		writeAuthError(response, http.StatusUnauthorized, "AUTH_INVALID_CREDENTIALS", "管理员凭证无效")
	case errors.Is(err, ErrInvalidSession):
		writeAuthError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
	case errors.Is(err, ErrInvalidRequest):
		writeAuthError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
	case errors.Is(err, ErrStepUpRequired):
		writeAuthError(response, http.StatusForbidden, "STEP_UP_REQUIRED", "此操作需要近期完成 TOTP 二次验证")
	default:
		writeAuthError(response, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE", "认证服务暂时不可用")
	}
}

func writeAuthError(response http.ResponseWriter, status int, code, message string) {
	writeAuthJSON(response, status, struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
}

func writeAuthJSON(response http.ResponseWriter, status int, document any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(document)
}

var _ HTTPService = (*Service)(nil)
