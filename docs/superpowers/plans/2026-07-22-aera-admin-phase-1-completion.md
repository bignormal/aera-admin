# Aera Admin Phase 1 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the audit placeholder and add controlled system security settings so Aera Admin Phase 1 is functionally complete.

**Architecture:** Extend the existing append-only audit domain with a permission-scoped cursor query path, and add a focused `internal/settings` domain for the singleton security policy, reason catalog, optimistic revisions, and Admin-local idempotency. Authentication consumes settings through narrow interfaces; the React app continues to use the same-origin Admin BFF and existing step-up flow.

**Tech Stack:** Go 1.26, PostgreSQL 18, Redis 8, chi/net-http, React 19, TypeScript, Ant Design, TanStack Query, Vitest, Playwright, OpenAPI 3.1, Docker.

## Global Constraints

- Start from `aera-admin/main@2fff6674b5208483446ce9333154ec4131183923` on branch `aera/admin-phase1-completion`.
- Work only in `/Users/zizimutou/Desktop/aera/aera-admin`; `aera-cloud/main` is a read-only real E2E dependency.
- Do not add Official Managed Agent, desktop, Workspace, Hermes, payment, website, or Cloud-contract scope.
- Preserve six fixed roles, append-only audit storage, mTLS/service-JWT Cloud authentication, two-person account lifecycle approval, and masked identity boundaries.
- Never log or return email, phone, raw IP, passwords, TOTP, recovery codes, tokens, cookies, search inputs, encryption material, or idempotency keys.
- Every production behavior follows RED → GREEN → REFACTOR; do not write implementation before observing the targeted test fail for the expected reason.
- System settings mutations are `super_admin` only and require recent TOTP step-up, CSRF/Origin, `Idempotency-Key`, optimistic revision, standard reason, and immutable audit.
- Session-policy changes revoke all administrator sessions; retention-only changes do not.
- Audit retention is a configurable compliance minimum; the Admin runtime and browser provide no audit deletion path.

---

### Task 1: Add the Phase 1 completion schema and fixed permissions

**Files:**
- Create: `internal/store/migrations/000006_phase1_completion.sql`
- Modify: `internal/store/migrate_test.go`
- Modify: `internal/rbac/rbac.go`
- Modify: `internal/rbac/rbac_test.go`

**Interfaces:**
- Produces: `admin_security_settings`, `admin_settings_idempotency`, reason-code revisions and protected seed rows.
- Produces: `rbac.ReadSystemSettings` and `rbac.ManageSystemSettings`.

- [ ] **Step 1: Write failing migration assertions**

Add integration assertions that the singleton is seeded with `(30, 8, 730, 1)`, both protected security reasons exist and are active, `reason_codes.revision` is positive, code/category updates are rejected by PostgreSQL, and `admin_settings_idempotency` rejects duplicate actor/action/key HMAC tuples.

```go
var idleMinutes, absoluteHours, retentionDays int
var revision int64
err := postgres.QueryRow(ctx, `
  SELECT session_idle_minutes, session_absolute_hours, audit_retention_days, revision
  FROM admin_security_settings WHERE settings_key = 'global'
`).Scan(&idleMinutes, &absoluteHours, &retentionDays, &revision)
if err != nil || idleMinutes != 30 || absoluteHours != 8 || retentionDays != 730 || revision != 1 {
    t.Fatalf("seeded security policy = %d/%d/%d r%d, err=%v", idleMinutes, absoluteHours, retentionDays, revision, err)
}
```

