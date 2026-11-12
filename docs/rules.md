# Declarations in the rules

The maintainer ruled on 2026-11-11 (amending admin ADR-33's ruling 7)
that C's declaration structuring moves into its grammar's rules, in every
runtime, so that a rule pass opens and closes every node; that the
members which repeat a subtree `children` holds are left to an API; and
that C then ships a transducer part, gives up `whole`, and streams. This
page is the design the change follows, and what it measured. alchemy's
`docs/streaming-plan.md`, section 13.2, has the evidence that led to the
ruling.

The TypeScript reader builds the tree this page describes from 0.6. The
Go and Rust readers build 0.5's tree until they move to it, reading the
0.5 copies of the fixtures (`test/spec-0.5/`,
`ts/test/spec-0.5/path-dispatch.tsv`, `ts/test/csmith-fixtures-0.5/`)
and keeping the 0.5 grammar (`go/c-grammar.jsonic`,
`rs/c-grammar.jsonic`); see "Order".

## What the parser did up to 0.5

An external declaration took one of two paths. A rule path:
`external_declaration` dispatched on its head to `simple_declaration`,
the statement rules, the struct, enum, attribute, asm, preprocessor and
static_assert rules, and `@tabnas/expr` for expressions. A legacy path:
a chomp absorbed the declaration's tokens one pass each, and a
recursive-descent structurer (`structure.ts`, with its own expression
parser in `expr.ts`) built a tree from them after the last. Plain mode
sent a declaration with a type or storage head to the rules; extended
mode first asked a lookahead validator, `@looks-simple-decl`. Every other
declaration went to the structurer, which accepted any token run, and a
post-pass folded `#if` ... `#endif` runs into conditional groups.

Measured over the 100 Csmith programs, the 117 shared fixtures and 208
real-world files (the 148 headers of `/usr/include` and 60 `.c` files),
with the TypeScript reader at 0.5.15:

- **The paths built different trees.** The structurer kept an operator
  and a call's parentheses and commas as tokens where the rules kept `op`
  and dropped them, and left an array size, a bit-field width and a few
  conditions as bare tokens. Since the validator's answer depended on the
  state of the lookahead buffer, the same declaration got either tree
  depending on what came before it.
- **Every Csmith function body was the structurer's,** all 904, since
  each is longer than the validator's 256 tokens, and the rule path had
  defects only long bodies meet: `(e)` read as `e()`, `(int)a + b`
  casting `a + b`, `*p++` binding the `*` first, `a.b[1]` subscripting
  `b`, `(long)(int)a` refused, a chained ternary overflowing the stack, a
  prefix operator first in a brace list kept as `@tabnas/expr`'s raw
  operator array, an `else`, a `do`'s `while` and a label's statement
  read as the next statement, a struct, union or enum in a parameter read
  as tokens, `_BitInt(N)` after another specifier losing its keyword, and
  `static inline` and every other order of specifiers refused.
- **The structurer was what extended mode accepted.** It took any token
  run the validator declined. It also ran out of memory on 31 of the 208
  real-world files and on some malformed asm.

## One path, dispatched on the head

Every external declaration is built by rules: `structure.ts`, `expr.ts`,
the chomp and the fold are gone, and so is `viaPath`.
`external_declaration` dispatches on its head token:

| Head | Rule | Route |
|---|---|---|
| `#` | `preprocessor_directive` | strict in extended mode, armed in plain mode |
| `static_assert`, `_Static_assert` | `static_assert_declaration` | strict |
| `asm`, `__asm`, `__asm__` (extended) | `asm_statement` | strict |
| a type, storage, `_BitInt` or `[[` head (plain mode) | `simple_declaration` | strict |
| a head `@looks-simple-decl` accepts (both modes) | `simple_declaration` | strict |
| any other declaration specifier: storage class, type specifier or qualifier, typedef name, `struct`, `union`, `enum`, `_BitInt`, `typeof`, `alignas`, function specifier, attribute, `__extension__` (`#DECL_HEAD`) | `simple_declaration` | armed |
| anything else: an identifier, a macro, a stray punctuator | `unknown_declaration` | its tokens, flat |

A strict route is one 0.5 held to the rules: a declaration the rules
cannot parse there is refused, with the rules' code. An armed route is
one 0.5 handed to its structurer. The validator stays for that one
answer: which declarations are strict.

## Acceptance: the fallback

An armed declaration is the token run 0.5's chomp absorbed, and that run
ends where the chomp ended it: after a `;` at brace depth 0, after the
newline that ends a `#` line, after a `}` back to depth 0 when the next
token starts a declaration (the chomp's own test, `startsNewDeclaration`
in `ts/src/fallback.ts`), or at the end. Inside it:

- **The catch-all.** Every rule below `external_declaration` has a last
  alternate, in each state, that marks the declaration failed where no
  other alternate matches. **The bail.** Its first alternate, once the
  declaration has failed, ends the state without taking a token, and its
  lifecycle actions do nothing. The rules close down to
  `external_declaration`, whose close turns the declaration into an
  unknown one: the tokens it has taken, flat, and the rest of the run, up
  to the chomp's end (`unknown_declaration`).
- **The fence.** Every alternate that takes a token is held back once
  the tokens taken reach the chomp's end, so the rules end there or fail
  there. A declaration the rules end before the chomp's end (a function
  body followed by a macro use) takes the rest of the run, flat, after
  what the rules built.
