package secure

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	minimumPasswordRunes = 12
	maximumPasswordRunes = 128
)

type Argon2Params struct {
	MemoryKiB   uint32
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

type PasswordHasherConfig struct {
	CurrentVersion int
	Versions       map[int]Argon2Params
}

type PasswordHasher struct {
	currentVersion int
	versions       map[int]Argon2Params
}

func NewPasswordHasher(config PasswordHasherConfig) (*PasswordHasher, error) {
	if config.CurrentVersion <= 0 || len(config.Versions) == 0 {
		return nil, errors.New("password parameter versions are required")
	}
	versions := make(map[int]Argon2Params, len(config.Versions))
	for version, params := range config.Versions {
		if version <= 0 || !validArgon2Params(params) {
			return nil, errors.New("password parameter version is invalid")
		}
		versions[version] = params
	}
	if _, ok := versions[config.CurrentVersion]; !ok {
		return nil, errors.New("current password parameter version is unavailable")
	}
	return &PasswordHasher{currentVersion: config.CurrentVersion, versions: versions}, nil
}

func DefaultPasswordHasher() (*PasswordHasher, error) {
	return NewPasswordHasher(PasswordHasherConfig{
		CurrentVersion: 1,
		Versions: map[int]Argon2Params{
			1: {
				MemoryKiB:   64 * 1024,
				Iterations:  3,
				Parallelism: 1,
				SaltLength:  16,
				KeyLength:   32,
			},
		},
	})
}

func (hasher *PasswordHasher) Hash(password string) (string, int, error) {
	if hasher == nil || !validPasswordLength(password) {
		return "", 0, errors.New("password must contain between 12 and 128 characters")
	}
	params, ok := hasher.versions[hasher.currentVersion]
	if !ok {
		return "", 0, errors.New("password hashing is unavailable")
	}
	salt, err := randomBytes(int(params.SaltLength))
	if err != nil {
		return "", 0, err
	}
	digest := argon2.IDKey([]byte(password), salt, params.Iterations, params.MemoryKiB, params.Parallelism, params.KeyLength)
	encoded := fmt.Sprintf(
		"$aera-admin$%d$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		hasher.currentVersion,
		argon2.Version,
		params.MemoryKiB,
		params.Iterations,
		params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(digest),
	)
	return encoded, hasher.currentVersion, nil
}

func (hasher *PasswordHasher) Verify(password, encoded string) (bool, bool, error) {
	if hasher == nil {
		return false, false, errors.New("password verification is unavailable")
	}
	if !validPasswordLength(password) {
		return false, false, nil
	}
	version, params, salt, expected, err := hasher.parse(encoded)
	if err != nil {
		return false, false, err
	}
	actual := argon2.IDKey([]byte(password), salt, params.Iterations, params.MemoryKiB, params.Parallelism, params.KeyLength)
	if subtle.ConstantTimeCompare(actual, expected) != 1 {
		return false, false, nil
	}
	return true, version != hasher.currentVersion, nil
}

func (hasher *PasswordHasher) CurrentVersion() int {
	if hasher == nil {
		return 0
	}
	return hasher.currentVersion
}

func (hasher *PasswordHasher) Params(version int) Argon2Params {
	if hasher == nil {
		return Argon2Params{}
	}
	return hasher.versions[version]
}

func (hasher *PasswordHasher) parse(encoded string) (int, Argon2Params, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 8 || parts[0] != "" || parts[1] != "aera-admin" || parts[3] != "argon2id" || parts[4] != "v=19" {
		return 0, Argon2Params{}, nil, nil, errors.New("password hash is malformed")
	}
	version, err := strconv.Atoi(parts[2])
	if err != nil {
		return 0, Argon2Params{}, nil, nil, errors.New("password hash version is malformed")
	}
	params, ok := hasher.versions[version]
	if !ok {
		return 0, Argon2Params{}, nil, nil, errors.New("password hash version is unsupported")
	}
	wantParams := fmt.Sprintf("m=%d,t=%d,p=%d", params.MemoryKiB, params.Iterations, params.Parallelism)
	if parts[5] != wantParams {
		return 0, Argon2Params{}, nil, nil, errors.New("password hash parameters do not match their version")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[6])
	if err != nil || len(salt) != int(params.SaltLength) {
		return 0, Argon2Params{}, nil, nil, errors.New("password hash salt is malformed")
	}
	digest, err := base64.RawStdEncoding.DecodeString(parts[7])
	if err != nil || len(digest) != int(params.KeyLength) {
		return 0, Argon2Params{}, nil, nil, errors.New("password hash digest is malformed")
	}
	return version, params, salt, digest, nil
}

func validPasswordLength(password string) bool {
	if !utf8.ValidString(password) {
		return false
	}
	length := utf8.RuneCountInString(password)
	return length >= minimumPasswordRunes && length <= maximumPasswordRunes
}

func validArgon2Params(params Argon2Params) bool {
	return params.MemoryKiB >= 8*uint32(params.Parallelism) && params.MemoryKiB <= 1024*1024 &&
		params.Iterations > 0 && params.Iterations <= 10 &&
		params.Parallelism > 0 && params.Parallelism <= 16 &&
		params.SaltLength >= 16 && params.SaltLength <= 64 &&
		params.KeyLength >= 32 && params.KeyLength <= 64
}
