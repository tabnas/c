/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Phase A wiring for @jsonic/expr on the main jsonic instance.
//
// The plugin's `op:` table is consumed by makeOpMap which calls
// `jsonic.fixed(src)` to discover an existing tin for each operator's
// source. Because c.ts already registers PUNC_PLUS / PUNC_LPAREN /
// etc. in `fixed.token`, @jsonic/expr reuses those tins instead of
// minting fresh `#E+` ones — and the plugin's val-rule alts therefore
// match the very tokens our lex matchers emit.
//
// Phase A scope:
//   * Define the full C operator catalog using @jsonic/expr's OpDef
//     shape.
//   * `installExpr(jsonic)` calls jsonic.use(Expr, { op, evaluate })
//     and adds C-atom open alts to the val rule (LIT_INT / LIT_FLOAT
//     / LIT_CHAR / LIT_STRING / ID / MACRO_NAME / TYPEDEF_NAME). Each
//     atom alt produces a leaf CST node so the evaluate callback can
//     splice it into the surrounding expression.
//   * `evaluateCExpr(rule, ctx, op, terms)` converts @jsonic/expr's
//     S-expression nodes into the same CST shapes the rest of the
//     parser emits (binary_expression, assignment_expression, etc.).
//
// The main grammar in c-grammar.jsonic does NOT yet descend into val;
// that's phase B. Installing the plugin is functionally a no-op for
// existing tests because the chomp rule never reaches val.

import type { Tabnas, Rule, RuleSpec, Context, Token } from '@tabnas/parser'
import { Expr } from '@tabnas/expr'
import type { ExprOptions, Op } from '@tabnas/expr'

// ---- C operator table ---------------------------------------------
//
// Precedence convention (matches @jsonic/expr's prattify logic):
//   left-assoc:  left  <  right    (next same-prec op wraps)
//   right-assoc: left  >  right    (next same-prec op drills)
// Numbers are spaced by 1_000 so future operators slot in without
// renumbering, following the rjrodger/aontu convention.

