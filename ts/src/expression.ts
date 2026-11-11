/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// C's expressions, as precedence climbing in the grammar's rules
// (c-grammar.jsonic, "expressions"): each level of C's expression grammar
// is a rule, and every repetition (a comma list, a left-associative chain
// of binary operators, a postfix chain, an argument list) is a replace
// loop at one depth.
//
// A node whose existence only a later token decides (a binary operator
// after its left operand, a postfix operator after its operand, a comma
// after the first item) is WRAPPED IN PLACE when that token arrives: the
// node built so far becomes the new node, and what it was moves into its
// first child. Every reference to it, the rule that will attach it to its
// parent among them, so sees the new node, and nothing has to walk back
// along a replace chain.
//
// The node shapes are the ones the rule path built before: an operator is
// `op` and not a token, a call drops its parentheses and argument commas,
// a subscript its brackets, a parenthesised expression its parentheses, a
// conditional its `?` and `:`, a comma expression its commas; a cast and a
// compound literal keep their parentheses. A dropped token's comments stay,
// as children of the node that drops it.

import type { Rule, Context, Token } from '@tabnas/parser'

import {
  CNode, makeNode, keepToken, dropToken, tokenRef, leadingTriviaRefs,
  isNode, fixSpans,
} from './node.js'

// What never directly follows an operand in C (c.ts's JUXTAPOSED set).
const JUXTAPOSED = new Set([
  'ID', 'TYPEDEF_NAME', 'MACRO_NAME',
  'LIT_INT', 'LIT_FLOAT', 'LIT_CHAR', 'LIT_STRING',
])

// The binary operators' precedence, by token name: a larger number binds
// tighter. C's levels, from `||` to the multiplicative operators.
export const BINARY_PRECEDENCE: Record<string, number> = {
  PUNC_OR_OR: 4,
  PUNC_AND_AND: 5,
  PUNC_PIPE: 6,
  PUNC_CARET: 7,
  PUNC_AMP: 8,
  PUNC_EQ: 9, PUNC_NE: 9,
  PUNC_LT: 10, PUNC_LE: 10, PUNC_GT: 10, PUNC_GE: 10,
  PUNC_LSHIFT: 11, PUNC_RSHIFT: 11,
  PUNC_PLUS: 12, PUNC_MINUS: 12,
  PUNC_STAR: 13, PUNC_SLASH: 13, PUNC_PERCENT: 13,
}

// The rules that build an expression, which a context reads back through
// rule.child.node.
export const EXPRESSION_RULES = new Set<string>([
  'val', 'expression', 'assignment_expression', 'conditional_expression',
  'binary', 'binary_rhs', 'cast_expression', 'unary_expression',
  'postfix_expression', 'postfix_more', 'primary_expression',
])

export function isExpressionRule(rule: Rule | undefined): boolean {
  return !!rule && EXPRESSION_RULES.has(rule.name)
}

// The child rule a close state has not attached yet: a rule's bc runs each
// time its close state is entered, after every child it pushed returns.
export function freshChild(rule: Rule): Rule | undefined {
  const child = rule.child as Rule | undefined
  if (!child || child === (rule as any).u.seenChild) return undefined
  if (!child.node || 'object' !== typeof child.node) return undefined
  rule.u.seenChild = child
  return child
}

// A replace that carries a node on: the alternate's action marks the node,
// and the replacing rule's bo finds it.
export function carryOn(rule: Rule): void {
  rule.k.cont = rule.node
}

export function isCarried(rule: Rule): boolean {
  const carried = rule.k.cont
  if (undefined === carried) return false
  delete rule.k.cont
  return carried === rule.node
}

// Turn `node` into a new node of `kind` whose first child is what `node`
// was. The new node takes the old one's span, as the node a rule wraps
// always gave its wrapper.
export function wrapInPlace(node: CNode, kind: string): CNode {
  const inner: CNode = { ...node } as CNode
  for (const key of Object.keys(node)) delete (node as any)[key]
  node.kind = kind
  node.span = inner.span
  node.children = [inner]
  node.trivia = { leading: [], trailing: [] }
  return inner
}

function tok(rule: Rule, i: number): Token {
  return ((rule.state === 'o' ? (rule as any)['o' + i] : (rule as any)['c' + i])) as Token
}

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

// A transparent rule's bc: its node is the node of the rule it pushed.
function relay(rule: Rule): void {
  const child = freshChild(rule)
  if (child) rule.node = child.node
}

// A fresh rule starts with no node of its own (the engine hands a pushed
// rule its parent's node, which it must not write to).
function fresh(rule: Rule): void {
  if (!isCarried(rule)) rule.node = undefined as any
}

