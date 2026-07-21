# Aera Admin Security Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a locally runnable, production-shaped Aera Admin foundation with the approved React shell, independent administrator accounts, mandatory TOTP, fixed RBAC, administrator lifecycle controls, and append-only audit.

**Architecture:** A Go/Chi BFF serves a React/Vite single-page application from the same origin. PostgreSQL is authoritative for administrator identities, credentials, sessions, invitations, and audit; Redis is mandatory for live sessions, login challenges, rate limits, and step-up state. This subproject does not call Aera Cloud yet, but it establishes the authenticated interfaces that later Cloud management plans consume.

**Tech Stack:** Go 1.26.5, Chi v5, pgx v5, go-redis v9, PostgreSQL, Redis, React 19, TypeScript, Vite, Ant Design 5, TanStack Query, React Router, React Hook Form, Zod, Vitest, Testing Library, Playwright, pnpm 11.

## Global Constraints

- Product access is limited to company `super_admin`, `developer`, `operator`, `support`, `finance`, and `auditor` administrators.
- Ordinary Aera users, Workspace Owners, and Workspace Members must never authenticate here.
- Authentication is independent password plus mandatory TOTP; SSO is not part of this plan.
- Passwords use versioned Argon2id with a minimum of 12 and maximum of 128 Unicode code points.
- Session cookie is `__Host-aera_admin_session` with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`, with no `Domain`.
- Session idle lifetime is 30 minutes and absolute lifetime is 8 hours.
- A TOTP time step can be accepted only once per credential; high-risk operations require TOTP within the previous 10 minutes.
- Fixed RBAC permissions are code-owned; there are no editable custom roles.
- The system must preserve at least two active `super_admin` accounts before operational features can unlock.
- Responses use `Cache-Control: no-store`; HTML uses strict CSP, `frame-ancestors 'none'`, `nosniff`, `no-referrer`, and HSTS in production.
- Logs use allowlisted fields and must not include passwords, TOTP values, recovery codes, session tokens, CSRF tokens, encrypted identities, or raw administrator email addresses.
- `.superpowers/`, environment secrets, local databases, build outputs, and logs are never committed.
- Use TDD for every behavior and commit after every independently testable task.

---

## File Structure

```text
.
├── api/openapi/admin.yaml                 # Browser API contract
├── cmd/aera-admin/main.go                 # Production server composition
├── cmd/aera-admin-bootstrap/main.go       # First-two-super-admin invitation CLI
├── internal/admin/                        # Administrator lifecycle domain and HTTP adapter
├── internal/audit/                        # Append-only hash-chain events
├── internal/auth/                         # Login, TOTP, sessions, CSRF, step-up
├── internal/config/                       # Strict environment configuration
├── internal/httpapi/                      # Top-level router and security headers
├── internal/rbac/                         # Fixed roles and permissions
├── internal/secure/                       # Password, email sealing, tokens, TOTP
├── internal/store/                        # PostgreSQL/Redis construction and embedded migrations
├── internal/webui/                        # Embedded production frontend
├── web/                                   # React application source
├── compose.yaml                           # Local PostgreSQL/Redis
├── Dockerfile                             # Reproducible frontend + Go build
├── Makefile                               # Check, test, build, dev commands
├── go.mod
└── README.md
```

## Shared Interfaces

The following names are stable across all tasks in this plan:

```go
// internal/rbac/rbac.go
type Role string
type Permission string
func Allowed(role Role, permission Permission) bool

// internal/auth/model.go
type Principal struct {
    AdminID uuid.UUID
    Role rbac.Role
    SessionID uuid.UUID
    MFAAuthenticatedAt time.Time
}

// internal/audit/service.go
type Record struct {
    ActorAdminID uuid.UUID
    ActorRole rbac.Role
    EventType string
    ObjectType string
    ObjectID uuid.UUID
    Outcome string
    ReasonCode string
    TicketReference string
    Note string
    RequestID string
    OccurredAt time.Time
}
type Recorder interface { Append(context.Context, Record) (uuid.UUID, error) }

// internal/auth/session.go
type SessionManager interface {
    Create(context.Context, uuid.UUID, rbac.Role, time.Time) (rawToken string, csrfToken string, expiresAt time.Time, err error)
    Authenticate(context.Context, string, time.Time) (Principal, error)
    RevokeAll(context.Context, uuid.UUID, time.Time) error
}
```

### Task 1: Go Service Skeleton and Health Contract

**Files:**
- Create: `go.mod`
- Create: `cmd/aera-admin/main.go`
- Create: `internal/config/config.go`
- Create: `internal/config/config_test.go`
- Create: `internal/httpapi/server.go`
- Create: `internal/httpapi/server_test.go`
- Create: `internal/store/postgres.go`
- Create: `internal/store/redis.go`
- Create: `.env.example`

**Interfaces:**
- Produces: `config.Load(config.LookupEnv) (config.Config, error)`.
- Produces: `httpapi.New(httpapi.Dependencies) http.Handler` with `/health/live` and `/health/ready`.
- Produces: PostgreSQL and Redis values satisfying `Ping(context.Context) error`.

- [ ] **Step 1: Write strict configuration tests**

```go
func TestLoadRequiresEverySecuritySecret(t *testing.T) {
    values := validEnvironment()
    delete(values, "AERA_ADMIN_SESSION_HMAC_KEY")
    _, err := Load(mapLookup(values))
    if err == nil || !strings.Contains(err.Error(), "AERA_ADMIN_SESSION_HMAC_KEY") {
        t.Fatalf("Load() error = %v", err)
    }
}

