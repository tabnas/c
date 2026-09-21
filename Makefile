# Build and test @tabnas/c.
#
# ts/ is the canonical implementation. go/ is a COMPLETE hand-translation at
# parity with it: `go test` runs the same shared test/spec/*.tsv fixtures and
# the 100-program CSmith corpus against the TypeScript golden fixtures.
# rs/ is the Rust port, which runs the same shared fixtures.
#
# Local builds resolve the unpublished @tabnas siblings via the file:
# devDependencies in ts/package.json and, for Go, a go.work over sibling
# checkouts of parser/jsonic/expr (and their deps).

.PHONY: all build test clean reset build-ts test-ts clean-ts build-go test-go \
        build-rs test-rs clean-rs embed prose prose-counts

all: build test

build: build-ts build-go build-rs

test: test-ts test-go test-rs

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

clean: clean-ts clean-rs

# The prose gate (see docs/STYLE-GUIDE.md). Vale over the reader-facing
# pages, at the levels set in .vale.ini, on the same file list
# ts/test/docs.test.js reads. Requires `vale` on PATH and one
# `vale sync`. Warnings are advisory, errors fail.
prose:
	vale --minAlertLevel=error $$(node ts/scripts/gated-docs.cjs)
	node ts/scripts/vale-counts.cjs

# Re-measure what .vale.ini and the style guide record, after
# a change to the pages or to the rules moves the numbers.
prose-counts:
	node ts/scripts/vale-counts.cjs --write

# --- Rust (crate in rs/) ---
#
# `embed` first, the same ordering ts/Makefile gives build-rs and
# build-go and that npm's own `build` script gives build-ts.
# rs/c-grammar.jsonic is a copy of the single source of truth, written
# by ts/embed-grammar.js and parsed by the crate at load; without this,
# a focused Rust build after an edit to ts/c-grammar.jsonic compiles the
# previous text and succeeds. The drift tripwire is a test, and a build
# target does not run it.
build-rs: embed
	cd rs && cargo build --all-targets

# `--all-targets` excludes the doctests, and the README's examples are
# doctests, so both runs are needed.
test-rs:
	cd rs && cargo test --all-targets && cargo test --doc
	cd rs && cargo clippy --all-targets --all-features -- -D warnings

clean-rs:
	cd rs && cargo clean

# Re-embed the grammar into the TypeScript source and copy it to the Go
# and Rust modules. ts/c-grammar.jsonic is the single source of truth.
embed:
	cd ts && node embed-grammar.js
