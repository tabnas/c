# @tabnas/c

A [Tabnas](https://github.com/tabnas/parser) parser plugin — layered on
[@tabnas/jsonic](https://github.com/tabnas/jsonic) — that parses **C source code**
into a **concrete syntax tree** — preserving every token, comment, macro
definition, macro use, and compiler extension as-is.

Targets **C23** plus the common **GCC / Clang / MSVC** extensions, with
best-effort handling of preprocessor conditional groups.

> Ported from [`@jsonic/c`](https://github.com/jsonicjs/c) to the
> [Tabnas](https://github.com/tabnas/parser) engine. The grammar is the
> same; the plugin now runs on `@tabnas/parser` + `@tabnas/jsonic` and
> uses `@tabnas/expr` for Pratt-style expression parsing.

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

## Architecture

- **Focused lex matchers** (`src/matchers.ts`): one matcher per concept —
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
  the entire C surface — translation unit, external declarations,
  declarators, statements, expressions — live as a Jsonic-DSL
  document, embedded at build time into `src/c.ts`. All conditions
  and actions are bound to `@`-named refs in the TS plugin, so the
  grammar file reads as structural intent and action logic stays
  out of it.

- **Pratt-style expressions** via [`@tabnas/expr`](https://github.com/tabnas/expr):
  the `val` rule absorbs C atoms (`LIT_INT` / `LIT_FLOAT` / `LIT_CHAR`
  / `LIT_STRING` / `ID` / `MACRO_NAME` / `TYPEDEF_NAME` / `KW_NULLPTR`
  / `KW_TRUE` / `KW_FALSE`), then `@tabnas/expr`'s pratt logic
  drives infix / prefix / suffix operator precedence. Custom val
  open-alts handle the C-only constructs that aren't simple
  operators: `sizeof ( type )` / cast / compound literal / `_Generic`
  / GCC statement-expression / brace initializer list / adjacent
  string concatenation.

- **Conditional-group folding** (`src/conditional-groups.ts`): a
  translation-unit-level post-pass that collapses contiguous runs
  of `#if`/`#ifdef` … `#elif`/`#else` … `#endif` into a single
  `conditional_group` node. Self-contained — operates only on
  already-parsed `conditional_directive` nodes.

- **Hybrid dispatch + legacy fallback** (`src/structure.ts`,
  `src/expr.ts`): the `external_declaration` cascading wildcard
  alts dispatch to `simple_declaration` (or to typed
  preprocessor / asm / static_assert sub-rules) whenever
  `@looks-simple-decl` recognises the head; otherwise the chomp
  loop falls through to a recursive-descent post-processor in
  `structure.ts`. Shapes covered by the new path:
  - simple declarations (storage prefix, multi-keyword type,
    pointer / array, function declarator, function definition)
  - tagged-type specifiers (struct / union / enum, including
    standalone definitions and C23 fixed-underlying-type enums)
  - attribute specs (GCC / MSVC / C23, leading + between-specs
    insertion points)
  - top-level preprocessor directives (#define, #include, #if
    family, #pragma / #error / #warning / #undef / #line)
  - top-level GCC `__asm__`
  - all expression and statement forms

  Shapes still on the legacy path:
  - K&R parameter lists (`int f(a, b) int a; long b; { … }`) —
    rare in modern code; csmith never generates them
  - complex compound declarators beyond simple function pointers
    (`int (*arr[N])(int);` arrays-of-fn-ptrs,
    `int (*(*fpp))(int);` ptr-to-fn-ptr). Plain function pointers
    `int (*fp)(int);` and top-level `static_assert(cond, msg);`
    moved onto the grammar path in 2.0.

  Both paths produce identical CST shapes; the
  `@tabnas/expr`-driven `val` handles initializer expressions in
  either case.

## Concrete-syntax shapes

Every node carries `{kind, span, children, trivia}` plus per-kind
fields. Highlights:

```
translation_unit
  conditional_group              (#if … #elif … #else … #endif folded)
    branches: conditional_branch { branchKind, directive, body }
    endif
  external_declaration { declKind: 'declaration'|'function_definition' }
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
    static_assert_declaration { condition, message? }
    define_directive { macroName, macroKind, macroParams?, macroVariadic? }
    include_directive { includeForm, headerKind, headerName }
    conditional_directive { directive }
    pragma_directive / error_directive / warning_directive / undef_directive
    compound_statement
      declaration | statement
      if_statement, switch_statement, while_statement, do_statement,
        for_statement (for_controls), labeled_statement
        { labelKind, labelName? }, jump_statement { jumpKind },
        expression_statement, asm_statement, preprocessor_line
```

### Expression shapes (Pratt-parsed via @tabnas/expr)

Operator precedence is driven by `@tabnas/expr`'s pratt machinery.
The full C operator catalog (11 binary precedence levels, prefix /
suffix unary, ternary, assignment, comma, member access, and the
sizeof / _Alignof prefix forms) is registered as a single
`OpDef`-table at plugin-install time. The val rule absorbs C atoms
via custom open-alts; @tabnas/expr drives the precedence climb;
the `evaluate` callback converts the resulting S-expression into
the per-kind CST shapes below.

```
literal_expression { literalKind, value }
identifier_expression { name }
paren_expression
call_expression { callee, isMacro }
  argument_list
subscript_expression { target, index_list }
member_expression { object, op ('.'|'->'), memberName }
postfix_unary_expression { target, op }
unary_expression { op, operand }              // ++/--/+/-/!/~/*/&/sizeof/_Alignof/...
cast_expression { typeName, operand }
binary_expression { op, left, right }         // 11 precedence levels
conditional_expression { cond, then, else }
assignment_expression { left, op, right }     // right-assoc
comma_expression
generic_selection
  generic_controlling_expression { expression }
  generic_association { associationKind, typeName?, value }
statement_expression                           // GCC ({ ... })
compound_literal { typeName, initializer_list }
initializer_list
  initializer_item { designation?, value }
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

Each `#-line` is its own structured directive node (see shapes above).
A translation-unit-level post-pass folds the flat sequence of
`#if`/`#ifdef`/`#ifndef` … (`#elif`…)\* (`#else`)? … `#endif` into a
single `conditional_group` containing typed branches. Best-effort:
unmatched `#endif` or unterminated `#if` leaves the surrounding
sequence flat. Nested `#if … #endif` inside a branch is recursively
grouped.

`#define` directives populate `ctx.meta.cmeta.macros`; `#undef`
removes. The macro table is the single source of truth used by lex-time
**MACRO_NAME** tagging.

## Attributes (all three forms structured)

```
attribute_spec { attributeForm: 'gcc'|'msvc'|'c23', items }
  attribute_item { attributeName, attributePrefix?, argumentList? }
    attribute_argument_list                   // Pratt-parsed args
```

`__attribute__((noreturn, format(printf, 1, 2)))`,
`__declspec(dllexport)`, and C23 `[[gnu::pure]]` /
`[[deprecated("reason")]]` all produce the same item shape.

## GCC inline assembly

```
asm_statement { qualifiers }
  asm_template { expression }
  asm_outputs?  asm_operand { asmName?, constraint, value { expression } }
  asm_inputs?
  asm_clobbers? asm_clobber { value }
  asm_labels?   asm_label_ref { labelName }
```

## for-loop controls

```
for_controls
  for_init { value: declaration | <expr> | empty }
  for_cond { value: <expr> | empty }
  for_iter { value: <expr> | empty }
```

## Coverage and known limitations

The parser handles every shape in the CSmith-generated regression
corpus (100 random C programs) plus a hand-curated stress sweep
(GCC `__attribute__`, C23 `nullptr` / `[[nodiscard]]` / `_BitInt`,
nested preprocessor `#if` chains, line-continuation in macro
bodies, function pointers, GCC inline assembly with operand
sections, struct bitfields with anonymous unions, designated and
indexed initialisers).

Known fall-throughs that produce a `declKind: 'unknown'` external
declaration rather than a structured one (still parseable, source
fidelity preserved):

- K&R-style parameter declarations (`int f(a, b) int a; long b; { … }`).
- GCC `__extern_inline` declarations gated on a `__USE_EXTERN_INLINES`
  feature macro that hasn't been `#define`d.

The first parse of `(struct point){ … }` (compound literal with a
struct-tagged type) inside a function body is not yet structured —
the struct-tagged type isn't in the new path's `SIMPLE_TYPE_HEAD`
set. Top-level brace initialisers on struct types (`struct point p
= { … };`) work because they go through the legacy fallback.

## Architecture history

The parser shipped through a 14-phase migration from a pure
chomp-and-post-process design to the current near-pure-grammar
hybrid:

- **A** install `@tabnas/expr`; `val` accepts C atoms with the
  evaluate callback emitting the public CST shapes.
- **B** `simple_declaration` family + statement family —
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
  unit tests passing on the new path, csmith fixtures regenerated.
  Shipped as `0.2.0`.
- **F** struct / union / enum specifiers + members + bitfields +
  enumerators, dispatched from `simple_declaration` / `spec_loop`.
- **G** attribute specs (3 forms × leading + between-specs
  insertion points).
- **H** top-level preprocessor directives — define / undef /
  include / conditional / pragma / error / warning / line — with
  macro registration on `cmeta.macros`, header-name lex-mode
  feedback, and the typed sub-rules wrapped under
  `external_declaration`.
- **I** top-level GCC `__asm__`. (`static_assert` grammar rule
  defined; top-level dispatch deferred pending comma-op gating.)
- **K** `structureConditionalGroups` extracted to its own
  module — a self-contained translation-unit-level post-pass.
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

The legacy chomp + `structureExternalDeclaration` fallback
remains by design for the long-tail shapes — K&R parameter lists
and complex compound declarators beyond simple function pointers.
Both paths emit identical CST nodes, so consumers see one tree
regardless of which path produced it.

## Go port

A complete Go port lives under [`go/`](go/). The whole TypeScript parser is
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
uses). Build/test the Go port with a `go.work` over the sibling `@tabnas`
modules (see the CI note in [`AGENTS.md`](AGENTS.md)); one optional upstream
`@tabnas/expr` sort fix makes the synthetic start=`val` precedence unit test
deterministic (corpus parity is robust without it).

## License

MIT. Copyright (c) 2026 Richard Rodger and contributors.
