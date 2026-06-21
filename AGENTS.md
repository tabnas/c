# Agents Guide — c

## What this project is

`@tabnas/c` is a **grammar plugin** that parses **C source code** (C23 plus
common GCC / Clang / MSVC extensions) into a **concrete syntax tree** —
preserving every token, comment, macro definition, macro use and compiler
extension verbatim.

It is a port of [`@jsonic/c`](https://github.com/jsonicjs/c) onto the
[Tabnas](https://github.com/tabnas/parser) engine. Like `@tabnas/zon`, this
is a **jsonic plugin**: it layers on `@tabnas/jsonic`'s relaxed-JSON grammar
(used as the DSL the grammar file is authored in) and uses
[`@tabnas/expr`](https://github.com/tabnas/expr) for Pratt-style expression
parsing. Install it on a jsonic-enabled engine:

```ts
import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { C } from '@tabnas/c'

const cst = new Tabnas().use(jsonic).use(C).parse('typedef int T; T x = 1;')
// cst.kind === 'translation_unit'
```

## Repository map

| Path | What it is |
|---|---|
| [`ts/`](ts/) | **Canonical** implementation — the `@tabnas/c` package. |
| [`go/`](go/) | **Go port — IN PROGRESS.** Done: the lexer (`tokens.go`, `symbols.go`, `matchers.go`), the CST helpers (`cst.go`), and the `@tabnas/expr` wiring + C-atom expression rules (`expr_grammar.go`). Still to come: the grammar install + the ~471-entry `@`-ref map (`c.go`), the legacy structuring post-processor (`structure.go` + `expr.go`), and the `#if`-folding post-pass (`conditional_groups.go`). The upstream `@jsonic/c` is TypeScript-only, so there is no Go source to convert from; the port is a from-scratch hand-translation. |
| [`ts/c-grammar.jsonic`](ts/c-grammar.jsonic) | **Single source of truth** for the declarative grammar (rule shapes for the whole C surface), authored in jsonic-DSL syntax. |
| [`ts/embed-grammar.js`](ts/embed-grammar.js) | Embeds `c-grammar.jsonic` into `src/c.ts` (between `BEGIN/END EMBEDDED` markers) as the `grammarText` string literal, **and** copies it verbatim to `go/c-grammar.jsonic` for `//go:embed`. The grammar contains backticks, so the Go side embeds from the file rather than inlining a raw string (unlike the smaller ports). Runs as the first half of `npm run build`. |
| [`ts/src/c.ts`](ts/src/c.ts) | Plugin entry: token catalog wiring, lex matchers, grammar install, and the `@`-named ref map (conditions/actions bound by name from the grammar). |
| [`ts/src/matchers.ts`](ts/src/matchers.ts) | Focused lex matchers (whitespace, comments, directives, header names, identifiers, literals, punctuators). |
| [`ts/src/tokens.ts`](ts/src/tokens.ts) | Named tokens for every keyword, extension keyword and punctuator. |
| [`ts/src/symbols.ts`](ts/src/symbols.ts) | `SymbolTable` + `MacroTable` on `ctx.meta.cmeta`, shared by matchers and rule actions (typedef/macro disambiguation). |
| [`ts/src/expr.ts`](ts/src/expr.ts), [`ts/src/expr-grammar.ts`](ts/src/expr-grammar.ts) | C operator table + `evaluateCExpr` (converts `@tabnas/expr` S-expressions into the per-kind expression CST shapes); `installExpr` wires `@tabnas/expr` and the C val-atom alts. |
| [`ts/src/structure.ts`](ts/src/structure.ts) | Recursive-descent post-processor for the legacy-fallback long-tail shapes (K&R params, complex compound declarators). |
| [`ts/src/conditional-groups.ts`](ts/src/conditional-groups.ts) | Translation-unit post-pass that folds `#if`/`#elif`/`#else`/`#endif` runs into `conditional_group` nodes. |
| [`ts/test/`](ts/test/) | TS tests (compiled to `dist-test/`): `c.test.ts` (parse cases), `csmith.test.ts` (replays the 100-program CSmith regression corpus against committed gzipped fixtures). |

## The tabnas engine dependency

This repo sits **above jsonic** in the stack (not directly on the bare
engine). Peer dependencies (`ts/package.json`, all `^0.2.0`):
`@tabnas/parser`, `@tabnas/jsonic`, `@tabnas/expr`. Each is mirrored as a
`file:../../<dep>/ts` devDependency for local builds. Clone
`parser`, `jsonic` and `expr` (plus jsonic's own deps `json`, `debug`,
`abnf`, `railroad`) as siblings of this repo and build their `ts/` halves
first; CI (`.github/workflows/build.yml`) does exactly this.

## Go port: upstream @tabnas/expr requirement

The Go `@tabnas/expr` operator binding reuses tins from the **global**
`tabnas.FixedTokens` table (the TypeScript expr consults the *instance's*
fixed tokens). `expr_grammar.go`'s `withInstanceFixedTokens` shim bridges this
by briefly exposing the C instance's tins through that global table across the
`Use(Expr)` call. Additionally, `@tabnas/expr`'s Go `makeAllOps` iterates the
operator table as a Go map, so operator precedence is **non-deterministic**
unless the op names are sorted — a one-line fix in `expr/go/expr.go`
(`sort.Strings(opNames)` before building the ops). The C Go port needs that
fix released in `@tabnas/expr` to parse expressions deterministically.

## Conversion notes (from @jsonic/c)

The port is mostly mechanical — the grammar is unchanged. The substitutions:

1. **Imports/API.** `from 'jsonic'` → `@tabnas/parser` (types) +
   `import { jsonic } from '@tabnas/jsonic'`; `from '@jsonic/expr'` →
   `@tabnas/expr`; `Jsonic` type → `Tabnas`; `Jsonic.make()(text)` →
   `new Tabnas().use(jsonic).parse(text)`. In tests
   `Jsonic.make().use(C)` → `new Tabnas().use(jsonic).use(C)` and a parse
   call `j(src)` → `j.parse(src)` (tabnas instances are not callable).
2. **Dropped vestigial peers.** `@jsonic/path` / `@jsonic/directive` were
   declared as peers upstream but never imported by the source, so they are
   not carried over.

### The one behavioural fix: val-close clobber

The single non-mechanical change lives in
[`ts/src/expr-grammar.ts`](ts/src/expr-grammar.ts). tabnas core's
relaxed-JSON `val` close (`@val-bc/replace` and its `@val-ac` restore,
supplied by `@tabnas/json` + `@tabnas/jsonic`) preserves only a
**primitive** node a plugin set in a `val` open action — an **object** CST
node is treated as a stale parent-seeded container and overwritten with the
matched token value. The C atom recognisers (`makeAtomAction` /
`makeIdAction`) deliberately set object CST nodes, so without intervention
every bare atom collapsed to its raw token string (`42` instead of a
`literal_expression`). The fix: stash the node on `rule.u.cNode` and restore
it in a C-side `val` **after-close (`ac`)** hook, which — because `jsonic`
is `use`d before `C` — runs after jsonic's own `ac` and so has the final
say. It only restores when `val` did not already settle on a richer node (a
`@tabnas/expr` Op converted by `evaluateCExpr`, or a sub-rule CST copied by
the `bc` hook — both carry a `.kind`). This is the same class of divergence
`@tabnas/zon` documents (jsonic core no longer auto-preserves plugin object
nodes / auto-seeds list nodes); keep it in mind for any future val-phase
work.

## Build & test

From `ts/`:

```bash
npm install            # resolves the @tabnas/parser + jsonic + expr file: siblings
npm run build          # node embed-grammar.js && tsc --build src test
npm test               # node --enable-source-maps --test "dist-test/*.test.js"
```

`npm run build` **embeds the grammar first** (into `src/c.ts`), then
`tsc --build`s both `src` and `test`. The repo-root [`Makefile`](Makefile)
wraps the package: `make build|test|clean|reset`.

## Authority rules

1. **`c-grammar.jsonic` is single-sourced, not duplicated.** Never
   hand-edit the text between the `--- BEGIN/END EMBEDDED c-grammar.jsonic
   ---` markers in `src/c.ts` — edit `c-grammar.jsonic` and re-run
   `npm run embed` (or `npm run build`, which embeds first).
2. **Both parse paths must agree.** The grammar path and the legacy
   `structure.ts` fallback must emit identical CST shapes; the CSmith
   corpus + fixtures (`ts/test/csmith-*`) are the parity contract.
