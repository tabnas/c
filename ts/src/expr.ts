/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// C-expression parser. Precedence handling for binary, comma, and
// assignment operators is delegated to @jsonic/expr's `testing.prattify`
// algorithm; the operator table is declared using @jsonic/expr's public
// `OpDef` shape and `testing.opify` marks each entry as an Op.
//
// Atoms, prefix unary forms, postfix forms (call / subscript / member),
// casts, sizeof, _Generic, statement-expressions, and compound literals
// remain hand-rolled — those constructs don't fit @jsonic/expr's
// prefix/infix/suffix/paren classification cleanly enough to be worth
// expressing through it. The Pratt result is an [op, ...terms]
// S-expression tree which `toCST` walks to produce the structured CST
// nodes (binary_expression, conditional_expression, assignment_expression,
// comma_expression) that the rest of the codebase already consumes.
//
// Walking the produced CST depth-first still yields the original token
// sequence in source order, so source fidelity is preserved.

import type { Token } from '@tabnas/parser'
import type { TokenStream, CNode, CTokenRef } from './structure.js'

import { testing as exprTesting } from '@tabnas/expr'
import type { OpDef, Op } from '@tabnas/expr'

const { prattify, opify } = exprTesting

const PRESERVED_TRIVIA = new Set([
  'TRIVIA_LINE_COMMENT', 'TRIVIA_BLOCK_COMMENT', 'TRIVIA_LINE_CONT',
])

const TYPE_KEYWORDS = new Set([
  'KW_VOID', 'KW_CHAR', 'KW_SHORT', 'KW_INT', 'KW_LONG', 'KW_FLOAT',
  'KW_DOUBLE', 'KW_SIGNED', 'KW_UNSIGNED', 'KW_BOOL', 'KW__BOOL',
  'KW__COMPLEX', 'KW__IMAGINARY',
  'KW___SIGNED__', 'KW___SIGNED',
  'KW___INT8', 'KW___INT16', 'KW___INT32', 'KW___INT64',
  'KW_CONST', 'KW_VOLATILE', 'KW_RESTRICT', 'KW__ATOMIC',
  'KW___CONST__', 'KW___CONST',
  'KW___VOLATILE__', 'KW___VOLATILE',
  'KW___RESTRICT__', 'KW___RESTRICT',
  'KW_STRUCT', 'KW_UNION', 'KW_ENUM',
  'KW_TYPEOF', 'KW_TYPEOF_UNQUAL',
  'KW___TYPEOF__', 'KW___TYPEOF',
  'KW__BITINT',
])

function makeNode(kind: string, span: any): CNode {
  return { kind, span, children: [], trivia: { leading: [], trailing: [] } } as CNode
}

function tokenRef(t: Token): CTokenRef {
  return {
    kind: 'token', tname: t.name, src: t.src,
    span: { start: t.sI, end: t.sI + t.len, line: t.rI, col: t.cI },
  }
}

function spanOf(t: Token) {
  return { start: t.sI, end: t.sI + t.len, line: t.rI, col: t.cI }
}

// Push the next real token with leading trivia onto `node`. Returns the
// underlying Token or null at end-of-stream.
function takeTokenInto(ts: TokenStream, node: CNode): Token | null {
  return ts.takeInto(node)
}

// ---- Operator tables (driven by @jsonic/expr OpDef shape) ----------
//
// Precedence numbers are well-spaced so future additions can slot in
// without renumbering. Convention from @jsonic/expr:
//   left-assoc  →  left  <  right   (next same-prec op wraps)
//   right-assoc →  left  >  right   (next same-prec op drills)

const COMMA_OP_DEF: OpDef = {
  src: ',',  infix: true, left: 1_000, right: 1_001,
}

// All assignment operators share the same precedence; they're
// right-associative so left > right by 1.
const ASSIGN_OP_DEFS: Record<string, OpDef> = {
  '=':   { src: '=',   infix: true, left: 2_001, right: 2_000 },
  '+=':  { src: '+=',  infix: true, left: 2_001, right: 2_000 },
  '-=':  { src: '-=',  infix: true, left: 2_001, right: 2_000 },
  '*=':  { src: '*=',  infix: true, left: 2_001, right: 2_000 },
  '/=':  { src: '/=',  infix: true, left: 2_001, right: 2_000 },
  '%=':  { src: '%=',  infix: true, left: 2_001, right: 2_000 },
  '<<=': { src: '<<=', infix: true, left: 2_001, right: 2_000 },
  '>>=': { src: '>>=', infix: true, left: 2_001, right: 2_000 },
  '&=':  { src: '&=',  infix: true, left: 2_001, right: 2_000 },
  '^=':  { src: '^=',  infix: true, left: 2_001, right: 2_000 },
  '|=':  { src: '|=',  infix: true, left: 2_001, right: 2_000 },
}

