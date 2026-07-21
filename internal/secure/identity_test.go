package secure

import (
	"bytes"
	"crypto/sha256"
	"testing"
)

func TestIdentityCodecNeverUsesPlaintextAsLookup(t *testing.T) {
	codec := testIdentityCodec(t, "enc-v2", "lookup-v2")
	sealed, err := codec.SealEmail(" Admin@Example.com ")
	if err != nil {
		t.Fatalf("SealEmail() error = %v", err)
	}
	if sealed.EncryptionKeyID != "enc-v2" || sealed.LookupKeyID != "lookup-v2" {
		t.Fatalf("sealed key IDs = %q/%q", sealed.EncryptionKeyID, sealed.LookupKeyID)
	}
	if len(sealed.Nonce) != 12 || len(sealed.LookupHMAC) != sha256.Size {
		t.Fatalf("nonce/HMAC lengths = %d/%d", len(sealed.Nonce), len(sealed.LookupHMAC))
	}
	if bytes.Contains(sealed.Ciphertext, []byte("admin@example.com")) || bytes.Contains(sealed.LookupHMAC, []byte("admin@example.com")) {
		t.Fatal("stored identity material contains plaintext email")
	}
	candidates := codec.LookupCandidates("admin@example.com")
	if len(candidates) != 2 || candidates[0].KeyID != "lookup-v2" || len(candidates[0].HMAC) != sha256.Size {
		t.Fatalf("LookupCandidates() = %+v", candidates)
	}
	if !bytes.Equal(candidates[0].HMAC, sealed.LookupHMAC) {
		t.Fatal("active lookup candidate does not match sealed lookup HMAC")
	}
	opened, err := codec.OpenEmail(sealed)
	if err != nil || opened != "admin@example.com" {
		t.Fatalf("OpenEmail() = %q, %v", opened, err)
	}
}

func TestIdentityCodecUsesRandomNonceAndSupportsKeyRotation(t *testing.T) {
	oldCodec := testIdentityCodec(t, "enc-v1", "lookup-v1")
	first, err := oldCodec.SealEmail("admin@example.com")
	if err != nil {
		t.Fatalf("SealEmail() error = %v", err)
	}
	second, err := oldCodec.SealEmail("admin@example.com")
	if err != nil {
		t.Fatalf("second SealEmail() error = %v", err)
	}
	if bytes.Equal(first.Nonce, second.Nonce) || bytes.Equal(first.Ciphertext, second.Ciphertext) {
		t.Fatal("sealing the same email reused encryption output")
	}
	if !bytes.Equal(first.LookupHMAC, second.LookupHMAC) {
		t.Fatal("lookup HMAC is not stable")
	}

	rotated := testIdentityCodec(t, "enc-v2", "lookup-v2")
	opened, err := rotated.OpenEmail(first)
	if err != nil || opened != "admin@example.com" {
		t.Fatalf("rotated OpenEmail() = %q, %v", opened, err)
	}
	oldCandidate := oldCodec.LookupCandidates("admin@example.com")[0]
	candidates := rotated.LookupCandidates("admin@example.com")
	if len(candidates) != 2 || candidates[0].KeyID != "lookup-v2" || candidates[1].KeyID != "lookup-v1" {
		t.Fatalf("rotated LookupCandidates() = %+v", candidates)
	}
	if !bytes.Equal(candidates[1].HMAC, oldCandidate.HMAC) {
		t.Fatal("old lookup digest changed during rotation")
	}
}

