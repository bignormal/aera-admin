# Aera Admin Foundation V1 Admin-only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Aera Admin side of Cloud user, device, session, approval, idempotency, reliable execution, and health management without changing `aera-cloud` or presenting simulated Cloud success.

**Architecture:** The existing React SPA and Go BFF keep the current independent administrator authentication, mandatory TOTP, fixed RBAC, and append-only audit. New Cloud-control application services persist approvals, idempotency records, and an Outbox in Admin PostgreSQL, while a strictly configured mTLS plus short-lived service-JWT client consumes a versioned Cloud Internal Admin API contract. When that external API is not configured or cannot be trusted, every Cloud read and mutation fails closed and the UI renders an explicit unavailable state.

**Tech Stack:** Go 1.26.5, Chi v5, pgx v5, PostgreSQL 17, go-redis v9, React 19, TypeScript 5.9, Vite 7, Ant Design 5, TanStack Query 5, React Hook Form 7, Zod 4, Vitest 4, Testing Library, Playwright 1.61, pnpm 11.

## Global Constraints

- Implement only in `/Users/zizimutou/Desktop/aera/aera-admin`; do not modify `aera-cloud`, `aera`, `aera-api`, `aera-runtime`, or `aera-guanwang`.
- Preserve the existing six fixed roles: `super_admin`, `developer`, `operator`, `support`, `finance`, and `auditor`.
- Preserve independent administrator password plus mandatory TOTP authentication, the hardened session cookie, CSRF/Origin checks, 10-minute TOTP Step-up, and append-only audit.
- Never connect Admin directly to the Cloud database and never duplicate Cloud users into Admin PostgreSQL.
- Cloud calls require both a trusted mTLS client certificate and a service JWT with `aud=aera-cloud-admin`, minimal scopes, unique `jti`, and a lifetime no longer than 5 minutes.
- The Admin service identity key is distinct from all Aera Cloud user-token signing keys.
- Exact email/phone search uses POST JSON and the raw input must not enter URLs, browser storage, TanStack Query keys, logs, traces, metrics, audit, PostgreSQL, Redis, or responses.
- Cloud identity fields returned to the browser are masked; the BFF rejects an unexpected or unmasked upstream identity.
- Cloud-disabled, TLS failure, token failure, timeout, contract mismatch, and unknown-result states must never render or return success.
- Production code contains no in-memory fake Cloud client that returns users or successful mutations; test doubles remain in `_test.go` files or an E2E-only build target.
- Every Cloud-affecting execution (device/session revoke and approved account lifecycle) is accepted only with a validated `Idempotency-Key`, standard reason code, recent TOTP Step-up, and the required RBAC permission; review reject/cancel uses row-state concurrency instead of creating an operation.
- Account disable/restore is initiated only by `operator` and approved or rejected only by a different `super_admin`.
- Approval status and execution status remain independent; approval never implies execution success.
- Use the existing React/Ant Design Aera tokens and compact RuoYi-Plus-Soybean visual language; do not add Vue.
- Every behavior is developed test-first and every independently reviewable task ends in a focused commit.
- Local validation, commit, push, deployment, and release are reported as separate states.

---

## File Map

- `internal/store/migrations/000005_cloud_control.sql` owns approval, idempotency, and Outbox constraints; `internal/store/migrate_test.go` proves them.
- `internal/config/config.go` owns fail-closed Cloud and operation-key configuration; `.env.example` documents only safe defaults.
- `internal/cloudadmin/{client,contract,http_client,token}.go` owns the one-way Cloud consumer boundary, whitelisted DTOs, mTLS transport, and request-scoped service JWT.
- `internal/operations/{model,repository,service,worker}.go` owns idempotent operation acceptance, Outbox persistence, delivery, retry, and reconciliation.
- `internal/approval/{model,repository,service}.go` owns dual-control account lifecycle state and immutable approval events.
- `internal/cloudcontrol/{service,http}.go` owns Browser BFF orchestration, RBAC, Step-up enforcement, stable errors, and response shaping.
- `api/openapi/admin.yaml` remains the Browser contract; `api/openapi/cloud-admin-client.yaml` is the versioned consumer contract snapshot.
- `web/src/api`, `web/src/components`, and the three scoped page modules own typed Browser access and the RuoYi-Plus-Soybean-style UI without moving security decisions out of the BFF.
- `e2e/cloud-stub/main.go` is the only non-`_test.go` test double and is compiled only with the `e2e` build tag; `scripts/run-e2e.sh` owns its ephemeral PKI and lifecycle.
- `cmd/aera-admin/main.go` composes production dependencies and supervises the HTTP server plus Outbox Worker; it never selects the E2E stub.

The complete create/modify tree and cross-task type definitions are collected in **File Structure** and **Shared Interfaces** at the end of this plan. Those definitions are normative for every task.

### Task 1: Constrained Approval, Idempotency, and Outbox Schema

**Files:**
- Create: `internal/store/migrations/000005_cloud_control.sql`
- Modify: `internal/store/migrate_test.go`

**Interfaces:**
- Produces: `approval_requests`, `approval_events`, `admin_idempotency_records`, and `admin_outbox`.
- Produces: one pending request per `(target_user_id, action)` and one browser idempotency record per `(actor_admin_id, action, idempotency_key_hmac)`.
- Produces: append-only database enforcement for `approval_events`.

- [ ] **Step 1: Write the failing migration acceptance test**

Add this test to `internal/store/migrate_test.go`:

```go
func TestMigrateCreatesConstrainedCloudControlSchema(t *testing.T) {
    postgres := testPostgres(t)
    ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
    defer cancel()
    if err := Migrate(ctx, postgres); err != nil {
        t.Fatalf("Migrate() error = %v", err)
    }
    for _, table := range []string{
        "approval_requests", "approval_events", "admin_idempotency_records", "admin_outbox",
    } {
        assertTableExists(t, ctx, postgres, table)
    }
    assertCheckConstraint(t, ctx, postgres, "approval_requests", "approval_requests_approval_status_check")
    assertCheckConstraint(t, ctx, postgres, "approval_requests", "approval_requests_execution_status_check")
    assertCheckConstraint(t, ctx, postgres, "admin_outbox", "admin_outbox_status_check")
    assertUniqueColumns(t, ctx, postgres, "admin_idempotency_records", "admin_idempotency_actor_key", []string{
        "actor_admin_id", "action", "idempotency_key_hmac",
    })

    actorID := uuid.New()
    seedActiveAdministrator(t, ctx, postgres, actorID, rbac.Operator)
    requestID := uuid.New()
    _, err := postgres.Exec(ctx, `
        INSERT INTO approval_requests (
            id, action, target_user_id, target_snapshot, requested_by_admin_id, requested_by_role,
            reason_code, expected_revision, approval_status, execution_status, expires_at,
            created_at, updated_at, version
        ) VALUES ($1, 'disable_user', $2, $3, $4, 'operator', 'policy_violation', 7,
            'pending_review', 'not_started', now() + interval '24 hours', now(), now(), 1)
    `, requestID, uuid.New(), `{"user_id":"019f0000-0000-7000-8000-000000000001","masked_email":"a***@example.test"}`, actorID)
    if err != nil {
        t.Fatalf("insert approval request: %v", err)
    }
    eventID := uuid.New()
    _, err = postgres.Exec(ctx, `
        INSERT INTO approval_events (
            id, approval_request_id, actor_admin_id, actor_role, event_type,
            before_status, after_status, request_id, created_at
        ) VALUES ($1, $2, $3, 'operator', 'created', '', 'pending_review', 'req-schema', now())
    `, eventID, requestID, actorID)
    if err != nil {
        t.Fatalf("insert approval event: %v", err)
    }
    if _, err := postgres.Exec(ctx, `UPDATE approval_events SET event_type = 'cancelled' WHERE id = $1`, eventID); err == nil {
        t.Fatal("approval event update unexpectedly succeeded")
    }
    if _, err := postgres.Exec(ctx, `DELETE FROM approval_events WHERE id = $1`, eventID); err == nil {
        t.Fatal("approval event delete unexpectedly succeeded")
    }
}
```

Reuse the existing test helper that inserts an active administrator; if its current name differs, extract the existing insert statements into exactly this helper:

```go
func seedActiveAdministrator(t *testing.T, ctx context.Context, postgres *pgxpool.Pool, id uuid.UUID, role rbac.Role) {
    t.Helper()
    _, err := postgres.Exec(ctx, `
        INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
        VALUES ($1, 'Schema Actor', $2, 'active', 1, now(), now())
    `, id, role)
    if err != nil {
        t.Fatalf("seed active administrator: %v", err)
    }
}
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/store -run TestMigrateCreatesConstrainedCloudControlSchema -count=1 -v
```

Expected: FAIL because `approval_requests` does not exist.

- [ ] **Step 3: Add the complete constrained migration**

Create `internal/store/migrations/000005_cloud_control.sql` with these definitions:

```sql
CREATE TABLE approval_requests (
    id UUID PRIMARY KEY,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT 'cloud_user',
    target_user_id UUID NOT NULL,
    target_snapshot JSONB NOT NULL,
    requested_by_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    requested_by_role TEXT NOT NULL,
    reviewed_by_admin_id UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL REFERENCES reason_codes(code) ON DELETE RESTRICT,
    ticket_reference TEXT,
    note TEXT,
    expected_revision BIGINT NOT NULL,
    approval_status TEXT NOT NULL,
    execution_status TEXT NOT NULL,
    operation_id UUID UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    version BIGINT NOT NULL,
    CONSTRAINT approval_requests_action_check CHECK (action IN ('disable_user', 'enable_user')),
    CONSTRAINT approval_requests_target_type_check CHECK (target_type = 'cloud_user'),
    CONSTRAINT approval_requests_role_check CHECK (requested_by_role = 'operator'),
    CONSTRAINT approval_requests_reason_check CHECK (char_length(btrim(reason_code)) BETWEEN 3 AND 64),
    CONSTRAINT approval_requests_ticket_check CHECK (ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 128),
    CONSTRAINT approval_requests_note_check CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    CONSTRAINT approval_requests_revision_check CHECK (expected_revision > 0),
    CONSTRAINT approval_requests_approval_status_check CHECK (
        approval_status IN ('pending_review', 'approved', 'rejected', 'expired', 'cancelled')
    ),
    CONSTRAINT approval_requests_execution_status_check CHECK (
        execution_status IN ('not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT approval_requests_snapshot_check CHECK (jsonb_typeof(target_snapshot) = 'object'),
    CONSTRAINT approval_requests_reviewer_check CHECK (
        reviewed_by_admin_id IS NULL OR reviewed_by_admin_id <> requested_by_admin_id
    ),
    CONSTRAINT approval_requests_review_state_check CHECK (
        (approval_status = 'pending_review' AND reviewed_by_admin_id IS NULL AND reviewed_at IS NULL) OR
        (approval_status IN ('approved', 'rejected') AND reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL) OR
        (approval_status IN ('expired', 'cancelled') AND reviewed_by_admin_id IS NULL AND reviewed_at IS NULL)
    ),
    CONSTRAINT approval_requests_execution_operation_check CHECK (
        (execution_status = 'not_started' AND operation_id IS NULL) OR
        (execution_status <> 'not_started' AND approval_status = 'approved' AND operation_id IS NOT NULL)
    ),
    CONSTRAINT approval_requests_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT approval_requests_timestamps_check CHECK (
        updated_at >= created_at AND (reviewed_at IS NULL OR reviewed_at >= created_at)
    ),
    CONSTRAINT approval_requests_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX approval_requests_one_pending_target_action
    ON approval_requests (target_user_id, action)
    WHERE approval_status = 'pending_review';
CREATE INDEX approval_requests_status_created_idx
    ON approval_requests (approval_status, created_at DESC, id);
CREATE INDEX approval_requests_requester_created_idx
    ON approval_requests (requested_by_admin_id, created_at DESC, id);

CREATE TABLE approval_events (
    id UUID PRIMARY KEY,
    approval_request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    actor_role TEXT NOT NULL,
    event_type TEXT NOT NULL,
    before_status TEXT NOT NULL,
    after_status TEXT NOT NULL,
    result_code TEXT,
    request_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT approval_events_role_check CHECK (
        actor_role IN ('super_admin', 'developer', 'operator', 'support', 'finance', 'auditor')
    ),
    CONSTRAINT approval_events_type_check CHECK (
        event_type IN ('created', 'approved', 'rejected', 'cancelled', 'expired',
            'execution_queued', 'execution_started', 'execution_reconciling',
            'execution_succeeded', 'execution_failed', 'execution_conflict')
    ),
    CONSTRAINT approval_events_before_check CHECK (
        before_status = '' OR before_status IN ('pending_review', 'approved', 'rejected', 'expired', 'cancelled',
            'not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT approval_events_after_check CHECK (
        after_status IN ('pending_review', 'approved', 'rejected', 'expired', 'cancelled',
            'not_started', 'queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT approval_events_result_check CHECK (
        result_code IS NULL OR result_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
    ),
    CONSTRAINT approval_events_request_check CHECK (char_length(request_id) BETWEEN 1 AND 128)
);

CREATE INDEX approval_events_request_created_idx
    ON approval_events (approval_request_id, created_at, id);

CREATE TABLE admin_idempotency_records (
    operation_id UUID PRIMARY KEY,
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    idempotency_key_hmac BYTEA NOT NULL,
    request_hash BYTEA NOT NULL,
    state TEXT NOT NULL,
    error_code TEXT,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT admin_idempotency_actor_key UNIQUE (actor_admin_id, action, idempotency_key_hmac),
    CONSTRAINT admin_idempotency_action_check CHECK (
        action IN ('revoke_device', 'revoke_session', 'disable_user', 'enable_user')
    ),
    CONSTRAINT admin_idempotency_key_length_check CHECK (octet_length(idempotency_key_hmac) = 32),
    CONSTRAINT admin_idempotency_request_length_check CHECK (octet_length(request_hash) = 32),
    CONSTRAINT admin_idempotency_state_check CHECK (
        state IN ('queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT admin_idempotency_error_check CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
    CONSTRAINT admin_idempotency_result_check CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    CONSTRAINT admin_idempotency_timestamps_check CHECK (
        updated_at >= created_at AND expires_at > created_at AND
        (completed_at IS NULL OR completed_at >= created_at)
    )
);

CREATE INDEX admin_idempotency_expiry_idx
    ON admin_idempotency_records (expires_at, operation_id);

CREATE TABLE admin_outbox (
    operation_id UUID PRIMARY KEY REFERENCES admin_idempotency_records(operation_id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    target_id UUID NOT NULL,
    approval_id UUID REFERENCES approval_requests(id) ON DELETE RESTRICT,
    actor_admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
    actor_role TEXT NOT NULL,
    idempotency_key_hmac BYTEA NOT NULL,
    expected_revision BIGINT NOT NULL,
    reason_code TEXT NOT NULL REFERENCES reason_codes(code) ON DELETE RESTRICT,
    ticket_reference TEXT,
    note TEXT,
    request_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    available_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    CONSTRAINT admin_outbox_action_check CHECK (
        action IN ('revoke_device', 'revoke_session', 'disable_user', 'enable_user')
    ),
    CONSTRAINT admin_outbox_revision_check CHECK (expected_revision > 0),
    CONSTRAINT admin_outbox_role_check CHECK (
        actor_role IN ('super_admin', 'developer', 'operator', 'support', 'finance', 'auditor')
    ),
    CONSTRAINT admin_outbox_key_length_check CHECK (octet_length(idempotency_key_hmac) = 32),
    CONSTRAINT admin_outbox_ticket_check CHECK (ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 128),
    CONSTRAINT admin_outbox_note_check CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
    CONSTRAINT admin_outbox_request_check CHECK (char_length(request_id) BETWEEN 1 AND 128),
    CONSTRAINT admin_outbox_status_check CHECK (
        status IN ('queued', 'executing', 'reconciling', 'succeeded', 'failed', 'conflict')
    ),
    CONSTRAINT admin_outbox_attempts_check CHECK (attempts >= 0),
    CONSTRAINT admin_outbox_error_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
    CONSTRAINT admin_outbox_timestamps_check CHECK (
        updated_at >= created_at AND available_at >= created_at AND
        (lease_until IS NULL OR lease_until >= updated_at) AND
        (completed_at IS NULL OR completed_at >= created_at)
    )
);

CREATE INDEX admin_outbox_claim_idx
    ON admin_outbox (available_at, created_at, operation_id)
    WHERE status IN ('queued', 'reconciling');

CREATE FUNCTION reject_approval_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'approval events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER approval_events_append_only
    BEFORE UPDATE OR DELETE ON approval_events
    FOR EACH ROW EXECUTE FUNCTION reject_approval_event_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON approval_events FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aera_admin_runtime') THEN
        EXECUTE format('GRANT SELECT, INSERT ON %I.approval_events TO aera_admin_runtime', current_schema());
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.approval_events FROM aera_admin_runtime', current_schema());
    END IF;
END;
$$;
```

- [ ] **Step 4: Run migration and store tests**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/store -count=1 -v
```

Expected: PASS, including rejection of `approval_events` update and delete.

- [ ] **Step 5: Commit the schema**

```bash
git add internal/store/migrations/000005_cloud_control.sql internal/store/migrate_test.go
git commit -m "feat: add admin cloud control schema"
```

### Task 2: Strict Cloud and Operation Configuration

**Files:**
- Modify: `internal/config/config.go`
- Modify: `internal/config/config_test.go`
- Modify: `.env.example`

**Interfaces:**
- Produces: `config.Config.CloudAdmin config.CloudAdminConfig`.
- Produces: `config.Config.OperationHMACKey []byte` as a separate cryptographic domain key.
- Consumes: the existing `LookupEnv`, key decoding, URL validation, and defensive-copy patterns.

- [ ] **Step 1: Write failing disabled/enabled configuration tests**

Add to `internal/config/config_test.go`:

```go
func TestLoadKeepsCloudExplicitlyDisabled(t *testing.T) {
    values := validEnvironment()
    values["AERA_ADMIN_CLOUD_ENABLED"] = "false"
    loaded, err := Load(mapLookup(values))
    if err != nil {
        t.Fatalf("Load() error = %v", err)
    }
    if loaded.CloudAdmin.Enabled || loaded.CloudAdmin.BaseURL != "" {
        t.Fatalf("CloudAdmin = %+v", loaded.CloudAdmin)
    }
}

func TestLoadRequiresCompleteCloudIdentityWhenEnabled(t *testing.T) {
    required := []string{
        "AERA_ADMIN_CLOUD_BASE_URL",
        "AERA_ADMIN_CLOUD_CA_FILE",
        "AERA_ADMIN_CLOUD_CLIENT_CERT_FILE",
        "AERA_ADMIN_CLOUD_CLIENT_KEY_FILE",
        "AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE",
        "AERA_ADMIN_CLOUD_JWT_ISSUER",
        "AERA_ADMIN_CLOUD_JWT_SUBJECT",
        "AERA_ADMIN_CLOUD_SCOPES",
    }
    for _, key := range required {
        t.Run(key, func(t *testing.T) {
            values := validCloudEnvironment()
            delete(values, key)
            _, err := Load(mapLookup(values))
            if err == nil || !strings.Contains(err.Error(), key) {
                t.Fatalf("Load() error = %v, want %s", err, key)
            }
        })
    }
}

func TestLoadRejectsUnsafeCloudConfiguration(t *testing.T) {
    cases := map[string]func(map[string]string){
        "non-https base URL": func(values map[string]string) { values["AERA_ADMIN_CLOUD_BASE_URL"] = "http://cloud.example.test" },
        "relative CA file": func(values map[string]string) { values["AERA_ADMIN_CLOUD_CA_FILE"] = "certs/ca.pem" },
        "empty scope": func(values map[string]string) { values["AERA_ADMIN_CLOUD_SCOPES"] = `[]` },
        "wildcard scope": func(values map[string]string) { values["AERA_ADMIN_CLOUD_SCOPES"] = `["*"]` },
    }
    for name, mutate := range cases {
        t.Run(name, func(t *testing.T) {
            values := validCloudEnvironment()
            mutate(values)
            if _, err := Load(mapLookup(values)); err == nil {
                t.Fatal("Load() accepted unsafe Cloud configuration")
            }
        })
    }
}

func validCloudEnvironment() map[string]string {
    values := validEnvironment()
    values["AERA_ADMIN_CLOUD_ENABLED"] = "true"
    values["AERA_ADMIN_CLOUD_BASE_URL"] = "https://cloud-admin.example.test"
    values["AERA_ADMIN_CLOUD_CA_FILE"] = "/run/secrets/cloud-ca.pem"
    values["AERA_ADMIN_CLOUD_CLIENT_CERT_FILE"] = "/run/secrets/admin-client.pem"
    values["AERA_ADMIN_CLOUD_CLIENT_KEY_FILE"] = "/run/secrets/admin-client-key.pem"
    values["AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE"] = "/run/secrets/admin-service-ed25519.pem"
    values["AERA_ADMIN_CLOUD_JWT_ISSUER"] = "aera-admin"
    values["AERA_ADMIN_CLOUD_JWT_SUBJECT"] = "aera-admin-production"
    values["AERA_ADMIN_CLOUD_SCOPES"] = `["users:read","devices:write","sessions:write","accounts:write","operations:read"]`
    return values
}
```

Add `AERA_ADMIN_OPERATION_HMAC_KEY` to `TestLoadRequiresEverySecuritySecret`. Extend `validEnvironment()` with both required baseline values:

```go
"AERA_ADMIN_OPERATION_HMAC_KEY": encodedKey(6),
"AERA_ADMIN_CLOUD_ENABLED":     "false",
```

- [ ] **Step 2: Run configuration tests and verify failure**

Run: `go test ./internal/config -run 'TestLoad(KeepsCloud|RequiresCompleteCloud|RejectsUnsafeCloud|RequiresEverySecurity)' -count=1 -v`

Expected: FAIL because `Config.CloudAdmin`, `CloudAdminConfig`, and `OperationHMACKey` are absent.

- [ ] **Step 3: Implement exact Cloud configuration parsing**

Add these types and parser to `internal/config/config.go`:

```go
type CloudAdminConfig struct {
    Enabled           bool
    BaseURL           string
    CAFile            string
    ClientCertFile    string
    ClientKeyFile     string
    JWTSigningKeyFile string
    JWTIssuer         string
    JWTSubject        string
    Scopes            []string
}

type Config struct {
    Environment            string
    ListenAddr             string
    PublicURL              string
    DatabaseURL            string
    RedisAddr              string
    TrustedProxyCIDRs      []netip.Prefix
    IdentityEncryptionKeys KeyRing
    IdentityLookupKeys     KeyRing
    TOTPEncryptionKeys     KeyRing
    SessionHMACKey         []byte
    CSRFHMACKey            []byte
    OperationHMACKey       []byte
    CloudAdmin             CloudAdminConfig
}

func loadCloudAdmin(lookup LookupEnv) (CloudAdminConfig, error) {
    raw, ok := lookup("AERA_ADMIN_CLOUD_ENABLED")
    if !ok || (raw != "true" && raw != "false") {
        return CloudAdminConfig{}, errors.New("AERA_ADMIN_CLOUD_ENABLED must be true or false")
    }
    if raw == "false" {
        return CloudAdminConfig{}, nil
    }
    baseURL, err := required(lookup, "AERA_ADMIN_CLOUD_BASE_URL")
    if err != nil { return CloudAdminConfig{}, err }
    parsed, err := url.Parse(baseURL)
    if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
        parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
        return CloudAdminConfig{}, errors.New("AERA_ADMIN_CLOUD_BASE_URL must be an HTTPS origin")
    }
    parsed.Path = ""
    absoluteFile := func(name string) (string, error) {
        value, requiredErr := required(lookup, name)
        if requiredErr != nil { return "", requiredErr }
        if !filepath.IsAbs(value) || filepath.Clean(value) != value {
            return "", fmt.Errorf("%s must be an absolute clean path", name)
        }
        return value, nil
    }
    caFile, err := absoluteFile("AERA_ADMIN_CLOUD_CA_FILE")
    if err != nil { return CloudAdminConfig{}, err }
    certFile, err := absoluteFile("AERA_ADMIN_CLOUD_CLIENT_CERT_FILE")
    if err != nil { return CloudAdminConfig{}, err }
    keyFile, err := absoluteFile("AERA_ADMIN_CLOUD_CLIENT_KEY_FILE")
    if err != nil { return CloudAdminConfig{}, err }
    signingFile, err := absoluteFile("AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE")
    if err != nil { return CloudAdminConfig{}, err }
    issuer, err := required(lookup, "AERA_ADMIN_CLOUD_JWT_ISSUER")
    if err != nil { return CloudAdminConfig{}, err }
    subject, err := required(lookup, "AERA_ADMIN_CLOUD_JWT_SUBJECT")
    if err != nil { return CloudAdminConfig{}, err }
    if !serviceIdentityName.MatchString(issuer) || !serviceIdentityName.MatchString(subject) {
        return CloudAdminConfig{}, errors.New("Cloud JWT issuer and subject must be stable service identifiers")
    }
    scopes, err := parseStringSet(lookup, "AERA_ADMIN_CLOUD_SCOPES", 16, scopeName)
    if err != nil { return CloudAdminConfig{}, err }
    return CloudAdminConfig{
        Enabled: true, BaseURL: parsed.String(), CAFile: caFile, ClientCertFile: certFile,
        ClientKeyFile: keyFile, JWTSigningKeyFile: signingFile, JWTIssuer: issuer,
        JWTSubject: subject, Scopes: scopes,
    }, nil
}
```

Define the strict patterns and JSON string-set helper in the same file:

```go
var (
    serviceIdentityName = regexp.MustCompile(`^[a-z][a-z0-9._-]{2,63}$`)
    scopeName = regexp.MustCompile(`^[a-z][a-z0-9:_-]{2,63}$`)
)

func parseStringSet(lookup LookupEnv, name string, maximum int, pattern *regexp.Regexp) ([]string, error) {
    raw, err := required(lookup, name)
    if err != nil { return nil, err }
    var values []string
    decoder := json.NewDecoder(strings.NewReader(raw))
    if err := decoder.Decode(&values); err != nil || ensureJSONEnd(decoder) != nil || len(values) == 0 || len(values) > maximum {
        return nil, fmt.Errorf("%s must contain one bounded JSON array", name)
    }
    seen := make(map[string]struct{}, len(values))
    for _, value := range values {
        if !pattern.MatchString(value) || value == "*" {
            return nil, fmt.Errorf("%s contains an invalid value", name)
        }
        if _, duplicate := seen[value]; duplicate {
            return nil, fmt.Errorf("%s contains a duplicate value", name)
        }
        seen[value] = struct{}{}
    }
    sort.Strings(values)
    return values, nil
}
```

Inside `Load`, decode `AERA_ADMIN_OPERATION_HMAC_KEY`, call `loadCloudAdmin`, and copy both values into `Config`.

- [ ] **Step 4: Document safe disabled and enabled environment fields**

Append this exact block to `.env.example`:

```dotenv
AERA_ADMIN_OPERATION_HMAC_KEY=BASE64_32_BYTE_KEY
AERA_ADMIN_CLOUD_ENABLED=false
# When enabled, every value below is mandatory. Keep all files outside the repository and image.
# AERA_ADMIN_CLOUD_BASE_URL=https://cloud-admin.internal.example
# AERA_ADMIN_CLOUD_CA_FILE=/run/secrets/aera-cloud-admin-ca.pem
# AERA_ADMIN_CLOUD_CLIENT_CERT_FILE=/run/secrets/aera-admin-client.pem
# AERA_ADMIN_CLOUD_CLIENT_KEY_FILE=/run/secrets/aera-admin-client-key.pem
# AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE=/run/secrets/aera-admin-service-ed25519.pem
# AERA_ADMIN_CLOUD_JWT_ISSUER=aera-admin
# AERA_ADMIN_CLOUD_JWT_SUBJECT=aera-admin-production
# AERA_ADMIN_CLOUD_SCOPES=["users:read","devices:write","sessions:write","accounts:write","operations:read"]
```

- [ ] **Step 5: Run all configuration tests**

Run: `go test ./internal/config -count=1 -v`

Expected: PASS with disabled mode accepted and incomplete enabled mode rejected.

- [ ] **Step 6: Commit strict configuration**

```bash
git add internal/config/config.go internal/config/config_test.go .env.example
git commit -m "feat: configure cloud admin service identity"
```

### Task 3: Cloud Consumer Contract and Fail-closed Domain Types

**Files:**
- Create: `internal/cloudadmin/client.go`
- Create: `internal/cloudadmin/client_test.go`
- Create: `internal/cloudadmin/contract.go`
- Create: `internal/cloudadmin/contract_test.go`
- Create: `api/openapi/cloud-admin-client.yaml`
- Modify: `api/openapi_test.go`

**Interfaces:**
- Produces: the `cloudadmin.Client` interface from Shared Interfaces.
- Produces: whitelisted `User`, `Device`, `Session`, `Operation`, page, lookup, and health DTOs.
- Produces: `ErrNotConfigured`, `ErrUnavailable`, `ErrContractViolation`, `ErrNotFound`, and `ErrConflict`.
- Produces: a consumer OpenAPI snapshot that contains no server implementation.

- [ ] **Step 1: Write failing whitelist and disabled-client tests**

Create `internal/cloudadmin/contract_test.go`:

```go
package cloudadmin

import (
    "testing"
    "time"

    "github.com/google/uuid"
)

func TestValidateUserAcceptsOnlyMaskedIdentity(t *testing.T) {
    valid := User{
        ID: uuid.New(), MaskedEmail: "a***@example.test", Status: UserActive,
        AdministrativeRevision: 7, CreatedAt: time.Now().UTC(),
    }
    if err := valid.Validate(); err != nil {
        t.Fatalf("valid user rejected: %v", err)
    }
    for _, identity := range []string{"alice@example.test", "a**@example.test", "a***@", ""} {
        candidate := valid
        candidate.MaskedEmail = identity
        if identity == "" { candidate.MaskedPhone = "138****1234" }
        if identity != "" {
            if err := candidate.Validate(); err == nil {
                t.Fatalf("unmasked or malformed identity %q accepted", identity)
            }
        } else if err := candidate.Validate(); err != nil {
            t.Fatalf("masked phone rejected: %v", err)
        }
    }
}

func TestValidateUserRejectsSensitiveOrUnknownState(t *testing.T) {
    user := User{
        ID: uuid.New(), MaskedEmail: "a***@example.test", Status: UserStatus("owner@example.test"),
        AdministrativeRevision: 1, CreatedAt: time.Now().UTC(),
    }
    if err := user.Validate(); !errors.Is(err, ErrContractViolation) {
        t.Fatalf("Validate() error = %v", err)
    }
}
```

Create `internal/cloudadmin/client_test.go`:

```go
package cloudadmin

import (
    "context"
    "errors"
    "testing"

    "github.com/google/uuid"
)

func TestDisabledClientFailsEveryCloudCapabilityClosed(t *testing.T) {
    client := DisabledClient{}
    if health, err := client.Health(context.Background()); !errors.Is(err, ErrNotConfigured) || health.Availability != NotConfigured {
        t.Fatalf("Health() = %+v, %v", health, err)
    }
    if _, err := client.GetUser(context.Background(), uuid.New()); !errors.Is(err, ErrNotConfigured) {
        t.Fatalf("GetUser() error = %v", err)
    }
    if _, err := client.RevokeSession(context.Background(), uuid.New(), CommandMeta{}); !errors.Is(err, ErrNotConfigured) {
        t.Fatalf("RevokeSession() error = %v", err)
    }
}
```

- [ ] **Step 2: Run the package tests and verify failure**

Run: `go test ./internal/cloudadmin -count=1 -v`

Expected: FAIL because the package and DTOs do not exist.

- [ ] **Step 3: Implement the complete whitelisted contract**

Create `internal/cloudadmin/contract.go`:

```go
package cloudadmin

import (
    "errors"
    "regexp"
    "time"

    "github.com/google/uuid"
)