- [ ] **Step 2: Run the migration test and verify RED**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/store -run TestMigrate -count=1
```

Expected: FAIL because `admin_security_settings` does not exist.

- [ ] **Step 3: Write failing fixed-RBAC assertions**

```go
if !Allowed(SuperAdmin, ReadSystemSettings) || !Allowed(SuperAdmin, ManageSystemSettings) {
    t.Fatal("super administrator settings permissions missing")
}
if !Allowed(Auditor, ReadSystemSettings) || Allowed(Auditor, ManageSystemSettings) {
    t.Fatal("auditor settings permissions invalid")
}
for _, role := range []Role{Developer, Operator, Support, Finance} {
    if Allowed(role, ReadSystemSettings) || Allowed(role, ManageSystemSettings) {
        t.Fatalf("%s unexpectedly has settings permission", role)
    }
}
```

- [ ] **Step 4: Run the RBAC test and verify RED**

Run: `go test ./internal/rbac -count=1`

Expected: compilation failure because the permissions do not exist.

- [ ] **Step 5: Add the constrained migration and RBAC constants**

The migration must create the singleton and idempotency tables, add a positive reason revision, seed protected reasons, constrain settings bounds, constrain supported mutation actions, store only HMAC/digest values, add a trigger that rejects reason code/category changes, and add created/event/outcome/reason audit query indexes.

```go
const (
    ReadSystemSettings   Permission = "system_settings.read"
    ManageSystemSettings Permission = "system_settings.manage"
)
```

Assign both to `SuperAdmin`, only read to `Auditor`, and neither to the other roles.

- [ ] **Step 6: Run schema and RBAC tests and verify GREEN**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/store ./internal/rbac -count=1
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/store/migrations/000006_phase1_completion.sql internal/store/migrate_test.go internal/rbac/rbac.go internal/rbac/rbac_test.go
git commit -m "feat: add phase one settings schema"
```

### Task 2: Implement permission-scoped audit cursor queries

**Files:**
- Create: `internal/audit/query.go`
- Create: `internal/audit/query_test.go`
- Modify: `internal/audit/repository.go`
- Modify: `internal/audit/repository_test.go`
- Modify: `internal/audit/model.go`

**Interfaces:**
- Produces: `audit.Query`, `audit.Page`, `audit.PublicEvent`, and `(*audit.Service).List(context.Context, Query) (Page, error)`.
- Consumes: existing `audit.Service`, hash-chain storage, and `rbac` permissions.

- [ ] **Step 1: Write failing cursor and validation tests**

Define the wished-for API in tests:

```go
query := Query{Limit: 20, Outcome: OutcomeSuccess, From: now.Add(-time.Hour), To: now}
if err := query.Validate(); err != nil { t.Fatalf("Validate() error = %v", err) }
cursor := EncodeCursor(now, uuid.MustParse("019f0000-0000-7000-8000-000000000001"))
decodedAt, decodedID, err := DecodeCursor(cursor)
if err != nil || !decodedAt.Equal(now.UTC().Truncate(time.Microsecond)) || decodedID == uuid.Nil {
    t.Fatalf("cursor round trip failed: %v", err)
}
```

Cover malformed base64, trailing JSON, nil UUID, invalid limit, invalid enum, `from >= to`, and event/object name patterns.

- [ ] **Step 2: Run query tests and verify RED**

Run: `go test ./internal/audit -run 'Test(Query|Cursor)' -count=1`

Expected: compilation failure because query types are absent.

- [ ] **Step 3: Implement minimal query models and opaque cursor codec**

```go
type Query struct {
    Cursor string
    Limit int
    ActorAdminID *uuid.UUID
    EventType string
    ObjectType string
    ObjectID *uuid.UUID
    Outcome Outcome
    ReasonCode string
    From time.Time
    To time.Time
}

type Page struct {
    Items []PublicEvent `json:"items"`
    NextCursor *string `json:"next_cursor"`
}
```

Use base64url-encoded fixed JSON containing only microsecond UTC time and UUID. Decode strictly with one JSON object and EOF.

- [ ] **Step 4: Write failing PostgreSQL query tests**

Seed multiple events for two administrators at equal and different timestamps. Assert descending `(created_at, id)`, non-overlapping cursor pages, actor/outcome/time filters, and that `PublicEvent` has no source-IP, User-Agent, or hash fields.

- [ ] **Step 5: Run repository query tests and verify RED**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/audit -run TestList -count=1
```

Expected: FAIL because the repository query is missing.

- [ ] **Step 6: Implement parameterized stable query and service method**

Build fixed SQL predicates with positional parameters; never interpolate filter values. Fetch `limit + 1`, trim the sentinel row, and create the next cursor from the final returned item. Convert only allowlisted state maps into `PublicEvent`.

- [ ] **Step 7: Extend safe audit-state keys**

Add only the keys required by approved settings and query audit events:

```go
"audit_retention_days": {}, "filter_actor": {}, "filter_event": {},
"filter_object": {}, "filter_outcome": {}, "filter_reason": {},
"filter_time": {}, "label_changed": {}, "result_count": {},
"revision": {}, "session_absolute_hours": {}, "session_idle_minutes": {},
"category": {},
```

Keep label text, query values, IP material, and free-form filters out of state.

- [ ] **Step 8: Run audit package tests and verify GREEN**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/audit -count=1
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add internal/audit
git commit -m "feat: add scoped audit event queries"
```