func TestIdentityCodecRejectsInvalidEmailAndTampering(t *testing.T) {
	codec := testIdentityCodec(t, "enc-v2", "lookup-v2")
	invalid := []string{
		"missing-at.example.com",
		"two@@example.com",
		"@example.com",
		"admin@",
		"admin @example.com",
		"admin@exam\nple.com",
		string(bytes.Repeat([]byte("a"), 250)) + "@example.com",
		string([]byte{0xff}) + "@example.com",
	}
	for _, value := range invalid {
		if _, err := codec.SealEmail(value); err == nil {
			t.Errorf("SealEmail() accepted %q", value)
		}
		if candidates := codec.LookupCandidates(value); candidates != nil {
			t.Errorf("LookupCandidates() accepted %q", value)
		}
	}

	sealed, err := codec.SealEmail("admin@example.com")
	if err != nil {
		t.Fatalf("SealEmail() error = %v", err)
	}
	sealed.Ciphertext[0] ^= 0xff
	if _, err := codec.OpenEmail(sealed); err == nil {
		t.Fatal("OpenEmail() accepted tampered ciphertext")
	}
	sealed.EncryptionKeyID = "unknown"
	if _, err := codec.OpenEmail(sealed); err == nil {
		t.Fatal("OpenEmail() accepted an unknown key")
	}
}

func TestIdentityCodecCopiesAndValidatesKeyRings(t *testing.T) {
	encryptionKey := bytes.Repeat([]byte{1}, 32)
	lookupKey := bytes.Repeat([]byte{2}, 32)
	codec, err := NewIdentityCodec(IdentityCodecConfig{
		ActiveEncryptionKeyID: "enc-v1",
		EncryptionKeys:        map[string][]byte{"enc-v1": encryptionKey},
		ActiveLookupKeyID:     "lookup-v1",
		LookupKeys:            map[string][]byte{"lookup-v1": lookupKey},
	})
	if err != nil {
		t.Fatalf("NewIdentityCodec() error = %v", err)
	}
	encryptionKey[0] ^= 0xff
	lookupKey[0] ^= 0xff
	sealed, err := codec.SealEmail("admin@example.com")
	if err != nil {
		t.Fatalf("SealEmail() after caller key mutation error = %v", err)
	}
	if _, err := codec.OpenEmail(sealed); err != nil {
		t.Fatalf("OpenEmail() after caller key mutation error = %v", err)
	}

	invalid := []IdentityCodecConfig{
		{},
		{ActiveEncryptionKeyID: "missing", EncryptionKeys: map[string][]byte{"enc-v1": bytes.Repeat([]byte{1}, 32)}, ActiveLookupKeyID: "lookup-v1", LookupKeys: map[string][]byte{"lookup-v1": bytes.Repeat([]byte{2}, 32)}},
		{ActiveEncryptionKeyID: "enc-v1", EncryptionKeys: map[string][]byte{"enc-v1": []byte("short")}, ActiveLookupKeyID: "lookup-v1", LookupKeys: map[string][]byte{"lookup-v1": bytes.Repeat([]byte{2}, 32)}},
		{ActiveEncryptionKeyID: "enc-v1", EncryptionKeys: map[string][]byte{"enc-v1": bytes.Repeat([]byte{1}, 32)}, ActiveLookupKeyID: "lookup-v1", LookupKeys: map[string][]byte{"lookup-v1": []byte("short")}},
	}
	for _, config := range invalid {
		if _, err := NewIdentityCodec(config); err == nil {
			t.Fatalf("NewIdentityCodec() accepted invalid config %+v", config)
		}
	}
}

func testIdentityCodec(t *testing.T, activeEncryptionKey, activeLookupKey string) *IdentityCodec {
	t.Helper()
	codec, err := NewIdentityCodec(IdentityCodecConfig{
		ActiveEncryptionKeyID: activeEncryptionKey,
		EncryptionKeys: map[string][]byte{
			"enc-v1": bytes.Repeat([]byte{1}, 32),
			"enc-v2": bytes.Repeat([]byte{2}, 32),
		},
		ActiveLookupKeyID: activeLookupKey,
		LookupKeys: map[string][]byte{
			"lookup-v1": bytes.Repeat([]byte{3}, 32),
			"lookup-v2": bytes.Repeat([]byte{4}, 32),
		},
	})
	if err != nil {
		t.Fatalf("NewIdentityCodec() error = %v", err)
	}
	return codec
}
