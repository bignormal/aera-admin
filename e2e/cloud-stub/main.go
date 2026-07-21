//go:build e2e

package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const (
	cloudAudience       = "aera-cloud-admin"
	cloudIssuer         = "aera-admin"
	cloudSubject        = "aera-admin-e2e"
	maximumRequestBytes = 64 << 10
)

var (
	fixedUserID    = uuid.MustParse("019f0000-0000-7000-8000-000000000071")
	fixedDeviceID  = uuid.MustParse("019f0000-0000-7000-8000-000000000072")
	fixedSessionID = uuid.MustParse("019f0000-0000-7000-8000-000000000073")
)

type operationRecord struct {
	ID               uuid.UUID
	Action           string
	TargetID         uuid.UUID
	ExpectedRevision int64
	Revision         int64
	Status           string
	UpdatedAt        time.Time
}

type state struct {
	mu                sync.Mutex
	userID            uuid.UUID
	deviceID          uuid.UUID
	sessionID         uuid.UUID
	rawLookupIdentity string
	userStatus        string
	revision          int64
	deviceRevoked     bool
	sessionRevoked    bool
	operations        map[uuid.UUID]operationRecord
}

func newState() *state {
	return &state{
		userID:            fixedUserID,
		deviceID:          fixedDeviceID,
		sessionID:         fixedSessionID,
		rawLookupIdentity: "cloud.lookup.canary@example.test",
		userStatus:        "active",
		revision:          1,
		operations:        make(map[uuid.UUID]operationRecord),
	}
}

type serviceClaims struct {
	Issuer    string   `json:"iss"`
	Subject   string   `json:"sub"`
	Audience  string   `json:"aud"`
	Scopes    []string `json:"scope"`
	IssuedAt  int64    `json:"iat"`
	NotBefore int64    `json:"nbf"`
	ExpiresAt int64    `json:"exp"`
	JWTID     string   `json:"jti"`
}

type claimsContextKey struct{}
type requestIDContextKey struct{}

type cloudServer struct {
	state     *state
	publicKey ed25519.PublicKey
	logger    *slog.Logger
}

type responseRecorder struct {
	http.ResponseWriter
	status int
}

func (recorder *responseRecorder) WriteHeader(status int) {
	if recorder.status != 0 {
		return
	}
	recorder.status = status
	recorder.ResponseWriter.WriteHeader(status)
}

func (recorder *responseRecorder) Write(body []byte) (int, error) {
	if recorder.status == 0 {
		recorder.WriteHeader(http.StatusOK)
	}
	return recorder.ResponseWriter.Write(body)
}

func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "Aera Admin E2E Cloud process failed: %s\n", err)
		os.Exit(1)
	}
}

func run() error {
	address, err := requiredEnvironment("AERA_ADMIN_E2E_CLOUD_LISTEN_ADDR")
	if err != nil {
		return err
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("Cloud listen address must be loopback")
	}
	caFile, err := requiredAbsoluteFile("AERA_ADMIN_E2E_CLOUD_CA_FILE")
	if err != nil {
		return err
	}
	certificateFile, err := requiredAbsoluteFile("AERA_ADMIN_E2E_CLOUD_CERT_FILE")
	if err != nil {
		return err
	}
	keyFile, err := requiredAbsoluteFile("AERA_ADMIN_E2E_CLOUD_KEY_FILE")
	if err != nil {
		return err
	}
	publicKeyFile, err := requiredAbsoluteFile("AERA_ADMIN_E2E_CLOUD_JWT_PUBLIC_KEY_FILE")
	if err != nil {
		return err
	}

	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return errors.New("read Cloud test CA")
	}
	clientRoots := x509.NewCertPool()
	if !clientRoots.AppendCertsFromPEM(caPEM) {
		return errors.New("parse Cloud test CA")
	}
	certificate, err := tls.LoadX509KeyPair(certificateFile, keyFile)
	if err != nil {
		return errors.New("load Cloud server identity")
	}
	publicKey, err := readPublicKey(publicKeyFile)
	if err != nil {
		return err
	}

	service := &cloudServer{
		state:     newState(),
		publicKey: publicKey,
		logger:    slog.New(slog.NewJSONHandler(os.Stdout, nil)),
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return errors.New("listen for Cloud E2E requests")
	}
	server := &http.Server{
		Addr:              address,
		Handler:           service.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          log.New(io.Discard, "", 0),
		TLSConfig: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			Certificates: []tls.Certificate{certificate},
			ClientAuth:   tls.RequireAndVerifyClientCert,
			ClientCAs:    clientRoots,
		},
	}
	return server.Serve(tls.NewListener(listener, server.TLSConfig))
}

