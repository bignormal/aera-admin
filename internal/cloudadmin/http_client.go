package cloudadmin

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bignormal/aera-admin/internal/config"
	"github.com/google/uuid"
)

const maxCloudResponseBytes = 1 << 20

type httpClient struct {
	baseURL *url.URL
	tokens  tokenSource
	client  *http.Client
	clock   func() time.Time
}

type failureStage string

const (
	failureServiceJWT failureStage = "service_jwt"
	failureMTLS       failureStage = "mtls"
	failureUpstream   failureStage = "upstream"
	failureContract   failureStage = "contract"
)

type stagedError struct {
	stage failureStage
	cause error
}

func (failure *stagedError) Error() string { return failure.cause.Error() }
func (failure *stagedError) Unwrap() error { return failure.cause }

func staged(stage failureStage, cause error) error {
	return &stagedError{stage: stage, cause: cause}
}

func NewHTTPClient(settings config.CloudAdminConfig, clock func() time.Time) (Client, error) {
	if !settings.Enabled {
		return DisabledClient{}, nil
	}
	if clock == nil {
		return nil, errors.New("Cloud Admin clock is required")
	}
	baseURL, err := url.Parse(settings.BaseURL)
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil ||
		baseURL.RawQuery != "" || baseURL.Fragment != "" || (baseURL.Path != "" && baseURL.Path != "/") {
		return nil, errors.New("Cloud Admin base URL is invalid")
	}
	baseURL.Path = ""

	caPEM, err := os.ReadFile(settings.CAFile)
	if err != nil {
		return nil, errors.New("Cloud Admin CA could not be read")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("Cloud Admin CA is invalid")
	}
	certificate, err := tls.LoadX509KeyPair(settings.ClientCertFile, settings.ClientKeyFile)
	if err != nil {
		return nil, errors.New("Cloud Admin client identity is invalid")
	}
	signingPEM, err := os.ReadFile(settings.JWTSigningKeyFile)
	if err != nil {
		return nil, errors.New("Cloud Admin service identity could not be read")
	}
	privateKey, err := parseEd25519PrivateKey(signingPEM)
	if err != nil {
		return nil, err
	}
	tokens, err := newTokenSource(privateKey, settings.JWTIssuer, settings.JWTSubject, settings.Scopes, clock)
	if err != nil {
		return nil, err
	}

	transport := &http.Transport{
		Proxy: nil,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS13,
			RootCAs:    roots,
			Certificates: []tls.Certificate{
				certificate,
			},
		},
		DialContext:           (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   3 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		ExpectContinueTimeout: time.Second,
		IdleConnTimeout:       60 * time.Second,
		MaxIdleConns:          20,
		MaxIdleConnsPerHost:   10,
	}
	return &httpClient{
		baseURL: baseURL,
		tokens:  tokens,
		clock:   clock,
		client: &http.Client{
			Transport: transport,
			Timeout:   10 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (client *httpClient) doJSON(
	ctx context.Context,
	method string,
	path string,
	query url.Values,
	body any,
	operationID *uuid.UUID,
	target any,
) error {
	endpoint := *client.baseURL
	endpoint.Path = path
	endpoint.RawQuery = query.Encode()

	var encoded io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return staged(failureContract, ErrContractViolation)
		}
		encoded = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), encoded)
	if err != nil {
		return staged(failureMTLS, ErrUnavailable)
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	token, err := client.tokens.Token(ctx)
	if err != nil {
		return staged(failureServiceJWT, ErrUnavailable)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if operationID != nil {
		request.Header.Set("Idempotency-Key", operationID.String())
	}

	response, err := client.client.Do(request)
	if err != nil {
		return staged(failureMTLS, ErrUnavailable)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < http.StatusOK || response.StatusCode > 299 {
		return staged(failureUpstream, mapRemoteStatus(response.StatusCode))
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return staged(failureContract, ErrContractViolation)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxCloudResponseBytes+1))
	if err != nil {
		return staged(failureUpstream, ErrUnavailable)
	}
	if len(raw) > maxCloudResponseBytes {
		return staged(failureContract, ErrContractViolation)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil || ensureResponseJSONEnd(decoder) != nil {
		return staged(failureContract, ErrContractViolation)
	}
	return nil
}

func (client *httpClient) Health(ctx context.Context) (Health, error) {
	checkedAt := client.clock().UTC()
	result := Health{
		Configured: true, MTLS: CheckNotChecked, ServiceJWT: CheckNotChecked,
		Upstream: CheckNotChecked, CheckedAt: checkedAt,
	}
	var payload struct {
		Status string `json:"status"`
	}
	if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/health", nil, nil, nil, &payload); err != nil {
		var stagedFailure *stagedError
		if errors.As(err, &stagedFailure) {
			switch stagedFailure.stage {
			case failureServiceJWT:
				result.ServiceJWT = CheckUnavailable
			case failureMTLS:
				result.ServiceJWT = CheckOK
				result.MTLS = CheckUnavailable
			case failureUpstream:
				result.ServiceJWT, result.MTLS, result.Upstream = CheckOK, CheckOK, CheckUnavailable
			case failureContract:
				result.ServiceJWT, result.MTLS, result.Upstream = CheckOK, CheckOK, CheckContractError
				result.Availability = ContractError
				return result, err
			}
		}
		result.Availability = Unavailable
		return result, err
	}
	result.ServiceJWT, result.MTLS, result.Upstream = CheckOK, CheckOK, CheckOK
	if payload.Status != "ok" {
		result.Availability, result.Upstream = ContractError, CheckContractError
		return result, ErrContractViolation
	}
	result.Availability = Available
	return result, nil
}

func (client *httpClient) ListUsers(ctx context.Context, input ListUsersRequest) (Page[User], error) {
	query, err := pageQuery(input.PageRequest)
	if err != nil {
		return Page[User]{}, err
	}
	if input.Status != "" {
		if input.Status != UserActive && input.Status != UserPendingDeletion && input.Status != UserDisabled {
			return Page[User]{}, ErrContractViolation
		}
		query.Set("status", string(input.Status))
	}
	var result Page[User]
	if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/users", query, nil, nil, &result); err != nil {
		return Page[User]{}, err
	}
	if len(result.Items) > input.Limit {
		return Page[User]{}, ErrContractViolation
	}
	if err := validateUserPage(result); err != nil {
		return Page[User]{}, err
	}
	return result, nil
}

func (client *httpClient) LookupUser(ctx context.Context, input LookupRequest) (User, error) {
	if (input.Kind != IdentityEmail && input.Kind != IdentityPhone) || input.Value == "" ||
		!utf8.ValidString(input.Value) || len(input.Value) > 320 || strings.TrimSpace(input.Value) != input.Value {
		return User{}, ErrContractViolation
	}
	var result User
	if err := client.doJSON(ctx, http.MethodPost, "/internal/admin/v1/users/lookup", nil, input, nil, &result); err != nil {
		return User{}, err
	}
	if err := result.Validate(); err != nil {
		return User{}, err
	}
	return result, nil
}

func (client *httpClient) GetUser(ctx context.Context, id uuid.UUID) (User, error) {
	if id == uuid.Nil {
		return User{}, ErrContractViolation
	}
	var result User
	if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/users/"+id.String(), nil, nil, nil, &result); err != nil {
		return User{}, err
	}
	if err := result.Validate(); err != nil || result.ID != id {
		return User{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) ListUserDevices(ctx context.Context, id uuid.UUID, page PageRequest) (Page[Device], error) {
	query, err := pageQuery(page)
	if err != nil || id == uuid.Nil {
		return Page[Device]{}, ErrContractViolation
	}
	var result Page[Device]
	if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/users/"+id.String()+"/devices", query, nil, nil, &result); err != nil {
		return Page[Device]{}, err
	}
	if len(result.Items) > page.Limit || validateDevicePage(result) != nil {
		return Page[Device]{}, ErrContractViolation
	}
	for _, device := range result.Items {
		if device.UserID != id {
			return Page[Device]{}, ErrContractViolation
		}
	}
	return result, nil
}

func (client *httpClient) ListUserSessions(ctx context.Context, id uuid.UUID, page PageRequest) (Page[Session], error) {
	query, err := pageQuery(page)
	if err != nil || id == uuid.Nil {
		return Page[Session]{}, ErrContractViolation
	}
	var result Page[Session]
	if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/users/"+id.String()+"/sessions", query, nil, nil, &result); err != nil {
		return Page[Session]{}, err
	}
	if len(result.Items) > page.Limit || validateSessionPage(result) != nil {
		return Page[Session]{}, ErrContractViolation
	}
	for _, session := range result.Items {
		if session.UserID != id {
			return Page[Session]{}, ErrContractViolation
		}
	}
	return result, nil
}

