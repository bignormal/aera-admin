package cloudadmin

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/config"
	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

func TestHTTPClientRequiresMTLSAndAudienceBoundJWT(t *testing.T) {
	fixture := newTLSFixture(t)
	var observedAuthorization string
	var observedIdempotency string
	server := fixture.startServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.TLS == nil || len(request.TLS.PeerCertificates) != 1 {
			t.Error("client certificate was not presented")
		}
		observedAuthorization = request.Header.Get("Authorization")
		observedIdempotency = request.Header.Get("Idempotency-Key")
		if request.URL.Path != "/internal/admin/v1/sessions/019f0000-0000-7000-8000-000000000011/revoke" {
			t.Errorf("path = %q", request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"operation_id":"019f0000-0000-7000-8000-000000000012","status":"succeeded","updated_at":"2026-07-22T08:00:00Z"}`)
	}))
	fixture.config.BaseURL = server.URL
	client, err := NewHTTPClient(fixture.config, fixture.clock)
	if err != nil {
		t.Fatal(err)
	}
	operationID := uuid.MustParse("019f0000-0000-7000-8000-000000000012")
	result, err := client.RevokeSession(context.Background(), uuid.MustParse("019f0000-0000-7000-8000-000000000011"), CommandMeta{
		OperationID: operationID, ActorAdminID: uuid.New(), RequestID: "req-client",
		ReasonCode: "suspected_compromise", ExpectedRevision: 1,
	})
	if err != nil || result.ID != operationID {
		t.Fatalf("result = %+v, %v", result, err)
	}
	if !strings.HasPrefix(observedAuthorization, "Bearer ") || observedIdempotency != operationID.String() {
		t.Fatalf("authentication headers = %q %q", observedAuthorization, observedIdempotency)
	}
}

func TestHTTPClientMapsUnsafeResponsesToStableErrors(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"unknown field", 200, `{"user_id":"019f0000-0000-7000-8000-000000000001","masked_email":"a***@example.test","status":"active","administratively_disabled":false,"administrative_revision":1,"device_count":0,"active_device_count":0,"active_session_count":0,"created_at":"2026-07-22T08:00:00Z","secret_extra":"canary"}`, ErrContractViolation},
		{"raw identity", 200, `{"user_id":"019f0000-0000-7000-8000-000000000001","email":"raw@example.test","status":"active"}`, ErrContractViolation},
		{"not found", 404, `{"error":{"code":"USER_NOT_FOUND","message":"raw upstream canary"}}`, ErrNotFound},
		{"conflict", 409, `{"error":{"code":"USER_STATE_CONFLICT","message":"raw upstream canary"}}`, ErrConflict},
		{"redirect", 302, ``, ErrUnavailable},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			client := newFixtureClient(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				response.WriteHeader(item.status)
				_, _ = io.WriteString(response, item.body)
			}))
			_, err := client.GetUser(context.Background(), uuid.MustParse("019f0000-0000-7000-8000-000000000001"))
			if !errors.Is(err, item.want) {
				t.Fatalf("GetUser() error = %v, want %v", err, item.want)
			}
			if err != nil && strings.Contains(err.Error(), "raw upstream canary") {
				t.Fatal("upstream body leaked through error")
			}
		})
	}
}

func TestHTTPClientRejectsOversizeAndTimeout(t *testing.T) {
	oversize := newFixtureClient(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write(bytes.Repeat([]byte{'x'}, (1<<20)+2))
	}))
	if _, err := oversize.GetUser(context.Background(), uuid.New()); !errors.Is(err, ErrContractViolation) {
		t.Fatalf("oversize error = %v", err)
	}

	delayed := newFixtureClient(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{}`)
	}))
	delayed.(*httpClient).client.Timeout = 10 * time.Millisecond
	if _, err := delayed.GetUser(context.Background(), uuid.New()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("timeout error = %v", err)
	}
}

