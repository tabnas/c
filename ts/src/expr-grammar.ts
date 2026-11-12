/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// C's expressions, read by @tabnas/expr.
//
// The grammar's contexts push `val`, the rule an expression starts from,
// where C's grammar names an expression (an initializer, a condition, an
// argument). expr parses the expression with C's operator table, and its
// evaluate callback turns each operation of the S-expression into the
// node C's tree holds for it, from the root down once the expression has
// ended (`evaluateCExpr`). The table sets the options expr has for a
// language like C (`ts/doc/reference.md` in tabnas/expr):
//
// - a binding power on a call's and a subscript's parenthesis (`left`),
//   so `a.b[1]` subscripts `a.b` and `a.b(1)` calls it;
// - a cast: a parenthesised type name before an operand, a prefix
//   operator at the unary level, `accept`ed when the group holds a
//   `type_name`;
// - the comma operator beside separators: a call's arguments are a
//   separated list, and so is any context that sets `n.expr_sep`
//   (`val`'s before-open below);
// - `juxtapose: false`: values side by side are refused;
// - a required content: `()` as a group is refused, and `f()` is a call.
//
// The tree's shapes are C's: an operator is `op`, not a token; a call
// drops its parentheses and the commas between its arguments, a
// subscript its brackets, a parenthesised expression its parentheses, a
// conditional its `?` and `:`, a comma expression its commas; a cast and
// a compound literal keep their parentheses. A dropped token's comments
// stay, as children of the node that drops it, at its place. A token
// expr does not hand over with the operation (an opener, a separator, a
// conditional's `:`) is reached through the links the sub-lex hook makes
// as the tokens are lexed (`linkToken`).

import type { Tabnas, Rule, RuleSpec, Context, Token } from '@tabnas/parser'
import { Expr } from '@tabnas/expr'

import {
  CNode, makeNode, keepToken, dropToken, isNode, childNodes, fixSpans,
  unfixSpan, tokenRef,
} from './node.js'

// ---- C's operator table ---------------------------------------------
//
// Binding powers on a 1,000 ladder, loosest first. Left-associative
// operators have left < right, right-associative ones left > right.

const UNARY = 16_000
const POSTFIX = 17_000