func TestLoadRejectsNonHTTPSProductionURL(t *testing.T) {
    values := validEnvironment()
    values["AERA_ADMIN_ENVIRONMENT"] = "production"
    values["AERA_ADMIN_PUBLIC_URL"] = "http://admin.example.test"
    if _, err := Load(mapLookup(values)); err == nil {
        t.Fatal("Load() accepted non-HTTPS production URL")
    }
}
```

- [ ] **Step 2: Run configuration tests and verify failure**

Run: `go test ./internal/config -run TestLoad -v`

Expected: FAIL because `Load` does not exist.

- [ ] **Step 3: Implement strict configuration parsing**

```go
type Config struct {
    Environment string
    ListenAddr string
    PublicURL string
    DatabaseURL string
    RedisAddr string
    IdentityEncryptionKeys KeyRing
    IdentityLookupKeys KeyRing
    TOTPEncryptionKeys KeyRing
    SessionHMACKey []byte
    CSRFHMACKey []byte
}

func Load(lookup LookupEnv) (Config, error) {
    environment, err := required(lookup, "AERA_ADMIN_ENVIRONMENT")
    if err != nil { return Config{}, err }
    if environment != "development" && environment != "test" && environment != "production" {
        return Config{}, errors.New("AERA_ADMIN_ENVIRONMENT must be development, test, or production")
    }
    listenAddr, err := required(lookup, "AERA_ADMIN_LISTEN_ADDR")
    if err != nil { return Config{}, err }
    publicURL, err := parsePublicURL(lookup, environment)
    if err != nil { return Config{}, err }
    databaseURL, err := required(lookup, "AERA_ADMIN_DATABASE_URL")
    if err != nil { return Config{}, err }
    redisAddr, err := required(lookup, "AERA_ADMIN_REDIS_ADDR")
    if err != nil { return Config{}, err }
    identityEncryption, err := parseKeyRing(lookup, "AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS")
    if err != nil { return Config{}, err }
    identityLookup, err := parseKeyRing(lookup, "AERA_ADMIN_IDENTITY_LOOKUP_KEYS")
    if err != nil { return Config{}, err }
    totpEncryption, err := parseKeyRing(lookup, "AERA_ADMIN_TOTP_ENCRYPTION_KEYS")
    if err != nil { return Config{}, err }
    sessionKey, err := decodeRequiredKey(lookup, "AERA_ADMIN_SESSION_HMAC_KEY", 32)
    if err != nil { return Config{}, err }
    csrfKey, err := decodeRequiredKey(lookup, "AERA_ADMIN_CSRF_HMAC_KEY", 32)
    if err != nil { return Config{}, err }
    return Config{
        Environment: environment, ListenAddr: listenAddr, PublicURL: publicURL,
        DatabaseURL: databaseURL, RedisAddr: redisAddr,
        IdentityEncryptionKeys: identityEncryption, IdentityLookupKeys: identityLookup,
        TOTPEncryptionKeys: totpEncryption, SessionHMACKey: sessionKey, CSRFHMACKey: csrfKey,
    }, nil
}
```

`parseKeyRing` accepts a JSON object with `active_key_id` and base64-encoded `keys`, rejects missing active keys and keys shorter than 32 bytes, and returns copied byte slices. `parsePublicURL` requires an origin-only URL and HTTPS in production. Errors name only the environment variable, never its value.

- [ ] **Step 4: Write health endpoint tests**

```go
func TestReadinessFailsClosedWhenDependencyFails(t *testing.T) {
    handler := New(Dependencies{PostgreSQL: stubChecker{err: errors.New("down")}, Redis: stubChecker{}})
    request := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
    response := httptest.NewRecorder()
    handler.ServeHTTP(response, request)
    if response.Code != http.StatusServiceUnavailable || response.Body.String() != "{\"status\":\"unavailable\"}\n" {
        t.Fatalf("response = %d %q", response.Code, response.Body.String())
    }
}
```

- [ ] **Step 5: Implement the Chi router and server composition**

```go
type HealthChecker interface { Ping(context.Context) error }
type Dependencies struct { PostgreSQL HealthChecker; Redis HealthChecker; API http.Handler; Web http.Handler }

func New(deps Dependencies) http.Handler {
    router := chi.NewRouter()
    router.Get("/health/live", live)
    router.Get("/health/ready", ready(deps.PostgreSQL, deps.Redis))
    if deps.API != nil { router.Mount("/api/v1", deps.API) }
    router.NotFound(spaFallback(deps.Web))
    return securityHeaders(router)
}
```

- [ ] **Step 6: Verify backend foundation**

Run: `go test ./internal/config ./internal/httpapi ./internal/store`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add go.mod go.sum cmd/aera-admin internal/config internal/httpapi internal/store .env.example
git commit -m "feat: bootstrap Aera Admin service"
```

### Task 2: React/Soybean-Style Application Shell

