package secure

import (
	"strings"
	"testing"
)

func TestPasswordHasherUsesArgon2idAndRandomSalt(t *testing.T) {
	hasher := testPasswordHasher(t, 1)
	first, version, err := hasher.Hash("correct horse battery staple")
	if err != nil || version != 1 || !strings.Contains(first, "$aera-admin$1$argon2id$") {
		t.Fatalf("Hash() = %q, %d, %v", first, version, err)
	}
	if strings.Contains(first, "correct horse battery staple") {
		t.Fatal("password hash contains the plaintext password")
	}
	second, _, err := hasher.Hash("correct horse battery staple")
	if err != nil {
		t.Fatalf("second Hash() error = %v", err)
	}
	if first == second {
		t.Fatal("password hashes reused a salt")
	}

	ok, rehash, err := hasher.Verify("correct horse battery staple", first)
	if err != nil || !ok || rehash {
		t.Fatalf("Verify() = %v, %v, %v, want true, false, nil", ok, rehash, err)
	}
	ok, rehash, err = hasher.Verify("wrong password value", first)
	if err != nil || ok || rehash {
		t.Fatalf("Verify(wrong) = %v, %v, %v, want false, false, nil", ok, rehash, err)
	}
}

func TestPasswordHasherRequiresTwelveToOneHundredTwentyEightRunes(t *testing.T) {
	hasher := testPasswordHasher(t, 1)
	tests := []struct {
		name    string
		value   string
		wantErr bool
	}{
		{name: "eleven", value: "12345678901", wantErr: true},
		{name: "twelve unicode", value: "密码密码密码密码密码密码", wantErr: false},
		{name: "one hundred twenty eight", value: strings.Repeat("a", 128), wantErr: false},
		{name: "one hundred twenty nine", value: strings.Repeat("a", 129), wantErr: true},
		{name: "invalid UTF-8", value: string([]byte{0xff, 0xfe}) + strings.Repeat("a", 12), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := hasher.Hash(test.value)
			if (err != nil) != test.wantErr {
				t.Fatalf("Hash() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestPasswordHasherPinsParametersToRegisteredVersion(t *testing.T) {
	oldHasher := testPasswordHasher(t, 1)
	encoded, _, err := oldHasher.Hash("correct horse battery staple")
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}
	currentHasher := testPasswordHasher(t, 2)
	ok, rehash, err := currentHasher.Verify("correct horse battery staple", encoded)
	if err != nil || !ok || !rehash {
		t.Fatalf("Verify(old version) = %v, %v, %v, want true, true, nil", ok, rehash, err)
	}

	malformed := []string{
		"not-a-password-hash",
		"$agentera$1$argon2id$v=19$m=64,t=1,p=1$c2FsdA$aGFzaA",
		"$aera-admin$99$argon2id$v=19$m=64,t=1,p=1$c2FsdA$aGFzaA",
		"$aera-admin$2$argon2id$v=19$m=999999999,t=9,p=9$c2FsdA$aGFzaA",
		"$aera-admin$2$argon2id$v=18$m=128,t=2,p=1$c2FsdA$aGFzaA",
	}
	for _, value := range malformed {
		if _, _, err := currentHasher.Verify("correct horse battery staple", value); err == nil {
			t.Errorf("Verify() accepted malformed hash %q", value)
		}
	}
}

func TestDefaultPasswordHasherUsesApprovedProductionParameters(t *testing.T) {
	hasher, err := DefaultPasswordHasher()
	if err != nil {
		t.Fatalf("DefaultPasswordHasher() error = %v", err)
	}
	params := hasher.Params(hasher.CurrentVersion())
	if params != (Argon2Params{MemoryKiB: 64 * 1024, Iterations: 3, Parallelism: 1, SaltLength: 16, KeyLength: 32}) {
		t.Fatalf("default parameters = %+v", params)
	}
}

func testPasswordHasher(t *testing.T, currentVersion int) *PasswordHasher {
	t.Helper()
	hasher, err := NewPasswordHasher(PasswordHasherConfig{
		CurrentVersion: currentVersion,
		Versions: map[int]Argon2Params{
			1: {MemoryKiB: 64, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32},
			2: {MemoryKiB: 128, Iterations: 2, Parallelism: 1, SaltLength: 16, KeyLength: 32},
		},
	})
	if err != nil {
		t.Fatalf("NewPasswordHasher() error = %v", err)
	}
	return hasher
}