// Binary operators (C23 §6.5 levels 4..13).
const BINARY_OP_DEFS: Record<string, OpDef> = {
  '||': { src: '||', infix: true, left: 4_000,  right: 4_001 },
  '&&': { src: '&&', infix: true, left: 5_000,  right: 5_001 },
  '|':  { src: '|',  infix: true, left: 6_000,  right: 6_001 },
  '^':  { src: '^',  infix: true, left: 7_000,  right: 7_001 },
  '&':  { src: '&',  infix: true, left: 8_000,  right: 8_001 },
  '==': { src: '==', infix: true, left: 9_000,  right: 9_001 },
  '!=': { src: '!=', infix: true, left: 9_000,  right: 9_001 },
  '<':  { src: '<',  infix: true, left: 10_000, right: 10_001 },
  '<=': { src: '<=', infix: true, left: 10_000, right: 10_001 },
  '>':  { src: '>',  infix: true, left: 10_000, right: 10_001 },
  '>=': { src: '>=', infix: true, left: 10_000, right: 10_001 },
  '<<': { src: '<<', infix: true, left: 11_000, right: 11_001 },
  '>>': { src: '>>', infix: true, left: 11_000, right: 11_001 },
  '+':  { src: '+',  infix: true, left: 12_000, right: 12_001 },
  '-':  { src: '-',  infix: true, left: 12_000, right: 12_001 },
  '*':  { src: '*',  infix: true, left: 13_000, right: 13_001 },
  '/':  { src: '/',  infix: true, left: 13_000, right: 13_001 },
  '%':  { src: '%',  infix: true, left: 13_000, right: 13_001 },
}

// Resolve an OpDef to a prattify-ready Op. The fields jsonic uses but
// prattify does not (tin, token, otkn, etc.) get stub defaults.
function buildOp(name: string, def: OpDef): Op {
  return opify({
    name,
    src: def.src as string,
    left: def.left ?? 0,
    right: def.right ?? 0,
    use: {},
    prefix: !!def.prefix,
    suffix: !!def.suffix,
    infix: !!def.infix,
    ternary: !!def.ternary,
    paren: !!def.paren,
    terms: def.ternary ? 3 : (def.prefix || def.suffix) ? 1 : 2,
    tkn: '', tin: 0, osrc: '', csrc: '', otkn: '', otin: 0, ctkn: '', ctin: 0,
    preval: { active: !!def.preval?.active, required: !!def.preval?.required },
    token: undefined as any,
  } as any) as Op
}

// Map from token-name (e.g. 'PUNC_PLUS') → resolved Op. Built once.
const INFIX_BY_TOKEN: Record<string, Op> = {}
const ASSIGN_BY_TOKEN: Record<string, Op> = {}
const COMMA_OP: Op = buildOp('comma', COMMA_OP_DEF)

const TOKEN_NAME_OF_OP_SRC: Record<string, string> = {
  '+': 'PUNC_PLUS', '-': 'PUNC_MINUS', '*': 'PUNC_STAR', '/': 'PUNC_SLASH',
  '%': 'PUNC_PERCENT', '<': 'PUNC_LT', '<=': 'PUNC_LE', '>': 'PUNC_GT',
  '>=': 'PUNC_GE', '==': 'PUNC_EQ', '!=': 'PUNC_NE', '&': 'PUNC_AMP',
  '^': 'PUNC_CARET', '|': 'PUNC_PIPE', '&&': 'PUNC_AND_AND',
  '||': 'PUNC_OR_OR', '<<': 'PUNC_LSHIFT', '>>': 'PUNC_RSHIFT',
  '=': 'PUNC_ASSIGN', '+=': 'PUNC_PLUS_ASSIGN', '-=': 'PUNC_MINUS_ASSIGN',
  '*=': 'PUNC_STAR_ASSIGN', '/=': 'PUNC_SLASH_ASSIGN',
  '%=': 'PUNC_PERCENT_ASSIGN', '<<=': 'PUNC_LSHIFT_ASSIGN',
  '>>=': 'PUNC_RSHIFT_ASSIGN', '&=': 'PUNC_AMP_ASSIGN',
  '^=': 'PUNC_CARET_ASSIGN', '|=': 'PUNC_PIPE_ASSIGN',
}