**Files:**
- Create: `web/package.json`
- Create: `web/pnpm-lock.yaml`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/app/App.tsx`
- Create: `web/src/app/router.tsx`
- Create: `web/src/app/theme.ts`
- Create: `web/src/layout/AdminLayout.tsx`
- Create: `web/src/layout/AdminLayout.test.tsx`
- Create: `web/src/pages/DashboardPage.tsx`
- Create: `web/src/styles/global.css`
- Create: `internal/webui/handler.go`
- Create: `internal/webui/handler_test.go`
- Create: `internal/webui/assets.go`
- Create: `internal/webui/dist/.gitkeep`

**Interfaces:**
- Produces: `webui.New(fs.FS) http.Handler` for embedded SPA files.
- Produces: `AdminLayout` with approved navigation labels and desktop tab strip.

- [ ] **Step 1: Write a failing shell test**

```tsx
it('renders the approved phase-one navigation', () => {
  render(<MemoryRouter><AdminLayout /></MemoryRouter>);
  for (const label of ['工作台', '内部管理员', '角色与权限', '用户与访问', '设备与会话', '处置审批', '审计记录', '服务健康']) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
});
```

- [ ] **Step 2: Scaffold Vite and verify the test fails**

Run: `cd web && pnpm install && pnpm test --run src/layout/AdminLayout.test.tsx`

Expected: FAIL because `AdminLayout` is absent.

- [ ] **Step 3: Implement the shell and Aera theme**

```tsx
export const aeraTheme: ThemeConfig = {
  token: { colorPrimary: '#1677ff', colorBgLayout: '#f5f7fb', borderRadius: 6, fontSize: 14 },
  components: { Layout: { siderBg: '#0b1426', headerBg: '#ffffff' }, Table: { cellPaddingBlock: 10 } },
};

const navigation = [
  ['工作台', '/dashboard'], ['内部管理员', '/security/admins'], ['角色与权限', '/security/roles'],
  ['用户与访问', '/cloud/users'], ['设备与会话', '/cloud/devices'], ['处置审批', '/approvals'],
  ['审计记录', '/audit'], ['服务健康', '/system/health'],
] as const;

function Brand() { return <div className="brand">Aera Admin</div>; }
function PermissionNavigation() { return <Menu items={navigation.map(([label, key]) => ({ label, key }))} />; }
function BreadcrumbBar() { return <Breadcrumb items={[{ title: 'Aera' }, { title: '工作台' }]} />; }
function PageTabs() { return <div className="page-tabs" role="navigation">工作台</div>; }

export function AdminLayout() {
  return <Layout className="admin-shell">
    <Sider width={224}><Brand /><PermissionNavigation /></Sider>
    <Layout><Header><BreadcrumbBar /></Header><PageTabs /><Content><Outlet /></Content></Layout>
  </Layout>;
}
```

The navigation model must contain route and required permission, so later RBAC filtering does not duplicate labels in view code.

- [ ] **Step 4: Write and implement SPA fallback tests**

```go
func TestHandlerServesIndexForClientRouteButNotMissingAsset(t *testing.T) {
    handler := New(fstest.MapFS{"dist/index.html": {Data: []byte("shell")}})
    assertBody(t, handler, "/dashboard", http.StatusOK, "shell")
    assertBody(t, handler, "/assets/missing.js", http.StatusNotFound, "")
}
```

`handler.go` must set immutable caching only for hashed assets and `no-store` for `index.html`.

- [ ] **Step 5: Verify frontend and Go web handler**

Run: `cd web && pnpm test --run && pnpm build`

Expected: Vitest PASS and Vite emits `internal/webui/dist`.

Run: `go test ./internal/webui`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web internal/webui
git commit -m "feat: add Aera Admin application shell"
```

### Task 3: Security Schema and Migration Runner

**Files:**
- Create: `internal/store/migrations/000001_admin_security.sql`
- Create: `internal/store/migrate.go`
- Create: `internal/store/migrate_test.go`
- Create: `compose.yaml`
- Create: `Makefile`

**Interfaces:**
- Produces: `store.Migrate(context.Context, *pgxpool.Pool) error`.
- Produces tables `admin_users`, `admin_identities`, `admin_password_credentials`, `admin_totp_credentials`, `admin_recovery_codes`, `admin_sessions`, `admin_invitations`, `admin_audit_events`, `admin_audit_checkpoints`, and `reason_codes`.

- [ ] **Step 1: Write migration contract tests**

```go
func TestMigrateCreatesConstrainedSecuritySchema(t *testing.T) {
    db := testPostgres(t)
    if err := Migrate(context.Background(), db); err != nil { t.Fatal(err) }
    assertCheckConstraint(t, db, "admin_users", "admin_users_role_check")
    assertCheckConstraint(t, db, "admin_users", "admin_users_status_check")
    assertUniqueColumns(t, db, "admin_identities", []string{"lookup_key_id", "lookup_hmac"})
    assertColumnType(t, db, "admin_audit_events", "previous_hash", "bytea")
}
```

- [ ] **Step 2: Run the migration test and verify failure**

Run: `docker compose up -d postgres redis && go test ./internal/store -run TestMigrate -v`

Expected: FAIL because the migration runner and tables do not exist.

- [ ] **Step 3: Write the complete initial SQL migration**

The migration must use UUID primary keys, timestamptz timestamps, explicit checks for all enum-like values, token/hash length checks, and foreign keys. The central constraints are:

```sql
CREATE TABLE admin_users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited',
  security_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT admin_users_role_check CHECK (role IN ('super_admin','developer','operator','support','finance','auditor')),
  CONSTRAINT admin_users_status_check CHECK (status IN ('invited','active','suspended')),
  CONSTRAINT admin_users_security_version_check CHECK (security_version > 0)
);

CREATE TABLE admin_identities (
  admin_user_id UUID PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  encryption_key_id TEXT NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
  lookup_key_id TEXT NOT NULL,
  lookup_hmac BYTEA NOT NULL CHECK (octet_length(lookup_hmac) = 32),
  CONSTRAINT admin_identities_lookup_key UNIQUE (lookup_key_id, lookup_hmac)
);

CREATE TABLE admin_password_credentials (
  admin_user_id UUID PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  params_version INTEGER NOT NULL CHECK (params_version > 0),
  changed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE admin_totp_credentials (
  admin_user_id UUID PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  encryption_key_id TEXT NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 16),
  last_accepted_step BIGINT NOT NULL DEFAULT -1 CHECK (last_accepted_step >= -1),
  bound_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE admin_recovery_codes (
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  code_hmac BYTEA NOT NULL CHECK (octet_length(code_hmac) = 32),
  created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (admin_user_id, code_hmac)
);

CREATE TABLE admin_sessions (
  id UUID PRIMARY KEY,
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hmac BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hmac) = 32),
  csrf_hmac BYTEA NOT NULL CHECK (octet_length(csrf_hmac) = 32),
  security_version BIGINT NOT NULL CHECK (security_version > 0),
  role TEXT NOT NULL CHECK (role IN ('super_admin','developer','operator','support','finance','auditor')),
  mfa_authenticated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > created_at),
  CHECK (absolute_expires_at > idle_expires_at)
);
CREATE INDEX admin_sessions_live_user_idx ON admin_sessions(admin_user_id, absolute_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE admin_invitations (
  id UUID PRIMARY KEY,
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hmac BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hmac) = 32),
  created_by_admin_id UUID REFERENCES admin_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE TABLE admin_audit_events (
  id UUID PRIMARY KEY,
  actor_admin_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  actor_role TEXT,
  event_type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id UUID,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','denied')),
  reason_code TEXT,
  ticket_reference TEXT,
  note TEXT,
  request_id TEXT NOT NULL,
  source_ip_hmac BYTEA CHECK (source_ip_hmac IS NULL OR octet_length(source_ip_hmac) = 32),
  user_agent TEXT,
  previous_hash BYTEA NOT NULL CHECK (octet_length(previous_hash) = 32),
  event_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(event_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (actor_role IS NULL OR actor_role IN ('super_admin','developer','operator','support','finance','auditor'))
);
CREATE INDEX admin_audit_events_created_idx ON admin_audit_events(created_at DESC, id);

CREATE TABLE admin_audit_checkpoints (
  checkpoint_date DATE PRIMARY KEY,
  last_event_id UUID NOT NULL REFERENCES admin_audit_events(id) ON DELETE RESTRICT,
  event_hash BYTEA NOT NULL CHECK (octet_length(event_hash) = 32),
  signing_key_id TEXT NOT NULL,
  signature BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE reason_codes (
  code TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('administrator','session','device','account','security')),
  label TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
```

The migration seeds stable administrator reason codes and grants the runtime database role `SELECT, INSERT` only on `admin_audit_events`; update and delete are not granted.

- [ ] **Step 4: Implement ordered embedded migrations**

```go
//go:embed migrations/*.sql
var migrationFiles embed.FS

func Migrate(ctx context.Context, postgres *pgxpool.Pool) error {
    connection, err := postgres.Acquire(ctx)
    if err != nil { return fmt.Errorf("acquire migration connection: %w", err) }
    defer connection.Release()
    if _, err := connection.Exec(ctx, `
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL
        )
    `); err != nil { return fmt.Errorf("create migration ledger: %w", err) }
    if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock($1)`, int64(0x4145524141444d)); err != nil {
        return fmt.Errorf("lock migrations: %w", err)
    }
    defer func() { _, _ = connection.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, int64(0x4145524141444d)) }()
    entries, err := fs.Glob(migrationFiles, "migrations/*.sql")
    if err != nil { return fmt.Errorf("list migrations: %w", err) }
    sort.Strings(entries)
    for _, name := range entries {
        version := path.Base(name)
        var applied bool
        if err := connection.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, version).Scan(&applied); err != nil {
            return fmt.Errorf("read migration %s state: %w", version, err)
        }
        if applied { continue }
        body, err := migrationFiles.ReadFile(name)
        if err != nil { return fmt.Errorf("read migration %s: %w", name, err) }
        tx, err := connection.Begin(ctx)
        if err != nil { return fmt.Errorf("begin migration %s: %w", version, err) }
        if _, err := tx.Exec(ctx, string(body)); err != nil {
            _ = tx.Rollback(ctx)
            return fmt.Errorf("apply migration %s: %w", version, err)
        }
        if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES ($1,$2)`, version, time.Now().UTC()); err != nil {
            _ = tx.Rollback(ctx)
            return fmt.Errorf("record migration %s: %w", version, err)
        }
        if err := tx.Commit(ctx); err != nil { return fmt.Errorf("commit migration %s: %w", version, err) }
    }
    return nil
}
```

The SQL file is canonical and embedded directly from the package subtree. Tests run `Migrate` twice and require the second call to be a no-op.

- [ ] **Step 5: Verify migrations and local dependencies**

Run: `go test ./internal/store -run TestMigrate -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/store compose.yaml Makefile
git commit -m "feat: add administrator security schema"
```

### Task 4: Fixed RBAC and Authorization Middleware

**Files:**
- Create: `internal/rbac/rbac.go`
- Create: `internal/rbac/rbac_test.go`
- Create: `internal/auth/context.go`
- Create: `internal/auth/middleware.go`
- Create: `internal/auth/middleware_test.go`

**Interfaces:**
- Produces: role and permission constants.
- Produces: `auth.Require(permission rbac.Permission, next http.Handler) http.Handler`.
- Consumes: `auth.Principal` populated by session authentication.