var (
    ErrNotConfigured    = errors.New("Cloud administration is not configured")
    ErrUnavailable      = errors.New("Cloud administration is unavailable")
    ErrContractViolation = errors.New("Cloud administration contract violation")
    ErrNotFound         = errors.New("Cloud administration target not found")
    ErrConflict         = errors.New("Cloud administration state conflict")

    maskedEmailPattern = regexp.MustCompile(`^[^@*[:space:]]\*{3}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
    maskedPhonePattern = regexp.MustCompile(`^[0-9]{3}\*{4}[0-9]{4}$`)
    cursorPattern      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,512}$`)
    errorCodePattern   = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,99}$`)
)

type Availability string
const (
    NotConfigured Availability = "not_configured"
    Available Availability = "available"
    Unavailable Availability = "unavailable"
    ContractError Availability = "contract_error"
)

type CheckStatus string
const (
    CheckNotChecked CheckStatus = "not_checked"
    CheckOK CheckStatus = "ok"
    CheckUnavailable CheckStatus = "unavailable"
    CheckContractError CheckStatus = "contract_error"
)

type Health struct {
    Configured   bool         `json:"configured"`
    Availability Availability `json:"availability"`
    MTLS         CheckStatus  `json:"mtls"`
    ServiceJWT   CheckStatus  `json:"service_jwt"`
    Upstream     CheckStatus  `json:"upstream"`
    CheckedAt    time.Time    `json:"checked_at"`
}

type IdentityKind string
const (
    IdentityEmail IdentityKind = "email"
    IdentityPhone IdentityKind = "phone"
)

type UserStatus string
const (
    UserActive UserStatus = "active"
    UserPendingDeletion UserStatus = "pending_deletion"
    UserDisabled UserStatus = "disabled"
)

type DeviceStatus string
const (
    DeviceActive DeviceStatus = "active"
    DeviceInactive DeviceStatus = "inactive"
    DeviceRevoked DeviceStatus = "revoked"
)

type SessionStatus string
const (
    SessionActive SessionStatus = "active"
    SessionRotated SessionStatus = "rotated"
    SessionExpired SessionStatus = "expired"
    SessionRevoked SessionStatus = "revoked"
    SessionReplayDetected SessionStatus = "replay_detected"
)

type OperationStatus string
const (
    OperationQueued OperationStatus = "queued"
    OperationExecuting OperationStatus = "executing"
    OperationSucceeded OperationStatus = "succeeded"
    OperationFailed OperationStatus = "failed"
    OperationConflict OperationStatus = "conflict"
)

type PageRequest struct {
    Cursor string
    Limit  int
}

type ListUsersRequest struct {
    PageRequest
    Status UserStatus
}

type LookupRequest struct {
    Kind  IdentityKind `json:"type"`
    Value string       `json:"value"`
}

type Page[T any] struct {
    Items      []T    `json:"items"`
    NextCursor string `json:"next_cursor,omitempty"`
}

type User struct {
    ID                     uuid.UUID  `json:"user_id"`
    MaskedEmail            string     `json:"masked_email,omitempty"`
    MaskedPhone            string     `json:"masked_phone,omitempty"`
    Status                 UserStatus `json:"status"`
    AdministrativelyDisabled bool      `json:"administratively_disabled"`
    DeletionFinalizedAt      *time.Time `json:"deletion_finalized_at,omitempty"`
    AdministrativeRevision int64      `json:"administrative_revision"`
    DeviceCount            int        `json:"device_count"`
    ActiveDeviceCount      int        `json:"active_device_count"`
    ActiveSessionCount     int        `json:"active_session_count"`
    CreatedAt              time.Time  `json:"created_at"`
    LastCloudActivityAt    *time.Time `json:"last_cloud_activity_at,omitempty"`
}

type Device struct {
    ID            uuid.UUID    `json:"device_id"`
    UserID        uuid.UUID    `json:"user_id"`
    DisplayName   string       `json:"display_name"`
    Platform      string       `json:"platform"`
    ClientVersion string       `json:"client_version"`
    Status        DeviceStatus `json:"status"`
    LastSeenAt    *time.Time   `json:"last_seen_at,omitempty"`
}

type Session struct {
    ID        uuid.UUID     `json:"session_id"`
    UserID    uuid.UUID     `json:"user_id"`
    DeviceID  uuid.UUID     `json:"device_id"`
    Status    SessionStatus `json:"status"`
    IssuedAt  time.Time     `json:"issued_at"`
    ExpiresAt time.Time     `json:"expires_at"`
    RevokedAt *time.Time    `json:"revoked_at,omitempty"`
}

type Operation struct {
    ID                     uuid.UUID       `json:"operation_id"`
    Status                 OperationStatus `json:"status"`
    ErrorCode              string          `json:"error_code,omitempty"`
    AdministrativeRevision int64           `json:"administrative_revision,omitempty"`
    UpdatedAt              time.Time       `json:"updated_at"`
}

func (user User) Validate() error {
    emailOK := user.MaskedEmail == "" || maskedEmailPattern.MatchString(user.MaskedEmail)
    phoneOK := user.MaskedPhone == "" || maskedPhonePattern.MatchString(user.MaskedPhone)
    statusOK := user.Status == UserActive || user.Status == UserPendingDeletion || user.Status == UserDisabled
    if user.ID == uuid.Nil || (!emailOK || !phoneOK) || (user.MaskedEmail == "" && user.MaskedPhone == "") ||
        !statusOK || user.AdministrativeRevision <= 0 || user.DeviceCount < 0 ||
        user.ActiveDeviceCount < 0 || user.ActiveSessionCount < 0 || user.CreatedAt.IsZero() {
        return ErrContractViolation
    }
    return nil
}

func validateCursor(cursor string) error {
    if cursor != "" && !cursorPattern.MatchString(cursor) { return ErrContractViolation }
    return nil
}

func validateOperation(operation Operation) error {
    statusOK := operation.Status == OperationQueued || operation.Status == OperationExecuting ||
        operation.Status == OperationSucceeded || operation.Status == OperationFailed || operation.Status == OperationConflict
    if operation.ID == uuid.Nil || !statusOK || operation.UpdatedAt.IsZero() ||
        (operation.ErrorCode != "" && !errorCodePattern.MatchString(operation.ErrorCode)) {
        return ErrContractViolation
    }
    return nil
}

func (device Device) Validate() error {
    statusOK := device.Status == DeviceActive || device.Status == DeviceInactive || device.Status == DeviceRevoked
    if device.ID == uuid.Nil || device.UserID == uuid.Nil || !statusOK ||
        !validBoundedLabel(device.DisplayName, 100) || !validBoundedLabel(device.Platform, 32) ||
        !validBoundedLabel(device.ClientVersion, 64) {
        return ErrContractViolation
    }
    return nil
}

func (session Session) Validate() error {
    statusOK := session.Status == SessionActive || session.Status == SessionRotated || session.Status == SessionExpired ||
        session.Status == SessionRevoked || session.Status == SessionReplayDetected
    if session.ID == uuid.Nil || session.UserID == uuid.Nil || session.DeviceID == uuid.Nil || !statusOK ||
        session.IssuedAt.IsZero() || !session.ExpiresAt.After(session.IssuedAt) ||
        (session.RevokedAt != nil && session.RevokedAt.Before(session.IssuedAt)) {
        return ErrContractViolation
    }
    return nil
}

func validateUserPage(page Page[User]) error {
    if page.Items == nil || validateCursor(page.NextCursor) != nil { return ErrContractViolation }
    for _, item := range page.Items { if err := item.Validate(); err != nil { return err } }
    return nil
}

func validateDevicePage(page Page[Device]) error {
    if page.Items == nil || validateCursor(page.NextCursor) != nil { return ErrContractViolation }
    for _, item := range page.Items { if err := item.Validate(); err != nil { return err } }
    return nil
}

func validateSessionPage(page Page[Session]) error {
    if page.Items == nil || validateCursor(page.NextCursor) != nil { return ErrContractViolation }
    for _, item := range page.Items { if err := item.Validate(); err != nil { return err } }
    return nil
}

func validBoundedLabel(value string, maximum int) bool {
    if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > maximum ||
        strings.Contains(value, "@") || phonePattern.MatchString(value) {
        return false
    }
    for _, character := range value { if unicode.IsControl(character) { return false } }
    return true
}
```

Add this declaration beside the existing contract patterns, and import `strings`, `unicode`, and `unicode/utf8` for the validators above:

```go
phonePattern = regexp.MustCompile(`(?:\+?86)?1[3-9][0-9]{9}`)
```

Create `internal/cloudadmin/client.go` with the `Client` and `CommandMeta` definitions in **Shared Interfaces**, followed by this complete disabled implementation:

```go
type DisabledClient struct{}

func (DisabledClient) Health(context.Context) (Health, error) {
    return Health{Configured:false, Availability:NotConfigured, MTLS:CheckNotChecked,
        ServiceJWT:CheckNotChecked, Upstream:CheckNotChecked}, ErrNotConfigured
}
func (DisabledClient) ListUsers(context.Context, ListUsersRequest) (Page[User], error) {
    return Page[User]{}, ErrNotConfigured
}
func (DisabledClient) LookupUser(context.Context, LookupRequest) (User, error) {
    return User{}, ErrNotConfigured
}
func (DisabledClient) GetUser(context.Context, uuid.UUID) (User, error) {
    return User{}, ErrNotConfigured
}
func (DisabledClient) ListUserDevices(context.Context, uuid.UUID, PageRequest) (Page[Device], error) {
    return Page[Device]{}, ErrNotConfigured
}
func (DisabledClient) ListUserSessions(context.Context, uuid.UUID, PageRequest) (Page[Session], error) {
    return Page[Session]{}, ErrNotConfigured
}
func (DisabledClient) RevokeDevice(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
    return Operation{}, ErrNotConfigured
}
func (DisabledClient) RevokeSession(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
    return Operation{}, ErrNotConfigured
}
func (DisabledClient) DisableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
    return Operation{}, ErrNotConfigured
}
func (DisabledClient) EnableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error) {
    return Operation{}, ErrNotConfigured
}
func (DisabledClient) GetOperation(context.Context, uuid.UUID) (Operation, error) {
    return Operation{}, ErrNotConfigured
}
```

- [ ] **Step 4: Add the consumer OpenAPI snapshot and safety assertion**

Create `api/openapi/cloud-admin-client.yaml` with OpenAPI `3.1.0`, both `mutualTLS` and bearer security requirements, and exactly these operations:

```yaml
openapi: 3.1.0
info:
  title: Aera Cloud Internal Admin API Consumer Contract
  version: 0.1.0
servers:
  - url: https://aera-cloud-admin.invalid
security:
  - mutualTLS: []
    serviceJWT: []
paths:
  /internal/admin/v1/health:
    get:
      operationId: getCloudAdminHealth
      responses:
        '200':
          description: Internal Admin API is ready
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Health' }
  /internal/admin/v1/users:
    get:
      operationId: listCloudUsers
      parameters:
        - { $ref: '#/components/parameters/Cursor' }
        - { $ref: '#/components/parameters/Limit' }
        - name: status
          in: query
          schema: { $ref: '#/components/schemas/UserStatus' }
      responses:
        '200':
          description: Masked Cloud user page
          content:
            application/json:
              schema: { $ref: '#/components/schemas/UserPage' }
  /internal/admin/v1/users/lookup:
    post:
      operationId: lookupCloudUser
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/LookupRequest' }
      responses:
        '200':
          description: One masked Cloud user
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
  /internal/admin/v1/users/{userID}:
    get:
      operationId: getCloudUser
      parameters: [{ $ref: '#/components/parameters/UserID' }]
      responses:
        '200':
          description: One masked Cloud user
          content:
            application/json:
              schema: { $ref: '#/components/schemas/User' }
  /internal/admin/v1/users/{userID}/devices:
    get:
      operationId: listCloudUserDevices
      parameters:
        - { $ref: '#/components/parameters/UserID' }
        - { $ref: '#/components/parameters/Cursor' }
        - { $ref: '#/components/parameters/Limit' }
      responses:
        '200':
          description: Device page
          content:
            application/json:
              schema: { $ref: '#/components/schemas/DevicePage' }
  /internal/admin/v1/users/{userID}/sessions:
    get:
      operationId: listCloudUserSessions
      parameters:
        - { $ref: '#/components/parameters/UserID' }
        - { $ref: '#/components/parameters/Cursor' }
        - { $ref: '#/components/parameters/Limit' }
      responses:
        '200':
          description: Session page
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SessionPage' }
  /internal/admin/v1/devices/{deviceID}/revoke:
    post:
      operationId: revokeCloudDevice
      parameters:
        - { $ref: '#/components/parameters/DeviceID' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
      requestBody: { $ref: '#/components/requestBodies/Command' }
      responses: { '200': { $ref: '#/components/responses/Operation' } }
  /internal/admin/v1/sessions/{sessionID}/revoke:
    post:
      operationId: revokeCloudSession
      parameters:
        - { $ref: '#/components/parameters/SessionID' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
      requestBody: { $ref: '#/components/requestBodies/Command' }
      responses: { '200': { $ref: '#/components/responses/Operation' } }
  /internal/admin/v1/users/{userID}/disable:
    post:
      operationId: disableCloudUser
      parameters:
        - { $ref: '#/components/parameters/UserID' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
      requestBody: { $ref: '#/components/requestBodies/Command' }
      responses: { '200': { $ref: '#/components/responses/Operation' } }
  /internal/admin/v1/users/{userID}/enable:
    post:
      operationId: enableCloudUser
      parameters:
        - { $ref: '#/components/parameters/UserID' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
      requestBody: { $ref: '#/components/requestBodies/Command' }
      responses: { '200': { $ref: '#/components/responses/Operation' } }
  /internal/admin/v1/operations/{operationID}:
    get:
      operationId: getCloudAdminOperation
      parameters: [{ $ref: '#/components/parameters/OperationID' }]
      responses: { '200': { $ref: '#/components/responses/Operation' } }
components:
  securitySchemes:
    mutualTLS: { type: mutualTLS }
    serviceJWT: { type: http, scheme: bearer, bearerFormat: JWT }
  parameters:
    Cursor: { name: cursor, in: query, schema: { type: string, maxLength: 512 } }
    Limit: { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
    UserID: { name: userID, in: path, required: true, schema: { type: string, format: uuid } }
    DeviceID: { name: deviceID, in: path, required: true, schema: { type: string, format: uuid } }
    SessionID: { name: sessionID, in: path, required: true, schema: { type: string, format: uuid } }
    OperationID: { name: operationID, in: path, required: true, schema: { type: string, format: uuid } }
    IdempotencyKey: { name: Idempotency-Key, in: header, required: true, schema: { type: string, format: uuid } }
  requestBodies:
    Command:
      required: true
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Command' }
  responses:
    Operation:
      description: Idempotent operation state
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Operation' }
  schemas:
    Health:
      type: object
      additionalProperties: false
      required: [status]
      properties: { status: { const: ok } }
    LookupRequest:
      type: object
      additionalProperties: false
      required: [type, value]
      properties:
        type: { enum: [email, phone] }
        value: { type: string, minLength: 3, maxLength: 320 }
    UserStatus: { enum: [active, pending_deletion, disabled] }
    User:
      type: object
      additionalProperties: false
      required: [user_id, status, administratively_disabled, administrative_revision, device_count, active_device_count, active_session_count, created_at]
      properties:
        user_id: { type: string, format: uuid }
        masked_email: { type: string, pattern: '^[^@* ]\*{3}@[A-Za-z0-9.-]+$' }
        masked_phone: { type: string, pattern: '^[0-9]{3}\*{4}[0-9]{4}$' }
        status: { $ref: '#/components/schemas/UserStatus' }
        administratively_disabled: { type: boolean }
        deletion_finalized_at: { type: string, format: date-time }
        administrative_revision: { type: integer, minimum: 1 }
        device_count: { type: integer, minimum: 0 }
        active_device_count: { type: integer, minimum: 0 }
        active_session_count: { type: integer, minimum: 0 }
        created_at: { type: string, format: date-time }
        last_cloud_activity_at: { type: string, format: date-time }
    UserPage:
      type: object
      additionalProperties: false
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/User' } }
        next_cursor: { type: string, maxLength: 512 }
    DevicePage:
      type: object
      additionalProperties: false
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/Device' } }
        next_cursor: { type: string, maxLength: 512 }
    SessionPage:
      type: object
      additionalProperties: false
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/Session' } }
        next_cursor: { type: string, maxLength: 512 }
    Device:
      type: object
      additionalProperties: false
      required: [device_id, user_id, display_name, platform, client_version, status]
      properties:
        device_id: { type: string, format: uuid }
        user_id: { type: string, format: uuid }
        display_name: { type: string, minLength: 1, maxLength: 100 }
        platform: { type: string, minLength: 1, maxLength: 32 }
        client_version: { type: string, minLength: 1, maxLength: 64 }
        status: { enum: [active, inactive, revoked] }
        last_seen_at: { type: string, format: date-time }
    Session:
      type: object
      additionalProperties: false
      required: [session_id, user_id, device_id, status, issued_at, expires_at]
      properties:
        session_id: { type: string, format: uuid }
        user_id: { type: string, format: uuid }
        device_id: { type: string, format: uuid }
        status: { enum: [active, rotated, expired, revoked, replay_detected] }
        issued_at: { type: string, format: date-time }
        expires_at: { type: string, format: date-time }
        revoked_at: { type: string, format: date-time }
    Command:
      type: object
      additionalProperties: false
      required: [operation_id, actor_admin_id, request_id, reason_code, expected_revision]
      properties:
        operation_id: { type: string, format: uuid }
        actor_admin_id: { type: string, format: uuid }
        approval_id: { type: string, format: uuid }
        request_id: { type: string, minLength: 1, maxLength: 128 }
        reason_code: { type: string, pattern: '^[a-z][a-z0-9_]{2,63}$' }
        ticket_reference: { type: string, minLength: 1, maxLength: 128 }
        note: { type: string, minLength: 1, maxLength: 500 }
        expected_revision: { type: integer, minimum: 1 }
    Operation:
      type: object
      additionalProperties: false
      required: [operation_id, status, updated_at]
      properties:
        operation_id: { type: string, format: uuid }
        status: { enum: [queued, executing, succeeded, failed, conflict] }
        error_code: { type: string, pattern: '^[A-Z][A-Z0-9_]{2,99}$' }
        administrative_revision: { type: integer, minimum: 1 }
        updated_at: { type: string, format: date-time }
```

Add this separate consumer-contract test to `api/openapi_test.go`:

```go
func TestCloudConsumerContract(t *testing.T) {
    encoded, err := os.ReadFile("openapi/cloud-admin-client.yaml")
    if err != nil { t.Fatal("read Cloud Admin consumer contract") }
    var document map[string]any
    if err := yaml.Unmarshal(encoded, &document); err != nil { t.Fatal("parse Cloud Admin consumer contract") }
    paths := object(t, document["paths"], "Cloud paths")
    if len(paths) != 11 { t.Fatalf("Cloud path count = %d, want 11", len(paths)) }
    raw := string(encoded)
    for _, operationID := range []string{
        "getCloudAdminHealth", "listCloudUsers", "lookupCloudUser", "getCloudUser",
        "listCloudUserDevices", "listCloudUserSessions", "revokeCloudDevice",
        "revokeCloudSession", "disableCloudUser", "enableCloudUser", "getCloudAdminOperation",
    } {
        if !strings.Contains(raw, "operationId: "+operationID) { t.Errorf("missing %s", operationID) }
    }
    components := object(t, document["components"], "Cloud components")
    schemes := object(t, components["securitySchemes"], "Cloud security schemes")
    if object(t, schemes["mutualTLS"], "mutualTLS")["type"] != "mutualTLS" ||
        object(t, schemes["serviceJWT"], "serviceJWT")["scheme"] != "bearer" {
        t.Fatal("Cloud contract does not require mTLS plus service JWT")
    }
    schemas := object(t, components["schemas"], "Cloud schemas")
    for _, schemaName := range []string{"User", "Device", "Session", "Operation"} {
        properties := object(t, object(t, schemas[schemaName], schemaName)["properties"], schemaName+" properties")
        for _, forbidden := range []string{"email", "phone", "identity_ciphertext", "token", "public_key"} {
            if _, present := properties[forbidden]; present { t.Errorf("%s exposes %s", schemaName, forbidden) }
        }
    }
}
```

- [ ] **Step 5: Run contract and package tests**

Run:

```bash
go test ./internal/cloudadmin ./api -count=1 -v
```

Expected: PASS with the disabled client failing closed and contract safety assertions passing.

- [ ] **Step 6: Commit the consumer boundary**

```bash
git add internal/cloudadmin api/openapi/cloud-admin-client.yaml api/openapi_test.go
git commit -m "feat: define cloud admin consumer contract"
```

### Task 4: mTLS and Short-lived Service-JWT HTTP Client

**Files:**
- Create: `internal/cloudadmin/token.go`
- Create: `internal/cloudadmin/token_test.go`
- Create: `internal/cloudadmin/http_client.go`
- Create: `internal/cloudadmin/http_client_test.go`

**Interfaces:**
- Consumes: `config.CloudAdminConfig` and all DTO validators from Task 3.
- Produces: `cloudadmin.NewHTTPClient(config.CloudAdminConfig, func() time.Time) (Client, error)`.
- Produces: a request-scoped Ed25519 JWT; no token is persisted or shared with the browser.

- [ ] **Step 1: Write failing service-token tests**

Create `internal/cloudadmin/token_test.go` with an Ed25519 key generated by `ed25519.GenerateKey(rand.Reader)` and this assertion:

```go
func TestServiceTokenIsAudienceBoundShortLivedAndUnique(t *testing.T) {
    publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
    if err != nil { t.Fatal(err) }
    now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
    source, err := newTokenSource(privateKey, "aera-admin", "aera-admin-test", []string{"users:read"}, func() time.Time { return now })
    if err != nil { t.Fatal(err) }
    first, err := source.Token(context.Background())
    if err != nil { t.Fatal(err) }
    second, err := source.Token(context.Background())
    if err != nil { t.Fatal(err) }
    if first == second { t.Fatal("service JWT jti was reused") }

    claims := verifyTestToken(t, publicKey, first)
    if claims.Audience != "aera-cloud-admin" || claims.Issuer != "aera-admin" ||
        claims.Subject != "aera-admin-test" || claims.ExpiresAt-claims.IssuedAt != 300 ||
        !slices.Equal(claims.Scopes, []string{"users:read"}) || claims.JWTID == "" {
        t.Fatalf("claims = %+v", claims)
    }
}

func TestServiceTokenRejectsWrongKeyTypeAndUnsafeIdentity(t *testing.T) {
    rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
    if err != nil { t.Fatal(err) }
    encoded, err := x509.MarshalPKCS8PrivateKey(rsaKey)
    if err != nil { t.Fatal(err) }
    if _, err := parseEd25519PrivateKey(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded})); err == nil {
        t.Fatal("RSA key accepted for Ed25519 service identity")
    }
    _, privateKey, err := ed25519.GenerateKey(rand.Reader)
    if err != nil { t.Fatal(err) }
    if _, err := newTokenSource(privateKey, "bad issuer", "aera-admin-test", []string{"users:read"}, time.Now); err == nil {
        t.Fatal("unsafe issuer accepted")
    }
}
```

Define the test verifier in the same file so the assertions exercise the encoded bytes, signature, and strict claim shape:

```go
func verifyTestToken(t *testing.T, publicKey ed25519.PublicKey, token string) serviceClaims {
    t.Helper()
    segments := strings.Split(token, ".")
    if len(segments) != 3 { t.Fatalf("JWT segment count = %d", len(segments)) }
    signed := segments[0] + "." + segments[1]
    signature, err := base64.RawURLEncoding.DecodeString(segments[2])
    if err != nil || !ed25519.Verify(publicKey, []byte(signed), signature) {
        t.Fatal("JWT signature is invalid")
    }
    body, err := base64.RawURLEncoding.DecodeString(segments[1])
    if err != nil { t.Fatal(err) }
    var claims serviceClaims
    decoder := json.NewDecoder(bytes.NewReader(body))
    decoder.DisallowUnknownFields()
    if err := decoder.Decode(&claims); err != nil { t.Fatal(err) }
    if err := ensureTokenJSONEnd(decoder); err != nil { t.Fatal(err) }
    return claims
}

func ensureTokenJSONEnd(decoder *json.Decoder) error {
    var extra any
    if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
        return errors.New("JWT claims contain trailing JSON")
    }
    return nil
}
```

- [ ] **Step 2: Run token tests and verify failure**

Run: `go test ./internal/cloudadmin -run TestServiceToken -count=1 -v`

Expected: FAIL because the token source does not exist.

- [ ] **Step 3: Implement the Ed25519 token source with standard library crypto**

Create `internal/cloudadmin/token.go`:

```go
package cloudadmin

import (
    "context"
    "crypto/ed25519"
    "crypto/rand"
    "crypto/x509"
    "encoding/base64"
    "encoding/json"
    "encoding/pem"
    "errors"
    "regexp"
    "strings"
    "time"
)

const serviceTokenLifetime = 5 * time.Minute
var serviceIdentityPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{2,63}$`)

type tokenSource interface { Token(context.Context) (string, error) }

type ed25519TokenSource struct {
    privateKey ed25519.PrivateKey
    issuer string
    subject string
    scopes []string
    clock func() time.Time
}

type serviceClaims struct {
    Issuer string `json:"iss"`
    Subject string `json:"sub"`
    Audience string `json:"aud"`
    Scopes []string `json:"scope"`
    IssuedAt int64 `json:"iat"`
    NotBefore int64 `json:"nbf"`
    ExpiresAt int64 `json:"exp"`
    JWTID string `json:"jti"`
}

func parseEd25519PrivateKey(raw []byte) (ed25519.PrivateKey, error) {
    block, rest := pem.Decode(raw)
    if block == nil || block.Type != "PRIVATE KEY" || len(strings.TrimSpace(string(rest))) != 0 {
        return nil, errors.New("service JWT signing key must contain one PKCS8 private key")
    }
    parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
    if err != nil { return nil, errors.New("service JWT signing key is invalid") }
    privateKey, ok := parsed.(ed25519.PrivateKey)
    if !ok || len(privateKey) != ed25519.PrivateKeySize {
        return nil, errors.New("service JWT signing key must be Ed25519")
    }
    return append(ed25519.PrivateKey(nil), privateKey...), nil
}

func newTokenSource(privateKey ed25519.PrivateKey, issuer, subject string, scopes []string, clock func() time.Time) (tokenSource, error) {
    if len(privateKey) != ed25519.PrivateKeySize || !serviceIdentityPattern.MatchString(issuer) ||
        !serviceIdentityPattern.MatchString(subject) || len(scopes) == 0 || clock == nil {
        return nil, errors.New("service JWT configuration is invalid")
    }
    return &ed25519TokenSource{
        privateKey: append(ed25519.PrivateKey(nil), privateKey...), issuer: issuer,
        subject: subject, scopes: append([]string(nil), scopes...), clock: clock,
    }, nil
}

func (source *ed25519TokenSource) Token(ctx context.Context) (string, error) {
    if err := ctx.Err(); err != nil { return "", err }
    identifier := make([]byte, 16)
    if _, err := rand.Read(identifier); err != nil { return "", errors.New("service JWT id could not be generated") }
    now := source.clock().UTC().Truncate(time.Second)
    claims := serviceClaims{
        Issuer: source.issuer, Subject: source.subject, Audience: "aera-cloud-admin",
        Scopes: append([]string(nil), source.scopes...), IssuedAt: now.Unix(), NotBefore: now.Add(-5 * time.Second).Unix(),
        ExpiresAt: now.Add(serviceTokenLifetime).Unix(), JWTID: base64.RawURLEncoding.EncodeToString(identifier),
    }
    header, _ := json.Marshal(map[string]string{"alg":"EdDSA", "typ":"JWT"})
    body, err := json.Marshal(claims)
    if err != nil { return "", errors.New("service JWT claims could not be encoded") }
    unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
    signature := ed25519.Sign(source.privateKey, []byte(unsigned))
    return unsigned + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}
```

- [ ] **Step 4: Write failing HTTP client tests with an ephemeral private PKI**

Create `internal/cloudadmin/http_client_test.go`. Use `crypto/x509.CreateCertificate` to generate one CA, one server certificate for `127.0.0.1`, and one client certificate. Write all four PEM files and one PKCS8 Ed25519 service key under `t.TempDir()`. Start `httptest.NewUnstartedServer`, set `server.TLS.ClientAuth = tls.RequireAndVerifyClientCert`, set `ClientCAs`, and use the generated server certificate.

The main assertion is:

```go
func TestHTTPClientRequiresMTLSAndAudienceBoundJWT(t *testing.T) {
    fixture := newTLSFixture(t)
    var observedAuthorization string
    var observedIdempotency string
    server := fixture.startServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
        if request.TLS == nil || len(request.TLS.PeerCertificates) != 1 { t.Error("client certificate was not presented") }
        observedAuthorization = request.Header.Get("Authorization")
        observedIdempotency = request.Header.Get("Idempotency-Key")
        if request.URL.Path != "/internal/admin/v1/sessions/019f0000-0000-7000-8000-000000000011/revoke" {
            t.Errorf("path = %q", request.URL.Path)
        }
        response.Header().Set("Content-Type", "application/json")
        _, _ = io.WriteString(response, `{"operation_id":"019f0000-0000-7000-8000-000000000012","status":"succeeded","updated_at":"2026-07-22T08:00:00Z"}`)
    }))
    defer server.Close()
    fixture.config.BaseURL = server.URL
    client, err := NewHTTPClient(fixture.config, fixture.clock)
    if err != nil { t.Fatal(err) }
    operationID := uuid.MustParse("019f0000-0000-7000-8000-000000000012")
    result, err := client.RevokeSession(context.Background(), uuid.MustParse("019f0000-0000-7000-8000-000000000011"), CommandMeta{
        OperationID: operationID, ActorAdminID: uuid.New(), RequestID: "req-client",
        ReasonCode: "suspected_compromise", ExpectedRevision: 1,
    })
    if err != nil || result.ID != operationID { t.Fatalf("result = %+v, %v", result, err) }
    if !strings.HasPrefix(observedAuthorization, "Bearer ") || observedIdempotency != operationID.String() {
        t.Fatalf("authentication headers = %q %q", observedAuthorization, observedIdempotency)
    }
}
```

Add this response table against the same mTLS fixture:

```go
func TestHTTPClientMapsUnsafeResponsesToStableErrors(t *testing.T) {
    cases := []struct {
        name string
        status int
        body string
        want error
    }{
        {"unknown field", 200, `{"user_id":"019f0000-0000-7000-8000-000000000001","masked_email":"a***@example.test","status":"active","administratively_disabled":false,"administrative_revision":1,"device_count":0,"active_device_count":0,"active_session_count":0,"created_at":"2026-07-22T08:00:00Z","secret_extra":"canary"}`, ErrContractViolation},
        {"raw identity", 200, `{"user_id":"019f0000-0000-7000-8000-000000000001","email":"raw@example.test","status":"active"}`, ErrContractViolation},
        {"not found", 404, `{"error":{"code":"USER_NOT_FOUND","message":"raw upstream canary"}}`, ErrNotFound},
        {"conflict", 409, `{"error":{"code":"USER_STATE_CONFLICT","message":"raw upstream canary"}}`, ErrConflict},
        {"redirect", 302, ``, ErrUnavailable},
    }
    for _, item := range cases {
        t.Run(item.name, func(t *testing.T) {
            client := newFixtureClient(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
                response.Header().Set("Content-Type", "application/json")
                response.WriteHeader(item.status)
                _, _ = io.WriteString(response, item.body)
            }))
            _, err := client.GetUser(context.Background(), uuid.MustParse("019f0000-0000-7000-8000-000000000001"))
            if !errors.Is(err, item.want) { t.Fatalf("GetUser() error = %v, want %v", err, item.want) }
            if err != nil && strings.Contains(err.Error(), "raw upstream canary") { t.Fatal("upstream body leaked through error") }
        })
    }
}

func TestHTTPClientRejectsOversizeAndTimeout(t *testing.T) {
    oversize := newFixtureClient(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
        response.Header().Set("Content-Type", "application/json")
        _, _ = response.Write(bytes.Repeat([]byte{'x'}, (1<<20)+2))
    }))
    if _, err := oversize.GetUser(context.Background(), uuid.New()); !errors.Is(err, ErrContractViolation) { t.Fatalf("oversize error = %v", err) }
    delayed := newFixtureClient(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
        time.Sleep(50 * time.Millisecond)
        response.WriteHeader(http.StatusOK)
    }))
    delayed.(*httpClient).client.Timeout = 10 * time.Millisecond
    if _, err := delayed.GetUser(context.Background(), uuid.New()); !errors.Is(err, ErrUnavailable) { t.Fatalf("timeout error = %v", err) }
}
```

Add these complete fixture helpers to `http_client_test.go`; they create all key material below `t.TempDir()` and register every server cleanup with `t.Cleanup`:

```go
type tlsFixture struct {
    config            config.CloudAdminConfig
    clock             func() time.Time
    serverCertificate tls.Certificate
    clientRoots       *x509.CertPool
}

func newTLSFixture(t *testing.T) *tlsFixture {
    t.Helper()
    now := time.Now().UTC()
    _, caKey, err := ed25519.GenerateKey(rand.Reader)
    if err != nil { t.Fatal(err) }
    caTemplate := &x509.Certificate{
        SerialNumber:big.NewInt(1), Subject:pkix.Name{CommonName:"Aera Admin Test CA"},
        NotBefore:now.Add(-time.Hour), NotAfter:now.Add(time.Hour), IsCA:true,
        BasicConstraintsValid:true, KeyUsage:x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
    }
    caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, caKey.Public(), caKey)
    if err != nil { t.Fatal(err) }
    caCertificate, err := x509.ParseCertificate(caDER)
    if err != nil { t.Fatal(err) }
    issue := func(serial int64, commonName string, usage x509.ExtKeyUsage, addresses []net.IP) (tls.Certificate, []byte, []byte) {
        t.Helper()
        _, privateKey, generateErr := ed25519.GenerateKey(rand.Reader)
        if generateErr != nil { t.Fatal(generateErr) }
        certificateTemplate := &x509.Certificate{
            SerialNumber:big.NewInt(serial), Subject:pkix.Name{CommonName:commonName},
            NotBefore:now.Add(-time.Hour), NotAfter:now.Add(time.Hour),
            KeyUsage:x509.KeyUsageDigitalSignature, ExtKeyUsage:[]x509.ExtKeyUsage{usage}, IPAddresses:addresses,
        }
        certificateDER, createErr := x509.CreateCertificate(rand.Reader, certificateTemplate, caCertificate, privateKey.Public(), caKey)
        if createErr != nil { t.Fatal(createErr) }
        encodedKey, marshalErr := x509.MarshalPKCS8PrivateKey(privateKey)
        if marshalErr != nil { t.Fatal(marshalErr) }
        certificatePEM := pem.EncodeToMemory(&pem.Block{Type:"CERTIFICATE", Bytes:certificateDER})
        keyPEM := pem.EncodeToMemory(&pem.Block{Type:"PRIVATE KEY", Bytes:encodedKey})
        pair, pairErr := tls.X509KeyPair(certificatePEM, keyPEM)
        if pairErr != nil { t.Fatal(pairErr) }
        return pair, certificatePEM, keyPEM
    }
    serverCertificate, _, _ := issue(2, "aera-cloud-test", x509.ExtKeyUsageServerAuth, []net.IP{net.ParseIP("127.0.0.1")})
    _, clientCertificatePEM, clientKeyPEM := issue(3, "aera-admin-test", x509.ExtKeyUsageClientAuth, nil)
    _, serviceKey, err := ed25519.GenerateKey(rand.Reader)
    if err != nil { t.Fatal(err) }
    encodedServiceKey, err := x509.MarshalPKCS8PrivateKey(serviceKey)
    if err != nil { t.Fatal(err) }
    directory := t.TempDir()
    write := func(name string, body []byte) string {
        t.Helper()
        path := filepath.Join(directory, name)
        if err := os.WriteFile(path, body, 0o600); err != nil { t.Fatal(err) }
        return path
    }
    caPEM := pem.EncodeToMemory(&pem.Block{Type:"CERTIFICATE", Bytes:caDER})
    roots := x509.NewCertPool()
    if !roots.AppendCertsFromPEM(caPEM) { t.Fatal("test CA could not be loaded") }
    fixedNow := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
    return &tlsFixture{
        config:config.CloudAdminConfig{
            Enabled:true, BaseURL:"https://127.0.0.1", CAFile:write("ca.pem", caPEM),
            ClientCertFile:write("client.pem", clientCertificatePEM), ClientKeyFile:write("client-key.pem", clientKeyPEM),
            JWTSigningKeyFile:write("service-key.pem", pem.EncodeToMemory(&pem.Block{Type:"PRIVATE KEY", Bytes:encodedServiceKey})),
            JWTIssuer:"aera-admin", JWTSubject:"aera-admin-test", Scopes:[]string{"users:read","sessions:write"},
        },
        clock:func() time.Time { return fixedNow }, serverCertificate:serverCertificate, clientRoots:roots,
    }
}

func (fixture *tlsFixture) startServer(t *testing.T, handler http.Handler) *httptest.Server {
    t.Helper()
    server := httptest.NewUnstartedServer(handler)
    server.TLS = &tls.Config{
        Certificates:[]tls.Certificate{fixture.serverCertificate}, ClientAuth:tls.RequireAndVerifyClientCert,
        ClientCAs:fixture.clientRoots, MinVersion:tls.VersionTLS13,
    }
    server.StartTLS()
    return server
}

func newFixtureClient(t *testing.T, handler http.Handler) Client {
    t.Helper()
    fixture := newTLSFixture(t)
    server := fixture.startServer(t, handler)
    t.Cleanup(server.Close)
    fixture.config.BaseURL = server.URL
    client, err := NewHTTPClient(fixture.config, fixture.clock)
    if err != nil { t.Fatal(err) }
    return client
}
```

- [ ] **Step 5: Implement the bounded mTLS HTTP client**

Create `internal/cloudadmin/http_client.go` with this constructor and request core:

```go
type httpClient struct {
    baseURL *url.URL
    tokens tokenSource
    client *http.Client
    clock func() time.Time
}

type failureStage string
const (
    failureServiceJWT failureStage = "service_jwt"
    failureMTLS failureStage = "mtls"
    failureUpstream failureStage = "upstream"
    failureContract failureStage = "contract"
)

type stagedError struct { stage failureStage; cause error }
func (err *stagedError) Error() string { return err.cause.Error() }
func (err *stagedError) Unwrap() error { return err.cause }

func staged(stage failureStage, cause error) error { return &stagedError{stage:stage, cause:cause} }

func NewHTTPClient(settings config.CloudAdminConfig, clock func() time.Time) (Client, error) {
    if !settings.Enabled { return DisabledClient{}, nil }
    caPEM, err := os.ReadFile(settings.CAFile)
    if err != nil { return nil, errors.New("Cloud Admin CA could not be read") }
    roots := x509.NewCertPool()
    if !roots.AppendCertsFromPEM(caPEM) { return nil, errors.New("Cloud Admin CA is invalid") }
    certificate, err := tls.LoadX509KeyPair(settings.ClientCertFile, settings.ClientKeyFile)
    if err != nil { return nil, errors.New("Cloud Admin client identity is invalid") }
    signingPEM, err := os.ReadFile(settings.JWTSigningKeyFile)
    if err != nil { return nil, errors.New("Cloud Admin service identity could not be read") }
    privateKey, err := parseEd25519PrivateKey(signingPEM)
    if err != nil { return nil, err }
    tokens, err := newTokenSource(privateKey, settings.JWTIssuer, settings.JWTSubject, settings.Scopes, clock)
    if err != nil { return nil, err }
    baseURL, err := url.Parse(settings.BaseURL)
    if err != nil { return nil, errors.New("Cloud Admin base URL is invalid") }
    transport := &http.Transport{
        Proxy: nil,
        TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, Certificates: []tls.Certificate{certificate}},
        DialContext: (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
        TLSHandshakeTimeout: 3 * time.Second,
        ResponseHeaderTimeout: 5 * time.Second,
        ExpectContinueTimeout: time.Second,
        IdleConnTimeout: 60 * time.Second,
        MaxIdleConns: 20,
        MaxIdleConnsPerHost: 10,
    }
    return &httpClient{
        baseURL: baseURL, tokens: tokens, clock: clock,
        client: &http.Client{
            Transport: transport, Timeout: 10 * time.Second,
            CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
        },
    }, nil
}

