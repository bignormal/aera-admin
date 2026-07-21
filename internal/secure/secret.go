package secure

import (
	"crypto/aes"
	"crypto/cipher"
	"errors"
)

const secretAAD = "aera-admin.totp-secret.v1"

type SecretCodecConfig struct {
	ActiveKeyID string
	Keys        map[string][]byte
}

type SealedSecret struct {
	KeyID      string
	Nonce      []byte
	Ciphertext []byte
}

type SecretCodec struct {
	activeKeyID string
	keys        map[string][]byte
}

func NewSecretCodec(config SecretCodecConfig) (*SecretCodec, error) {
	keys, err := copyKeyRing(config.Keys, 32, 32)
	if err != nil {
		return nil, err
	}
	if config.ActiveKeyID == "" {
		return nil, errors.New("active secret encryption key is unavailable")
	}
	if _, ok := keys[config.ActiveKeyID]; !ok {
		return nil, errors.New("active secret encryption key is unavailable")
	}
	return &SecretCodec{activeKeyID: config.ActiveKeyID, keys: keys}, nil
}

func (codec *SecretCodec) Seal(secret []byte) (SealedSecret, error) {
	if codec == nil || len(secret) == 0 || len(secret) > 64 {
		return SealedSecret{}, errors.New("secret encryption input is invalid")
	}
	block, err := aes.NewCipher(codec.keys[codec.activeKeyID])
	if err != nil {
		return SealedSecret{}, errors.New("secret encryption is unavailable")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return SealedSecret{}, errors.New("secret encryption is unavailable")
	}
	nonce, err := randomBytes(aead.NonceSize())
	if err != nil {
		return SealedSecret{}, err
	}
	return SealedSecret{
		KeyID:      codec.activeKeyID,
		Nonce:      nonce,
		Ciphertext: aead.Seal(nil, nonce, secret, []byte(secretAAD)),
	}, nil
}

func (codec *SecretCodec) Open(sealed SealedSecret) ([]byte, error) {
	if codec == nil {
		return nil, errors.New("secret decryption is unavailable")
	}
	key, ok := codec.keys[sealed.KeyID]
	if !ok {
		return nil, errors.New("secret encryption key is unavailable")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("secret decryption is unavailable")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(sealed.Nonce) != aead.NonceSize() {
		return nil, errors.New("encrypted secret is malformed")
	}
	plaintext, err := aead.Open(nil, sealed.Nonce, sealed.Ciphertext, []byte(secretAAD))
	if err != nil || len(plaintext) == 0 || len(plaintext) > 64 {
		return nil, errors.New("encrypted secret could not be authenticated")
	}
	return plaintext, nil
}
