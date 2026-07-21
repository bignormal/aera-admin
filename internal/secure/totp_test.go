package secure

import (
	"encoding/base32"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestTOTPMatchesRFC6238SHA1Vector(t *testing.T) {
	service := TOTP{Period: 30 * time.Second, Digits: 8}
	secret := []byte("12345678901234567890")
	now := time.Unix(59, 0)
	if got := service.Code(secret, now); got != "94287082" {
		t.Fatalf("Code() = %q, want 94287082", got)
	}
	step, ok := service.Validate(secret, "94287082", now, -1)
	if !ok || step != 1 {
		t.Fatalf("Validate() = %d, %v, want 1, true", step, ok)
	}
}

func TestTOTPRejectsAcceptedTimeStepReplay(t *testing.T) {
	service := TOTP{Period: 30 * time.Second, Digits: 6}
	secret := []byte("12345678901234567890")
	now := time.Unix(59, 0)
	code := service.Code(secret, now)
	step, ok := service.Validate(secret, code, now, -1)
	if !ok {
		t.Fatal("known code was rejected")
	}
	if _, replayOK := service.Validate(secret, code, now, step); replayOK {
		t.Fatal("accepted time step was replayed")
	}
}

func TestTOTPAcceptsOneAdjacentStepOnly(t *testing.T) {
	service := TOTP{Period: 30 * time.Second, Digits: 6}
	secret := []byte("12345678901234567890")
	now := time.Unix(120, 0)
	previous := service.Code(secret, now.Add(-30*time.Second))
	next := service.Code(secret, now.Add(30*time.Second))
	tooOld := service.Code(secret, now.Add(-60*time.Second))

	if step, ok := service.Validate(secret, previous, now, -1); !ok || step != 3 {
		t.Fatalf("previous-step Validate() = %d, %v", step, ok)
	}
	if step, ok := service.Validate(secret, next, now, -1); !ok || step != 5 {
		t.Fatalf("next-step Validate() = %d, %v", step, ok)
	}
	if _, ok := service.Validate(secret, tooOld, now, -1); ok {
		t.Fatal("two-step-old code was accepted")
	}
}

func TestTOTPGenerateAndProvisioningURI(t *testing.T) {
	service := TOTP{Period: 30 * time.Second, Digits: 6, Issuer: "Aera Admin"}
	first, err := service.Generate()
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	second, err := service.Generate()
	if err != nil {
		t.Fatalf("second Generate() error = %v", err)
	}
	if len(first) != 20 || string(first) == string(second) {
		t.Fatalf("generated secret length/equality = %d/%v", len(first), string(first) == string(second))
	}

	rawURI, err := service.ProvisioningURI(first, "admin@example.com")
	if err != nil {
		t.Fatalf("ProvisioningURI() error = %v", err)
	}
	parsed, err := url.Parse(rawURI)
	if err != nil {
		t.Fatalf("parse provisioning URI: %v", err)
	}
	query := parsed.Query()
	wantSecret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(first)
	if parsed.Scheme != "otpauth" || parsed.Host != "totp" || !strings.Contains(parsed.Path, "Aera Admin:admin@example.com") ||
		query.Get("secret") != wantSecret || query.Get("issuer") != "Aera Admin" || query.Get("algorithm") != "SHA1" ||
		query.Get("digits") != "6" || query.Get("period") != "30" {
		t.Fatalf("provisioning URI = %q", rawURI)
	}
}

func TestTOTPRejectsMalformedInputsAndConfiguration(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(59, 0)
	invalidServices := []TOTP{
		{Period: 0, Digits: 6},
		{Period: 29 * time.Second, Digits: 6},
		{Period: 30 * time.Second, Digits: 7},
	}
	for _, service := range invalidServices {
		if code := service.Code(secret, now); code != "" {
			t.Errorf("invalid service Code() = %q", code)
		}
		if _, ok := service.Validate(secret, "123456", now, -1); ok {
			t.Fatal("invalid service validated a code")
		}
	}

	service := TOTP{Period: 30 * time.Second, Digits: 6, Issuer: "Aera Admin"}
	for _, code := range []string{"", "12345", "1234567", "12345a", "１２３４５６"} {
		if _, ok := service.Validate(secret, code, now, -1); ok {
			t.Errorf("Validate() accepted malformed code %q", code)
		}
	}
	if _, ok := service.Validate([]byte("short"), service.Code(secret, now), now, -1); ok {
		t.Fatal("Validate() accepted a short secret")
	}
	if _, err := service.ProvisioningURI(secret, "bad:account"); err == nil {
		t.Fatal("ProvisioningURI() accepted a colon in the account label")
	}
}
