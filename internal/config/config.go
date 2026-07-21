package config

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"strings"
)

const minimumKeyBytes = 32

type LookupEnv func(string) (string, bool)

type KeyRing struct {
	ActiveKeyID string
	Keys        map[string][]byte
}

type Config struct {
	Environment            string
	ListenAddr             string
	PublicURL              string
	DatabaseURL            string
	RedisAddr              string
	TrustedProxyCIDRs      []netip.Prefix
	IdentityEncryptionKeys KeyRing
	IdentityLookupKeys     KeyRing
	TOTPEncryptionKeys     KeyRing
	SessionHMACKey         []byte
	CSRFHMACKey            []byte
}

func Load(lookup LookupEnv) (Config, error) {
	if lookup == nil {
		return Config{}, errors.New("environment lookup is required")
	}
	environment, err := required(lookup, "AERA_ADMIN_ENVIRONMENT")
	if err != nil {
		return Config{}, err
	}
	if environment != "development" && environment != "test" && environment != "production" {
		return Config{}, errors.New("AERA_ADMIN_ENVIRONMENT must be development, test, or production")
	}
	listenAddr, err := required(lookup, "AERA_ADMIN_LISTEN_ADDR")
	if err != nil {
		return Config{}, err
	}
	if _, _, err := net.SplitHostPort(listenAddr); err != nil {
		return Config{}, errors.New("AERA_ADMIN_LISTEN_ADDR must contain a host and port")
	}
	publicURL, err := loadPublicURL(lookup, environment)
	if err != nil {
		return Config{}, err
	}
	databaseURL, err := required(lookup, "AERA_ADMIN_DATABASE_URL")
	if err != nil {
		return Config{}, err
	}
	if err := validateDatabaseURL(databaseURL); err != nil {
		return Config{}, err
	}
	redisAddr, err := required(lookup, "AERA_ADMIN_REDIS_ADDR")
	if err != nil {
		return Config{}, err
	}
	if _, _, err := net.SplitHostPort(redisAddr); err != nil {
		return Config{}, errors.New("AERA_ADMIN_REDIS_ADDR must contain a host and port")
	}
	trustedProxyCIDRs, err := parseTrustedProxyCIDRs(lookup, environment)
	if err != nil {
		return Config{}, err
	}
	identityEncryption, err := parseKeyRing(lookup, "AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS")
	if err != nil {
		return Config{}, err
	}
	identityLookup, err := parseKeyRing(lookup, "AERA_ADMIN_IDENTITY_LOOKUP_KEYS")
	if err != nil {
		return Config{}, err
	}
	totpEncryption, err := parseKeyRing(lookup, "AERA_ADMIN_TOTP_ENCRYPTION_KEYS")
	if err != nil {
		return Config{}, err
	}
	sessionKey, err := decodeRequiredKey(lookup, "AERA_ADMIN_SESSION_HMAC_KEY")
	if err != nil {
		return Config{}, err
	}
	csrfKey, err := decodeRequiredKey(lookup, "AERA_ADMIN_CSRF_HMAC_KEY")
	if err != nil {
		return Config{}, err
	}
	return Config{
		Environment: environment, ListenAddr: listenAddr, PublicURL: publicURL,
		DatabaseURL: databaseURL, RedisAddr: redisAddr, TrustedProxyCIDRs: trustedProxyCIDRs,
		IdentityEncryptionKeys: identityEncryption, IdentityLookupKeys: identityLookup,
		TOTPEncryptionKeys: totpEncryption, SessionHMACKey: sessionKey, CSRFHMACKey: csrfKey,
	}, nil
}