export const C_OP_TABLE: ExprOptions['op'] = {
  // ---- comma (lowest binary; left-assoc)
  'comma':    { src: ',',   infix: true, left: 1_000, right: 1_001 },

  // ---- assignment (right-assoc — left > right)
  'assign':   { src: '=',   infix: true, left: 2_001, right: 2_000 },
  'plus_a':   { src: '+=',  infix: true, left: 2_001, right: 2_000 },
  'minus_a':  { src: '-=',  infix: true, left: 2_001, right: 2_000 },
  'star_a':   { src: '*=',  infix: true, left: 2_001, right: 2_000 },
  'slash_a':  { src: '/=',  infix: true, left: 2_001, right: 2_000 },
  'pct_a':    { src: '%=',  infix: true, left: 2_001, right: 2_000 },
  'lsh_a':    { src: '<<=', infix: true, left: 2_001, right: 2_000 },
  'rsh_a':    { src: '>>=', infix: true, left: 2_001, right: 2_000 },
  'amp_a':    { src: '&=',  infix: true, left: 2_001, right: 2_000 },
  'crt_a':    { src: '^=',  infix: true, left: 2_001, right: 2_000 },
  'pipe_a':   { src: '|=',  infix: true, left: 2_001, right: 2_000 },

  // ---- ternary (`? :` paired)
  'tern':     { src: ['?', ':'], ternary: true, left: 3_001, right: 3_000 },

  // ---- binary (logical-or → multiplicative; left-assoc)
  'or':       { src: '||', infix: true, left: 4_000,  right: 4_001 },
  'and':      { src: '&&', infix: true, left: 5_000,  right: 5_001 },
  'bor':      { src: '|',  infix: true, left: 6_000,  right: 6_001 },
  'bxor':     { src: '^',  infix: true, left: 7_000,  right: 7_001 },
  'band':     { src: '&',  infix: true, left: 8_000,  right: 8_001 },
  'eq':       { src: '==', infix: true, left: 9_000,  right: 9_001 },
  'ne':       { src: '!=', infix: true, left: 9_000,  right: 9_001 },
  'lt':       { src: '<',  infix: true, left: 10_000, right: 10_001 },
  'le':       { src: '<=', infix: true, left: 10_000, right: 10_001 },
  'gt':       { src: '>',  infix: true, left: 10_000, right: 10_001 },
  'ge':       { src: '>=', infix: true, left: 10_000, right: 10_001 },
  'lsh':      { src: '<<', infix: true, left: 11_000, right: 11_001 },
  'rsh':      { src: '>>', infix: true, left: 11_000, right: 11_001 },
  'plus':     { src: '+',  infix: true, left: 12_000, right: 12_001 },
  'minus':    { src: '-',  infix: true, left: 12_000, right: 12_001 },
  'star':     { src: '*',  infix: true, left: 13_000, right: 13_001 },
  'slash':    { src: '/',  infix: true, left: 13_000, right: 13_001 },
  'pct':      { src: '%',  infix: true, left: 13_000, right: 13_001 },

  // ---- prefix unary
  'pre_inc':  { src: '++', prefix: true, right: 16_000 },
  'pre_dec':  { src: '--', prefix: true, right: 16_000 },
  'unary_p':  { src: '+',  prefix: true, right: 16_000 },
  'unary_n':  { src: '-',  prefix: true, right: 16_000 },
  'lnot':     { src: '!',  prefix: true, right: 16_000 },
  'bnot':     { src: '~',  prefix: true, right: 16_000 },
  'deref':    { src: '*',  prefix: true, right: 16_000 },
  'addr':     { src: '&',  prefix: true, right: 16_000 },

  // sizeof / _Alignof / _Alignof variants. C makes these unary
  // prefix operators (sizeof / _Alignof can also take a parenthesised
  // type-name; the type-form is handled separately as a val open
  // alt — Phase C). Their src strings already exist as KW_*
  // fixed tokens, so @jsonic/expr's fixed() lookup finds them and
  // reuses the same tin instead of creating an `#Esizeof` token.
  'sizeof':   { src: 'sizeof',    prefix: true, right: 16_000 },
  'alignof':  { src: '_Alignof',  prefix: true, right: 16_000 },
  'alignof_g':  { src: 'alignof', prefix: true, right: 16_000 },
  'gnualignof': { src: '__alignof__', prefix: true, right: 16_000 },
  'gnualignof_s': { src: '__alignof', prefix: true, right: 16_000 },

  // ---- postfix
  'post_inc': { src: '++', suffix: true, left: 17_000 },
  'post_dec': { src: '--', suffix: true, left: 17_000 },

  // ---- member access (infix; right operand is an identifier)
  // Member access is left-associative: `a.b.c` → `(a.b).c`.
  // Pratt convention here is left < right ⇒ left-assoc (matches mult,
  // add, etc).
  'dot':      { src: '.',  infix: true, left: 17_000, right: 17_001 },
  'arrow':    { src: '->', infix: true, left: 17_000, right: 17_001 },

  // ---- paren forms
  // Calls and subscripts use preval (a value precedes the opener);
  // grouping doesn't.
  'paren':    { osrc: '(', csrc: ')', paren: true,
                preval: { active: false } },
  'call':     { osrc: '(', csrc: ')', paren: true,
                preval: { active: true } },
  'subscript':{ osrc: '[', csrc: ']', paren: true,
                preval: { active: true, required: true } },
}

// ---- evaluate callback: S-expression → my CST shape ---------------
//
// @jsonic/expr produces nested arrays `[op, term, term, ...]` and
// invokes the evaluate callback to combine them. We emit the same CST
// node shapes the existing post-processor produces, so the rest of
// the codebase (and the structural test suite) keeps working as the
// rule machinery takes over expression contexts in phase B.