func (client *httpClient) doJSON(ctx context.Context, method, path string, query url.Values, body any, operationID *uuid.UUID, target any) error {
    endpoint := *client.baseURL
    endpoint.Path = path
    endpoint.RawQuery = query.Encode()
    var encoded io.Reader
    if body != nil {
        raw, err := json.Marshal(body)
        if err != nil { return staged(failureContract, ErrContractViolation) }
        encoded = bytes.NewReader(raw)
    }
    request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), encoded)
    if err != nil { return staged(failureMTLS, ErrUnavailable) }
    request.Header.Set("Accept", "application/json")
    if body != nil { request.Header.Set("Content-Type", "application/json") }
    token, err := client.tokens.Token(ctx)
    if err != nil { return staged(failureServiceJWT, ErrUnavailable) }
    request.Header.Set("Authorization", "Bearer "+token)
    if operationID != nil { request.Header.Set("Idempotency-Key", operationID.String()) }
    response, err := client.client.Do(request)
    if err != nil { return staged(failureMTLS, ErrUnavailable) }
    defer func() { _ = response.Body.Close() }()
    if response.StatusCode < 200 || response.StatusCode > 299 { return staged(failureUpstream, mapRemoteStatus(response.StatusCode)) }
    limited := io.LimitReader(response.Body, (1<<20)+1)
    decoder := json.NewDecoder(limited)
    decoder.DisallowUnknownFields()
    if err := decoder.Decode(target); err != nil || ensureJSONEnd(decoder) != nil { return staged(failureContract, ErrContractViolation) }
    return nil
}
```

Add these path-specific wrappers; `pageQuery` rejects limits outside `1..100` and malformed cursors, and `command` validates all IDs/meta before calling `doJSON`:

```go
func (client *httpClient) Health(ctx context.Context) (Health, error) {
    checkedAt := client.clock().UTC()
    result := Health{Configured:true, MTLS:CheckNotChecked, ServiceJWT:CheckNotChecked, Upstream:CheckNotChecked, CheckedAt:checkedAt}
    var payload struct { Status string `json:"status"` }
    if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/health", nil, nil, nil, &payload); err != nil {
        var stagedFailure *stagedError
        if errors.As(err, &stagedFailure) {
            switch stagedFailure.stage {
            case failureServiceJWT:
                result.ServiceJWT = CheckUnavailable
            case failureMTLS:
                result.ServiceJWT = CheckOK
                result.MTLS = CheckUnavailable
            case failureUpstream:
                result.ServiceJWT, result.MTLS, result.Upstream = CheckOK, CheckOK, CheckUnavailable
            case failureContract:
                result.ServiceJWT, result.MTLS, result.Upstream = CheckOK, CheckOK, CheckContractError
                result.Availability = ContractError
                return result, err
            }
        }
        result.Availability = Unavailable
        return result, err
    }
    result.ServiceJWT, result.MTLS, result.Upstream = CheckOK, CheckOK, CheckOK
    if payload.Status != "ok" { result.Availability, result.Upstream = ContractError, CheckContractError; return result, ErrContractViolation }
    result.Availability = Available
    return result, nil
}

func (client *httpClient) ListUsers(ctx context.Context, input ListUsersRequest) (Page[User], error) {
    query, err := pageQuery(input.PageRequest)
    if err != nil { return Page[User]{}, err }
    if input.Status != "" { query.Set("status", string(input.Status)) }
    var result Page[User]
    if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/users", query, nil, nil, &result); err != nil { return Page[User]{}, err }
    if err := validateUserPage(result); err != nil { return Page[User]{}, err }
    return result, nil
}

func (client *httpClient) LookupUser(ctx context.Context, input LookupRequest) (User, error) {
    if (input.Kind != IdentityEmail && input.Kind != IdentityPhone) || input.Value == "" || len(input.Value) > 320 { return User{}, ErrContractViolation }
    var result User
    if err := client.doJSON(ctx, http.MethodPost, "/internal/admin/v1/users/lookup", nil, input, nil, &result); err != nil { return User{}, err }
    if err := result.Validate(); err != nil { return User{}, err }
    return result, nil
}

func (client *httpClient) GetUser(ctx context.Context, id uuid.UUID) (User, error) {
    if id == uuid.Nil { return User{}, ErrContractViolation }
    var result User
    if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/users/"+id.String(), nil, nil, nil, &result); err != nil { return User{}, err }
    if err := result.Validate(); err != nil { return User{}, err }
    return result, nil
}

func (client *httpClient) ListUserDevices(ctx context.Context, id uuid.UUID, page PageRequest) (Page[Device], error) {
    query, err := pageQuery(page)
    if err != nil || id == uuid.Nil { return Page[Device]{}, ErrContractViolation }
    var result Page[Device]
    if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/users/"+id.String()+"/devices", query, nil, nil, &result); err != nil { return Page[Device]{}, err }
    if err := validateDevicePage(result); err != nil { return Page[Device]{}, err }
    return result, nil
}

func (client *httpClient) ListUserSessions(ctx context.Context, id uuid.UUID, page PageRequest) (Page[Session], error) {
    query, err := pageQuery(page)
    if err != nil || id == uuid.Nil { return Page[Session]{}, ErrContractViolation }
    var result Page[Session]
    if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/users/"+id.String()+"/sessions", query, nil, nil, &result); err != nil { return Page[Session]{}, err }
    if err := validateSessionPage(result); err != nil { return Page[Session]{}, err }
    return result, nil
}

func (client *httpClient) RevokeDevice(ctx context.Context, id uuid.UUID, meta CommandMeta) (Operation, error) {
    return client.command(ctx, "/internal/admin/v1/devices/"+id.String()+"/revoke", id, meta)
}
func (client *httpClient) RevokeSession(ctx context.Context, id uuid.UUID, meta CommandMeta) (Operation, error) {
    return client.command(ctx, "/internal/admin/v1/sessions/"+id.String()+"/revoke", id, meta)
}
func (client *httpClient) DisableUser(ctx context.Context, id uuid.UUID, meta CommandMeta) (Operation, error) {
    return client.command(ctx, "/internal/admin/v1/users/"+id.String()+"/disable", id, meta)
}
func (client *httpClient) EnableUser(ctx context.Context, id uuid.UUID, meta CommandMeta) (Operation, error) {
    return client.command(ctx, "/internal/admin/v1/users/"+id.String()+"/enable", id, meta)
}

func (client *httpClient) command(ctx context.Context, endpoint string, targetID uuid.UUID, meta CommandMeta) (Operation, error) {
    if targetID == uuid.Nil || meta.OperationID == uuid.Nil || meta.ActorAdminID == uuid.Nil ||
        meta.RequestID == "" || meta.ReasonCode == "" || meta.ExpectedRevision <= 0 { return Operation{}, ErrContractViolation }
    var result Operation
    if err := client.doJSON(ctx, http.MethodPost, endpoint, nil, meta, &meta.OperationID, &result); err != nil { return Operation{}, err }
    if err := validateOperation(result); err != nil { return Operation{}, err }
    return result, nil
}

func (client *httpClient) GetOperation(ctx context.Context, id uuid.UUID) (Operation, error) {
    if id == uuid.Nil { return Operation{}, ErrContractViolation }
    var result Operation
    if err := client.doJSON(ctx, http.MethodGet, "/internal/admin/v1/operations/"+id.String(), nil, nil, nil, &result); err != nil { return Operation{}, err }
    if err := validateOperation(result); err != nil { return Operation{}, err }
    return result, nil
}

func pageQuery(page PageRequest) (url.Values, error) {
    if page.Limit < 1 || page.Limit > 100 || validateCursor(page.Cursor) != nil { return nil, ErrContractViolation }
    query := url.Values{"limit": []string{strconv.Itoa(page.Limit)}}
    if page.Cursor != "" { query.Set("cursor", page.Cursor) }
    return query, nil
}
```

- [ ] **Step 6: Run client tests, including race detection**

Run:

```bash
go test ./internal/cloudadmin -count=1 -v
go test -race ./internal/cloudadmin -count=1
```

Expected: PASS; the test server observes both client-certificate and bearer authentication, while unsafe responses fail closed.

- [ ] **Step 7: Commit the authenticated client**

```bash
git add internal/cloudadmin/token.go internal/cloudadmin/token_test.go internal/cloudadmin/http_client.go internal/cloudadmin/http_client_test.go
git commit -m "feat: add authenticated cloud admin client"
```

### Task 5: Idempotent Immediate Operation Acceptance

**Files:**
- Create: `internal/operations/model.go`
- Create: `internal/operations/repository.go`
- Create: `internal/operations/repository_test.go`
- Create: `internal/operations/service.go`
- Create: `internal/operations/service_test.go`

**Interfaces:**
- Consumes: `admin.Actor`, `admin.ActionReason`, `audit.Service`, `cloudadmin.Client`, PostgreSQL, and `config.OperationHMACKey`.
- Produces: `operations.Service.EnqueueImmediate(context.Context, EnqueueRequest) (Result, error)`.
- Produces: `operations.Service.Get(context.Context, admin.Actor, uuid.UUID) (Result, error)`.
- Produces: `operations.TransactionalEnqueuer.EnqueueTx(context.Context, pgx.Tx, EnqueueRequest) (Result, error)` for approved account lifecycle requests.

- [ ] **Step 1: Write failing integration tests for idempotency and atomicity**

Create `internal/operations/repository_test.go`:

```go
package operations

func TestEnqueueTxReturnsSameOperationForSameSemanticRequest(t *testing.T) {
    postgres := testkit.Postgres(t)
    auditService, err := audit.NewService(postgres)
    if err != nil { t.Fatal(err) }
    actor := seedOperator(t, postgres)
    repository, err := newRepository(postgres, bytes.Repeat([]byte{9}, 32), auditService, fixedClock)
    if err != nil { t.Fatal(err) }
    request := EnqueueRequest{
        Actor: actor, Action: RevokeSession, TargetID: uuid.New(), ExpectedRevision: 4,
        BrowserIdempotencyKey: "019f0000-0000-7000-8000-000000000021",
        Reason: admin.ActionReason{Code: "suspected_compromise", Meta: actor.Meta},
    }
    first, err := repository.Enqueue(context.Background(), request)
    if err != nil { t.Fatal(err) }
    second, err := repository.Enqueue(context.Background(), request)
    if err != nil { t.Fatal(err) }
    if first.OperationID != second.OperationID || first.State != StateQueued {
        t.Fatalf("results = %+v %+v", first, second)
    }
    var idempotencyCount, outboxCount, auditCount int
    if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_idempotency_records WHERE operation_id = $1`, first.OperationID).Scan(&idempotencyCount); err != nil { t.Fatal(err) }
    if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox WHERE operation_id = $1`, first.OperationID).Scan(&outboxCount); err != nil { t.Fatal(err) }
    if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_audit_events WHERE operation_id = $1`, first.OperationID).Scan(&auditCount); err != nil { t.Fatal(err) }
    if idempotencyCount != 1 || outboxCount != 1 || auditCount != 1 {
        t.Fatalf("counts = idempotency:%d outbox:%d audit:%d", idempotencyCount, outboxCount, auditCount)
    }
}

func TestEnqueueTxRejectsIdempotencyKeyReuseForDifferentRequest(t *testing.T) {
    postgres := testkit.Postgres(t)
    auditService, _ := audit.NewService(postgres)
    actor := seedOperator(t, postgres)
    repository, _ := newRepository(postgres, bytes.Repeat([]byte{9}, 32), auditService, fixedClock)
    request := EnqueueRequest{
        Actor: actor, Action: RevokeDevice, TargetID: uuid.New(), ExpectedRevision: 4,
        BrowserIdempotencyKey: "019f0000-0000-7000-8000-000000000022",
        Reason: admin.ActionReason{Code: "lost_device", Meta: actor.Meta},
    }
    if _, err := repository.Enqueue(context.Background(), request); err != nil { t.Fatal(err) }
    request.TargetID = uuid.New()
    if _, err := repository.Enqueue(context.Background(), request); !errors.Is(err, ErrIdempotencyKeyReused) {
        t.Fatalf("Enqueue() error = %v", err)
    }
}
```

Add these exact helpers to `repository_test.go`:

```go
func seedActor(t *testing.T, postgres *pgxpool.Pool, role rbac.Role) admin.Actor {
    t.Helper()
    id := uuid.New()
    _, err := postgres.Exec(context.Background(), `
        INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
        VALUES ($1, 'Operation Test Actor', $2, 'active', 1, now(), now())
    `, id, role)
    if err != nil { t.Fatal(err) }
    return admin.Actor{AdminID:id, Role:role, Meta:admin.RequestMeta{RequestID:"req-operation", UserAgent:"operations-test"}}
}

func seedOperator(t *testing.T, postgres *pgxpool.Pool) admin.Actor {
    return seedActor(t, postgres, rbac.Operator)
}

func fixedClock() time.Time {
    return time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
}
```

- [ ] **Step 2: Run repository tests and verify failure**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/operations -run TestEnqueueTx -count=1 -v
```

Expected: FAIL because `operations` does not exist.

- [ ] **Step 3: Implement operation types and canonical request hashing**

Create `internal/operations/model.go` with the Shared Interfaces constants plus:

```go
var (
    ErrInvalidRequest = errors.New("operation request is invalid")
    ErrPermissionDenied = errors.New("operation permission is denied")
    ErrIdempotencyKeyReused = errors.New("idempotency key was reused for another request")
    ErrOperationNotFound = errors.New("operation was not found")
    ErrCloudUnavailable = errors.New("Cloud administration is unavailable")
)

var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`)
var operationErrorCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{2,99}$`)

func (request EnqueueRequest) validate() error {
    if request.Actor.AdminID == uuid.Nil || !request.Actor.Role.Valid() || !request.Action.Valid() ||
        request.TargetID == uuid.Nil || request.ExpectedRevision <= 0 ||
        !idempotencyKeyPattern.MatchString(request.BrowserIdempotencyKey) ||
        request.Reason.Code == "" || request.Reason.Meta.RequestID == "" ||
        audit.ContainsSensitiveText(request.Reason.TicketReference) || audit.ContainsSensitiveText(request.Reason.Note) {
        return ErrInvalidRequest
    }
    return nil
}

func (action Action) Valid() bool {
    return action == RevokeDevice || action == RevokeSession || action == DisableUser || action == EnableUser
}

func permissionFor(action Action) rbac.Permission {
    switch action {
    case RevokeDevice:
        return rbac.RevokeCloudDevice
    case RevokeSession:
        return rbac.RevokeCloudSession
    case DisableUser, EnableUser:
        return rbac.ApproveAccountLifecycle
    default:
        return rbac.Permission("")
    }
}

func requestDigest(request EnqueueRequest) [sha256.Size]byte {
    approvalID := ""
    if request.ApprovalID != nil { approvalID = request.ApprovalID.String() }
    canonical := strings.Join([]string{
        string(request.Action), request.TargetID.String(), strconv.FormatInt(request.ExpectedRevision, 10),
        request.Reason.Code, request.Reason.TicketReference, request.Reason.Note, approvalID,
    }, "\x00")
    return sha256.Sum256([]byte(canonical))
}
```

- [ ] **Step 4: Implement transactional enqueue and exact replay behavior**

Create `internal/operations/repository.go` with these public transaction boundaries:

```go
type TransactionalEnqueuer interface {
    EnqueueTx(context.Context, pgx.Tx, EnqueueRequest) (Result, error)
}

type repository struct {
    postgres *pgxpool.Pool
    hmacKey []byte
    audit *audit.Service
    clock func() time.Time
}

func newRepository(postgres *pgxpool.Pool, hmacKey []byte, recorder *audit.Service, clock func() time.Time) (*repository, error) {
    if postgres == nil || len(hmacKey) < 32 || recorder == nil || clock == nil {
        return nil, errors.New("operation repository dependencies are required")
    }
    return &repository{postgres: postgres, hmacKey: append([]byte(nil), hmacKey...), audit: recorder, clock: clock}, nil
}

func (repository *repository) Enqueue(ctx context.Context, request EnqueueRequest) (Result, error) {
    tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
    if err != nil { return Result{}, errors.New("operation transaction could not start") }
    defer func() { _ = tx.Rollback(context.Background()) }()
    result, err := repository.EnqueueTx(ctx, tx, request)
    if err != nil { return Result{}, err }
    if err := tx.Commit(ctx); err != nil { return Result{}, errors.New("operation could not be committed") }
    return result, nil
}

func (repository *repository) EnqueueTx(ctx context.Context, tx pgx.Tx, request EnqueueRequest) (Result, error) {
    if err := request.validate(); err != nil { return Result{}, err }
    if !rbac.Allowed(request.Actor.Role, permissionFor(request.Action)) { return Result{}, ErrPermissionDenied }
    keyMAC := hmac.New(sha256.New, repository.hmacKey)
    _, _ = keyMAC.Write([]byte("aera-admin.operation-idempotency.v1\x00" + request.BrowserIdempotencyKey))
    keyDigest := keyMAC.Sum(nil)
    semanticDigest := requestDigest(request)
    now := repository.clock().UTC()
    operationID := uuid.New()
    command, err := tx.Exec(ctx, `
        INSERT INTO admin_idempotency_records (
            operation_id, actor_admin_id, action, idempotency_key_hmac, request_hash,
            state, created_at, updated_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, 'queued', $6, $6, $7)
        ON CONFLICT (actor_admin_id, action, idempotency_key_hmac) DO NOTHING
    `, operationID, request.Actor.AdminID, request.Action, keyDigest, semanticDigest[:], now, now.Add(30*24*time.Hour))
    if err != nil { return Result{}, errors.New("idempotency record could not be stored") }
    if command.RowsAffected() == 0 {
        var existing Result
        var existingHash []byte
        err := tx.QueryRow(ctx, `
            SELECT operation_id, state, COALESCE(error_code, ''), updated_at, request_hash
            FROM admin_idempotency_records
            WHERE actor_admin_id=$1 AND action=$2 AND idempotency_key_hmac=$3
            FOR UPDATE
        `, request.Actor.AdminID, request.Action, keyDigest).Scan(
            &existing.OperationID, &existing.State, &existing.ErrorCode, &existing.UpdatedAt, &existingHash,
        )
        if err != nil { return Result{}, errors.New("idempotency record could not be read") }
        if subtle.ConstantTimeCompare(existingHash, semanticDigest[:]) != 1 { return Result{}, ErrIdempotencyKeyReused }
        return existing, nil
    }
    _, err = tx.Exec(ctx, `
        INSERT INTO admin_outbox (
            operation_id, action, target_id, approval_id, actor_admin_id, actor_role, idempotency_key_hmac, expected_revision,
            reason_code, ticket_reference, note, request_id, status, attempts,
            available_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULLIF($10,''),NULLIF($11,''),$12,'queued',0,$13,$13,$13)
    `, operationID, request.Action, request.TargetID, request.ApprovalID, request.Actor.AdminID,
        request.Actor.Role, keyDigest, request.ExpectedRevision, request.Reason.Code, request.Reason.TicketReference,
        request.Reason.Note, request.Reason.Meta.RequestID, now)
    if err != nil { return Result{}, errors.New("operation Outbox record could not be stored") }
    if _, err := repository.audit.AppendTx(ctx, tx, audit.Record{
        ActorAdminID: &request.Actor.AdminID, ActorRole: request.Actor.Role,
        EventType: "cloud_operation_queued", ObjectType: string(request.Action), ObjectID: &request.TargetID,
        Outcome: audit.OutcomeSuccess, ReasonCode: request.Reason.Code,
        TicketReference: request.Reason.TicketReference, Note: request.Reason.Note,
        ApprovalID: request.ApprovalID, OperationID: &operationID,
        AfterState: map[string]string{"execution_status":"queued"}, RequestID: request.Reason.Meta.RequestID,
        SourceIPHMAC: request.Reason.Meta.SourceIPHMAC, UserAgent: request.Reason.Meta.UserAgent,
    }); err != nil { return Result{}, err }
    return Result{OperationID: operationID, State: StateQueued, UpdatedAt: now}, nil
}
```

The `ON CONFLICT DO NOTHING` path above handles concurrent retries without aborting the transaction: it locks and compares the winning row before returning.

- [ ] **Step 5: Write and implement fail-closed immediate-operation service tests**

Create `internal/operations/service_test.go` with this complete health-controlled client and service fixture:

```go
type cloudStub struct {
    cloudadmin.DisabledClient
    health cloudadmin.Health
    err error
}

func (stub cloudStub) Health(context.Context) (cloudadmin.Health, error) {
    return stub.health, stub.err
}

func newTestService(t *testing.T, postgres *pgxpool.Pool, cloud cloudadmin.Client) *Service {
    t.Helper()
    recorder, err := audit.NewService(postgres)
    if err != nil { t.Fatal(err) }
    service, err := NewService(ServiceConfig{
        PostgreSQL:postgres, HMACKey:bytes.Repeat([]byte{9}, 32), Cloud:cloud,
        Audit:recorder, Clock:fixedClock,
    })
    if err != nil { t.Fatal(err) }
    return service
}

func validImmediateRequest(t *testing.T, postgres *pgxpool.Pool, action Action, role rbac.Role) EnqueueRequest {
    t.Helper()
    actor := seedActor(t, postgres, role)
    return EnqueueRequest{
        Actor:actor, Action:action, TargetID:uuid.New(), ExpectedRevision:1,
        BrowserIdempotencyKey:uuid.NewString(),
        Reason:admin.ActionReason{Code:"suspected_compromise", Meta:actor.Meta},
    }
}
```

Then add this acceptance assertion:

```go
func TestEnqueueImmediateDoesNotWriteWhenCloudIsUnavailable(t *testing.T) {
    postgres := testkit.Postgres(t)
    service := newTestService(t, postgres, cloudStub{health: cloudadmin.Health{Availability: cloudadmin.Unavailable}, err: cloudadmin.ErrUnavailable})
    request := validImmediateRequest(t, postgres, RevokeDevice, rbac.Support)
    if _, err := service.EnqueueImmediate(context.Background(), request); !errors.Is(err, ErrCloudUnavailable) {
        t.Fatalf("EnqueueImmediate() error = %v", err)
    }
    var count int
    if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox`).Scan(&count); err != nil || count != 0 {
        t.Fatalf("outbox count/error = %d/%v", count, err)
    }
}
```

Implement `Service`:

```go
type Service struct {
    repository *repository
    cloud cloudadmin.Client
}

type ServiceConfig struct {
    PostgreSQL *pgxpool.Pool
    HMACKey []byte
    Cloud cloudadmin.Client
    Audit *audit.Service
    Clock func() time.Time
}

func NewService(config ServiceConfig) (*Service, error) {
    repository, err := newRepository(config.PostgreSQL, config.HMACKey, config.Audit, config.Clock)
    if err != nil { return nil, err }
    if config.Cloud == nil { return nil, errors.New("Cloud client is required") }
    return &Service{repository:repository, cloud:config.Cloud}, nil
}

func (service *Service) EnqueueTx(ctx context.Context, tx pgx.Tx, request EnqueueRequest) (Result, error) {
    return service.repository.EnqueueTx(ctx, tx, request)
}

func (service *Service) EnqueueImmediate(ctx context.Context, request EnqueueRequest) (Result, error) {
    if request.Action != RevokeDevice && request.Action != RevokeSession { return Result{}, ErrInvalidRequest }
    health, err := service.cloud.Health(ctx)
    if err != nil || health.Availability != cloudadmin.Available { return Result{}, ErrCloudUnavailable }
    return service.repository.Enqueue(ctx, request)
}

func (service *Service) Get(ctx context.Context, actor admin.Actor, operationID uuid.UUID) (Result, error) {
    if actor.AdminID == uuid.Nil || !actor.Role.Valid() || operationID == uuid.Nil { return Result{}, ErrInvalidRequest }
    return service.repository.Get(ctx, actor, operationID)
}
```

Add this exact read method to `repository.go`; no payload, reason, or upstream response can cross this boundary:

```go
func (repository *repository) Get(ctx context.Context, actor admin.Actor, operationID uuid.UUID) (Result, error) {
    var ownerID uuid.UUID
    var result Result
    err := repository.postgres.QueryRow(ctx, `
        SELECT operation_id, actor_admin_id, state, COALESCE(error_code,''), updated_at
        FROM admin_idempotency_records WHERE operation_id=$1
    `, operationID).Scan(&result.OperationID, &ownerID, &result.State, &result.ErrorCode, &result.UpdatedAt)
    if errors.Is(err, pgx.ErrNoRows) { return Result{}, ErrOperationNotFound }
    if err != nil { return Result{}, errors.New("operation state could not be read") }
    if ownerID != actor.AdminID && !rbac.Allowed(actor.Role, rbac.ReadFullAudit) {
        return Result{}, ErrPermissionDenied
    }
    return result, nil
}
```

- [ ] **Step 6: Run operation package integration tests**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/operations -count=1 -v
```

Expected: PASS with one Outbox row for an exact retry, a conflict for semantic key reuse, and no row when Cloud health is unavailable.

- [ ] **Step 7: Commit operation acceptance**

```bash
git add internal/operations
git commit -m "feat: enqueue idempotent admin operations"
```

### Task 6: Dual-control Account Lifecycle Approval

**Files:**
- Create: `internal/approval/model.go`
- Create: `internal/approval/model_test.go`
- Create: `internal/approval/repository.go`
- Create: `internal/approval/repository_test.go`
- Create: `internal/approval/service.go`
- Create: `internal/approval/service_test.go`
- Modify: `internal/operations/service.go`

**Interfaces:**
- Consumes: `cloudadmin.Client`, `operations.TransactionalEnqueuer`, `audit.Service`, PostgreSQL, and the existing staff actor/reason types.
- Produces: `Create`, `List`, `Get`, `Approve`, `Reject`, and `Cancel` methods on `approval.Service`.
- Produces: `approval.ExecutionSink.ApplyExecutionTx(...)` for the Worker in Task 7.

- [ ] **Step 1: Write failing pure state-rule tests**

Create `internal/approval/model_test.go`:

```go
package approval

func TestRequestReviewRulesRequireAnotherSuperAdministrator(t *testing.T) {
    requesterID := uuid.New()
    request := Request{
        ID: uuid.New(), RequestedByAdminID: requesterID, RequestedByRole: rbac.Operator,
        Status: PendingReview, ExecutionStatus: NotStarted,
        ExpiresAt: time.Date(2026, 7, 23, 8, 0, 0, 0, time.UTC), Version: 1,
    }
    now := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
    cases := []struct {
        name string
        actor admin.Actor
        want error
    }{
        {"requester", admin.Actor{AdminID: requesterID, Role: rbac.SuperAdmin}, ErrSelfReview},
        {"operator", admin.Actor{AdminID: uuid.New(), Role: rbac.Operator}, ErrPermissionDenied},
        {"different super admin", admin.Actor{AdminID: uuid.New(), Role: rbac.SuperAdmin}, nil},
    }
    for _, item := range cases {
        t.Run(item.name, func(t *testing.T) {
            err := request.CanReview(item.actor, now)
            if !errors.Is(err, item.want) { t.Fatalf("CanReview() error = %v, want %v", err, item.want) }
        })
    }
}

func TestRequestCannotReviewExpiredOrFinalState(t *testing.T) {
    request := Request{
        ID: uuid.New(), RequestedByAdminID: uuid.New(), RequestedByRole: rbac.Operator,
        Status: PendingReview, ExecutionStatus: NotStarted,
        ExpiresAt: time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC), Version: 1,
    }
    actor := admin.Actor{AdminID: uuid.New(), Role: rbac.SuperAdmin}
    if err := request.CanReview(actor, request.ExpiresAt); !errors.Is(err, ErrExpired) {
        t.Fatalf("CanReview() error = %v", err)
    }
    request.Status = Rejected
    if err := request.CanReview(actor, request.ExpiresAt.Add(-time.Second)); !errors.Is(err, ErrStateConflict) {
        t.Fatalf("final CanReview() error = %v", err)
    }
}
```

- [ ] **Step 2: Run model tests and verify failure**

Run: `go test ./internal/approval -run TestRequest -count=1 -v`

Expected: FAIL because the approval package does not exist.

- [ ] **Step 3: Implement explicit approval and execution state rules**

Create `internal/approval/model.go` with the Shared Interfaces types plus:

```go
var (
    ErrInvalidRequest = errors.New("approval request is invalid")
    ErrPermissionDenied = errors.New("approval permission is denied")
    ErrSelfReview = errors.New("approval requester cannot review the request")
    ErrExpired = errors.New("approval request expired")
    ErrStateConflict = errors.New("approval state changed")
    ErrNotFound = errors.New("approval request was not found")
    ErrTargetState = errors.New("Cloud user state does not permit this action")
)

var approvalReasonCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

type CreateRequest struct {
    Actor admin.Actor
    Action Action
    TargetUserID uuid.UUID
    Reason admin.ActionReason
}

type ListFilter struct {
    View string
    Cursor string
    Limit int
}

type Page struct {
    Items []Request `json:"items"`
    NextCursor string `json:"next_cursor,omitempty"`
}

type Event struct {
    ID uuid.UUID `json:"id"`
    EventType string `json:"event_type"`
    BeforeStatus string `json:"before_status"`
    AfterStatus string `json:"after_status"`
    ResultCode string `json:"result_code,omitempty"`
    ActorAdminID uuid.UUID `json:"actor_admin_id"`
    ActorRole rbac.Role `json:"actor_role"`
    RequestID string `json:"request_id"`
    CreatedAt time.Time `json:"created_at"`
}

func (request Request) CanReview(actor admin.Actor, now time.Time) error {
    if request.Status != PendingReview { return ErrStateConflict }
    if !now.UTC().Before(request.ExpiresAt.UTC()) { return ErrExpired }
    if actor.AdminID == request.RequestedByAdminID { return ErrSelfReview }
    if actor.Role != rbac.SuperAdmin || !rbac.Allowed(actor.Role, rbac.ApproveAccountLifecycle) {
        return ErrPermissionDenied
    }
    return nil
}

func (request Request) CanCancel(actor admin.Actor, now time.Time) error {
    if request.Status != PendingReview { return ErrStateConflict }
    if !now.UTC().Before(request.ExpiresAt.UTC()) { return ErrExpired }
    if actor.AdminID != request.RequestedByAdminID || actor.Role != rbac.Operator { return ErrPermissionDenied }
    return nil
}

func actionAllowed(action Action, user cloudadmin.User) bool {
    switch action {
    case DisableUser:
        return user.Status == cloudadmin.UserActive && user.DeletionFinalizedAt == nil
    case EnableUser:
        return user.Status == cloudadmin.UserDisabled && user.AdministrativelyDisabled && user.DeletionFinalizedAt == nil
    default:
        return false
    }
}

func (request CreateRequest) validate() error {
    if request.Actor.AdminID == uuid.Nil || (request.Action != DisableUser && request.Action != EnableUser) ||
        request.TargetUserID == uuid.Nil || !approvalReasonCodePattern.MatchString(request.Reason.Code) ||
        len(request.Reason.TicketReference) > 128 || len(request.Reason.Note) > 500 ||
        audit.ContainsSensitiveText(request.Reason.TicketReference) || audit.ContainsSensitiveText(request.Reason.Note) ||
        request.Reason.Meta.RequestID == "" {
        return ErrInvalidRequest
    }
    return nil
}
```

- [ ] **Step 4: Write failing repository concurrency and append tests**

Create `internal/approval/repository_test.go`:

```go
func TestConcurrentApproveHasOneStateTransitionAndOneOutbox(t *testing.T) {
    postgres := testkit.Postgres(t)
    fixture := newApprovalFixture(t, postgres)
    request := fixture.createPending(t)
    reviewers := []admin.Actor{fixture.firstSuperAdmin, fixture.secondSuperAdmin}
    results := make(chan error, len(reviewers))
    var wait sync.WaitGroup
    for index, reviewer := range reviewers {
        wait.Add(1)
        go func(index int, reviewer admin.Actor) {
            defer wait.Done()
            _, err := fixture.service.Approve(context.Background(), reviewer, request.ID,
                fmt.Sprintf("019f0000-0000-7000-8000-%012d", index+31))
            results <- err
        }(index, reviewer)
    }
    wait.Wait()
    close(results)
    successes, conflicts := 0, 0
    for err := range results {
        switch {
        case err == nil: successes++
        case errors.Is(err, ErrStateConflict): conflicts++
        default: t.Fatalf("unexpected approval error: %v", err)
        }
    }
    if successes != 1 || conflicts != 1 { t.Fatalf("success/conflict = %d/%d", successes, conflicts) }
    var approved, outbox, events int
    if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM approval_requests WHERE id=$1 AND approval_status='approved' AND execution_status='queued'`, request.ID).Scan(&approved); err != nil { t.Fatal(err) }
    if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM admin_outbox WHERE approval_id=$1`, request.ID).Scan(&outbox); err != nil { t.Fatal(err) }
    if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM approval_events WHERE approval_request_id=$1 AND event_type='approved'`, request.ID).Scan(&events); err != nil { t.Fatal(err) }
    if approved != 1 || outbox != 1 || events != 1 { t.Fatalf("approved/outbox/events = %d/%d/%d", approved, outbox, events) }
}
```

Add this fixture to `repository_test.go`; it uses the real approval and operation repositories and only replaces the external Cloud boundary:

```go
type approvalCloudStub struct {
    cloudadmin.DisabledClient
    user cloudadmin.User
}

func (stub approvalCloudStub) Health(context.Context) (cloudadmin.Health, error) {
    return cloudadmin.Health{Configured:true, Availability:cloudadmin.Available, CheckedAt:approvalClock()}, nil
}
func (stub approvalCloudStub) GetUser(context.Context, uuid.UUID) (cloudadmin.User, error) {
    return stub.user, nil
}

type approvalFixture struct {
    service *Service
    operator admin.Actor
    firstSuperAdmin admin.Actor
    secondSuperAdmin admin.Actor
    user cloudadmin.User
}

func approvalClock() time.Time { return time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC) }

func seedApprovalActor(t *testing.T, postgres *pgxpool.Pool, role rbac.Role, requestID string) admin.Actor {
    t.Helper()
    id := uuid.New()
    _, err := postgres.Exec(context.Background(), `
        INSERT INTO admin_users (id, display_name, role, status, security_version, created_at, updated_at)
        VALUES ($1, 'Approval Test Actor', $2, 'active', 1, now(), now())
    `, id, role)
    if err != nil { t.Fatal(err) }
    return admin.Actor{AdminID:id, Role:role, Meta:admin.RequestMeta{RequestID:requestID, UserAgent:"approval-test"}}
}

func newApprovalFixture(t *testing.T, postgres *pgxpool.Pool) *approvalFixture {
    t.Helper()
    recorder, err := audit.NewService(postgres)
    if err != nil { t.Fatal(err) }
    user := cloudadmin.User{
        ID:uuid.New(), MaskedEmail:"a***@example.test", Status:cloudadmin.UserActive,
        AdministrativeRevision:7, CreatedAt:approvalClock(),
    }
    cloud := approvalCloudStub{user:user}
    operationService, err := operations.NewService(operations.ServiceConfig{
        PostgreSQL:postgres, HMACKey:bytes.Repeat([]byte{8}, 32), Cloud:cloud,
        Audit:recorder, Clock:approvalClock,
    })
    if err != nil { t.Fatal(err) }
    service, err := NewService(ServiceConfig{
        PostgreSQL:postgres, Cloud:cloud, Operations:operationService, Audit:recorder, Clock:approvalClock,
    })
    if err != nil { t.Fatal(err) }
    return &approvalFixture{
        service:service, user:user,
        operator:seedApprovalActor(t, postgres, rbac.Operator, "req-approval-create"),
        firstSuperAdmin:seedApprovalActor(t, postgres, rbac.SuperAdmin, "req-approval-review-1"),
        secondSuperAdmin:seedApprovalActor(t, postgres, rbac.SuperAdmin, "req-approval-review-2"),
    }
}

func (fixture *approvalFixture) createPending(t *testing.T) Request {
    t.Helper()
    request, err := fixture.service.Create(context.Background(), CreateRequest{
        Actor:fixture.operator, Action:DisableUser, TargetUserID:fixture.user.ID,
        Reason:admin.ActionReason{Code:"policy_violation", Meta:fixture.operator.Meta},
    })
    if err != nil { t.Fatal(err) }
    return request
}
```