- **A ref that throws** a JavaScript error in an armed declaration fails
  it, as an unmatched alternate does.

`withFallback` (`ts/src/fallback.ts`) adds the alternates and wraps the
refs when the grammar is installed. Nothing is rewound and nothing
probes: the plugin records the tokens it lexes (the sub-lex hook) and
trims the record at each declaration's start, and the engine's count of
the tokens taken (`ctx.vAbs`) says how many the declaration holds. So an
armed declaration is accepted whatever it holds, as the structurer
accepted it, and the next declaration starts where it started.

One rule catches a failure below it as the declaration does:
`asm_operand`, whose operand 0.5's rules took flat whatever it held. A
failure inside an operand (a local scope, `openLocal`) makes the operand
flat from its first token, and `asm_operand_rest` takes the rest of its
tokens up to the `,`, `:` or `)` that ends it at depth 0.

**The names a declaration binds** decide how later tokens lex, so an
armed declaration binds what 0.5 bound for its run, read from its tokens:
the typedef names of a run that starts with `typedef` and ends with `;`
(`registerTypedefIfApplicable`), and the macro each `#define` and
`#undef` line in it names (`registerMacrosFromTokens`), unless the run is
an unknown declaration that does not start with `#`, which the
structurer did not read. A strict declaration binds the typedef names its
rules found, and a strict `#define` binds its macro as its name lands.

