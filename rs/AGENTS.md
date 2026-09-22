# Agents Guide — the Rust port (`rs/`)

Read [`../AGENTS.md`](../AGENTS.md) first: it holds the repository
layout, the TypeScript-canonical contract, the shared fixtures, the
divergence rules and the untrusted-input stance. This file is only what
is specific to the crate.

## What this crate is

`tabnas-c`, lib `tabnas_c`. A plugin for the `tabnas` engine that
installs the C grammar on an instance that already carries the jsonic
base grammar, and hands expressions to `tabnas-expr`.

TypeScript is canonical. `ts/src/c.ts` defines behaviour, option names
and defaults; `ts/c-grammar.jsonic` defines the rule chain and is copied
verbatim into `rs/c-grammar.jsonic`, `go/c-grammar.jsonic` and the
`grammarText` literal in `ts/src/c.ts` by `ts/embed-grammar.js`. Never
edit a copy. Edit the source and run `make embed` from the repository
root.

## Layout

| File | What lives there |
|---|---|
| `src/lib.rs` | the plugin, `COptions`, `CMeta`, `make`/`parse`, token registration, engine options, grammar install |
| `src/matchers.rs` | the imperative lex matchers: identifiers, numbers, strings, punctuators, trivia, header names |
| `src/tokens.rs`, `src/sets.rs` | token names, keyword tables and the token sets the grammar dispatches on |
| `src/cst.rs` | the tree arena, `Item`, `Span`, and `realize` |
| `src/state.rs` | per-parse state: symbol table, macro table, lex mode, the arena itself |
| `src/rt.rs` | the runtime the ported handlers are written against: rule nodes, the `k`/`u` bags, the lookahead walk |
| `src/refs*.rs` | the grammar's `@name` handlers, split the way `ts/src/c.ts` groups them |
| `src/structure.rs`, `src/legacy_expr.rs` | the recursive-descent fallback that structures an absorbed token run (port of `ts/src/structure.ts`) |
| `src/expr_grammar.rs` | the operator table and the `tabnas-expr` install (port of `ts/src/expr-grammar.ts`) |
| `src/conditional_groups.rs` | the `#if`/`#endif` folding post-pass |
| `src/trivia.rs` | the sub-lex hook that buffers comments onto the next token |

## Two things the canonical does that Rust cannot do directly

**The parse state is a thread local, not a live object.** The canonical
hangs the symbol table, the macro table, the lexer mode and the tree on
`ctx.meta.cmeta` as JavaScript objects that matchers and handlers mutate
through shared references. An engine `Value` is copied on write and
cannot hold a native handle, so all of it lives in `state.rs` behind a
thread local, and the values that travel through a parse are HANDLES
into it (`{"#node": 12}`). `crate::realize` turns the handles back into
plain engine values at the parse boundary, which is why a caller driving
a `tabnas` instance directly has to call it before the next parse on
that thread. `parse_with` does it for you.

**The engine's lookahead buffer has a different shape.** In the
canonical engine and in Go, `ctx.t` is an array that never shrinks:
consuming a token blanks the slot it vacates with a `NOTOKEN` sentinel.
Here `context.t` is a `Vec` of real tokens that shortens as the parse
consumes. `fetchDeep` cannot lex past a blanked slot, so a dispatch
validator that has already looked far ahead once is blind until the
parse catches up, and that blindness DECIDES which of the two
declaration paths a declaration takes. `rt.rs` keeps the high-water mark
of `context.t.len()` to stand in for the canonical array's length; see
the comment above `note_lookahead`. `e2e.tsv` is the row that fails if
this is wrong, and it fails by routing three declarations through the
grammar path where the canonical routes them through the legacy one.

## Tests

| File | What it holds |
|---|---|
| `tests/parity_test.rs` | the shared `test/spec/*.tsv` fixtures, through `tabnas-support` |
| `tests/roundtrip_test.rs` | the concreteness contract: tokens verbatim, in order, at the spans they claim |
| `tests/csmith_test.rs` | the 100-program CSmith corpus against the golden fixtures under `ts/test`; `KNOWN_DIVERGENT` names the seeds that differ only by DIVERGENCE.md section 3 |
| `tests/path_dispatch_test.rs` | the path-dispatch catalogue `ts/test/spec/path-dispatch.tsv`: which of the two declaration paths each shape takes, read from where the canonical reads it |
| `tests/c_test.rs` | behaviour that a fixture row cannot express: the plugin API, the options, the symbol table |
| `tests/limits_test.rs` | untrusted input: deep nesting, long input, unterminated constructs, odd Unicode |
| `tests/perf_test.rs` | that parse time stays linear in input size |
| `tests/version_test.rs` | `Cargo.toml`, `VERSION`, `ts/package.json` and `go/c.go` agree |

Run one file with `cargo test --test <name>`. The whole gate is
`bash ../ci/rust/run.sh`.

**Do not leave a scratch test behind.** A file named `zz_*.rs` or
`spike*.rs` under `tests/` is a developer aid, and it is a defect to
commit one.

## Adding a fixture

A fixture in `test/spec` runs in all three runtimes, so it has to pass
in all three: `npm test` from `ts/`, `go test ./...` from `go/`, and
`cargo test --test parity_test` from here. Read
[`../test/AGENTS.md`](../test/AGENTS.md) for the column format and the
ASCII rule.

## Divergences

Any input where this port answers differently from the canonical
TypeScript needs an entry in [`../DIVERGENCE.md`](../DIVERGENCE.md) with
a measured table, and a row in `test/spec/divergent.tsv` where a fixture
row can express it, or a Rust test where it cannot. Prose alone is not a
record.

## Prose

`rs/README.md` is in the gated set (`ts/scripts/gated-docs.cjs`), so it
follows `docs/STYLE-GUIDE.md`: no em dash, no first person, no banned
phrase, and every `rust` fence is a complete `fn main` that runs as a
doctest. This file is an agent guide and is outside that set — em dashes
are house convention here.