func requiredEnvironment(name string) (string, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" || strings.TrimSpace(value) != value {
		return "", errors.New("required Cloud E2E environment is missing")
	}
	return value, nil
}

func requiredAbsoluteFile(name string) (string, error) {
	value, err := requiredEnvironment(name)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return "", errors.New("Cloud E2E file path is invalid")
	}
	return value, nil
}

func readPublicKey(path string) (ed25519.PublicKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("read Cloud service public key")
	}
	block, rest := pem.Decode(raw)
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("Cloud service public key PEM is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, errors.New("Cloud service public key is invalid")
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("Cloud service public key must be Ed25519")
	}
	return append(ed25519.PublicKey(nil), publicKey...), nil
}

func (server *cloudServer) routes() http.Handler {
	router := chi.NewRouter()
	router.Use(server.logRequest)
	router.Use(server.authenticate)
	router.With(server.requireScope("users:read")).Get("/internal/admin/v1/health", server.health)
	router.With(server.requireScope("users:read")).Get("/internal/admin/v1/users", server.listUsers)
	router.With(server.requireScope("users:read")).Post("/internal/admin/v1/users/lookup", server.lookupUser)
	router.With(server.requireScope("users:read")).Get("/internal/admin/v1/users/{userID}", server.getUser)
	router.With(server.requireScope("users:read")).Get("/internal/admin/v1/users/{userID}/devices", server.listDevices)
	router.With(server.requireScope("users:read")).Get("/internal/admin/v1/users/{userID}/sessions", server.listSessions)
	router.With(server.requireScope("devices:write")).Post("/internal/admin/v1/devices/{deviceID}/revoke", server.revokeDevice)
	router.With(server.requireScope("sessions:write")).Post("/internal/admin/v1/sessions/{sessionID}/revoke", server.revokeSession)
	router.With(server.requireScope("accounts:write")).Post("/internal/admin/v1/users/{userID}/disable", server.disableUser)
	router.With(server.requireScope("accounts:write")).Post("/internal/admin/v1/users/{userID}/enable", server.enableUser)
	router.With(server.requireScope("operations:read")).Get("/internal/admin/v1/operations/{operationID}", server.getOperation)
	return router
}

func (server *cloudServer) logRequest(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestID := "cloud-" + uuid.NewString()
		request = request.WithContext(context.WithValue(request.Context(), requestIDContextKey{}, requestID))
		recorder := &responseRecorder{ResponseWriter: response}
		next.ServeHTTP(recorder, request)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		route := chi.RouteContext(request.Context()).RoutePattern()
		if route == "" {
			route = "unmatched"
		}
		server.logger.Info(
			"request",
			"method", request.Method,
			"route", route,
			"status", status,
			"request_id", requestID,
		)
	})
}

func (server *cloudServer) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.TLS == nil || len(request.TLS.PeerCertificates) == 0 {
			writeError(response, http.StatusUnauthorized, "SERVICE_IDENTITY_REQUIRED")
			return
		}
		authorization := request.Header.Get("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") || strings.Count(authorization, " ") != 1 {
			writeError(response, http.StatusUnauthorized, "SERVICE_TOKEN_INVALID")
			return
		}
		claims, err := verifyToken(server.publicKey, strings.TrimPrefix(authorization, "Bearer "), time.Now().UTC())
		if err != nil {
			writeError(response, http.StatusUnauthorized, "SERVICE_TOKEN_INVALID")
			return
		}
		next.ServeHTTP(response, request.WithContext(context.WithValue(request.Context(), claimsContextKey{}, claims)))
	})
}