**0.5's lenient endings stay** where a strict declaration relied on them:
a declarator after a declarator with no comma between (`int a b;`, a
member's `long a MACRO;`) is the declaration's next one, and its name is
the one the run binds, as 0.5 bound it; `default` or a label with no `:`
ends there; a `do` with no `while` ends after its body; an `else`, a
label and a `case` before a `}` or a declaration take no statement. An
armed declaration fails at the declarator with no comma, where 0.5's
structurer gave up. Where a lenient ending let an unfinished construct
through, it goes: a designator ends with its member's name or its `]`,
and a `static_assert` with its `)` and its `;`. In extended mode a
malformed declaration that 0.5's structurer gave up on is built where the
rules read it as plain mode always has: a declarator list that starts
with a comma, two declarations with no `;` between, a `__declspec(` with
no `)`.

## Expressions are read by expr

C reads its expressions with `@tabnas/expr` (0.6.1 or later), in every
runtime: the maintainer ruled that C uses expr, and that expr is fixed
where it falls short of C. `ts/src/expr-grammar.ts` installs it over
C's grammar with C's operator table and the options expr has for a
language like C (expr's `ts/doc/reference.md`):

- a binding power on a call's and a subscript's parenthesis, so
  `a.b[1]` subscripts `a.b` and `a.b(1)` calls it;
- a cast at the unary level, accepted where the group holds a type name;
- the comma operator beside separators: a call's arguments are a
  separated list, and so is every context but an expression statement,
  a `return`, a condition, a `for`'s controls and an asm operand's value
  (`n.expr_sep`);
- `juxtapose: false`, with C's identifiers and literals as expr's
  `values`, so values side by side are refused wherever they stand;
- a required content, so `()` and `a[]` are refused;
- the conditional as a ternary with binding powers between assignment
  and `||`, so `x = a ? b : c` is `x = (a ? b : c)`.

A context pushes `val` where C's grammar names an expression, and
expr's evaluate callback builds C's node for each operation, from the
root down once the expression has ended, with the shapes the tree had:
an operator is `op`, a call drops its parentheses and commas, and a
dropped token's comments stay as the node's children at its place. The
tokens expr does not hand over with an operation (a paren's opener, a
call's commas, a conditional's `:`) are reached through links the
sub-lex hook makes as the tokens are lexed. A cast whose operand starts
with a brace list is a compound literal, which the postfix operators
after it apply to. `sizeof ( type )`, `_Generic`, GCC statement
expressions, brace lists and adjacent strings are C's rules, which
`val` opens. The armed fallback covers the rules expr reads with, its
own and jsonic's.

An expression in parentheses, a call's arguments and a subscript end
with their `)` or `]`, and a conditional with its `:` and its third
operand: nothing else ends them. Each expression is evaluated into C's
nodes iteratively, so a chain of 10,000 operators adds no depth to the
call stack, and its rules repeat by replacement (`ts/test/repeat.test.ts`).

## Conditional groups are rules

A `#if`, `#ifdef` or `#ifndef` line where an external declaration may
start opens a `conditional_group`: `extdecl_loop` hands the line to the
group, whose first `conditional_branch` holds it and the declarations up
to the next `#elif`, `#elifdef`, `#elifndef`, `#else` or `#endif` line
(`k.inBranch`); each later branch starts with its own line, and the
`#endif` line ends the group. An `#endif`, `#elif` or `#else` with no
group open is a flat external declaration, as the fold left it. An
unterminated `#if` is a group that ends with the document, where the fold
left it flat; so a header guard, which wraps a whole file, streams.

## The tree

One tree, the same in all three runtimes once they move. Every node is
opened and closed by the passes of the rule that builds it, `children`
holds each subtree once, no node holds itself, and a node's other
members are scalars (`op`, `name`, `declKind`, `declaredName`,
`literalKind`, `macroParams`, and the like). What changes from 0.5:

- The members that repeat a child are gone: `operand`, `target`,
  `object`, `typeName`, `cond`, `then`, `else`, `value`, `designation`,
  `init`, `iter`, `condition`, `message`, `controlling`, `associations`,
  `expression`, `items`, `argumentList`, `template`, `asm_outputs`,
  `asm_inputs`, `asm_clobbers`, `asm_labels`, `asmName`, `constraint`,
  `endif`, `directive`. So is `viaPath`.
- A declaration 0.5's structurer built takes the rules' tree: an
  operator is `op`, not a token; a call's parentheses and commas, a
  parenthesised expression's parentheses and a member access's `.` or
  `->` are not kept; a cast keeps its parentheses; a `goto`'s label is a
  token; a parameter's array postfix follows its direct declarator; a
  parameter with no name holds a `declarator`; every `declaration` has a
  `declKind`.
- The rule path's defects are repaired (above), so a parenthesised
  expression is a `paren_expression`, and the manifest's loss list loses
  `(f)` against `f()` and the brace-list item the Rust reader drops once
  every runtime has moved.
- An asm operand is `asm_name`, `asm_constraint` and `asm_value`, as the
  structurer built it; a `#` line in a body is its directive's node; an
  attribute or an asm label after a declarator is the init declarator's;
  `typeof` and `alignas` keep their parentheses' tokens in the
  specifiers.
- A node's span is the span of the first token it keeps, comments left
  out; a node that keeps no token takes its parent's (`fixSpans`).
- Every comment is kept but one after the last token: a comment is a
  child, in source order, of the node that keeps the token it precedes,
  or of the node that drops it, at the dropped token's place. `trivia`
  stays on every node, empty.
- An external declaration that starts with an identifier or a macro is
  unknown, where the structurer guessed an implicit `int` for some, and
  so is `extern "C" {`, which it read as a function definition with a K&R
  list.

## The members, by API

`member(node, name)` (TypeScript, `ts/src/members.ts`; `Member(node,
name)` in Go and `member(node, name)` in Rust once they move) gives back
a member the tree no longer holds, from the node's children, by kind or
by place among its child nodes:

| Node | Members |
|---|---|
| `unary_expression` | `operand` |
| `postfix_unary_expression`, `subscript_expression` | `target` |
| `member_expression` | `object` |
| `cast_expression` | `typeName`, `operand` |
| `compound_literal` | `typeName` |
| `conditional_expression` | `cond`, `then`, `else` |
| `initializer_item` | `designation`, `value` |
| `for_controls` | `init`, `cond`, `iter` |
| `for_init`, `for_cond`, `for_iter` | `value` |
| `static_assert_declaration` | `condition`, `message` |
| `generic_selection` | `controlling`, `associations` (a list) |
| `generic_association` | `typeName`, `value` |
| `generic_controlling_expression`, `asm_template`, `asm_value` | `expression` |
| `attribute_spec` | `items` (a list) |
| `attribute_item` | `argumentList` |
| `asm_statement` | `template`, `asm_outputs`, `asm_inputs`, `asm_clobbers`, `asm_labels` |
| `asm_operand` | `asmName`, `constraint`, `value` |
| `conditional_group` | `endif` |
| `conditional_branch` | `directive` |

`test/spec/members.tsv` holds the readers to the same answers.

## Context

The typedef-name ambiguity stays where it is decided, in the lexer: the
identifier matcher reads the symbol table, a typedef's names are bound
when its external declaration ends, and the lookahead tokens already
lexed are reclassified. Macro names are bound by a `#define` and unbound
by `#undef`. Every other choice is a fixed lookahead of at most three
tokens, as the grammar's alternates make them: a cast's `(` and a type's
head, a label's identifier and `:`, an asm name's `[`, name and `]`, a
directive's `#` and name, the adjacent `[[`. No rule probes or rewinds.

## Repetition

Every repetition is a replace loop, the item pushed by the loop's open
state, or a close state the item returns to: a translation unit's and a
branch's declarations, a group's branches, a block's items, a list's
items, a binary chain, a postfix chain, an unknown declaration's tokens,
an operand's flat tokens. `ts/test/repeat.test.ts` repeats each of 21
items 10,000 times and holds the deepest rule to what one item needs.

## What was measured

With the TypeScript reader of this change against 0.5.15:

- **The shared fixtures**: every row's difference from its old expected
  value is a span (the rule path's nodes had none), the statement nesting
  above, or a `declKind` on a block declaration, and the rows were
  regenerated (`test/spec-0.5/` keeps the old ones).
- **Csmith**: every one of the 7,237 declarations 0.5's structurer built
  is built by the rules with the same structure under a normalisation of
  the conventions above (the scratch tool `decl-diff`), and every
  declaration the rule path built is unchanged but for the repaired
  defects (1,548 raw operator arrays, 722 `(e)` read as a call). The
  fixtures were regenerated (`ts/test/csmith-fixtures-0.5/` keeps the old
  ones). No declaration became unknown.
- **The real-world files**: each is accepted or refused as 0.5 does, in
  both modes, except the 31 on which 0.5 runs out of memory; 0.6 parses
  29 of those and refuses 2 at an unknown type name. In extended mode
  149 declarations of 49 files that 0.5's structurer built are unknown
  in 0.6. 77 name a type no included header defines (`FILE`, `size_t`),
  which the structurer took for a type name: with those names bound as
  typedef names the rules build all 77. 70 hold a macro where the syntax
  needs a declarator or a specifier (`__THROW`,
  `__REDIRECT_NTH (f, (...), g)`, `__exctype (isalnum);`) or C++
  (`extern "C" {`). One drops its type (`PANEL;`), and one has a pointer
  before a parenthesised declarator (`typedef char *(*f)(...)`), which
  the rules do not read; 0.5's rules refuse it in a struct and in a
  function body too.
- **Comments**: every comment of every accepted fixture, Csmith program
  and real-world file is in the tree, but those after the last token
  (`ts/test/tree.test.ts` holds the fixtures and Csmith to it).
- **The render**: every plain-mode fixture's tree is written by
  `alchemy/render.alc` and reads back as the same tree, spans included,
  and so are trees with a comment where an operator, a comma or a
  parenthesis is dropped, and a file of 90 expression statements that
  holds every operator, a call of no arguments on every kind of callee,
  casts, compound literals and `_Generic`, in both modes. A node's
  pieces are placed among its operands in one pass: a call of 2,500
  arguments is written in 4.3 s, 5,000 in 7.3 s and 10,000 in 16 s, where
  counting each operand's place over the whole list took 22.3 s and
  83.7 s for the first two.
- **Acceptance** over 10,708 documents, the fixtures, declarations of six
  Csmith programs and small headers, each mutated at 12 places, in both
  modes: the differences are the classes below, and the inputs on which
  0.5 crashes. A second sweep, over 24,432 documents, deletes every token
  of every fixture and of 400 statements of the Csmith programs in turn
  and doubles every punctuator, in both modes: the review of this change
  found the unfinished constructs the first one missed (`f(1;`, `a ? b;`).
  Each document whose acceptance or count of unknown declarations
  changed is held to a syntax oracle: pycparser over clang's
  preprocessor output, and clang's own parse errors where pycparser does
  not read a GNU or C23 form. None that 0.5 refuses is accepted unless
  it is syntactically valid C, and none that is syntactically valid and
  0.5 accepts is refused. A declaration 0.6 makes unknown where 0.5
  built one is not C23: all but a handful drop a type specifier or a
  typedef name, which C before C99 read as an implicit `int`, and the
  rest are malformed (`int add( a, int b)`, a label with no `:`).

Reading the expressions with expr (above) in place of C's own expression
rules, which this change first wrote, left every tree and every answer
the same, over the fixtures, the Csmith programs, both sweeps in both
modes and the real-world files: of the documents refused, 212 are
refused at another token, in each case the one 0.5 refuses at (`s.;` at
the `;`, as 0.5 does, where C's own rules refused at the `.`).

The maintainer approved the two changes to what is accepted or refused:
valid C that 0.5 refuses only by its rule path's defects (a
cast of a cast, the comma operator in a condition, a `return` or an
expression statement, a chained ternary, `static inline` and every
order or repetition of the declaration specifiers, an assignment as a
brace-list item, a member of any postfix expression (`{ .x = 1 .y = 2 }`),
`(void*)0 & x`) is accepted; invalid C that 0.5 accepted through jsonic's
implicit lists (values side by side in an expression: in parentheses, a
call's arguments, a `for`'s controls, a `static_assert`'s condition or
an initializer), an empty subscript (`a[]`), empty parentheses (`()`,
`sizeof()`), or its rules' lenient endings (a designator with no name or
no `]`, `{ . = 1 }` and `{ [4 = 50 }`, and a `static_assert` with no `)`
or no `;`) is refused. `test/spec/unfinished.tsv` and the rows beside it
pin both.

## The part

C's transducer part reads the rule passes with token items
(`parser-events input :tokens`) and holds one external declaration at a
time: a binary chain's root is known last, and an armed declaration may
still become unknown. It writes each node from the passes of the rule
that builds it, a node's span from its first token's offset, row and
column, and each comment where the reader puts it. A conditional group
is written as its passes arrive: it opens at its `#if` and closes at its
`#endif`. Once the part streams, the manifest's `translate` object loses
`whole`, and the whole parser declares `lex.window` once its matchers
are verified at the window's edge.

## Order

1. TypeScript: the rules, the tree, the API, the fallback, the tests and
   the fixtures. The shared fixtures and the Csmith fixtures move to the
   new tree; until the ports follow, Go and Rust read the 0.5 copies, so
   every pull request is green on its own, and `ts/embed-grammar.js`
   does not copy the grammar to them.
2. Go and Rust, to the same tree; the 0.5 copies go.
3. The part, the window, the manifest and the render; the release, a
   minor version, 0.6.0, since the tree changes.
