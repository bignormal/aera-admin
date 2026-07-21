package secure

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const emailIdentityAAD = "aera-admin.identity.email.v1"

type IdentityCodecConfig struct {
	ActiveEncryptionKeyID string
	EncryptionKeys        map[string][]byte
	ActiveLookupKeyID     string
	LookupKeys            map[string][]byte
}

type SealedIdentity struct {
	EncryptionKeyID string
	Nonce           []byte
	Ciphertext      []byte
	LookupKeyID     string
	LookupHMAC      []byte
}

type LookupIndex struct {
	KeyID string
	HMAC  []byte
}

type IdentityCodec struct {
	activeEncryptionKeyID string
	encryptionKeys        map[string][]byte
	activeLookupKeyID     string
	lookupKeys            map[string][]byte
	lookupOrder           []string
}

func NewIdentityCodec(config IdentityCodecConfig) (*IdentityCodec, error) {
	encryptionKeys, err := copyKeyRing(config.EncryptionKeys, 32, 32)
	if err != nil {
		return nil, err
	}
	if config.ActiveEncryptionKeyID == "" {
		return nil, errors.New("active identity encryption key is unavailable")
	}
	if _, ok := encryptionKeys[config.ActiveEncryptionKeyID]; !ok {
		return nil, errors.New("active identity encryption key is unavailable")
	}
	lookupKeys, err := copyKeyRing(config.LookupKeys, 32, 64)
	if err != nil {
		return nil, err
	}
	if config.ActiveLookupKeyID == "" {
		return nil, errors.New("active identity lookup key is unavailable")
	}
	if _, ok := lookupKeys[config.ActiveLookupKeyID]; !ok {
		return nil, errors.New("active identity lookup key is unavailable")
	}

	lookupOrder := make([]string, 0, len(lookupKeys))
	for keyID := range lookupKeys {
		if keyID != config.ActiveLookupKeyID {
			lookupOrder = append(lookupOrder, keyID)
		}
	}
	sort.Strings(lookupOrder)
	lookupOrder = append([]string{config.ActiveLookupKeyID}, lookupOrder...)
	return &IdentityCodec{
		activeEncryptionKeyID: config.ActiveEncryptionKeyID,
		encryptionKeys:        encryptionKeys,
		activeLookupKeyID:     config.ActiveLookupKeyID,
		lookupKeys:            lookupKeys,
		lookupOrder:           lookupOrder,
	}, nil
}

func NormalizeAdminEmail(raw string) (string, error) {
	if !utf8.ValidString(raw) {
		return "", errors.New("administrator email is invalid")
	}
	normalized := strings.ToLower(strings.TrimSpace(raw))
	if len(normalized) > 254 || strings.Count(normalized, "@") != 1 {
		return "", errors.New("administrator email is invalid")
	}
	local, domain, _ := strings.Cut(normalized, "@")
	if local == "" || domain == "" {
		return "", errors.New("administrator email is invalid")
	}
	for _, character := range normalized {
		if unicode.IsSpace(character) || unicode.IsControl(character) {
			return "", errors.New("administrator email is invalid")
		}
	}
	return normalized, nil
}

func (codec *IdentityCodec) SealEmail(raw string) (SealedIdentity, error) {
	if codec == nil {
		return SealedIdentity{}, errors.New("identity encryption is unavailable")
	}
	normalized, err := NormalizeAdminEmail(raw)
	if err != nil {
		return SealedIdentity{}, err
	}
	block, err := aes.NewCipher(codec.encryptionKeys[codec.activeEncryptionKeyID])
	if err != nil {
		return SealedIdentity{}, errors.New("identity encryption is unavailable")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return SealedIdentity{}, errors.New("identity encryption is unavailable")
	}
	nonce, err := randomBytes(aead.NonceSize())
	if err != nil {
		return SealedIdentity{}, err
	}
	ciphertext := aead.Seal(nil, nonce, []byte(normalized), []byte(emailIdentityAAD))
	lookup := codec.lookup(normalized, codec.activeLookupKeyID)
	return SealedIdentity{
		EncryptionKeyID: codec.activeEncryptionKeyID,
		Nonce:           nonce,
		Ciphertext:      ciphertext,
		LookupKeyID:     lookup.KeyID,
		LookupHMAC:      lookup.HMAC,
	}, nil
}

func (codec *IdentityCodec) OpenEmail(sealed SealedIdentity) (string, error) {
	if codec == nil {
		return "", errors.New("identity decryption is unavailable")
	}
	key, ok := codec.encryptionKeys[sealed.EncryptionKeyID]
	if !ok {
		return "", errors.New("identity encryption key is unavailable")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", errors.New("identity decryption is unavailable")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(sealed.Nonce) != aead.NonceSize() {
		return "", errors.New("encrypted identity is malformed")
	}
	plaintext, err := aead.Open(nil, sealed.Nonce, sealed.Ciphertext, []byte(emailIdentityAAD))
	if err != nil {
		return "", errors.New("encrypted identity could not be authenticated")
	}
	normalized, err := NormalizeAdminEmail(string(plaintext))
	if err != nil || normalized != string(plaintext) {
		return "", errors.New("encrypted identity is malformed")
	}
	return normalized, nil
}

func (codec *IdentityCodec) LookupCandidates(raw string) []LookupIndex {
	if codec == nil {
		return nil
	}
	normalized, err := NormalizeAdminEmail(raw)
	if err != nil {
		return nil
	}
	indices := make([]LookupIndex, 0, len(codec.lookupOrder))
	for _, keyID := range codec.lookupOrder {
		indices = append(indices, codec.lookup(normalized, keyID))
	}
	return indices
}

func (codec *IdentityCodec) lookup(normalized, keyID string) LookupIndex {
	mac := hmac.New(sha256.New, codec.lookupKeys[keyID])
	_, _ = mac.Write([]byte("aera-admin.lookup.email.v1"))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(normalized))
	return LookupIndex{KeyID: keyID, HMAC: mac.Sum(nil)}
}

func copyKeyRing(keys map[string][]byte, minimumLength, maximumLength int) (map[string][]byte, error) {
	if len(keys) == 0 {
		return nil, errors.New("identity key ring is empty")
	}
	copied := make(map[string][]byte, len(keys))
	for keyID, material := range keys {
		if strings.TrimSpace(keyID) == "" || keyID != strings.TrimSpace(keyID) ||
			len(material) < minimumLength || len(material) > maximumLength {
			return nil, errors.New("identity key ring contains an invalid key")
		}
		copied[keyID] = append([]byte(nil), material...)
	}
	return copied, nil
}