func TestHTTPClientSignsOfficialActorAndValidatesOperationIdentity(t *testing.T) {
	fixture := newTLSFixture(t)
	actorID, operationID := uuid.New(), uuid.New()
	requestCount := 0
	server := fixture.startServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requestCount++
		claims := verifyTestToken(t, fixture.servicePublicKey, strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "))
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/internal/admin/v1/official-agent-definitions":
			if request.Method == http.MethodGet {
				if claims.AdminID != actorID.String() || claims.AdminRole != string(rbac.Developer) || claims.OperationID != "" {
					t.Errorf("read claims = %+v", claims)
				}
				_, _ = io.WriteString(response, `{"items":[{"definition_id":"019f0000-0000-7000-8000-000000000221","platform_id":"019f0000-0000-7000-8000-000000000222","display_name":"Official Research","status":"active","created_by_admin_id":"019f0000-0000-7000-8000-000000000223","created_at":"2026-07-22T08:00:00Z","updated_at":"2026-07-22T08:00:00Z"}]}`)
				return
			}
			if claims.OperationID != operationID.String() || request.Header.Get("Idempotency-Key") != operationID.String() {
				t.Errorf("mutation claims/header = %+v / %q", claims, request.Header.Get("Idempotency-Key"))
			}
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body["actor_admin_id"] != actorID.String() || body["actor_admin_role"] != string(rbac.Developer) {
				t.Errorf("mutation body/error = %+v / %v", body, err)
			}
			_, _ = io.WriteString(response, `{"operation_id":"`+operationID.String()+`","status":"succeeded","administrative_revision":1,"updated_at":"2026-07-22T08:00:00Z"}`)
		default:
			http.NotFound(response, request)
		}
	}))
	fixture.config.BaseURL = server.URL
	client, err := NewHTTPClient(fixture.config, fixture.clock)
	if err != nil {
		t.Fatal(err)
	}
	actor := ActorContext{AdminID: actorID, Role: rbac.Developer}
	definitions, err := client.ListOfficialDefinitions(context.Background(), actor, PageRequest{Limit: 20})
	if err != nil || len(definitions.Items) != 1 {
		t.Fatalf("definitions = %+v, %v", definitions, err)
	}
	actor.OperationID = &operationID
	operation, err := client.ExecuteOfficialCommand(context.Background(), actor, OfficialCommand{
		Action: OfficialDefinitionReserve, TargetID: uuid.New(), ExpectedRevision: 1,
		ReasonCode: "official_content_review", Payload: json.RawMessage(`{"display_name":"Official Research"}`),
	})
	if err != nil || operation.ID != operationID || requestCount != 2 {
		t.Fatalf("official operation = %+v, requests=%d, error=%v", operation, requestCount, err)
	}
}

func TestHTTPClientRejectsUnsafeOfficialResponseEncodingAndPageSize(t *testing.T) {
	const validDefinition = `{"definition_id":"019f0000-0000-7000-8000-000000000221","platform_id":"019f0000-0000-7000-8000-000000000222","display_name":"Official Research","status":"active","created_by_admin_id":"019f0000-0000-7000-8000-000000000223","created_at":"2026-07-22T08:00:00Z","updated_at":"2026-07-22T08:00:00Z"}`
	cases := []struct {
		name  string
		body  string
		limit int
	}{
		{"duplicate key", `{"items":[{"definition_id":"019f0000-0000-7000-8000-000000000221","platform_id":"019f0000-0000-7000-8000-000000000222","display_name":"Official Research","status":"active","status":"archived","created_by_admin_id":"019f0000-0000-7000-8000-000000000223","created_at":"2026-07-22T08:00:00Z","updated_at":"2026-07-22T08:00:00Z"}]}`, 1},
		{"noncanonical UUID", strings.Replace(`{"items":[`+validDefinition+`]}`, "019f0000-0000-7000-8000-000000000221", "019F0000-0000-7000-8000-000000000221", 1), 1},
		{"too many items", `{"items":[` + validDefinition + `,` + strings.Replace(validDefinition, "000000000221", "000000000224", 1) + `]}`, 1},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newTLSFixture(t)
			server := fixture.startServer(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(response, test.body)
			}))
			fixture.config.BaseURL = server.URL
			client, err := NewHTTPClient(fixture.config, fixture.clock)
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.ListOfficialDefinitions(context.Background(), ActorContext{
				AdminID: uuid.New(), Role: rbac.Developer,
			}, PageRequest{Limit: test.limit})
			if !errors.Is(err, ErrContractViolation) {
				t.Fatalf("ListOfficialDefinitions() error = %v", err)
			}
		})
	}
}

