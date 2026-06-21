# Build and test @tabnas/c.
#
# ts/ is the canonical implementation. go/ is currently a SCAFFOLD (module
# wiring + embedded grammar + plugin/helper signatures only — the parsing
# logic is not yet ported; see go/c.go and AGENTS.md).
#
# Local builds resolve the unpublished @tabnas siblings via the file:
# devDependencies in ts/package.json and, for Go, a go.work over sibling
# checkouts of parser/jsonic/expr (and their deps).

.PHONY: all build test clean reset build-ts test-ts clean-ts build-go test-go

all: build test

build: build-ts build-go

test: test-ts

# --- TypeScript (canonical) ---
build-ts:
	cd ts && npm run build

test-ts:
	cd ts && npm test

clean-ts:
	rm -rf ts/dist ts/dist-test

reset:
	cd ts && npm run reset

# --- Go (scaffold) ---
# Requires a go.work covering the sibling parser/jsonic/expr Go modules.
build-go:
	cd go && go build ./...

test-go:
	cd go && go test ./...

clean: clean-ts