export function evaluateCExpr(
  _rule: Rule, _ctx: Context, op: Op, terms: any[],
): any {
  const span = (terms[0] && terms[0].span) || tokenSpan(op.token) || zeroSpan()

  if (op.name === 'comma-infix' || op.name === 'comma') {
    const out = makeNode('comma_expression', span)
    for (const t of terms) {
      if (t && t.kind === 'comma_expression') {
        for (const c of t.children) out.children.push(c)
      } else if (t !== undefined) {
        out.children.push(t)
      }
    }
    return out
  }

  if (op.ternary) {
    const out = makeNode('conditional_expression', span)
    if (terms[0] !== undefined) { out.children.push(terms[0]); out.cond = terms[0] }
    if (terms[1] !== undefined) { out.children.push(terms[1]); out.then = terms[1] }
    if (terms[2] !== undefined) { out.children.push(terms[2]); out.else = terms[2] }
    return out
  }

  if (isAssignName(op.name)) {
    const out = makeNode('assignment_expression', span)
    if (terms[0] !== undefined) { out.children.push(terms[0]); out.left = terms[0] }
    if (terms[1] !== undefined) { out.children.push(terms[1]); out.right = terms[1] }
    out.op = op.src
    return out
  }

  if (op.name === 'dot-infix' || op.name === 'arrow-infix') {
    const out = makeNode('member_expression', span)
    if (terms[0] !== undefined) { out.children.push(terms[0]); out.object = terms[0] }
    if (terms[1] !== undefined) {
      out.children.push(terms[1])
      if (terms[1].name) out.memberName = terms[1].name
    }
    out.op = op.src
    return out
  }

  if (op.name === 'call-paren') {
    const out = makeNode('call_expression', span)
    const callee = terms[0]
    if (callee !== undefined) {
      out.children.push(callee)
      if (callee.kind === 'identifier_expression') {
        out.callee = callee.name
        const idTok = (callee.children || []).find(
          (c: any) => c && c.kind === 'token',
        )
        out.isMacro = !!(idTok && idTok.tname === 'MACRO_NAME')
      }
    }
    const args = makeNode('argument_list', span)
    if (Array.isArray(terms[1]) && (terms[1] as any).OP_MARK === undefined) {
      // @jsonic/expr returns an implicit list when commas appear inside
      // the parens — splice all of those as separate args.
      for (const a of terms[1]) args.children.push(a)
    } else if (terms[1] !== undefined && terms[1].kind === 'comma_expression') {
      for (const c of terms[1].children) {
        if (c.kind !== 'token') args.children.push(c)
      }
    } else if (terms[1] !== undefined) {
      args.children.push(terms[1])
    }
    out.children.push(args)
    return out
  }

  if (op.name === 'subscript-paren') {
    const out = makeNode('subscript_expression', span)
    if (terms[0] !== undefined) { out.children.push(terms[0]); out.target = terms[0] }
    const idx = makeNode('index_list', span)
    if (terms[1] !== undefined) idx.children.push(terms[1])
    out.children.push(idx)
    return out
  }

  if (op.name === 'paren-paren') {
    const out = makeNode('paren_expression', span)
    if (terms[0] !== undefined) out.children.push(terms[0])
    return out
  }

  if (op.prefix) {
    const out = makeNode('unary_expression', span)
    out.op = op.src
    if (terms[0] !== undefined) { out.children.push(terms[0]); out.operand = terms[0] }
    return out
  }
  if (op.suffix) {
    const out = makeNode('postfix_unary_expression', span)
    out.op = op.src
    if (terms[0] !== undefined) { out.children.push(terms[0]); out.target = terms[0] }
    return out
  }
  if (op.infix) {
    const out = makeNode('binary_expression', span)
    out.op = op.src
    if (terms[0] !== undefined) { out.children.push(terms[0]); out.left = terms[0] }
    if (terms[1] !== undefined) { out.children.push(terms[1]); out.right = terms[1] }
    return out
  }

  // Defensive fallback.
  const out = makeNode('expression', span)
  for (const t of terms) if (t !== undefined) out.children.push(t)
  return out
}

