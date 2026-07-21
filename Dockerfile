ARG NODE_IMAGE=node:24.13.0-alpine3.23@sha256:cd6fb7efa6490f039f3471a189214d5f548c11df1ff9e5b181aa49e22c14383e
ARG GO_IMAGE=golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian12:nonroot@sha256:f5b485ea962d9bd1186b2f6b3a061191539b905b82ec395de78cbfae51f20e35

FROM ${NODE_IMAGE} AS web-build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile --filter @aera/admin-web...
COPY web ./web
RUN pnpm --filter @aera/admin-web build

FROM ${GO_IMAGE} AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=web-build /src/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -tags release -trimpath -ldflags='-s -w' -o /out/aera-admin ./cmd/aera-admin && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/aera-admin-bootstrap ./cmd/aera-admin-bootstrap

FROM ${RUNTIME_IMAGE}
COPY --from=go-build --chown=65532:65532 /out/aera-admin /aera-admin
COPY --from=go-build --chown=65532:65532 /out/aera-admin-bootstrap /aera-admin-bootstrap
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/aera-admin"]