### Task 3: Expose the audit API and server-enforced data range

**Files:**
- Create: `internal/audithttp/http.go`
- Create: `internal/audithttp/http_test.go`
- Modify: `cmd/aera-admin/main.go`
- Modify: `cmd/aera-admin/main_test.go`
- Modify: `api/openapi/admin.yaml`
- Modify: `api/openapi_test.go`

**Interfaces:**
- Produces: `GET /api/v1/audit-events`.
- Consumes: `auth.PrincipalFromContext`, `auth.RequestMetaFromContext`, `rbac.ReadFullAudit`, `rbac.ReadOwnAudit`, `audit.Service.List` and `audit.Service.Append`. The adapter is a separate package because `auth` already imports `audit`; this preserves an acyclic dependency graph.

- [ ] **Step 1: Write failing HTTP scope tests**

Use a fake query service that captures the effective query. Test:

```go
request := httptest.NewRequest(http.MethodGet, "/audit-events?actor_admin_id="+otherID.String(), nil)
request = auth.WithPrincipal(request, auth.Principal{AdminID: ownID.String(), Role: rbac.Operator})
handler.ServeHTTP(response, request)
if captured.ActorAdminID == nil || *captured.ActorAdminID != ownID {
    t.Fatalf("own-audit scope = %v", captured.ActorAdminID)
}
```

Cover full readers, own readers, all unauthorized roles, malformed cursor, invalid time, `Cache-Control: no-store`, and absence of sensitive response field names.

- [ ] **Step 2: Run HTTP tests and verify RED**

Run: `go test ./internal/audithttp -run TestHTTP -count=1`

Expected: compilation failure because the handler is absent.

- [ ] **Step 3: Implement handler parsing, RBAC scope, and query audit**

The handler determines permission using the principal, parses only approved query keys, calls `List`, then appends `audit_events_viewed` using request metadata. If the query-audit append fails, return `503 AUDIT_UNAVAILABLE` instead of exposing an untracked sensitive read.

- [ ] **Step 4: Add OpenAPI path and safe schemas**

Document every filter, cursor, `items`, nullable `next_cursor`, safe state maps, `400`, `401`, `403`, and `503`. Do not include source-IP HMAC, User-Agent, previous hash, or event hash in public schemas.

- [ ] **Step 5: Wire the handler into the runtime**

```go
auditHandler := audithttp.NewHandler(auditService)
router.Handle("/audit-events", auditHandler)
```

The handler itself enforces the any-of audit permission because the current generic middleware accepts one permission at a time.

- [ ] **Step 6: Run focused contract and runtime tests and verify GREEN**

Run:

```bash
go test ./internal/audit ./internal/audithttp ./cmd/aera-admin ./api -count=1
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/audithttp cmd/aera-admin api docs/superpowers/plans/2026-07-22-aera-admin-phase-1-completion.md
git commit -m "feat: expose administrator audit queries"
```

### Task 4: Build the `/audit` page

**Files:**
- Create: `web/src/pages/AuditPage.tsx`
- Create: `web/src/pages/AuditPage.test.tsx`
- Modify: `web/src/api/contracts.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/app/router.tsx`
- Modify: `web/src/app/router.test.tsx`

**Interfaces:**
- Consumes: `GET /audit-events`.
- Produces: audited filter/table/cursor/detail UI at `/audit`.

- [ ] **Step 1: Write failing component tests**

Mock the API boundary, not internal Ant components. Assert the page renders safe columns, submits filters, follows `next_cursor`, opens a detail drawer, labels own scope, and never renders `source_ip_hmac`, `user_agent`, `event_hash`, or a supplied identity canary.