export const C_OP_TABLE: Record<string, any> = {
  // The comma operator, which gives way to a separator wherever the
  // context separates on `,` (a call's arguments, an initializer).
  comma: { src: ',', infix: true, left: 1_000, right: 1_001, separator: true },

  // Assignment, right-associative.
  assign: { src: '=', infix: true, left: 2_001, right: 2_000 },
  plus_a: { src: '+=', infix: true, left: 2_001, right: 2_000 },
  minus_a: { src: '-=', infix: true, left: 2_001, right: 2_000 },
  star_a: { src: '*=', infix: true, left: 2_001, right: 2_000 },
  slash_a: { src: '/=', infix: true, left: 2_001, right: 2_000 },
  pct_a: { src: '%=', infix: true, left: 2_001, right: 2_000 },
  lsh_a: { src: '<<=', infix: true, left: 2_001, right: 2_000 },
  rsh_a: { src: '>>=', infix: true, left: 2_001, right: 2_000 },
  amp_a: { src: '&=', infix: true, left: 2_001, right: 2_000 },
  crt_a: { src: '^=', infix: true, left: 2_001, right: 2_000 },
  pipe_a: { src: '|=', infix: true, left: 2_001, right: 2_000 },

  // The conditional, right-associative, placed by its binding powers: it
  // binds tighter than assignment and the comma operator, and its middle
  // term is a whole expression.
  tern: { src: ['?', ':'], ternary: true, left: 3_001, right: 3_000 },

  // The binary operators, from `||` to the multiplicative ones.
  or: { src: '||', infix: true, left: 4_000, right: 4_001 },
  and: { src: '&&', infix: true, left: 5_000, right: 5_001 },
  bor: { src: '|', infix: true, left: 6_000, right: 6_001 },
  bxor: { src: '^', infix: true, left: 7_000, right: 7_001 },
  band: { src: '&', infix: true, left: 8_000, right: 8_001 },
  eq: { src: '==', infix: true, left: 9_000, right: 9_001 },
  ne: { src: '!=', infix: true, left: 9_000, right: 9_001 },
  lt: { src: '<', infix: true, left: 10_000, right: 10_001 },
  le: { src: '<=', infix: true, left: 10_000, right: 10_001 },
  gt: { src: '>', infix: true, left: 10_000, right: 10_001 },
  ge: { src: '>=', infix: true, left: 10_000, right: 10_001 },
  lsh: { src: '<<', infix: true, left: 11_000, right: 11_001 },
  rsh: { src: '>>', infix: true, left: 11_000, right: 11_001 },
  plus: { src: '+', infix: true, left: 12_000, right: 12_001 },
  minus: { src: '-', infix: true, left: 12_000, right: 12_001 },
  star: { src: '*', infix: true, left: 13_000, right: 13_001 },
  slash: { src: '/', infix: true, left: 13_000, right: 13_001 },
  pct: { src: '%', infix: true, left: 13_000, right: 13_001 },

  // The prefix operators, and the cast at their level.
  pre_inc: { src: '++', prefix: true, right: UNARY },
  pre_dec: { src: '--', prefix: true, right: UNARY },
  unary_p: { src: '+', prefix: true, right: UNARY },
  unary_n: { src: '-', prefix: true, right: UNARY },
  lnot: { src: '!', prefix: true, right: UNARY },
  bnot: { src: '~', prefix: true, right: UNARY },
  deref: { src: '*', prefix: true, right: UNARY },
  addr: { src: '&', prefix: true, right: UNARY },
  sizeof: { src: 'sizeof', prefix: true, right: UNARY },
  alignof: { src: '_Alignof', prefix: true, right: UNARY },
  alignof_g: { src: 'alignof', prefix: true, right: UNARY },
  gnualignof: { src: '__alignof__', prefix: true, right: UNARY },
  gnualignof_s: { src: '__alignof', prefix: true, right: UNARY },
  cast: {
    osrc: '(', csrc: ')', cast: true, right: UNARY,
    accept: (term: any) => isNode(term) && 'type_name' === term.kind,
  },

  // The postfix operators, one level, left to right.
  post_inc: { src: '++', suffix: true, left: POSTFIX },
  post_dec: { src: '--', suffix: true, left: POSTFIX },
  dot: { src: '.', infix: true, left: POSTFIX, right: POSTFIX + 1 },
  arrow: { src: '->', infix: true, left: POSTFIX, right: POSTFIX + 1 },

  // A group, whose content is required; a call, whose content is its
  // arguments, separated; a subscript.
  paren: {
    osrc: '(', csrc: ')', paren: true,
    preval: { active: false }, content: { required: true },
  },
  call: {
    osrc: '(', csrc: ')', paren: true, left: POSTFIX,
    preval: { active: true }, content: { separated: true },
  },
  subscript: {
    osrc: '[', csrc: ']', paren: true, left: POSTFIX,
    preval: { active: true, required: true }, content: { required: true },
  },
}

const ASSIGN_OPS = new Set([
  'assign-infix', 'plus_a-infix', 'minus_a-infix', 'star_a-infix',
  'slash_a-infix', 'pct_a-infix', 'lsh_a-infix', 'rsh_a-infix',
  'amp_a-infix', 'crt_a-infix', 'pipe_a-infix',
])

// ---- The links between an operation's tokens --------------------------
//
// expr hands evaluate each operation's own token: an operator's, a
// paren's closer, a conditional's `?`. The opener of a paren, the commas
// between a call's arguments and a conditional's `:` are reached from
// it, through links made as the tokens are lexed: a closer's `use.open`
// is its opener, an opener's `use.seps` the commas directly inside it,
// and a `?`'s `use.colon` the `:` that answers it.

