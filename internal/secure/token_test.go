package secure

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestNewOpaqueTokenIsRandomURLSafeAndStoresOnlyDigest(t *testing.T) {
	firstRaw, firstDigest, err := NewOpaqueToken(32)
	if err != nil {
		t.Fatalf("NewOpaqueToken() error = %v", err)
	}
	secondRaw, secondDigest, err := NewOpaqueToken(32)
	if err != nil {
		t.Fatalf("second NewOpaqueToken() error = %v", err)
	}
	if firstRaw == secondRaw || bytes.Equal(firstDigest[:], secondDigest[:]) {
		t.Fatal("opaque tokens reused random material")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(firstRaw)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("raw token decoded length/error = %d/%v", len(decoded), err)
	}
	wantDigest := sha256.Sum256([]byte(firstRaw))
	if !bytes.Equal(firstDigest[:], wantDigest[:]) {
		t.Fatal("token digest does not match the raw token")
	}
	if !OpaqueTokenMatches(firstRaw, firstDigest) || OpaqueTokenMatches(secondRaw, firstDigest) {
		t.Fatal("OpaqueTokenMatches() returned the wrong result")
	}
}

func TestNewOpaqueTokenRejectsUnsafeLengths(t *testing.T) {
	for _, size := range []int{-1, 0, 16, 31, 129} {
		if _, _, err := NewOpaqueToken(size); err == nil {
			t.Errorf("NewOpaqueToken(%d) succeeded", size)
		}
	}
}