- [ ] **Step 5: Implement repository locking, events, and visibility**

Create `internal/approval/repository.go` around these exact boundaries:

```go
type repository struct { postgres *pgxpool.Pool }

func (repository *repository) begin(ctx context.Context) (pgx.Tx, error) {
    return repository.postgres.BeginTx(ctx, pgx.TxOptions{})
}

func lockRequest(ctx context.Context, tx pgx.Tx, id uuid.UUID) (Request, error) {
    row := tx.QueryRow(ctx, `
        SELECT id, action, target_user_id, target_snapshot, requested_by_admin_id, requested_by_role,
            reviewed_by_admin_id, reason_code, COALESCE(ticket_reference,''), COALESCE(note,''),
            expected_revision, approval_status, execution_status, operation_id, expires_at,
            created_at, updated_at, version
        FROM approval_requests WHERE id=$1 FOR UPDATE
    `, id)
    return scanRequest(row)
}

func insertEvent(ctx context.Context, tx pgx.Tx, requestID, actorID uuid.UUID, actorRole rbac.Role,
    eventType, before, after, resultCode, traceRequestID string, now time.Time) error {
    _, err := tx.Exec(ctx, `
        INSERT INTO approval_events (
            id, approval_request_id, actor_admin_id, actor_role, event_type,
            before_status, after_status, result_code, request_id, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9,$10)
    `, uuid.New(), requestID, actorID, actorRole, eventType, before, after, resultCode, traceRequestID, now)
    return err
}

func (repository *repository) InsertWithAudit(ctx context.Context, request Request, actor admin.Actor,
    reason admin.ActionReason, recorder *audit.Service) (Request, error) {
    snapshot, err := json.Marshal(request.TargetSnapshot)
    if err != nil { return Request{}, cloudadmin.ErrContractViolation }
    tx, err := repository.begin(ctx)
    if err != nil { return Request{}, errors.New("approval transaction could not start") }
    defer func() { _ = tx.Rollback(context.Background()) }()
    _, err = tx.Exec(ctx, `
        INSERT INTO approval_requests (
            id, action, target_user_id, target_snapshot, requested_by_admin_id, requested_by_role,
            reason_code, ticket_reference, note, expected_revision, approval_status, execution_status,
            expires_at, created_at, updated_at, version
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),NULLIF($9,''),$10,$11,$12,$13,$14,$14,$15)
    `, request.ID, request.Action, request.TargetUserID, snapshot, request.RequestedByAdminID,
        request.RequestedByRole, request.ReasonCode, request.TicketReference, request.Note,
        request.ExpectedRevision, request.Status, request.ExecutionStatus, request.ExpiresAt,
        request.CreatedAt, request.Version)
    if err != nil {
        var databaseError *pgconn.PgError
        if errors.As(err, &databaseError) && databaseError.Code == "23505" { return Request{}, ErrStateConflict }
        return Request{}, errors.New("approval request could not be stored")
    }
    if err := insertEvent(ctx, tx, request.ID, actor.AdminID, actor.Role, "created", "", string(PendingReview), "", actor.Meta.RequestID, request.CreatedAt); err != nil {
        return Request{}, err
    }
    if _, err := recorder.AppendTx(ctx, tx, audit.Record{
        ActorAdminID:&actor.AdminID, ActorRole:actor.Role, EventType:"account_lifecycle_requested",
        ObjectType:"cloud_user", ObjectID:&request.TargetUserID, Outcome:audit.OutcomeSuccess,
        ReasonCode:reason.Code, TicketReference:reason.TicketReference, Note:reason.Note,
        ApprovalID:&request.ID, AfterState:map[string]string{
            "approval_status":"pending_review", "execution_status":"not_started",
        }, RequestID:actor.Meta.RequestID, SourceIPHMAC:actor.Meta.SourceIPHMAC, UserAgent:actor.Meta.UserAgent,
    }); err != nil { return Request{}, err }
    if err := tx.Commit(ctx); err != nil { return Request{}, errors.New("approval request could not be committed") }
    return repository.Get(ctx, actor, request.ID)
}
```

Add strict row decoding and role-scoped reads to the same file:

