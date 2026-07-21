package audit

import (
	"bytes"
	"encoding/binary"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/bignormal/aera-admin/internal/rbac"
	"github.com/google/uuid"
)

type Outcome string

const (
	OutcomeSuccess Outcome = "success"
	OutcomeFailure Outcome = "failure"
	OutcomeDenied  Outcome = "denied"
)

var (
	ErrInvalidRecord = errors.New("administrator audit record is invalid")
	ErrSensitiveText = errors.New("administrator audit record contains sensitive text")
	ErrIntegrity     = errors.New("administrator audit chain integrity check failed")

	namePattern       = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,99}$`)
	reasonPattern     = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)
	requestPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	ticketPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
	errorCodePattern  = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,99}$`)
	stateValuePattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	emailPattern      = regexp.MustCompile(`(?i)[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+`)
	phonePattern      = regexp.MustCompile(`(?:\+?86[ -]?)?1[3-9](?:[ -]?[0-9]){9}`)
	jwtPattern        = regexp.MustCompile(`[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}`)
	credentialPattern = regexp.MustCompile(`(?i)(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:password|secret|token|cookie)\s*[:=]\s*\S{6,})`)
	privateKeyPattern = regexp.MustCompile(`(?i)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	serviceURLPattern = regexp.MustCompile(`(?i)(?:postgres(?:ql)?|redis)://`)

	allowedStateKeys = map[string]struct{}{
		"account_status":   {},
		"active":           {},
		"approval_status":  {},
		"device_status":    {},
		"execution_status": {},
		"mfa_status":       {},
		"reason_code":      {},
		"role":             {},
		"security_version": {},
		"session_status":   {},
		"status":           {},
	}
)

type Record struct {
	ActorAdminID    *uuid.UUID
	ActorRole       rbac.Role
	EventType       string
	ObjectType      string
	ObjectID        *uuid.UUID
	Outcome         Outcome
	ReasonCode      string
	TicketReference string
	Note            string
	ApprovalID      *uuid.UUID
	OperationID     *uuid.UUID
	ErrorCode       string
	BeforeState     map[string]string
	AfterState      map[string]string
	RequestID       string
	SourceIPHMAC    []byte
	UserAgent       string
}

type auditEvent struct {
	ID           uuid.UUID
	Record       Record
	PreviousHash []byte
	EventHash    []byte
	CreatedAt    time.Time
}

func prepareRecord(record Record) (Record, error) {
	if !namePattern.MatchString(record.EventType) || !namePattern.MatchString(record.ObjectType) ||
		(record.Outcome != OutcomeSuccess && record.Outcome != OutcomeFailure && record.Outcome != OutcomeDenied) ||
		(record.ReasonCode != "" && !reasonPattern.MatchString(record.ReasonCode)) ||
		(record.TicketReference != "" && !ticketPattern.MatchString(record.TicketReference)) ||
		(record.ErrorCode != "" && !errorCodePattern.MatchString(record.ErrorCode)) ||
		!requestPattern.MatchString(record.RequestID) ||
		(len(record.SourceIPHMAC) != 0 && len(record.SourceIPHMAC) != 32) {
		return Record{}, ErrInvalidRecord
	}
	if !validOptionalUUID(record.ActorAdminID) || !validOptionalUUID(record.ObjectID) ||
		!validOptionalUUID(record.ApprovalID) || !validOptionalUUID(record.OperationID) {
		return Record{}, ErrInvalidRecord
	}
	if (record.ActorAdminID == nil) != (record.ActorRole == "") || (record.ActorRole != "" && !record.ActorRole.Valid()) {
		return Record{}, ErrInvalidRecord
	}

	prepared := record
	prepared.ActorAdminID = cloneOptionalUUID(record.ActorAdminID)
	prepared.ObjectID = cloneOptionalUUID(record.ObjectID)
	prepared.ApprovalID = cloneOptionalUUID(record.ApprovalID)
	prepared.OperationID = cloneOptionalUUID(record.OperationID)
	prepared.TicketReference = strings.TrimSpace(record.TicketReference)
	prepared.Note = strings.TrimSpace(record.Note)
	if !validFreeText(prepared.Note, 500) {
		return Record{}, ErrInvalidRecord
	}
	prepared.UserAgent = sanitizeUserAgent(record.UserAgent)
	if record.UserAgent != "" && prepared.UserAgent == "" {
		return Record{}, ErrInvalidRecord
	}
	if containsSensitiveText(prepared.Note) || containsSensitiveText(prepared.TicketReference) || containsSensitiveText(prepared.UserAgent) {
		return Record{}, ErrSensitiveText
	}
	beforeState, err := prepareState(record.BeforeState)
	if err != nil {
		return Record{}, err
	}
	afterState, err := prepareState(record.AfterState)
	if err != nil {
		return Record{}, err
	}
	prepared.BeforeState = beforeState
	prepared.AfterState = afterState
	prepared.SourceIPHMAC = append([]byte(nil), record.SourceIPHMAC...)
	return prepared, nil
}