func (client *httpClient) RevokeDevice(ctx context.Context, id uuid.UUID, meta CommandMeta) (Operation, error) {
	return client.command(ctx, "/internal/admin/v1/devices/"+id.String()+"/revoke", id, meta)
}

func (client *httpClient) RevokeSession(ctx context.Context, id uuid.UUID, meta CommandMeta) (Operation, error) {
	return client.command(ctx, "/internal/admin/v1/sessions/"+id.String()+"/revoke", id, meta)
}

func (client *httpClient) DisableUser(ctx context.Context, id uuid.UUID, meta CommandMeta) (Operation, error) {
	return client.command(ctx, "/internal/admin/v1/users/"+id.String()+"/disable", id, meta)
}

func (client *httpClient) EnableUser(ctx context.Context, id uuid.UUID, meta CommandMeta) (Operation, error) {
	return client.command(ctx, "/internal/admin/v1/users/"+id.String()+"/enable", id, meta)
}

func (client *httpClient) command(ctx context.Context, endpoint string, targetID uuid.UUID, meta CommandMeta) (Operation, error) {
	if targetID == uuid.Nil || !validCommandMeta(meta) {
		return Operation{}, ErrContractViolation
	}
	var result Operation
	if err := client.doJSON(ctx, http.MethodPost, endpoint, nil, meta, &meta.OperationID, &result); err != nil {
		return Operation{}, err
	}
	if err := validateOperation(result); err != nil || result.ID != meta.OperationID {
		return Operation{}, ErrContractViolation
	}
	return result, nil
}