- [ ] **Step 1: Encode the approved matrix as tests**

```go
func TestFixedMatrix(t *testing.T) {
    tests := []struct{ role Role; permission Permission; want bool }{
        {Support, RevokeCloudSession, true},
        {Support, InitiateAccountLifecycle, false},
        {Operator, InitiateAccountLifecycle, true},
        {Operator, ApproveAccountLifecycle, false},
        {SuperAdmin, ApproveAccountLifecycle, true},
        {Developer, ExactIdentityLookup, false},
        {Auditor, ReadFullAudit, true},
        {Auditor, RevokeCloudSession, false},
        {Finance, ReadCloudUsers, false},
    }
    for _, tt := range tests {
        if got := Allowed(tt.role, tt.permission); got != tt.want { t.Errorf("Allowed(%s,%s)=%v", tt.role, tt.permission, got) }
    }
}
```

- [ ] **Step 2: Verify failure, then implement explicit permission sets**

Run: `go test ./internal/rbac -run TestFixedMatrix -v`

Expected: FAIL before implementation.

```go
var permissions = map[Role]map[Permission]struct{}{
    SuperAdmin: set(ManageAdministrators, ReadCloudUsers, ExactIdentityLookup, ReadCloudDevices, RevokeCloudSession, RevokeCloudDevice, ApproveAccountLifecycle, ReadFullAudit, ReadServiceHealth),
    Developer: set(ReadTechnicalUserFields, ReadCloudDevices, ReadServiceHealth),
    Operator: set(ReadCloudUsers, ExactIdentityLookup, ReadCloudDevices, RevokeCloudSession, RevokeCloudDevice, InitiateAccountLifecycle, ReadOwnAudit, ReadServiceHealth),
    Support: set(ReadCloudUsers, ExactIdentityLookup, ReadCloudDevices, RevokeCloudSession, RevokeCloudDevice, ReadOwnAudit),
    Finance: set(),
    Auditor: set(ReadAdministrators, ReadFullAudit, ReadServiceHealth),
}
```

- [ ] **Step 3: Test API enforcement rather than menu hiding**

```go
func TestRequireRejectsAuthenticatedRoleWithoutPermission(t *testing.T) {
    request := withPrincipal(httptest.NewRequest(http.MethodPost, "/action", nil), Principal{Role: rbac.Auditor})
    response := httptest.NewRecorder()
    Require(rbac.RevokeCloudSession, okHandler).ServeHTTP(response, request)
    if response.Code != http.StatusForbidden { t.Fatalf("status=%d", response.Code) }
}
```

- [ ] **Step 4: Implement middleware and verify**

Run: `go test ./internal/rbac ./internal/auth -run 'TestFixedMatrix|TestRequire' -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/rbac internal/auth/context.go internal/auth/middleware.go internal/auth/middleware_test.go
git commit -m "feat: enforce fixed administrator RBAC"
```

### Task 5: Password, Identity, Token, and TOTP Primitives

**Files:**
- Create: `internal/secure/password.go`
- Create: `internal/secure/password_test.go`
- Create: `internal/secure/identity.go`
- Create: `internal/secure/identity_test.go`
- Create: `internal/secure/token.go`
- Create: `internal/secure/token_test.go`
- Create: `internal/secure/totp.go`
- Create: `internal/secure/totp_test.go`

**Interfaces:**
- Produces: `PasswordHasher.Hash` and `PasswordHasher.Verify` with versioned parameters.
- Produces: `IdentityCodec.SealEmail`, `IdentityCodec.LookupCandidates`, and `IdentityCodec.OpenEmail`.
- Produces: `NewOpaqueToken(bytes int) (raw string, digest [32]byte, error)`.
- Produces: `TOTP.Generate`, `TOTP.Validate` and provisioning URI generation.

- [ ] **Step 1: Write password behavior tests**

```go
func TestPasswordHasherUsesArgon2idAndRandomSalt(t *testing.T) {
    hasher := testHasher(t)
    first, version, err := hasher.Hash("correct horse battery staple")
    if err != nil || version != 1 || !strings.Contains(first, "argon2id") { t.Fatalf("hash=%q v=%d err=%v", first, version, err) }
    second, _, _ := hasher.Hash("correct horse battery staple")
    if first == second { t.Fatal("password hashes reused a salt") }
    ok, _, err := hasher.Verify("correct horse battery staple", first)
    if err != nil || !ok { t.Fatalf("Verify()=%v,%v", ok, err) }
}

func TestPasswordHasherRequiresTwelveRunes(t *testing.T) {
    if _, _, err := testHasher(t).Hash("short-pass"); err == nil { t.Fatal("short password accepted") }
}
```

- [ ] **Step 2: Implement versioned Argon2id**

Use parameters `m=65536 KiB`, `t=3`, `p=1`, 16-byte random salt, and 32-byte output for version 1. Encoded hashes use `$aera-admin$1$argon2id$v=19$...`; parsing must reject parameter substitution instead of trusting encoded costs.

- [ ] **Step 3: Test encrypted email plus HMAC lookup**

```go
func TestIdentityCodecNeverUsesPlaintextAsLookup(t *testing.T) {
    codec := testIdentityCodec(t)
    sealed, err := codec.SealEmail("Admin@Example.com")
    if err != nil { t.Fatal(err) }
    if bytes.Contains(sealed.Ciphertext, []byte("admin@example.com")) { t.Fatal("ciphertext leaked email") }
    candidates := codec.LookupCandidates("admin@example.com")
    if len(candidates) != 1 || len(candidates[0].HMAC) != sha256.Size { t.Fatalf("candidates=%+v", candidates) }
}
```