// ---- val-rule extension for C atoms -------------------------------
//
// Adds open alts that recognise C identifiers and literals. Each alt
// produces a leaf CST node (literal_expression / identifier_expression)
// so evaluateCExpr can splice it into the surrounding expression
// directly.

export function installExpr(jsonic: Tabnas): void {
  jsonic.use(Expr, { op: C_OP_TABLE as any, evaluate: evaluateCExpr as any })

  // Add C-atom recognisers to val's open alts. These coexist with the
  // operator-aware alts that @jsonic/expr injected.
  jsonic.rule('val', (rs: RuleSpec) => {
    // Phase C.2/C.3/C.4 multi-token discriminators. These need to
    // fire BEFORE @jsonic/expr's prefix-op machinery (which would
    // treat `sizeof` as a prefix op and try to parse `( int )` as
    // a paren-expression operand) and BEFORE jsonic's default `{`
    // → map handling. Prepended via append:false.
    rs.open([
      // sizeof / _Alignof type-name form:
      // `<sizeof|_Alignof|...> ( <type-head> ...` — backstep all 3
      // matched tokens so the sub-rule re-takes them.
      { s: '#SIZEOF_KW PUNC_LPAREN #SIMPLE_TYPE_HEAD',
        b: 3, p: 'sizeof_type_form',
        g: 'c-sizeof-type' },
      // cast / compound literal: `( <type-head> ...`.
      { s: 'PUNC_LPAREN #SIMPLE_TYPE_HEAD',
        b: 2, p: 'cast_or_compound_literal',
        g: 'c-cast-or-cl' },
      // Phase C.6: GCC statement expression `( { … } )`.
      { s: 'PUNC_LPAREN PUNC_LBRACE',
        b: 2, p: 'statement_expression',
        g: 'c-stmt-expr' },
      // Phase C.5: `_Generic ( ctrl , <association>+ )`.
      { s: ['KW__GENERIC'],
        b: 1, p: 'generic_selection',
        g: 'c-generic' },
      // Phase C.4: brace initializer list as a val (e.g. RHS of
      // `int x = { 1, 2 };`).
      { s: ['PUNC_LBRACE'],
        b: 1, p: 'initializer_list',
        g: 'c-init-list' },
    ], { append: false })

    rs.open([
      // Paren-preval: a C atom immediately followed by `(` or `[` opens
      // a call/subscript expression. We back-step the paren so
      // @jsonic/expr's expr rule picks it up as a paren-form, and set
      // rule.node to the atom CST so expr uses it as the preceding
      // value. The token sets are configured in c.ts.
      { s: '#C_ATOM #C_PAREN_OPEN',
        b: 1, p: 'expr',
        a: cParenPrevalAction,
        u: { paren_preval: true },
        g: 'c-atom,c-call-preval' },
      { s: ['LIT_INT'],     a: makeAtomAction('literal_expression', 'LIT_INT'),
        g: 'c-atom,c-int' },
      { s: ['LIT_FLOAT'],   a: makeAtomAction('literal_expression', 'LIT_FLOAT'),
        g: 'c-atom,c-float' },
      { s: ['LIT_CHAR'],    a: makeAtomAction('literal_expression', 'LIT_CHAR'),
        g: 'c-atom,c-char' },
      { s: ['LIT_STRING'],  b: 1, p: 'string_atom',
        g: 'c-atom,c-str' },
      { s: ['ID'],          a: makeIdAction(),  g: 'c-atom,c-id' },
      { s: ['MACRO_NAME'],  a: makeIdAction(),  g: 'c-atom,c-macro' },
      { s: ['TYPEDEF_NAME'], a: makeIdAction(), g: 'c-atom,c-typedef' },
      // C23 keyword constants. We surface them as literal_expression
      // nodes (not identifiers) so consumers can distinguish a real
      // identifier named `nullptr` (impossible in C23, but trivial in
      // older code where the keyword wasn't reserved) from the
      // language-level constant.
      { s: ['KW_NULLPTR'],
        a: makeAtomAction('literal_expression', 'KW_NULLPTR'),
        g: 'c-atom,c-nullptr' },
      { s: ['KW_TRUE'],
        a: makeAtomAction('literal_expression', 'KW_TRUE'),
        g: 'c-atom,c-true' },
      { s: ['KW_FALSE'],
        a: makeAtomAction('literal_expression', 'KW_FALSE'),
        g: 'c-atom,c-false' },
    ], { append: true })

    // After a sub-rule (sizeof_type_form, cast_or_compound_literal,
    // …) returns to val in close state, copy its CST node onto
    // val.node so val proceeds as if the sub-rule was an atom. The
    // @jsonic/expr-installed bc on val tests `isOp(r.node)` for term
    // appending; our sub-rule produces a non-Op node so it's a no-op
    // there and ours runs after without interfering.
    rs.bc((rule: any) => {
      if (rule.child &&
          (rule.child.name === 'sizeof_type_form' ||
           rule.child.name === 'cast_or_compound_literal' ||
           rule.child.name === 'initializer_list' ||
           rule.child.name === 'string_atom' ||
           rule.child.name === 'generic_selection' ||
           rule.child.name === 'statement_expression') &&
          rule.child.node) {
        rule.node = rule.child.node
      }
    })

    // C-terminator close alts. These pre-empt jsonic's implicit-
    // list close behaviour (which would recurse into the list rule
    // on any unmatched token) so that hitting a `;`/`)`/`]`/`}`
    // exits val cleanly back to the C-grammar parent.
    //
    // PUNC_COMMA / PUNC_COLON are gated on `!r.gt('expr_paren')`:
    // inside a paren-form (call args, ternary, _Generic, etc) the
    // comma / colon is owned by @jsonic/expr's own logic, so we
    // let it through. Outside of paren-forms the surrounding
    // C-grammar rule (e.g. init_declarator's `,` between
    // declarators, or labeled_statement's `:`) wants to take it,
    // so we bail val.
    //
    // unshift (default add behaviour) puts these in front of the
    // imp-list alts, which is exactly where they need to be.
    rs.close([
      { s: ['PUNC_SEMI'],     b: 1, g: 'c-end-stmt' },
      // r.n.expr_paren is set by @jsonic/expr's paren rule; absent
      // (undefined) at top level. We check truthiness directly —
      // r.gt() treats null/undefined as ">0" so it can't be used.
      { s: ['PUNC_COMMA'],    c: (r: any) => !r.n.expr_paren,
                              b: 1, g: 'c-end-comma' },
      { s: ['PUNC_RPAREN'],   b: 1, g: 'c-end-paren' },
      { s: ['PUNC_RBRACKET'], b: 1, g: 'c-end-bracket' },
      { s: ['PUNC_RBRACE'],   b: 1, g: 'c-end-brace' },
      { s: ['PUNC_COLON'],    c: (r: any) => !r.n.expr_paren,
                              b: 1, g: 'c-end-colon' },
    ])

    // tabnas core's relaxed-JSON val close (@val-bc/replace and its
    // @val-ac restore) only preserves a PRIMITIVE node a plugin set in a
    // val open action — an object CST node is treated as a stale
    // container and overwritten with the matched token value. The C
    // atom recognisers (makeAtomAction / makeIdAction) deliberately set
    // object CST nodes, so restore them here. This runs after jsonic's
    // own @val-ac (registration order: jsonic is `use`d before C), so it
    // has the final say. Only restore when val did not already settle on
    // a richer node (a @tabnas/expr Op converted by evaluateCExpr, or a
    // sub-rule CST copied by the bc above — both carry a `.kind`).
    rs.ac((rule: any) => {
      const cn = rule.u.cNode
      if (null != cn &&
          (null == rule.node ||
           'object' !== typeof rule.node ||
           undefined === (rule.node as any).kind)) {
        rule.node = cn
      }
    })
  })
}