func (client *httpClient) GetOperation(ctx context.Context, id uuid.UUID) (Operation, error) {
	if id == uuid.Nil {
		return Operation{}, ErrContractViolation
	}
	var result Operation
	if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/operations/"+id.String(), nil, nil, nil, &result); err != nil {
		return Operation{}, err
	}
	if err := validateOperation(result); err != nil || result.ID != id {
		return Operation{}, ErrContractViolation
	}
	return result, nil
}

func pageQuery(page PageRequest) (url.Values, error) {
	if page.Limit < 1 || page.Limit > 100 || validateCursor(page.Cursor) != nil {
		return nil, ErrContractViolation
	}
	query := url.Values{"limit": []string{strconv.Itoa(page.Limit)}}
	if page.Cursor != "" {
		query.Set("cursor", page.Cursor)
	}
	return query, nil
}

func validCommandMeta(meta CommandMeta) bool {
	if meta.OperationID == uuid.Nil || meta.ActorAdminID == uuid.Nil || meta.RequestID == "" ||
		len(meta.RequestID) > 128 || meta.ReasonCode == "" || len(meta.ReasonCode) > 64 ||
		meta.ExpectedRevision <= 0 || len(meta.TicketReference) > 128 || len(meta.Note) > 500 {
		return false
	}
	if strings.TrimSpace(meta.RequestID) != meta.RequestID || strings.TrimSpace(meta.ReasonCode) != meta.ReasonCode ||
		(meta.TicketReference != "" && strings.TrimSpace(meta.TicketReference) != meta.TicketReference) ||
		(meta.Note != "" && strings.TrimSpace(meta.Note) != meta.Note) {
		return false
	}
	return true
}

func mapRemoteStatus(status int) error {
	switch status {
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusConflict:
		return ErrConflict
	default:
		return ErrUnavailable
	}
}

func ensureResponseJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ErrContractViolation
	}
	return nil
}

var _ Client = (*httpClient)(nil)