func (server *cloudServer) requireScope(scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			claims, ok := request.Context().Value(claimsContextKey{}).(serviceClaims)
			if !ok || !contains(claims.Scopes, scope) {
				writeError(response, http.StatusForbidden, "SERVICE_SCOPE_REQUIRED")
				return
			}
			next.ServeHTTP(response, request)
		})
	}
}

func verifyToken(publicKey ed25519.PublicKey, token string, now time.Time) (serviceClaims, error) {
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		return serviceClaims{}, errors.New("invalid JWT segments")
	}
	signed := segments[0] + "." + segments[1]
	signature, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil || !ed25519.Verify(publicKey, []byte(signed), signature) {
		return serviceClaims{}, errors.New("invalid JWT signature")
	}
	headerRaw, err := base64.RawURLEncoding.DecodeString(segments[0])
	if err != nil {
		return serviceClaims{}, errors.New("invalid JWT header")
	}
	var header struct {
		Algorithm string `json:"alg"`
		Type      string `json:"typ"`
	}
	if decodeStrictBytes(headerRaw, &header) != nil || header.Algorithm != "EdDSA" || header.Type != "JWT" {
		return serviceClaims{}, errors.New("invalid JWT header")
	}
	claimsRaw, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return serviceClaims{}, errors.New("invalid JWT claims")
	}
	var claims serviceClaims
	if decodeStrictBytes(claimsRaw, &claims) != nil ||
		claims.Issuer != cloudIssuer || claims.Subject != cloudSubject || claims.Audience != cloudAudience ||
		claims.JWTID == "" || len(claims.JWTID) > 128 || len(claims.Scopes) == 0 ||
		claims.NotBefore > now.Unix() || claims.ExpiresAt <= now.Unix() || claims.ExpiresAt-claims.IssuedAt > 300 {
		return serviceClaims{}, errors.New("invalid JWT claims")
	}
	return claims, nil
}

