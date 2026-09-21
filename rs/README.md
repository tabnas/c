# tabnas-c (Rust)

A C23 grammar plugin for the
[`tabnas`](https://github.com/tabnas/parser) parsing engine, crate
`tabnas_c`. It parses C source, plus the common GCC, Clang and MSVC
extensions, into a CONCRETE syntax tree.

Concrete means the tree keeps what it parsed. Every token carries its
own source text and the span it came from, comments ride along as
tokens, a `#define` keeps its body, and a compiler extension survives as
itself rather than being normalised away. The section
[What the tree keeps](#what-the-tree-keeps) measures exactly how far
that goes.

The plugin layers on two others. The relaxed-JSON grammar of
[`tabnas-jsonic`](https://github.com/tabnas/jsonic) supplies the `val`
rule the C grammar hangs its expressions on, and is also the dialect
the grammar document itself is written in.
[`tabnas-expr`](https://github.com/tabnas/expr) supplies Pratt-style
expression parsing with the C operator table.

This is the Rust port of the canonical TypeScript implementation in
[`../ts`](../ts); the TypeScript version is authoritative and this crate
tracks it. The Go port in [`../go`](../go) has the same shape. All
three run the same fixtures in [`../test/spec`](../test/spec).

## Use

Parse a translation unit:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let value = tabnas_c::parse("int x = 1;")?;
    let tree = value.to_json();

    assert_eq!(tree["kind"], "translation_unit");
    assert_eq!(tree["children"][0]["kind"], "external_declaration");
    Ok(())
}
```

[`parse`](https://docs.rs/tabnas-c) builds a parser once and reuses it.
Building one costs far more than a small parse, so keep your own for
anything past a one-off call:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let parser = tabnas_c::make();

    for source in ["int a;", "char b;", "void f(void);"] {
        let value = tabnas_c::parse_with(&parser, source)?;
        assert_eq!(value.to_json()["kind"], "translation_unit");
    }
    Ok(())
}
```

A parser is `Send + Sync` and parses through `&self`, so one instance
serves every thread.

## Tokens, spans and trivia

A token node carries `tname` (the token identity), `src` (its text) and
`span` (`start`, `end`, `line`, `col`). A comment is a token like any
other, with a `TRIVIA_` name:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let value = tabnas_c::parse("/* why */ int x;")?;
    let tree = value.to_json();
    let first = &tree["children"][0]["children"][0]["children"][0];

    assert_eq!(first["tname"], "TRIVIA_BLOCK_COMMENT");
    assert_eq!(first["src"], "/* why */");
    assert_eq!(first["span"]["start"], 0.0);
    assert_eq!(first["span"]["end"], 9.0);
    Ok(())
}
```

Spans are BYTE offsets into the source. The canonical TypeScript counts
UTF-16 code units and Go counts bytes, so the three agree on every ASCII
input and differ on the offsets of anything past it. The shared fixtures
are ASCII for that reason; see [`../test/AGENTS.md`](../test/AGENTS.md).

## Extensions

Plain C23, the whole preprocessor included, is the default. The GCC,
Clang and MSVC constructs are opt-in, and with them switched off the
rules that parse them are stripped from the grammar document before it
is installed, rather than merely left unreachable:

```rust
use tabnas_c::COptions;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let parser = tabnas_c::make_with(&COptions::new().with_extended(true));
    let value = tabnas_c::parse_with(&parser, "__attribute__((packed)) int x;")?;

    assert_eq!(value.to_json()["kind"], "translation_unit");
    Ok(())
}
```

## Names the source never declares

C cannot be parsed without knowing which identifiers are typedef names:
`uint32_t x;` declares `x` only if `uint32_t` is already a type. The
parser does not follow `#include`, so tell it what a header would have
said:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let parser = tabnas_c::make();
    let mut meta = tabnas_c::CMeta::new();
    meta.symbols.bind_typedef("uint32_t");

    let value = tabnas_c::parse_with_meta(&parser, "uint32_t x;", &meta)?;
    let tree = value.to_json();
    let declarators = &tree["children"][0]["children"][1];

    assert_eq!(declarators["children"][0]["declaredName"], "x");
    Ok(())
}
```

`CMeta` carries a [`SymbolTable`] and a [`MacroTable`], the same pair
the canonical plugin hangs off `ctx.meta.cmeta`.

## Install it yourself

`make` and `make_with` are shorthand for installing the jsonic base
grammar and then this one. Do it by hand when the instance needs other
plugins too:

```rust
use tabnas::Tabnas;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut parser = Tabnas::new();
    parser.use_plugin(tabnas_jsonic::plugin(), None)?;
    parser.use_plugin(tabnas_c::plugin(), None)?;

    let value = tabnas_c::parse_with(&parser, "int x;")?;
    assert_eq!(value.to_json()["kind"], "translation_unit");
    Ok(())
}
```

The plugin refuses a bare engine: it hangs its expression alternates on
the base grammar's `val` rule, and an instance without one has nothing
to hang them on. A second install returns early rather than giving the
instance a second copy of every alternate.

## What the tree keeps

The tree keeps every token verbatim, at a span that names exactly the
text the token carries, in source order and without overlaps. The test
`tokens_are_verbatim_and_ordered` in
[`tests/roundtrip_test.rs`](tests/roundtrip_test.rs) reassembles every
fixture input from its tree and holds the port to that.

Three things are kept somewhere other than a token, and one group is
not kept at all. Both lists are measured, and the same inputs behave
the same way in the canonical TypeScript, so a port that kept more of
them would fail the shared fixtures:

- An expression's OPERATOR is a field, not a token. `1 + 2` gives a
  `binary_expression` with `op: "+"` and two operand children, so the
  operator text survives while its span does not. The same holds for an
  assignment, a unary operator and `sizeof`.
- A call's parentheses and a `_BitInt(37)` width are dropped.
- A parameter list inside a parenthesised declarator, as in
  `int qsort(void *, int (*)(const void *, const void *));`, is dropped.
- A comment that no later token can take as leading trivia, which means
  one at the very end of the input, is dropped.

So the tree is concrete about names, keywords, literals, comments
between tokens, macro bodies and compiler extensions, and it is not a
byte-for-byte record of an expression's operator positions.

## Limits

The tree is realized into engine values by a recursive walk, and the
value it builds recurses again when it is rendered or dropped. A Rust
stack overflow aborts the process, so the walk stops at
`REALIZE_DEPTH_CAP` levels and the parse reports the engine's `cancel`
code instead:

```rust
fn main() {
    let deep = format!("void f(void) {{ {}{} }}", "{".repeat(4000), "}".repeat(4000));
    let error = tabnas_c::parse(&deep).expect_err("too deep to realize");

    assert_eq!(error.code, "cancel");
    assert!(tabnas_c::REALIZE_DEPTH_CAP >= 256);
}
```

The cap is measured rather than copied: a translation unit of N nested
compound statements realizes at depth `N + 2`, and an unoptimized build
spends a little under a kilobyte of stack per level, so a thread with
the 1 MiB stack a small runtime hands out gives out somewhere past 300.
The cap sits below that, and no fixture and no program in the
100-program CSmith corpus reaches a tenth of it.

## Options

| Option | Type | Default | Effect |
|---|---|---|---|
| `extended` | `bool` | `false` | Parse the GCC, Clang and MSVC extensions, the inline assembly and attribute forms included. |

`COptions::from_value` reads the same option out of the JSON bag
`use_plugin` merges over the declared defaults, so
`parser.use_plugin(tabnas_c::plugin(), Some(options))` and
`make_with` agree.

## Install

The engine, the jsonic base grammar, the expr operator plugin and the
fixture runner are unpublished, so each is a path dependency on a
sibling checkout:

```toml
[dependencies]
tabnas-c = { path = "../c/rs" }
tabnas = { path = "../parser/rs" }
tabnas-jsonic = { path = "../jsonic/rs" }
tabnas-expr = { path = "../expr/rs" }
```

Clone `parser`, `json`, `jsonic`, `expr` and `support` next to this
repository before building.

## Differences from the canonical TypeScript

Recorded, with the measurement behind each, in
[`../DIVERGENCE.md`](../DIVERGENCE.md). The short version:

- A ternary in a declaration initializer, as in `int a = b ? c : d;`,
  builds a tree that holds itself. The canonical throws
  `RangeError: Maximum call stack size exceeded` and Go dies with
  `fatal error: stack overflow`; this port reports the `cancel` code and
  the caller carries on.
- Deeply nested source is bounded by the realize cap described above.
  The canonical has no cap and aborts instead.
- For a few initializer shapes, `static int g[2] = {-5,1};` among them,
  the canonical leaves the raw operator array `tabnas-expr` handed it on
  the initializer item. This port drops it, so the item comes back with
  no children. Every shared fixture passes either way; the CSmith corpus
  is where it shows.

## Build and test

```bash
cargo test --all-targets   # unit, fixture, round-trip and corpus tests
cargo test --doc           # the examples on this page
cargo clippy --all-targets --all-features -- -D warnings
```

`bash ../ci/rust/run.sh` runs the whole gate, including a lockfile
check, and leaves the tree as it found it.

The grammar lives in [`../ts/c-grammar.jsonic`](../ts/c-grammar.jsonic)
and is copied here by `ts/embed-grammar.js`. Edit it there, then run
`make embed` from the repository root.

## License

MIT
