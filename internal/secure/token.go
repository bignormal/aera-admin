package secure

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
)

const (
	minimumOpaqueTokenBytes = 32
	maximumOpaqueTokenBytes = 128
)

func NewOpaqueToken(size int) (string, [sha256.Size]byte, error) {
	if size < minimumOpaqueTokenBytes || size > maximumOpaqueTokenBytes {
		return "", [sha256.Size]byte{}, errors.New("opaque token length is invalid")
	}
	material, err := randomBytes(size)
	if err != nil {
		return "", [sha256.Size]byte{}, err
	}
	raw := base64.RawURLEncoding.EncodeToString(material)
	return raw, DigestOpaqueToken(raw), nil
}

func DigestOpaqueToken(raw string) [sha256.Size]byte {
	return sha256.Sum256([]byte(raw))
}

func OpaqueTokenMatches(raw string, expected [sha256.Size]byte) bool {
	actual := DigestOpaqueToken(raw)
	return subtle.ConstantTimeCompare(actual[:], expected[:]) == 1
}

func randomBytes(size int) ([]byte, error) {
	if size <= 0 {
		return nil, errors.New("secure random length is invalid")
	}
	material := make([]byte, size)
	if _, err := rand.Read(material); err != nil {
		return nil, errors.New("secure randomness is unavailable")
	}
	return material, nil
}