for (const [src, def] of Object.entries(BINARY_OP_DEFS)) {
  INFIX_BY_TOKEN[TOKEN_NAME_OF_OP_SRC[src]] = buildOp(src, def)
}
for (const [src, def] of Object.entries(ASSIGN_OP_DEFS)) {
  ASSIGN_BY_TOKEN[TOKEN_NAME_OF_OP_SRC[src]] = buildOp(src, def)
}

// Source-side recognition only — these don't go through prattify.
const PREFIX_OPS = new Set([
  'PUNC_PLUS_PLUS', 'PUNC_MINUS_MINUS',
  'PUNC_PLUS', 'PUNC_MINUS', 'PUNC_BANG', 'PUNC_TILDE',
  'PUNC_STAR', 'PUNC_AMP',
  'KW_SIZEOF', 'KW__ALIGNOF', 'KW_ALIGNOF', 'KW___ALIGNOF__', 'KW___ALIGNOF',
  'KW___REAL__', 'KW___IMAG__', 'KW___EXTENSION__',
])

const POSTFIX_OPS = new Set(['PUNC_PLUS_PLUS', 'PUNC_MINUS_MINUS'])

// ---- prattify-driven Pratt loop -------------------------------------
//
// Two helpers cover the lifecycle of an expression tree:
//
//   isExprTree(x)   — true when x is an [Op, ...terms] array produced
//                     by opify+prattify (uses the OP_MARK on x[0]).
//   appendTerm(...) — fill the missing slot left by prattify after it
//                     resolves where the new op should sit.
//
// The result of pratt(...) is either a leaf (my CST node) or an
// [op, term, term, ...] array. toCST walks the latter and produces
// binary_expression / assignment_expression / comma_expression /
// conditional_expression nodes.

function isExprTree(x: any): boolean {
  return Array.isArray(x) && x[0] && (x[0] as any).OP_MARK !== undefined &&
    typeof (x[0] as any).left === 'number'
}

// Append `term` to the deepest open slot of `node`. prattify(...) leaves
// the array short by exactly one term in the slot it's resolved.
function appendTerm(node: any[], term: any): void {
  // Walk down the rightmost child while the rightmost is itself an
  // expr-tree whose length is equal to its op.terms (i.e. complete).
  let cur: any[] = node
  while (true) {
    if (cur.length - 1 < cur[0].terms) {
      cur.push(term)
      return
    }
    const last = cur[cur.length - 1]
    if (isExprTree(last)) cur = last
    else break
  }
  // Defensive: if no open slot found, append to root.
  node.push(term)
}

// ---- Stoppers helpers ----------------------------------------------

function isStop(name: string | null, stoppers: Set<string>): boolean {
  return name === null || stoppers.has(name)
}

// ---- Entry ---------------------------------------------------------
//
// Top-level: comma > assignment > ternary > binary > unary (atoms).
// Only the binary level uses @jsonic/expr's prattify directly —
// assignment and ternary need control-flow that doesn't fit a flat
// Pratt loop:
//   assignment:  unary-expression op assignment-expression  (right-assoc;
//                LHS must be unary-expression, not the binary-tree built
//                so far). Hand-rolled.
//   ternary:     logical-OR ? expr : conditional-expression. Hand-rolled.

export function parseExpression(
  ts: TokenStream, stoppers: Set<string>,
): CNode | null {
  return parseCommaExpr(ts, stoppers)
}

// assignment-expression-or-comma at the top level. Comma is left-grown.
function parseCommaExpr(
  ts: TokenStream, stoppers: Set<string>,
): CNode | null {
  let first = parseAssignmentExpression(ts, stoppers)
  if (!first) return null
  if (stoppers.has('PUNC_COMMA') || ts.peekName() !== 'PUNC_COMMA') return first
  const node = makeNode('comma_expression', first.span)
  node.children.push(first)
  while (ts.peekName() === 'PUNC_COMMA' && !stoppers.has('PUNC_COMMA')) {
    takeTokenInto(ts, node) // ','
    const next = parseAssignmentExpression(ts, stoppers)
    if (!next) break
    node.children.push(next)
  }
  return node
}

