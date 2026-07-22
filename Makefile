SHELL := /bin/sh
.DEFAULT_GOAL := check
.NOTPARALLEL: check

AERA_ADMIN_TEST_DATABASE_URL ?= postgres://aera_admin:aera-admin-dev-only@127.0.0.1:55435/aera_admin?sslmode=disable
AERA_ADMIN_TEST_REDIS_ADDR ?= 127.0.0.1:56382
AERA_ADMIN_IMAGE ?= aera-admin:security-foundation

.PHONY: check build dependencies-up dependencies-down e2e e2e-runner-contract e2e-typecheck format-check image install openapi-check race test test-integration verify vet web-check web-test

dependencies-up:
	docker compose up -d --wait postgres redis

dependencies-down:
	docker compose down

install:
	pnpm install --frozen-lockfile

format-check:
	@unformatted="$$(gofmt -l $$(find api cmd internal -name '*.go' -type f))"; \
	if [ -n "$$unformatted" ]; then echo "Go files require gofmt:" >&2; echo "$$unformatted" >&2; exit 1; fi

e2e-runner-contract:
	sh scripts/tests/run-e2e-contract.test.sh

vet:
	go vet ./...

test:
	go test ./... -count=1

test-integration: dependencies-up
	AERA_ADMIN_TEST_DATABASE_URL='$(AERA_ADMIN_TEST_DATABASE_URL)' AERA_ADMIN_TEST_REDIS_ADDR='$(AERA_ADMIN_TEST_REDIS_ADDR)' go test ./internal/store ./internal/audit ./internal/admin ./internal/auth ./internal/settings ./internal/cloudadmin ./internal/operations ./internal/approval ./internal/cloudcontrol -count=1

race: dependencies-up
	AERA_ADMIN_TEST_DATABASE_URL='$(AERA_ADMIN_TEST_DATABASE_URL)' AERA_ADMIN_TEST_REDIS_ADDR='$(AERA_ADMIN_TEST_REDIS_ADDR)' go test -race ./internal/audit ./internal/admin ./internal/auth ./internal/settings ./internal/cloudadmin ./internal/operations ./internal/approval ./internal/cloudcontrol -count=1

web-check: install
	pnpm --filter @aera/admin-web lint
	pnpm --filter @aera/admin-web test --run
	pnpm --filter @aera/admin-web typecheck
	pnpm --filter @aera/admin-web build

web-test: web-check

openapi-check:
	go test ./api -run '^TestOpenAPIContract$$' -count=1

e2e-typecheck: install
	pnpm exec tsc -p tsconfig.e2e.json

build: install
	pnpm --filter @aera/admin-web build
	mkdir -p bin
	CGO_ENABLED=0 go build -tags release -trimpath -o bin/aera-admin ./cmd/aera-admin
	CGO_ENABLED=0 go build -trimpath -o bin/aera-admin-bootstrap ./cmd/aera-admin-bootstrap

check: dependencies-up install e2e-runner-contract format-check vet test test-integration race web-check openapi-check e2e-typecheck build

verify: check

e2e:
	./scripts/run-e2e.sh

image:
	docker build -t '$(AERA_ADMIN_IMAGE)' .
