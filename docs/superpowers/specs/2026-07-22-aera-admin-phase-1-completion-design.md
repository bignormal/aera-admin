# Aera Admin Phase 1 Completion Design

## 1. Status and decision

This specification closes the two remaining functional gaps in Aera Admin Phase 1:

- searchable, permission-scoped administrator audit records at `/audit`;
- security policy and reason-code management at `/system/settings`.

The user approved the following control model on 2026-07-22:

- only `super_admin` may change system settings;
- every settings mutation requires a recent step-up, CSRF and Origin validation, an `Idempotency-Key`, optimistic revision checking, a standard reason code, and an immutable audit event;
- settings changes do not add a second-person approval workflow in Phase 1;
- account disable and restore continue to require the existing two-person approval workflow.

This work starts from `aera-admin/main` commit `2fff6674b5208483446ce9333154ec4131183923` and uses the existing real `aera-cloud` integration without changing Cloud contracts.

## 2. Goals

1. Replace the `/audit` placeholder with a production-backed audit query page.
2. Enforce `audit.read_full` and `audit.read_own` in the server query, not only in the browser.
3. Provide stable cursor pagination and exact, bounded audit filters.
4. Keep identity, credential, network, and search-input material out of audit responses and query logs.
5. Add a versioned administrator security policy with session idle, absolute-session, and audit-retention values.
6. Make reason codes server-owned and dynamically consumed by all business-action forms.
7. Revoke every current administrator session after a session-policy change so a shorter policy takes effect immediately.
8. Preserve immutable, append-only audit storage and the existing real Admin-to-Cloud management chain.

## 3. Non-goals

- Official Managed Agent workflows.
- Workspace, desktop, Hermes, payment, website, or ordinary-user changes.
- Cloud Internal Admin API changes.
- An audit delete endpoint or a runtime role capable of deleting audit events.
- Automated archive or physical purge jobs. The retention value is a compliance minimum consumed by deployment and compliance operations.
- Editable roles or permissions; the six fixed roles remain fixed.
- Two-person approval for settings changes in Phase 1.

## 4. Architecture

### 4.1 Audit query path

The existing `internal/audit` package remains the sole owner of audit persistence and hash-chain validation. It gains focused query models and repository methods alongside the existing append path. A browser handler exposes read-only querying through the authenticated Admin BFF.

The server derives the allowed scope from the authenticated principal:

- `audit.read_full`: no actor restriction is injected unless the caller explicitly filters an actor;
- `audit.read_own`: `actor_admin_id` is always replaced with the authenticated administrator ID;
- neither permission: return `403 PERMISSION_DENIED` before repository access.

The browser never receives raw source-IP HMAC bytes, event hashes, full identities, credential material, or unrestricted database JSON. Before and after state remain limited to the existing audit state-key allowlist.

### 4.2 System settings path

A new `internal/settings` domain owns:

- the singleton security policy;
- reason-code reads and mutations;
- optimistic concurrency;
- settings-mutation idempotency;
- transactionally coupled immutable audit events.

The authentication service consumes a small policy-reader interface instead of hard-coded session durations. Failure to load a valid policy fails closed: it cannot create or refresh a management session.

Reason-code consumers use a small catalog interface. Business mutation services validate that a submitted reason code exists, is active, and is allowed for the requested usage before accepting the operation. Usage compatibility is explicit: administrator actions accept `administrator` or `security`; account actions accept `account` or `security`; device actions accept `device` or `security`; session actions accept `session` or `security`; settings changes accept `security` only.

## 5. Data model

Migration `000006_phase1_completion.sql` adds the following objects.

### 5.1 `admin_security_settings`

The table has exactly one row with key `global`:

| Column | Meaning |
|---|---|
| `settings_key` | Fixed primary key `global` |
| `session_idle_minutes` | Integer from 5 through 120; default 30 |
| `session_absolute_hours` | Integer from 1 through 24; default 8 |
| `audit_retention_days` | Integer from 365 through 3650; default 730 |
| `revision` | Positive monotonically increasing integer |
| `updated_by_admin_id` | Last modifying administrator |
| `created_at`, `updated_at` | UTC timestamps |

The absolute lifetime must be strictly greater than the idle lifetime. The migration seeds the current production-equivalent values, so deployment does not silently change existing behavior.

### 5.2 `reason_codes`

The existing table gains:

- `revision BIGINT NOT NULL DEFAULT 1`;
- a positive-revision constraint.

Reason-code `code` and `category` are immutable after creation. The label and active state may change. Rows are never deleted. A category cannot be left without any active code. The migration seeds `security_policy_change` and `reason_catalog_change` in the `security` category; those two codes cannot be deactivated.

### 5.3 `admin_settings_idempotency`

This focused table records immediate Admin-local settings mutations:

| Column | Meaning |
|---|---|
| `operation_id` | Stable mutation identifier |
| `actor_admin_id` | Calling super administrator |
| `action` | `update_security_policy`, `create_reason_code`, or `update_reason_code` |
| `idempotency_key_hmac` | HMAC of the caller-provided key |
| `request_hash` | Canonical request digest |
| `response_status` | Stored successful HTTP status |
| `response_body` | Safe replayable result object |
| `created_at`, `expires_at` | UTC timestamps with a 24-hour replay window |