Normalize by trimming surrounding whitespace and lowercasing the complete admin email, then validate one `@`, total byte length at most 254, non-empty local/domain, valid UTF-8, and no control characters. Seal with AES-256-GCM and type-specific AAD; index with HMAC-SHA256 and versioned keys.

- [ ] **Step 4: Test RFC 6238 validation and replay guard**

```go
func TestTOTPRejectsAcceptedTimeStepReplay(t *testing.T) {
    service := TOTP{Period: 30 * time.Second, Digits: 6}
    secret := []byte("12345678901234567890")
    now := time.Unix(59, 0)
    code := service.Code(secret, now)
    step, ok := service.Validate(secret, code, now, -1)
    if !ok { t.Fatal("known code rejected") }
    if _, replayOK := service.Validate(secret, code, now, step); replayOK { t.Fatal("accepted time step replayed") }
}
```

Accept current step plus one adjacent step for clock skew, but reject every step less than or equal to the credential's `last_accepted_step`. Compare codes in constant time.

- [ ] **Step 5: Verify secure primitives**

Run: `go test ./internal/secure -v`

Expected: PASS, including malformed encoding and key-rotation cases.

- [ ] **Step 6: Commit**

```bash
git add internal/secure
git commit -m "feat: add administrator security primitives"
```

### Task 6: Append-Only Audit Hash Chain

**Files:**
- Create: `internal/audit/model.go`
- Create: `internal/audit/repository.go`
- Create: `internal/audit/repository_test.go`
- Create: `internal/audit/service.go`
- Create: `internal/audit/service_test.go`

**Interfaces:**
- Produces: the shared `audit.Recorder` interface.
- Produces: `audit.Service.Append(context.Context, audit.Record) (uuid.UUID, error)`.
- Produces: `audit.Service.Verify(context.Context) error` for tests and scheduled verification.

- [ ] **Step 1: Write hash-chain and redaction tests**

```go
func TestAppendChainsCanonicalEventsWithoutSensitiveFields(t *testing.T) {
    service := newAuditFixture(t)
    first, err := service.Append(ctx, validRecord("admin_login"))
    if err != nil { t.Fatal(err) }
    second, err := service.Append(ctx, validRecord("admin_role_changed"))
    if err != nil { t.Fatal(err) }
    assertPreviousHashMatches(t, first, second)
    if err := service.Verify(ctx); err != nil { t.Fatal(err) }
}

func TestAppendRejectsSensitiveReasonText(t *testing.T) {
    record := validRecord("admin_suspended")
    record.Note = "contact admin@example.com"
    if _, err := service.Append(ctx, record); !errors.Is(err, ErrSensitiveText) { t.Fatalf("err=%v", err) }
}
```

- [ ] **Step 2: Implement canonical encoding and transaction lock**

Canonical bytes contain a schema version and length-prefixed allowlisted fields in a fixed order. `Append` starts a transaction, takes `pg_advisory_xact_lock` for the audit chain, reads the last event hash, computes SHA-256 over `previous_hash || canonical_event`, inserts once, and commits. There is no update or delete repository method.

- [ ] **Step 3: Verify audit**

Run: `go test ./internal/audit -v`

Expected: PASS, including concurrent append, tamper detection, and sensitive-text rejection.

- [ ] **Step 4: Commit**

```bash
git add internal/audit
git commit -m "feat: add tamper-evident administrator audit"
```

### Task 7: Bootstrap Invitations and Activation

**Files:**
- Create: `internal/admin/model.go`
- Create: `internal/admin/repository.go`
- Create: `internal/admin/repository_test.go`
- Create: `internal/admin/service.go`
- Create: `internal/admin/service_test.go`
- Create: `internal/admin/http.go`
- Create: `internal/admin/http_test.go`
- Create: `cmd/aera-admin-bootstrap/main.go`

**Interfaces:**
- Produces: `admin.Service.Invite`, `admin.Service.Activate`, `admin.Service.List`, `admin.Service.ChangeRole`, `admin.Service.Suspend`, and `admin.Service.ResetTOTP`.
- Consumes: secure identity/password/TOTP/token primitives and `audit.Recorder`.

- [ ] **Step 1: Write lifecycle invariant tests**

```go
func TestCannotReduceActiveSuperAdminsBelowTwo(t *testing.T) {
    service := fixtureWithTwoActiveSuperAdmins(t)
    err := service.ChangeRole(ctx, actorSuperAdmin, secondSuperAdminID, rbac.Operator, "staff_change")
    if !errors.Is(err, ErrMinimumSuperAdmins) { t.Fatalf("err=%v", err) }
}

func TestActivationConsumesInvitationAndRequiresTOTP(t *testing.T) {
    invitation, rawToken := fixtureInvitation(t)
    result, err := service.Activate(ctx, ActivateRequest{Token: rawToken, Password: "correct horse battery staple", TOTPCode: currentCode(invitation)})
    if err != nil || len(result.RecoveryCodes) != 8 { t.Fatalf("result=%+v err=%v", result, err) }
    if _, err := service.Activate(ctx, sameRequest); !errors.Is(err, ErrInvalidInvitation) { t.Fatalf("replay err=%v", err) }
}
```

- [ ] **Step 2: Implement transactional invitation and activation**

`Invite` seals the administrator email, stores lookup HMAC and a 24-hour invitation-token digest, and emits audit without raw email. `Activate` locks the invitation and user, validates password and TOTP, stores credentials and eight recovery-code digests, changes status to active, consumes the invitation, and audits in one PostgreSQL transaction.