// Action for the paren-preval alt: builds a C atom CST node from the
// matched atom token (literal_expression or identifier_expression),
// stashes it as rule.node so @jsonic/expr's expr rule can use it as
// the preceding value of the call/subscript paren-form.
function cParenPrevalAction(rule: Rule): void {
  const tkn = rule.o0 as Token
  const ref = {
    kind: 'token', tname: tkn.name, src: tkn.src,
    span: tokenSpan(tkn),
  }
  if (tkn.name.startsWith('LIT_')) {
    const node = makeNode('literal_expression', ref.span as any)
    for (const tr of leadingTriviaRefs(tkn)) node.children.push(tr)
    node.children.push(ref)
    node.literalKind = tkn.name
    node.value = tkn.src
    rule.node = node
  } else {
    const node = makeNode('identifier_expression', ref.span as any)
    for (const tr of leadingTriviaRefs(tkn)) node.children.push(tr)
    node.children.push(ref)
    node.name = tkn.src
    rule.node = node
  }
}

function makeAtomAction(kind: string, literalKind: string) {
  return function atomAction(rule: Rule): void {
    const tkn = rule.o0 as Token
    const ref = {
      kind: 'token', tname: tkn.name, src: tkn.src,
      span: tokenSpan(tkn),
    }
    const node = makeNode(kind, ref.span as any)
    for (const tr of leadingTriviaRefs(tkn)) node.children.push(tr)
    node.children.push(ref)
    node.literalKind = literalKind
    node.value = tkn.src
    rule.node = node
    // Stash for the val after-close restore. tabnas core's relaxed-JSON
    // val close (@val-bc/replace + @val-ac) preserves only PRIMITIVE
    // plugin-set node values; an object CST node set here is treated as a
    // stale parent-seeded container and overwritten with the matched
    // token. Restore it in the C-side `ac` hook below.
    rule.u.cNode = node
  }
}

