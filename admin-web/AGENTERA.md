# Aera Admin Web

## Local development

Keep the Payload environment variables in the repository root `.env`, then start two terminals:

1. Payload: `ADMIN_WEB_URL=http://localhost:9527 pnpm dev:payload`
2. Soybean: `pnpm dev:admin`

Open `http://localhost:9527/admin/`.

`ADMIN_WEB_URL` is the exact Soybean origin allowed to send Cookie-authenticated mutations during split-port development. Production deployment under the same origin does not need it.

## Verification

- Unit: `pnpm test:admin`
- Typecheck: `pnpm --dir admin-web typecheck`
- Build: `pnpm build:admin`
- Isolated E2E: `pnpm test:e2e:admin`

## Backend boundary

Pages call the small modules in `src/service/`. Those modules call Payload REST under `/api` with HttpOnly Cookie authentication. Do not add a BFF or store auth tokens in browser storage.
