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
| `int x = ((( ... 1 ... )));`, 5000 deep | `RangeError` | a tree | `ERROR:cancel` |
| `int x = --- ... 1;`, 5000 deep | a tree | a tree | `ERROR:cancel` |
| `void f(void) { if (a) if (a) ... ; }`, 2000 deep | a tree | a tree | `ERROR:cancel` |

The last three rows were measured 2026-09-23 with `extended: true`, the
option `other_deep_shapes_return` in `rs/tests/limits_test.rs` parses
them with.

**What happens.** The tree is realized into engine values by a recursive
walk, and the value it builds recurses again in `Value::to_json` and in
its own `Drop`. JavaScript throws when its stack runs out and Rust
aborts, so the port needs a bound that JavaScript does not.

**The structurer recurses too.** With `extended: true`, a declaration
the grammar path does not take is chomped as a flat token run and
handed to a recursive-descent structurer (`rs/src/structure.rs` and
`rs/src/legacy_expr.rs`, ports of `ts/src/structure.ts` and
`ts/src/expr.ts`). It spends a set of frames on every level of nesting
it meets, and nesting reaches it through more than blocks: a statement
inside a statement with no braces at all, a label, a declarator inside
a declarator, a parameter list inside a parameter list, a struct inside
a struct, a brace initializer inside another, an operand inside an
expression. `TokenStream::deeper` counts every one of those levels
against the same cap and gives up the same way, with `cancel`. Each
counted level builds a node inside the node its caller is building, so
the count never passes the depth the tree realizes at, and the count
refuses nothing that realize would admit. That is measured as well as
argued: on 13 shapes, the deepest input that returns a tree is the same
with the count as with it removed. At the cap, the costliest of those
paths in an unoptimized build, a struct in a struct or a parameter list
in a parameter list, holds about 0.85 MiB of stack, measured
2026-09-23.

The trees the structurer builds by a loop rather than by recursion, as
`x = 1 + 1 + ... + 1` is, are as deep as they are long, so the walks
between the structurer and the realize cap (macro registration and the
conditional-group fold) keep their own stacks rather than recursing.

Measured 2026-09-23 with `extended: true` on the 22 shapes of
`every_recursive_construct_stops_at_the_cap`, each 2000 deep: the
canonical returns a tree for 15 of them and throws `RangeError` for the
other 7, the Go port returns a tree for 21 and does not finish the
nested parameter lists in two minutes, and this port reports `cancel`
for all 22.

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
the main thread.

**How much room real source leaves, measured 2026-09-22.** The deepest
row in `test/spec` realizes at 17. The deepest of the 100 Csmith
programs realizes at 146, which is over half the cap, so the headroom
on generated C is real but not large. Every seed still returns a tree:
a walk that stopped short reports `cancel`, and the corpus test would
fail on it rather than compare a truncated one.

**Who repairs it.** Nobody: the cap is deliberate, and removing it would
trade a clean error for a process abort. The number moves only with a
fresh measurement.

**Pinned by.** `test/divergent.tsv`, and `nesting_at_the_cap`,
`nesting_past_the_cap`, `other_deep_shapes_return` and
`every_recursive_construct_stops_at_the_cap` in
`rs/tests/limits_test.rs`.

## 3. An initializer item whose expression is left un-evaluated

| input | TypeScript | Go | Rust |
|---|---|---|---|
| `static int g[2] = {-5,1};` | the item's `children` hold a raw `@tabnas/expr` operator array | the same array, on the item's `value` and `children` | the item's `children` are EMPTY |

**What happens.** When a prefix operator is the WHOLE of a brace
initializer item, the expression is handed back by `@tabnas/expr` as
its own operator array rather than as a built node, and the canonical
leaves that array on the item as it is. Measured 2026-09-21 on
`int a[5] = {+5, &x, !y, ~z, -5, 3, (4), -(6), b - 1};`: the five
prefix items and `-(6)` all come back as the raw array, while `3`,
`(4)` and `b - 1` come back as nodes. The same `-5` as a whole
declaration initializer, `int x = -5;`, builds a `unary_expression` in
every runtime. The array is not a CST node, it has no `kind`, and
`toFixture` writes it as an empty object. The Rust port drops it, so
the item comes back with no children at all, and the tokens of that
expression are absent from the tree.

**How far it reaches.** It is invisible to the shared fixtures: every
row of `test/spec` passes. It shows up in the Csmith corpus: 37 of the
100 seeds carry at least one such item, and `KNOWN_DIVERGENT` in
`rs/tests/csmith_test.rs` names them. Measured 2026-09-22 over the 100
golden fixtures: those 37 carry between 1 and 222 of them each, and one
seed carries exactly one, so the count per seed is not a number to
quote. The grader accepts a seed as known-divergent only when the `{}`
child is the SOLE difference from its golden fixture, and it asserts
the set of such seeds is exactly that list, so a repair goes red there
naming the seeds to delete, and a regression that widens the set goes
red the same way.

**Not in the register.** The input fits a cell; the ANSWER does not. The
disagreement is a whole CST, tens of thousands of characters wide, and a
register row compares whole expected values. Named tests carry it
instead.

**Who repairs it.** The canonical first, then both ports (ADR-13).
What the canonical leaves on the item is an engine-internal record, not
a node of the language; the language's shape for that expression is
the `unary_expression` the canonical itself builds for `int x = -5;`.
Copying the array into this port would reproduce the defect rather
than repair it, which is what the Go port did and why its column reads
as it does, and reproducing it faithfully would in any case need the
Rust `tabnas-expr` operator record to take the canonical's shape, a
change to a sibling crate. The port's own answer is not right either:
an empty item loses the tokens. The order of repair is therefore
`ts/src` evaluating the item's expression into the node it builds
everywhere else, the 37 golden fixtures regenerated, and Go and Rust
then building the same node; the Rust half of that lands in
`@initializer_item-bc` in `rs/src/refs_forms.rs`, where the
un-evaluated value is discarded today.

**Pinned by.** `KNOWN_DIVERGENT` in `rs/tests/csmith_test.rs`, and
`unevaluated_initializer_items_are_dropped` in `rs/tests/c_test.rs`.

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
- **Span offsets on non-ASCII input.** Go counts bytes, TypeScript
  counts UTF-16 code units and Rust counts Unicode scalar values, each
  an engine property rather than this plugin's. The shared fixtures are
  ASCII for exactly this reason; see `test/AGENTS.md`. The parsed
  VALUES agree. Measured 2026-09-21: after a block comment holding one
  astral character (U+1F600), `int` starts at 9 in TypeScript, 11 in Go
  and 8 in Rust; after one holding `é`, at 8, 9 and 8.
  `spans_count_unicode_scalar_values` in `rs/tests/c_test.rs` pins the
  Rust count on both inputs, with the other two in its comment.
- **Error codes.** This package declares none of its own, so a failed
  parse surfaces a base code from the engine or from `@tabnas/jsonic`,
  the same one in all three.