interface Level { opener?: Token; qs: Token[] }

interface LinkState { levels: Level[]; last?: Token }

const OPENERS = new Set(['PUNC_LPAREN', 'PUNC_LBRACKET', 'PUNC_LBRACE'])
const CLOSER_OF: Record<string, string> = {
  PUNC_RPAREN: 'PUNC_LPAREN',
  PUNC_RBRACKET: 'PUNC_LBRACKET',
  PUNC_RBRACE: 'PUNC_LBRACE',
}

export function newLinks(): LinkState {
  return { levels: [{ qs: [] }] }
}

function use(tkn: Token): any {
  return ((tkn as any).use = (tkn as any).use || {})
}

// Link a token the lexer gave the parser, in the order it gave them. A
// token given again at the same place (the engine's relex) takes the
// place of the one before it.
export function linkToken(links: LinkState, tkn: Token): void {
  const last = links.last
  if (last && last.sI === tkn.sI) {
    const was = use(last)
    const now = use(tkn)
    for (const key of ['open', 'seps', 'colon']) {
      if (undefined !== was[key] && undefined === now[key]) now[key] = was[key]
    }
    for (const level of links.levels) {
      if (level.opener === last) level.opener = tkn
      const qi = level.qs.indexOf(last)
      if (qi >= 0) level.qs[qi] = tkn
    }
    links.last = tkn
    return
  }
  links.last = tkn
  const levels = links.levels
  const top = levels[levels.length - 1]
  const name = tkn.name
  if (OPENERS.has(name)) {
    levels.push({ opener: tkn, qs: [] })
    return
  }
  const opens = CLOSER_OF[name]
  if (undefined !== opens) {
    for (let i = levels.length - 1; i > 0; i--) {
      const opener = levels[i].opener as Token
      if (opener.name === opens) {
        use(tkn).open = opener
        levels.length = i
        break
      }
    }
    return
  }
  if ('PUNC_COMMA' === name) {
    if (top.opener) (use(top.opener).seps ??= []).push(tkn)
    return
  }
  if ('PUNC_QUESTION' === name) {
    top.qs.push(tkn)
    return
  }
  if ('PUNC_COLON' === name) {
    const q = top.qs.pop()
    if (q) use(q).colon = tkn
    return
  }
  if ('PUNC_SEMI' === name) {
    top.qs.length = 0
  }
}

const linked = (tkn: Token | undefined, key: string): any =>
  tkn && (tkn as any).use ? (tkn as any).use[key] : undefined

// ---- evaluate: an operation as C's node -----------------------------

function nodeOf(term: any): CNode | undefined {
  return isNode(term) ? term : undefined
}

function push(node: CNode, term: any): void {
  if (isNode(term)) node.children.push(term)
}

function drop(node: CNode, tkn: Token | undefined): void {
  if (tkn && (tkn as any).isToken) dropToken(node, tkn)
}

function keep(node: CNode, tkn: Token | undefined): void {
  if (tkn && (tkn as any).isToken) keepToken(node, tkn)
}

// An infix operation: the left operand, the operator's comments, the
// right operand.
function infix(kind: string, op: any, terms: any[]): CNode {
  const out = makeNode(kind)
  push(out, terms[0])
  drop(out, op.token)
  push(out, terms[1])
  return out
}

// A comma expression holds every operand of a chain of commas: expr
// builds `a, b, c` left to right, `[, [, a b] c]`, and the inner one is
// the outer one's first operand. A parenthesised one is a group's.
function comma(op: any, terms: any[]): CNode {
  const left = nodeOf(terms[0])
  let out: CNode
  if (left && 'comma_expression' === left.kind) {
    out = left
    unfixSpan(out)
  } else {
    out = makeNode('comma_expression')
    push(out, left)
  }
  drop(out, op.token)
  push(out, terms[1])
  return out
}