```go
type rowScanner interface { Scan(...any) error }

func scanRequest(row rowScanner) (Request, error) {
    var request Request
    var snapshot []byte
    err := row.Scan(
        &request.ID, &request.Action, &request.TargetUserID, &snapshot,
        &request.RequestedByAdminID, &request.RequestedByRole, &request.ReviewedByAdminID,
        &request.ReasonCode, &request.TicketReference, &request.Note, &request.ExpectedRevision,
        &request.Status, &request.ExecutionStatus, &request.OperationID, &request.ExpiresAt,
        &request.CreatedAt, &request.UpdatedAt, &request.Version,
    )
    if errors.Is(err, pgx.ErrNoRows) { return Request{}, ErrNotFound }
    if err != nil { return Request{}, errors.New("approval request could not be decoded") }
    decoder := json.NewDecoder(bytes.NewReader(snapshot))
    decoder.DisallowUnknownFields()
    if err := decoder.Decode(&request.TargetSnapshot); err != nil { return Request{}, cloudadmin.ErrContractViolation }
    var extra any
    if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) { return Request{}, cloudadmin.ErrContractViolation }
    if err := request.TargetSnapshot.Validate(); err != nil { return Request{}, err }
    return request, nil
}

const requestColumns = `id, action, target_user_id, target_snapshot, requested_by_admin_id, requested_by_role,
    reviewed_by_admin_id, reason_code, COALESCE(ticket_reference,''), COALESCE(note,''),
    expected_revision, approval_status, execution_status, operation_id, expires_at, created_at, updated_at, version`

func canSee(actor admin.Actor, request Request) bool {
    return actor.Role == rbac.SuperAdmin || (actor.Role == rbac.Operator && request.RequestedByAdminID == actor.AdminID)
}

func (repository *repository) Get(ctx context.Context, actor admin.Actor, id uuid.UUID) (Request, error) {
    request, err := scanRequest(repository.postgres.QueryRow(ctx, `SELECT `+requestColumns+` FROM approval_requests WHERE id=$1`, id))
    if err != nil { return Request{}, err }
    if !canSee(actor, request) { return Request{}, ErrPermissionDenied }
    rows, err := repository.postgres.Query(ctx, `SELECT id, event_type, before_status, after_status,
        COALESCE(result_code,''), actor_admin_id, actor_role, request_id, created_at
        FROM approval_events WHERE approval_request_id=$1 ORDER BY created_at, id`, id)
    if err != nil { return Request{}, errors.New("approval events could not be listed") }
    defer rows.Close()
    request.Events = make([]Event, 0)
    for rows.Next() {
        var event Event
        if err := rows.Scan(&event.ID, &event.EventType, &event.BeforeStatus, &event.AfterStatus,
            &event.ResultCode, &event.ActorAdminID, &event.ActorRole, &event.RequestID, &event.CreatedAt); err != nil {
            return Request{}, errors.New("approval event could not be decoded")
        }
        request.Events = append(request.Events, event)
    }
    if err := rows.Err(); err != nil { return Request{}, errors.New("approval events could not be read") }
    return request, nil
}

type approvalCursor struct { CreatedAt time.Time; ID uuid.UUID }

func encodeApprovalCursor(value approvalCursor) string {
    return base64.RawURLEncoding.EncodeToString([]byte(value.CreatedAt.UTC().Format(time.RFC3339Nano)+"|"+value.ID.String()))
}

func decodeApprovalCursor(raw string) (*approvalCursor, error) {
    if raw == "" { return nil, nil }
    decoded, err := base64.RawURLEncoding.DecodeString(raw)
    if err != nil { return nil, ErrInvalidRequest }
    parts := strings.Split(string(decoded), "|")
    if len(parts) != 2 { return nil, ErrInvalidRequest }
    createdAt, err := time.Parse(time.RFC3339Nano, parts[0])
    if err != nil { return nil, ErrInvalidRequest }
    id, err := uuid.Parse(parts[1])
    if err != nil { return nil, ErrInvalidRequest }
    return &approvalCursor{CreatedAt:createdAt, ID:id}, nil
}

func (repository *repository) List(ctx context.Context, actor admin.Actor, filter ListFilter) (Page, error) {
    if actor.Role != rbac.Operator && actor.Role != rbac.SuperAdmin { return Page{}, ErrPermissionDenied }
    if filter.Limit < 1 || filter.Limit > 100 { return Page{}, ErrInvalidRequest }
    cursor, err := decodeApprovalCursor(filter.Cursor)
    if err != nil { return Page{}, err }
    view := filter.View
    if actor.Role == rbac.Operator { view = "mine" }
    if view != "mine" && view != "pending_for_me" && view != "all" { return Page{}, ErrInvalidRequest }
    var cursorTime any
    var cursorID any
    if cursor != nil { cursorTime, cursorID = cursor.CreatedAt, cursor.ID }
    rows, err := repository.postgres.Query(ctx, `SELECT `+requestColumns+` FROM approval_requests
        WHERE ($1 <> 'mine' OR requested_by_admin_id=$2)
          AND ($1 <> 'pending_for_me' OR (approval_status='pending_review' AND requested_by_admin_id<>$2))
          AND ($3::timestamptz IS NULL OR (created_at,id) < ($3,$4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`, view, actor.AdminID, cursorTime, cursorID, filter.Limit+1)
    if err != nil { return Page{}, errors.New("approval requests could not be listed") }
    defer rows.Close()
    items := make([]Request, 0, filter.Limit)
    for rows.Next() {
        item, err := scanRequest(rows)
        if err != nil { return Page{}, err }
        items = append(items, item)
    }
    if err := rows.Err(); err != nil { return Page{}, errors.New("approval requests could not be read") }
    page := Page{Items:items}
    if len(items) > filter.Limit {
        page.Items = items[:filter.Limit]
        last := page.Items[len(page.Items)-1]
        page.NextCursor = encodeApprovalCursor(approvalCursor{CreatedAt:last.CreatedAt, ID:last.ID})
    }
    return page, nil
}
```

- [ ] **Step 6: Implement create, approve, reject, and cancel transactions**

Create `internal/approval/service.go` with:

```go
type ServiceConfig struct {
    PostgreSQL *pgxpool.Pool
    Cloud cloudadmin.Client
    Operations operations.TransactionalEnqueuer
    Audit *audit.Service
    Clock func() time.Time
}

type Service struct {
    repository *repository
    cloud cloudadmin.Client
    operations operations.TransactionalEnqueuer
    audit *audit.Service
    clock func() time.Time
}

func NewService(config ServiceConfig) (*Service, error) {
    if config.PostgreSQL == nil || config.Cloud == nil || config.Operations == nil ||
        config.Audit == nil || config.Clock == nil {
        return nil, errors.New("approval service dependencies are required")
    }
    return &Service{
        repository:&repository{postgres:config.PostgreSQL}, cloud:config.Cloud,
        operations:config.Operations, audit:config.Audit, clock:config.Clock,
    }, nil
}

func (service *Service) Create(ctx context.Context, input CreateRequest) (Request, error) {
    if err := input.validate(); err != nil { return Request{}, err }
    if input.Actor.Role != rbac.Operator || !rbac.Allowed(input.Actor.Role, rbac.InitiateAccountLifecycle) {
        return Request{}, ErrPermissionDenied
    }
    user, err := service.cloud.GetUser(ctx, input.TargetUserID)
    if err != nil { return Request{}, mapCloudError(err) }
    if !actionAllowed(input.Action, user) { return Request{}, ErrTargetState }
    now := service.clock().UTC()
    request := Request{
        ID: uuid.New(), Action: input.Action, TargetUserID: input.TargetUserID, TargetSnapshot: user,
        RequestedByAdminID: input.Actor.AdminID, RequestedByRole: input.Actor.Role,
        ReasonCode: input.Reason.Code, TicketReference: input.Reason.TicketReference, Note: input.Reason.Note,
        ExpectedRevision: user.AdministrativeRevision, Status: PendingReview, ExecutionStatus: NotStarted,
        ExpiresAt: now.Add(24*time.Hour), CreatedAt: now, UpdatedAt: now, Version: 1,
    }
    return service.repository.InsertWithAudit(ctx, request, input.Actor, input.Reason, service.audit)
}

func (service *Service) Approve(ctx context.Context, actor admin.Actor, id uuid.UUID, idempotencyKey string) (Request, error) {
    tx, err := service.repository.begin(ctx)
    if err != nil { return Request{}, err }
    defer func() { _ = tx.Rollback(context.Background()) }()
    request, err := lockRequest(ctx, tx, id)
    if err != nil { return Request{}, err }
    now := service.clock().UTC()
    if err := request.CanReview(actor, now); err != nil {
        if errors.Is(err, ErrExpired) {
            if persistErr := service.expireTx(ctx, tx, request, actor, now); persistErr != nil { return Request{}, persistErr }
            if commitErr := tx.Commit(ctx); commitErr != nil { return Request{}, errors.New("approval expiry could not be committed") }
        }
        return Request{}, err
    }
    action := operations.DisableUser
    if request.Action == EnableUser { action = operations.EnableUser }
    approvalID := request.ID
    result, err := service.operations.EnqueueTx(ctx, tx, operations.EnqueueRequest{
        Actor: actor, Action: action, TargetID: request.TargetUserID,
        ExpectedRevision: request.ExpectedRevision, BrowserIdempotencyKey: idempotencyKey,
        ApprovalID: &approvalID,
        Reason: admin.ActionReason{Code: request.ReasonCode, TicketReference: request.TicketReference, Note: request.Note, Meta: actor.Meta},
    })
    if err != nil { return Request{}, err }
    command, err := tx.Exec(ctx, `
        UPDATE approval_requests SET approval_status='approved', execution_status='queued',
            reviewed_by_admin_id=$2, reviewed_at=$3, operation_id=$4, updated_at=$3, version=version+1
        WHERE id=$1 AND version=$5 AND approval_status='pending_review'
    `, request.ID, actor.AdminID, now, result.OperationID, request.Version)
    if err != nil { return Request{}, errors.New("approval could not be updated") }
    if command.RowsAffected() != 1 { return Request{}, ErrStateConflict }
    if err := insertEvent(ctx, tx, request.ID, actor.AdminID, actor.Role, "approved", string(PendingReview), string(Approved), "", actor.Meta.RequestID, now); err != nil { return Request{}, err }
    if err := insertEvent(ctx, tx, request.ID, actor.AdminID, actor.Role, "execution_queued", string(NotStarted), string(Queued), "", actor.Meta.RequestID, now); err != nil { return Request{}, err }
    if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
        ActorAdminID: &actor.AdminID, ActorRole: actor.Role, EventType: "account_lifecycle_approved",
        ObjectType: "cloud_user", ObjectID: &request.TargetUserID, Outcome: audit.OutcomeSuccess,
        ReasonCode: request.ReasonCode, TicketReference: request.TicketReference, Note: request.Note,
        ApprovalID: &request.ID, OperationID: &result.OperationID,
        BeforeState: map[string]string{"approval_status":"pending_review"},
        AfterState: map[string]string{"approval_status":"approved", "execution_status":"queued"},
        RequestID: actor.Meta.RequestID, SourceIPHMAC: actor.Meta.SourceIPHMAC, UserAgent: actor.Meta.UserAgent,
    }); err != nil { return Request{}, err }
    if err := tx.Commit(ctx); err != nil { return Request{}, errors.New("approval could not be committed") }
    return service.Get(ctx, actor, request.ID)
}
```

Add the non-executing terminal transitions and error mapping to the same file:

```go
func mapCloudError(err error) error {
    switch {
    case errors.Is(err, cloudadmin.ErrNotConfigured), errors.Is(err, cloudadmin.ErrUnavailable),
        errors.Is(err, cloudadmin.ErrContractViolation), errors.Is(err, cloudadmin.ErrNotFound),
        errors.Is(err, cloudadmin.ErrConflict):
        return err
    default:
        return cloudadmin.ErrUnavailable
    }
}

func (service *Service) expireTx(ctx context.Context, tx pgx.Tx, request Request, actor admin.Actor, now time.Time) error {
    command, err := tx.Exec(ctx, `UPDATE approval_requests SET approval_status='expired', updated_at=$2, version=version+1
        WHERE id=$1 AND approval_status='pending_review' AND version=$3`, request.ID, now, request.Version)
    if err != nil || command.RowsAffected() != 1 { return ErrStateConflict }
    if err := insertEvent(ctx, tx, request.ID, actor.AdminID, actor.Role, "expired", string(PendingReview), string(Expired), "APPROVAL_EXPIRED", actor.Meta.RequestID, now); err != nil { return err }
    _, err = service.audit.AppendTx(ctx, tx, audit.Record{
        ActorAdminID:&actor.AdminID, ActorRole:actor.Role, EventType:"account_lifecycle_expired",
        ObjectType:"cloud_user", ObjectID:&request.TargetUserID, Outcome:audit.OutcomeFailure,
        ErrorCode:"APPROVAL_EXPIRED", ApprovalID:&request.ID,
        BeforeState:map[string]string{"approval_status":"pending_review"},
        AfterState:map[string]string{"approval_status":"expired"},
        RequestID:actor.Meta.RequestID, SourceIPHMAC:actor.Meta.SourceIPHMAC, UserAgent:actor.Meta.UserAgent,
    })
    return err
}

func (service *Service) Reject(ctx context.Context, actor admin.Actor, id uuid.UUID) (Request, error) {
    tx, err := service.repository.begin(ctx)
    if err != nil { return Request{}, err }
    defer func() { _ = tx.Rollback(context.Background()) }()
    request, err := lockRequest(ctx, tx, id)
    if err != nil { return Request{}, err }
    now := service.clock().UTC()
    if err := request.CanReview(actor, now); err != nil {
        if errors.Is(err, ErrExpired) {
            if persistErr := service.expireTx(ctx, tx, request, actor, now); persistErr != nil { return Request{}, persistErr }
            if commitErr := tx.Commit(ctx); commitErr != nil { return Request{}, errors.New("approval expiry could not be committed") }
        }
        return Request{}, err
    }
    command, err := tx.Exec(ctx, `UPDATE approval_requests SET approval_status='rejected',
        reviewed_by_admin_id=$2, reviewed_at=$3, updated_at=$3, version=version+1
        WHERE id=$1 AND approval_status='pending_review' AND version=$4`, request.ID, actor.AdminID, now, request.Version)
    if err != nil || command.RowsAffected() != 1 { return Request{}, ErrStateConflict }
    if err := insertEvent(ctx, tx, request.ID, actor.AdminID, actor.Role, "rejected", string(PendingReview), string(Rejected), "", actor.Meta.RequestID, now); err != nil { return Request{}, err }
    if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
        ActorAdminID:&actor.AdminID, ActorRole:actor.Role, EventType:"account_lifecycle_rejected",
        ObjectType:"cloud_user", ObjectID:&request.TargetUserID, Outcome:audit.OutcomeSuccess,
        ReasonCode:request.ReasonCode, TicketReference:request.TicketReference, Note:request.Note,
        ApprovalID:&request.ID, BeforeState:map[string]string{"approval_status":"pending_review"},
        AfterState:map[string]string{"approval_status":"rejected"}, RequestID:actor.Meta.RequestID,
        SourceIPHMAC:actor.Meta.SourceIPHMAC, UserAgent:actor.Meta.UserAgent,
    }); err != nil { return Request{}, err }
    if err := tx.Commit(ctx); err != nil { return Request{}, errors.New("approval rejection could not be committed") }
    return service.Get(ctx, actor, request.ID)
}

func (service *Service) Cancel(ctx context.Context, actor admin.Actor, id uuid.UUID) (Request, error) {
    tx, err := service.repository.begin(ctx)
    if err != nil { return Request{}, err }
    defer func() { _ = tx.Rollback(context.Background()) }()
    request, err := lockRequest(ctx, tx, id)
    if err != nil { return Request{}, err }
    now := service.clock().UTC()
    if err := request.CanCancel(actor, now); err != nil {
        if errors.Is(err, ErrExpired) {
            if persistErr := service.expireTx(ctx, tx, request, actor, now); persistErr != nil { return Request{}, persistErr }
            if commitErr := tx.Commit(ctx); commitErr != nil { return Request{}, errors.New("approval expiry could not be committed") }
        }
        return Request{}, err
    }
    command, err := tx.Exec(ctx, `UPDATE approval_requests SET approval_status='cancelled', updated_at=$2, version=version+1
        WHERE id=$1 AND approval_status='pending_review' AND version=$3`, request.ID, now, request.Version)
    if err != nil || command.RowsAffected() != 1 { return Request{}, ErrStateConflict }
    if err := insertEvent(ctx, tx, request.ID, actor.AdminID, actor.Role, "cancelled", string(PendingReview), string(Cancelled), "", actor.Meta.RequestID, now); err != nil { return Request{}, err }
    if _, err := service.audit.AppendTx(ctx, tx, audit.Record{
        ActorAdminID:&actor.AdminID, ActorRole:actor.Role, EventType:"account_lifecycle_cancelled",
        ObjectType:"cloud_user", ObjectID:&request.TargetUserID, Outcome:audit.OutcomeSuccess,
        ReasonCode:request.ReasonCode, TicketReference:request.TicketReference, Note:request.Note,
        ApprovalID:&request.ID, BeforeState:map[string]string{"approval_status":"pending_review"},
        AfterState:map[string]string{"approval_status":"cancelled"}, RequestID:actor.Meta.RequestID,
        SourceIPHMAC:actor.Meta.SourceIPHMAC, UserAgent:actor.Meta.UserAgent,
    }); err != nil { return Request{}, err }
    if err := tx.Commit(ctx); err != nil { return Request{}, errors.New("approval cancellation could not be committed") }
    return service.Get(ctx, actor, request.ID)
}

func (service *Service) List(ctx context.Context, actor admin.Actor, filter ListFilter) (Page, error) {
    return service.repository.List(ctx, actor, filter)
}

func (service *Service) Get(ctx context.Context, actor admin.Actor, id uuid.UUID) (Request, error) {
    return service.repository.Get(ctx, actor, id)
}
```

The `operations.Service.EnqueueTx` forwarding method shown in Task 5 is the exact implementation required for `operations.TransactionalEnqueuer`; do not add a second code path.

- [ ] **Step 7: Run approval integration and race tests**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/approval -count=1 -v
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test -race ./internal/approval -count=1
```

Expected: PASS with exactly one concurrent approval transition and one Outbox row.

- [ ] **Step 8: Commit dual-control approval**

```bash
git add internal/approval internal/operations/service.go
git commit -m "feat: add dual-control account approvals"
```

### Task 7: Outbox Delivery, Retry, and Unknown-result Reconciliation

**Files:**
- Modify: `internal/operations/model.go`
- Modify: `internal/operations/repository.go`
- Modify: `internal/operations/repository_test.go`
- Create: `internal/operations/worker.go`
- Create: `internal/operations/worker_test.go`
- Modify: `internal/approval/repository.go`
- Modify: `internal/approval/service.go`
- Modify: `internal/approval/service_test.go`

**Interfaces:**
- Produces: `operations.NewWorker(WorkerConfig) (*Worker, error)` and `Worker.Run(context.Context) error`.
- Consumes: `cloudadmin.Client` and `approval.ExecutionSink` without importing approval persistence details.
- Guarantees: the same operation ID is used for every command retry and operation-status reconciliation.

- [ ] **Step 1: Write failing retry and reconciliation tests**

Create `internal/operations/worker_test.go`:

```go
func TestWorkerReconcilesUnknownResultWithoutChangingOperationID(t *testing.T) {
    postgres := testkit.Postgres(t)
    fixture := newWorkerFixture(t, postgres)
    accepted := fixture.enqueue(t, RevokeSession)
    fixture.cloud.commandErrors = []error{cloudadmin.ErrUnavailable}
    fixture.cloud.operationResults = []cloudResult{{operation: cloudadmin.Operation{
        ID: accepted.OperationID, Status: cloudadmin.OperationSucceeded,
        UpdatedAt: fixture.clock().Add(time.Second),
    }}}

    if err := fixture.worker.RunOnce(context.Background()); err != nil { t.Fatal(err) }
    first, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
    if err != nil { t.Fatal(err) }
    if first.State != StateReconciling { t.Fatalf("first state = %s", first.State) }

    fixture.advance(2 * time.Second)
    if err := fixture.worker.RunOnce(context.Background()); err != nil { t.Fatal(err) }
    final, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
    if err != nil { t.Fatal(err) }
    if final.State != StateSucceeded { t.Fatalf("final state = %s", final.State) }
    if !slices.Equal(fixture.cloud.commandOperationIDs, []uuid.UUID{accepted.OperationID}) ||
        !slices.Equal(fixture.cloud.queriedOperationIDs, []uuid.UUID{accepted.OperationID}) {
        t.Fatalf("operation IDs = commands:%v queries:%v", fixture.cloud.commandOperationIDs, fixture.cloud.queriedOperationIDs)
    }
}

func TestWorkerRecoversExpiredLeaseAfterRestart(t *testing.T) {
    postgres := testkit.Postgres(t)
    fixture := newWorkerFixture(t, postgres)
    accepted := fixture.enqueue(t, RevokeDevice)
    fixture.advance(2 * time.Minute)
    _, err := postgres.Exec(context.Background(), `
        UPDATE admin_outbox SET status='executing', lease_until=$2, updated_at=$2
        WHERE operation_id=$1
    `, accepted.OperationID, fixture.clock().Add(-time.Minute))
    if err != nil { t.Fatal(err) }
    fixture.cloud.commandResults = []cloudadmin.Operation{{
        ID: accepted.OperationID, Status: cloudadmin.OperationSucceeded, UpdatedAt: fixture.clock(),
    }}
    if err := fixture.worker.RunOnce(context.Background()); err != nil { t.Fatal(err) }
    result, err := fixture.operations.Get(context.Background(), fixture.actor, accepted.OperationID)
    if err != nil || result.State != StateSucceeded { t.Fatalf("result = %+v, %v", result, err) }
}

func TestCleanupExpiredDeletesOnlyTerminalOperationPairs(t *testing.T) {
    postgres := testkit.Postgres(t)
    fixture := newWorkerFixture(t, postgres)
    completed := fixture.enqueue(t, RevokeSession)
    if err := fixture.worker.RunOnce(context.Background()); err != nil { t.Fatal(err) }
    pending := fixture.enqueue(t, RevokeDevice)
    fixture.advance(31 * 24 * time.Hour)
    deleted, err := fixture.operations.repository.CleanupExpired(context.Background(), fixture.clock(), 16)
    if err != nil || deleted != 1 { t.Fatalf("CleanupExpired() = %d, %v", deleted, err) }
    for _, table := range []string{"admin_outbox", "admin_idempotency_records"} {
        var completedCount, pendingCount int
        if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM `+table+` WHERE operation_id=$1`, completed.OperationID).Scan(&completedCount); err != nil { t.Fatal(err) }
        if err := postgres.QueryRow(context.Background(), `SELECT count(*) FROM `+table+` WHERE operation_id=$1`, pending.OperationID).Scan(&pendingCount); err != nil { t.Fatal(err) }
        if completedCount != 0 || pendingCount != 1 { t.Fatalf("%s completed/pending = %d/%d", table, completedCount, pendingCount) }
    }
}
```

Add these deterministic fixtures below the tests:

```go
type cloudResult struct {
    operation cloudadmin.Operation
    err error
}

type workerCloudStub struct {
    cloudadmin.DisabledClient
    commandErrors []error
    commandResults []cloudadmin.Operation
    operationResults []cloudResult
    commandOperationIDs []uuid.UUID
    queriedOperationIDs []uuid.UUID
    now func() time.Time
}

func (stub *workerCloudStub) Health(context.Context) (cloudadmin.Health, error) {
    return cloudadmin.Health{Configured:true, Availability:cloudadmin.Available, CheckedAt:stub.now()}, nil
}
func (stub *workerCloudStub) command(meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
    stub.commandOperationIDs = append(stub.commandOperationIDs, meta.OperationID)
    if len(stub.commandErrors) > 0 {
        err := stub.commandErrors[0]
        stub.commandErrors = stub.commandErrors[1:]
        return cloudadmin.Operation{}, err
    }
    if len(stub.commandResults) > 0 {
        result := stub.commandResults[0]
        stub.commandResults = stub.commandResults[1:]
        return result, nil
    }
    return cloudadmin.Operation{ID:meta.OperationID, Status:cloudadmin.OperationSucceeded, UpdatedAt:stub.now()}, nil
}
func (stub *workerCloudStub) RevokeDevice(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
    return stub.command(meta)
}
func (stub *workerCloudStub) RevokeSession(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
    return stub.command(meta)
}
func (stub *workerCloudStub) DisableUser(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
    return stub.command(meta)
}
func (stub *workerCloudStub) EnableUser(_ context.Context, _ uuid.UUID, meta cloudadmin.CommandMeta) (cloudadmin.Operation, error) {
    return stub.command(meta)
}
func (stub *workerCloudStub) GetOperation(_ context.Context, id uuid.UUID) (cloudadmin.Operation, error) {
    stub.queriedOperationIDs = append(stub.queriedOperationIDs, id)
    if len(stub.operationResults) == 0 { return cloudadmin.Operation{}, cloudadmin.ErrNotFound }
    result := stub.operationResults[0]
    stub.operationResults = stub.operationResults[1:]
    return result.operation, result.err
}

type noopExecutionSink struct{}
func (noopExecutionSink) ApplyExecutionTx(context.Context, pgx.Tx, uuid.UUID, State, string, string, time.Time) error { return nil }

type workerFixture struct {
    operations *Service
    worker *Worker
    cloud *workerCloudStub
    actor admin.Actor
    now time.Time
}

func newWorkerFixture(t *testing.T, postgres *pgxpool.Pool) *workerFixture {
    t.Helper()
    fixture := &workerFixture{now:time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)}
    fixture.actor = seedActor(t, postgres, rbac.Support)
    fixture.cloud = &workerCloudStub{now:fixture.clock}
    recorder, err := audit.NewService(postgres)
    if err != nil { t.Fatal(err) }
    fixture.operations, err = NewService(ServiceConfig{
        PostgreSQL:postgres, HMACKey:bytes.Repeat([]byte{7}, 32), Cloud:fixture.cloud,
        Audit:recorder, Clock:fixture.clock,
    })
    if err != nil { t.Fatal(err) }
    fixture.worker, err = NewWorker(WorkerConfig{
        Operations:fixture.operations, Cloud:fixture.cloud, ExecutionSink:noopExecutionSink{},
        Clock:fixture.clock, PollInterval:time.Second, BatchSize:8, Lease:30*time.Second,
        Jitter:func() time.Duration { return 0 },
    })
    if err != nil { t.Fatal(err) }
    return fixture
}

func (fixture *workerFixture) clock() time.Time { return fixture.now }
func (fixture *workerFixture) advance(duration time.Duration) { fixture.now = fixture.now.Add(duration) }
func (fixture *workerFixture) enqueue(t *testing.T, action Action) Result {
    t.Helper()
    result, err := fixture.operations.EnqueueImmediate(context.Background(), EnqueueRequest{
        Actor:fixture.actor, Action:action, TargetID:uuid.New(), ExpectedRevision:1,
        BrowserIdempotencyKey:uuid.NewString(),
        Reason:admin.ActionReason{Code:"suspected_compromise", Meta:fixture.actor.Meta},
    })
    if err != nil { t.Fatal(err) }
    return result
}
```

- [ ] **Step 2: Run Worker tests and verify failure**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/operations -run TestWorker -count=1 -v
```

Expected: FAIL because `Worker` and claiming methods do not exist.

- [ ] **Step 3: Add claimed-job and execution-sink interfaces**

Append to `internal/operations/model.go`:

```go
type Job struct {
    OperationID uuid.UUID
    Action Action
    TargetID uuid.UUID
    ApprovalID *uuid.UUID
    ActorAdminID uuid.UUID
    ActorRole rbac.Role
    ExpectedRevision int64
    ReasonCode string
    TicketReference string
    Note string
    RequestID string
    Attempts int
    State State
}

type ExecutionSink interface {
    ApplyExecutionTx(context.Context, pgx.Tx, uuid.UUID, State, string, string, time.Time) error
}
```

Implement `ApplyExecutionTx` on `approval.Service` with the exact transition table below:

```go
func executionTransitionAllowed(before ExecutionStatus, after operations.State) bool {
    switch before {
    case Queued:
        return after == operations.StateExecuting || after == operations.StateReconciling ||
            after == operations.StateSucceeded || after == operations.StateFailed || after == operations.StateConflict
    case Executing:
        return after == operations.StateQueued || after == operations.StateReconciling ||
            after == operations.StateSucceeded || after == operations.StateFailed || after == operations.StateConflict
    case Reconciling:
        return after == operations.StateQueued || after == operations.StateExecuting ||
            after == operations.StateSucceeded || after == operations.StateFailed || after == operations.StateConflict
    default:
        return false
    }
}

func executionEvent(state operations.State) (string, error) {
    switch state {
    case operations.StateQueued: return "execution_queued", nil
    case operations.StateExecuting: return "execution_started", nil
    case operations.StateReconciling: return "execution_reconciling", nil
    case operations.StateSucceeded: return "execution_succeeded", nil
    case operations.StateFailed: return "execution_failed", nil
    case operations.StateConflict: return "execution_conflict", nil
    default: return "", ErrStateConflict
    }
}

func (service *Service) ApplyExecutionTx(ctx context.Context, tx pgx.Tx, operationID uuid.UUID,
    next operations.State, resultCode, requestID string, now time.Time) error {
    var request Request
    var reviewerID *uuid.UUID
    err := tx.QueryRow(ctx, `SELECT id, target_user_id, approval_status, execution_status,
        operation_id, reviewed_by_admin_id, version FROM approval_requests WHERE operation_id=$1 FOR UPDATE`, operationID).Scan(
        &request.ID, &request.TargetUserID, &request.Status, &request.ExecutionStatus,
        &request.OperationID, &reviewerID, &request.Version,
    )
    if errors.Is(err, pgx.ErrNoRows) { return ErrNotFound }
    if err != nil || request.Status != Approved || request.OperationID == nil ||
        *request.OperationID != operationID || reviewerID == nil ||
        !executionTransitionAllowed(request.ExecutionStatus, next) {
        return ErrStateConflict
    }
    eventType, err := executionEvent(next)
    if err != nil { return err }
    command, err := tx.Exec(ctx, `UPDATE approval_requests SET execution_status=$2, updated_at=$3, version=version+1
        WHERE id=$1 AND version=$4 AND approval_status='approved' AND operation_id=$5`,
        request.ID, next, now, request.Version, operationID)
    if err != nil || command.RowsAffected() != 1 { return ErrStateConflict }
    return insertEvent(ctx, tx, request.ID, *reviewerID, rbac.SuperAdmin, eventType,
        string(request.ExecutionStatus), string(next), resultCode, requestID, now)
}
```

- [ ] **Step 4: Implement atomic claim and transition persistence**

Add to `internal/operations/repository.go`:

```go
func (repository *repository) Claim(ctx context.Context, limit int, lease time.Duration, sink ExecutionSink) ([]Job, error) {
    if limit < 1 || limit > 32 || lease < 5*time.Second || lease > 5*time.Minute { return nil, ErrInvalidRequest }
    now := repository.clock().UTC()
    tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
    if err != nil { return nil, errors.New("Outbox claim transaction could not start") }
    defer func() { _ = tx.Rollback(context.Background()) }()
    rows, err := tx.Query(ctx, `
        WITH candidates AS (
            SELECT operation_id, status AS previous_status FROM admin_outbox
            WHERE (
                status IN ('queued','reconciling') AND available_at <= $1
            ) OR (
                status='executing' AND lease_until < $1
            )
            ORDER BY available_at, created_at, operation_id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
        )
        UPDATE admin_outbox AS outbox
        SET status='executing', attempts=attempts+1, lease_until=$3, updated_at=$1
        FROM candidates
        WHERE outbox.operation_id=candidates.operation_id
        RETURNING outbox.operation_id, outbox.action, outbox.target_id, outbox.approval_id,
            outbox.actor_admin_id, outbox.actor_role, outbox.expected_revision, outbox.reason_code,
            COALESCE(outbox.ticket_reference,''), COALESCE(outbox.note,''),
            outbox.request_id, outbox.attempts,
            CASE WHEN candidates.previous_status='executing' THEN 'reconciling' ELSE candidates.previous_status END
    `, now, limit, now.Add(lease))
    if err != nil { return nil, errors.New("Outbox jobs could not be claimed") }
    defer rows.Close()
    jobs := make([]Job, 0, limit)
    for rows.Next() {
        var job Job
        if err := rows.Scan(&job.OperationID, &job.Action, &job.TargetID, &job.ApprovalID,
            &job.ActorAdminID, &job.ActorRole, &job.ExpectedRevision, &job.ReasonCode, &job.TicketReference,
            &job.Note, &job.RequestID, &job.Attempts, &job.State); err != nil {
            return nil, errors.New("Outbox job could not be decoded")
        }
        jobs = append(jobs, job)
    }
    if err := rows.Err(); err != nil { return nil, errors.New("Outbox jobs could not be read") }
    rows.Close()
    for _, job := range jobs {
        if _, err := tx.Exec(ctx, `UPDATE admin_idempotency_records SET state='executing', updated_at=$2 WHERE operation_id=$1`, job.OperationID, now); err != nil { return nil, err }
        if job.ApprovalID != nil && job.State == StateQueued {
            if err := sink.ApplyExecutionTx(ctx, tx, job.OperationID, StateExecuting, "", job.RequestID, now); err != nil { return nil, err }
        }
        if _, err := repository.audit.AppendTx(ctx, tx, audit.Record{
            ActorAdminID:&job.ActorAdminID, ActorRole:job.ActorRole, EventType:"cloud_operation_started",
            ObjectType:string(job.Action), ObjectID:&job.TargetID, Outcome:audit.OutcomeSuccess,
            ReasonCode:job.ReasonCode, TicketReference:job.TicketReference, Note:job.Note,
            ApprovalID:job.ApprovalID, OperationID:&job.OperationID,
            BeforeState:map[string]string{"execution_status":string(job.State)},
            AfterState:map[string]string{"execution_status":"executing"}, RequestID:job.RequestID,
        }); err != nil { return nil, err }
    }
    if err := tx.Commit(ctx); err != nil { return nil, errors.New("Outbox claims could not be committed") }
    return jobs, nil
}
```

Add this atomic transition implementation to `repository.go`:

```go
func terminalState(state State) bool {
    return state == StateSucceeded || state == StateFailed || state == StateConflict
}

func transitionEvent(state State) string {
    switch state {
    case StateQueued: return "cloud_operation_queued"
    case StateReconciling: return "cloud_operation_reconciling"
    case StateSucceeded: return "cloud_operation_succeeded"
    case StateConflict: return "cloud_operation_conflict"
    default: return "cloud_operation_failed"
    }
}

func (repository *repository) Transition(ctx context.Context, job Job, nextState State,
    errorCode string, nextAttemptAt time.Time, sink ExecutionSink) error {
    if nextState != StateQueued && nextState != StateReconciling && !terminalState(nextState) {
        return ErrStateConflict
    }
    if (nextState == StateFailed || nextState == StateConflict || nextState == StateReconciling) &&
        !operationErrorCodePattern.MatchString(errorCode) { return ErrInvalidRequest }
    now := repository.clock().UTC()
    availableAt := nextAttemptAt.UTC()
    if terminalState(nextState) { availableAt = now }
    if !terminalState(nextState) && !availableAt.After(now) { return ErrInvalidRequest }
    tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
    if err != nil { return errors.New("operation transition could not start") }
    defer func() { _ = tx.Rollback(context.Background()) }()
    completedAt := any(nil)
    if terminalState(nextState) { completedAt = now }
    command, err := tx.Exec(ctx, `UPDATE admin_outbox SET status=$2, last_error_code=NULLIF($3,''),
        available_at=$4, lease_until=NULL, completed_at=$5, updated_at=$6
        WHERE operation_id=$1 AND status='executing'`,
        job.OperationID, nextState, errorCode, availableAt, completedAt, now)
    if err != nil { return errors.New("Outbox transition could not be stored") }
    if command.RowsAffected() != 1 { return ErrStateConflict }
    resultJSON, err := json.Marshal(map[string]string{"state":string(nextState), "error_code":errorCode})
    if err != nil { return errors.New("operation result could not be encoded") }
    command, err = tx.Exec(ctx, `UPDATE admin_idempotency_records SET state=$2, error_code=NULLIF($3,''),
        result=$4, completed_at=$5, updated_at=$6 WHERE operation_id=$1 AND state='executing'`,
        job.OperationID, nextState, errorCode, resultJSON, completedAt, now)
    if err != nil || command.RowsAffected() != 1 { return ErrStateConflict }
    if job.ApprovalID != nil {
        if err := sink.ApplyExecutionTx(ctx, tx, job.OperationID, nextState, errorCode, job.RequestID, now); err != nil { return err }
    }
    outcome := audit.OutcomeSuccess
    if nextState != StateSucceeded && nextState != StateQueued { outcome = audit.OutcomeFailure }
    if _, err := repository.audit.AppendTx(ctx, tx, audit.Record{
        ActorAdminID:&job.ActorAdminID, ActorRole:job.ActorRole, EventType:transitionEvent(nextState),
        ObjectType:string(job.Action), ObjectID:&job.TargetID, Outcome:outcome, ErrorCode:errorCode,
        ReasonCode:job.ReasonCode, TicketReference:job.TicketReference, Note:job.Note,
        ApprovalID:job.ApprovalID, OperationID:&job.OperationID,
        BeforeState:map[string]string{"execution_status":"executing"},
        AfterState:map[string]string{"execution_status":string(nextState)}, RequestID:job.RequestID,
    }); err != nil { return err }
    if err := tx.Commit(ctx); err != nil { return errors.New("operation transition could not be committed") }
    return nil
}

func (repository *repository) CleanupExpired(ctx context.Context, now time.Time, limit int) (int, error) {
    if limit < 1 || limit > 256 { return 0, ErrInvalidRequest }
    tx, err := repository.postgres.BeginTx(ctx, pgx.TxOptions{})
    if err != nil { return 0, errors.New("operation cleanup could not start") }
    defer func() { _ = tx.Rollback(context.Background()) }()
    rows, err := tx.Query(ctx, `SELECT operation_id FROM admin_idempotency_records
        WHERE state IN ('succeeded','failed','conflict') AND expires_at < $1
        ORDER BY expires_at, operation_id FOR UPDATE SKIP LOCKED LIMIT $2`, now.UTC(), limit)
    if err != nil { return 0, errors.New("expired operations could not be selected") }
    identifiers := make([]uuid.UUID, 0, limit)
    for rows.Next() {
        var id uuid.UUID
        if err := rows.Scan(&id); err != nil { rows.Close(); return 0, err }
        identifiers = append(identifiers, id)
    }
    if err := rows.Err(); err != nil { rows.Close(); return 0, err }
    rows.Close()
    for _, id := range identifiers {
        if _, err := tx.Exec(ctx, `DELETE FROM admin_outbox WHERE operation_id=$1 AND status IN ('succeeded','failed','conflict')`, id); err != nil { return 0, err }
        if _, err := tx.Exec(ctx, `DELETE FROM admin_idempotency_records WHERE operation_id=$1 AND state IN ('succeeded','failed','conflict')`, id); err != nil { return 0, err }
    }
    if err := tx.Commit(ctx); err != nil { return 0, errors.New("operation cleanup could not be committed") }
    return len(identifiers), nil
}
```

- [ ] **Step 5: Implement deterministic execution and reconciliation**

Create `internal/operations/worker.go`:

```go
type WorkerConfig struct {
    Operations *Service
    Cloud cloudadmin.Client
    ExecutionSink ExecutionSink
    Clock func() time.Time
    PollInterval time.Duration
    BatchSize int
    Lease time.Duration
    Jitter func() time.Duration
}

type Worker struct {
    repository *repository
    cloud cloudadmin.Client
    sink ExecutionSink
    clock func() time.Time
    pollInterval time.Duration
    batchSize int
    lease time.Duration
    jitter func() time.Duration
    lastCleanup time.Time
}

func NewWorker(config WorkerConfig) (*Worker, error) {
    if config.Operations == nil || config.Operations.repository == nil || config.Cloud == nil ||
        config.ExecutionSink == nil || config.Clock == nil || config.PollInterval <= 0 ||
        config.BatchSize < 1 || config.BatchSize > 32 || config.Lease < 5*time.Second {
        return nil, errors.New("Outbox Worker dependencies are invalid")
    }
    jitter := config.Jitter
    if jitter == nil { jitter = secureJitter }
    return &Worker{
        repository:config.Operations.repository, cloud:config.Cloud, sink:config.ExecutionSink,
        clock:config.Clock, pollInterval:config.PollInterval, batchSize:config.BatchSize, lease:config.Lease,
        jitter:jitter,
    }, nil
}

func (worker *Worker) RunOnce(ctx context.Context) error {
    now := worker.clock().UTC()
    if worker.lastCleanup.IsZero() || now.Sub(worker.lastCleanup) >= time.Hour {
        if _, err := worker.repository.CleanupExpired(ctx, now, 128); err != nil { return err }
        worker.lastCleanup = now
    }
    jobs, err := worker.repository.Claim(ctx, worker.batchSize, worker.lease, worker.sink)
    if err != nil { return err }
    for _, job := range jobs {
        if err := worker.process(ctx, job); err != nil && !errors.Is(err, context.Canceled) { return err }
    }
    return nil
}

func (worker *Worker) Run(ctx context.Context) error {
    ticker := time.NewTicker(worker.pollInterval)
    defer ticker.Stop()
    for {
        if err := worker.RunOnce(ctx); err != nil && ctx.Err() == nil { return err }
        select {
        case <-ctx.Done(): return nil
        case <-ticker.C:
        }
    }
}

func (worker *Worker) process(ctx context.Context, job Job) error {
    if job.State == StateReconciling {
        operation, err := worker.cloud.GetOperation(ctx, job.OperationID)
        return worker.applyRemoteResult(ctx, job, operation, err)
    }
    meta := cloudadmin.CommandMeta{
        OperationID: job.OperationID, ActorAdminID: job.ActorAdminID, ApprovalID: job.ApprovalID,
        RequestID: job.RequestID, ReasonCode: job.ReasonCode, TicketReference: job.TicketReference,
        Note: job.Note, ExpectedRevision: job.ExpectedRevision,
    }
    var operation cloudadmin.Operation
    var err error
    switch job.Action {
    case RevokeDevice:
        operation, err = worker.cloud.RevokeDevice(ctx, job.TargetID, meta)
    case RevokeSession:
        operation, err = worker.cloud.RevokeSession(ctx, job.TargetID, meta)
    case DisableUser:
        operation, err = worker.cloud.DisableUser(ctx, job.TargetID, meta)
    case EnableUser:
        operation, err = worker.cloud.EnableUser(ctx, job.TargetID, meta)
    default:
        err = cloudadmin.ErrContractViolation
    }
    return worker.applyRemoteResult(ctx, job, operation, err)
}

func (worker *Worker) applyRemoteResult(ctx context.Context, job Job, operation cloudadmin.Operation, err error) error {
    now := worker.clock().UTC()
    switch {
    case errors.Is(err, cloudadmin.ErrUnavailable):
        return worker.repository.Transition(ctx, job, StateReconciling, "OPERATION_STATUS_UNKNOWN", now.Add(backoff(job.Attempts, worker.jitter)), worker.sink)
    case errors.Is(err, cloudadmin.ErrConflict):
        return worker.repository.Transition(ctx, job, StateConflict, "USER_STATE_CONFLICT", time.Time{}, worker.sink)
    case errors.Is(err, cloudadmin.ErrNotFound) && job.State == StateReconciling:
        return worker.repository.Transition(ctx, job, StateQueued, "", now.Add(backoff(job.Attempts, worker.jitter)), worker.sink)
    case err != nil:
        return worker.repository.Transition(ctx, job, StateFailed, stableExecutionError(err), time.Time{}, worker.sink)
    case operation.ID != job.OperationID:
        return worker.repository.Transition(ctx, job, StateFailed, "CLOUD_CONTRACT_VIOLATION", time.Time{}, worker.sink)
    case operation.Status == cloudadmin.OperationSucceeded:
        return worker.repository.Transition(ctx, job, StateSucceeded, "", time.Time{}, worker.sink)
    case operation.Status == cloudadmin.OperationConflict:
        return worker.repository.Transition(ctx, job, StateConflict, stableRemoteCode(operation.ErrorCode, "USER_STATE_CONFLICT"), time.Time{}, worker.sink)
    case operation.Status == cloudadmin.OperationFailed:
        return worker.repository.Transition(ctx, job, StateFailed, stableRemoteCode(operation.ErrorCode, "CLOUD_OPERATION_FAILED"), time.Time{}, worker.sink)
    default:
        return worker.repository.Transition(ctx, job, StateReconciling, "OPERATION_STATUS_UNKNOWN", now.Add(backoff(job.Attempts, worker.jitter)), worker.sink)
    }
}

func stableExecutionError(err error) string {
    switch {
    case errors.Is(err, cloudadmin.ErrNotConfigured): return "CLOUD_NOT_CONFIGURED"
    case errors.Is(err, cloudadmin.ErrContractViolation): return "CLOUD_CONTRACT_VIOLATION"
    case errors.Is(err, context.DeadlineExceeded): return "CLOUD_TIMEOUT"
    default: return "CLOUD_OPERATION_FAILED"
    }
}

func stableRemoteCode(value, fallback string) string {
    if operationErrorCodePattern.MatchString(value) { return value }
    return fallback
}

func secureJitter() time.Duration {
    maximum := big.NewInt(251)
    value, err := rand.Int(rand.Reader, maximum)
    if err != nil { return 0 }
    return time.Duration(value.Int64()) * time.Millisecond
}

func backoff(attempt int, jitter func() time.Duration) time.Duration {
    if attempt < 1 { attempt = 1 }
    if attempt > 8 { attempt = 8 }
    bounded := jitter()
    if bounded < 0 || bounded > 250*time.Millisecond { bounded = 0 }
    return time.Duration(1<<uint(attempt-1))*time.Second + bounded
}
```

In `newWorkerFixture`, pass `Jitter:func() time.Duration { return 0 }`; production composition omits it and therefore uses `secureJitter`. No stable error mapping includes upstream error text.

- [ ] **Step 6: Run Worker, approval, and race suites**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/operations ./internal/approval -count=1 -v
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test -race ./internal/operations ./internal/approval -count=1
```

Expected: PASS with restart recovery, one operation ID across retries, and approval execution state updated in the same transition transaction.

- [ ] **Step 7: Commit reliable execution**

```bash
git add internal/operations internal/approval
git commit -m "feat: deliver admin operations through outbox"
```

### Task 8: Cloud-control Browser API, RBAC, and Runtime Composition

**Files:**
- Create: `internal/cloudcontrol/service.go`
- Create: `internal/cloudcontrol/service_test.go`
- Create: `internal/cloudcontrol/http.go`
- Create: `internal/cloudcontrol/http_test.go`
- Modify: `cmd/aera-admin/main.go`
- Modify: `cmd/aera-admin/main_test.go`
- Modify: `internal/audit/model.go`
- Modify: `internal/audit/model_test.go`

**Interfaces:**
- Consumes: Cloud client, operation service/Worker, approval service, existing auth middleware, PostgreSQL, and Redis.
- Produces: all scoped `/api/v1/cloud-*`, `/api/v1/approval-requests`, `/api/v1/operations`, and `/api/v1/system/health` routes.
- Produces: one runtime composition value containing the API Handler and Outbox Worker.

- [ ] **Step 1: Write failing HTTP permission and no-leak tests**

Create `internal/cloudcontrol/http_test.go`:

```go
func TestCloudRoutesEnforceFixedRBACAtTheAPI(t *testing.T) {
    service := &handlerStub{}
    handler := NewHandler(service)
    cases := []struct {
        role rbac.Role
        method string
        path string
        body string
        want int
    }{
        {rbac.Support, http.MethodPost, "/cloud-users/lookup", `{"type":"email","value":"alice@example.test"}`, http.StatusOK},
        {rbac.Developer, http.MethodPost, "/cloud-users/lookup", `{"type":"email","value":"alice@example.test"}`, http.StatusForbidden},
        {rbac.Support, http.MethodPost, "/approval-requests", `{}`, http.StatusForbidden},
        {rbac.Operator, http.MethodPost, "/approval-requests", validApprovalJSON(), http.StatusCreated},
        {rbac.Operator, http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000041/approve", `{}`, http.StatusForbidden},
        {rbac.SuperAdmin, http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000041/approve", `{}`, http.StatusAccepted},
        {rbac.Finance, http.MethodGet, "/cloud-users", "", http.StatusForbidden},
    }
    for _, item := range cases {
        t.Run(string(item.role)+item.method+item.path, func(t *testing.T) {
            request := httptest.NewRequest(item.method, item.path, strings.NewReader(item.body))
            request.Header.Set("Content-Type", "application/json")
            request.Header.Set("Idempotency-Key", "019f0000-0000-7000-8000-000000000042")
            request = auth.WithPrincipal(request, testPrincipal(item.role, true))
            response := httptest.NewRecorder()
            handler.ServeHTTP(response, request)
            if response.Code != item.want { t.Fatalf("status/body = %d %q", response.Code, response.Body.String()) }
        })
    }
}

func TestExactLookupDoesNotEchoOrLogRawIdentity(t *testing.T) {
    rawIdentity := "lookup.canary@example.test"
    service := &handlerStub{lookupResult: maskedUser()}
    var logs bytes.Buffer
    handler := NewHandlerWithLogger(service, slog.New(slog.NewJSONHandler(&logs, nil)))
    request := httptest.NewRequest(http.MethodPost, "/cloud-users/lookup", strings.NewReader(
        `{"type":"email","value":"`+rawIdentity+`"}`,
    ))
    request.Header.Set("Content-Type", "application/json")
    request = auth.WithPrincipal(request, testPrincipal(rbac.Support, false))
    response := httptest.NewRecorder()
    handler.ServeHTTP(response, request)
    if response.Code != http.StatusOK { t.Fatalf("status/body = %d %q", response.Code, response.Body.String()) }
    if strings.Contains(response.Body.String(), rawIdentity) || strings.Contains(logs.String(), rawIdentity) {
        t.Fatal("raw lookup identity escaped the one-request boundary")
    }
    if service.observedLookup.Value != rawIdentity { t.Fatal("service did not receive exact lookup value") }
}

func TestEveryCloudRouteHasFixedSixRoleMatrix(t *testing.T) {
    allRoles := []rbac.Role{rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support, rbac.Finance, rbac.Auditor}
    allowed := func(roles ...rbac.Role) map[rbac.Role]bool {
        result := make(map[rbac.Role]bool, len(roles))
        for _, role := range roles { result[role] = true }
        return result
    }
    cases := []struct {
        method, path, body string
        success int
        allowed map[rbac.Role]bool
    }{
        {http.MethodGet, "/cloud-users?limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
        {http.MethodPost, "/cloud-users/lookup", `{"type":"email","value":"matrix@example.test"}`, 200, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
        {http.MethodGet, "/cloud-users/019f0000-0000-7000-8000-000000000043", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support)},
        {http.MethodGet, "/cloud-users/019f0000-0000-7000-8000-000000000043/devices?limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support)},
        {http.MethodGet, "/cloud-users/019f0000-0000-7000-8000-000000000043/sessions?limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Support)},
        {http.MethodPost, "/cloud-devices/019f0000-0000-7000-8000-000000000044/revoke", `{"expected_revision":1,"reason_code":"lost_device","ticket_reference":"","note":""}`, 202, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
        {http.MethodPost, "/cloud-sessions/019f0000-0000-7000-8000-000000000045/revoke", `{"expected_revision":1,"reason_code":"session_cleanup","ticket_reference":"","note":""}`, 202, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
        {http.MethodPost, "/approval-requests", validApprovalJSON(), 201, allowed(rbac.Operator)},
        {http.MethodGet, "/approval-requests?view=all&limit=50", "", 200, allowed(rbac.SuperAdmin, rbac.Operator)},
        {http.MethodGet, "/approval-requests/019f0000-0000-7000-8000-000000000046", "", 200, allowed(rbac.SuperAdmin, rbac.Operator)},
        {http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000046/approve", `{}`, 202, allowed(rbac.SuperAdmin)},
        {http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000046/reject", `{}`, 200, allowed(rbac.SuperAdmin)},
        {http.MethodPost, "/approval-requests/019f0000-0000-7000-8000-000000000046/cancel", `{}`, 200, allowed(rbac.Operator)},
        {http.MethodGet, "/operations/019f0000-0000-7000-8000-000000000047", "", 200, allowed(rbac.SuperAdmin, rbac.Operator, rbac.Support)},
        {http.MethodGet, "/system/health", "", 200, allowed(rbac.SuperAdmin, rbac.Developer, rbac.Operator, rbac.Auditor)},
    }
    handler := NewHandler(&handlerStub{})
    for _, route := range cases {
        for _, role := range allRoles {
            t.Run(string(role)+" "+route.method+" "+route.path, func(t *testing.T) {
                request := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
                if route.method == http.MethodPost {
                    request.Header.Set("Content-Type", "application/json")
                    request.Header.Set("Idempotency-Key", uuid.NewString())
                }
                request = auth.WithPrincipal(request, testPrincipal(role, true))
                response := httptest.NewRecorder()
                handler.ServeHTTP(response, request)
                want := http.StatusForbidden
                if route.allowed[role] { want = route.success }
                if response.Code != want { t.Fatalf("status/body = %d %q, want %d", response.Code, response.Body.String(), want) }
            })
        }
    }
}
```

Add these exact test fixtures below the assertions:

```go
type handlerStub struct {
    lookupResult cloudadmin.User
    observedLookup cloudadmin.LookupRequest
}

func (stub *handlerStub) ListUsers(context.Context, admin.Actor, cloudadmin.ListUsersRequest) (cloudadmin.Page[cloudadmin.User], error) {
    return cloudadmin.Page[cloudadmin.User]{Items:[]cloudadmin.User{}}, nil
}
func (stub *handlerStub) LookupUser(_ context.Context, _ admin.Actor, input cloudadmin.LookupRequest) (cloudadmin.User, error) {
    stub.observedLookup = input
    if stub.lookupResult.ID == uuid.Nil { return maskedUser(), nil }
    return stub.lookupResult, nil
}
func (stub *handlerStub) GetUser(context.Context, admin.Actor, uuid.UUID) (cloudadmin.User, error) { return maskedUser(), nil }
func (stub *handlerStub) ListDevices(context.Context, admin.Actor, uuid.UUID, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Device], error) {
    return cloudadmin.Page[cloudadmin.Device]{Items:[]cloudadmin.Device{}}, nil
}
func (stub *handlerStub) ListSessions(context.Context, admin.Actor, uuid.UUID, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Session], error) {
    return cloudadmin.Page[cloudadmin.Session]{Items:[]cloudadmin.Session{}}, nil
}
func (stub *handlerStub) RevokeDevice(context.Context, admin.Actor, uuid.UUID, int64, admin.ActionReason, string) (operations.Result, error) {
    return operations.Result{OperationID:uuid.New(), State:operations.StateQueued, UpdatedAt:testNow()}, nil
}
func (stub *handlerStub) RevokeSession(context.Context, admin.Actor, uuid.UUID, int64, admin.ActionReason, string) (operations.Result, error) {
    return operations.Result{OperationID:uuid.New(), State:operations.StateQueued, UpdatedAt:testNow()}, nil
}
func (stub *handlerStub) CreateApproval(_ context.Context, input approval.CreateRequest) (approval.Request, error) {
    return approval.Request{ID:uuid.New(), Action:input.Action, TargetUserID:input.TargetUserID,
        Status:approval.PendingReview, ExecutionStatus:approval.NotStarted, CreatedAt:testNow(), UpdatedAt:testNow(), ExpiresAt:testNow().Add(24*time.Hour), Version:1}, nil
}
func (stub *handlerStub) ListApprovals(context.Context, admin.Actor, approval.ListFilter) (approval.Page, error) {
    return approval.Page{Items:[]approval.Request{}}, nil
}
func (stub *handlerStub) GetApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error) { return approval.Request{ID:uuid.New()}, nil }
func (stub *handlerStub) ApproveApproval(context.Context, admin.Actor, uuid.UUID, string) (approval.Request, error) {
    operationID := uuid.New()
    return approval.Request{ID:uuid.New(), Status:approval.Approved, ExecutionStatus:approval.Queued, OperationID:&operationID}, nil
}
func (stub *handlerStub) RejectApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error) { return approval.Request{ID:uuid.New(), Status:approval.Rejected}, nil }
func (stub *handlerStub) CancelApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error) { return approval.Request{ID:uuid.New(), Status:approval.Cancelled}, nil }
func (stub *handlerStub) GetOperation(context.Context, admin.Actor, uuid.UUID) (operations.Result, error) {
    return operations.Result{OperationID:uuid.New(), State:operations.StateQueued, UpdatedAt:testNow()}, nil
}
func (stub *handlerStub) Health(context.Context, admin.Actor) (HealthDocument, error) {
    return HealthDocument{Admin:"ok", PostgreSQL:"ok", Redis:"ok", Cloud:cloudadmin.Health{Configured:true, Availability:cloudadmin.Available, CheckedAt:testNow()}}, nil
}

func testNow() time.Time { return time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC) }

func testPrincipal(role rbac.Role, recentTOTP bool) auth.Principal {
    now := time.Now().UTC()
    principal := auth.Principal{
        AdminID:uuid.NewString(), SessionID:uuid.NewString(), Role:role, SecurityVersion:1,
        MFAAuthenticatedAt:now, MFAMethod:auth.MFAMethodTOTP,
    }
    if recentTOTP { principal.TOTPAuthenticatedAt = &now }
    return principal
}

func maskedUser() cloudadmin.User {
    return cloudadmin.User{ID:uuid.MustParse("019f0000-0000-7000-8000-000000000043"),
        MaskedEmail:"a***@example.test", Status:cloudadmin.UserActive,
        AdministrativeRevision:1, CreatedAt:testNow()}
}

func validApprovalJSON() string {
    return `{"action":"disable_user","target_user_id":"019f0000-0000-7000-8000-000000000043","reason_code":"policy_violation","ticket_reference":"SEC-42","note":""}`
}
```

- [ ] **Step 2: Run HTTP tests and verify failure**

Run: `go test ./internal/cloudcontrol -count=1 -v`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement the orchestration service**

Create `internal/cloudcontrol/service.go`:

```go
var (
    ErrInvalidRequest = errors.New("Cloud control request is invalid")
    ErrPermissionDenied = errors.New("Cloud control permission is denied")
)

type ServiceConfig struct {
    PostgreSQL *pgxpool.Pool
    Redis *redis.Client
    Cloud cloudadmin.Client
    Operations *operations.Service
    Approvals *approval.Service
    Audit *audit.Service
    Clock func() time.Time
}

type Service struct {
    postgres *pgxpool.Pool
    redis *redis.Client
    cloud cloudadmin.Client
    operations *operations.Service
    approvals *approval.Service
    audit *audit.Service
    clock func() time.Time
}

func NewService(config ServiceConfig) (*Service, error) {
    if config.PostgreSQL == nil || config.Redis == nil || config.Cloud == nil ||
        config.Operations == nil || config.Approvals == nil || config.Audit == nil || config.Clock == nil {
        return nil, errors.New("Cloud control service dependencies are required")
    }
    return &Service{
        postgres:config.PostgreSQL, redis:config.Redis, cloud:config.Cloud,
        operations:config.Operations, approvals:config.Approvals, audit:config.Audit, clock:config.Clock,
    }, nil
}

type HealthDocument struct {
    Admin string `json:"admin"`
    PostgreSQL string `json:"postgres"`
    Redis string `json:"redis"`
    Cloud cloudadmin.Health `json:"cloud"`
}

func (service *Service) LookupUser(ctx context.Context, actor admin.Actor, input cloudadmin.LookupRequest) (cloudadmin.User, error) {
    if !rbac.Allowed(actor.Role, rbac.ExactIdentityLookup) || actor.AdminID == uuid.Nil { return cloudadmin.User{}, ErrPermissionDenied }
    if !validLookup(input) { return cloudadmin.User{}, ErrInvalidRequest }
    user, err := service.cloud.LookupUser(ctx, input)
    eventType := "cloud_identity_lookup_" + string(input.Kind)
    if err != nil {
        mapped := mapCloudError(err)
        if _, auditErr := service.audit.Append(ctx, audit.Record{
            ActorAdminID:&actor.AdminID, ActorRole:actor.Role, EventType:eventType,
            ObjectType:"cloud_user", Outcome:audit.OutcomeFailure, ErrorCode:stableLookupError(mapped),
            RequestID:actor.Meta.RequestID, SourceIPHMAC:actor.Meta.SourceIPHMAC, UserAgent:actor.Meta.UserAgent,
        }); auditErr != nil { return cloudadmin.User{}, auditErr }
        return cloudadmin.User{}, mapped
    }
    if err := user.Validate(); err != nil { return cloudadmin.User{}, cloudadmin.ErrContractViolation }
    if _, err := service.audit.Append(ctx, audit.Record{
        ActorAdminID:&actor.AdminID, ActorRole:actor.Role, EventType:eventType,
        ObjectType:"cloud_user", ObjectID:&user.ID, Outcome:audit.OutcomeSuccess,
        RequestID:actor.Meta.RequestID, SourceIPHMAC:actor.Meta.SourceIPHMAC, UserAgent:actor.Meta.UserAgent,
    }); err != nil { return cloudadmin.User{}, err }
    return user, nil
}

func (service *Service) RevokeSession(ctx context.Context, actor admin.Actor, sessionID uuid.UUID,
    expectedRevision int64, reason admin.ActionReason, idempotencyKey string) (operations.Result, error) {
    return service.operations.EnqueueImmediate(ctx, operations.EnqueueRequest{
        Actor: actor, Action: operations.RevokeSession, TargetID: sessionID,
        ExpectedRevision: expectedRevision, Reason: reason, BrowserIdempotencyKey: idempotencyKey,
    })
}

func (service *Service) Health(ctx context.Context, actor admin.Actor) (HealthDocument, error) {
    if !rbac.Allowed(actor.Role, rbac.ReadServiceHealth) { return HealthDocument{}, ErrPermissionDenied }
    document := HealthDocument{Admin:"ok", PostgreSQL:"ok", Redis:"ok"}
    if err := service.postgres.Ping(ctx); err != nil { document.PostgreSQL = "unavailable" }
    if err := service.redis.Ping(ctx).Err(); err != nil { document.Redis = "unavailable" }
    cloudHealth, err := service.cloud.Health(ctx)
    if err != nil && cloudHealth.Availability == "" {
        cloudHealth = cloudadmin.Health{Configured:true, Availability:cloudadmin.Unavailable, CheckedAt:service.clock().UTC()}
    }
    if cloudHealth.CheckedAt.IsZero() { cloudHealth.CheckedAt = service.clock().UTC() }
    document.Cloud = cloudHealth
    return document, nil
}

func stableLookupError(err error) string {
    switch {
    case errors.Is(err, cloudadmin.ErrNotFound): return "USER_NOT_FOUND"
    case errors.Is(err, cloudadmin.ErrNotConfigured): return "CLOUD_NOT_CONFIGURED"
    case errors.Is(err, cloudadmin.ErrContractViolation): return "CLOUD_CONTRACT_VIOLATION"
    default: return "CLOUD_UNAVAILABLE"
    }
}
```

Add the remaining service methods with these signatures and authorization checks:

```go
func (service *Service) ListUsers(ctx context.Context, actor admin.Actor, input cloudadmin.ListUsersRequest) (cloudadmin.Page[cloudadmin.User], error) {
    if !rbac.Allowed(actor.Role, rbac.ReadCloudUsers) { return cloudadmin.Page[cloudadmin.User]{}, ErrPermissionDenied }
    if input.Limit < 1 || input.Limit > 100 || len(input.Cursor) > 512 { return cloudadmin.Page[cloudadmin.User]{}, ErrInvalidRequest }
    return service.cloud.ListUsers(ctx, input)
}

func (service *Service) GetUser(ctx context.Context, actor admin.Actor, userID uuid.UUID) (cloudadmin.User, error) {
    allowed := rbac.Allowed(actor.Role, rbac.ReadCloudUsers) || rbac.Allowed(actor.Role, rbac.ReadTechnicalUserFields)
    if !allowed { return cloudadmin.User{}, ErrPermissionDenied }
    if userID == uuid.Nil { return cloudadmin.User{}, ErrInvalidRequest }
    return service.cloud.GetUser(ctx, userID)
}

func (service *Service) ListDevices(ctx context.Context, actor admin.Actor, userID uuid.UUID, page cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Device], error) {
    if !rbac.Allowed(actor.Role, rbac.ReadCloudDevices) { return cloudadmin.Page[cloudadmin.Device]{}, ErrPermissionDenied }
    if userID == uuid.Nil { return cloudadmin.Page[cloudadmin.Device]{}, ErrInvalidRequest }
    return service.cloud.ListUserDevices(ctx, userID, page)
}

func (service *Service) ListSessions(ctx context.Context, actor admin.Actor, userID uuid.UUID, page cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Session], error) {
    if !rbac.Allowed(actor.Role, rbac.ReadCloudDevices) { return cloudadmin.Page[cloudadmin.Session]{}, ErrPermissionDenied }
    if userID == uuid.Nil { return cloudadmin.Page[cloudadmin.Session]{}, ErrInvalidRequest }
    return service.cloud.ListUserSessions(ctx, userID, page)
}

func (service *Service) RevokeDevice(ctx context.Context, actor admin.Actor, deviceID uuid.UUID,
    expectedRevision int64, reason admin.ActionReason, idempotencyKey string) (operations.Result, error) {
    return service.operations.EnqueueImmediate(ctx, operations.EnqueueRequest{
        Actor:actor, Action:operations.RevokeDevice, TargetID:deviceID,
        ExpectedRevision:expectedRevision, Reason:reason, BrowserIdempotencyKey:idempotencyKey,
    })
}

func (service *Service) CreateApproval(ctx context.Context, input approval.CreateRequest) (approval.Request, error) {
    return service.approvals.Create(ctx, input)
}
func (service *Service) ListApprovals(ctx context.Context, actor admin.Actor, filter approval.ListFilter) (approval.Page, error) {
    return service.approvals.List(ctx, actor, filter)
}
func (service *Service) GetApproval(ctx context.Context, actor admin.Actor, id uuid.UUID) (approval.Request, error) {
    return service.approvals.Get(ctx, actor, id)
}
func (service *Service) ApproveApproval(ctx context.Context, actor admin.Actor, id uuid.UUID, key string) (approval.Request, error) {
    return service.approvals.Approve(ctx, actor, id, key)
}
func (service *Service) RejectApproval(ctx context.Context, actor admin.Actor, id uuid.UUID) (approval.Request, error) {
    return service.approvals.Reject(ctx, actor, id)
}
func (service *Service) CancelApproval(ctx context.Context, actor admin.Actor, id uuid.UUID) (approval.Request, error) {
    return service.approvals.Cancel(ctx, actor, id)
}
func (service *Service) GetOperation(ctx context.Context, actor admin.Actor, id uuid.UUID) (operations.Result, error) {
    return service.operations.Get(ctx, actor, id)
}
```

Add this exact lookup guard; list methods keep the `1..100`, 512-byte cursor, and non-nil UUID checks shown above:

```go
var exactPhonePattern = regexp.MustCompile(`^\+?[0-9]{7,15}$`)

func validLookup(input cloudadmin.LookupRequest) bool {
    if len(input.Value) < 3 || len(input.Value) > 320 || strings.TrimSpace(input.Value) != input.Value {
        return false
    }
    for _, character := range input.Value {
        if character <= 0x20 || character == 0x7f { return false }
    }
    switch input.Kind {
    case cloudadmin.IdentityEmail:
        return strings.Count(input.Value, "@") == 1
    case cloudadmin.IdentityPhone:
        return exactPhonePattern.MatchString(input.Value)
    default:
        return false
    }
}
```

- [ ] **Step 4: Implement the hardened Chi handler**

Create `internal/cloudcontrol/http.go` and register exactly these routes:

```go
type HandlerService interface {
    ListUsers(context.Context, admin.Actor, cloudadmin.ListUsersRequest) (cloudadmin.Page[cloudadmin.User], error)
    LookupUser(context.Context, admin.Actor, cloudadmin.LookupRequest) (cloudadmin.User, error)
    GetUser(context.Context, admin.Actor, uuid.UUID) (cloudadmin.User, error)
    ListDevices(context.Context, admin.Actor, uuid.UUID, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Device], error)
    ListSessions(context.Context, admin.Actor, uuid.UUID, cloudadmin.PageRequest) (cloudadmin.Page[cloudadmin.Session], error)
    RevokeDevice(context.Context, admin.Actor, uuid.UUID, int64, admin.ActionReason, string) (operations.Result, error)
    RevokeSession(context.Context, admin.Actor, uuid.UUID, int64, admin.ActionReason, string) (operations.Result, error)
    CreateApproval(context.Context, approval.CreateRequest) (approval.Request, error)
    ListApprovals(context.Context, admin.Actor, approval.ListFilter) (approval.Page, error)
    GetApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error)
    ApproveApproval(context.Context, admin.Actor, uuid.UUID, string) (approval.Request, error)
    RejectApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error)
    CancelApproval(context.Context, admin.Actor, uuid.UUID) (approval.Request, error)
    GetOperation(context.Context, admin.Actor, uuid.UUID) (operations.Result, error)
    Health(context.Context, admin.Actor) (HealthDocument, error)
}

func NewHandler(service HandlerService) http.Handler {
    return NewHandlerWithLogger(service, slog.Default())
}

func NewHandlerWithLogger(service HandlerService, logger *slog.Logger) http.Handler {
    if service == nil { panic("Cloud control HandlerService is required") }
    if logger == nil { logger = slog.Default() }
    router := chi.NewRouter()
    router.With(requirePermission(rbac.ReadCloudUsers)).Get("/cloud-users", listUsersHTTP(service, logger))
    router.With(requirePermission(rbac.ExactIdentityLookup)).Post("/cloud-users/lookup", lookupUserHTTP(service, logger))
    router.With(anyPermission(rbac.ReadCloudUsers, rbac.ReadTechnicalUserFields)).Get("/cloud-users/{userID}", getUserHTTP(service))
    router.With(requirePermission(rbac.ReadCloudDevices)).Get("/cloud-users/{userID}/devices", listDevicesHTTP(service))
    router.With(requirePermission(rbac.ReadCloudDevices)).Get("/cloud-users/{userID}/sessions", listSessionsHTTP(service))
    router.With(requirePermission(rbac.RevokeCloudDevice), recentTOTP()).Post("/cloud-devices/{deviceID}/revoke", revokeDeviceHTTP(service))
    router.With(requirePermission(rbac.RevokeCloudSession), recentTOTP()).Post("/cloud-sessions/{sessionID}/revoke", revokeSessionHTTP(service))
    router.With(requirePermission(rbac.InitiateAccountLifecycle), recentTOTP()).Post("/approval-requests", createApprovalHTTP(service))
    router.With(anyPermission(rbac.InitiateAccountLifecycle, rbac.ApproveAccountLifecycle)).Get("/approval-requests", listApprovalsHTTP(service))
    router.With(anyPermission(rbac.InitiateAccountLifecycle, rbac.ApproveAccountLifecycle)).Get("/approval-requests/{approvalID}", getApprovalHTTP(service))
    router.With(requirePermission(rbac.ApproveAccountLifecycle), recentTOTP()).Post("/approval-requests/{approvalID}/approve", approveApprovalHTTP(service))
    router.With(requirePermission(rbac.ApproveAccountLifecycle), recentTOTP()).Post("/approval-requests/{approvalID}/reject", rejectApprovalHTTP(service))
    router.With(requirePermission(rbac.InitiateAccountLifecycle), recentTOTP()).Post("/approval-requests/{approvalID}/cancel", cancelApprovalHTTP(service))
    router.With(anyPermission(rbac.RevokeCloudDevice, rbac.RevokeCloudSession, rbac.ApproveAccountLifecycle)).Get("/operations/{operationID}", getOperationHTTP(service))
    router.With(requirePermission(rbac.ReadServiceHealth)).Get("/system/health", healthHTTP(service))
    return noStore(router)
}

func requirePermission(permission rbac.Permission) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler { return auth.Require(permission, next) }
}

func recentTOTP() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler { return auth.RequireRecentTOTP(time.Now, next) }
}

func anyPermission(permissions ...rbac.Permission) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
            principal, ok := auth.PrincipalFromContext(request.Context())
            if !ok || principal.AdminID == "" || !principal.Role.Valid() {
                writeError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话")
                return
            }
            for _, permission := range permissions {
                if rbac.Allowed(principal.Role, permission) { next.ServeHTTP(response, request); return }
            }
            writeError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
        })
    }
}
```

Mutation payloads use this shared shape:

```go
type mutationPayload struct {
    ExpectedRevision int64 `json:"expected_revision"`
    ReasonCode string `json:"reason_code"`
    TicketReference string `json:"ticket_reference"`
    Note string `json:"note"`
}
```

Implement every referenced handler with these shared decoding and actor boundaries; the only lookup log fields are kind, stable result code, and request ID:

```go
const maximumJSONBody = 64 << 10
const maximumLookupBody = 4 << 10

type reasonPayload struct {
    ReasonCode string `json:"reason_code"`
    TicketReference string `json:"ticket_reference"`
    Note string `json:"note"`
}

func actorFromRequest(request *http.Request) (admin.Actor, bool) {
    principal, ok := auth.PrincipalFromContext(request.Context())
    if !ok || !principal.Role.Valid() { return admin.Actor{}, false }
    id, err := uuid.Parse(principal.AdminID)
    if err != nil || id == uuid.Nil { return admin.Actor{}, false }
    meta := admin.RequestMeta{RequestID:"req-"+uuid.NewString(), UserAgent:request.UserAgent()}
    if authenticatedMeta, present := auth.RequestMetaFromContext(request.Context()); present {
        meta = admin.RequestMeta{RequestID:authenticatedMeta.RequestID,
            SourceIPHMAC:append([]byte(nil), authenticatedMeta.SourceIPHMAC...), UserAgent:authenticatedMeta.UserAgent}
    }
    return admin.Actor{AdminID:id, Role:principal.Role, Meta:meta}, true
}

func decodeJSON(response http.ResponseWriter, request *http.Request, maximum int64, target any) error {
    mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
    if err != nil || mediaType != "application/json" { return ErrInvalidRequest }
    request.Body = http.MaxBytesReader(response, request.Body, maximum)
    decoder := json.NewDecoder(request.Body)
    decoder.DisallowUnknownFields()
    if err := decoder.Decode(target); err != nil { return ErrInvalidRequest }
    var extra any
    if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) { return ErrInvalidRequest }
    return nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
    response.Header().Set("Content-Type", "application/json")
    response.WriteHeader(status)
    _ = json.NewEncoder(response).Encode(value)
}

func requestActor(response http.ResponseWriter, request *http.Request) (admin.Actor, bool) {
    actor, ok := actorFromRequest(request)
    if !ok { writeError(response, http.StatusUnauthorized, "AUTH_REQUIRED", "需要有效的管理员会话") }
    return actor, ok
}

func parseID(response http.ResponseWriter, request *http.Request, name string) (uuid.UUID, bool) {
    id, err := uuid.Parse(chi.URLParam(request, name))
    if err != nil || id == uuid.Nil {
        writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容无效")
        return uuid.Nil, false
    }
    return id, true
}

func pageFromRequest(request *http.Request) (cloudadmin.PageRequest, error) {
    limit := 50
    if raw := request.URL.Query().Get("limit"); raw != "" {
        parsed, err := strconv.Atoi(raw)
        if err != nil { return cloudadmin.PageRequest{}, ErrInvalidRequest }
        limit = parsed
    }
    page := cloudadmin.PageRequest{Cursor:request.URL.Query().Get("cursor"), Limit:limit}
    if page.Limit < 1 || page.Limit > 100 || len(page.Cursor) > 512 { return cloudadmin.PageRequest{}, ErrInvalidRequest }
    return page, nil
}

func listUsersHTTP(service HandlerService, logger *slog.Logger) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        page, err := pageFromRequest(request); if err != nil { writeDomainError(response, err); return }
        input := cloudadmin.ListUsersRequest{PageRequest:page, Status:cloudadmin.UserStatus(request.URL.Query().Get("status"))}
        result, err := service.ListUsers(request.Context(), actor, input)
        logger.Info("Cloud user list", "result", stableHTTPResult(err), "request_id", actor.Meta.RequestID)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func lookupUserHTTP(service HandlerService, logger *slog.Logger) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        var input cloudadmin.LookupRequest
        if err := decodeJSON(response, request, maximumLookupBody, &input); err != nil { writeDomainError(response, err); return }
        result, err := service.LookupUser(request.Context(), actor, input)
        logger.Info("Cloud exact identity lookup", "kind", input.Kind, "result", stableHTTPResult(err), "request_id", actor.Meta.RequestID)
        input.Value = ""
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func getUserHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "userID"); if !ok { return }
        result, err := service.GetUser(request.Context(), actor, id)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func listDevicesHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "userID"); if !ok { return }
        page, err := pageFromRequest(request); if err != nil { writeDomainError(response, err); return }
        result, err := service.ListDevices(request.Context(), actor, id, page)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func listSessionsHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "userID"); if !ok { return }
        page, err := pageFromRequest(request); if err != nil { writeDomainError(response, err); return }
        result, err := service.ListSessions(request.Context(), actor, id, page)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func mutationReason(payload mutationPayload, actor admin.Actor) admin.ActionReason {
    return admin.ActionReason{Code:payload.ReasonCode, TicketReference:payload.TicketReference, Note:payload.Note, Meta:actor.Meta}
}

func revokeDeviceHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "deviceID"); if !ok { return }
        var payload mutationPayload
        if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil { writeDomainError(response, err); return }
        result, err := service.RevokeDevice(request.Context(), actor, id, payload.ExpectedRevision,
            mutationReason(payload, actor), request.Header.Get("Idempotency-Key"))
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusAccepted, result)
    }
}

func revokeSessionHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "sessionID"); if !ok { return }
        var payload mutationPayload
        if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil { writeDomainError(response, err); return }
        result, err := service.RevokeSession(request.Context(), actor, id, payload.ExpectedRevision,
            mutationReason(payload, actor), request.Header.Get("Idempotency-Key"))
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusAccepted, result)
    }
}

func createApprovalHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        var payload struct {
            Action approval.Action `json:"action"`
            TargetUserID uuid.UUID `json:"target_user_id"`
            reasonPayload
        }
        if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil { writeDomainError(response, err); return }
        result, err := service.CreateApproval(request.Context(), approval.CreateRequest{
            Actor:actor, Action:payload.Action, TargetUserID:payload.TargetUserID,
            Reason:admin.ActionReason{Code:payload.ReasonCode, TicketReference:payload.TicketReference, Note:payload.Note, Meta:actor.Meta},
        })
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusCreated, result)
    }
}

func listApprovalsHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        page, err := pageFromRequest(request); if err != nil { writeDomainError(response, err); return }
        result, err := service.ListApprovals(request.Context(), actor, approval.ListFilter{
            View:request.URL.Query().Get("view"), Cursor:page.Cursor, Limit:page.Limit,
        })
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func getApprovalHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "approvalID"); if !ok { return }
        result, err := service.GetApproval(request.Context(), actor, id)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func approveApprovalHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "approvalID"); if !ok { return }
        var payload struct{}
        if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil { writeDomainError(response, err); return }
        result, err := service.ApproveApproval(request.Context(), actor, id, request.Header.Get("Idempotency-Key"))
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusAccepted, result)
    }
}

func rejectApprovalHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "approvalID"); if !ok { return }
        var payload struct{}
        if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil { writeDomainError(response, err); return }
        result, err := service.RejectApproval(request.Context(), actor, id)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func cancelApprovalHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "approvalID"); if !ok { return }
        var payload struct{}
        if err := decodeJSON(response, request, maximumJSONBody, &payload); err != nil { writeDomainError(response, err); return }
        result, err := service.CancelApproval(request.Context(), actor, id)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func getOperationHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        id, ok := parseID(response, request, "operationID"); if !ok { return }
        result, err := service.GetOperation(request.Context(), actor, id)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}

func healthHTTP(service HandlerService) http.HandlerFunc {
    return func(response http.ResponseWriter, request *http.Request) {
        actor, ok := requestActor(response, request); if !ok { return }
        result, err := service.Health(request.Context(), actor)
        if err != nil { writeDomainError(response, err); return }
        writeJSON(response, http.StatusOK, result)
    }
}
```

`lookupUserHTTP` uses a 4 KiB body limit; every other JSON route uses a 64 KiB limit. Decoders require `Content-Type: application/json`, call `DisallowUnknownFields`, and require one JSON object. `Idempotency-Key` is read only for mutation/approval execution and is never logged. All responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

Map domain errors to these stable responses:

```go
var errorResponses = []struct {
    match error
    status int
    code string
    message string
}{
    {ErrInvalidRequest, 400, "INVALID_REQUEST", "请求内容无效"},
    {operations.ErrIdempotencyKeyReused, 409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他操作"},
    {approval.ErrSelfReview, 403, "APPROVAL_SELF_REVIEW_FORBIDDEN", "发起人不能审批自己的申请"},
    {approval.ErrExpired, 409, "APPROVAL_EXPIRED", "审批申请已过期"},
    {approval.ErrStateConflict, 409, "APPROVAL_STATE_CONFLICT", "申请状态已变化，请刷新后重试"},
    {cloudadmin.ErrNotConfigured, 503, "CLOUD_NOT_CONFIGURED", "Cloud 管理服务尚未配置"},
    {cloudadmin.ErrUnavailable, 503, "CLOUD_UNAVAILABLE", "Cloud 管理服务暂时不可用"},
    {cloudadmin.ErrContractViolation, 502, "CLOUD_CONTRACT_VIOLATION", "Cloud 管理服务响应不符合安全契约"},
}
```

Implement the stable writer and no-store wrapper exactly as follows; unmatched errors never serialize `err.Error()`:

```go
func stableHTTPResult(err error) string {
    if err == nil { return "OK" }
    for _, item := range errorResponses { if errors.Is(err, item.match) { return item.code } }
    return "INTERNAL_ERROR"
}

func writeDomainError(response http.ResponseWriter, err error) {
    for _, item := range errorResponses {
        if errors.Is(err, item.match) { writeError(response, item.status, item.code, item.message); return }
    }
    switch {
    case errors.Is(err, ErrPermissionDenied), errors.Is(err, operations.ErrPermissionDenied), errors.Is(err, approval.ErrPermissionDenied):
        writeError(response, http.StatusForbidden, "PERMISSION_DENIED", "没有执行此操作的权限")
    case errors.Is(err, cloudadmin.ErrNotFound), errors.Is(err, approval.ErrNotFound), errors.Is(err, operations.ErrOperationNotFound):
        writeError(response, http.StatusNotFound, "NOT_FOUND", "目标不存在")
    case errors.Is(err, cloudadmin.ErrConflict):
        writeError(response, http.StatusConflict, "STATE_CONFLICT", "目标状态已变化")
    default:
        writeError(response, http.StatusInternalServerError, "INTERNAL_ERROR", "系统暂时无法完成请求")
    }
}

func writeError(response http.ResponseWriter, status int, code, message string) {
    writeJSON(response, status, struct {
        Error struct { Code string `json:"code"`; Message string `json:"message"` } `json:"error"`
    }{Error:struct { Code string `json:"code"`; Message string `json:"message"` }{Code:code, Message:message}})
}

func noStore(next http.Handler) http.Handler {
    return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
        response.Header().Set("Cache-Control", "no-store")
        response.Header().Set("X-Content-Type-Options", "nosniff")
        next.ServeHTTP(response, request)
    })
}
```

- [ ] **Step 5: Extend audit state whitelist for operation transitions**

Add `operation_status` to `allowedStateKeys` in `internal/audit/model.go`, then add a test that accepts `queued -> reconciling` and still rejects keys named `email`, `phone`, or `token`.

```go
func TestPrepareRecordAllowsSafeOperationStateOnly(t *testing.T) {
    record := validRecord("cloud_operation_reconciling", "req-operation-state")
    record.BeforeState = map[string]string{"operation_status":"queued"}
    record.AfterState = map[string]string{"operation_status":"reconciling"}
    if _, err := prepareRecord(record); err != nil { t.Fatalf("prepareRecord() error = %v", err) }
    record.AfterState = map[string]string{"email":"a***@example.test"}
    if _, err := prepareRecord(record); !errors.Is(err, ErrInvalidRecord) { t.Fatalf("unsafe state error = %v", err) }
}
```

- [ ] **Step 6: Compose services and supervise the Worker**

Replace `buildAdminAPI` with this composition result in `cmd/aera-admin/main.go`:

```go
type adminRuntime struct {
    API http.Handler
    Worker *operations.Worker
}

func buildAdminRuntime(settings config.Config, postgres *pgxpool.Pool, redisClient *redis.Client) (adminRuntime, error) {
    passwords, err := secure.DefaultPasswordHasher()
    if err != nil { return adminRuntime{}, err }
    identities, err := secure.NewIdentityCodec(secure.IdentityCodecConfig{
        ActiveEncryptionKeyID: settings.IdentityEncryptionKeys.ActiveKeyID,
        EncryptionKeys: settings.IdentityEncryptionKeys.Keys,
        ActiveLookupKeyID: settings.IdentityLookupKeys.ActiveKeyID,
        LookupKeys: settings.IdentityLookupKeys.Keys,
    })
    if err != nil { return adminRuntime{}, err }
    totpSecrets, err := secure.NewSecretCodec(secure.SecretCodecConfig{
        ActiveKeyID: settings.TOTPEncryptionKeys.ActiveKeyID,
        Keys: settings.TOTPEncryptionKeys.Keys,
    })
    if err != nil { return adminRuntime{}, err }
    auditService, err := adminaudit.NewService(postgres)
    if err != nil { return adminRuntime{}, err }
    adminService, err := admin.NewService(admin.ServiceConfig{
        PostgreSQL: postgres, Passwords: passwords, Identities: identities,
        TOTPSecrets: totpSecrets, TOTP: secure.DefaultTOTP(), Audit: auditService,
        PublicURL: settings.PublicURL,
    })
    if err != nil { return adminRuntime{}, err }
    authService, err := adminauth.NewService(adminauth.ServiceConfig{
        PostgreSQL: postgres, Redis: redisClient, RedisPrefix: "aera-admin:"+settings.Environment+":",
        Passwords: passwords, Identities: identities, TOTPSecrets: totpSecrets,
        TOTP: secure.DefaultTOTP(), Audit: auditService,
        SessionHMACKey: settings.SessionHMACKey, CSRFHMACKey: settings.CSRFHMACKey,
    })
    if err != nil { return adminRuntime{}, err }
    authHandler := adminauth.NewHandler(authService)
    administratorHandler := admin.NewHandlerWithActivationLimiter(adminService, authService)
    cloudClient, err := cloudadmin.NewHTTPClient(settings.CloudAdmin, time.Now)
    if err != nil { return adminRuntime{}, err }
    operationService, err := operations.NewService(operations.ServiceConfig{
        PostgreSQL: postgres, HMACKey: settings.OperationHMACKey, Cloud: cloudClient,
        Audit: auditService, Clock: time.Now,
    })
    if err != nil { return adminRuntime{}, err }
    approvalService, err := approval.NewService(approval.ServiceConfig{
        PostgreSQL: postgres, Cloud: cloudClient, Operations: operationService,
        Audit: auditService, Clock: time.Now,
    })
    if err != nil { return adminRuntime{}, err }
    worker, err := operations.NewWorker(operations.WorkerConfig{
        Operations: operationService, Cloud: cloudClient, ExecutionSink: approvalService,
        Clock: time.Now, PollInterval: time.Second, BatchSize: 8, Lease: 30*time.Second,
    })
    if err != nil { return adminRuntime{}, err }
    cloudService, err := cloudcontrol.NewService(cloudcontrol.ServiceConfig{
        PostgreSQL: postgres, Redis: redisClient, Cloud: cloudClient,
        Operations: operationService, Approvals: approvalService, Audit: auditService, Clock: time.Now,
    })
    if err != nil { return adminRuntime{}, err }
    browserSecurity, err := adminauth.NewBrowserSecurity(adminauth.BrowserSecurityConfig{
        Service: authService, PublicURL: settings.PublicURL,
        SourceIPHMACKey: settings.SessionHMACKey, TrustedProxyCIDRs: settings.TrustedProxyCIDRs,
    })
    if err != nil { return adminRuntime{}, err }
    router := http.NewServeMux()
    for _, path := range []string{"/auth/login", "/auth/totp/verify", "/auth/step-up", "/auth/logout", "/me"} {
        router.Handle(path, authHandler)
    }
    for _, path := range []string{"/auth/activation/prepare", "/auth/activate", "/admin-users", "/admin-users/"} {
        router.Handle(path, administratorHandler)
    }
    cloudHandler := cloudcontrol.NewHandler(cloudService)
    for _, path := range []string{"/cloud-users", "/cloud-users/", "/cloud-devices/", "/cloud-sessions/", "/approval-requests", "/approval-requests/", "/operations/", "/system/health"} {
        router.Handle(path, cloudHandler)
    }
    return adminRuntime{API: browserSecurity.Wrap(router), Worker: worker}, nil
}
```

In `run`, replace the current API construction and select block with:

```go
runtime, err := buildAdminRuntime(settings, postgres, redisStore.Client())
if err != nil { return err }
handler := httpapi.New(httpapi.Dependencies{
    PostgreSQL:postgres, Redis:redisStore, API:runtime.API,
    Web:webui.EmbeddedHandler(), Production:settings.Environment == "production",
})
server := newHTTPServer(settings.ListenAddr, handler)
serveResult := make(chan error, 1)
workerResult := make(chan error, 1)
go func() { serveResult <- server.ListenAndServe() }()
go func() { workerResult <- runtime.Worker.Run(ctx) }()
shutdown := func() error {
    shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
    defer cancel()
    return server.Shutdown(shutdownCtx)
}
select {
case err := <-serveResult:
    if errors.Is(err, http.ErrServerClosed) { return nil }
    return fmt.Errorf("serve Aera Admin: %w", err)
case err := <-workerResult:
    if err == nil && ctx.Err() != nil { _ = shutdown(); return nil }
    _ = shutdown()
    return fmt.Errorf("run Admin Outbox Worker: %w", err)
case <-ctx.Done():
    if err := shutdown(); err != nil { return errors.New("shut down Aera Admin") }
    return nil
}
```

- [ ] **Step 7: Run API, composition, and existing security tests**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' AERA_ADMIN_TEST_REDIS_ADDR='127.0.0.1:56382' go test ./internal/cloudcontrol ./cmd/aera-admin ./internal/audit ./internal/auth ./internal/admin -count=1 -v
```

Expected: PASS; existing auth routes retain behavior, fixed-role requests are enforced server-side, and exact lookup canaries do not appear in response or logs.

- [ ] **Step 8: Commit the Browser API and runtime wiring**

```bash
git add internal/cloudcontrol internal/audit cmd/aera-admin
git commit -m "feat: expose secured cloud control API"
```

### Task 9: Browser OpenAPI Contract and Security Assertions

**Files:**
- Modify: `api/openapi/admin.yaml`
- Modify: `api/openapi_test.go`

**Interfaces:**
- Consumes: exact Handler paths and DTO JSON names from Task 8.
- Produces: Browser API version `0.2.0` with Cloud, Approval, Operation, and System tags.
- Guarantees: exact identity input exists only in the POST lookup request body.

- [ ] **Step 1: Write failing path and identity-placement assertions**

Add to `api/openapi_test.go`:

```go
func readContract(t *testing.T, name string) string {
    t.Helper()
    encoded, err := os.ReadFile(name)
    if err != nil { t.Fatalf("read %s: %v", name, err) }
    return string(encoded)
}

func TestCloudBrowserContractHasEverySecuredOperation(t *testing.T) {
    raw := readContract(t, "openapi/admin.yaml")
    for _, operationID := range []string{
        "listCloudUsers", "lookupCloudUser", "getCloudUser", "listCloudUserDevices",
        "listCloudUserSessions", "revokeCloudDevice", "revokeCloudSession",
        "createApprovalRequest", "listApprovalRequests", "getApprovalRequest",
        "approveApprovalRequest", "rejectApprovalRequest", "cancelApprovalRequest",
        "getAdminOperation", "getAdminSystemHealth",
    } {
        if !strings.Contains(raw, "operationId: "+operationID) {
            t.Errorf("missing operation %s", operationID)
        }
    }
    var document map[string]any
    if err := yaml.Unmarshal([]byte(raw), &document); err != nil { t.Fatal(err) }
    paths := object(t, document["paths"], "paths")
    for _, path := range []string{
        "/cloud-users/lookup", "/cloud-devices/{deviceID}/revoke", "/cloud-sessions/{sessionID}/revoke",
        "/approval-requests", "/approval-requests/{approvalID}/approve",
        "/approval-requests/{approvalID}/reject", "/approval-requests/{approvalID}/cancel",
    } {
        operation := object(t, object(t, paths[path], path)["post"], path+" post")
        assertSessionAndCSRF(t, operation, path)
    }
}

func TestExactIdentityExistsOnlyInLookupRequestBody(t *testing.T) {
    var document map[string]any
    raw := readContract(t, "openapi/admin.yaml")
    if err := yaml.Unmarshal([]byte(raw), &document); err != nil { t.Fatal(err) }
    paths := document["paths"].(map[string]any)
    for path, value := range paths {
        if strings.Contains(strings.ToLower(path), "email") || strings.Contains(strings.ToLower(path), "phone") {
            t.Errorf("identity field appears in path %s", path)
        }
        pathItem := value.(map[string]any)
        for method, operationValue := range pathItem {
            operation, ok := operationValue.(map[string]any)
            if !ok { continue }
            parameters, _ := operation["parameters"].([]any)
            for _, parameterValue := range parameters {
                parameter, ok := parameterValue.(map[string]any)
                if !ok { continue }
                name, _ := parameter["name"].(string)
                if strings.EqualFold(name, "email") || strings.EqualFold(name, "phone") || strings.EqualFold(name, "value") {
                    t.Errorf("identity parameter %s appears on %s %s", name, method, path)
                }
            }
        }
    }
    if !strings.Contains(raw, "/cloud-users/lookup:") || !strings.Contains(raw, "$ref: '#/components/schemas/IdentityLookupRequest'") {
        t.Fatal("POST lookup request body is missing")
    }
}
```

In the existing `TestOpenAPIContract`, change the path-count guard from 13 to the exact combined total of 27 paths:

```go
if len(paths) != 27 {
    t.Fatalf("OpenAPI path count = %d, want 27", len(paths))
}
```

- [ ] **Step 2: Run OpenAPI tests and verify failure**

Run: `go test ./api -run 'Test(CloudBrowser|ExactIdentity)' -count=1 -v`

Expected: FAIL because the Cloud Browser operations are absent.

- [ ] **Step 3: Add the exact Browser paths and reusable schemas**

Update the API description to state that the contract now covers Admin-side Cloud consumption while the real Cloud server remains external. Add tags `CloudUsers`, `CloudDevices`, `Approvals`, `Operations`, and `System`.

Add the following path shapes to `api/openapi/admin.yaml`; every mutation declares both `adminSession` and `csrfToken`, Step-up in its description, and a required `Idempotency-Key` header where shown:

```yaml
  /cloud-users:
    get:
      tags: [CloudUsers]
      operationId: listCloudUsers
      security: [{ adminSession: [] }]
      parameters:
        - { $ref: '#/components/parameters/Cursor' }
        - { $ref: '#/components/parameters/Limit' }
        - { $ref: '#/components/parameters/UserStatus' }
      responses:
        '200': { $ref: '#/components/responses/CloudUserPage' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '503': { $ref: '#/components/responses/CloudUnavailable' }
  /cloud-users/lookup:
    post:
      tags: [CloudUsers]
      operationId: lookupCloudUser
      security: [{ adminSession: [], csrfToken: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/IdentityLookupRequest' }
      responses:
        '200': { $ref: '#/components/responses/CloudUser' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '404': { $ref: '#/components/responses/NotFound' }
        '503': { $ref: '#/components/responses/CloudUnavailable' }
  /cloud-users/{userID}:
    get:
      tags: [CloudUsers]
      operationId: getCloudUser
      security: [{ adminSession: [] }]
      parameters: [{ $ref: '#/components/parameters/UserID' }]
      responses: { '200': { $ref: '#/components/responses/CloudUser' } }
  /cloud-users/{userID}/devices:
    get:
      tags: [CloudDevices]
      operationId: listCloudUserDevices
      security: [{ adminSession: [] }]
      parameters:
        - { $ref: '#/components/parameters/UserID' }
        - { $ref: '#/components/parameters/Cursor' }
        - { $ref: '#/components/parameters/Limit' }
      responses: { '200': { $ref: '#/components/responses/CloudDevicePage' } }
  /cloud-users/{userID}/sessions:
    get:
      tags: [CloudDevices]
      operationId: listCloudUserSessions
      security: [{ adminSession: [] }]
      parameters:
        - { $ref: '#/components/parameters/UserID' }
        - { $ref: '#/components/parameters/Cursor' }
        - { $ref: '#/components/parameters/Limit' }
      responses: { '200': { $ref: '#/components/responses/CloudSessionPage' } }
  /cloud-devices/{deviceID}/revoke:
    post:
      tags: [CloudDevices]
      operationId: revokeCloudDevice
      description: Requires a TOTP Step-up completed within the last 10 minutes.
      security: [{ adminSession: [], csrfToken: [] }]
      parameters:
        - { $ref: '#/components/parameters/DeviceID' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
      requestBody: { $ref: '#/components/requestBodies/CloudMutation' }
      responses: { '202': { $ref: '#/components/responses/AdminOperation' } }
  /cloud-sessions/{sessionID}/revoke:
    post:
      tags: [CloudDevices]
      operationId: revokeCloudSession
      description: Requires a TOTP Step-up completed within the last 10 minutes.
      security: [{ adminSession: [], csrfToken: [] }]
      parameters:
        - { $ref: '#/components/parameters/SessionID' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
      requestBody: { $ref: '#/components/requestBodies/CloudMutation' }
      responses: { '202': { $ref: '#/components/responses/AdminOperation' } }
  /approval-requests:
    get:
      tags: [Approvals]
      operationId: listApprovalRequests
      security: [{ adminSession: [] }]
      parameters:
        - { $ref: '#/components/parameters/ApprovalView' }
        - { $ref: '#/components/parameters/Cursor' }
        - { $ref: '#/components/parameters/Limit' }
      responses: { '200': { $ref: '#/components/responses/ApprovalPage' } }
    post:
      tags: [Approvals]
      operationId: createApprovalRequest
      description: Requires a TOTP Step-up completed within the last 10 minutes.
      security: [{ adminSession: [], csrfToken: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateApprovalRequest' }
      responses: { '201': { $ref: '#/components/responses/ApprovalRequest' } }
  /approval-requests/{approvalID}:
    get:
      tags: [Approvals]
      operationId: getApprovalRequest
      security: [{ adminSession: [] }]
      parameters: [{ $ref: '#/components/parameters/ApprovalID' }]
      responses: { '200': { $ref: '#/components/responses/ApprovalRequest' } }
  /approval-requests/{approvalID}/approve:
    post:
      tags: [Approvals]
      operationId: approveApprovalRequest
      description: Requires a TOTP Step-up completed within the last 10 minutes.
      security: [{ adminSession: [], csrfToken: [] }]
      parameters:
        - { $ref: '#/components/parameters/ApprovalID' }
        - { $ref: '#/components/parameters/IdempotencyKey' }
      responses: { '202': { $ref: '#/components/responses/ApprovalRequest' } }
  /approval-requests/{approvalID}/reject:
    post:
      tags: [Approvals]
      operationId: rejectApprovalRequest
      description: Requires a TOTP Step-up completed within the last 10 minutes.
      security: [{ adminSession: [], csrfToken: [] }]
      parameters: [{ $ref: '#/components/parameters/ApprovalID' }]
      responses: { '200': { $ref: '#/components/responses/ApprovalRequest' } }
  /approval-requests/{approvalID}/cancel:
    post:
      tags: [Approvals]
      operationId: cancelApprovalRequest
      description: Requires a TOTP Step-up completed within the last 10 minutes.
      security: [{ adminSession: [], csrfToken: [] }]
      parameters: [{ $ref: '#/components/parameters/ApprovalID' }]
      responses: { '200': { $ref: '#/components/responses/ApprovalRequest' } }
  /operations/{operationID}:
    get:
      tags: [Operations]
      operationId: getAdminOperation
      security: [{ adminSession: [] }]
      parameters: [{ $ref: '#/components/parameters/OperationID' }]
      responses: { '200': { $ref: '#/components/responses/AdminOperation' } }
  /system/health:
    get:
      tags: [System]
      operationId: getAdminSystemHealth
      security: [{ adminSession: [] }]
      responses: { '200': { $ref: '#/components/responses/SystemHealth' } }
```

Set `info.version: 0.2.0`, preserve the three existing tags, and append `CloudUsers`, `CloudDevices`, `Approvals`, `Operations`, and `System`. Merge these exact reusable components into the existing `components` object (do not replace existing authentication/administrator components):

```yaml
  parameters:
    Cursor: { name: cursor, in: query, schema: { type: string, maxLength: 512 } }
    Limit: { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
    UserStatus: { name: status, in: query, schema: { $ref: '#/components/schemas/CloudUserStatus' } }
    UserID: { name: userID, in: path, required: true, schema: { type: string, format: uuid } }
    DeviceID: { name: deviceID, in: path, required: true, schema: { type: string, format: uuid } }
    SessionID: { name: sessionID, in: path, required: true, schema: { type: string, format: uuid } }
    ApprovalID: { name: approvalID, in: path, required: true, schema: { type: string, format: uuid } }
    OperationID: { name: operationID, in: path, required: true, schema: { type: string, format: uuid } }
    ApprovalView: { name: view, in: query, required: true, schema: { type: string, enum: [pending_for_me, mine, all] } }
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      schema: { type: string, minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' }
  requestBodies:
    CloudMutation:
      required: true
      content:
        application/json:
          schema: { $ref: '#/components/schemas/CloudMutationRequest' }
  schemas:
    IdentityLookupRequest:
      type: object
      additionalProperties: false
      required: [type, value]
      properties:
        type: { type: string, enum: [email, phone] }
        value: { type: string, minLength: 3, maxLength: 320, writeOnly: true }
    CloudUserStatus: { type: string, enum: [active, pending_deletion, disabled] }
    CloudUser:
      type: object
      additionalProperties: false
      required: [user_id, status, administratively_disabled, administrative_revision, device_count, active_device_count, active_session_count, created_at]
      properties:
        user_id: { type: string, format: uuid }
        masked_email: { type: string, pattern: '^[^@* ]\*{3}@[A-Za-z0-9.-]+$' }
        masked_phone: { type: string, pattern: '^[0-9]{3}\*{4}[0-9]{4}$' }
        status: { $ref: '#/components/schemas/CloudUserStatus' }
        administratively_disabled: { type: boolean }
        deletion_finalized_at: { type: string, format: date-time }
        administrative_revision: { type: integer, format: int64, minimum: 1 }
        device_count: { type: integer, minimum: 0 }
        active_device_count: { type: integer, minimum: 0 }
        active_session_count: { type: integer, minimum: 0 }
        created_at: { type: string, format: date-time }
        last_cloud_activity_at: { type: string, format: date-time }
    CloudDevice:
      type: object
      additionalProperties: false
      required: [device_id, user_id, display_name, platform, client_version, status]
      properties:
        device_id: { type: string, format: uuid }
        user_id: { type: string, format: uuid }
        display_name: { type: string, minLength: 1, maxLength: 100 }
        platform: { type: string, minLength: 1, maxLength: 32 }
        client_version: { type: string, minLength: 1, maxLength: 64 }
        status: { type: string, enum: [active, inactive, revoked] }
        last_seen_at: { type: string, format: date-time }
    CloudSession:
      type: object
      additionalProperties: false
      required: [session_id, user_id, device_id, status, issued_at, expires_at]
      properties:
        session_id: { type: string, format: uuid }
        user_id: { type: string, format: uuid }
        device_id: { type: string, format: uuid }
        status: { type: string, enum: [active, rotated, expired, revoked, replay_detected] }
        issued_at: { type: string, format: date-time }
        expires_at: { type: string, format: date-time }
        revoked_at: { type: string, format: date-time }
    CloudUserPage:
      type: object
      additionalProperties: false
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/CloudUser' } }
        next_cursor: { type: string, maxLength: 512 }
    CloudDevicePage:
      type: object
      additionalProperties: false
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/CloudDevice' } }
        next_cursor: { type: string, maxLength: 512 }
    CloudSessionPage:
      type: object
      additionalProperties: false
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/CloudSession' } }
        next_cursor: { type: string, maxLength: 512 }
    CloudMutationRequest:
      type: object
      additionalProperties: false
      required: [expected_revision, reason_code]
      properties:
        expected_revision: { type: integer, format: int64, minimum: 1 }
        reason_code: { type: string, pattern: '^[a-z][a-z0-9_]{2,63}$' }
        ticket_reference: { type: string, maxLength: 128 }
        note: { type: string, maxLength: 500 }
    CreateApprovalRequest:
      type: object
      additionalProperties: false
      required: [action, target_user_id, reason_code]
      properties:
        action: { type: string, enum: [disable_user, enable_user] }
        target_user_id: { type: string, format: uuid }
        reason_code: { type: string, pattern: '^[a-z][a-z0-9_]{2,63}$' }
        ticket_reference: { type: string, maxLength: 128 }
        note: { type: string, maxLength: 500 }
    OperationState: { type: string, enum: [queued, executing, reconciling, succeeded, failed, conflict] }
    AdminOperation:
      type: object
      additionalProperties: false
      required: [operation_id, state, updated_at]
      properties:
        operation_id: { type: string, format: uuid }
        state: { $ref: '#/components/schemas/OperationState' }
        error_code: { type: string, pattern: '^[A-Z][A-Z0-9_]{2,99}$' }
        updated_at: { type: string, format: date-time }
    ApprovalEvent:
      type: object
      additionalProperties: false
      required: [id, event_type, before_status, after_status, actor_admin_id, actor_role, request_id, created_at]
      properties:
        id: { type: string, format: uuid }
        event_type: { type: string }
        before_status: { type: string }
        after_status: { type: string }
        result_code: { type: string, pattern: '^[A-Z][A-Z0-9_]{2,99}$' }
        actor_admin_id: { type: string, format: uuid }
        actor_role: { $ref: '#/components/schemas/AdminRole' }
        request_id: { type: string, maxLength: 128 }
        created_at: { type: string, format: date-time }
    ApprovalRequest:
      type: object
      additionalProperties: false
      required: [id, action, target_user_id, target_snapshot, requested_by_admin_id, requested_by_role, reason_code, expected_revision, approval_status, execution_status, expires_at, created_at, updated_at, version]
      properties:
        id: { type: string, format: uuid }
        action: { type: string, enum: [disable_user, enable_user] }
        target_user_id: { type: string, format: uuid }
        target_snapshot: { $ref: '#/components/schemas/CloudUser' }
        requested_by_admin_id: { type: string, format: uuid }
        requested_by_role: { type: string, const: operator }
        reviewed_by_admin_id: { type: string, format: uuid }
        reason_code: { type: string }
        ticket_reference: { type: string }
        note: { type: string }
        expected_revision: { type: integer, format: int64, minimum: 1 }
        approval_status: { type: string, enum: [pending_review, approved, rejected, expired, cancelled] }
        execution_status: { type: string, enum: [not_started, queued, executing, reconciling, succeeded, failed, conflict] }
        operation_id: { type: string, format: uuid }
        expires_at: { type: string, format: date-time }
        created_at: { type: string, format: date-time }
        updated_at: { type: string, format: date-time }
        version: { type: integer, format: int64, minimum: 1 }
        events: { type: array, items: { $ref: '#/components/schemas/ApprovalEvent' } }
    ApprovalPage:
      type: object
      additionalProperties: false
      required: [items]
      properties:
        items: { type: array, items: { $ref: '#/components/schemas/ApprovalRequest' } }
        next_cursor: { type: string, maxLength: 512 }
    SystemHealth:
      type: object
      additionalProperties: false
      required: [admin, postgres, redis, cloud]
      properties:
        admin: { type: string, const: ok }
        postgres: { type: string, enum: [ok, unavailable] }
        redis: { type: string, enum: [ok, unavailable] }
        cloud: { $ref: '#/components/schemas/CloudHealth' }
    CloudHealth:
      type: object
      additionalProperties: false
      required: [configured, availability, mtls, service_jwt, upstream, checked_at]
      properties:
        configured: { type: boolean }
        availability: { type: string, enum: [not_configured, available, unavailable, contract_error] }
        mtls: { type: string, enum: [not_checked, ok, unavailable, contract_error] }
        service_jwt: { type: string, enum: [not_checked, ok, unavailable, contract_error] }
        upstream: { type: string, enum: [not_checked, ok, unavailable, contract_error] }
        checked_at: { type: string, format: date-time }
    CloudControlErrorDocument:
      type: object
      additionalProperties: false
      required: [error]
      properties:
        error:
          type: object
          additionalProperties: false
          required: [code, message]
          properties:
            code: { type: string, enum: [CLOUD_NOT_CONFIGURED, CLOUD_UNAVAILABLE, CLOUD_CONTRACT_VIOLATION, IDEMPOTENCY_KEY_REUSED, APPROVAL_EXPIRED, APPROVAL_SELF_REVIEW_FORBIDDEN, APPROVAL_STATE_CONFLICT, OPERATION_RECONCILING] }
            message: { type: string }
  responses:
    CloudUserPage: { description: Masked Cloud users, content: { application/json: { schema: { $ref: '#/components/schemas/CloudUserPage' } } } }
    CloudUser: { description: One masked Cloud user, content: { application/json: { schema: { $ref: '#/components/schemas/CloudUser' } } } }
    CloudDevicePage: { description: Cloud devices, content: { application/json: { schema: { $ref: '#/components/schemas/CloudDevicePage' } } } }
    CloudSessionPage: { description: Cloud sessions, content: { application/json: { schema: { $ref: '#/components/schemas/CloudSessionPage' } } } }
    AdminOperation: { description: Accepted or current operation state, content: { application/json: { schema: { $ref: '#/components/schemas/AdminOperation' } } } }
    ApprovalRequest: { description: Approval request, content: { application/json: { schema: { $ref: '#/components/schemas/ApprovalRequest' } } } }
    ApprovalPage: { description: Approval request page, content: { application/json: { schema: { $ref: '#/components/schemas/ApprovalPage' } } } }
    SystemHealth: { description: Safe dependency health, content: { application/json: { schema: { $ref: '#/components/schemas/SystemHealth' } } } }
    CloudUnavailable: { description: Cloud dependency is not safely available, content: { application/json: { schema: { $ref: '#/components/schemas/CloudControlErrorDocument' } } } }
    NotFound: { description: Target not found, content: { application/json: { schema: { $ref: '#/components/schemas/ErrorDocument' } } } }
```

For each new operation, declare the applicable `400`, `401`, `403`, `404`, `409`, `502`, `503`, or `500` responses with existing generic responses or `CloudUnavailable`; do not add response bodies containing upstream details. Also remove the duplicate `role` key already present under `/admin-users/{adminID}/role` while touching the YAML.

- [ ] **Step 4: Run the complete OpenAPI suite**

Run: `go test ./api -run '^TestOpenAPIContract|TestCloudBrowserContract|TestExactIdentity' -count=1 -v`

Expected: PASS with every Handler operation represented and no identity query parameter.

- [ ] **Step 5: Commit the Browser contract**

```bash
git add api/openapi/admin.yaml api/openapi_test.go
git commit -m "docs: publish cloud control browser contract"
```

### Task 10: Shared React Contracts, Idempotency, and Boundary Components

**Files:**
- Modify: `web/src/api/contracts.ts`
- Modify: `web/src/api/client.ts`
- Create: `web/src/api/client.test.ts`
- Create: `web/src/components/CloudBoundary.tsx`
- Create: `web/src/components/CloudBoundary.test.tsx`
- Create: `web/src/components/OperationStatus.tsx`
- Create: `web/src/components/ReasonForm.tsx`
- Create: `web/src/components/ReasonForm.test.tsx`
- Modify: `web/src/styles/global.css`

**Interfaces:**
- Produces: exact TypeScript mirrors of Browser OpenAPI response DTOs.
- Produces: `postIdempotentJSON<T>(path, body, idempotencyKey)` without persisting the key.
- Produces: reusable unavailable/contract, reason, and operation-state UI.

- [ ] **Step 1: Write failing API idempotency and no-storage tests**

Create `web/src/api/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postIdempotentJSON } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('postIdempotentJSON', () => {
  it('sends the caller key once without browser persistence', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ operation_id: '019f0000-0000-7000-8000-000000000051', state: 'queued', updated_at: '2026-07-22T08:00:00Z' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const key = '019f0000-0000-7000-8000-000000000052';
    await postIdempotentJSON('/cloud-sessions/019f0000-0000-7000-8000-000000000053/revoke', { expected_revision: 3 }, key);
    const headers = new Headers(fetch.mock.calls[0][1]?.headers);
    expect(headers.get('Idempotency-Key')).toBe(key);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('rejects a malformed key before fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(postIdempotentJSON('/probe', {}, 'short')).rejects.toThrow('Invalid idempotency key');
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the client test and verify failure**

Run: `pnpm --filter @aera/admin-web test --run src/api/client.test.ts`

Expected: FAIL because `postIdempotentJSON` is absent.

- [ ] **Step 3: Add exact Cloud and workflow TypeScript types**

Append to `web/src/api/contracts.ts`:

```ts
export type CloudAvailability = 'not_configured' | 'available' | 'unavailable' | 'contract_error';
export type CloudUserStatus = 'active' | 'pending_deletion' | 'disabled';
export type CloudDeviceStatus = 'active' | 'inactive' | 'revoked';
export type CloudSessionStatus = 'active' | 'rotated' | 'expired' | 'revoked' | 'replay_detected';
export type OperationState = 'queued' | 'executing' | 'reconciling' | 'succeeded' | 'failed' | 'conflict';
export type ApprovalStatus = 'pending_review' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ApprovalExecutionStatus = 'not_started' | OperationState;

export interface CloudUser {
  user_id: string;
  masked_email?: string;
  masked_phone?: string;
  status: CloudUserStatus;
  administratively_disabled: boolean;
  deletion_finalized_at?: string;
  administrative_revision: number;
  device_count: number;
  active_device_count: number;
  active_session_count: number;
  created_at: string;
  last_cloud_activity_at?: string;
}

export interface CloudDevice {
  device_id: string;
  user_id: string;
  display_name: string;
  platform: string;
  client_version: string;
  status: CloudDeviceStatus;
  last_seen_at?: string;
}

export interface CloudSession {
  session_id: string;
  user_id: string;
  device_id: string;
  status: CloudSessionStatus;
  issued_at: string;
  expires_at: string;
  revoked_at?: string;
}

export interface Page<T> { items: T[]; next_cursor?: string }

export interface AdminOperation {
  operation_id: string;
  state: OperationState;
  error_code?: string;
  updated_at: string;
}

export interface ApprovalEvent {
  id: string;
  event_type: string;
  before_status: string;
  after_status: string;
  result_code?: string;
  actor_admin_id: string;
  actor_role: AdminRole;
  request_id: string;
  created_at: string;
}

export interface ApprovalRequest {
  id: string;
  action: 'disable_user' | 'enable_user';
  target_user_id: string;
  target_snapshot: CloudUser;
  requested_by_admin_id: string;
  requested_by_role: 'operator';
  reviewed_by_admin_id?: string;
  reason_code: string;
  ticket_reference?: string;
  note?: string;
  expected_revision: number;
  approval_status: ApprovalStatus;
  execution_status: ApprovalExecutionStatus;
  operation_id?: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  version: number;
  events?: ApprovalEvent[];
}

export interface SystemHealth {
  admin: 'ok';
  postgres: 'ok' | 'unavailable';
  redis: 'ok' | 'unavailable';
  cloud: {
    configured: boolean;
    availability: CloudAvailability;
    mtls: 'not_checked' | 'ok' | 'unavailable' | 'contract_error';
    service_jwt: 'not_checked' | 'ok' | 'unavailable' | 'contract_error';
    upstream: 'not_checked' | 'ok' | 'unavailable' | 'contract_error';
    checked_at: string;
  };
}

export interface ReasonInput {
  reason_code: string;
  ticket_reference: string;
  note: string;
}
```

- [ ] **Step 4: Implement the idempotent request helper**

Add to `web/src/api/client.ts`:

```ts
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function postIdempotentJSON<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
  if (!idempotencyKeyPattern.test(idempotencyKey)) throw new Error('Invalid idempotency key');
  return request<T>(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
}
```

The key remains component state only until the request resolves; no helper writes LocalStorage, SessionStorage, IndexedDB, URL parameters, or Query keys.

- [ ] **Step 5: Write and implement shared boundary components**

Create `CloudBoundary.tsx`:

```tsx
import { Alert, Button, Empty } from 'antd';
import { APIError } from '../api/client';

export function CloudBoundary({ error, empty, onRetry, children }: {
  error: unknown; empty: boolean; onRetry: () => void; children: React.ReactNode;
}) {
  if (error instanceof APIError) {
    const contract = error.code === 'CLOUD_CONTRACT_VIOLATION';
    const notConfigured = error.code === 'CLOUD_NOT_CONFIGURED';
    return <Alert
      showIcon
      type={contract ? 'error' : 'warning'}
      message={contract ? 'Cloud 安全契约异常' : notConfigured ? 'Cloud 管理服务尚未配置' : 'Cloud 管理服务暂时不可用'}
      description="系统未生成演示数据，也不会把失败显示为成功。"
      action={<Button onClick={onRetry}>重新检查</Button>}
    />;
  }
  if (error) return <Alert showIcon type="error" message="请求未能完成" />;
  if (empty) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的数据" />;
  return <>{children}</>;
}
```

Create `OperationStatus.tsx`:

```tsx
import { Badge, Tag } from 'antd';
import type { OperationState } from '../api/contracts';

const presentation: Record<OperationState, { label: string; color: string; processing?: boolean }> = {
  queued: { label: '待执行', color: 'default' },
  executing: { label: '执行中', color: 'processing', processing: true },
  reconciling: { label: '状态未知，正在对账', color: 'warning', processing: true },
  succeeded: { label: '执行成功', color: 'success' },
  failed: { label: '执行失败', color: 'error' },
  conflict: { label: '状态冲突', color: 'warning' },
};

export function OperationStatus({ state }: { state: OperationState }) {
  const item = presentation[state];
  return item.processing ? <Badge status="processing" text={item.label} /> : <Tag color={item.color}>{item.label}</Tag>;
}
```

Create `ReasonForm.tsx` with the exact category-specific options and validation below:

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Form, Input, Select } from 'antd';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import type { ReasonInput } from '../api/contracts';

const options = {
  account: [
    { value: 'customer_request', label: '客户请求' },
    { value: 'policy_violation', label: '违反使用政策' },
    { value: 'account_recovery', label: '账号恢复' },
    { value: 'suspected_compromise', label: '疑似凭证泄露' },
    { value: 'security_incident', label: '安全事件处置' },
  ],
  device: [
    { value: 'lost_device', label: '设备遗失' },
    { value: 'device_replacement', label: '设备更换' },
    { value: 'suspected_compromise', label: '疑似凭证泄露' },
    { value: 'security_incident', label: '安全事件处置' },
  ],
  session: [
    { value: 'session_cleanup', label: '会话安全清理' },
    { value: 'suspected_compromise', label: '疑似凭证泄露' },
    { value: 'security_incident', label: '安全事件处置' },
  ],
} as const;

export type ReasonCategory = keyof typeof options;
const sensitiveText = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?86[- ]?)?1[3-9]\d{9}|bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|cookie\s*:|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

function schemaFor(category: ReasonCategory) {
  const allowed = new Set<string>(options[category].map((item) => item.value));
  return z.object({
    reason_code: z.string().refine((value) => allowed.has(value), '请选择标准原因'),
    ticket_reference: z.string().trim().max(128, '工单编号最多 128 字符'),
    note: z.string().trim().max(500, '补充说明最多 500 字符'),
  }).superRefine((value, context) => {
    for (const field of ['ticket_reference', 'note'] as const) {
      if (sensitiveText.test(value[field])) {
        context.addIssue({ code: 'custom', path: [field], message: '请勿填写邮箱、手机号、令牌、Cookie 或私钥' });
      }
    }
  });
}

export function ReasonForm({ category, submitLabel, pending = false, onSubmit }: {
  category: ReasonCategory;
  submitLabel: string;
  pending?: boolean;
  onSubmit: (value: ReasonInput) => void | Promise<void>;
}) {
  const schema = schemaFor(category);
  const { control, handleSubmit, formState: { errors } } = useForm<ReasonInput>({
    resolver: zodResolver(schema),
    defaultValues: { reason_code: '', ticket_reference: '', note: '' },
  });
  return <Form component="form" className="reason-form-grid" layout="vertical" onFinish={handleSubmit(onSubmit)}>
    <Controller control={control} name="reason_code" render={({ field }) => <Form.Item
      label="标准原因" validateStatus={errors.reason_code ? 'error' : undefined} help={errors.reason_code?.message}
    ><Select {...field} options={[...options[category]]} aria-label="标准原因" /></Form.Item>} />
    <Controller control={control} name="ticket_reference" render={({ field }) => <Form.Item
      label="工单编号" validateStatus={errors.ticket_reference ? 'error' : undefined} help={errors.ticket_reference?.message}
    ><Input {...field} maxLength={128} autoComplete="off" /></Form.Item>} />
    <Controller control={control} name="note" render={({ field }) => <Form.Item
      label="补充说明" validateStatus={errors.note ? 'error' : undefined} help={errors.note?.message}
    ><Input.TextArea {...field} maxLength={500} autoComplete="off" rows={3} /></Form.Item>} />
    <Button type="primary" htmlType="submit" danger loading={pending}>{submitLabel}</Button>
  </Form>;
}
```

- [ ] **Step 6: Test boundary and reason behavior**

Create `ReasonForm.test.tsx` with one table-driven sensitive-value test; use the same `onSubmit` spy for every case and assert it remains untouched:

```tsx
it.each([
  ['工单编号', 'owner@example.test'],
  ['工单编号', '13800138000'],
  ['补充说明', 'Bearer secret-canary'],
])('rejects sensitive text in %s', async (label, value) => {
  const onSubmit = vi.fn();
  render(<ReasonForm category="device" submitLabel="确认撤销" onSubmit={onSubmit} />);
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('标准原因'));
  await user.click(await screen.findByText('设备遗失'));
  await user.type(screen.getByLabelText(label), value);
  await user.click(screen.getByRole('button', { name: '确认撤销' }));
  expect(await screen.findByText('请勿填写邮箱、手机号、令牌、Cookie 或私钥')).toBeVisible();
  expect(onSubmit).not.toHaveBeenCalled();
});
```

Create `CloudBoundary.test.tsx` with these exact cases:

```tsx
it.each([
  ['CLOUD_NOT_CONFIGURED', 'Cloud 管理服务尚未配置'],
  ['CLOUD_UNAVAILABLE', 'Cloud 管理服务暂时不可用'],
  ['CLOUD_CONTRACT_VIOLATION', 'Cloud 安全契约异常'],
])('renders %s without metric children', (code, message) => {
  render(<CloudBoundary error={new APIError(503, code, 'safe')} empty={false} onRetry={vi.fn()}><span>42</span></CloudBoundary>);
  expect(screen.getByText(message)).toBeVisible();
  expect(screen.queryByText('42')).not.toBeInTheDocument();
});

it('renders children only for a successful non-empty result', () => {
  render(<CloudBoundary error={null} empty={false} onRetry={vi.fn()}><span>安全结果</span></CloudBoundary>);
  expect(screen.getByText('安全结果')).toBeVisible();
});

it('renders the explicit empty state', () => {
  render(<CloudBoundary error={null} empty onRetry={vi.fn()}><span>42</span></CloudBoundary>);
  expect(screen.getByText('没有符合条件的数据')).toBeVisible();
  expect(screen.queryByText('42')).not.toBeInTheDocument();
});
```

Run:

```bash
pnpm --filter @aera/admin-web test --run src/api/client.test.ts src/components/CloudBoundary.test.tsx src/components/ReasonForm.test.tsx
pnpm --filter @aera/admin-web typecheck
```

Expected: PASS.

- [ ] **Step 7: Add compact shared styling**

Append these exact compact styles to `web/src/styles/global.css`:

```css
.cloud-boundary { margin: 12px 0; }

.filter-card {
  margin-bottom: 12px;
  border: 1px solid #e7ebf1;
  border-radius: 8px;
  box-shadow: 0 4px 14px rgb(16 24 40 / 3%);
}

.filter-card .ant-card-body {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 10px;
  padding: 12px 14px;
}

.detail-drawer-grid {
  display: grid;
  grid-template-columns: minmax(120px, 0.4fr) minmax(220px, 1fr);
  gap: 8px 14px;
  font-size: 13px;
}

.detail-drawer-grid dt { color: #667085; }
.detail-drawer-grid dd { margin: 0; color: #182230; overflow-wrap: anywhere; }

.operation-status { display: inline-flex; align-items: center; min-height: 24px; font-size: 12px; }

.reason-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 12px;
}

.reason-form-grid .ant-form-item:nth-child(3),
.reason-form-grid > .ant-btn { grid-column: 1 / -1; }

.reason-form-grid > .ant-btn { justify-self: end; }
```

- [ ] **Step 8: Commit shared frontend primitives**

```bash
git add web/src/api web/src/components web/src/styles/global.css
git commit -m "feat: add cloud control UI primitives"
```

### Task 11: Masked Cloud User List, Exact Search, and Lifecycle Request UI

**Files:**
- Create: `web/src/pages/CloudUsersPage.tsx`
- Create: `web/src/pages/CloudUsersPage.test.tsx`
- Modify: `web/src/app/router.tsx`
- Modify: `web/src/app/router.test.tsx`
- Modify: `web/src/styles/global.css`

**Interfaces:**
- Consumes: `/cloud-users`, `/cloud-users/lookup`, `/cloud-users/{id}`, and `/approval-requests`.
- Produces: `CloudUsersPage` with list filters, one-request exact search, detail drawer, and operator lifecycle-request form.
- Guarantees: raw exact-search input is absent from every Query key and browser storage location.

- [ ] **Step 1: Write the failing exact-search privacy test**

Create `web/src/pages/CloudUsersPage.test.tsx`:

```tsx
it('uses a POST mutation for exact identity and clears every raw value after success', async () => {
  const rawIdentity = 'lookup.canary@example.test';
  const observed: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    observed.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.endsWith('/api/v1/cloud-users/lookup')) {
      return jsonResponse(maskedUser(), 200);
    }
    return jsonResponse({ items: [maskedUser()] }, 200);
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderCloudUsers(queryClient, 'support');
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('完整邮箱或手机号'), rawIdentity);
  await user.click(screen.getByRole('button', { name: '精确查找' }));
  expect(await screen.findByText('l***@example.test')).toBeVisible();
  expect(screen.getByLabelText('完整邮箱或手机号')).toHaveValue('');
  expect(observed.find((item) => item.body?.includes(rawIdentity))?.url.endsWith('/api/v1/cloud-users/lookup')).toBe(true);
  expect(observed.some((item) => item.url.includes(rawIdentity))).toBe(false);
  expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.queryKey))).not.toContain(rawIdentity);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it('renders explicit Cloud-unavailable state without invented rows', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'CLOUD_UNAVAILABLE', message: 'unavailable' } }, 503)));
  renderCloudUsers(new QueryClient({ defaultOptions: { queries: { retry: false } } }), 'operator');
  expect(await screen.findByText('Cloud 管理服务暂时不可用')).toBeVisible();
  expect(screen.queryByRole('row', { name: /example/ })).not.toBeInTheDocument();
});
```

`maskedUser()` returns a complete `CloudUser` with only `masked_email:'l***@example.test'`; `renderCloudUsers` wraps `QueryClientProvider`, an authenticated `AuthProvider`, and `MemoryRouter`.

- [ ] **Step 2: Run page tests and verify failure**

Run: `pnpm --filter @aera/admin-web test --run src/pages/CloudUsersPage.test.tsx`

Expected: FAIL because `CloudUsersPage` does not exist.

- [ ] **Step 3: Implement list and exact-search state boundaries**

Create `web/src/pages/CloudUsersPage.tsx` with these hooks:

```tsx
export function CloudUsersPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CloudUserStatus | 'all'>('all');
  const [cursor, setCursor] = useState('');
  const [lookupValue, setLookupValue] = useState('');
  const [lookupResult, setLookupResult] = useState<CloudUser | null>(null);
  const [selectedUserID, setSelectedUserID] = useState<string | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<'disable_user' | 'enable_user' | null>(null);

  const users = useQuery({
    queryKey: ['cloud-users', status, cursor],
    queryFn: () => request<Page<CloudUser>>(`/cloud-users?limit=50${status === 'all' ? '' : `&status=${status}`}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  });
  const lookup = useMutation({
    mutationFn: (input: { type: 'email' | 'phone'; value: string }) => postJSON<CloudUser>('/cloud-users/lookup', input),
    onSuccess: (result) => {
      setLookupResult(result);
      setLookupValue('');
    },
    onSettled: (_result, _error, variables) => {
      setLookupValue('');
      variables.value = '';
    },
  });

  const submitLookup = () => {
    const value = lookupValue.trim();
    const type = value.includes('@') ? 'email' : 'phone';
    if (!exactIdentitySchema.safeParse({ type, value }).success) return;
    lookup.mutate({ type, value });
  };

  useEffect(() => () => setLookupValue(''), []);
```

Use `exactIdentitySchema`:

```ts
const exactIdentitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), value: z.string().trim().email().max(320) }),
  z.object({ type: z.literal('phone'), value: z.string().trim().regex(/^\+?[0-9]{7,15}$/) }),
]);
```

Render a compact filter card, search input with `autoComplete="off"`, status filter, masked table, pagination buttons, and a result card. Never set lookup input as a URL, route state, query key, DOM data attribute, tooltip, notification description, or page title.

- [ ] **Step 4: Add detail drawer and lifecycle request**

Fetch the selected user only by internal UUID:

```tsx
const detail = useQuery({
  queryKey: ['cloud-user', selectedUserID],
  queryFn: () => request<CloudUser>(`/cloud-users/${selectedUserID}`),
  enabled: Boolean(selectedUserID),
});
```

The drawer displays masked identities, status, revision, device/session counts, creation time, and last Cloud activity. For `operator`, show “发起禁用申请” only for `active`, and “发起恢复申请” only for `disabled && administratively_disabled && !deletion_finalized_at`.

Submit with the existing Step-up retry pattern:

```tsx
const createLifecycleRequest = async (reason: ReasonInput) => {
  if (!detail.data || !lifecycleAction) return;
  const execute = () => postJSON<ApprovalRequest>('/approval-requests', {
    action: lifecycleAction,
    target_user_id: detail.data.user_id,
    reason_code: reason.reason_code,
    ticket_reference: reason.ticket_reference,
    note: reason.note,
  });
  try {
    await execute();
  } catch (error) {
    if (error instanceof APIError && error.code === 'STEP_UP_REQUIRED') {
      setPendingAfterStepUp(() => execute);
      setStepUpOpen(true);
      return;
    }
    throw error;
  }
  setLifecycleAction(null);
  await queryClient.invalidateQueries({ queryKey: ['approval-requests'] });
};
```

The success notification says “申请已提交，等待另一名超级管理员审批”; it never says the Cloud account changed.

- [ ] **Step 5: Replace the user placeholder route**

Lazy-load `CloudUsersPage` in `web/src/app/router.tsx` and replace only the `/cloud/users` placeholder:

```tsx
const CloudUsersPage = lazy(() => import('../pages/CloudUsersPage').then((module) => ({ default: module.CloudUsersPage })));

{
  path: 'cloud/users',
  element: <RequirePermission permission="cloud_user.read">{suspended(<CloudUsersPage />)}</RequirePermission>,
},
```

Update `router.test.tsx` to assert a support role can render the page, while `finance` gets “无权访问此页面”.

- [ ] **Step 6: Run page, router, lint, and type tests**

Run:

```bash
pnpm --filter @aera/admin-web test --run src/pages/CloudUsersPage.test.tsx src/app/router.test.tsx
pnpm --filter @aera/admin-web lint
pnpm --filter @aera/admin-web typecheck
```

Expected: PASS; exact input occurs only in the POST body and is cleared after completion.

- [ ] **Step 7: Commit the Cloud user page**

```bash
git add web/src/pages/CloudUsersPage.tsx web/src/pages/CloudUsersPage.test.tsx web/src/app/router.tsx web/src/app/router.test.tsx web/src/styles/global.css
git commit -m "feat: add masked cloud user management page"
```

### Task 12: Device and Session Inspection with Idempotent Single-item Revoke

**Files:**
- Create: `web/src/pages/CloudDevicesPage.tsx`
- Create: `web/src/pages/CloudDevicesPage.test.tsx`
- Modify: `web/src/app/router.tsx`
- Modify: `web/src/app/router.test.tsx`
- Modify: `web/src/styles/global.css`

**Interfaces:**
- Consumes: user detail, user device/session pages, revoke routes, and operation status.
- Produces: one-user-at-a-time device/session view and single-item revoke flow.
- Guarantees: accepted, reconciling, failed, conflict, and succeeded remain visually distinct.

- [ ] **Step 1: Write failing duplicate-click and reconciliation tests**

Create `web/src/pages/CloudDevicesPage.test.tsx`:

```tsx
it('uses one idempotency key and never reports accepted as succeeded', async () => {
  const revokeCalls: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/devices')) return jsonResponse({ items: [activeDevice()] }, 200);
    if (url.includes('/sessions')) return jsonResponse({ items: [] }, 200);
    if (url.endsWith('/revoke')) {
      revokeCalls.push(init ?? {});
      return jsonResponse({ operation_id: operationID, state: 'queued', updated_at: '2026-07-22T08:00:00Z' }, 202);
    }
    if (url.endsWith(`/operations/${operationID}`)) {
      return jsonResponse({ operation_id: operationID, state: 'reconciling', error_code: 'OPERATION_STATUS_UNKNOWN', updated_at: '2026-07-22T08:00:01Z' }, 200);
    }
    return jsonResponse(activeUser(), 200);
  }));
  renderDevices('support');
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Cloud 用户 ID'), activeUser().user_id);
  await user.click(screen.getByRole('button', { name: '加载设备与会话' }));
  await user.click(await screen.findByRole('button', { name: '撤销设备' }));
  await user.click(screen.getByLabelText('标准原因'));
  await user.click(await screen.findByText('设备遗失'));
  const confirm = screen.getByRole('button', { name: '确认撤销' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(revokeCalls).toHaveLength(1);
  expect(new Headers(revokeCalls[0].headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText('状态未知，正在对账')).toBeVisible();
  expect(screen.queryByText('执行成功')).not.toBeInTheDocument();
});

it('lets developer inspect but never renders revoke controls', async () => {
  stubDeviceReads();
  renderDevices('developer');
  await loadUserByID();
  expect(await screen.findByText('测试设备')).toBeVisible();
  expect(screen.queryByRole('button', { name: /撤销/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run page tests and verify failure**

Run: `pnpm --filter @aera/admin-web test --run src/pages/CloudDevicesPage.test.tsx`

Expected: FAIL because `CloudDevicesPage` does not exist.

- [ ] **Step 3: Implement one-user inspection**

Create `CloudDevicesPage.tsx` with an internal UUID input validated by `z.string().uuid()`. After submit, keep `selectedUserID` in component state and run these queries:

```tsx
const user = useQuery({
  queryKey: ['cloud-user', selectedUserID],
  queryFn: () => request<CloudUser>(`/cloud-users/${selectedUserID}`),
  enabled: Boolean(selectedUserID),
});
const devices = useQuery({
  queryKey: ['cloud-user-devices', selectedUserID],
  queryFn: () => request<Page<CloudDevice>>(`/cloud-users/${selectedUserID}/devices?limit=100`),
  enabled: Boolean(selectedUserID),
});
const sessions = useQuery({
  queryKey: ['cloud-user-sessions', selectedUserID],
  queryFn: () => request<Page<CloudSession>>(`/cloud-users/${selectedUserID}/sessions?limit=100`),
  enabled: Boolean(selectedUserID),
});
```

Render separate compact tables. Device IDs and session IDs may be copied because they are internal identifiers; never render device public keys, refresh-family hashes, tokens, full IP addresses, or identity ciphertext.

- [ ] **Step 4: Implement one-operation revoke state**

Keep exactly one selected target and idempotency key:

```tsx
type RevokeTarget = { kind: 'device' | 'session'; id: string };
const [target, setTarget] = useState<RevokeTarget | null>(null);
const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
const [operationID, setOperationID] = useState<string | null>(null);
const revokeInFlight = useRef(false);

const openRevoke = (next: RevokeTarget) => {
  setTarget(next);
  setIdempotencyKey(newIdempotencyKey());
};

const revoke = useMutation({
  mutationFn: async (reason: ReasonInput) => {
    if (!target || !idempotencyKey || !user.data) throw new Error('revoke context is incomplete');
    const path = target.kind === 'device' ? `/cloud-devices/${target.id}/revoke` : `/cloud-sessions/${target.id}/revoke`;
    return postIdempotentJSON<AdminOperation>(path, {
      expected_revision: user.data.administrative_revision,
      reason_code: reason.reason_code,
      ticket_reference: reason.ticket_reference,
      note: reason.note,
    }, idempotencyKey);
  },
  onSuccess: (operation) => {
    setOperationID(operation.operation_id);
    setTarget(null);
  },
  onSettled: () => { revokeInFlight.current = false; },
});

const submitRevoke = (reason: ReasonInput) => {
  if (revokeInFlight.current) return;
  revokeInFlight.current = true;
  revoke.mutate(reason);
};

const operation = useQuery({
  queryKey: ['admin-operation', operationID],
  queryFn: () => request<AdminOperation>(`/operations/${operationID}`),
  enabled: Boolean(operationID),
  refetchInterval: (query) => {
    const state = query.state.data?.state;
    return state === 'queued' || state === 'executing' || state === 'reconciling' ? 1000 : false;
  },
});
```

Disable the confirm button while the mutation is pending. If the server returns `STEP_UP_REQUIRED`, retain the same `idempotencyKey`, open `StepUpModal`, and retry only after successful TOTP verification. Clear the key only when the modal is cancelled before acceptance or the operation reaches a final state.

When `state==='succeeded'`, invalidate user/device/session queries and show “Cloud 已确认撤销成功”. For `reconciling`, show “状态未知，正在对账”; for failed/conflict, show the stable error code and no success wording.

- [ ] **Step 5: Replace the device placeholder route**

Lazy-load `CloudDevicesPage` and replace `/cloud/devices`:

```tsx
{
  path: 'cloud/devices',
  element: <RequirePermission permission="cloud_device.read">{suspended(<CloudDevicesPage />)}</RequirePermission>,
},
```

Update router tests for developer read access and finance denial.

- [ ] **Step 6: Run frontend verification for this page**

Run:

```bash
pnpm --filter @aera/admin-web test --run src/pages/CloudDevicesPage.test.tsx src/app/router.test.tsx
pnpm --filter @aera/admin-web lint
pnpm --filter @aera/admin-web typecheck
```

Expected: PASS with one revoke POST for duplicate clicks and no false success during reconciliation.

- [ ] **Step 7: Commit device/session management**

```bash
git add web/src/pages/CloudDevicesPage.tsx web/src/pages/CloudDevicesPage.test.tsx web/src/app/router.tsx web/src/app/router.test.tsx web/src/styles/global.css
git commit -m "feat: add device and session controls"
```

### Task 13: Approval Console, Health Page, and Truthful Dashboard

**Files:**
- Create: `web/src/pages/ApprovalsPage.tsx`
- Create: `web/src/pages/ApprovalsPage.test.tsx`
- Create: `web/src/pages/SystemHealthPage.tsx`
- Create: `web/src/pages/SystemHealthPage.test.tsx`
- Modify: `web/src/pages/DashboardPage.tsx`
- Modify: `web/src/app/router.tsx`
- Modify: `web/src/app/router.test.tsx`
- Modify: `web/src/styles/global.css`

**Interfaces:**
- Consumes: approval list/detail/actions, operation status, and system health.
- Produces: role-correct approval views, separate approval/execution state, and dependency health without secret details.
- Replaces: only the `/approvals` and `/system/health` scoped placeholder pages.

- [ ] **Step 1: Write failing approval separation and role tests**

Create `web/src/pages/ApprovalsPage.test.tsx`:

```tsx
it('shows approved and reconciling as different states without success language', async () => {
  const request = approvalFixture({ approval_status: 'approved', execution_status: 'reconciling' });
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [request] }, 200)));
  renderApprovals('super_admin');
  expect(await screen.findByText('已批准')).toBeVisible();
  expect(screen.getByText('状态未知，正在对账')).toBeVisible();
  expect(screen.queryByText('执行成功')).not.toBeInTheDocument();
});

it('operator can cancel its pending request but cannot approve it', async () => {
  const request = approvalFixture({ approval_status: 'pending_review', execution_status: 'not_started' });
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [request] }, 200)));
  renderApprovals('operator', request.requested_by_admin_id);
  expect(await screen.findByRole('button', { name: '撤回申请' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
});

it('approval uses a stable idempotency key and remains queued after HTTP 202', async () => {
  const request = approvalFixture({ approval_status: 'pending_review', execution_status: 'not_started' });
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/approve')) {
      calls.push(init ?? {});
      return jsonResponse({ ...request, approval_status: 'approved', execution_status: 'queued', operation_id: operationID }, 202);
    }
    return jsonResponse({ items: [request] }, 200);
  }));
  renderApprovals('super_admin', '019f0000-0000-7000-8000-000000000061');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '批准' }));
  await user.click(screen.getByRole('button', { name: '确认批准' }));
  expect(calls).toHaveLength(1);
  expect(new Headers(calls[0].headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByText('待执行')).toBeVisible();
  expect(screen.queryByText('执行成功')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run approval tests and verify failure**

Run: `pnpm --filter @aera/admin-web test --run src/pages/ApprovalsPage.test.tsx`

Expected: FAIL because `ApprovalsPage` does not exist.

- [ ] **Step 3: Implement role-scoped approval list and details**

Create `ApprovalsPage.tsx` with view state constrained by role:

```tsx
const allowedViews = {
  operator: ['mine'] as const,
  super_admin: ['pending_for_me', 'all'] as const,
};

const approvals = useQuery({
  queryKey: ['approval-requests', view, cursor],
  queryFn: () => request<Page<ApprovalRequest>>(`/approval-requests?view=${view}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  refetchInterval: (query) => query.state.data?.items.some((item) =>
    item.execution_status === 'queued' || item.execution_status === 'executing' || item.execution_status === 'reconciling',
  ) ? 2000 : false,
});
```

Render target masked snapshot, action, requester ID, reason, expiry, approval state, execution state, operation ID, and timestamps. The details drawer treats approval events as read-only and never allows editing reason, target, or expected revision.

Approve with a component-state idempotency key and Step-up retry:

```tsx
const approve = useMutation({
  mutationFn: ({ id, key }: { id: string; key: string }) =>
    postIdempotentJSON<ApprovalRequest>(`/approval-requests/${id}/approve`, {}, key),
  onSuccess: (updated) => {
    queryClient.setQueryData<Page<ApprovalRequest>>(['approval-requests', view, cursor], (current) => current && ({
      ...current,
      items: current.items.map((item) => item.id === updated.id ? updated : item),
    }));
  },
});
```

Reject and cancel use `postJSON` with an empty object; the BFF derives actor and retains the original reason. Show buttons only when the local role/state permits, while relying on BFF RBAC for enforcement.

- [ ] **Step 4: Write and implement system health states**

Create `SystemHealthPage.test.tsx`:

```tsx
it('shows Cloud authentication categories without addresses or key paths', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
    admin: 'ok', postgres: 'ok', redis: 'ok',
    cloud: { configured: true, availability: 'unavailable', mtls: 'ok', service_jwt: 'ok', upstream: 'unavailable', checked_at: '2026-07-22T08:00:00Z' },
  }, 200)));
  renderHealth('developer');
  expect(await screen.findByText('Cloud 管理链路')).toBeVisible();
  expect(screen.getByText('mTLS')).toBeVisible();
  expect(screen.getByText('服务令牌')).toBeVisible();
  expect(screen.getByText('Cloud 上游')).toBeVisible();
  expect(screen.getByText('暂时不可用')).toBeVisible();
  expect(document.body.textContent).not.toMatch(/\/run\/secrets|postgres:\/\/|redis:\/\/|BEGIN PRIVATE KEY/);
});
```

Create `SystemHealthPage.tsx`:

```tsx
export function SystemHealthPage() {
  const health = useQuery({
    queryKey: ['system-health'],
    queryFn: () => request<SystemHealth>('/system/health'),
    refetchInterval: 15_000,
  });
  if (health.error) return <CloudBoundary error={health.error} empty={false} onRetry={() => void health.refetch()}>{null}</CloudBoundary>;
  const document = health.data;
  return <div className="system-health-page">
    <div className="page-heading"><div><Typography.Title level={3}>服务健康</Typography.Title><Typography.Paragraph type="secondary">仅显示安全状态分类，不暴露连接与密钥信息。</Typography.Paragraph></div></div>
    <Row gutter={[14, 14]}>
      <HealthCard title="Aera Admin" state={document?.admin ?? 'unavailable'} />
      <HealthCard title="PostgreSQL" state={document?.postgres ?? 'unavailable'} />
      <HealthCard title="Redis" state={document?.redis ?? 'unavailable'} />
      <HealthCard title="Cloud 管理链路" state={document?.cloud.availability ?? 'unavailable'} />
      <HealthCard title="mTLS" state={document?.cloud.mtls ?? 'not_checked'} />
      <HealthCard title="服务令牌" state={document?.cloud.service_jwt ?? 'not_checked'} />
      <HealthCard title="Cloud 上游" state={document?.cloud.upstream ?? 'not_checked'} />
    </Row>
  </div>;
}
```

`HealthCard` maps only approved state labels and never renders URLs, certificate subjects, file paths, JWT claims, or raw errors.

- [ ] **Step 5: Make Dashboard use real health and approval data**

Replace static “待初始化/尚未接入” values with queries to `/system/health` and the role-visible `/approval-requests?view=...&limit=5`. Display counts only after a successful response. When a query fails, show “不可用” and omit the numeric value. Preserve the existing sentence “未连接的数据源不会生成演示指标”.

```tsx
const metric = <T,>(query: UseQueryResult<T>, value: (data: T) => React.ReactNode) =>
  query.isSuccess ? value(query.data) : <Tag color="default">不可用</Tag>;
