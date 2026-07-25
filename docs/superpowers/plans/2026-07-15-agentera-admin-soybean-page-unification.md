# AgentEra Admin Soybean Page Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every real AgentEra Payload admin page use the approved light Soybean visual system while preserving Payload authentication, authorization, CRUD, upload, draft, version, and publishing behavior.

**Architecture:** Keep Payload as the behavior and routing owner. Add one static collection-description component family, split the remaining Payload-specific theme rules into focused SCSS partials, and extend the existing Playwright suite with page-family contracts before each visual change. Existing custom platform views and the official-agent overview remain unchanged except where shared tokens apply.

**Tech Stack:** Payload CMS 3.86, Next.js 16, React 19, TypeScript 5.7, SCSS, SQLite, Vitest, Playwright Chrome.

## Global Constraints

- Preserve every existing dirty-worktree change in `src/app/(payload)/custom.scss`, `src/components/admin/AgentEraNav.tsx`, `src/components/admin/PlatformTopbar.tsx`, `src/components/admin/platform/PlatformViewShell.tsx`, and `tests/e2e/admin.e2e.spec.ts`.
- Do not change collection fields, database schema, access rules, API routes, draft/version behavior, or publish behavior.
- Keep the official-agent overview and its four real metric cards; do not add metric cards to other collections.
- Implement only the approved light theme. Keep the topbar theme action disabled.
- Keep desktop navigation expanded at `>=1180px`, icon-only at `769-1179px`, and drawer-based at `<=768px`.
- Use Payload DOM classes only for presentation; do not replace Payload form submission or list state with custom client state.
- Run the failing Playwright assertion before the corresponding implementation change.
- Do not hand-edit `src/app/(payload)/admin/importMap.js`; regenerate it with `pnpm generate:importmap`.
- Stage and commit only the files named in the task being completed.

---

## File Structure

- `src/components/admin/CollectionDescription.tsx` — static descriptions for the four standard real collections that do not use the official-agent overview.
- `src/collections/Admins.ts` — register the administrator list description.
- `src/collections/ExpertCategories.ts` — register the category list description.
- `src/collections/SkillCatalog.ts` — register the skill list description.
- `src/collections/Media.ts` — register the media list description.
- `src/app/(payload)/payload-lists.scss` — standard list header, toolbar, table/media grid, selection, and paginator styling.
- `src/app/(payload)/payload-forms.scss` — create/edit/account fields, upload surface, document controls, sidebar, and feedback styling.
- `src/app/(payload)/payload-auth.scss` — login and Payload authentication-state styling.
- `src/app/(payload)/custom.scss` — design tokens, AgentEra shell styles, imports for the focused Payload partials, and shared responsive rules.
- `tests/e2e/admin.e2e.spec.ts` — page-family visual contracts and responsive interaction checks.
- `src/app/(payload)/admin/importMap.js` — generated Payload component map.

---

### Task 1: Add standard collection descriptions without replacing Payload headers

**Files:**
- Create: `src/components/admin/CollectionDescription.tsx`
- Modify: `src/collections/Admins.ts`
- Modify: `src/collections/ExpertCategories.ts`
- Modify: `src/collections/SkillCatalog.ts`
- Modify: `src/collections/Media.ts`
- Modify: `tests/e2e/admin.e2e.spec.ts`
- Generate: `src/app/(payload)/admin/importMap.js`

**Interfaces:**
- Consumes: Payload `admin.components.Description` custom-component slot.
- Produces: `AdminsDescription`, `ExpertCategoriesDescription`, `SkillCatalogDescription`, and `MediaDescription`, each rendering one `.ae-collection-description` paragraph.

- [ ] **Step 1: Add the failing list-description contract**

Append this loop after the existing collection-open tests in `tests/e2e/admin.e2e.spec.ts`:

```ts
for (const [path, title, description] of [
  ['expert-categories', '智能体分类', '维护官方智能体的分类与排序'],
  ['skill-catalog', '技能目录', '维护 Hermes Runtime 可安装技能目录'],
  ['media', '媒体资源', '管理智能体头像与平台图片资源'],
  ['admins', '管理员', '管理平台超级管理员和内容发布员'],
] as const) {
  test(`renders the standard Soybean heading for ${title}`, async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${serverURL}/admin/collections/${path}`)

    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await expect(page.getByText(description, { exact: true })).toBeVisible()
    await expect(page.getByTestId('agent-list-overview')).toHaveCount(0)
  })
}
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm exec playwright test tests/e2e/admin.e2e.spec.ts \
  --grep "renders the standard Soybean heading" \
  --workers=1 --reporter=line