function member(op: any, terms: any[]): CNode {
  const out = makeNode('member_expression')
  push(out, terms[0])
  drop(out, op.token)
  const name = nodeOf(terms[1])
  push(out, name)
  if (name && 'string' === typeof name.name) out.memberName = name.name
  out.op = op.src
  return out
}

function conditional(op: any, terms: any[]): CNode {
  const out = makeNode('conditional_expression')
  push(out, terms[0])
  drop(out, op.token)
  push(out, terms[1])
  drop(out, linked(op.token, 'colon'))
  push(out, terms[2])
  return out
}

function unary(op: any, terms: any[]): CNode {
  const out = makeNode('unary_expression')
  out.op = op.src
  drop(out, op.token)
  push(out, terms[0])
  return out
}

function postfix(op: any, terms: any[]): CNode {
  const out = makeNode('postfix_unary_expression')
  push(out, terms[0])
  drop(out, op.token)
  out.op = op.src
  return out
}

function call(op: any, terms: any[]): CNode {
  const out = makeNode('call_expression')
  const callee = nodeOf(terms[0])
  push(out, callee)
  if (callee && 'identifier_expression' === callee.kind) {
    out.callee = callee.name
    const idTok = callee.children.find(
      (c: any) => c && 'token' === c.kind && !String(c.tname).startsWith('TRIVIA'))
    out.isMacro = !!(idTok && 'MACRO_NAME' === (idTok as any).tname)
  }
  const closer = op.token as Token
  const opener = linked(closer, 'open') as Token | undefined
  const seps: Token[] = linked(opener, 'seps') || []
  const args = makeNode('argument_list')
  drop(args, opener)
  for (let i = 1; i < terms.length; i++) {
    if (i > 1) drop(args, seps[i - 2])
    push(args, terms[i])
  }
  drop(args, closer)
  out.children.push(args)
  return out
}

function subscript(op: any, terms: any[]): CNode {
  const out = makeNode('subscript_expression')
  push(out, terms[0])
  const closer = op.token as Token
  const index = makeNode('index_list')
  drop(index, linked(closer, 'open'))
  for (let i = 1; i < terms.length; i++) push(index, terms[i])
  drop(index, closer)
  out.children.push(index)
  return out
}

// A parenthesised expression.
function group(op: any, terms: any[]): CNode {
  const out = makeNode('paren_expression')
  const closer = op.token as Token
  drop(out, linked(closer, 'open'))
  for (const t of terms) push(out, t)
  drop(out, closer)
  return out
}

// The nodes a postfix operator builds, each over its first child node:
// a compound literal's postfix chain is built over its brace list.
const POSTFIX_KINDS = new Set([
  'member_expression', 'subscript_expression', 'call_expression',
  'postfix_unary_expression',
])

// A cast: `( type-name )` and its operand. A brace list in the operand's
// place is a compound literal, which binds as a postfix expression does:
// expr builds the postfix operators after it into the cast's operand, so
// the compound literal takes the brace list's place under them.
function cast(op: any, terms: any[]): CNode {
  const closer = op.token as Token
  const opener = linked(closer, 'open') as Token | undefined
  const typeName = nodeOf(terms[0])
  const operand = nodeOf(terms[1])

  const parens = (kind: string, body: CNode | undefined): CNode => {
    const out = makeNode(kind)
    keep(out, opener)
    push(out, typeName)
    keep(out, closer)
    push(out, body)
    return out
  }

  const chain: CNode[] = []
  let n = operand
  while (n && POSTFIX_KINDS.has(n.kind)) {
    chain.push(n)
    n = childNodes(n)[0]
  }
  if (n && 'initializer_list' === n.kind) {
    const literal = parens('compound_literal', n)
    const parent = chain[chain.length - 1]
    if (!parent) return literal
    const i = parent.children.indexOf(n)
    parent.children[i] = literal
    // The chain's nodes start with the compound literal's `(` now.
    for (const c of chain) unfixSpan(c)
    return operand as CNode
  }
  return parens('cast_expression', operand)
}

