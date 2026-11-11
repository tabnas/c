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

From 0.6 every runtime builds every declaration and expression with the
canonical's rules ([`docs/rules.md`](docs/rules.md)). That closed the two
divergences this record kept besides the one below: a ternary used as a
whole declaration initializer, whose node held itself up to 0.5, and an
initializer item whose expression `@tabnas/expr` left un-evaluated. All
three runtimes return the same tree for both, and the register holds no
row.

## 1. Source nested deeper than the realize cap

| input | TypeScript | Go | Rust |
|---|---|---|---|
| `void f(void) { {{{ ... }}} }`, 4000 deep | a tree | a tree | `ERROR:cancel` |
| the same, 20000 deep | a tree | a tree | `ERROR:cancel` |
| `int x = ((( ... 1 ... )));`, 5000 deep | a tree | a tree | `ERROR:cancel` |
| `int x = --- ... 1;`, 5000 deep | a tree | a tree | `ERROR:cancel` |
| `void f(void) { if (a) if (a) ... ; }`, 2000 deep | a tree | a tree | `ERROR:cancel` |
| `#if 1`, 127 lines with no `#endif` | a tree | a tree | `ERROR:cancel` (0.5: a tree, the lines flat) |

Measured 2026-11-11 with `extended: true`, the option
`other_deep_shapes_return` in `rs/tests/limits_test.rs` parses them with.
The first four trees are deeper than JavaScript's `JSON.stringify`
writes: it throws `RangeError` on each, a limit of the caller's
serializer, not of the parse. Up to 0.5 the canonical threw `RangeError`
in its structurer on the first two.

**What happens.** The tree is realized into engine values by a recursive
walk, and the value it builds recurses again in `Value::to_json` and in
its own `Drop`. JavaScript throws when its stack runs out and Rust
aborts, so the port needs a bound that JavaScript does not.

**The parse does not recurse.** From 0.6 the rules read every one of
these shapes with a rule stack that grows with the nesting and a parse
loop that does not recurse, in every runtime, so what nests is the tree.
A tree a loop builds is as deep as it is long: a chain
`x = 1 + 1 + ... + 1` nests a `binary_expression` per operator, and a
postfix chain a node per operator. The rules read such a chain at one
rule depth (`rs/tests/repeat_test.rs`), and in this port a chain of more
operators than the cap realizes past it too and reports `cancel`, where
TypeScript and Go return the tree. An unterminated `#if` is a group that
ends with the document, so each nests the rest of the document in its
branch, two levels a line: 127 such lines in a row realize past the cap,
where up to 0.5 the lines stayed flat and this port returned a tree
(`unterminated_conditionals_nest_to_the_cap`). No compiler accepts them.

Measured 2026-11-11 with `extended: true` on the 22 shapes of
`every_recursive_construct_stops_at_the_cap`, each 2000 deep: the
canonical's parse returns a tree for all 22, of which `JSON.stringify`
writes 17 and throws `RangeError` on 5; the Go port returns a tree for
all 22, each in under half a second; this port reports `cancel` for 19
and returns the canonical's tree for the other 3, a declarator nested in
parentheses past one level, which every runtime reads as an unknown
declaration, flat. Up to 0.5 the canonical returned a tree for 15 and
threw `RangeError` for 7, the Go port did not finish the nested parameter
lists in two minutes, and this port reported `cancel` for all 22.

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

**How much room real source leaves, measured 2026-11-11 on the 0.6
tree.** The deepest row in `test/spec` realizes at 19. The deepest of
the 100 Csmith programs realizes at 148, which is over half the cap, so
the headroom on generated C is real but not large. Every seed still returns a tree:
a walk that stopped short reports `cancel`, and the corpus test would
fail on it rather than compare a truncated one.

**Who repairs it.** Nobody: the cap is deliberate, and removing it would
trade a clean error for a process abort. The number moves only with a
fresh measurement.

**Pinned by.** `nesting_at_the_cap`, `nesting_past_the_cap`,
`unterminated_conditionals_nest_to_the_cap`, `other_deep_shapes_return`
and `every_recursive_construct_stops_at_the_cap` in
`rs/tests/limits_test.rs`.

## Not divergences

Three differences come up often enough to be worth naming as NOT
belonging here, because all three runtimes agree:

- **The tree is not a byte-for-byte record of the source.** An
  expression's operator is a field rather than a token; the punctuation
  an expression's node stands for (a call's parentheses and commas, a
  subscript's brackets, a conditional's `?` and `:`, the parentheses
  around an expression) and a `_BitInt(N)` width are dropped, a comment
  where one stood kept as the node's child at its place; the parameter
  list after a parenthesised abstract declarator, as in a parameter
  `int (*)(int)`, is dropped; and a comment at the very end of the input
  is dropped. Measured in TypeScript and in Rust
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