export function makeExpressionRefs(): Record<string, Function> {
  return {

    // ---- val: the rule an expression starts from -------------------
    '@val-start': (rule: Rule): void => { rule.node = undefined as any },
    // An expression parsed on its own (the start rule `val`): its spans,
    // as an external declaration's are given when it ends.
    '@val-end': (rule: Rule, ctx: Context): void => {
      relay(rule)
      const parent = (rule as any).parent
      if ((!parent || parent === (ctx as any).NORULE) && isNode(rule.node)) {
        fixSpans(rule.node)
      }
    },

    // ---- expression: the comma operator ----------------------------
    '@expression-bo': fresh,
    '@expression-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (!child) return
      if (rule.node && 'comma_expression' === rule.node.kind) {
        rule.node.children.push(child.node)
      } else {
        rule.node = child.node
      }
    },
    '@comma': (rule: Rule): void => {
      if ('comma_expression' !== rule.node.kind) {
        wrapInPlace(rule.node, 'comma_expression')
      }
      dropToken(rule.node, rule.c0 as Token)
      carryOn(rule)
    },

    // ---- assignment ------------------------------------------------
    '@assignment_expression-bo': fresh,
    '@assignment_expression-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (!child) return
      if (rule.u.op) {
        rule.node.children.push(child.node)
        rule.u.done = true
      } else {
        rule.node = child.node
      }
    },
    '@assign': (rule: Rule): void => {
      const op = rule.c0 as Token
      wrapInPlace(rule.node, 'assignment_expression')
      rule.node.op = op.src
      dropToken(rule.node, op)
      rule.u.op = true
    },
    '@asg-done': (rule: Rule): boolean => rule.u.done === true,

    // ---- conditional -----------------------------------------------
    '@conditional_expression-bo': fresh,
    '@conditional_expression-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (!child) return
      if ('then' === rule.u.stage || 'else' === rule.u.stage) {
        rule.node.children.push(child.node)
        if ('else' === rule.u.stage) rule.u.stage = 'done'
      } else {
        rule.node = child.node
      }
    },
    '@cond-q': (rule: Rule): void => {
      wrapInPlace(rule.node, 'conditional_expression')
      dropToken(rule.node, rule.c0 as Token)
      rule.u.stage = 'then'
    },
    '@cond-at-then': (rule: Rule): boolean => 'then' === rule.u.stage,
    '@cond-colon': (rule: Rule): void => {
      dropToken(rule.node, rule.c0 as Token)
      rule.u.stage = 'else'
    },
    '@cond-done': (rule: Rule): boolean => 'done' === rule.u.stage,
    '@cond-at-test': (rule: Rule): boolean => undefined === rule.u.stage,

    // ---- binary operators: precedence climbing ---------------------
    //
    // `binary` takes an operand and, while the next operator binds at
    // least as tightly as the rule's level (k.min, handed down by the
    // rule that pushed it), wraps what it has in a binary_expression and
    // replaces itself with binary_rhs, which pushes a `binary` one level
    // tighter for the right operand. The chain of a left-associative
    // operator is so one replace loop at one depth.
    '@binary-bo': (rule: Rule): void => {
      fresh(rule)
      rule.u.min = rule.k.min ?? 0
    },
    '@binary-bc': relay,
    // The token after the operand (the operator alternate before this
    // one fetched it) is not an identifier or a literal.
    '@not-juxtaposed': (_rule: Rule, ctx: Context): boolean => {
      const t = ctx.t[0] as any
      return !(t && JUXTAPOSED.has(t.name))
    },
    '@binary_rhs-bo': (rule: Rule): void => {
      isCarried(rule)
      rule.u.min = rule.k.binMin ?? 0
    },
    '@binary_rhs-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (child) rule.node.children.push(child.node)
    },
    '@bin-binds': (rule: Rule): boolean => {
      const prec = BINARY_PRECEDENCE[(rule.c0 as Token).name]
      return undefined !== prec && prec >= rule.u.min
    },
    '@bin-op': (rule: Rule): void => {
      const op = rule.c0 as Token
      wrapInPlace(rule.node, 'binary_expression')
      rule.node.op = op.src
      dropToken(rule.node, op)
      rule.k.binMin = rule.u.min
      rule.k.min = BINARY_PRECEDENCE[op.name] + 1
      carryOn(rule)
    },

    // ---- casts and compound literals -------------------------------
    '@cast_expression-bo': fresh,
    '@cast_expression-bc': relay,
    '@cast-was-cl': (rule: Rule): boolean => {
      const n = rule.node
      if (n && 'compound_literal' === n.kind && !rule.u.postfixed) {
        rule.u.postfixed = true
        carryOn(rule)
        return true
      }
      return false
    },

    '@cast_or_compound_literal-bo': (rule: Rule): void => {
      rule.node = makeNode('cast_expression')
    },
    '@cocl-open': (rule: Rule): void => {
      keepToken(rule.node, rule.o0 as Token)
    },
    '@cast_or_compound_literal-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (!child) return
      if ('type_name' === child.name) {
        rule.node.children.push(child.node)
        return
      }
      rule.node.children.push(child.node)
      rule.u.done = true
    },
    '@cocl-cl': (rule: Rule): void => {
      rule.node.kind = 'compound_literal'
      keepToken(rule.node, rule.c0 as Token)
    },
    '@cocl-cast': (rule: Rule): void => {
      keepToken(rule.node, rule.c0 as Token)
    },
    '@cocl-done': (rule: Rule): boolean => rule.u.done === true,

    // ---- unary -----------------------------------------------------
    '@unary_expression-bo': fresh,
    '@unary_expression-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (!child) return
      if (rule.u.prefix) {
        rule.node.children.push(child.node)
        // A prefix operator's node takes its operand's span, as the
        // node an operator builds takes its first term's.
        rule.node.span = child.node.span
      } else {
        rule.node = child.node
      }
    },
    '@prefix': (rule: Rule): void => {
      const op = rule.o0 as Token
      rule.node = makeNode('unary_expression')
      rule.node.op = op.src
      dropToken(rule.node, op)
      rule.u.prefix = true
    },

    // ---- postfix ---------------------------------------------------
    '@postfix_expression-bo': fresh,
    '@postfix_expression-bc': relay,
    '@postfix_more-bo': (rule: Rule): void => {
      isCarried(rule)
    },
    '@postfix_more-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (!child) return
      if ('subscript' === rule.u.pending) {
        rule.u.index.children.push(child.node)
      } else if ('call' === rule.u.pending) {
        // The argument list takes its call's span, as it always has.
        child.node.span = rule.node.span
        rule.node.children.push(child.node)
        rule.u.args = child.node
      }
    },
    '@subscript': (rule: Rule): void => {
      wrapInPlace(rule.node, 'subscript_expression')
      const index = makeNode('index_list', rule.node.span)
      dropToken(index, rule.c0 as Token)
      rule.node.children.push(index)
      rule.u.index = index
      rule.u.pending = 'subscript'
    },
    '@pm-in-subscript': (rule: Rule): boolean => 'subscript' === rule.u.pending,
    '@pm-free': (rule: Rule): boolean => undefined === rule.u.pending,
    '@pf-carry': carryOn,
    '@pm-rbracket': (rule: Rule): void => {
      dropToken(rule.u.index, rule.c0 as Token)
      carryOn(rule)
    },
    '@call': (rule: Rule): void => {
      const callee = wrapInPlace(rule.node, 'call_expression')
      if ('identifier_expression' === callee.kind) {
        rule.node.callee = callee.name
        const idTok = (callee.children || []).find(
          (c: any) => c && 'token' === c.kind && !String(c.tname).startsWith('TRIVIA'))
        rule.node.isMacro = !!(idTok && 'MACRO_NAME' === idTok.tname)
      }
      rule.u.pending = 'call'
      rule.k.callParen = rule.c0
    },
    '@pm-in-call': (rule: Rule): boolean => 'call' === rule.u.pending,
    '@pm-rparen': (rule: Rule): void => {
      dropToken(rule.u.args, rule.c0 as Token)
      carryOn(rule)
    },
    '@member': (rule: Rule): void => {
      const op = rule.c0 as Token
      const name = rule.c1 as Token
      wrapInPlace(rule.node, 'member_expression')
      dropToken(rule.node, op)
      rule.node.children.push(atom('identifier_expression', name))
      rule.node.memberName = name.src
      rule.node.op = op.src
      carryOn(rule)
    },
    '@postfix': (rule: Rule): void => {
      const op = rule.c0 as Token
      wrapInPlace(rule.node, 'postfix_unary_expression')
      rule.node.op = op.src
      dropToken(rule.node, op)
      carryOn(rule)
    },

    // ---- arguments -------------------------------------------------
    '@argument_list-bo': (rule: Rule): void => {
      rule.u.carried = isCarried(rule)
      if (!rule.u.carried) {
        rule.node = makeNode('argument_list')
        const lp = rule.k.callParen as Token | undefined
        if (lp) dropToken(rule.node, lp)
      }
      delete rule.k.callParen
    },
    '@argument_list-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (child) rule.node.children.push(child.node)
    },
    '@args-first': (rule: Rule): boolean => rule.u.carried !== true,
    '@args-comma': (rule: Rule): void => {
      dropToken(rule.node, rule.c0 as Token)
      carryOn(rule)
    },

    // ---- primary ---------------------------------------------------
    '@primary_expression-bo': fresh,
    '@primary_expression-bc': (rule: Rule): void => {
      const child = freshChild(rule)
      if (!child) return
      if (rule.u.paren) {
        rule.node.children.push(child.node)
        rule.node.span = child.node.span
      } else {
        rule.node = child.node
      }
    },
    '@lit': (rule: Rule): void => {
      rule.node = atom('literal_expression', rule.o0 as Token)
    },
    '@ident': (rule: Rule): void => {
      rule.node = atom('identifier_expression', rule.o0 as Token)
    },
    '@paren-open': (rule: Rule): void => {
      rule.node = makeNode('paren_expression')
      dropToken(rule.node, rule.o0 as Token)
      rule.u.paren = true
    },
    '@paren-pending': (rule: Rule): boolean =>
      rule.u.paren === true && rule.u.parenClosed !== true,
    '@paren-free': (rule: Rule): boolean =>
      rule.u.paren !== true || rule.u.parenClosed === true,
    '@paren-close': (rule: Rule): void => {
      dropToken(rule.node, rule.c0 as Token)
      rule.u.parenClosed = true
    },
  }
}

// Leading trivia refs, re-exported for the plugin's other refs.
export { leadingTriviaRefs, tok }