export function evaluateCExpr(
  _rule: Rule, _ctx: Context, op: any, terms: any[],
): any {
  const out = evaluateOp(op, terms)
  // Each operation's node is given its span as it is built, from the
  // innermost out: the span of the first token it keeps, which every
  // expression's node has. An external declaration gives the rest of its
  // tree theirs when it ends, and an expression parsed on its own (the
  // start rule `val`) has no declaration to give them.
  if (isNode(out)) fixSpans(out)
  return out
}

function isRoot(rule: Rule, ctx: Context): boolean {
  const norule = (ctx as any).NORULE
  const parent: any = rule ? (rule as any).parent : undefined
  return rule === norule || !parent || parent === norule
}

function evaluateOp(op: any, terms: any[]): any {
  const name: string = op.name
  if (op.cast) return cast(op, terms)
  if (op.paren) {
    if ('call-paren' === name) return call(op, terms)
    if ('subscript-paren' === name) return subscript(op, terms)
    return group(op, terms)
  }
  if (op.ternary) return conditional(op, terms)
  if (op.infix) {
    if ('comma-infix' === name) return comma(op, terms)
    if (ASSIGN_OPS.has(name)) {
      const out = infix('assignment_expression', op, terms)
      out.op = op.src
      return out
    }
    if ('dot-infix' === name || 'arrow-infix' === name) return member(op, terms)
    const out = infix('binary_expression', op, terms)
    out.op = op.src
    return out
  }
  if (op.prefix) return unary(op, terms)
  if (op.suffix) return postfix(op, terms)
  const out = makeNode('expression')
  for (const t of terms) push(out, t)
  return out
}

// ---- val: where an expression starts --------------------------------

// The rules of expr's own: a `val` they push is a term of the
// expression being read, not a new one.
const EXPR_OWN = new Set([
  'val', 'expr', 'paren', 'ternary', 'list', 'map', 'elem', 'pair',
])

// The contexts whose expression is a full one, where a comma is the
// comma operator; in every other a comma ends the expression, for the
// context to take (an assignment or a conditional expression, in C's
// grammar).
const FULL_EXPRESSION = new Set([
  'expression_statement', 'jump_statement', 'paren_condition',
  'for_init', 'for_cond', 'for_iter', 'asm_value',
])

// The C rules a `val` pushes for a term, whose node is the term's.
const TERM_RULES = new Set([
  'type_name', 'sizeof_type_form', 'initializer_list', 'string_atom',
  'generic_selection', 'statement_expression',
])

// C's values: an identifier or a literal, which never directly follows
// an operand.
const JUXTAPOSED = new Set([
  'ID', 'TYPEDEF_NAME', 'MACRO_NAME',
  'LIT_INT', 'LIT_FLOAT', 'LIT_CHAR', 'LIT_STRING',
])

// A literal or an identifier, from its one token.
function atom(kind: string, tkn: Token): CNode {
  const node = makeNode(kind, tokenRef(tkn).span)
  keepToken(node, tkn)
  if ('literal_expression' === kind) {
    node.literalKind = tkn.name
    node.value = tkn.src
  } else {
    node.name = tkn.src
  }
  return node
}

function atomAction(kind: string) {
  return (rule: Rule): void => {
    rule.node = atom(kind, rule.o0 as Token)
  }
}

// Is the val the first term of a group's content, where a type name is
// the group's own (a cast's or a compound literal's)?
function groupContent(rule: Rule): boolean {
  const paren: any = (rule as any).parent
  return !!paren && 'paren' === paren.name && !!paren.u.expr_paren_group &&
    undefined === paren.u.expr_items
}