```

Expected: all four cases fail because the exact description text is absent.

- [ ] **Step 3: Implement static description components**

Create `src/components/admin/CollectionDescription.tsx`:

```tsx
const descriptions = {
  admins: '管理平台超级管理员和内容发布员',
  categories: '维护官方智能体的分类与排序',
  media: '管理智能体头像与平台图片资源',
  skills: '维护 Hermes Runtime 可安装技能目录',
} as const

function CollectionDescription({ children }: { children: string }) {
  return <p className="ae-collection-description">{children}</p>
}

export function AdminsDescription() {
  return <CollectionDescription>{descriptions.admins}</CollectionDescription>
}

export function ExpertCategoriesDescription() {
  return <CollectionDescription>{descriptions.categories}</CollectionDescription>
}

export function MediaDescription() {
  return <CollectionDescription>{descriptions.media}</CollectionDescription>
}

export function SkillCatalogDescription() {
  return <CollectionDescription>{descriptions.skills}</CollectionDescription>
}
```

Keep the static map at module scope. Do not add `'use client'`, state, effects, or browser APIs.

- [ ] **Step 4: Register each description in its collection**

Extend the existing `admin` object in each collection with the exact component reference:

```ts
components: {
  Description: '/components/admin/CollectionDescription#AdminsDescription',
},
```

Use these export names for the other files:

```ts
'/components/admin/CollectionDescription#ExpertCategoriesDescription'
'/components/admin/CollectionDescription#SkillCatalogDescription'
'/components/admin/CollectionDescription#MediaDescription'
```

Do not add a description slot to `AgentTemplates`; its existing `AgentListOverview` owns that page introduction.

- [ ] **Step 5: Regenerate the import map**

```bash
pnpm generate:importmap
```

Expected: the generated map imports the four named exports from `CollectionDescription.tsx`.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run the Step 2 command again.

Expected: four cases pass, and none renders `agent-list-overview`.

- [ ] **Step 7: Run React and lint checks**

```bash
pnpm lint
```

Expected: exit code `0`; the static description component creates no client bundle or hook warning.

- [ ] **Step 8: Commit Task 1**

```bash
git add \
  src/components/admin/CollectionDescription.tsx \
  src/collections/Admins.ts \
  src/collections/ExpertCategories.ts \
  src/collections/SkillCatalog.ts \
  src/collections/Media.ts \
  'src/app/(payload)/admin/importMap.js' \
  tests/e2e/admin.e2e.spec.ts
git commit -m "feat: add collection page descriptions"
```

---

### Task 2: Unify every real collection list page

**Files:**
- Create: `src/app/(payload)/payload-lists.scss`
- Modify: `src/app/(payload)/custom.scss`
- Modify: `tests/e2e/admin.e2e.spec.ts`

**Interfaces:**
- Consumes: shared CSS variables and Payload classes `.collection-list`, `.list-header`, `.list-controls`, `.table`, `.list-selection`, and `.paginator`.
- Produces: one visual contract for official agents, categories, skills, media, and administrators without changing list behavior.

- [ ] **Step 1: Add the failing shared list-surface test**

Append:

```ts
test('uses one Soybean surface system on every real collection list', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })

  for (const path of ['expert-categories', 'skill-catalog', 'media', 'admins']) {
    await page.goto(`${serverURL}/admin/collections/${path}`)

    const title = page.locator('.collection-list .list-header h1')
    const description = page.locator('.ae-collection-description')
    const controls = page.locator('.collection-list .list-controls')
    const createButton = page.locator('.collection-list .list-header .btn--style-primary')

    await expect(title).toHaveCSS('font-size', '22px')
    await expect(description).toHaveCSS('color', 'rgb(148, 153, 169)')
    await expect(controls).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(controls).toHaveCSS('border-top-left-radius', '10px')
    await expect(createButton).toHaveCSS('background-color', 'rgb(100, 108, 237)')
  }
})
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm exec playwright test tests/e2e/admin.e2e.spec.ts \
  --grep "one Soybean surface system" \
  --workers=1 --reporter=line
