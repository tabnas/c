# Divergences: the Rust port against the canonical TypeScript

Every input for which `rs/` produces a different RESULT from `ts/`. The
canonical TypeScript is authoritative, so a row here is a debt, not a
feature, and each one names who repairs it.

The executable half of this record is
[`test/divergent.tsv`](test/divergent.tsv), run by
`rs/tests/divergent_test.rs`. That file fails both ways: it goes red
when the port regresses AND when a divergence is repaired, so a closed
row cannot sit here claiming something that no longer happens. Prose
alone is never the record.

Measured 2026-09-21 by running all three: the canonical under Node
(type-stripped `ts/src/c.ts`), the Go port through a small driver, and
the Rust port through `cargo test`.

## 1. A ternary in a declaration initializer

| input | TypeScript | Go | Rust |
|---|---|---|---|
| `int a = b ? c : d;` | `RangeError: Maximum call stack size exceeded` | `fatal error: stack overflow`, the process dies | `ERROR:cancel` |

**What happens.** `@tabnas/expr` hands the ternary back as a
`conditional_expression`, and the node that the C plugin builds for it
holds ITSELF among its descendants. The tree is therefore not a tree,
and every walk over it runs forever. In the canonical the first walk to
reach it is `structureConditionalGroups`, which recurses until
JavaScript throws; the throw is catchable, so a caller inside a
`try` survives. Go recurses until the runtime kills the process, which
is not catchable. A straight port of the same walk into Rust overflows
the Rust stack, and that ABORTS THE PROCESS: no unwinding, no error, no
chance for the caller.

**Why this port differs.** A library that can be handed hostile input
must not be able to kill the process that called it. Two guards stop it:
`structure_conditional_groups` refuses to enter a node twice, and
`cst::realize` stops at `REALIZE_DEPTH_CAP` levels and makes the parse
report the engine's existing `cancel` code. Neither changes the answer
for any input that has one.

**Who repairs it.** The defect is upstream, in the canonical: the
expression node should not contain itself. Until `ts/src/c.ts` is
repaired, all three runtimes fail on this input and only the manner
differs. When it is repaired, all three should return a tree and this
row goes.

**Pinned by.** `test/divergent.tsv`, and `expression_cycle` in
`rs/tests/limits_test.rs`.

## 2. Source nested deeper than the realize cap

| input | TypeScript | Go | Rust |
|---|---|---|---|
| `void f(void) { {{{ ... }}} }`, 4000 deep | a tree | a tree | `ERROR:cancel` |
| the same, 20000 deep | `RangeError` or an out-of-memory kill | `fatal error: stack overflow` | `ERROR:cancel` |

**What happens.** The tree is realized into engine values by a recursive
walk, and the value it builds recurses again in `Value::to_json` and in
its own `Drop`. JavaScript throws when its stack runs out and Rust
aborts, so the port needs a bound that JavaScript does not.

**Where the cap sits, measured.** A translation unit of N nested
compound statements realizes at depth `N + 2`, and an unoptimized build
spends a little under a kilobyte of stack per level:

| thread stack | deepest that survived | first that aborted |
|---|---|---|
| 1 MiB | 302 | 402 |
| 2 MiB (a spawned thread's default) | 402 | 802 |
| 8 MiB (the main thread's default) | 1202 | not reached |

`REALIZE_DEPTH_CAP` is 256, below the smallest of those with room to
spare, so the bound holds wherever the parse runs rather than only on
the main thread. Nothing in `test/spec` and no program in the
100-program CSmith corpus reaches a tenth of it.

**Who repairs it.** Nobody: the cap is deliberate, and removing it would
trade a clean error for a process abort. The number moves only with a
fresh measurement.

**Pinned by.** `test/divergent.tsv`, and `nesting_at_the_cap` and
`nesting_past_the_cap` in `rs/tests/limits_test.rs`.

## 3. An initializer item whose expression is left un-evaluated

| input | TypeScript | Go | Rust |
|---|---|---|---|
| `static int g[2] = {-5,1};` | the item's `children` hold a raw `@tabnas/expr` operator array | the same array, on the item's `value` and `children` | the item's `children` are EMPTY |

**What happens.** For a few initializer shapes, a prefix operator and an
address-of among them, the expression is handed back by
`@tabnas/expr` as its own operator array rather than as a built node,
and the canonical leaves that array on the item as it is. It is not a
CST node, it has no `kind`, and `toFixture` writes it as an empty
object. The Rust port drops it, so the item comes back with no children
at all.

**How far it reaches.** It is invisible to the shared fixtures: every
row of `test/spec` passes. It shows up in the CSmith corpus, where these
initializer shapes are everywhere, and `rs/tests/csmith_test.rs` counts
the seeds it affects and names them, so a repair goes red there and says
so.

**Not in the register.** The input fits a cell; the ANSWER does not. The
disagreement is a whole CST, tens of thousands of characters wide, and a
register row compares whole expected values. It is pinned by
`unevaluated_initializer_items_are_dropped` in `rs/tests/c_test.rs` and
by the seed list in `rs/tests/csmith_test.rs` instead.

**Who repairs it.** This port. Reproducing the array means giving the
Rust `tabnas-expr` port's operator record the shape the canonical's has,
which is a change to a sibling crate, so it is not a change to make in
passing.

## Not divergences

Three differences come up often enough to be worth naming as NOT
belonging here, because all three runtimes agree:

- **The tree is not a byte-for-byte record of the source.** An
  expression's operator is a field rather than a token, a call's
  parentheses and a `_BitInt(N)` width are dropped, a parameter list
  inside a parenthesised declarator is dropped, and a comment at the
  very end of the input is dropped. Measured in TypeScript and in Rust
  on the same inputs, with the same result, and the shared fixtures pin
  the whole tree so a port that kept more of them would go red. Listed
  in `rs/README.md` under "What the tree keeps".
- **Span offsets on non-ASCII input.** Rust and Go count bytes,
  TypeScript counts UTF-16 code units. The shared fixtures are ASCII for
  exactly this reason; see `test/AGENTS.md`. The parsed VALUES agree.
- **Error codes.** This package declares none of its own, so a failed
  parse surfaces a base code from the engine or from `@tabnas/jsonic`,
  the same one in all three.
