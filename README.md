# @tabnas/c

<!-- tabnas-badges -->
[![npm](https://tabnas.github.io/status/badges/c-npm.svg)](https://www.npmjs.com/package/@tabnas/c)
[![CI](https://github.com/tabnas/c/actions/workflows/ci.yml/badge.svg)](https://github.com/tabnas/c/actions/workflows/ci.yml)
[![go](https://tabnas.github.io/status/badges/c-go.svg)](https://pkg.go.dev/github.com/tabnas/c/go)
[![tabnas standard](https://tabnas.github.io/status/badges/c-standard.svg)](https://tabnas.github.io/status/)
<!-- /tabnas-badges -->

A [Tabnas](https://github.com/tabnas/parser) parser plugin (layered on
[@tabnas/jsonic](https://github.com/tabnas/jsonic)) that parses **C source code**
into a **concrete syntax tree**, preserving every token, comment, macro
definition, macro use, and compiler extension as-is.

Docs, guides, the error reference and the playground: **[tabnas.dev](https://tabnas.dev)**.

Targets **C23** plus the common **GCC / Clang / MSVC** extensions, with
best-effort handling of preprocessor conditional groups.

> Ported from [`@jsonic/c`](https://github.com/jsonicjs/c) to the
> [Tabnas](https://github.com/tabnas/parser) engine. The plugin runs on
> `@tabnas/parser`, `@tabnas/jsonic`, and `@tabnas/expr`. From 0.6 every
> declaration is built by its own grammar rules, and `@tabnas/expr` reads
> every expression ([`docs/rules.md`](docs/rules.md)).

## Install

```bash
npm install @tabnas/parser @tabnas/jsonic @tabnas/expr @tabnas/c
```

## Quick start

```ts
import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import { C } from '@tabnas/c'

const j = new Tabnas().use(jsonic).use(C)

const cst = j.parse(`
  typedef int T;
  T x = 1;
`)
// cst.kind === 'translation_unit'
// cst.children = [external_declaration{declKind:'declaration'}, ...]
```

Walk the tree depth-first and concatenate every `kind:'token'` `src` to
recover the original source byte-for-byte (modulo whitespace, whose
positions are preserved on token spans).

## Options

The plugin takes a single option, passed as the second argument to `use`:

```ts
const j = new Tabnas().use(jsonic).use(C, { extended: true })
```

| Option | Default | Effect |
|---|---|---|
| `extended` | `false` | Enable the compiler-extension surface. |

**`extended: false` (the default): plain C23.** Keywords, punctuators,
literals, declarations / definitions / statements / expressions, C23
attributes `[[...]]`, `static_assert`, typedef + macro tracking, and the
**whole preprocessor** (`#define` / `#include` / `#if` family / `#pragma`
/ `#error` / `#warning` / `#undef` / `#line`, plus `conditional_group`
folding). Preprocessor directives are structured identically in both
modes.

**`extended: true`: plus GCC / Clang / MSVC extensions.** GCC keywords
and syntax (`__attribute__`, `__asm__`, `__extension__`, `__inline__`,
`__signed__`, `__volatile__`, `__const__`, `__restrict__`, `__typeof__`,
`__alignof__`), MSVC keywords (`__declspec`, `__cdecl`,
`__int8/16/32/64`, `__ptr32/64`), Clang nullability annotations, and
the structured CST shapes for inline assembly (see *Coverage and known
limitations*).

Every extension dispatch alt in the grammar is gated on `@extended-on`,
and the extension-only rules are stripped from the grammar spec
altogether in plain-C mode, so plain C23 source parses through a
provably extension-free grammar. Real-world C source (anything that
includes a system header) needs `{ extended: true }`; source using an
extension construct under the default is a parse error, not a
silently degraded parse.

The sections below on **Attributes** (GCC/MSVC forms) and **GCC inline
assembly** describe `extended: true` behaviour. C23 `[[...]]` attributes
work in both modes.

## Architecture

- **Focused lex matchers** (`src/matchers.ts`): one matcher per concept:
  whitespace, line continuation, line/block comments, preprocessor
  directive opener (line-start gated), directive newline, header name,
  identifier (with keyword/typedef-name/macro-name reclassification),
  integer/float/char/string literals, and longest-match punctuator
  dispatch.

- **Symbol & macro tables** (`src/symbols.ts`): scope stack and macro
  lookup live on `ctx.meta.cmeta` so both lex matchers and rule
  actions share state. Lex matchers consult the tables when
  classifying identifiers; rule actions register names when they
  finalize a `typedef` or `#define`. Pre-lexed lookahead tokens are
  reclassified in place so the very next match sees the updated
  classification immediately.

- **Token catalog** (`src/tokens.ts`): every C23 keyword, every
  compiler-extension keyword, and every punctuator gets its own named
  token. Grammar rules and structuring code reference these names
  directly.

- **Declarative grammar** (`c-grammar.jsonic`): the rule shapes for
  the entire C surface (translation unit, external declarations,
  declarators, statements, expressions) live as a Jsonic-DSL
  document, embedded at build time into `src/c.ts`. All conditions
  and actions are bound to `@`-named refs in the TS plugin, so the
  grammar file reads as structural intent and action logic stays
  out of it.

- **`@tabnas/expr` reads the expressions** (`src/expr-grammar.ts`),
  with C's operator table and expr's options for a language like C:
  calls and subscripts bind as postfix operators, a group that holds a
  type name casts the operand after it, a call's arguments are a
  separated list beside the comma operator, expr refuses values side by
  side, and the conditional binds between assignment and `||`. Compound
  literals, `sizeof ( type )`, `_Generic`, GCC statement expressions,
  brace lists, and adjacent strings are rules of their own.

- **Conditional groups are rules**: a `#if`, `#ifdef`, or `#ifndef`
  line opens a `conditional_group`, whose `conditional_branch`es hold
  the declarations up to the next `#elif`, `#else`, or `#endif` line.

- **One path, dispatched on the head, with a fallback**
  (`src/fallback.ts`): `external_declaration` holds a declaration to the
  rules where 0.5 did (a type or storage head in plain mode, a head that
  `@looks-simple-decl` accepts in extended mode, a directive, a
  `static_assert`, an asm statement), and a declaration the rules cannot
  parse there is a parse error. Any other declaration is *armed*: where
  the rules cannot parse it, it becomes an unknown declaration
  (`declKind: 'unknown'`), its tokens flat, over the token run 0.5 handed
  its structurer, so what the parser accepts is what 0.5 accepted. An
  external declaration that starts with an identifier or a macro is
  unknown.

## Concrete-syntax shapes

Every node carries `{kind, span, children, trivia}` plus per-kind
fields. Highlights:

```
translation_unit
  conditional_group              (#if … #elif … #else … #endif)
    conditional_branch { branchKind }
      children: the branch's directive, then its declarations
    the #endif's external_declaration, last
  external_declaration { declKind: 'declaration'|'function_definition'|'unknown' }
    declaration_specifiers
      attribute_spec, struct_specifier, union_specifier, enum_specifier
      member_decl_list / enumerator_list (typed members, bitfields,
                                          static_assert, enumerators)
    init_declarator_list
      init_declarator { declaredName }
        declarator
          pointer (with qualifiers + attribute_spec)
          direct_declarator
            array_postfix
            function_postfix
              parameter_type_list { variadic? }
                parameter_declaration { declaredName }
              identifier_list                 (K&R)
        asm_label?, attribute_spec?
        '=' initializer
    static_assert_declaration
    define_directive { macroName, macroKind, macroParams?, macroVariadic? }
    include_directive { includeForm, headerKind, headerName }
    conditional_directive { directive }
    pragma_directive / error_directive / warning_directive / undef_directive
    compound_statement
      declaration | statement
      if_statement, switch_statement, while_statement, do_statement,
        for_statement (for_controls), labeled_statement
        { labelKind, labelName? }, jump_statement { jumpKind },
        expression_statement, asm_statement, and a `#` line's
        directive node
```

A node's other members are scalars. The named members that repeat one
of its children up to 0.5 (`operand`, `typeName`, `cond`, `value`,
`items`, and the rest) come from `member(node, name)` instead, exported
with the plugin; [`docs/rules.md`](docs/rules.md) has the table.

```ts
import { member } from '@tabnas/c'
member(castNode, 'typeName')   // the cast's type_name child
member(castNode, 'operand')    // the expression cast
```

### Expression shapes

C's eleven binary precedence levels, the prefix and postfix operators,
the conditional, assignment, and comma operators, member access, and the
`sizeof` and `_Alignof` forms. An operator is the node's `op`, not a
token; a call's parentheses and commas, a parenthesised expression's
parentheses and a member access's `.` or `->` are not kept as tokens,
and a cast keeps its parentheses. The members in braces after `·` come
from `member()`.

```
literal_expression { literalKind, value }
identifier_expression { name }
paren_expression
call_expression { callee, isMacro }
  argument_list
subscript_expression { · target }             // children: target, index_list
member_expression { op ('.'|'->'), memberName · object }
postfix_unary_expression { op · target }
unary_expression { op · operand }             // ++/--/+/-/!/~/*/&/sizeof/_Alignof/...
cast_expression { · typeName, operand }
binary_expression { op }                      // children: left, right
conditional_expression { · cond, then, else }
assignment_expression { op }                  // children: left, right; right-assoc
comma_expression
generic_selection { · controlling, associations }
  generic_controlling_expression { · expression }
  generic_association { associationKind · typeName?, value }
statement_expression                           // GCC ({ ... })
compound_literal { · typeName }               // children: type_name, initializer_list
initializer_list
  initializer_item { · designation?, value }
    designation
      member_designator { memberName }
      index_designator
```

## Disambiguation strategy

C's classic ambiguity (an identifier may name a typedef OR a variable)
is resolved at lex time. The identifier matcher consults
`SymbolTable.isTypedef(word)` and emits **TYPEDEF_NAME** instead of
**ID** for every typedef'd name. After a `typedef int T;` declaration
finalizes, the symbol table is updated AND any pre-fetched lookahead
tokens carrying that name are reclassified in place, so the next
declaration sees the new classification regardless of the parser's
arbitrary-lookahead.

A parallel **macro table** records `#define`d names. Identifiers seen
earlier in a `#define` lex as **MACRO_NAME**, and `call_expression`
nodes carrying such a callee get `isMacro: true` so consumers can
distinguish a macro invocation from a real function call without
re-querying any table. `#undef` removes the entry.

Full **nested scoping** (file / function-prototype / function-body /
block / struct-or-union / enum / for-init) is implemented in
`SymbolTable`. Inner non-typedef bindings shadow outer typedefs.

## Preprocessor

Each `#-line` is its own structured directive node (see shapes above)
at the top level and in a function body alike. A
`#if`/`#ifdef`/`#ifndef` … (`#elif`…)\* (`#else`)? … `#endif` run is a
`conditional_group` containing typed branches, built by rules as the
lines arrive. An unmatched `#endif` or `#else` is a flat external
declaration; an unterminated `#if` is a group that ends with the
document. Nested `#if … #endif` inside a branch is a group of its own.

Structural relationships use `children` as their single representation.
In particular, binary and assignment operands are `children[0]` and
`children[1]`, and conditional branches and their bodies are nested only in
`children`; they are not repeated under `left`/`right`, `branches` or `body`.

`#define` directives populate `ctx.meta.cmeta.macros`; `#undef`
removes. The macro table is the single source of truth used by lex-time
**MACRO_NAME** tagging.

## Attributes (all three forms structured)

```
attribute_spec { attributeForm: 'gcc'|'msvc'|'c23' · items }
  attribute_item { attributeName, attributePrefix? · argumentList? }
    attribute_argument_list
```

`__attribute__((noreturn, format(printf, 1, 2)))`,
`__declspec(dllexport)`, and C23 `[[gnu::pure]]` /
`[[deprecated("reason")]]` all produce the same item shape.

## GCC inline assembly

```
asm_statement { qualifiers · template, asm_outputs, asm_inputs, asm_clobbers, asm_labels }
  asm_template { · expression }
  asm_outputs?  asm_operand { · asmName?, constraint, value }
                  asm_name, asm_constraint { value }, asm_value { · expression }
  asm_inputs?
  asm_clobbers? asm_clobber { value }
  asm_labels?   asm_label_ref { labelName }
```

An operand the three parts cannot read (one 0.5 also took flat) keeps
its tokens flat.

## for-loop controls

```
for_controls { · init, cond, iter }
  for_init { · value: declaration | <expr> | empty }
  for_cond { · value: <expr> | empty }
  for_iter { · value: <expr> | empty }
```

## Coverage and known limitations

The parser handles every shape in the Csmith-generated regression
corpus (100 random C programs) plus a hand-curated stress sweep
(GCC `__attribute__`, C23 `nullptr` / `[[nodiscard]]` / `_BitInt`,
nested preprocessor `#if` chains, line-continuation in macro
bodies, function pointers, GCC inline assembly with operand
sections, struct bitfields with anonymous unions, designated and
indexed initialisers).

Pointer type qualifiers are structured everywhere a declarator can
appear, including parameter lists: `void f(char * restrict d, int *
const p)` puts the qualifier token on the `pointer` node it qualifies,
the same shape a top-level `int * const p;` produces. C99 array
declarator qualifiers (`int a[static 4]`, `char b[restrict 8]`) and the
unspecified-VLA marker (`int a[*]`) land as plain tokens inside the
`array_postfix` node, in source order; a genuine VLA size expression
(`int a[*p]`) still parses as an expression.

Struct and union members take the same tagged-type shapes as top-level
declarations: named members (`struct S0 f0;`), inline definitions
(`struct { int a; } t;`), C11 anonymous members
(`union { int i; float f; };`) and arbitrary nesting all produce a
nested `struct_specifier` / `union_specifier` / `enum_specifier` inside
the member's `specifier_qualifier_list`.

Known fall-throughs that produce a `declKind: 'unknown'` external
declaration rather than a structured one, under `{ extended: true }`
(source fidelity preserved; in plain-C mode they are a parse error, as
they were in 0.5):

- K&R-style parameter declarations (`int f(a, b) int a; long b; { … }`),
  which read as two unknown declarations, split at the `;`.
- Pointer-to-function-pointer declarators (`int (*(*fpp))(int);`), which
  0.5's structurer built.
- A declaration holding a macro where its syntax is due (`__THROW`,
  `__REDIRECT`), and `extern "C" {`.

Compound literals with a struct-tagged type inside a function body
(`(struct point){ … }`) ARE structured: they produce a
`compound_literal` node with a `type_name` and an `initializer_list`,
same as the anonymous-array form `(int[]){1,2,3}`.

**Attribute insertion points are a deliberate subset.** All three
attribute forms are recognised *leading* a declaration and *between*
declaration specifiers (`static [[deprecated]] int x;`,
`static __attribute__((unused)) int x;`,
`static __declspec(dllexport) int x;`), GCC's form is also recognised
after a declarator (`int x __attribute__((unused));`), and C23
attributes are recognised on enumerators (`enum E { A [[deprecated]] };`).
Attributes in the remaining standard positions are **not** parsed and
are a syntax error: after a declarator in C23 form
(`int x [[maybe_unused]];`), on a parameter
(`void f(int x [[maybe_unused]])`, `void f([[maybe_unused]] int x)`),
on a struct/union tag or member (`struct [[deprecated]] S { … };`,
`struct S { [[deprecated]] int a; };`), and on a statement or label
(`[[fallthrough]];`, `[[unlikely]] l: ;`).

## Architecture history

The parser shipped through a 14-phase migration from a pure
chomp-and-post-process design to the current near-pure-grammar
hybrid:

- **A** install `@tabnas/expr`; `val` accepts C atoms with the
  evaluate callback emitting the public CST shapes.
- **B** `simple_declaration` family + statement family.
  `block_item` / `statement` / `expression_statement` /
  `jump_statement` / `if`/`while`/`do`/`switch`/`for` /
  `labeled_statement` / `asm_statement` / `preprocessor_line`.
- **C** `val` open-alts for type-name constructs:
  `type_name` / `sizeof_type_form` / `cast_or_compound_literal` /
  `initializer_list` (with `designation` / `designator`) /
  `generic_selection` / `statement_expression` / `string_atom` /
  structured `asm_statement`.
- **D** cutover gates: deep-lookahead body validation
  (`fetchDeep()` drives `ctx.lex` directly so the body-supportedness
  check walks past the closing `}` of any function body), all
  unit tests passing on the new path, Csmith fixtures regenerated.
  See `ts/package.json` for the current version.
- **F** struct / union / enum specifiers + members + bitfields +
  enumerators, dispatched from `simple_declaration` / `spec_loop`.
- **G** attribute specs (3 forms × leading + between-specs
  insertion points).
- **H** top-level preprocessor directives (define / undef /
  include / conditional / pragma / error / warning / line) with
  macro registration on `cmeta.macros`, header-name lex-mode
  feedback, and the typed sub-rules wrapped under
  `external_declaration`.
- **I** top-level GCC `__asm__`. (`static_assert` grammar rule
  defined; top-level dispatch deferred pending comma-op gating.)
- **K** `structureConditionalGroups` extracted to its own
  module: a self-contained translation-unit-level post-pass.
- **L** standalone struct / enum definitions through grammar
  (`@looks-simple-decl` walks past tagged-type bodies).
- **N** ship `1.0.0`.
- **P** parenthesised sub-declarators (function pointers):
  `paren_inner_declarator` rule + `@looks-simple-decl` paren-walk
  branch. Shapes like `int (*fp)(int);` and
  `typedef int (*Fn)(int);` flow through the grammar.
- **O** top-level `static_assert(cond, msg)` dispatches into the
  existing `static_assert_declaration` rule with `n.no_comma_op`
  set, so `@tabnas/expr`'s `val.close` / `expr.close` bail on `,`
  (matching by src) and the `,` lands as a separator instead of
  the comma operator. Requires `@tabnas/expr >= 2.3.0`.
- **N₂** ship `2.0.0` declaring the hybrid as the final
  architecture.

- **0.6** every declaration and expression is built by rules, in
  one path, the chomp, the structurer, `@tabnas/expr`, and the
  conditional-group post-pass gone; the members that repeat a child
  move to `member()`. [`docs/rules.md`](docs/rules.md) has the
  design and what was measured.

## Go port

A complete Go port lives under [`go/`](go/). It builds 0.5's tree until it
moves to the rules (see [`docs/rules.md`](docs/rules.md), "Order"). The whole
TypeScript parser of 0.5 is
hand-translated: the lexer, the `@tabnas/expr`-driven expression layer, the
grammar install, the conditional-group post-pass, the top-level chomp +
preprocessor directives, the new-path structured dispatch (declarations,
declarators, struct/union/enum, initializers, statements), and the legacy
recursive-descent structurer. `tabnasc.Parse(src)` / `tabnasc.MakeC()` parse C
into structured concrete-syntax trees with typedef/macro tracking.

```go
import tabnasc "github.com/tabnas/c/go"

cst, _ := tabnasc.Parse(`int f(int a){ return a + 1; }`, map[string]any{"extended": true})
// cst["kind"] == "translation_unit"
```

**Parity:** `go test`'s `TestCsmithCorpus` is a hard gate and passes **100/100**
against the TypeScript golden fixtures (the same `.json.gz` set the TS suite
uses). The Go port builds against the published modules `go/go.mod`
requires; a `go.work` over sibling `@tabnas` checkouts (see the CI note in
[`AGENTS.md`](AGENTS.md)) is only for testing unreleased ones. One optional
upstream `@tabnas/expr` sort fix makes the synthetic start=`val` precedence
unit test deterministic (corpus parity holds without it).

## Rust port

A Rust port lives under [`rs/`](rs/): crate `tabnas-c`, library
`tabnas_c`, a hand-translation of the TypeScript onto the Rust `tabnas`
engine over `tabnas-jsonic` and `tabnas-expr`. It builds 0.5's tree until
it moves to the rules (see [`docs/rules.md`](docs/rules.md), "Order"). The engine and the two
plugins are on crates.io as well, but this repository's `rs/Cargo.toml`
takes each by path from a sibling checkout, and the release workflow swaps
in crates.io versions when it publishes `tabnas-c`.

```rust
let value = tabnas_c::parse("int f(int a) { return a + 1; }")?;
assert_eq!(value.to_json()["kind"], "translation_unit");
```

**Parity:** every shared `test/spec` fixture passes, and the Rust corpus
test replays all 100 Csmith seeds: 63 match their golden fixture
exactly, and the other 37 differ in one recorded way, a prefix operator
standing alone as a brace-initializer item, which the canonical leaves
as a raw operator array and this port drops. That difference and the
two others (a ternary as a whole declaration initializer, which the
canonical cannot walk, and a cap on nesting depth) are recorded with
their measurements in [`DIVERGENCE.md`](DIVERGENCE.md), and each is
pinned by a test that fails when it is repaired as well as when it
regresses. Build and test from `rs/` with
`cargo test --all-targets && cargo test --doc`, or run the whole gate
with `ci/rust/run.sh`; [`rs/README.md`](rs/README.md) has the details.

## License

MIT. Copyright (c) 2026 Richard Rodger and contributors.