```

Expected: fail on the default list heading, description, or create-button computed style.

- [ ] **Step 3: Import the focused list stylesheet**

At the top of `custom.scss`, keep the existing platform import and add:

```scss
@use './platform-admin';
@use './payload-lists';
```

Remove the previous duplicate `.collection-list__wrap`, `.list-controls`, `.table`, `.paginator`, `.list-selection`, and official-agent list-header declarations from `custom.scss` only after the equivalent rules exist in the new partial.

- [ ] **Step 4: Implement `payload-lists.scss`**

Create the partial with these exact shared rules:

```scss
.collection-list__wrap {
  padding: 22px var(--gutter-h) 36px;
}

.collection-list__wrap > .gutter {
  max-width: 1540px;
}

.collection-list .list-header {
  align-items: flex-start;
  display: flex;
  gap: 18px;
  justify-content: space-between;
  margin-bottom: 18px;

  h1 {
    color: var(--ae-text);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.25;
    margin: 0 0 6px;
  }

  .btn--style-primary {
    --bg-color: var(--ae-primary);
    --hover-bg: var(--ae-primary-hover);
    --color: #fff;
    --hover-color: #fff;
    border-radius: var(--ae-radius-control);
    box-shadow: 0 6px 14px rgb(104 112 229 / 18%);
    min-height: 38px;
  }
}

.ae-collection-description {
  color: var(--ae-text-muted);
  font-size: 12px;
  line-height: 1.55;
  margin: 0;
}

body:has([data-testid='agent-list-overview']) .collection-list .list-header {
  display: none;
}

.list-controls {
  background: var(--ae-surface);
  border: 1px solid var(--ae-border);
  border-bottom: 0;
  border-radius: var(--ae-radius-panel) var(--ae-radius-panel) 0 0;
  box-shadow: var(--ae-shadow-panel);
  padding: 13px 16px;

  .search-filter input,
  .react-select__control,
  .rs__control {
    background: #fbfcfe;
    border-color: #e7e9f0;
    border-radius: var(--ae-radius-control);
    font-size: 12px;
  }
}

