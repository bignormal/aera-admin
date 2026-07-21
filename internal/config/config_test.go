package config

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

func TestLoadRequiresEverySecuritySecret(t *testing.T) {
	requiredKeys := []string{
		"AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS",
		"AERA_ADMIN_IDENTITY_LOOKUP_KEYS",
		"AERA_ADMIN_TOTP_ENCRYPTION_KEYS",
		"AERA_ADMIN_SESSION_HMAC_KEY",
		"AERA_ADMIN_CSRF_HMAC_KEY",
	}
	for _, key := range requiredKeys {
		t.Run(key, func(t *testing.T) {
			values := validEnvironment()
			delete(values, key)
			_, err := Load(mapLookup(values))
			if err == nil || !strings.Contains(err.Error(), key) {
				t.Fatalf("Load() error = %v, want error naming %s", err, key)
			}
		})
	}
}

func TestLoadRejectsNonHTTPSProductionURL(t *testing.T) {
	values := validEnvironment()
	values["AERA_ADMIN_ENVIRONMENT"] = "production"
	values["AERA_ADMIN_PUBLIC_URL"] = "http://admin.example.test"
	if _, err := Load(mapLookup(values)); err == nil || !strings.Contains(err.Error(), "AERA_ADMIN_PUBLIC_URL") {
		t.Fatalf("Load() error = %v, want production public URL error", err)
	}
}

func TestLoadRequiresExplicitTrustedProxyCIDRsForProduction(t *testing.T) {
	values := validEnvironment()
	values["AERA_ADMIN_ENVIRONMENT"] = "production"
	values["AERA_ADMIN_TRUSTED_PROXY_CIDRS"] = `[]`
	if _, err := Load(mapLookup(values)); err == nil || !strings.Contains(err.Error(), "AERA_ADMIN_TRUSTED_PROXY_CIDRS") {
		t.Fatalf("Load() error = %v, want production trusted-proxy error", err)
	}

	values["AERA_ADMIN_TRUSTED_PROXY_CIDRS"] = `["10.0.0.0/8","2001:db8::/32"]`
	loaded, err := Load(mapLookup(values))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(loaded.TrustedProxyCIDRs) != 2 {
		t.Fatalf("trusted proxy CIDRs = %v", loaded.TrustedProxyCIDRs)
	}
}

func TestLoadRejectsMalformedOrNonCanonicalTrustedProxyCIDRs(t *testing.T) {
	for _, raw := range []string{
		`["not-a-cidr"]`,
		`["10.0.0.1/8"]`,
		`["10.0.0.0/8","10.0.0.0/8"]`,
		`{"cidrs":["10.0.0.0/8"]}`,
		`null`,
	} {
		t.Run(raw, func(t *testing.T) {
			values := validEnvironment()
			values["AERA_ADMIN_TRUSTED_PROXY_CIDRS"] = raw
			if _, err := Load(mapLookup(values)); err == nil || !strings.Contains(err.Error(), "AERA_ADMIN_TRUSTED_PROXY_CIDRS") {
				t.Fatalf("Load() error = %v, want trusted-proxy validation error", err)
			}
		})
	}
}

func TestLoadRejectsPublicURLWithPathQueryOrCredentials(t *testing.T) {
	for _, raw := range []string{
		"https://admin.example.test/control",
		"https://admin.example.test?debug=true",
		"https://operator:secret@admin.example.test",
	} {
		t.Run(raw, func(t *testing.T) {
			values := validEnvironment()
			values["AERA_ADMIN_PUBLIC_URL"] = raw
			if _, err := Load(mapLookup(values)); err == nil {
				t.Fatalf("Load() accepted non-origin public URL %q", raw)
			}
		})
	}
}

func TestLoadRejectsShortOrUnresolvableKeyMaterial(t *testing.T) {
	shortKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 31))
	values := validEnvironment()
	values["AERA_ADMIN_SESSION_HMAC_KEY"] = shortKey
	if _, err := Load(mapLookup(values)); err == nil || !strings.Contains(err.Error(), "AERA_ADMIN_SESSION_HMAC_KEY") {
		t.Fatalf("Load() short key error = %v", err)
	}

	values = validEnvironment()
	values["AERA_ADMIN_IDENTITY_LOOKUP_KEYS"] = fmt.Sprintf(`{"active_key_id":"missing","keys":{"v1":%q}}`, encodedKey(2))
	if _, err := Load(mapLookup(values)); err == nil || !strings.Contains(err.Error(), "AERA_ADMIN_IDENTITY_LOOKUP_KEYS") {
		t.Fatalf("Load() unresolved active key error = %v", err)
	}
}

func TestLoadReturnsValidatedIndependentKeyCopies(t *testing.T) {
	config, err := Load(mapLookup(validEnvironment()))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if config.Environment != "test" || config.ListenAddr != "127.0.0.1:8080" ||
		config.PublicURL != "https://admin.example.test" || config.RedisAddr != "127.0.0.1:6379" {
		t.Fatalf("config = %+v", config)
	}
	if config.IdentityEncryptionKeys.ActiveKeyID != "v1" || len(config.IdentityEncryptionKeys.Keys["v1"]) != 32 ||
		len(config.SessionHMACKey) != 32 || len(config.CSRFHMACKey) != 32 {
		t.Fatalf("security key lengths are invalid")
	}
	config.IdentityEncryptionKeys.Keys["v1"][0] = 99
	second, err := Load(mapLookup(validEnvironment()))
	if err != nil {
		t.Fatalf("second Load() error = %v", err)
	}
	if second.IdentityEncryptionKeys.Keys["v1"][0] == 99 {
		t.Fatal("Load() reused mutable key material")
	}
}

func validEnvironment() map[string]string {
	return map[string]string{
		"AERA_ADMIN_ENVIRONMENT":              "test",
		"AERA_ADMIN_LISTEN_ADDR":              "127.0.0.1:8080",
		"AERA_ADMIN_PUBLIC_URL":               "https://admin.example.test",
		"AERA_ADMIN_DATABASE_URL":             "postgres://aera_admin:password@127.0.0.1:5432/aera_admin?sslmode=disable",
		"AERA_ADMIN_REDIS_ADDR":               "127.0.0.1:6379",
		"AERA_ADMIN_TRUSTED_PROXY_CIDRS":      `[]`,
		"AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS": keyRingJSON("v1", encodedKey(1)),
		"AERA_ADMIN_IDENTITY_LOOKUP_KEYS":     keyRingJSON("v1", encodedKey(2)),
		"AERA_ADMIN_TOTP_ENCRYPTION_KEYS":     keyRingJSON("v1", encodedKey(3)),
		"AERA_ADMIN_SESSION_HMAC_KEY":         encodedKey(4),
		"AERA_ADMIN_CSRF_HMAC_KEY":            encodedKey(5),
	}
}

func keyRingJSON(id, key string) string {
	return fmt.Sprintf(`{"active_key_id":%q,"keys":{%q:%q}}`, id, id, key)
}

func encodedKey(value byte) string {
	return base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{value}, 32))
}

func mapLookup(values map[string]string) LookupEnv {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}
