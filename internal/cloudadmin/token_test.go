package cloudadmin

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

func TestServiceTokenIsAudienceBoundShortLivedAndUnique(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	source, err := newTokenSource(privateKey, "aera-admin", "aera-admin-test", []string{"users:read"}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	first, err := source.Token(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := source.Token(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("service JWT jti was reused")
	}

	claims := verifyTestToken(t, publicKey, first)
	if claims.Audience != "aera-cloud-admin" || claims.Issuer != "aera-admin" ||
		claims.Subject != "aera-admin-test" || claims.ExpiresAt-claims.IssuedAt != 300 ||
		!slices.Equal(claims.Scopes, []string{"users:read"}) || claims.JWTID == "" {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestServiceTokenBindsOnlyValidatedOfficialActorIdentity(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	source, err := newTokenSource(privateKey, "aera-admin", "aera-admin-test", []string{"official_agent_releases:write"}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	operationID, approvalID, requesterID := uuid.New(), uuid.New(), uuid.New()
	actor := &ActorContext{
		AdminID: uuid.New(), Role: rbac.SuperAdmin, OperationID: &operationID,
		ApprovalID: &approvalID, RequesterAdminID: &requesterID,
	}
	token, err := source.Token(context.Background(), actor)
	if err != nil {
		t.Fatal(err)
	}
	claims := verifyTestToken(t, publicKey, token)
	if claims.AdminID != actor.AdminID.String() || claims.AdminRole != string(rbac.SuperAdmin) ||
		claims.OperationID != operationID.String() || claims.ApprovalID != approvalID.String() ||
		claims.RequesterAdminID != requesterID.String() || claims.ExpiresAt-claims.IssuedAt != 300 {
		t.Fatalf("actor claims = %+v", claims)
	}
	encoded, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"reason", "note", "manifest", "bundle", "allowlist", "secret"} {
		if strings.Contains(strings.ToLower(string(encoded)), forbidden) {
			t.Fatalf("JWT claims contain forbidden field %q: %s", forbidden, encoded)
		}
	}

	invalid := []ActorContext{
		{Role: rbac.Developer},
		{AdminID: uuid.New(), Role: rbac.Role("owner")},
		{AdminID: uuid.New(), Role: rbac.Operator, ApprovalID: &approvalID},
		{AdminID: uuid.New(), Role: rbac.SuperAdmin, OperationID: &operationID, ApprovalID: &approvalID},
	}
	for _, candidate := range invalid {
		if _, err := source.Token(context.Background(), &candidate); err == nil {
			t.Fatalf("invalid actor accepted: %+v", candidate)
		}
	}
}

func TestServiceTokenRejectsWrongKeyTypeAndUnsafeIdentity(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := x509.MarshalPKCS8PrivateKey(rsaKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parseEd25519PrivateKey(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded})); err == nil {
		t.Fatal("RSA key accepted for Ed25519 service identity")
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newTokenSource(privateKey, "bad issuer", "aera-admin-test", []string{"users:read"}, time.Now); err == nil {
		t.Fatal("unsafe issuer accepted")
	}
}

func verifyTestToken(t *testing.T, publicKey ed25519.PublicKey, token string) serviceClaims {
	t.Helper()
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		t.Fatalf("JWT segment count = %d", len(segments))
	}
	signed := segments[0] + "." + segments[1]
	signature, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil || !ed25519.Verify(publicKey, []byte(signed), signature) {
		t.Fatal("JWT signature is invalid")
	}
	body, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims serviceClaims
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		t.Fatal(err)
	}
	if err := ensureTokenJSONEnd(decoder); err != nil {
		t.Fatal(err)
	}
	return claims
}

func ensureTokenJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("JWT claims contain trailing JSON")
	}
	return nil
}