// assignment-expression: right-associative.
//   unary-expression assignment-operator assignment-expression
// | conditional-expression
//
// We optimistically parse a conditional-expression. If that leaves the
// stream pointed at an assignment operator AND the conditional's root
// is a unary-expression-shaped CST node, we recurse for the right
// side. Otherwise we return the conditional as-is.
export function parseAssignmentExpression(
  ts: TokenStream, stoppers: Set<string>,
): CNode | null {
  const left = parseConditionalExpression(ts, stoppers)
  if (!left) return null
  const opName = ts.peekName()
  if (!opName || stoppers.has(opName)) return left
  const op = ASSIGN_BY_TOKEN[opName]
  if (!op) return left
  const node = makeNode('assignment_expression', left.span)
  node.children.push(left)
  node.left = left
  takeTokenInto(ts, node) // '=' / '+=' / etc.
  node.op = op.src
  const right = parseAssignmentExpression(ts, stoppers) // right-assoc
  if (right) {
    node.children.push(right)
    node.right = right
  }
  return node
}

// conditional-expression: logical-OR-expression
//                       | logical-OR-expression ? expression : conditional-expression
function parseConditionalExpression(
  ts: TokenStream, stoppers: Set<string>,
): CNode | null {
  const cond = parseBinaryExpression(ts, stoppers)
  if (!cond) return null
  if (ts.peekName() !== 'PUNC_QUESTION') return cond
  const node = makeNode('conditional_expression', cond.span)
  node.children.push(cond)
  node.cond = cond
  takeTokenInto(ts, node) // '?'
  const then = parseExpression(ts, new Set([...stoppers, 'PUNC_COLON']))
  if (then) {
    node.children.push(then)
    node.then = then
  }
  if (ts.peekName() === 'PUNC_COLON') takeTokenInto(ts, node)
  // Right-assoc: the alternative is itself a conditional-expression.
  // Implement via parseAssignmentExpression which subsumes
  // conditional-expression and assignment.
  const els = parseAssignmentExpression(ts, stoppers)
  if (els) {
    node.children.push(els)
    node.else = els
  }
  return node
}

// Binary operators (logical-OR through multiplicative) handled with
// @jsonic/expr's prattify driving precedence. Operands are unary-
// expressions; the resulting [op, ...terms] tree is converted to my
// CST shape via toCST.
function parseBinaryExpression(
  ts: TokenStream, stoppers: Set<string>,
): CNode | null {
  let expr: any = parseUnary(ts, stoppers)
  if (expr === null) return null

  while (true) {
    const n = ts.peekName()
    if (isStop(n, stoppers)) break
    const op = INFIX_BY_TOKEN[n!]
    if (!op) break

    const opTokenInfo = ts.take()!
    const opCarry = {
      trivia: opTokenInfo.trivia,
      ref: opTokenInfo.ref,
    }

    const right = parseUnary(ts, stoppers)
    if (right === null) break

    if (!isExprTree(expr)) {
      const tree: any[] = [op, expr, right]
      ;(tree as any).__op_token__ = opCarry
      expr = tree
    } else {
      const result = prattify(expr, op, 'c-pratt-infix') as any[]
      ;(result as any).__op_token__ = opCarry
      appendTerm(result, right)
    }
  }
  return toCST(expr)
}

// ---- S-expression → CST conversion ---------------------------------
//
// prattify produces [op, left, right] arrays for binary infix
// operators. toCST walks the tree depth-first and emits a
// binary_expression node whose children list preserves source order
// (left, opTokenWithTrivia, right). Non-tree leaves pass through
// untouched.

function toCST(node: any): CNode {
  if (!isExprTree(node)) return node as CNode
  const op = node[0] as Op
  const left = toCST(node[1])
  const right = node[2] !== undefined ? toCST(node[2]) : undefined
  const carried = (node as any).__op_token__ as
    | { trivia: CTokenRef[]; ref: CTokenRef }
    | undefined

  const out = makeNode('binary_expression', left.span)
  out.children.push(left)
  out.left = left
  if (carried) {
    for (const tr of carried.trivia) out.children.push(tr)
    out.children.push(carried.ref)
  }
  if (right) {
    out.children.push(right)
    out.right = right
  }
  out.op = op.src
  return out
}