```tsx
expect(await screen.findByText('admin_login_succeeded')).toBeInTheDocument();
expect(screen.queryByText('source_ip_hmac')).not.toBeInTheDocument();
await user.click(screen.getByRole('button', { name: '查看详情' }));
expect(screen.getByRole('dialog', { name: '审计详情' })).toBeInTheDocument();
```

- [ ] **Step 2: Run the page test and verify RED**

Run: `pnpm --filter @aera/admin-web test --run src/pages/AuditPage.test.tsx`

Expected: FAIL because `AuditPage` is absent.

- [ ] **Step 3: Add typed contracts and client method**

```ts
export interface AuditEventPage {
  items: AuditEvent[];
  next_cursor: string | null;
}

export function listAuditEvents(query: URLSearchParams): Promise<AuditEventPage> {
  return request<AuditEventPage>(`/audit-events?${query.toString()}`);
}
```

Use URL state only for internal IDs, enum values, and RFC3339 timestamps.

- [ ] **Step 4: Implement the page and route**

Use Ant `Form`, `Table`, `Tag`, `Drawer`, `DatePicker`, and explicit loading/empty/error states. Store a cursor history stack in component memory for previous navigation. Replace `ModulePlaceholderPage` in the audit route.

- [ ] **Step 5: Run page and route tests and verify GREEN**

Run:

```bash
pnpm --filter @aera/admin-web test --run src/pages/AuditPage.test.tsx src/app/router.test.tsx
pnpm --filter @aera/admin-web typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: add audit records console"
```

### Task 5: Implement security policy and reason catalog services

**Files:**
- Create: `internal/settings/model.go`
- Create: `internal/settings/model_test.go`
- Create: `internal/settings/repository.go`
- Create: `internal/settings/repository_test.go`
- Create: `internal/settings/service.go`
- Create: `internal/settings/service_test.go`

**Interfaces:**
- Produces: `settings.Policy`, `settings.ReasonCode`, `settings.ReasonUsage`, `settings.Page`, `settings.Service`.
- Produces: `SessionLifetimes(context.Context) (time.Duration, time.Duration, error)` for auth.
- Produces: `ValidateReason(context.Context, ReasonUsage, string) error` for mutation services.
- Consumes: PostgreSQL, audit transactional recorder, operation HMAC key, clock, and a live-session invalidator callback.

- [ ] **Step 1: Write failing model tests**

Cover policy bounds, absolute greater than idle, reason-code pattern/category/label validation, explicit usage compatibility, protected codes, and canonical idempotency request hashing.

```go
if !CompatibleReason(UsageAccount, CategorySecurity) { t.Fatal("security reason must be valid for account actions") }
if CompatibleReason(UsageSettings, CategoryAccount) { t.Fatal("account reason must not authorize settings") }
```

- [ ] **Step 2: Run model tests and verify RED**

Run: `go test ./internal/settings -run Test -count=1`

Expected: package or symbol compilation failure.

- [ ] **Step 3: Implement minimal models and validation**

```go
type Policy struct {
    SessionIdleMinutes int `json:"session_idle_minutes"`
    SessionAbsoluteHours int `json:"session_absolute_hours"`
    AuditRetentionDays int `json:"audit_retention_days"`
    Revision int64 `json:"revision"`
    UpdatedByAdminID *uuid.UUID `json:"updated_by_admin_id"`
    UpdatedAt time.Time `json:"updated_at"`
}
```

Keep free-text validation aligned with existing audit-sensitive text detection.

- [ ] **Step 4: Write failing integration tests for reads and mutations**

Test policy reads, same-request idempotent replay, different-request key conflict, policy revision conflict, conditional all-session revocation, retention-only no-revocation, create reason, update label/active, reason revision conflict, protected deactivation, last-active category guard, and rollback when audit append fails.

