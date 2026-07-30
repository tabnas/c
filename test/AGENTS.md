# Agents Guide — shared spec fixtures

`spec/*.tsv` holds the cross-runtime conformance fixtures. Both runtimes
auto-discover and run **every** file in this directory, so a change here
affects TypeScript and Go together — edit with that in mind.

## Format

Tab-separated, one case per line, with a header row naming the columns.
Blank lines are skipped, and so are comment lines — a line starting with
`#` that contains no tab. (A data row always has at least one tab, so a
`#`-leading source such as a C preprocessor directive still works.)

| Column | Meaning |
|---|---|
| `input` | C source. Escapes `\n` `\r` `\t` `\\` are decoded. |
| `expected` | A JSON value (the parse result), or `ERROR` / `ERROR:<substring>` for inputs that must fail. |
| `opts` | Optional JSON object of plugin options (empty means defaults). |

`expected` and `opts` are **not** escape-decoded — they are raw JSON, so
JSON's own escape rules apply (`"a\nb"` is a string containing a newline).
To put a literal backslash in `input`, write `\\`.

**Keep fixture input ASCII.** These fixtures pin whole CST nodes, spans
included, and the two runtimes count source offsets differently on non-ASCII
input: Go's `span.start`/`end` are byte offsets, TypeScript's are JS string
(UTF-16 code unit) offsets. Parsed *values* agree — only the offsets drift —
but a fixture that pins a span cannot contain a non-ASCII character until the
engine's position model is unified. (The e2e fixture's banner comment was
de-accented for exactly this reason.)

Results are compared after a JSON round-trip, so key order and the
`OrderedMap` / null-prototype-object representations do not affect the
comparison.

## Who runs what

- TypeScript: `ts/test/parity.test.ts` — reads `../../test/spec` at runtime
  from `dist-test/`, one `describe` per file.
- Go: `go/parity_test.go` — `TestSpec` globs `../test/spec/*.tsv`.

Both discover files by directory listing: adding a `.tsv` here runs it in
both runtimes without touching either runner.

## Rules

- Prefer adding a fixture here over a one-off in-language assertion when a
  case is expressible as input → output. That is what keeps the two
  runtimes honest against each other.
- TypeScript is canonical. If the two runtimes disagree, the TS behaviour is
  the expected value — unless Go has exposed a genuine TS defect, in which
  case fix TS first and pin the corrected behaviour here.
- A new fixture must pass in BOTH runtimes: run `go test ./...` (from `go/`)
  and `npm test` (from `ts/`) before considering it done.