function makeIdAction() {
  return function idAction(rule: Rule): void {
    const tkn = rule.o0 as Token
    const ref = {
      kind: 'token', tname: tkn.name, src: tkn.src,
      span: tokenSpan(tkn),
    }
    const node = makeNode('identifier_expression', ref.span as any)
    for (const tr of leadingTriviaRefs(tkn)) node.children.push(tr)
    node.children.push(ref)
    node.name = tkn.src
    rule.node = node
    rule.u.cNode = node
  }
}

function leadingTriviaRefs(tkn: Token): any[] {
  const leading = (tkn as any).use && (tkn as any).use.leading
  if (!Array.isArray(leading)) return []
  return leading.map((lt: Token) => ({
    kind: 'token', tname: lt.name, src: lt.src,
    span: tokenSpan(lt),
  }))
}

// ---- Helpers -------------------------------------------------------

function tokenSpan(tkn: Token | undefined): Span | undefined {
  if (!tkn) return undefined
  return { start: tkn.sI, end: tkn.sI + tkn.len, line: tkn.rI, col: tkn.cI }
}

function zeroSpan(): Span {
  return { start: 0, end: 0, line: 1, col: 1 }
}

interface Span { start: number; end: number; line: number; col: number }

interface CNode {
  kind: string
  span: Span
  children: any[]
  trivia: { leading: any[]; trailing: any[] }
  [extra: string]: any
}

function makeNode(kind: string, span: Span | undefined): CNode {
  return {
    kind,
    span: span ?? zeroSpan(),
    children: [],
    trivia: { leading: [], trailing: [] },
  }
}

const ASSIGN_NAMES = new Set([
  'assign-infix', 'plus_a-infix', 'minus_a-infix', 'star_a-infix',
  'slash_a-infix', 'pct_a-infix', 'lsh_a-infix', 'rsh_a-infix',
  'amp_a-infix', 'crt_a-infix', 'pipe_a-infix',
])

function isAssignName(name: string): boolean {
  return ASSIGN_NAMES.has(name)
}
