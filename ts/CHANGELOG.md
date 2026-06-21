# Changelog

## 0.2.0 (@tabnas/c)

Ported from [`@jsonic/c`](https://github.com/jsonicjs/c) onto the
[Tabnas](https://github.com/tabnas/parser) engine, renamed to
`@tabnas/c` and versioned with the `@tabnas` line (`0.2.0`). The C
grammar is unchanged. See `AGENTS.md` for the full conversion notes;
the entries below are the upstream `@jsonic/c` history.

### Changed

- Imports/API moved from `jsonic` / `@jsonic/expr` to `@tabnas/parser`
  + `@tabnas/jsonic` + `@tabnas/expr`. Construct an engine as
  `new Tabnas().use(jsonic).use(C)` and parse with `.parse(src)`.
- Dropped the vestigial `@jsonic/path` / `@jsonic/directive` peer
  dependencies (never imported by the source).

### Fixed

- val-close clobber: tabnas core's relaxed-JSON `val` close preserves
  only primitive plugin-set nodes, so the C atom recognisers' object
  CST nodes were overwritten with their raw token value. Restored via a
  C-side `val` after-close (`ac`) hook in `src/expr-grammar.ts`.

## 2.0.0 (@jsonic/c)

Lands parenthesised sub-declarators (function pointers) and
top-level `static_assert` on the grammar path, vendors a patched
copy of `@jsonic/expr` so the comma-operator vs static_assert
comma-separator collision is solved at the source, and declares
the hybrid grammar + legacy-fallback architecture as the final
shape for this release line.

### Added

- `paren_inner_declarator` rule — inner declarator inside `( … )`
  with pointer prefix + ID + array / function postfix support.
  Wired into `init_declarator` so shapes like `int (*fp)(int);`
  and `typedef int (*Fn)(int);` flow through the grammar.
  `@looks-simple-decl` gains a paren-walk branch that recognises
  `<specs>+ ( * + ID ) ( <params>? ) ;`.
- Top-level `static_assert(cond, msg)` and `_Static_assert(cond)`
  dispatch through `external_declaration` into the existing
  `static_assert_declaration` grammar rule. `@said-take-lparen`
  now sets `rule.n.no_comma_op = 1` which propagates into the
  cond / msg val sub-rules; the vendored `@jsonic/expr` honours
  the flag by bailing on `,` rather than consuming it as the
  comma operator.
- Vendored copy of `@jsonic/expr@2.2.0` under `vendor/jsonic-expr/`,
  installed via `package.json` `file:` link. Patches add a
  `n.no_comma_op` bail in both `val.close` and `expr.close`. The
  bail matches `[INFIX]` with a src-equals-`,` cond so it works
  with the C plugin's `PUNC_COMMA` lex (which is distinct from
  jsonic-default `CA`).
- 4 new unit tests: 3 function-pointer shapes (variable / multi-
  param / multi-pointer) plus a top-level static_assert with a
  type-form sizeof in the cond.

### Architecture decision

The 1.0.0 release notes called the legacy `structure.ts` path "a
fallback for shapes the new grammar doesn't yet cover". 2.0.0
formalises the hybrid as the **final** architecture rather than a
transitional one:

- The grammar covers the common shapes — every variable / function
  declaration, every C statement, every val-position construct,
  every preprocessor directive, struct / union / enum bodies,
  attribute specs in three forms, leading-position function
  pointers (new in 2.0).
- The legacy chomp + `structure.ts` post-processor remains as the
  safety net for the long tail: top-level `static_assert` (where
  the comma-separator clashes with the comma operator inside an
  active Pratt expression), K&R `int f(a, b) int a; long b; { … }`
  parameter lists, and any complex declarator the dispatcher's
  lookahead doesn't accept.
- Both paths produce identical CST: `@looks-simple-decl` decides
  which path runs, but the consumer sees one tree shape regardless.

This matches how production C parsers (GCC, Clang) split between
their LR / handwritten core and special-case handlers for
historic / edge constructs.

### Tests

- 293 / 293 pass (89 unit + 100 csmith parse + 100 csmith fixture
  + 4 suite scaffolding).

### Known limitations (legacy chomp+structure path)

- K&R parameter lists (`int f(a, b) int a; long b; { … }`) — rare
  in modern code; csmith never generates them.
- Complex compound declarators beyond simple function pointers
  (e.g. `int (*arr[N])(int);` arrays of function pointers,
  `int (*(*fpp))(int);` pointer-to-function-pointer).

## 1.0.0

Continues the grammar-driven migration: adds rules for tagged-type
specifiers, attribute specs, top-level preprocessor directives,
top-level GCC `__asm__`, and standalone struct / enum definitions.
Csmith fixtures regenerate against the updated CST shapes — most
tag definitions, attribute placements, and directives now flow
through the grammar instead of the legacy chomp+structure
post-processor.

### Added

- `struct_specifier`, `union_specifier`, `enum_specifier` rules
  with `member_decl_list` / `struct_declaration` /
  `struct_declarator` / `bitfield_width` (struct-with-body and
  bitfields), `enumerator_list` / `enumerator` (enum body), and
  C23 `enum E : int { … }` fixed-underlying-type support.
- `attribute_spec_gcc` (`__attribute__((…))`),
  `attribute_spec_msvc` (`__declspec(…)`),
  `attribute_spec_c23` (`[[ … ]]`), with `attribute_item` and
  `attribute_argument_list`. Wired as leading specifiers and via
  `spec_loop` for between-specifier placements.
- Top-level preprocessor directives: `define_directive` (with
  `macro_parameter_list` and `macro_body`), `undef_directive`,
  `include_directive` (angled / quoted / macro-form),
  `conditional_directive` (#if / #ifdef / #ifndef / #elif /
  #elifdef / #elifndef / #else / #endif), `simple_directive`
  (#pragma / #error / #warning / #line and unknown directives).
  Macro registration / un-registration on `cmeta.macros` happens
  synchronously when `#define` / `#undef` parse, and pre-fetched
  lookahead tokens are reclassified in place.
- Top-level GCC `__asm__` blocks dispatch into the existing
  `asm_statement` rule (added in 0.2.0).
- `static_assert_declaration` grammar rule (used by struct-member
  dispatch; top-level dispatch deferred pending comma-operator
  gating in `@jsonic/expr`).
- `structureConditionalGroups` moved from `src/structure.ts` to
  its own `src/conditional-groups.ts` module — self-contained,
  no dependency on the rest of `structure.ts`.

### Tests

- 289 / 289 pass (85 unit + 100 csmith parse + 100 csmith fixture
  + 4 suite scaffolding). All csmith corpus files now flow
  through the grammar for struct definitions, attribute specs,
  and preprocessor directives.

### Known limitations (still on the legacy chomp+structure path)

- Top-level `static_assert(cond, msg);` — the `,` between cond
  and msg conflicts with the comma operator in `C_OP_TABLE`.
  Resolving cleanly needs flag-gated suppression of comma-op
  inside the static_assert paren context. Struct-member
  static_assert is handled by the new path.
- K&R parameter lists (`int f(a, b) int a; long b; { … }`).
- Complex declarators: function pointers, function-returning-
  function (`int (*fp)(int);`).

CST shapes match the legacy chomp+structure output byte-for-byte
for the 100-file csmith corpus (fixtures regenerated). Consumers
that depended on the 0.2.0 CST shape see the same node kinds and
fields; the only differences are in subtle trivia placement and
the path the parser took to produce them.

## 0.2.0

First public release of the grammar-driven parser.

The parser is now structured as a hybrid:

- `@jsonic/expr`-driven Pratt expression parsing with custom val
  open-alts for C-only constructs (`sizeof ( type )`, cast,
  compound literal, `_Generic`, GCC statement-expression, brace
  initializer list, adjacent-string concatenation).
- Declarative grammar (in `c-grammar.jsonic`, embedded into
  `src/c.ts` at build time) for declarations, function definitions,
  and the full statement family (compound, if/else, while, do,
  switch, for, labeled, jump, expression, asm, preprocessor-line).
- A legacy `structure.ts` post-processor as a fallback for shapes
  the new grammar doesn't yet cover (struct / union / enum
  specifiers, attribute specs in three forms, top-level
  preprocessor directives, top-level GCC `__asm__`,
  `static_assert`, K&R parameter lists, complex declarators).

Both paths produce the same CST shape, so consumers see one tree
regardless of which path parsed a given external declaration.

### Added

- Grammar rules for every variable declaration form (storage class,
  multi-keyword type, comma-separated declarators, pointer + array
  postfix, function declarator, K&R-empty / `(void)` /
  `(<type> ID, …)` / abstract parameter shapes).
- Grammar rules for every C statement: `compound_statement`,
  `expression_statement`, `jump_statement` (return / break /
  continue / goto), `if_statement` with optional `else`,
  `while_statement`, `do_statement`, `switch_statement`,
  `for_statement` with `for_controls` / `for_init` / `for_cond` /
  `for_iter` slots, `labeled_statement` (`case` / `default` / ID
  label), `asm_statement` (qualifiers, template, four
  colon-separated sections), `preprocessor_line`.
- Grammar rules for every val-position construct: cast,
  compound literal, sizeof type-form, _Alignof, `_Generic`, GCC
  statement-expression, brace initializer list with designated
  members and indices, adjacent string-literal concatenation,
  function calls and subscripts via `@jsonic/expr` paren-preval.
- Recognition of C23 keyword constants `nullptr`, `true`, `false`
  as `literal_expression` atoms.
- 100-file CSmith corpus regression test (corpus and gzipped JSON
  fixtures committed; `csmith` binary not required at test time).

### Tests

- 289 / 289 pass (85 unit + 100 csmith parse + 100 csmith fixture
  + 4 suite scaffolding).

### Known limitations

- K&R-style parameter declarations and unguarded GCC
  `__extern_inline` declarations parse to a `declKind: 'unknown'`
  external declaration with the original tokens preserved as
  children.
- Compound literals of struct types (`(struct point){ … }`) inside
  function bodies are not yet structured as a single
  `compound_literal` node; the surrounding declaration falls back
  to the legacy chomp.