```

- [ ] **Step 6: Replace scoped routes and run frontend checks**

Lazy-load `ApprovalsPage` and `SystemHealthPage`, replacing their two `ModulePlaceholderPage` entries while preserving the existing `RequirePermission` wrappers. Update router tests for operator/super-admin approval access, developer health access, support health denial, and finance denial.

Run:

```bash
pnpm --filter @aera/admin-web test --run src/pages/ApprovalsPage.test.tsx src/pages/SystemHealthPage.test.tsx src/app/router.test.tsx
pnpm --filter @aera/admin-web lint
pnpm --filter @aera/admin-web typecheck
pnpm --filter @aera/admin-web build
```

Expected: PASS with approval/execution states separated and health free of secret details.

- [ ] **Step 7: Commit approval and health UI**

```bash
git add web/src/pages/ApprovalsPage.tsx web/src/pages/ApprovalsPage.test.tsx web/src/pages/SystemHealthPage.tsx web/src/pages/SystemHealthPage.test.tsx web/src/pages/DashboardPage.tsx web/src/app/router.tsx web/src/app/router.test.tsx web/src/styles/global.css
git commit -m "feat: add approval and health consoles"
```

### Task 14: E2E-only Cloud Contract Process and Acceptance Flows

**Files:**
- Create: `e2e/cloud-stub/main.go`
- Create: `e2e/cloud-control.spec.ts`
- Modify: `e2e/support.ts`
- Modify: `e2e/global-setup.ts`
- Modify: `e2e/global-teardown.ts`
- Modify: `scripts/run-e2e.sh`

**Interfaces:**
- Produces: an `e2e` build-tag-only mTLS server implementing the consumer contract.
- Consumes: the production Admin HTTP client; the stub is never linked into `aera-admin`.
- Verifies: six-role denial, exact-search privacy, idempotent revoke, dual approval, execution-state separation, and log/audit canaries.

- [ ] **Step 1: Write failing browser acceptance flows**

Create `e2e/cloud-control.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { apiRequest, generateTOTP, loginWithRecovery, readFixtures } from './support';