func decodeStrictBytes(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func (server *cloudServer) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

type userDocument struct {
	UserID                   uuid.UUID `json:"user_id"`
	MaskedEmail              string    `json:"masked_email"`
	Status                   string    `json:"status"`
	AdministrativelyDisabled bool      `json:"administratively_disabled"`
	AdministrativeRevision   int64     `json:"administrative_revision"`
	DeviceCount              int       `json:"device_count"`
	ActiveDeviceCount        int       `json:"active_device_count"`
	ActiveSessionCount       int       `json:"active_session_count"`
	CreatedAt                string    `json:"created_at"`
	LastCloudActivityAt      string    `json:"last_cloud_activity_at"`
}

func (current *state) userDocumentLocked() userDocument {
	activeDevices := 1
	if current.deviceRevoked {
		activeDevices = 0
	}
	activeSessions := 1
	if current.sessionRevoked {
		activeSessions = 0
	}
	return userDocument{
		UserID:                   current.userID,
		MaskedEmail:              "c***@example.test",
		Status:                   current.userStatus,
		AdministrativelyDisabled: current.userStatus == "disabled",
		AdministrativeRevision:   current.revision,
		DeviceCount:              1,
		ActiveDeviceCount:        activeDevices,
		ActiveSessionCount:       activeSessions,
		CreatedAt:                "2026-07-22T08:00:00Z",
		LastCloudActivityAt:      "2026-07-22T08:05:00Z",
	}
}

func (server *cloudServer) listUsers(response http.ResponseWriter, request *http.Request) {
	if !validPageQuery(request) {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	server.state.mu.Lock()
	defer server.state.mu.Unlock()
	items := make([]userDocument, 0, 1)
	status := request.URL.Query().Get("status")
	if status == "" || status == server.state.userStatus {
		items = append(items, server.state.userDocumentLocked())
	}
	writeJSON(response, http.StatusOK, struct {
		Items []userDocument `json:"items"`
	}{Items: items})
}

func (server *cloudServer) lookupUser(response http.ResponseWriter, request *http.Request) {
	var input struct {
		Type  string `json:"type"`
		Value string `json:"value"`
	}
	if decodeRequest(response, request, &input) != nil || input.Type != "email" {
		input.Value = ""
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	server.state.mu.Lock()
	matched := input.Value == server.state.rawLookupIdentity
	input.Value = ""
	if !matched {
		server.state.mu.Unlock()
		writeError(response, http.StatusNotFound, "USER_NOT_FOUND")
		return
	}
	document := server.state.userDocumentLocked()
	server.state.mu.Unlock()
	writeJSON(response, http.StatusOK, document)
}

func (server *cloudServer) getUser(response http.ResponseWriter, request *http.Request) {
	if chi.URLParam(request, "userID") != server.state.userID.String() {
		writeError(response, http.StatusNotFound, "USER_NOT_FOUND")
		return
	}
	server.state.mu.Lock()
	document := server.state.userDocumentLocked()
	server.state.mu.Unlock()
	writeJSON(response, http.StatusOK, document)
}

func (server *cloudServer) listDevices(response http.ResponseWriter, request *http.Request) {
	if chi.URLParam(request, "userID") != server.state.userID.String() || !validPageQuery(request) {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	server.state.mu.Lock()
	status := "active"
	if server.state.deviceRevoked {
		status = "revoked"
	}
	server.state.mu.Unlock()
	writeJSON(response, http.StatusOK, map[string]any{"items": []any{map[string]any{
		"device_id": server.state.deviceID, "user_id": server.state.userID,
		"display_name": "E2E macOS 设备", "platform": "macOS", "client_version": "1.0.0",
		"status": status, "last_seen_at": "2026-07-22T08:04:00Z",
	}}})
}

func (server *cloudServer) listSessions(response http.ResponseWriter, request *http.Request) {
	if chi.URLParam(request, "userID") != server.state.userID.String() || !validPageQuery(request) {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	server.state.mu.Lock()
	status := "active"
	document := map[string]any{
		"session_id": server.state.sessionID, "user_id": server.state.userID,
		"device_id": server.state.deviceID, "issued_at": "2026-07-22T08:00:00Z",
		"expires_at": "2026-07-23T08:00:00Z",
	}
	if server.state.sessionRevoked {
		status = "revoked"
		document["revoked_at"] = "2026-07-22T08:05:00Z"
	}
	document["status"] = status
	server.state.mu.Unlock()
	writeJSON(response, http.StatusOK, map[string]any{"items": []any{document}})
}

type commandPayload struct {
	OperationID      uuid.UUID  `json:"operation_id"`
	ActorAdminID     uuid.UUID  `json:"actor_admin_id"`
	ApprovalID       *uuid.UUID `json:"approval_id,omitempty"`
	RequestID        string     `json:"request_id"`
	ReasonCode       string     `json:"reason_code"`
	TicketReference  string     `json:"ticket_reference,omitempty"`
	Note             string     `json:"note,omitempty"`
	ExpectedRevision int64      `json:"expected_revision"`
}

func (server *cloudServer) revokeDevice(response http.ResponseWriter, request *http.Request) {
	server.command(response, request, "revoke_device", chi.URLParam(request, "deviceID"), server.state.deviceID)
}

func (server *cloudServer) revokeSession(response http.ResponseWriter, request *http.Request) {
	server.command(response, request, "revoke_session", chi.URLParam(request, "sessionID"), server.state.sessionID)
}

func (server *cloudServer) disableUser(response http.ResponseWriter, request *http.Request) {
	server.command(response, request, "disable_user", chi.URLParam(request, "userID"), server.state.userID)
}

func (server *cloudServer) enableUser(response http.ResponseWriter, request *http.Request) {
	server.command(response, request, "enable_user", chi.URLParam(request, "userID"), server.state.userID)
}

func (server *cloudServer) command(
	response http.ResponseWriter,
	request *http.Request,
	action string,
	rawTargetID string,
	expectedTargetID uuid.UUID,
) {
	var input commandPayload
	if decodeRequest(response, request, &input) != nil || rawTargetID != expectedTargetID.String() ||
		input.OperationID == uuid.Nil || input.ActorAdminID == uuid.Nil || input.RequestID == "" ||
		len(input.RequestID) > 128 || input.ReasonCode == "" || input.ExpectedRevision < 1 ||
		request.Header.Get("Idempotency-Key") != input.OperationID.String() {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	server.state.mu.Lock()
	defer server.state.mu.Unlock()
	if existing, ok := server.state.operations[input.OperationID]; ok {
		if existing.Action != action || existing.TargetID != expectedTargetID ||
			existing.ExpectedRevision != input.ExpectedRevision {
			writeError(response, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED")
			return
		}
		writeJSON(response, http.StatusAccepted, operationDocument(existing))
		return
	}
	if input.ExpectedRevision != server.state.revision {
		writeError(response, http.StatusConflict, "USER_STATE_CONFLICT")
		return
	}
	switch action {
	case "revoke_device":
		if server.state.deviceRevoked {
			writeError(response, http.StatusConflict, "DEVICE_STATE_CONFLICT")
			return
		}
		server.state.deviceRevoked = true
	case "revoke_session":
		if server.state.sessionRevoked {
			writeError(response, http.StatusConflict, "SESSION_STATE_CONFLICT")
			return
		}
		server.state.sessionRevoked = true
	case "disable_user":
		if server.state.userStatus != "active" {
			writeError(response, http.StatusConflict, "USER_STATE_CONFLICT")
			return
		}
		server.state.userStatus = "disabled"
	case "enable_user":
		if server.state.userStatus != "disabled" {
			writeError(response, http.StatusConflict, "USER_STATE_CONFLICT")
			return
		}
		server.state.userStatus = "active"
	default:
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	server.state.revision++
	record := operationRecord{
		ID: input.OperationID, Action: action, TargetID: expectedTargetID,
		ExpectedRevision: input.ExpectedRevision, Revision: server.state.revision,
		Status: "succeeded", UpdatedAt: time.Now().UTC(),
	}
	server.state.operations[input.OperationID] = record
	writeJSON(response, http.StatusAccepted, operationDocument(record))
}

func (server *cloudServer) getOperation(response http.ResponseWriter, request *http.Request) {
	id, err := uuid.Parse(chi.URLParam(request, "operationID"))
	if err != nil || id == uuid.Nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	server.state.mu.Lock()
	record, ok := server.state.operations[id]
	server.state.mu.Unlock()
	if !ok {
		writeError(response, http.StatusNotFound, "OPERATION_NOT_FOUND")
		return
	}
	writeJSON(response, http.StatusOK, operationDocument(record))
}

func operationDocument(record operationRecord) map[string]any {
	return map[string]any{
		"operation_id":            record.ID,
		"status":                  record.Status,
		"administrative_revision": record.Revision,
		"updated_at":              record.UpdatedAt,
	}
}

func validPageQuery(request *http.Request) bool {
	query := request.URL.Query()
	for key := range query {
		if key != "limit" && key != "cursor" && key != "status" {
			return false
		}
	}
	limit, err := strconv.Atoi(query.Get("limit"))
	return err == nil && limit >= 1 && limit <= 100 && query.Get("cursor") == ""
}

func decodeRequest(response http.ResponseWriter, request *http.Request, target any) error {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errors.New("invalid content type")
	}
	request.Body = http.MaxBytesReader(response, request.Body, maximumRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, code string) {
	writeJSON(response, status, map[string]any{
		"error": map[string]string{"code": code, "message": "request rejected"},
	})
}