- [ ] **Step 3: Implement bootstrap CLI guardrails**

```text
aera-admin-bootstrap invite-super-admin --email <value> --display-name <value>
```

The command is allowed only while fewer than two active super admins exist, prints the one-time activation URL once to stdout, never logs it, and rejects use after bootstrap completion.

- [ ] **Step 4: Implement JSON HTTP adapter**

```text
POST /api/v1/admin-users/invitations
POST /api/v1/auth/activate
GET  /api/v1/admin-users
PUT  /api/v1/admin-users/{id}/role
POST /api/v1/admin-users/{id}/suspend
POST /api/v1/admin-users/{id}/totp/reset
```

All management endpoints require `ManageAdministrators`; activation is token-authenticated and rate limited. Responses never include the raw administrator email; invitation creation returns the one-time activation URL only to the initiating super admin.

- [ ] **Step 5: Verify lifecycle and CLI**

Run: `go test ./internal/admin ./cmd/aera-admin-bootstrap -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/admin cmd/aera-admin-bootstrap
git commit -m "feat: add administrator invitation lifecycle"
```

### Task 8: Login, TOTP Challenge, Sessions, CSRF, and Step-Up

**Files:**
- Create: `internal/auth/model.go`
- Create: `internal/auth/repository.go`
- Create: `internal/auth/repository_test.go`
- Create: `internal/auth/session.go`
- Create: `internal/auth/session_test.go`
- Create: `internal/auth/service.go`
- Create: `internal/auth/service_test.go`
- Create: `internal/auth/http.go`
- Create: `internal/auth/http_test.go`
- Modify: `cmd/aera-admin/main.go`
- Modify: `internal/httpapi/server.go`

**Interfaces:**
- Produces the shared `SessionManager` and `Principal`.
- Produces browser endpoints `/auth/login`, `/auth/totp/verify`, `/auth/step-up`, `/auth/logout`, and `/me` below `/api/v1`.

- [ ] **Step 1: Test that password success alone cannot create a session**

```go
func TestLoginRequiresTOTPBeforeSession(t *testing.T) {
    challenge, err := service.BeginLogin(ctx, "admin@example.com", "correct horse battery staple", requestMeta)
    if err != nil || challenge.ID == uuid.Nil { t.Fatalf("challenge=%+v err=%v", challenge, err) }
    if sessionStore.createCalls != 0 { t.Fatal("session created before MFA") }
    result, err := service.CompleteLogin(ctx, challenge.ID, currentTOTP, requestMeta)
    if err != nil || result.RawSessionToken == "" { t.Fatalf("result=%+v err=%v", result, err) }
}
```

- [ ] **Step 2: Test generic errors and rate limits**

Unknown email, wrong password, wrong TOTP, expired challenge, replayed TOTP, and suspended account must return the same public `AUTH_INVALID_CREDENTIALS` where revealing the distinction would enumerate an account. Rate-limit responses use `RATE_LIMITED` and a bounded `Retry-After`.

- [ ] **Step 3: Implement PostgreSQL-authoritative and Redis-live sessions**

Creation writes a hashed session row and Redis live-session record; failure to write Redis revokes the PostgreSQL row and returns unavailable. Authentication requires Redis, verifies the token HMAC in constant time, checks idle/absolute expiry and security version, and updates last-seen with bounded write frequency. There is no PostgreSQL fallback while Redis is unavailable.

- [ ] **Step 4: Test CSRF, Origin, cookie, and logout**

```go
func TestLoginCookieUsesHostSecurityAttributes(t *testing.T) {
    response := completeHTTPLogin(t)
    cookie := response.Result().Cookies()[0]
    if cookie.Name != "__Host-aera_admin_session" || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.Domain != "" {
        t.Fatalf("cookie=%+v", cookie)
    }
}

func TestMutationRequiresMatchingOriginAndCSRF(t *testing.T) {
    response := callMutation(t, "https://evil.example", "wrong")
    if response.Code != http.StatusForbidden { t.Fatalf("status=%d", response.Code) }
}
```

- [ ] **Step 5: Implement step-up and recovery-code use**

Step-up validates a fresh, non-replayed TOTP and updates only `mfa_authenticated_at`. A recovery code can complete login once, is atomically consumed, revokes all older sessions, and emits a high-severity audit event.

- [ ] **Step 6: Verify complete auth flow**