test('support exact-searches a masked identity without browser or log persistence', async ({ page }) => {
  const fixtures = readFixtures();
  const support = fixtures.roles.support[0];
  await loginInBrowser(page, support);
  await page.goto('/cloud/users');
  await page.getByLabel('完整邮箱或手机号').fill(fixtures.cloud.rawLookupIdentity);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/cloud-users/lookup'));
  await page.getByRole('button', { name: '精确查找' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.url()).not.toContain(fixtures.cloud.rawLookupIdentity);
  expect(await response.text()).not.toContain(fixtures.cloud.rawLookupIdentity);
  await expect(page.getByText(fixtures.cloud.maskedEmail)).toBeVisible();
  await expect(page.getByLabel('完整邮箱或手机号')).toHaveValue('');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('operator request and different super-admin approval remain separate from execution', async () => {
  const fixtures = readFixtures();
  const operator = await loginWithRecovery(fixtures.baseURL, fixtures.roles.operator[0], 1, []);
  const operatorStepCode = generateTOTP(operator.fixture.totpSecret, 1);
  const operatorStepped = await apiRequest<{ csrf_token: string }>(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: operatorStepCode }, cookie: operator.cookie, csrfToken: operator.csrfToken,
  });
  expect(operatorStepped.status).toBe(200);
  const created = await apiRequest<{ id: string; approval_status: string; execution_status: string }>(fixtures.baseURL, '/approval-requests', {
    body: {
      action: 'disable_user', target_user_id: fixtures.cloud.userID,
      reason_code: 'policy_violation', ticket_reference: 'E2E-CLOUD-01', note: '',
    },
    cookie: operator.cookie, csrfToken: operatorStepped.body.csrf_token,
  });
  expect(created.status).toBe(201);
  expect(created.body).toEqual(expect.objectContaining({ approval_status: 'pending_review', execution_status: 'not_started' }));

  const reviewer = await loginWithRecovery(fixtures.baseURL, fixtures.roles.super_admin[1], 1, []);
  const stepCode = generateTOTP(reviewer.fixture.totpSecret, 1);
  const stepped = await apiRequest<{ csrf_token: string }>(fixtures.baseURL, '/auth/step-up', {
    body: { totp_code: stepCode }, cookie: reviewer.cookie, csrfToken: reviewer.csrfToken,
  });
  expect(stepped.status).toBe(200);
  const approved = await apiRequest<{ operation_id: string; approval_status: string; execution_status: string }>(
    fixtures.baseURL, `/approval-requests/${created.body.id}/approve`, {
      body: {}, cookie: reviewer.cookie, csrfToken: stepped.body.csrf_token,
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    },
  );
  expect(approved.status).toBe(202);
  expect(approved.body.approval_status).toBe('approved');
  expect(approved.body.execution_status).toBe('queued');
  await expect.poll(async () => {
    const result = await apiRequest<{ execution_status: string }>(fixtures.baseURL, `/approval-requests/${created.body.id}`, { cookie: reviewer.cookie });
    return result.body.execution_status;
  }).toBe('succeeded');
});

test('every unauthorized fixed role receives API 403 for Cloud mutations', async () => {
  const fixtures = readFixtures();
  for (const role of ['developer', 'finance', 'auditor'] as const) {
    const authenticated = await loginWithRecovery(fixtures.baseURL, fixtures.roles[role][0], 1, []);
    const result = await apiRequest(fixtures.baseURL, `/cloud-sessions/${fixtures.cloud.sessionID}/revoke`, {
      body: { expected_revision: 1, reason_code: 'session_cleanup', ticket_reference: '', note: '' },
      cookie: authenticated.cookie, csrfToken: authenticated.csrfToken,
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    expect(result.status).toBe(403);
    expect((result.body as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
  }
});
```

Extend `apiRequest` options in `e2e/support.ts` with `headers?: Record<string,string>` and merge those headers after Origin/CSRF defaults. Add a `cloud` fixture object containing only the test user/device/session IDs, raw lookup canary, and masked email.

- [ ] **Step 2: Run the new E2E spec and verify startup failure**

Run: `pnpm exec playwright test e2e/cloud-control.spec.ts`

Expected: FAIL because the E2E Cloud process and Admin Cloud configuration are absent.

- [ ] **Step 3: Implement the E2E-build-only mTLS Cloud process**

Create `e2e/cloud-stub/main.go` beginning with:

```go
//go:build e2e

package main
```

The process reads only these required environment variables: `AERA_ADMIN_E2E_CLOUD_LISTEN_ADDR`, `AERA_ADMIN_E2E_CLOUD_CA_FILE`, `AERA_ADMIN_E2E_CLOUD_CERT_FILE`, `AERA_ADMIN_E2E_CLOUD_KEY_FILE`, and `AERA_ADMIN_E2E_CLOUD_JWT_PUBLIC_KEY_FILE`. It constructs an `http.Server` with `tls.Config{MinVersion:tls.VersionTLS13, ClientAuth:tls.RequireAndVerifyClientCert, ClientCAs:roots}`.

Use this fixed in-memory state guarded by `sync.Mutex`:

```go
type state struct {
    userID uuid.UUID
    deviceID uuid.UUID
    sessionID uuid.UUID
    rawLookupIdentity string
    userStatus string
    revision int64
    operations map[uuid.UUID]string
}

func newState() *state {
    return &state{
        userID: uuid.MustParse("019f0000-0000-7000-8000-000000000071"),
        deviceID: uuid.MustParse("019f0000-0000-7000-8000-000000000072"),
        sessionID: uuid.MustParse("019f0000-0000-7000-8000-000000000073"),
        rawLookupIdentity: "cloud.lookup.canary@example.test",
        userStatus: "active", revision: 1, operations: make(map[uuid.UUID]string),
    }
}
```

Middleware rejects requests unless the client certificate is present and the bearer JWT has a valid Ed25519 signature, `aud=aera-cloud-admin`, unexpired `exp`, current `nbf`, non-empty `jti`, and a route-appropriate scope. It reads request bodies through `http.MaxBytesReader`, uses `DisallowUnknownFields`, never logs headers or bodies, and emits only method, route template, status, and request ID.

Register every Task 3 consumer path. Reads return only:

```json
{
  "user_id":"019f0000-0000-7000-8000-000000000071",
  "masked_email":"c***@example.test",
  "status":"active",
  "administratively_disabled":false,
  "administrative_revision":1,
  "device_count":1,
  "active_device_count":1,
  "active_session_count":1,
  "created_at":"2026-07-22T08:00:00Z"
}
```

Lookup compares the received value to `rawLookupIdentity` in memory and never writes it. Mutation handlers require `Idempotency-Key == operation_id`, preserve one result per operation ID, check `expected_revision`, update the in-memory status/revision once, and return the same operation on retry. `GET /operations/{id}` returns the stored state. No handler returns the raw identity.

- [ ] **Step 4: Generate ephemeral PKI and start the stub in the E2E script**

In `scripts/run-e2e.sh`, add `cloud_pid`, `cloud_log`, and a `pki_dir` beneath the already validated `e2e_tmp_dir`; terminate `cloud_pid` in `cleanup`. Generate ephemeral credentials:

```sh
openssl req -x509 -newkey rsa:3072 -nodes -days 1 -subj '/CN=Aera Admin E2E CA' \
  -keyout "$pki_dir/ca-key.pem" -out "$pki_dir/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:3072 -nodes -subj '/CN=127.0.0.1' \
  -keyout "$pki_dir/cloud-key.pem" -out "$pki_dir/cloud.csr" >/dev/null 2>&1
printf 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$pki_dir/cloud.ext"
openssl x509 -req -days 1 -in "$pki_dir/cloud.csr" -CA "$pki_dir/ca.pem" -CAkey "$pki_dir/ca-key.pem" -CAcreateserial \
  -extfile "$pki_dir/cloud.ext" -out "$pki_dir/cloud.pem" >/dev/null 2>&1
openssl req -newkey rsa:3072 -nodes -subj '/CN=aera-admin-e2e' \
  -keyout "$pki_dir/client-key.pem" -out "$pki_dir/client.csr" >/dev/null 2>&1
printf 'extendedKeyUsage=clientAuth\n' >"$pki_dir/client.ext"
openssl x509 -req -days 1 -in "$pki_dir/client.csr" -CA "$pki_dir/ca.pem" -CAkey "$pki_dir/ca-key.pem" -CAcreateserial \
  -extfile "$pki_dir/client.ext" -out "$pki_dir/client.pem" >/dev/null 2>&1
openssl genpkey -algorithm ED25519 -out "$pki_dir/service-key.pem" >/dev/null 2>&1
openssl pkey -in "$pki_dir/service-key.pem" -pubout -out "$pki_dir/service-public.pem" >/dev/null 2>&1
```

Build and launch:

```sh
cloud_binary="$e2e_tmp_dir/aera-admin-cloud-stub"
go build -tags e2e -trimpath -o "$cloud_binary" ./e2e/cloud-stub
export AERA_ADMIN_E2E_CLOUD_LISTEN_ADDR=127.0.0.1:18443
export AERA_ADMIN_E2E_CLOUD_CA_FILE="$pki_dir/ca.pem"
export AERA_ADMIN_E2E_CLOUD_CERT_FILE="$pki_dir/cloud.pem"
export AERA_ADMIN_E2E_CLOUD_KEY_FILE="$pki_dir/cloud-key.pem"
export AERA_ADMIN_E2E_CLOUD_JWT_PUBLIC_KEY_FILE="$pki_dir/service-public.pem"
"$cloud_binary" >"$cloud_log" 2>&1 &
cloud_pid=$!

export AERA_ADMIN_OPERATION_HMAC_KEY="$(openssl rand -base64 32 | tr -d '\n')"
export AERA_ADMIN_CLOUD_ENABLED=true
export AERA_ADMIN_CLOUD_BASE_URL=https://127.0.0.1:18443
export AERA_ADMIN_CLOUD_CA_FILE="$pki_dir/ca.pem"
export AERA_ADMIN_CLOUD_CLIENT_CERT_FILE="$pki_dir/client.pem"
export AERA_ADMIN_CLOUD_CLIENT_KEY_FILE="$pki_dir/client-key.pem"
export AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE="$pki_dir/service-key.pem"
export AERA_ADMIN_CLOUD_JWT_ISSUER=aera-admin
export AERA_ADMIN_CLOUD_JWT_SUBJECT=aera-admin-e2e
export AERA_ADMIN_CLOUD_SCOPES='["users:read","devices:write","sessions:write","accounts:write","operations:read"]'
export AERA_ADMIN_E2E_CLOUD_LOG="$cloud_log"
```

Immediately after `cloud_pid=$!`, verify the separate process accepts the generated client identity and validates the server chain; never use `curl -k`:

```sh
cloud_ready=false
attempt=0
while [ "$attempt" -lt 80 ]; do
  if printf '' | openssl s_client -connect 127.0.0.1:18443 -verify_return_error \
      -CAfile "$pki_dir/ca.pem" -cert "$pki_dir/client.pem" -key "$pki_dir/client-key.pem" \
      2>&1 | grep -q 'Verify return code: 0 (ok)'; then
    cloud_ready=true
    break
  fi
  if ! kill -0 "$cloud_pid" 2>/dev/null; then
    echo "Aera Admin E2E Cloud process stopped before mTLS readiness" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done
if [ "$cloud_ready" != true ]; then
  echo "Aera Admin E2E Cloud process did not become mTLS-ready" >&2
  exit 1
fi
```

Then start the production Admin binary and retain its existing `/health/ready` loop. The Cloud behavior itself is exercised only through the authenticated Admin BFF flows in this E2E spec.

- [ ] **Step 5: Extend fixture and teardown canary checks**

In `global-setup.ts`, add the raw Cloud lookup identity to `sensitiveCanaries`. In `global-teardown.ts`, read both `AERA_ADMIN_E2E_SERVER_LOG` and `AERA_ADMIN_E2E_CLOUD_LOG`, and call the existing `assertNoCanaries` for each. Extend `TestE2EAcceptance` in `internal/audit/e2e_acceptance_test.go` to reject the Cloud raw lookup canary and verify request/approval/operation IDs exist for the successful lifecycle flow.

- [ ] **Step 6: Run the full E2E suite**

Run: `make e2e`

Expected: PASS; Cloud control tests use real Admin auth, CSRF, Step-up, PostgreSQL, Redis, mTLS, service JWT, Outbox Worker, and the separate E2E contract process.

- [ ] **Step 7: Commit E2E acceptance**

```bash
git add e2e scripts/run-e2e.sh internal/audit/e2e_acceptance_test.go
git commit -m "test: cover cloud control admin workflows"
```

### Task 15: Documentation, Full Verification, and Authorized Push

**Files:**
- Modify: `README.md`
- Modify: `Makefile`
- Modify: `docs/superpowers/specs/2026-07-22-aera-admin-foundation-v1-admin-only-design.md`

**Interfaces:**
- Produces: accurate local-delivery status and repeatable complete verification.
- Preserves: the statement that real `aera-cloud` end-to-end management is still unverified.

- [ ] **Step 1: Add every new package to standard checks**

Update `Makefile` integration and race commands:

```make
test-integration: dependencies-up
	AERA_ADMIN_TEST_DATABASE_URL='$(AERA_ADMIN_TEST_DATABASE_URL)' AERA_ADMIN_TEST_REDIS_ADDR='$(AERA_ADMIN_TEST_REDIS_ADDR)' go test ./internal/store ./internal/audit ./internal/admin ./internal/auth ./internal/cloudadmin ./internal/operations ./internal/approval ./internal/cloudcontrol -count=1

race: dependencies-up
	AERA_ADMIN_TEST_DATABASE_URL='$(AERA_ADMIN_TEST_DATABASE_URL)' AERA_ADMIN_TEST_REDIS_ADDR='$(AERA_ADMIN_TEST_REDIS_ADDR)' go test -race ./internal/audit ./internal/admin ./internal/auth ./internal/cloudadmin ./internal/operations ./internal/approval ./internal/cloudcontrol -count=1
```

- [ ] **Step 2: Update README with exact delivery truth**

Replace the placeholder-only status paragraph with:

```markdown
当前仓库已完成独立管理员认证安全底座，以及 Admin 侧 Cloud 用户、设备、会话、双人审批、幂等和 Outbox 工作流。Cloud 管理未配置或不可达时严格失败关闭，页面不会生成演示指标或显示虚假成功。

本仓库的 mTLS 与服务令牌契约已通过独立 E2E 测试进程验证；`aera-cloud` 真实 Internal Admin API 尚未在本次范围内实现，因此不能把当前状态描述为真实 Cloud 端到端管理、部署或发布。
```

Document all new environment variable names without values, local disabled-mode startup, enabled-mode secret-file requirements, `make verify`, and `make e2e`. Keep passwords, TOTP seeds, keys, local fixture identities, and internal service addresses out of README.

- [ ] **Step 3: Mark only the Admin-only design status as locally implemented**

Add a delivery section to the design spec:

```markdown
## 14. 实施状态

- Admin-only 代码：本地实现并通过自动化验证。
- Git 提交：已完成。
- 远端推送：以最终 `git push` 结果为准。
- `aera-cloud` 真实联调：未在本增量实施。
- 部署与发布：未实施。
```

Do not change the parent Phase 1 design to “complete”.

- [ ] **Step 4: Run formatting and focused verification**

Run:

```bash
gofmt -w $(find api cmd internal e2e/cloud-stub -name '*.go' -type f)
git diff --check
go test ./internal/cloudadmin ./internal/operations ./internal/approval ./internal/cloudcontrol ./api -count=1
pnpm --filter @aera/admin-web lint
pnpm --filter @aera/admin-web test --run
pnpm --filter @aera/admin-web typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Run complete repository verification**

Run:

```bash
make verify
make e2e
```

Expected: both commands exit 0; no sensitive canary appears in Admin logs, Cloud-stub logs, browser storage, responses, or audit.

- [ ] **Step 6: Inspect scope and commit documentation**

Run:

```bash
git status --short
git diff --stat 6260a44..HEAD
git diff --check 6260a44..HEAD
git diff --name-only 6260a44..HEAD
```

Expected: every changed path belongs to `aera-admin`; no environment file, key, certificate, database, log, `tmp/`, `bin/`, or `.superpowers/` file is tracked.

Commit:

```bash
git add README.md Makefile docs/superpowers/specs/2026-07-22-aera-admin-foundation-v1-admin-only-design.md
git commit -m "docs: close admin-only foundation delivery"
```

- [ ] **Step 7: Push the verified branch to the specified repository**

Run:

```bash
git remote get-url origin
git branch --show-current
git push origin aera/admin-security-foundation
```

Expected: remote is `https://github.com/bignormal/aera-admin.git`, branch is `aera/admin-security-foundation`, and push succeeds. Report the final commit separately from deployment/release, which remain not performed.

## File Structure

```text
api/
├── openapi/admin.yaml                         # Browser-to-BFF contract
├── openapi/cloud-admin-client.yaml            # Versioned consumer contract snapshot
└── openapi_test.go                            # Contract presence and safety assertions
cmd/aera-admin/
├── main.go                                    # Production composition and Worker lifecycle
└── main_test.go                               # Wiring and disabled-mode integration
internal/
├── approval/
│   ├── model.go                               # Approval and execution state machines
│   ├── model_test.go
│   ├── repository.go                          # Approval request/event persistence
│   ├── repository_test.go
│   ├── service.go                             # Create/review/cancel/list rules
│   └── service_test.go
├── cloudadmin/
│   ├── client.go                              # Client interface and disabled client
│   ├── client_test.go
│   ├── contract.go                            # Whitelisted Cloud DTOs and validation
│   ├── contract_test.go
│   ├── http_client.go                         # mTLS HTTP implementation
│   ├── http_client_test.go
│   ├── token.go                               # Ed25519 short-lived service JWT
│   └── token_test.go
├── cloudcontrol/
│   ├── http.go                                # Browser routes, RBAC, Step-up, stable errors
│   ├── http_test.go
│   ├── service.go                             # Reads, lookup, mutation and health orchestration
│   └── service_test.go
├── config/
│   ├── config.go                              # Strict Cloud/service-identity configuration
│   └── config_test.go
├── operations/
│   ├── model.go                               # Action, operation and Outbox states
│   ├── repository.go                          # Idempotency and Outbox transactions
│   ├── repository_test.go
│   ├── service.go                             # Immediate command acceptance
│   ├── service_test.go
│   ├── worker.go                              # Delivery, retry and reconciliation
│   └── worker_test.go
└── store/
    ├── migrations/000005_cloud_control.sql    # Approval, event, Outbox and idempotency schema
    └── migrate_test.go                        # Schema constraints and append-only tests
web/src/
├── api/
│   ├── client.ts                              # Idempotent request helper
│   ├── client.test.ts
│   └── contracts.ts                           # Cloud, operation and approval browser types
├── components/
│   ├── CloudBoundary.tsx                      # Configured/unavailable/contract states
│   ├── CloudBoundary.test.tsx
│   ├── OperationStatus.tsx                    # Queued/executing/reconciling/final states
│   ├── ReasonForm.tsx                         # Shared standard-reason controls
│   └── ReasonForm.test.tsx
├── pages/
│   ├── ApprovalsPage.tsx
│   ├── ApprovalsPage.test.tsx
│   ├── CloudDevicesPage.tsx
│   ├── CloudDevicesPage.test.tsx
│   ├── CloudUsersPage.tsx
│   ├── CloudUsersPage.test.tsx
│   ├── DashboardPage.tsx
│   ├── SystemHealthPage.tsx
│   └── SystemHealthPage.test.tsx
├── app/router.tsx                             # Replace scoped placeholder routes
└── styles/global.css                          # Compact filters, tables, drawers and statuses
e2e/
├── cloud-control.spec.ts                      # Six-role, search, revoke and approval flows
├── cloud-stub/main.go                         # E2E-build-only mTLS contract process
├── global-setup.ts                            # Cloud/user fixtures plus administrator fixtures
└── support.ts                                 # Safe API and fixture helpers
scripts/run-e2e.sh                             # E2E PKI, service identity and Cloud stub lifecycle
.env.example                                   # Cloud-disabled defaults and secure enabled fields
Makefile                                       # New package integration/race checks
README.md                                      # Exact Admin-only delivery status
```

## Shared Interfaces

The names and field shapes below are stable across every task in this plan.

```go
// internal/cloudadmin/client.go
package cloudadmin

type Client interface {
    Health(context.Context) (Health, error)
    ListUsers(context.Context, ListUsersRequest) (Page[User], error)
    LookupUser(context.Context, LookupRequest) (User, error)
    GetUser(context.Context, uuid.UUID) (User, error)
    ListUserDevices(context.Context, uuid.UUID, PageRequest) (Page[Device], error)
    ListUserSessions(context.Context, uuid.UUID, PageRequest) (Page[Session], error)
    RevokeDevice(context.Context, uuid.UUID, CommandMeta) (Operation, error)
    RevokeSession(context.Context, uuid.UUID, CommandMeta) (Operation, error)
    DisableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error)
    EnableUser(context.Context, uuid.UUID, CommandMeta) (Operation, error)
    GetOperation(context.Context, uuid.UUID) (Operation, error)
}

type CommandMeta struct {
    OperationID     uuid.UUID
    ActorAdminID    uuid.UUID
    ApprovalID      *uuid.UUID
    RequestID       string
    ReasonCode      string
    TicketReference string
    Note            string
    ExpectedRevision int64
}
```

```go
// internal/operations/model.go
package operations

type Action string

const (
    RevokeDevice Action = "revoke_device"
    RevokeSession Action = "revoke_session"
    DisableUser Action = "disable_user"
    EnableUser Action = "enable_user"
)

type State string

const (
    StateQueued State = "queued"
    StateExecuting State = "executing"
    StateReconciling State = "reconciling"
    StateSucceeded State = "succeeded"
    StateFailed State = "failed"
    StateConflict State = "conflict"
)

type EnqueueRequest struct {
    Actor          admin.Actor
    Action         Action
    TargetID       uuid.UUID
    ExpectedRevision int64
    Reason         admin.ActionReason
    BrowserIdempotencyKey string
    ApprovalID     *uuid.UUID
}

type Result struct {
    OperationID uuid.UUID `json:"operation_id"`
    State       State     `json:"state"`
    ErrorCode   string    `json:"error_code,omitempty"`
    UpdatedAt   time.Time `json:"updated_at"`
}
```

```go
// internal/approval/model.go
package approval

type Action string
const (
    DisableUser Action = "disable_user"
    EnableUser Action = "enable_user"
)

type Status string
const (
    PendingReview Status = "pending_review"
    Approved Status = "approved"
    Rejected Status = "rejected"
    Expired Status = "expired"
    Cancelled Status = "cancelled"
)

type ExecutionStatus string
const (
    NotStarted ExecutionStatus = "not_started"
    Queued ExecutionStatus = "queued"
    Executing ExecutionStatus = "executing"
    Reconciling ExecutionStatus = "reconciling"
    Succeeded ExecutionStatus = "succeeded"
    Failed ExecutionStatus = "failed"
    Conflict ExecutionStatus = "conflict"
)

type Request struct {
    ID                 uuid.UUID       `json:"id"`
    Action             Action          `json:"action"`
    TargetUserID       uuid.UUID       `json:"target_user_id"`
    TargetSnapshot     cloudadmin.User `json:"target_snapshot"`
    RequestedByAdminID uuid.UUID       `json:"requested_by_admin_id"`
    RequestedByRole    rbac.Role       `json:"requested_by_role"`
    ReviewedByAdminID  *uuid.UUID      `json:"reviewed_by_admin_id,omitempty"`
    ReasonCode         string          `json:"reason_code"`
    TicketReference    string          `json:"ticket_reference,omitempty"`
    Note               string          `json:"note,omitempty"`
    ExpectedRevision   int64           `json:"expected_revision"`
    Status             Status          `json:"approval_status"`
    ExecutionStatus    ExecutionStatus `json:"execution_status"`
    OperationID        *uuid.UUID      `json:"operation_id,omitempty"`
    ExpiresAt          time.Time       `json:"expires_at"`
    CreatedAt          time.Time       `json:"created_at"`
    UpdatedAt          time.Time       `json:"updated_at"`
    Version            int64           `json:"version"`
    Events             []Event         `json:"events,omitempty"`
}
```

```ts
// web/src/api/contracts.ts
export type CloudAvailability = 'not_configured' | 'available' | 'unavailable' | 'contract_error';
export type OperationState = 'queued' | 'executing' | 'reconciling' | 'succeeded' | 'failed' | 'conflict';
export type ApprovalStatus = 'pending_review' | 'approved' | 'rejected' | 'expired' | 'cancelled';
export type ApprovalExecutionStatus = 'not_started' | OperationState;
```

---