// Prefix unary operators, including sizeof/_Alignof/typeof in their
// expression forms. Recurses into the operand.
function parseUnary(ts: TokenStream, stoppers: Set<string>): CNode | null {
  const n = ts.peekName()
  if (n && PREFIX_OPS.has(n)) {
    const startTkn = ts.peek()!
    const node = makeNode('unary_expression', spanOf(startTkn))
    const opTkn = takeTokenInto(ts, node)!
    node.op = opTkn.src
    // sizeof / _Alignof can take a parenthesised type-name, not an
    // expression. We detect by peeking: `sizeof ( <type-keyword |
    // typedef-name> ...` is a type-form.
    if ((n === 'KW_SIZEOF' || n === 'KW__ALIGNOF' || n === 'KW_ALIGNOF' ||
         n === 'KW___ALIGNOF__' || n === 'KW___ALIGNOF') &&
        ts.peekName() === 'PUNC_LPAREN' &&
        looksLikeTypeName(ts, 1)) {
      const tn = makeNode('type_name', spanOf(ts.peek()!))
      consumeBalanced(ts, tn, 'PUNC_LPAREN', 'PUNC_RPAREN')
      node.children.push(tn)
      node.operand = tn
      return node
    }
    const operand = parseUnary(ts, stoppers)
    if (operand) {
      node.children.push(operand)
      node.operand = operand
    }
    return node
  }
  return parsePostfix(ts, stoppers)
}

// Postfix loop: subscript, call, member access, increment/decrement.
function parsePostfix(ts: TokenStream, stoppers: Set<string>): CNode | null {
  let target = parsePrimary(ts, stoppers)
  if (!target) return null
  while (true) {
    const n = ts.peekName()
    if (!n || stoppers.has(n)) break
    if (n === 'PUNC_LBRACKET') {
      const node = makeNode('subscript_expression', target.span)
      node.children.push(target)
      node.target = target
      const idx = makeNode('index_list', spanOf(ts.peek()!))
      consumeBalanced(ts, idx, 'PUNC_LBRACKET', 'PUNC_RBRACKET')
      node.children.push(idx)
      target = node
      continue
    }
    if (n === 'PUNC_LPAREN') {
      const node = makeNode('call_expression', target.span)
      node.children.push(target)
      // Tag isMacro when the immediate target is an identifier_expression
      // whose token was MACRO_NAME.
      const callee = unwrapCallee(target)
      if (callee) {
        node.callee = callee.src
        node.isMacro = callee.tname === 'MACRO_NAME'
      }
      const args = makeNode('argument_list', spanOf(ts.peek()!))
      // Parse comma-separated assignment-expressions as arguments.
      takeTokenInto(ts, args) // '('
      while (!ts.done() && ts.peekName() !== 'PUNC_RPAREN') {
        const a = parseAssignmentExpression(ts, new Set(['PUNC_COMMA', 'PUNC_RPAREN']))
        if (a) args.children.push(a)
        else {
          // Defensive: avoid infinite loop on something we don't grok.
          takeTokenInto(ts, args)
        }
        if (ts.peekName() === 'PUNC_COMMA') takeTokenInto(ts, args)
      }
      if (ts.peekName() === 'PUNC_RPAREN') takeTokenInto(ts, args)
      node.children.push(args)
      target = node
      continue
    }
    if (n === 'PUNC_DOT' || n === 'PUNC_ARROW') {
      const node = makeNode('member_expression', target.span)
      node.children.push(target)
      node.object = target
      const opTkn = takeTokenInto(ts, node)!
      node.op = opTkn.src
      // The member name is the next ID (or possibly a TYPEDEF_NAME, in
      // exceptional code).
      const memTkn = ts.peek()
      if (memTkn && (memTkn.name === 'ID' || memTkn.name === 'TYPEDEF_NAME' ||
                     memTkn.name === 'MACRO_NAME')) {
        const taken = ts.take()!
        for (const tr of taken.trivia) node.children.push(tr)
        node.children.push(taken.ref)
        node.memberName = taken.tkn.src
      }
      target = node
      continue
    }
    if (POSTFIX_OPS.has(n)) {
      const node = makeNode('postfix_unary_expression', target.span)
      node.children.push(target)
      node.target = target
      const opTkn = takeTokenInto(ts, node)!
      node.op = opTkn.src
      target = node
      continue
    }
    break
  }
  return target
}