func validOptionalUUID(value *uuid.UUID) bool {
	return value == nil || *value != uuid.Nil
}

func cloneOptionalUUID(value *uuid.UUID) *uuid.UUID {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func validFreeText(value string, maximumRunes int) bool {
	if value == "" {
		return true
	}
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximumRunes {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func sanitizeUserAgent(raw string) string {
	if raw == "" || !utf8.ValidString(raw) {
		return ""
	}
	cleaned := strings.Map(func(character rune) rune {
		if unicode.IsControl(character) {
			return ' '
		}
		return character
	}, raw)
	cleaned = strings.Join(strings.Fields(cleaned), " ")
	if len(cleaned) <= 512 {
		return cleaned
	}
	var truncated strings.Builder
	for _, character := range cleaned {
		if truncated.Len()+utf8.RuneLen(character) > 512 {
			break
		}
		truncated.WriteRune(character)
	}
	return truncated.String()
}

func prepareState(state map[string]string) (map[string]string, error) {
	if len(state) == 0 {
		return nil, nil
	}
	if len(state) > len(allowedStateKeys) {
		return nil, ErrInvalidRecord
	}
	prepared := make(map[string]string, len(state))
	for key, value := range state {
		if _, allowed := allowedStateKeys[key]; !allowed || !stateValuePattern.MatchString(value) {
			return nil, ErrInvalidRecord
		}
		if containsSensitiveText(value) {
			return nil, ErrSensitiveText
		}
		prepared[key] = value
	}
	return prepared, nil
}

func containsSensitiveText(value string) bool {
	if value == "" {
		return false
	}
	return emailPattern.MatchString(value) || phonePattern.MatchString(value) || jwtPattern.MatchString(value) ||
		credentialPattern.MatchString(value) || privateKeyPattern.MatchString(value) || serviceURLPattern.MatchString(value) ||
		strings.Contains(strings.ToLower(value), "__host-aera_admin_session")
}

func canonicalBytes(event auditEvent) []byte {
	var encoded bytes.Buffer
	writeCanonicalBytes(&encoded, []byte("aera-admin.audit.v1"))
	writeCanonicalBytes(&encoded, event.ID[:])
	writeOptionalUUID(&encoded, event.Record.ActorAdminID)
	writeCanonicalBytes(&encoded, []byte(event.Record.ActorRole))
	writeCanonicalBytes(&encoded, []byte(event.Record.EventType))
	writeCanonicalBytes(&encoded, []byte(event.Record.ObjectType))
	writeOptionalUUID(&encoded, event.Record.ObjectID)
	writeCanonicalBytes(&encoded, []byte(event.Record.Outcome))
	writeCanonicalBytes(&encoded, []byte(event.Record.ReasonCode))
	writeCanonicalBytes(&encoded, []byte(event.Record.TicketReference))
	writeCanonicalBytes(&encoded, []byte(event.Record.Note))
	writeOptionalUUID(&encoded, event.Record.ApprovalID)
	writeOptionalUUID(&encoded, event.Record.OperationID)
	writeCanonicalBytes(&encoded, []byte(event.Record.ErrorCode))
	writeCanonicalState(&encoded, event.Record.BeforeState)
	writeCanonicalState(&encoded, event.Record.AfterState)
	writeCanonicalBytes(&encoded, []byte(event.Record.RequestID))
	writeCanonicalBytes(&encoded, event.Record.SourceIPHMAC)
	writeCanonicalBytes(&encoded, []byte(event.Record.UserAgent))
	var createdAt [8]byte
	binary.BigEndian.PutUint64(createdAt[:], uint64(event.CreatedAt.UnixMicro()))
	writeCanonicalBytes(&encoded, createdAt[:])
	return encoded.Bytes()
}

func writeOptionalUUID(target *bytes.Buffer, value *uuid.UUID) {
	if value == nil {
		writeCanonicalBytes(target, nil)
		return
	}
	writeCanonicalBytes(target, value[:])
}

func writeCanonicalState(target *bytes.Buffer, state map[string]string) {
	keys := make([]string, 0, len(state))
	for key := range state {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var count [4]byte
	binary.BigEndian.PutUint32(count[:], uint32(len(keys)))
	_, _ = target.Write(count[:])
	for _, key := range keys {
		writeCanonicalBytes(target, []byte(key))
		writeCanonicalBytes(target, []byte(state[key]))
	}
}

func writeCanonicalBytes(target *bytes.Buffer, value []byte) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(value)))
	_, _ = target.Write(length[:])
	_, _ = target.Write(value)
}
