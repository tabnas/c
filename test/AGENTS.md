# Agents Guide — shared spec fixtures

`spec/*.tsv` holds the cross-runtime conformance fixtures. All three
runtimes auto-discover and run **every** file in this directory, so a
change here affects TypeScript, Go and Rust together — edit with that in
mind.

## Format

Tab-separated, one case per line, with a header row naming the columns.
Blank lines are skipped, and so are comment lines — a line starting with
`#` that contains no tab. (A data row always has at least one tab, so a
`#`-leading source such as a C preprocessor directive still works.)

| Column | Meaning |
|---|---|
| `input` | C source. Escapes `\n` `\r` `\t` `\\` are decoded. |
| `expected` | A JSON value (the parse result), or `ERROR` / `ERROR:<code>` for inputs that must fail. The code is compared **exactly** — it is the error's code, not a substring of its message. |
| `opts` | Optional JSON object of plugin options (empty means defaults). |

`expected` and `opts` are **not** escape-decoded — they are raw JSON, so
JSON's own escape rules apply (`"a\nb"` is a string containing a newline).
To put a literal backslash in `input`, write `\\`.

**Keep fixture input ASCII.** These fixtures pin whole CST nodes, spans
included, and the runtimes count source offsets differently on non-ASCII
input: Go's `span.start`/`end` are byte offsets, TypeScript's are JS
string (UTF-16 code unit) offsets, and Rust's count Unicode scalar values.
Parsed *values* agree — only the offsets drift — but a fixture that pins a
span cannot contain a non-ASCII character until the engine's position model
is unified. (The e2e fixture's banner comment was de-accented for exactly
this reason.)

Results are compared after a JSON round-trip, so key order and the
`OrderedMap` / null-prototype-object representations do not affect the
comparison.

## Who runs what

- TypeScript: `ts/test/parity.test.ts` — `makeRunner(...).dir(...)`.
- Go: `go/parity_test.go` — `support.Runner{...}.Dir(t, dir)`.
- Rust: `rs/tests/parity_test.rs` — `Runner::new_with_row(...).dir(...)`.

Each is a dozen lines holding only what is specific to c: how to build
the parser for a row's options. Everything else — finding `test/spec`,
reading the file, decoding escapes, the `ERROR:` contract, the comparison,
the `<file>:<line>` in a failure message — comes from
[`@tabnas/support`](https://github.com/tabnas/support) and its Go and Rust
halves, so the three loaders cannot drift from each other either.

All three discover files by directory listing: adding a `.tsv` here runs it
in every runtime without touching any runner. An empty fixture, and a spec
directory with no fixtures in it, both **fail** — a runner that reports
green having run nothing is indistinguishable from coverage that was never
there.

## Rules

- Prefer adding a fixture here over a one-off in-language assertion when a
  case is expressible as input → output. That is what keeps the two
  runtimes honest against each other.
- TypeScript is canonical. If the runtimes disagree, the TS behaviour is
  the expected value — unless a port has exposed a genuine TS defect, in
  which case fix TS first and pin the corrected behaviour here.
- A new fixture must pass in ALL THREE runtimes: run `go test ./...` (from
  `go/`), `npm test` (from `ts/`) and `cargo test --test parity_test` (from
  `rs/`) before considering it done.