.table {
  background: var(--ae-surface);
  border: 1px solid var(--ae-border);
  box-shadow: var(--ae-shadow-panel);
  overflow-x: auto;

  table { border-collapse: collapse; min-width: 100%; }
  thead { background: #fafbfe; }
  th { color: #8f95a5; font-size: 11px; font-weight: 600; height: 43px; }
  td { color: #555b6b; font-size: 12px; height: 66px; }
  th, td { border-bottom: 1px solid #f0f2f6; }
  tbody tr { transition: background 150ms ease; }
  tbody tr:hover { background: #f8f9ff; }
}

.list-selection {
  background: var(--ae-primary-soft);
  border-color: rgb(100 108 237 / 20%);
  color: var(--ae-text);
  font-size: 12px;
}

.paginator {
  background: var(--ae-surface);
  border: 1px solid var(--ae-border);
  border-radius: 0 0 var(--ae-radius-panel) var(--ae-radius-panel);
  border-top: 0;
  margin-top: 0;
  min-height: 55px;
  padding: 0 16px;

  .btn,
  .popup-button { font-size: 11px; }
}

@media (max-width: 768px) {
  .collection-list__wrap { padding-block: 16px 28px; }
  .collection-list .list-header { align-items: stretch; flex-direction: column; }
  .collection-list .list-header .btn--style-primary { align-self: flex-start; }
  .list-controls { padding: 10px; }
  .table table { min-width: 760px; }
  .paginator { padding-inline: 10px; }
}
```

Keep the existing `.ae-agent-cell*` styles in `custom.scss`; they are specific to the official-agent custom cell.

- [ ] **Step 5: Run focused and existing list tests**

```bash
pnpm exec playwright test tests/e2e/admin.e2e.spec.ts \
  --grep "one Soybean surface system|shows real official-agent overview data|uses readable rows" \
  --workers=1 --reporter=line
```

Expected: all selected tests pass; the official-agent overview remains present and other lists remain compact.

- [ ] **Step 6: Commit Task 2**

```bash
git add 'src/app/(payload)/payload-lists.scss' 'src/app/(payload)/custom.scss' tests/e2e/admin.e2e.spec.ts
git commit -m "feat: unify Payload collection lists"
```

---

### Task 3: Unify create, edit, account, media, authentication, and overlay surfaces

**Files:**
- Create: `src/app/(payload)/payload-forms.scss`
- Create: `src/app/(payload)/payload-auth.scss`
- Modify: `src/app/(payload)/custom.scss`
- Modify: `tests/e2e/admin.e2e.spec.ts`

**Interfaces:**
- Consumes: Payload `.collection-edit`, `.document-fields`, `.doc-header`, `.doc-controls`, `.field-type`, `.upload`, `.dropzone`, `.file-details`, `.login`, `.popup`, `.modal`, `.drawer`, and `.toast` surfaces.
- Produces: one form/auth/feedback visual system with no changes to submission or validation.

- [ ] **Step 1: Add failing create/edit family contracts**

Append:

```ts
for (const path of ['agent-templates', 'expert-categories', 'skill-catalog', 'media', 'admins']) {
  test(`styles ${path} create view as a Soybean form`, async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${serverURL}/admin/collections/${path}/create`)

    const editMain = page.locator('.collection-edit__main')
    const fields = page.locator('.document-fields__main')
    const title = page.locator('.doc-header__title.render-title')

    await expect(editMain).toHaveCSS('border-radius', '10px')
    await expect(editMain).toHaveCSS(
      'box-shadow',
      'rgba(36, 50, 82, 0.06) 0px 3px 12px 0px',
    )
    await expect(fields).toHaveCSS('border', '1px solid rgb(238, 240, 245)')
    await expect(title).toHaveCSS('font-size', '22px')
  })
}

test('styles the account page inside the AgentEra shell', async () => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${serverURL}/admin/account`)

  await expect(page.getByTestId('agentera-nav')).toBeVisible()
  await expect(page.getByTestId('agentera-topbar')).toBeVisible()
  await expect(page.locator('.collection-edit__main')).toHaveCSS('border-radius', '10px')
})
```

- [ ] **Step 2: Add the failing login contract in an unauthenticated context**

Append:

```ts
test('styles the Payload login as an AgentEra Soybean card', async ({ browser }) => {
  const anonymousContext = await browser.newContext()
  const anonymous = await anonymousContext.newPage()
  await anonymous.setViewportSize({ width: 1440, height: 900 })
  await anonymous.goto(`${serverURL}/admin/login`)

  await expect(anonymous.getByTestId('agentera-brand')).toContainText('AgentEra 管理系统')
  await expect(anonymous.locator('.login__wrap')).toHaveCSS('border-radius', '14px')
  await expect(anonymous.locator('.login__wrap')).toHaveCSS(
    'box-shadow',
    'rgba(39, 47, 78, 0.12) 0px 22px 60px 0px',
  )
  await expect(anonymous.locator('#field-email')).toHaveCSS(
    'background-color',
    'rgb(251, 252, 254)',
  )
  await anonymousContext.close()
})
```

- [ ] **Step 3: Run both contracts and verify RED**

```bash
pnpm exec playwright test tests/e2e/admin.e2e.spec.ts \
  --grep "create view as a Soybean form|account page inside|AgentEra Soybean card" \
  --workers=1 --reporter=line
```

Expected: at least one create family, account, or login input computed-style assertion fails.

- [ ] **Step 4: Import focused form and auth stylesheets**

At the top of `custom.scss`, add after `payload-lists`:

```scss
@use './payload-forms';
@use './payload-auth';
```

Move existing `.collection-edit*`, `.doc-header*`, `.doc-controls`, `.document-fields*`, generic `.field-type`, select-menu, upload, modal/drawer, and toast rules from `custom.scss` into `payload-forms.scss`. Move existing `.template-minimal`, `.login`, and `.login__wrap` rules into `payload-auth.scss`. Do not move AgentEra shell, platform dashboard, or official-agent custom-cell rules.

- [ ] **Step 5: Implement `payload-forms.scss`**

Create the file with these required rules:

```scss
.collection-edit__main-wrapper { padding: 20px var(--gutter-h) 40px; }

.collection-edit__main {
  border-radius: var(--ae-radius-panel);
  box-shadow: var(--ae-shadow-panel);
  margin: 0 auto;
  max-width: 1180px;
  overflow: hidden;
}

.doc-header__title.render-title {
  color: var(--ae-text);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.25;
}

.doc-controls {
  background: rgb(255 255 255 / 94%);
  border-bottom: 1px solid var(--ae-border);
  box-shadow: 0 3px 12px rgb(36 50 82 / 3%);
  backdrop-filter: blur(14px);

  &__value { color: var(--ae-text); font-size: 12px; }
  &__label { color: var(--ae-text-muted); font-size: 11px; }
}

.document-fields__main {
  background: var(--ae-surface);
  border: 1px solid var(--ae-border);
  border-radius: var(--ae-radius-panel);
  min-width: 0;
  overflow: hidden;
}

.document-fields__edit { padding-bottom: 40px; padding-top: 24px; }

.document-fields__sidebar-wrap {
  background: var(--ae-surface);
  border: 1px solid var(--ae-border);
  border-left: 0;
  border-radius: 0 var(--ae-radius-panel) var(--ae-radius-panel) 0;
  overflow: hidden;
}

.field-type {
  label,
  .field-label { color: #5b6171; font-size: 12px; font-weight: 600; }

  input,
  textarea,
  .react-select__control,
  .rs__control {
    background: #fbfcfe;
    border-color: #e5e8f0;
    border-radius: var(--ae-radius-control);
    box-shadow: none;
    font-size: 12px;
    transition: background 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
  }

  input:focus,
  textarea:focus,
  .react-select__control--is-focused,
  .rs__control--is-focused {
    background: #fff;
    border-color: rgb(100 108 237 / 55%);
    box-shadow: 0 0 0 3px rgb(100 108 237 / 10%);
  }

  textarea { min-height: 106px; }
}

.field-type.error input,
.field-type.error textarea,
.field-type.error .rs__control { border-color: var(--ae-danger); }

.dropzone,
.upload__dropzoneAndUpload,
.file-details {
  background: #fbfcfe;
  border-color: var(--ae-border);
  border-radius: var(--ae-radius-panel);
}

.popup__content,
.react-select__menu,
.rs__menu,
.modal__content,
.drawer__content {
  border: 1px solid var(--ae-border);
  border-radius: var(--ae-radius-panel);
  box-shadow: 0 16px 42px rgb(36 50 82 / 14%);
}

.popup-button-list__button { border-radius: 7px; font-size: 12px; }
.toast { border-radius: var(--ae-radius-panel); }

@media (max-width: 768px) {
  .collection-edit__main-wrapper { padding: 14px var(--gutter-h) 28px; }
  .document-fields { display: block; }
  .document-fields__sidebar-wrap {
    border-left: 1px solid var(--ae-border);
    border-radius: var(--ae-radius-panel);
    margin-top: 14px;
  }
}
```

- [ ] **Step 6: Implement `payload-auth.scss`**

Create:

```scss
.template-minimal { background: var(--ae-bg); }

.login {
  background:
    radial-gradient(circle at 18% 18%, rgb(100 108 237 / 10%), transparent 28%),
    radial-gradient(circle at 82% 80%, rgb(82 184 238 / 10%), transparent 28%),
    var(--ae-bg);
  min-height: 100vh;
}

.login__wrap {
  background: var(--ae-surface);
  border: 1px solid var(--ae-border);
  border-radius: 14px;
  box-shadow: 0 22px 60px rgb(39 47 78 / 12%);
  max-width: 430px;
  padding: 36px;
}

.login .ae-brand { justify-content: center; width: 100%; }
.login .field-type input {
  background: #fbfcfe;
  border-color: #e5e8f0;
  border-radius: var(--ae-radius-control);
  font-size: 13px;
}
.login .btn--style-primary {
  --bg-color: var(--ae-primary);
  --hover-bg: var(--ae-primary-hover);
  --color: #fff;
  --hover-color: #fff;
  border-radius: var(--ae-radius-control);
  min-height: 42px;
  width: 100%;
}

@media (max-width: 768px) {
  .login { padding-inline: 16px; }
  .login__wrap { padding: 26px 22px; width: 100%; }
}
```

- [ ] **Step 7: Verify field, upload, relationship, account, and login surfaces**

Run the Step 3 command, then run:

```bash
pnpm exec playwright test tests/e2e/admin.e2e.spec.ts \
  --grep "styles Payload edit pages as Soybean panels" \
  --workers=1 --reporter=line
```

Expected: all selected tests pass; the relationship menu still opens and has a `10px` radius.

- [ ] **Step 8: Commit Task 3**

```bash
git add \
  'src/app/(payload)/payload-forms.scss' \
  'src/app/(payload)/payload-auth.scss' \
  'src/app/(payload)/custom.scss' \
  tests/e2e/admin.e2e.spec.ts
git commit -m "feat: unify Payload forms and authentication"
```

---

### Task 4: Close responsive, visual, and regression gates

**Files:**
- Modify: `src/app/(payload)/payload-lists.scss`
- Modify: `src/app/(payload)/payload-forms.scss`
- Modify: `src/app/(payload)/payload-auth.scss`
- Modify: `src/app/(payload)/custom.scss`
- Modify: `tests/e2e/admin.e2e.spec.ts`

**Interfaces:**
- Consumes: all visual contracts from Tasks 1-3 and the existing navigation behavior.
- Produces: desktop, middle-width, and mobile proof that every page family remains usable.

- [ ] **Step 1: Add the failing mobile real-page contract**

Append:

```ts
test('keeps real Payload pages inside the mobile viewport', async () => {
  await page.setViewportSize({ width: 390, height: 844 })

  for (const path of [
    '/admin/collections/expert-categories',
    '/admin/collections/skill-catalog/create',
    '/admin/collections/media',
    '/admin/account',
  ]) {
    await page.goto(`${serverURL}${path}`)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
})
```

- [ ] **Step 2: Run the mobile contract and verify RED if overflow remains**

```bash
pnpm exec playwright test tests/e2e/admin.e2e.spec.ts \
  --grep "real Payload pages inside the mobile viewport" \
  --workers=1 --reporter=line
```

Expected before final responsive fixes: at least one real list, create, media, or account page reports `scrollWidth > 390`.

- [ ] **Step 3: Fix only evidence-backed responsive overflow**

Use the failing route and browser screenshot to add the smallest selector to the responsible partial. Allowed properties are:

```scss
min-width: 0;
max-width: 100%;
overflow-x: auto;
width: 100%;
```

Apply them only to the overflowing Payload wrapper (`.collection-list`, `.collection-edit`, `.document-fields__main`, `.document-fields__sidebar-wrap`, `.upload`, `.table`, or `.paginator`). Do not add global `* { overflow: hidden; }` or hide table columns.

- [ ] **Step 4: Run the complete automated gate**

```bash
pnpm lint
pnpm test:int
pnpm exec playwright test tests/e2e/admin.e2e.spec.ts --workers=1 --reporter=line
git diff --check
```

Expected: every command exits `0`. The Payload no-email-adapter development warning is acceptable; application errors, framework overlays, and test retries are not.

- [ ] **Step 5: Perform Browser/IAB page-family QA**

Use `http://localhost:3100` and verify these routes with the authenticated test administrator:

```text
/admin/login
/admin/account
/admin/collections/agent-templates
/admin/collections/expert-categories
/admin/collections/skill-catalog
/admin/collections/media
/admin/collections/admins
/admin/collections/agent-templates/create
/admin/collections/expert-categories/create
/admin/collections/skill-catalog/create
/admin/collections/media/create
/admin/collections/admins/create
```

For each page family, record page identity, meaningful DOM content, no framework overlay, console health, one screenshot, and one primary interaction. Exercise list search or filtering, relationship-menu opening, and one mobile sidebar navigation. Do not submit a new real record during visual QA.

- [ ] **Step 6: Compare accepted and rendered screenshots**

Use `view_image` on the accepted reference:

```text
/var/folders/d8/tb_9ybdj5xzg_l5451f5209c0000gn/T/codex-clipboard-9392e87e-35d0-4e1a-a8b0-0dbd4f42e758.png
```

and on the latest desktop screenshot saved outside the repository:

```text
/tmp/agentera-admin-soybean-unified.png
```

Inspect shell geometry, title hierarchy, list toolbar/table surface, form/sidebar surface, and primary-control color/radius. Fix every material mismatch compatible with Payload behavior, then repeat the affected browser and automated checks.

- [ ] **Step 7: Review React and Next.js performance impact**

Confirm that `CollectionDescription.tsx` remains server-compatible and static; no new data request, effect, event listener, or dependency was introduced; platform dashboard interactions are unchanged; and all SCSS partials compile through the existing Next.js pipeline.

- [ ] **Step 8: Commit Task 4**

```bash
git add \
  'src/app/(payload)/payload-lists.scss' \
  'src/app/(payload)/payload-forms.scss' \
  'src/app/(payload)/payload-auth.scss' \
  'src/app/(payload)/custom.scss' \
  tests/e2e/admin.e2e.spec.ts
git commit -m "test: verify unified Soybean admin pages"
```

## Final Verification

Run from `/Users/zizimutou/Desktop/agentera claw/agentera-admin`:

```bash
pnpm lint
pnpm test:int
pnpm exec playwright test tests/e2e/admin.e2e.spec.ts --workers=1 --reporter=line
git diff --check
git status --short --branch
```

The final handoff must report the page families changed, exact automated pass counts, Browser/IAB URL and viewport coverage, screenshot comparison result, remaining intentional Payload-specific deviations, and the disposition of the pre-existing dirty-worktree changes.