function unwrapCallee(node: CNode): CTokenRef | null {
  if (node.kind !== 'identifier_expression') return null
  const t = node.children.find((c: any) => c.kind === 'token')
  return (t as CTokenRef) || null
}

// Primary: literal, identifier, parenthesised, generic, statement-expr,
// compound literal.
function parsePrimary(ts: TokenStream, stoppers: Set<string>): CNode | null {
  const t = ts.peek()
  if (!t) return null
  const n = t.name
  // C23 keyword constants are surfaced as literal_expressions (the
  // grammar-driven path treats them the same — see expr-grammar.ts).
  if (n === 'KW_NULLPTR' || n === 'KW_TRUE' || n === 'KW_FALSE') {
    const node = makeNode('literal_expression', spanOf(t))
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    node.literalKind = n
    node.value = taken.tkn.src
    return node
  }
  if (n === 'LIT_INT' || n === 'LIT_FLOAT' ||
      n === 'LIT_CHAR' || n === 'LIT_STRING') {
    const node = makeNode('literal_expression', spanOf(t))
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    node.literalKind = n
    node.value = taken.tkn.src
    // Adjacent string literals concatenate ("foo" "bar") — keep all in
    // one literal_expression node.
    if (n === 'LIT_STRING') {
      while (ts.peekName() === 'LIT_STRING') {
        const more = ts.take()!
        for (const tr of more.trivia) node.children.push(tr)
        node.children.push(more.ref)
      }
    }
    return node
  }
  if (n === 'ID' || n === 'MACRO_NAME' || n === 'TYPEDEF_NAME') {
    const node = makeNode('identifier_expression', spanOf(t))
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    node.name = taken.tkn.src
    return node
  }
  if (n === 'KW__GENERIC') {
    return parseGenericSelection(ts)
  }
  if (n === 'PUNC_LPAREN') {
    // GCC statement-expression `({ ... })`.
    if (ts.peekName(1) === 'PUNC_LBRACE') {
      const node = makeNode('statement_expression', spanOf(t))
      consumeBalanced(ts, node, 'PUNC_LPAREN', 'PUNC_RPAREN')
      return node
    }
    // Cast vs parenthesised expression vs compound literal: peek ahead
    // one token. If it begins a type-name, the form is `( type-name ) X`
    // (cast) or `( type-name ) { … }` (compound literal).
    if (looksLikeTypeName(ts, 1)) {
      // Find the closing ) and check what follows.
      const m = ts.mark()
      const opener = ts.take()! // '('
      const tn = makeNode('type_name', spanOf(opener.tkn))
      // Take the `(` we already consumed back as a child token.
      tn.children.push(opener.ref)
      // Consume balanced contents up to and including the matching ')'
      // (we treat the type-name's body as opaque tokens for now).
      let depth = 1
      while (!ts.done() && depth > 0) {
        const nn = ts.peekName()
        if (nn === 'PUNC_LPAREN') depth++
        else if (nn === 'PUNC_RPAREN') {
          depth--
          if (depth === 0) {
            takeTokenInto(ts, tn) // closing ')'
            break
          }
        }
        takeTokenInto(ts, tn)
      }
      // Compound literal: followed by `{`.
      if (ts.peekName() === 'PUNC_LBRACE') {
        const cl = makeNode('compound_literal', tn.span)
        cl.children.push(tn)
        cl.typeName = tn
        const init = makeNode('initializer_list', spanOf(ts.peek()!))
        consumeBalanced(ts, init, 'PUNC_LBRACE', 'PUNC_RBRACE')
        cl.children.push(init)
        return cl
      }
      // Cast: followed by an expression.
      const operand = parseUnary(ts, stoppers)
      if (operand) {
        const cast = makeNode('cast_expression', tn.span)
        cast.children.push(tn)
        cast.children.push(operand)
        cast.typeName = tn
        cast.operand = operand
        return cast
      }
      // Couldn't parse as cast — restore and fall through to plain
      // parenthesised expression.
      ts.restore(m)
    }
    // Plain parenthesised expression.
    const node = makeNode('paren_expression', spanOf(t))
    takeTokenInto(ts, node) // '('
    const inner = parseExpression(ts, new Set(['PUNC_RPAREN']))
    if (inner) node.children.push(inner)
    if (ts.peekName() === 'PUNC_RPAREN') takeTokenInto(ts, node)
    return node
  }
  return null
}