Run: `go test ./internal/auth ./internal/admin ./internal/httpapi -v`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/auth internal/httpapi cmd/aera-admin/main.go
git commit -m "feat: add mandatory TOTP administrator sessions"
```

### Task 9: Login, Activation, Administrator, and Role UI

**Files:**
- Create: `web/src/api/client.ts`
- Create: `web/src/api/contracts.ts`
- Create: `web/src/auth/AuthProvider.tsx`
- Create: `web/src/auth/PermissionGate.tsx`
- Create: `web/src/pages/LoginPage.tsx`
- Create: `web/src/pages/LoginPage.test.tsx`
- Create: `web/src/pages/ActivatePage.tsx`
- Create: `web/src/pages/AdministratorsPage.tsx`
- Create: `web/src/pages/AdministratorsPage.test.tsx`
- Create: `web/src/pages/RolesPage.tsx`
- Modify: `web/src/app/router.tsx`
- Modify: `web/src/layout/AdminLayout.tsx`
- Create: `api/openapi/admin.yaml`

**Interfaces:**
- Consumes the Admin Browser API from Tasks 7-8.
- Produces a permission-filtered navigation and route guards based on `/api/v1/me`.

- [ ] **Step 1: Write login behavior tests**

```tsx
it('does not persist credentials and advances to TOTP', async () => {
  server.use(http.post('/api/v1/auth/login', () => HttpResponse.json({ challenge_id: 'challenge-1' })));
  render(<LoginPage />);
  await user.type(screen.getByLabelText('内部邮箱'), 'admin@example.com');
  await user.type(screen.getByLabelText('密码'), 'correct horse battery staple');
  await user.click(screen.getByRole('button', { name: '继续' }));
  expect(await screen.findByLabelText('动态验证码')).toBeVisible();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
```

- [ ] **Step 2: Implement typed no-store API client**

```ts
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...csrfHeader(), ...init.headers },
  });
  if (!response.ok) throw await toAPIError(response);
  return response.json() as Promise<T>;
}
```

The client must not log request bodies and must clear password/TOTP fields after every attempt.

- [ ] **Step 3: Implement login and activation views**

Login is a two-step password/TOTP card matching the approved RuoYi/Soybean density. Activation shows the provisioning QR, requires one successful TOTP, then displays recovery codes exactly once with a confirmation that the operator stored them.

- [ ] **Step 4: Test and implement role-filtered Admin shell**

```tsx
it('does not render administrator management for support', () => {
  renderWithPrincipal(<AdminLayout />, { role: 'support', permissions: ['cloud_user.read'] });
  expect(screen.queryByText('内部管理员')).not.toBeInTheDocument();
});
```

Route loaders must also reject navigation; backend `403` remains authoritative.

- [ ] **Step 5: Implement Administrators and Roles pages**

The administrator table contains masked internal identity, display name, role, status, MFA state, last login, and actions. Role assignment uses the six fixed roles. The Roles page is read-only and reproduces the approved matrix.

- [ ] **Step 6: Write OpenAPI and verify UI**

Run: `cd web && pnpm lint && pnpm test --run && pnpm build`

Expected: PASS.

Run: `go test ./...`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web api/openapi/admin.yaml internal/webui/assets.go internal/webui/dist/.gitkeep
git commit -m "feat: add administrator security console"
```

Generated files under `internal/webui/dist` remain ignored except `.gitkeep`; Docker and release builds run Vite before `go build`, so the embedded assets are reproducible and not committed.

### Task 10: End-to-End Security Acceptance and Packaging

**Files:**
- Create: `e2e/auth.spec.ts`
- Create: `e2e/rbac.spec.ts`
- Create: `playwright.config.ts`
- Create: `Dockerfile`
- Create: `README.md`
- Modify: `Makefile`
- Modify: `.gitignore`
- Modify: `cmd/aera-admin/main.go`

**Interfaces:**
- Produces: `make check`, `make test`, `make build`, and `make e2e` as release gates.
- Produces: a multi-stage container image with no source tree, package manager cache, or secrets.

- [ ] **Step 1: Write end-to-end authentication and RBAC tests**

```ts
test('support cannot call administrator management directly', async ({ request }) => {
  const support = await loginAs(request, 'support');
  const response = await support.get('/api/v1/admin-users');
  expect(response.status()).toBe(403);
});

test('password-only login never receives a session cookie', async ({ request }) => {
  const response = await request.post('/api/v1/auth/login', { data: passwordCredentials });
  expect(response.status()).toBe(200);
  expect(response.headers()['set-cookie']).toBeUndefined();
});
```

- [ ] **Step 2: Add security-header and leakage assertions**

The suite inspects browser URLs, storage, network bodies returned by the server, captured structured logs, and audit rows for seeded password, TOTP, recovery-code, session-token, CSRF-token, and raw-email canaries. Every canary must be absent outside its permitted inbound request field.

- [ ] **Step 3: Create reproducible multi-stage image**

```dockerfile
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.26.5-alpine AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -o /out/aera-admin ./cmd/aera-admin

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=go /out/aera-admin /aera-admin
USER nonroot:nonroot
ENTRYPOINT ["/aera-admin"]
```

- [ ] **Step 4: Run the complete gate**

Run: `make check`

Expected: formatting, Go vet, TypeScript lint, unit, integration, build, migration equality, and OpenAPI checks all PASS.

Run: `make e2e`

Expected: Playwright authentication, session, RBAC, security-header, and leakage tests all PASS.

Run: `docker build -t aera-admin:security-foundation .`

Expected: image builds and `docker history` contains no secret values.

- [ ] **Step 5: Commit**

```bash
git add e2e playwright.config.ts Dockerfile README.md Makefile .gitignore cmd/aera-admin/main.go
git commit -m "test: close Aera Admin security foundation"
```

## Completion Gate

This plan is complete only when:

1. Tasks 1-10 are checked and committed independently.
2. `make check`, `make e2e`, and the container build pass from a clean checkout.
3. Two bootstrap super admins can activate with mandatory TOTP.
4. Password-only authentication cannot create a session.
5. Direct unauthorized API calls return `403` for every fixed role.
6. Session, CSRF, Origin, idle timeout, absolute timeout, security-version revocation, TOTP replay, and step-up tests pass.
7. Audit rows form a valid hash chain and contain no seeded sensitive canaries.
8. No Cloud, billing, Workspace, Hermes, or ordinary-user management code is introduced by this subproject.
9. The branch remains local; it is not pushed until the full approved Aera Admin delivery has completed its final acceptance gate.