export function installExpr(tn: Tabnas): void {
  tn.use(Expr as any, {
    op: C_OP_TABLE as any,
    evaluate: evaluateCExpr as any,
    juxtapose: false,
    values: [...JUXTAPOSED],
  })

  tn.rule('val', (rs: RuleSpec) => {
    // A new expression, from one of C's contexts: expr's counters start
    // again (the expression around a statement expression or a brace
    // list is not this one's), and the context says whether a comma
    // separates.
    rs.bo((rule: Rule) => {
      const parent: any = (rule as any).parent
      if (parent && !EXPR_OWN.has(parent.name)) {
        const n: any = rule.n
        n.expr = 0
        n.expr_prefix = 0
        n.expr_suffix = 0
        n.expr_paren = 0
        n.expr_ternary = 0
        n.expr_sep = FULL_EXPRESSION.has(parent.name) ? 0 : 1
        n.dlist = 0
        n.dmap = 0
        n.pk = 0
      }
      rule.node = undefined as any
    })

    // The forms that expr's own alternates would take otherwise: a type
    // name after `sizeof (`, a statement expression `( {`, `_Generic`, a
    // brace list, and a type name as a group's content (a cast's).
    rs.open([
      { s: '#SIZEOF_KW PUNC_LPAREN #SIMPLE_TYPE_HEAD', b: 3,
        p: 'sizeof_type_form', g: 'c-sizeof-type' },
      { s: 'PUNC_LPAREN PUNC_LBRACE', b: 2, p: 'statement_expression',
        g: 'c-stmt-expr' },
      { s: 'KW__GENERIC', b: 1, p: 'generic_selection', g: 'c-generic' },
      { s: 'PUNC_LBRACE', b: 1, p: 'initializer_list', g: 'c-brace-list' },
      { s: '#SIMPLE_TYPE_HEAD', b: 1, c: groupContent, p: 'type_name',
        g: 'c-type-name' },
    ] as any, { append: false } as any)

    // C's atoms.
    rs.open([
      { s: 'LIT_INT', a: atomAction('literal_expression'), g: 'c-atom,c-int' },
      { s: 'LIT_FLOAT', a: atomAction('literal_expression'), g: 'c-atom,c-float' },
      { s: 'LIT_CHAR', a: atomAction('literal_expression'), g: 'c-atom,c-char' },
      { s: 'KW_NULLPTR', a: atomAction('literal_expression'), g: 'c-atom,c-nullptr' },
      { s: 'KW_TRUE', a: atomAction('literal_expression'), g: 'c-atom,c-true' },
      { s: 'KW_FALSE', a: atomAction('literal_expression'), g: 'c-atom,c-false' },
      { s: 'LIT_STRING', b: 1, p: 'string_atom', g: 'c-atom,c-str' },
      { s: 'ID', a: atomAction('identifier_expression'), g: 'c-atom,c-id' },
      { s: 'MACRO_NAME', a: atomAction('identifier_expression'), g: 'c-atom,c-macro' },
      { s: 'TYPEDEF_NAME', a: atomAction('identifier_expression'), g: 'c-atom,c-typedef' },
    ] as any, { append: true } as any)

    // The expression ends where no operator follows. An identifier or a
    // literal, which never directly follows an operand in C, expr refuses
    // before this (its `values`).
    rs.close([
      { g: 'c-val-end' },
    ] as any, { append: true } as any)

    // A C rule a term pushed: its node is the term's.
    rs.bc((rule: Rule) => {
      const child: any = (rule as any).child
      if (child && TERM_RULES.has(child.name) && child.node &&
          child !== rule.u.seenTerm) {
        rule.u.seenTerm = child
        rule.node = child.node
      }
    })

    // An expression parsed on its own (the start rule `val`): its spans,
    // as an external declaration's are given when it ends.
    rs.ac((rule: Rule, ctx: Context) => {
      if (isRoot(rule, ctx) && isNode(rule.node)) fixSpans(rule.node)
    })
  })
}

// The rules an expression is built in, whose node a context reads back.
export function isExpressionRule(rule: Rule | undefined): boolean {
  return !!rule && 'val' === rule.name
}
