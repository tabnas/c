# Build and test @tabnas/c.
#
# ts/ is the canonical implementation. go/ is a COMPLETE hand-translation at
# parity with it: `go test` runs the same shared test/spec/*.tsv fixtures and
# the 100-program CSmith corpus against the TypeScript golden fixtures.
#
# Local builds resolve the unpublished @tabnas siblings via the file:
# devDependencies in ts/package.json and, for Go, a go.work over sibling
# checkouts of parser/jsonic/expr (and their deps).

.PHONY: all build test clean reset build-ts test-ts clean-ts build-go test-go

all: build test

build: build-ts build-go

test: test-ts test-go

# --- TypeScript (canonical) ---
build-ts:
	cd ts && npm run build

test-ts:
	cd ts && npm test

clean-ts:
	rm -rf ts/dist ts/dist-test

reset:
	cd ts && npm run reset

# --- Go (port, at parity) ---
# Requires a go.work covering the sibling parser/jsonic/expr Go modules.
build-go:
	cd go && go build ./...

test-go:
	cd go && go test ./...

clean: clean-ts
