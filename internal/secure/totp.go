package secure

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const generatedTOTPSecretBytes = 20

type TOTP struct {
	Period time.Duration
	Digits int
	Issuer string
}

func DefaultTOTP() TOTP {
	return TOTP{Period: 30 * time.Second, Digits: 6, Issuer: "Aera Admin"}
}

func (totp TOTP) Generate() ([]byte, error) {
	if !totp.validCodeConfiguration() {
		return nil, errors.New("TOTP configuration is invalid")
	}
	return randomBytes(generatedTOTPSecretBytes)
}

func (totp TOTP) Code(secret []byte, at time.Time) string {
	if !totp.validCodeConfiguration() || len(secret) < generatedTOTPSecretBytes || at.Unix() < 0 {
		return ""
	}
	step := at.Unix() / int64(totp.Period/time.Second)
	return totp.codeAtStep(secret, step)
}

func (totp TOTP) Validate(secret []byte, code string, at time.Time, lastAcceptedStep int64) (int64, bool) {
	if !totp.validCodeConfiguration() || len(secret) < generatedTOTPSecretBytes || at.Unix() < 0 || lastAcceptedStep < -1 || !validTOTPCode(code, totp.Digits) {
		return 0, false
	}
	currentStep := at.Unix() / int64(totp.Period/time.Second)
	matchedStep := int64(-1)
	for _, candidate := range []int64{currentStep - 1, currentStep, currentStep + 1} {
		if candidate < 0 {
			continue
		}
		expected := totp.codeAtStep(secret, candidate)
		matches := subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1
		if matches && candidate > lastAcceptedStep && candidate > matchedStep {
			matchedStep = candidate
		}
	}
	if matchedStep < 0 {
		return 0, false
	}
	return matchedStep, true
}

func (totp TOTP) ProvisioningURI(secret []byte, account string) (string, error) {
	issuer := strings.TrimSpace(totp.Issuer)
	account = strings.TrimSpace(account)
	if !totp.validCodeConfiguration() || len(secret) < generatedTOTPSecretBytes ||
		!validTOTPLabelPart(issuer, 80) || !validTOTPLabelPart(account, 254) {
		return "", errors.New("TOTP provisioning information is invalid")
	}
	query := url.Values{}
	query.Set("secret", base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret))
	query.Set("issuer", issuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", strconv.Itoa(totp.Digits))
	query.Set("period", strconv.FormatInt(int64(totp.Period/time.Second), 10))
	provisioningURL := url.URL{
		Scheme:   "otpauth",
		Host:     "totp",
		Path:     "/" + issuer + ":" + account,
		RawQuery: query.Encode(),
	}
	return provisioningURL.String(), nil
}

func (totp TOTP) codeAtStep(secret []byte, step int64) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	mac := hmac.New(sha1.New, secret)
	_, _ = mac.Write(counter[:])
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 0x0f
	value := binary.BigEndian.Uint32(digest[offset:offset+4]) & 0x7fffffff
	modulus := uint32(1_000_000)
	if totp.Digits == 8 {
		modulus = 100_000_000
	}
	return fmt.Sprintf("%0*d", totp.Digits, value%modulus)
}

func (totp TOTP) validCodeConfiguration() bool {
	periodSeconds := int64(totp.Period / time.Second)
	return totp.Period%time.Second == 0 && periodSeconds >= 30 && periodSeconds <= 300 && (totp.Digits == 6 || totp.Digits == 8)
}

func validTOTPCode(code string, digits int) bool {
	if len(code) != digits {
		return false
	}
	for _, character := range code {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func validTOTPLabelPart(value string, maximumBytes int) bool {
	if value == "" || len(value) > maximumBytes || !utf8.ValidString(value) || strings.Contains(value, ":") {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}
