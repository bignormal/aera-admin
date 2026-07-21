SHELL := /bin/sh

AERA_ADMIN_TEST_DATABASE_URL ?= postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable
AERA_ADMIN_TEST_REDIS_ADDR ?= 127.0.0.1:56382

.PHONY: dependencies-up dependencies-down test test-integration web-test verify

dependencies-up:
	docker compose up -d --wait postgres redis

dependencies-down:
	docker compose down

test:
	go test ./... -count=1

test-integration: dependencies-up
	AERA_ADMIN_TEST_DATABASE_URL='$(AERA_ADMIN_TEST_DATABASE_URL)' AERA_ADMIN_TEST_REDIS_ADDR='$(AERA_ADMIN_TEST_REDIS_ADDR)' go test ./internal/store ./internal/audit ./internal/admin ./internal/auth -count=1 -v

web-test:
	cd web && pnpm test --run && pnpm typecheck && pnpm build

verify: test test-integration web-test
	go vet ./...