- [ ] **Step 5: Run settings integration tests and verify RED**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/settings -count=1
```

Expected: FAIL because repository/service behavior is missing.

- [ ] **Step 6: Implement transactional repository and service**

Use `SELECT ... FOR UPDATE` for policy and reason revisions. Reserve idempotency within the same transaction, compare canonical request hashes in constant time, update data, revoke database sessions when required, append audit with `AppendTx`, store the safe replay result, and commit. After commit, call the cache invalidator with returned token HMACs; cache cleanup failure is logged without undoing authoritative database revocation.

- [ ] **Step 7: Run settings tests and verify GREEN**

Run:

```bash
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' go test ./internal/settings -count=1
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add internal/settings
git commit -m "feat: add administrator security settings domain"
```

### Task 6: Make authentication and business reasons policy-backed

**Files:**
- Modify: `internal/auth/session.go`
- Modify: `internal/auth/service.go`
- Modify: `internal/auth/service_test.go`
- Modify: `internal/auth/repository.go`
- Modify: `internal/admin/service.go`
- Modify: `internal/admin/service_test.go`
- Modify: `internal/cloudcontrol/service.go`
- Modify: `internal/cloudcontrol/service_test.go`
- Modify: `internal/approval/service.go`
- Modify: `internal/approval/service_test.go`

**Interfaces:**
- Consumes: settings lifetime reader and reason validator.
- Produces: `(*auth.Service).InvalidateLiveSessions(context.Context, [][]byte)` for settings post-commit cleanup.

- [ ] **Step 1: Write failing authentication policy tests**

Provide a fake lifetime reader returning 12 minutes and 3 hours. Assert newly created and refreshed sessions use those values. Provide an erroring reader and assert login/session refresh returns `ErrUnavailable` without creating a session.

- [ ] **Step 2: Run auth tests and verify RED**

Run: `go test ./internal/auth -run 'Test.*Policy|Test.*Lifetime' -count=1`

Expected: FAIL because auth still uses constants.

- [ ] **Step 3: Inject a narrow policy reader and expose cache invalidation**

```go
type SessionPolicyReader interface {
    SessionLifetimes(context.Context) (idle time.Duration, absolute time.Duration, err error)
}
```

Read and validate lifetimes before session creation and refresh. Delete Redis live-session keys only through the auth service method so the key format remains private to `internal/auth`.

- [ ] **Step 4: Write failing reason-validation tests**

Inject a fake validator that rejects inactive and mismatched reasons. Assert administrator mutations, device/session revocations, and approval creation stop before database/Cloud/outbox mutation and return the stable domain error.

- [ ] **Step 5: Run mutation service tests and verify RED**

Run:

```bash
go test ./internal/admin ./internal/cloudcontrol ./internal/approval -run Reason -count=1
```

Expected: FAIL because services do not consult the catalog.

- [ ] **Step 6: Add reason validator interfaces and usage mapping**

Each service receives a `ReasonValidator` interface and calls it before starting the business mutation. Map administrator/account/device/session usages explicitly. Preserve existing exact action permissions and two-person approval behavior.

- [ ] **Step 7: Run affected backend tests and verify GREEN**

Run:

```bash
go test ./internal/auth ./internal/admin ./internal/cloudcontrol ./internal/approval -count=1
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add internal/auth internal/admin internal/cloudcontrol internal/approval
git commit -m "feat: enforce dynamic admin security policy"
```

### Task 7: Expose settings APIs and complete runtime wiring

**Files:**
- Create: `internal/settings/http.go`
- Create: `internal/settings/http_test.go`
- Modify: `cmd/aera-admin/main.go`
- Modify: `cmd/aera-admin/main_test.go`
- Modify: `api/openapi/admin.yaml`
- Modify: `api/openapi_test.go`
- Modify: `Makefile`

**Interfaces:**
- Produces: the five approved `/api/v1/system/...` settings and reason endpoints.
- Consumes: settings service, auth `Require`, auth `RequireRecentTOTP`, principal and request metadata.

- [ ] **Step 1: Write failing HTTP permission and control tests**

Cover:

- super-admin read/manage;
- auditor read-only;
- developer/operator/support/finance direct settings `403`;
- any authenticated role reading active reasons for an approved usage;
- inactive reason listing restricted to settings readers;
- missing/invalid `Idempotency-Key`;
- missing recent TOTP;
- malformed JSON, revision conflict, protected/last-active reason errors;
- no-store headers and stable response bodies.

- [ ] **Step 2: Run handler tests and verify RED**

Run: `go test ./internal/settings -run TestHTTP -count=1`

Expected: compilation failure because the handler is absent.

- [ ] **Step 3: Implement strict handlers and error mapping**

Use a 64 KiB JSON limit, reject trailing JSON, parse UUID/revision/path values strictly, require a bounded idempotency header, and map only the stable errors from the approved design. Do not log request bodies or idempotency values.

- [ ] **Step 4: Wire store, auth, settings mutation service, and handlers**

Runtime construction order:

1. build audit service;
2. build settings store;
3. build auth with the settings store as lifetime reader;
4. build settings mutation service with auth as live-session invalidator;
5. inject settings reason validation into administrator, Cloud-control, and approval services;
6. mount audit and settings handlers.

- [ ] **Step 5: Extend OpenAPI and verification targets**

Add schemas and stable errors for policy, reason catalog, mutation metadata, revision conflicts, idempotency conflicts, and forced session revocation. Add `./internal/settings` to integration and race targets in `Makefile`.

- [ ] **Step 6: Run handler, runtime, OpenAPI, and race tests and verify GREEN**

Run:

```bash
go test ./internal/settings ./cmd/aera-admin ./api -count=1
AERA_ADMIN_TEST_DATABASE_URL='postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable' AERA_ADMIN_TEST_REDIS_ADDR='127.0.0.1:56382' go test -race ./internal/settings ./internal/auth ./internal/audit -count=1
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/settings cmd/aera-admin api Makefile
git commit -m "feat: expose secured system settings APIs"
```

### Task 8: Build dynamic reason controls and `/system/settings`

**Files:**
- Create: `web/src/pages/SystemSettingsPage.tsx`
- Create: `web/src/pages/SystemSettingsPage.test.tsx`
- Modify: `web/src/components/ReasonForm.tsx`
- Modify: `web/src/components/ReasonForm.test.tsx`
- Modify: `web/src/api/contracts.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/app/router.tsx`
- Modify: `web/src/app/router.test.tsx`
- Modify: `web/src/layout/AdminLayout.tsx`
- Modify: `web/src/layout/AdminLayout.test.tsx`
- Modify: affected page tests using `ReasonForm`

**Interfaces:**
- Consumes: settings and reason APIs.
- Produces: `/system/settings`, read-only auditor state, super-admin mutations, and server-backed reason selection across business pages.

- [ ] **Step 1: Write failing dynamic `ReasonForm` tests**

Assert options come from the client API, security-compatible reasons appear for account/device/session usages, inactive reasons do not appear, unavailable/empty catalogs disable submit, and no hard-coded reason fallback exists.

- [ ] **Step 2: Run component tests and verify RED**

Run: `pnpm --filter @aera/admin-web test --run src/components/ReasonForm.test.tsx`

Expected: FAIL because options are hard-coded.

- [ ] **Step 3: Implement a query-backed reason catalog hook**

```ts
export type ReasonUsage = 'administrator' | 'account' | 'device' | 'session' | 'settings';

