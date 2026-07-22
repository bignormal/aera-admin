package cloudadmin

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

const serviceTokenLifetime = 5 * time.Minute

var serviceIdentityPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{2,63}$`)

type tokenSource interface {
	Token(context.Context, *ActorContext) (string, error)
}

type ActorContext struct {
	AdminID          uuid.UUID
	Role             rbac.Role
	OperationID      *uuid.UUID
	ApprovalID       *uuid.UUID
	RequesterAdminID *uuid.UUID
}

type ed25519TokenSource struct {
	privateKey ed25519.PrivateKey
	issuer     string
	subject    string
	scopes     []string
	clock      func() time.Time
}

type serviceClaims struct {
	Issuer           string   `json:"iss"`
	Subject          string   `json:"sub"`
	Audience         string   `json:"aud"`
	Scopes           []string `json:"scope"`
	IssuedAt         int64    `json:"iat"`
	NotBefore        int64    `json:"nbf"`
	ExpiresAt        int64    `json:"exp"`
	JWTID            string   `json:"jti"`
	AdminID          string   `json:"admin_id,omitempty"`
	AdminRole        string   `json:"admin_role,omitempty"`
	OperationID      string   `json:"operation_id,omitempty"`
	ApprovalID       string   `json:"approval_id,omitempty"`
	RequesterAdminID string   `json:"requester_admin_id,omitempty"`
}

func parseEd25519PrivateKey(raw []byte) (ed25519.PrivateKey, error) {
	block, rest := pem.Decode(raw)
	if block == nil || block.Type != "PRIVATE KEY" || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, errors.New("service JWT signing key must contain one PKCS8 private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("service JWT signing key is invalid")
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("service JWT signing key must be Ed25519")
	}
	return append(ed25519.PrivateKey(nil), privateKey...), nil
}

func newTokenSource(privateKey ed25519.PrivateKey, issuer, subject string, scopes []string, clock func() time.Time) (tokenSource, error) {
	if len(privateKey) != ed25519.PrivateKeySize || !serviceIdentityPattern.MatchString(issuer) ||
		!serviceIdentityPattern.MatchString(subject) || len(scopes) == 0 || clock == nil {
		return nil, errors.New("service JWT configuration is invalid")
	}
	return &ed25519TokenSource{
		privateKey: append(ed25519.PrivateKey(nil), privateKey...),
		issuer:     issuer,
		subject:    subject,
		scopes:     append([]string(nil), scopes...),
		clock:      clock,
	}, nil
}

func (source *ed25519TokenSource) Token(ctx context.Context, actor *ActorContext) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !validActorContext(actor) {
		return "", errors.New("service JWT actor context is invalid")
	}
	identifier := make([]byte, 16)
	if _, err := rand.Read(identifier); err != nil {
		return "", errors.New("service JWT id could not be generated")
	}
	now := source.clock().UTC().Truncate(time.Second)
	claims := serviceClaims{
		Issuer: source.issuer, Subject: source.subject, Audience: "aera-cloud-admin",
		Scopes: append([]string(nil), source.scopes...), IssuedAt: now.Unix(),
		NotBefore: now.Add(-5 * time.Second).Unix(), ExpiresAt: now.Add(serviceTokenLifetime).Unix(),
		JWTID: base64.RawURLEncoding.EncodeToString(identifier),
	}
	if actor != nil {
		claims.AdminID = actor.AdminID.String()
		claims.AdminRole = string(actor.Role)
		if actor.OperationID != nil {
			claims.OperationID = actor.OperationID.String()
		}
		if actor.ApprovalID != nil {
			claims.ApprovalID = actor.ApprovalID.String()
			claims.RequesterAdminID = actor.RequesterAdminID.String()
		}
	}
	header, _ := json.Marshal(map[string]string{"alg": "EdDSA", "typ": "JWT"})
	body, err := json.Marshal(claims)
	if err != nil {
		return "", errors.New("service JWT claims could not be encoded")
	}
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	signature := ed25519.Sign(source.privateKey, []byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

func validActorContext(actor *ActorContext) bool {
	if actor == nil {
		return true
	}
	if actor.AdminID == uuid.Nil || !actor.Role.Valid() ||
		(actor.OperationID != nil && *actor.OperationID == uuid.Nil) ||
		(actor.ApprovalID != nil && *actor.ApprovalID == uuid.Nil) ||
		(actor.RequesterAdminID != nil && *actor.RequesterAdminID == uuid.Nil) {
		return false
	}
	rollbackEvidence := actor.ApprovalID != nil || actor.RequesterAdminID != nil
	if rollbackEvidence {
		return actor.OperationID != nil && actor.ApprovalID != nil && actor.RequesterAdminID != nil &&
			*actor.RequesterAdminID != actor.AdminID
	}
	return true
}