func TestHTTPClientRejectsMismatchedOfficialOperationIdentity(t *testing.T) {
	fixture := newTLSFixture(t)
	server := fixture.startServer(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(response, `{"operation_id":"019f0000-0000-7000-8000-000000000399","status":"succeeded","administrative_revision":1,"updated_at":"2026-07-22T08:00:00Z"}`)
	}))
	fixture.config.BaseURL = server.URL
	client, err := NewHTTPClient(fixture.config, fixture.clock)
	if err != nil {
		t.Fatal(err)
	}
	operationID := uuid.MustParse("019f0000-0000-7000-8000-000000000398")
	_, err = client.ExecuteOfficialCommand(context.Background(), ActorContext{
		AdminID: uuid.New(), Role: rbac.Developer, OperationID: &operationID,
	}, OfficialCommand{
		Action: OfficialDefinitionReserve, TargetID: uuid.New(), ExpectedRevision: 1,
		ReasonCode: "official_content_review", Payload: json.RawMessage(`{"display_name":"Official Research"}`),
	})
	if !errors.Is(err, ErrContractViolation) {
		t.Fatalf("ExecuteOfficialCommand() error = %v", err)
	}
}

type tlsFixture struct {
	config            config.CloudAdminConfig
	clock             func() time.Time
	serverCertificate tls.Certificate
	clientRoots       *x509.CertPool
	servicePublicKey  ed25519.PublicKey
}

func newTLSFixture(t *testing.T) *tlsFixture {
	t.Helper()
	now := time.Now().UTC()
	_, caKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Aera Admin Test CA"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caKey.Public(), caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCertificate, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	issue := func(serial int64, commonName string, usage x509.ExtKeyUsage, addresses []net.IP) (tls.Certificate, []byte, []byte) {
		t.Helper()
		_, privateKey, generateErr := ed25519.GenerateKey(rand.Reader)
		if generateErr != nil {
			t.Fatal(generateErr)
		}
		certificateTemplate := &x509.Certificate{
			SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: commonName},
			NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
			KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage}, IPAddresses: addresses,
		}
		certificateDER, createErr := x509.CreateCertificate(rand.Reader, certificateTemplate, caCertificate, privateKey.Public(), caKey)
		if createErr != nil {
			t.Fatal(createErr)
		}
		encodedKey, marshalErr := x509.MarshalPKCS8PrivateKey(privateKey)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		certificatePEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER})
		keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedKey})
		pair, pairErr := tls.X509KeyPair(certificatePEM, keyPEM)
		if pairErr != nil {
			t.Fatal(pairErr)
		}
		return pair, certificatePEM, keyPEM
	}
	serverCertificate, _, _ := issue(2, "aera-cloud-test", x509.ExtKeyUsageServerAuth, []net.IP{net.ParseIP("127.0.0.1")})
	_, clientCertificatePEM, clientKeyPEM := issue(3, "aera-admin-test", x509.ExtKeyUsageClientAuth, nil)
	_, serviceKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encodedServiceKey, err := x509.MarshalPKCS8PrivateKey(serviceKey)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	write := func(name string, body []byte) string {
		t.Helper()
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		t.Fatal("test CA could not be loaded")
	}
	fixedNow := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	return &tlsFixture{
		config: config.CloudAdminConfig{
			Enabled: true, BaseURL: "https://127.0.0.1", CAFile: write("ca.pem", caPEM),
			ClientCertFile: write("client.pem", clientCertificatePEM), ClientKeyFile: write("client-key.pem", clientKeyPEM),
			JWTSigningKeyFile: write("service-key.pem", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedServiceKey})),
			JWTIssuer:         "aera-admin", JWTSubject: "aera-admin-test", Scopes: []string{
				"users:read", "sessions:write", "official_agents:read", "official_agent_drafts:write",
				"official_agent_reviews:write", "official_agent_releases:write", "official_agent_audit:read",
			},
		},
		clock:             func() time.Time { return fixedNow },
		serverCertificate: serverCertificate,
		clientRoots:       roots,
		servicePublicKey:  serviceKey.Public().(ed25519.PublicKey),
	}
}

func (fixture *tlsFixture) startServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{
		Certificates: []tls.Certificate{fixture.serverCertificate}, ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs: fixture.clientRoots, MinVersion: tls.VersionTLS13,
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func newFixtureClient(t *testing.T, handler http.Handler) Client {
	t.Helper()
	fixture := newTLSFixture(t)
	server := fixture.startServer(t, handler)
	fixture.config.BaseURL = server.URL
	client, err := NewHTTPClient(fixture.config, fixture.clock)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