export function useReasonCodes(usage: ReasonUsage) {
  return useQuery({ queryKey: ['reason-codes', usage], queryFn: () => listReasonCodes({ usage }) });
}
```

Keep local sensitive-text and length checks, but validate selected values against the fetched result.

- [ ] **Step 4: Write failing settings page tests**

Assert super-admin controls, auditor read-only rendering, policy values/revision, warning and step-up before save, `Idempotency-Key`, conflict refresh, reason create/update, and `sessions_revoked` auth clear/redirect.

- [ ] **Step 5: Run settings page tests and verify RED**

Run: `pnpm --filter @aera/admin-web test --run src/pages/SystemSettingsPage.test.tsx`

Expected: FAIL because the page is absent.

- [ ] **Step 6: Implement typed settings client and page**

Use Ant cards/forms/table/modal patterns already established in `AdministratorsPage` and `ApprovalsPage`. Generate an idempotency key per submitted mutation and retain it only for the in-flight/retry lifecycle. Never persist it in browser storage. After session-policy success, call the Auth provider logout/reset path and navigate to `/login`.

- [ ] **Step 7: Add route and menu permission guards**

Mount `/system/settings` for `system_settings.read`; render mutation controls only for `system_settings.manage`. Update the fixed frontend permission union/matrix to match Go RBAC exactly.

- [ ] **Step 8: Run all frontend tests, lint, and typecheck and verify GREEN**

Run:

```bash
pnpm --filter @aera/admin-web lint
pnpm --filter @aera/admin-web test --run
pnpm --filter @aera/admin-web typecheck
```

Expected: PASS with no warnings or failed tests.

- [ ] **Step 9: Commit**

```bash
git add web/src
git commit -m "feat: add system security settings console"
```

### Task 9: Extend real-process E2E and operational documentation

**Files:**
- Create: `e2e/audit-settings.spec.ts`
- Modify: `e2e/support.ts`
- Modify: `e2e/global-setup.ts`
- Modify: `README.md`
- Modify: `.env.example` only if the final implementation introduces a documented non-secret setting; otherwise leave it unchanged.

**Interfaces:**
- Consumes: real Admin processes, PostgreSQL, Redis, and the existing real `aera-cloud` provider.
- Produces: browser/API acceptance evidence for audit and settings.

- [ ] **Step 1: Write failing Playwright acceptance tests**

Add tests proving:

1. super-admin and auditor see full audit while operator/support only see their own actor ID;
2. developer and finance direct audit/settings API calls return `403`;
3. auditor settings page is read-only;
4. a super-admin must step up before settings mutation;
5. same-key replay returns the same settings result and different input conflicts;
6. a new active reason appears in the matching business form;
7. session-policy change signs out all tested administrator sessions;
8. response/log/canary scans contain no credentials, identity search values, or idempotency keys.

- [ ] **Step 2: Run the focused E2E and verify RED**

Run:

```bash
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e
```

Expected: new tests FAIL until all integration behavior is wired.

- [ ] **Step 3: Complete fixture and cleanup support**

Add only deterministic internal administrator and settings fixtures. Preserve isolated Docker project names, temporary PKI, canary scanning, and teardown guarantees. Restore policy values within the isolated E2E database only; never mutate a developer database.

- [ ] **Step 4: Update README scope and runbook notes**

Document audit visibility, settings permissions, forced logout, dynamic reasons, retention-policy meaning, exact local verification commands, and that production deployment remains separate.

- [ ] **Step 5: Run the real Cloud E2E and verify GREEN**

Run:

```bash
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e
```

Expected: all existing and new tests PASS against the real Cloud provider.

- [ ] **Step 6: Commit**

```bash
git add e2e README.md .env.example
git commit -m "test: close admin phase one acceptance"
```

### Task 10: Verify, review, integrate, and push

**Files:**
- Modify only files required to fix failures discovered by the commands below, each with a reproducing test first.

**Interfaces:**
- Produces: clean verified feature branch, merged and remotely verified `aera-admin/main`.

- [ ] **Step 1: Review the implementation against every design requirement**

Read `docs/superpowers/specs/2026-07-22-aera-admin-phase-1-completion-design.md` line by line and map each goal, security constraint, endpoint, RBAC rule, error, frontend behavior, and test requirement to code and automated evidence. Fix uncovered gaps through a new failing test.

- [ ] **Step 2: Run full Admin verification**

Run: `make verify`

Expected: exit 0; Go unit/integration/race, frontend lint/tests/type/build, OpenAPI, E2E TypeScript, and release builds pass.

- [ ] **Step 3: Run real Cloud E2E**

Run:

```bash
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e
```

Expected: all Playwright and audit acceptance tests pass with real Cloud.

- [ ] **Step 4: Build the release image**

Run: `make image`

Expected: exit 0 and image `aera-admin:security-foundation` produced.

- [ ] **Step 5: Verify repository hygiene**

Run:

```bash
git diff --check
git status --short --branch
git log --oneline main..HEAD
```

Expected: no unstaged/untracked files and only intentional phase-completion commits.

- [ ] **Step 6: Complete the branch using the approved integration workflow**

Use `superpowers:finishing-a-development-branch`. The user has requested eventual merge and push, but still run its fresh verification and environment checks before integration. Merge without force, re-run `make verify` on merged `main`, push `main`, and compare local and remote SHA with `git ls-remote`.

- [ ] **Step 7: Report delivery states separately**

Report exact commit SHAs and distinguish:

- local implementation;
- local verification;
- merged `main`;
- pushed GitHub `main`;
- deployment and production acceptance, which remain incomplete unless separately executed.
