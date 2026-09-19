FROM node:22-alpine AS web
WORKDIR /src
COPY web/package*.json web/
RUN npm ci --prefix web
COPY web web
RUN npm run build --prefix web && mkdir -p /src/internal/webassets/assets && cp -r web/dist/* /src/internal/webassets/assets/
FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/internal/webassets/assets/ internal/webassets/assets/
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/xuetangx ./cmd/xuetangx
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/xuetangx /xuetangx
COPY --chown=65532:65532 deploy/app-data/ /var/lib/xuetangx/
USER 65532:65532
ENTRYPOINT ["/xuetangx"]