`(actor_admin_id, action, idempotency_key_hmac)` is unique. Reusing the same key and same request returns the stored result. Reusing it for different input returns `409 IDEMPOTENCY_KEY_REUSED`.

The table stores no raw idempotency key and no free-form sensitive input.

Settings idempotency reuses the existing operation HMAC secret with a distinct `aera-admin.settings-idempotency.v1` domain separator, so this phase introduces no additional deployment secret.

## 6. Audit API

### 6.1 Endpoint

`GET /api/v1/audit-events`

Supported query parameters:

- `cursor`: opaque base64url cursor;
- `limit`: default 20, range 1 through 100;
- `actor_admin_id`: UUID, effective only for full readers;
- `event_type`: exact allowlisted event type;
- `object_type`: exact allowlisted object type;
- `object_id`: UUID;
- `outcome`: `success`, `failure`, or `denied`;
- `reason_code`: exact standard reason code;
- `from`, `to`: RFC3339 UTC boundaries, with `from < to`.

Results are ordered by `(created_at DESC, id DESC)`. The cursor contains only the last row's UTC microsecond timestamp and UUID. Invalid cursors return `400 AUDIT_CURSOR_INVALID` and never fall back to the first page.

The response contains:

- event ID and timestamp;
- actor administrator ID and role snapshot;
- event type, object type, and internal object ID;
- outcome, reason code, safe ticket reference, and validated note;
- approval ID, operation ID, request ID, and stable error code;
- allowlisted before and after state;
- `next_cursor`, or `null` at the end.

It excludes source-IP HMAC, User-Agent, chain hashes, email, phone, tokens, cookies, secrets, and identity ciphertext.

### 6.2 Query audit

A successful audit query appends `audit_events_viewed` after the page snapshot is read. The event records the caller, role, result count, and which filter classes were used. It does not record filter values. Permission denials continue through the existing browser-security denial audit path.

## 7. Settings APIs

### 7.1 Read settings

`GET /api/v1/system/settings`

Requires `system_settings.read`. It returns the current security policy, revision, updater ID, and update timestamp. `super_admin` and `auditor` receive this permission.

### 7.2 Update security policy

`PUT /api/v1/system/settings/security-policy`

Requires `system_settings.manage`, a recent TOTP-backed step-up, CSRF/Origin validation, and `Idempotency-Key`.

The request contains:

- `expected_revision`;
- all three policy values;
- `reason_code`, `ticket_reference`, and validated `note`.

The transaction performs, in order:

1. reserve or replay the idempotency key;
2. lock the singleton settings row;
3. verify the expected revision and policy bounds;
4. verify the active security-category reason code;
5. update the policy and increment its revision;
6. if either session duration changed, revoke all active administrator sessions, including the caller's session;
7. append `security_policy_updated` with safe before and after state;
8. store the replayable response and commit.

The audit event stores only allowlisted numeric policy values and revisions. A reason-code audit stores the stable code, category, active state, revision, and a boolean `label_changed`; it does not copy the human label into the state map. An audit-query event stores only result count and filter-class flags. The audit state allowlist is extended for exactly these non-sensitive keys.

The response contains `sessions_revoked`. When it is true, the browser clears local authentication state and navigates to `/login`. A retention-only update does not revoke sessions. If a session-policy response is lost, the operator signs in again and can verify the new revision; the original idempotent result remains stored for 24 hours.

### 7.3 Read reason codes

`GET /api/v1/system/reason-codes`

Authenticated administrators may request active codes for one allowed action usage. The server applies the compatibility mapping from section 4.2, so an account form receives active `account` and `security` reasons without duplicating policy in the browser. Full settings readers may instead list an exact category or all categories and may include inactive rows. Usage and category parameters are mutually exclusive. Responses include code, category, label, active state, revision, and timestamps.

Business forms fail closed if this endpoint is unavailable; they do not fall back to a browser hard-coded catalog.

### 7.4 Create reason code

`POST /api/v1/system/reason-codes`

Requires `system_settings.manage`, recent step-up, CSRF/Origin, and `Idempotency-Key`. The request contains a new stable code, category, label, reason metadata, and `expected_settings_revision`. The mutation creates the row, increments the global settings revision, appends `reason_code_created`, and stores the idempotent response in one transaction.

### 7.5 Update reason code

`PUT /api/v1/system/reason-codes/{code}`

Requires the same controls as creation. The request contains `expected_settings_revision`, `expected_reason_revision`, label, active state, and reason metadata. Code and category are not accepted in the body. The mutation rejects either revision conflict, protected-code deactivation, and any change that would leave a category with zero active reasons. It increments both revisions and appends `reason_code_updated` with safe before and after state.

## 8. RBAC

Two fixed permissions are added:

- `system_settings.read`;
- `system_settings.manage`.

Role assignments:

| Role | Audit | Settings |
|---|---|---|
| `super_admin` | Full | Read and manage |
| `developer` | None | None |
| `operator` | Own | None; may read active reasons needed by authorized actions |
| `support` | Own | None; may read active reasons needed by authorized actions |
| `finance` | None | None |
| `auditor` | Full | Read only |

Backend checks are authoritative. Browser route guards and hidden controls are usability measures only.

## 9. Session-policy semantics

- Login and session refresh read the current policy from PostgreSQL.
- A missing, out-of-range, or unreadable policy causes authentication to return the existing unavailable failure class.
- Updating either session duration revokes every active session in PostgreSQL and removes its Redis live-session key after commit.
- Revocation failure in PostgreSQL rolls back the policy change and audit event.
- Redis cleanup is best effort after the database commit; database revocation remains authoritative, so stale Redis keys cannot authenticate.
- The modifier must sign in again before any further administrator action.

## 10. Audit-retention semantics

`audit_retention_days` is the minimum retention policy published to deployment and compliance operations. The Admin runtime never deletes audit rows and the browser exposes no delete action. This preserves the append-only trigger and hash-chain evidence.

The settings page states that changing the value does not immediately delete or archive existing records. Physical lifecycle enforcement requires a separately authorized maintenance workflow with external checkpoints and is outside Phase 1.

## 11. Frontend

### 11.1 `/audit`

The placeholder is replaced with an Ant Design page matching the existing soybean-style Admin shell:

- compact filter bar;
- result table with explicit empty, loading, denied, and failed states;
- previous/next cursor navigation without guessed page counts;
- detail drawer for correlation IDs and safe before/after state;
- no export, copy-all, or raw-JSON control in Phase 1.

The browser sends only internal IDs, enum-like values, and timestamps in the URL. It does not accept email or phone filters.

### 11.2 `/system/settings`

The page contains:

- a security-policy card with current revision and last-update metadata;
- idle and absolute session controls;
- the audit-retention policy and its no-delete explanation;
- a categorized reason-code table;
- super-admin-only create, edit, activate, and deactivate controls;
- a mandatory warning that session-policy saves sign out every administrator.

Auditors see the same policy and catalog in a read-only state. Mutation dialogs use the existing `StepUpModal` and reason-input patterns.

### 11.3 Dynamic reason forms

`ReasonForm` receives server-provided options by action usage. It retains client-side length and sensitive-text checks, while the server remains authoritative for usage compatibility and active-state validation. An unavailable or empty allowed catalog disables submission and displays a fail-closed message.

## 12. Stable errors

New machine error codes are:

- `AUDIT_CURSOR_INVALID`;
- `SETTINGS_REVISION_CONFLICT`;
- `SETTINGS_POLICY_INVALID`;
- `REASON_CODE_ALREADY_EXISTS`;
- `REASON_CODE_NOT_FOUND`;
- `REASON_CODE_INACTIVE`;
- `REASON_CODE_CATEGORY_MISMATCH`;
- `REASON_CODE_LAST_ACTIVE`;
- `REASON_CODE_PROTECTED`;
- `IDEMPOTENCY_KEY_REUSED`.

Raw PostgreSQL, Redis, hashing, or encryption errors are never returned to the browser.

## 13. Testing

### 13.1 Go

- audit cursor encoding, decoding, ordering, and malformed input;
- filter validation and exact repository predicates;
- full-versus-own actor scoping at the service and HTTP boundary;
- response-field allowlist and absence of source-IP/User-Agent/hash material;
- settings bounds, absolute-greater-than-idle, revision conflicts, and unavailable-policy failure closure;
- same-request idempotent replay and different-request key conflict;
- reason-code immutability, protected codes, last-active guard, category validation, and inactive-code rejection;
- all-session database revocation and Redis cleanup after policy changes;
- transaction rollback when audit append or database revocation fails;
- direct `403` checks for every unauthorized fixed role.

### 13.2 React

- audit filters, cursor navigation, empty/error states, and detail drawer;
- own-audit UI and direct-route permission behavior;
- super-admin settings edit versus auditor read-only state;
- step-up, revision conflict, and forced-login redirect;
- dynamic reason loading, category filtering, inactive reasons, and fail-closed loading errors.

### 13.3 Contracts and E2E

- update the Admin OpenAPI contract and contract tests;
- extend Playwright coverage for all six roles, audit scope, settings read/manage, dynamic reason use, and post-policy-change logout;
- run the existing real Admin-to-Cloud E2E suite against `aera-cloud/main`;
- run `make verify`, security-boundary checks, release builds, and `make image` before integration.

## 14. Delivery boundary

Phase 1 may be declared functionally complete only when:

1. the audit and settings placeholders are gone;
2. every API and browser behavior above has automated coverage;
3. `make verify` passes from a clean worktree;
4. the real Admin-to-Cloud E2E passes without the Cloud Stub;
5. the release image builds;
6. the feature branch is merged into and pushed to `aera-admin/main`;
7. local validation, Git push, deployment, and production acceptance are reported as separate states.

Official Managed Agent work and production deployment remain subsequent deliverables.