// Lookahead helper: does the token at offset `off` begin a type-name?
// True for type keywords and TYPEDEF_NAMEs. (Enough for the common
// cast / sizeof / compound-literal cases; full type-name detection is
// more involved and lives in structure.ts's specifier path.)
function looksLikeTypeName(ts: TokenStream, off: number): boolean {
  const t = ts.peek(off)
  if (!t) return false
  if (t.name === 'TYPEDEF_NAME') return true
  if (TYPE_KEYWORDS.has(t.name)) return true
  return false
}

// _Generic ( ctrl-expr , association ( , association )* )
// association:
//   type-name : assignment-expr | 'default' : assignment-expr
function parseGenericSelection(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('generic_selection', spanOf(startTkn))
  takeTokenInto(ts, node) // '_Generic'
  if (ts.peekName() !== 'PUNC_LPAREN') return node
  takeTokenInto(ts, node) // '('

  // Controlling expression: assignment up to ',' or ')'.
  const ctrl = parseExpression(ts, new Set(['PUNC_COMMA', 'PUNC_RPAREN']))
  if (ctrl) {
    const wrap = makeNode('generic_controlling_expression', ctrl.span)
    wrap.children.push(ctrl)
    wrap.expression = ctrl
    node.children.push(wrap)
    node.controlling = wrap
  }

  node.associations = [] as any[]
  while (ts.peekName() === 'PUNC_COMMA') {
    takeTokenInto(ts, node) // ','
    const ga = parseGenericAssociation(ts)
    if (ga) {
      node.children.push(ga)
      node.associations.push(ga)
    } else break
  }
  if (ts.peekName() === 'PUNC_RPAREN') takeTokenInto(ts, node)
  return node
}

function parseGenericAssociation(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('generic_association', spanOf(startTkn))

  // Either 'default' or a type-name. We model the type-name as an
  // opaque-balanced sequence up to ':' (a real type-name parser belongs
  // in structure.ts and is mid-flight; the contents are still
  // preserved verbatim).
  if (startTkn.name === 'KW_DEFAULT') {
    takeTokenInto(ts, node)
    node.associationKind = 'default'
  } else {
    const tn = makeNode('type_name', spanOf(startTkn))
    let parenD = 0, bracketD = 0
    while (!ts.done()) {
      const n = ts.peekName()
      if (n === 'PUNC_LPAREN') { parenD++; takeTokenInto(ts, tn); continue }
      if (n === 'PUNC_RPAREN') {
        if (parenD === 0) break
        parenD--; takeTokenInto(ts, tn); continue
      }
      if (n === 'PUNC_LBRACKET') { bracketD++; takeTokenInto(ts, tn); continue }
      if (n === 'PUNC_RBRACKET') {
        if (bracketD === 0) break
        bracketD--; takeTokenInto(ts, tn); continue
      }
      if (parenD === 0 && bracketD === 0 &&
          (n === 'PUNC_COLON' || n === 'PUNC_COMMA' || n === 'PUNC_RPAREN')) break
      takeTokenInto(ts, tn)
    }
    node.children.push(tn)
    node.typeName = tn
    node.associationKind = 'type'
  }
  if (ts.peekName() === 'PUNC_COLON') takeTokenInto(ts, node)
  const expr = parseExpression(ts, new Set(['PUNC_COMMA', 'PUNC_RPAREN']))
  if (expr) {
    node.children.push(expr)
    node.value = expr
  }
  return node
}

function consumeBalanced(
  ts: TokenStream, node: CNode, open: string, close: string,
): boolean {
  if (ts.peekName() !== open) return false
  takeTokenInto(ts, node)
  let depth = 1
  while (depth > 0 && !ts.done()) {
    const n = ts.peekName()
    if (n === open) depth++
    else if (n === close) depth--
    takeTokenInto(ts, node)
  }
  return depth === 0
}