func parseTrustedProxyCIDRs(lookup LookupEnv, environment string) ([]netip.Prefix, error) {
	raw, err := required(lookup, "AERA_ADMIN_TRUSTED_PROXY_CIDRS")
	if err != nil {
		return nil, err
	}
	var encoded []string
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	if err := decoder.Decode(&encoded); err != nil || ensureJSONEnd(decoder) != nil {
		return nil, errors.New("AERA_ADMIN_TRUSTED_PROXY_CIDRS must contain one JSON array of CIDRs")
	}
	if encoded == nil || len(encoded) > 64 {
		return nil, errors.New("AERA_ADMIN_TRUSTED_PROXY_CIDRS must contain a bounded JSON array of CIDRs")
	}
	if environment == "production" && len(encoded) == 0 {
		return nil, errors.New("AERA_ADMIN_TRUSTED_PROXY_CIDRS must name the HTTPS termination proxies in production")
	}
	prefixes := make([]netip.Prefix, 0, len(encoded))
	seen := make(map[netip.Prefix]struct{}, len(encoded))
	for _, rawPrefix := range encoded {
		prefix, parseErr := netip.ParsePrefix(rawPrefix)
		if parseErr != nil || prefix != prefix.Masked() || prefix.Addr().Zone() != "" {
			return nil, errors.New("AERA_ADMIN_TRUSTED_PROXY_CIDRS contains an invalid or non-canonical CIDR")
		}
		prefix = prefix.Masked()
		if _, duplicate := seen[prefix]; duplicate {
			return nil, errors.New("AERA_ADMIN_TRUSTED_PROXY_CIDRS contains a duplicate CIDR")
		}
		seen[prefix] = struct{}{}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}

func required(lookup LookupEnv, key string) (string, error) {
	value, ok := lookup(key)
	if !ok || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	if value != strings.TrimSpace(value) {
		return "", fmt.Errorf("%s must not contain surrounding whitespace", key)
	}
	return value, nil
}

func loadPublicURL(lookup LookupEnv, environment string) (string, error) {
	raw, err := required(lookup, "AERA_ADMIN_PUBLIC_URL")
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("AERA_ADMIN_PUBLIC_URL must be an HTTP origin without path, query, fragment, or credentials")
	}
	if environment == "production" && parsed.Scheme != "https" {
		return "", errors.New("AERA_ADMIN_PUBLIC_URL must use HTTPS in production")
	}
	if parsed.Path == "/" {
		parsed.Path = ""
	}
	return parsed.String(), nil
}

func validateDatabaseURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" || strings.TrimPrefix(parsed.Path, "/") == "" {
		return errors.New("AERA_ADMIN_DATABASE_URL must be a PostgreSQL URL")
	}
	return nil
}

func parseKeyRing(lookup LookupEnv, environmentKey string) (KeyRing, error) {
	raw, err := required(lookup, environmentKey)
	if err != nil {
		return KeyRing{}, err
	}
	var encoded struct {
		ActiveKeyID string            `json:"active_key_id"`
		Keys        map[string]string `json:"keys"`
	}
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&encoded); err != nil {
		return KeyRing{}, fmt.Errorf("%s must contain a valid key ring", environmentKey)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return KeyRing{}, fmt.Errorf("%s must contain one JSON object", environmentKey)
	}
	if encoded.ActiveKeyID == "" || len(encoded.Keys) == 0 {
		return KeyRing{}, fmt.Errorf("%s must contain an active key and keys", environmentKey)
	}
	keys := make(map[string][]byte, len(encoded.Keys))
	for id, rawKey := range encoded.Keys {
		if strings.TrimSpace(id) == "" {
			return KeyRing{}, fmt.Errorf("%s contains an empty key id", environmentKey)
		}
		key, err := base64.StdEncoding.DecodeString(rawKey)
		if err != nil || len(key) < minimumKeyBytes {
			return KeyRing{}, fmt.Errorf("%s contains invalid key material", environmentKey)
		}
		keys[id] = append([]byte(nil), key...)
	}
	if _, ok := keys[encoded.ActiveKeyID]; !ok {
		return KeyRing{}, fmt.Errorf("%s active key is unavailable", environmentKey)
	}
	return KeyRing{ActiveKeyID: encoded.ActiveKeyID, Keys: keys}, nil
}

func decodeRequiredKey(lookup LookupEnv, environmentKey string) ([]byte, error) {
	raw, err := required(lookup, environmentKey)
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(key) < minimumKeyBytes {
		return nil, fmt.Errorf("%s must be base64-encoded and at least %d bytes", environmentKey, minimumKeyBytes)
	}
	return append([]byte(nil), key...), nil
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}
