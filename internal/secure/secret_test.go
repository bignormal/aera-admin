package secure

import (
	"bytes"
	"testing"
)

func TestSecretCodecEncryptsWithRandomNonceAndSupportsRotation(t *testing.T) {
	oldCodec := testSecretCodec(t, "totp-v1")
	secret := bytes.Repeat([]byte{9}, 20)
	first, err := oldCodec.Seal(secret)
	if err != nil {
		t.Fatalf("Seal() error = %v", err)
	}
	second, err := oldCodec.Seal(secret)
	if err != nil {
		t.Fatalf("second Seal() error = %v", err)
	}
	if first.KeyID != "totp-v1" || len(first.Nonce) != 12 || bytes.Equal(first.Nonce, second.Nonce) || bytes.Equal(first.Ciphertext, second.Ciphertext) {
		t.Fatalf("sealed secrets reused output or wrong metadata: first=%+v second=%+v", first, second)
	}
	if bytes.Contains(first.Ciphertext, secret) {
		t.Fatal("ciphertext contains plaintext secret")
	}

	rotated := testSecretCodec(t, "totp-v2")
	opened, err := rotated.Open(first)
	if err != nil || !bytes.Equal(opened, secret) {
		t.Fatalf("rotated Open() = %x, %v", opened, err)
	}
}

func TestSecretCodecRejectsTamperingAndCopiesKeys(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	codec, err := NewSecretCodec(SecretCodecConfig{ActiveKeyID: "totp-v1", Keys: map[string][]byte{"totp-v1": key}})
	if err != nil {
		t.Fatalf("NewSecretCodec() error = %v", err)
	}
	key[0] ^= 0xff
	sealed, err := codec.Seal(bytes.Repeat([]byte{7}, 20))
	if err != nil {
		t.Fatalf("Seal() after key mutation error = %v", err)
	}
	sealed.Ciphertext[0] ^= 0xff
	if _, err := codec.Open(sealed); err == nil {
		t.Fatal("Open() accepted tampered ciphertext")
	}
	sealed.KeyID = "unknown"
	if _, err := codec.Open(sealed); err == nil {
		t.Fatal("Open() accepted unknown key")
	}
}

func TestSecretCodecRejectsInvalidConfigurationAndSecret(t *testing.T) {
	invalid := []SecretCodecConfig{
		{},
		{ActiveKeyID: "missing", Keys: map[string][]byte{"totp-v1": bytes.Repeat([]byte{1}, 32)}},
		{ActiveKeyID: "totp-v1", Keys: map[string][]byte{"totp-v1": []byte("short")}},
	}
	for _, config := range invalid {
		if _, err := NewSecretCodec(config); err == nil {
			t.Fatalf("NewSecretCodec() accepted %+v", config)
		}
	}
	codec := testSecretCodec(t, "totp-v2")
	if _, err := codec.Seal(nil); err == nil {
		t.Fatal("Seal(nil) succeeded")
	}
	if _, err := codec.Seal(bytes.Repeat([]byte{1}, 65)); err == nil {
		t.Fatal("Seal(65 bytes) succeeded")
	}
}

func testSecretCodec(t *testing.T, active string) *SecretCodec {
	t.Helper()
	codec, err := NewSecretCodec(SecretCodecConfig{
		ActiveKeyID: active,
		Keys: map[string][]byte{
			"totp-v1": bytes.Repeat([]byte{1}, 32),
			"totp-v2": bytes.Repeat([]byte{2}, 32),
		},
	})
	if err != nil {
		t.Fatalf("NewSecretCodec() error = %v", err)
	}
	return codec
}
