.PHONY: generate test race vet web build
generate:
	go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.29.0 generate
test:
	go test ./...
race:
	go test -race ./...
vet:
	go vet ./...
web:
	cd web && npm ci && npm run build
	node scripts/build-go-web.mjs
build: web
	go build -trimpath -o bin/xuetangx ./cmd/xuetangx
