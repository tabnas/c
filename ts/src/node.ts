/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// The tree's nodes, and the few operations every rule uses to build one.
//
// A rule builds its node from the tokens its alternates consume and the
// nodes of the rules it pushes. A token is either KEPT, as a child token
// reference, or DROPPED, where the node holds what it says in a field
// (an operator as `op`) or not at all (a call's parentheses). Either
// way the comments and line continuations the lexer put before it (the
// sub-lex hook attaches them to the next token's `use.leading`) become
// children of the node at that place, so no comment is lost.

import type { Token } from '@tabnas/parser'

export interface Span { start: number; end: number; line: number; col: number }

export interface CTokenRef {
  kind: 'token'
  tname: string
  src: string
  span: Span
}

export interface CNode {
  kind: string
  span: Span
  children: Array<CNode | CTokenRef>
  trivia: { leading: CTokenRef[]; trailing: CTokenRef[] }
  [extra: string]: any
}

export function zeroSpan(): Span {
  return { start: 0, end: 0, line: 1, col: 1 }
}

export function tokenSpan(tkn: Token): Span {
  return { start: tkn.sI, end: tkn.sI + tkn.len, line: tkn.rI, col: tkn.cI }
}

export function tokenRef(tkn: Token): CTokenRef {
  return { kind: 'token', tname: tkn.name, src: tkn.src, span: tokenSpan(tkn) }
}

export function makeNode(kind: string, span?: Span): CNode {
  return {
    kind,
    span: span ?? zeroSpan(),
    children: [],
    trivia: { leading: [], trailing: [] },
  }
}

// The comments and line continuations before `tkn`, as token references.
export function leadingTriviaRefs(tkn: Token): CTokenRef[] {
  const leading = (tkn as any).use && (tkn as any).use.leading
  if (!Array.isArray(leading)) return []
  return leading.map((lt: Token) => tokenRef(lt))
}

// Keep `tkn` as a child of `node`, after the trivia before it.
export function keepToken(node: CNode, tkn: Token): void {
  for (const tr of leadingTriviaRefs(tkn)) node.children.push(tr)
  node.children.push(tokenRef(tkn))
}

// Drop `tkn` from the tree but keep the trivia before it, as children of
// `node` at this place.
export function dropToken(node: CNode, tkn: Token): void {
  for (const tr of leadingTriviaRefs(tkn)) node.children.push(tr)
}

// Is `v` a node of the tree (not a token reference, not a raw value)?
export function isNode(v: any): v is CNode {
  return null != v && 'object' === typeof v && 'string' === typeof v.kind &&
    'token' !== v.kind && Array.isArray(v.children)
}

// The node's child nodes, tokens left out.
export function childNodes(node: CNode): CNode[] {
  return node.children.filter(isNode) as CNode[]
}

const isTrivia = (t: CTokenRef): boolean => t.tname.startsWith('TRIVIA_')

// Give every node in a subtree its span: the span of the first token it
// keeps, comments and line continuations left out; a node that keeps no
// token takes its parent's. Run once a subtree is complete: an external
// declaration when it ends, an expression parsed on its own. A node
// already given its span (an external declaration inside a conditional
// group) is not walked again. The walks are iterative: a chain of
// operators nests as deep as it is long.
export function fixSpans(node: CNode, parent?: Span): void {
  const first = new Map<CNode, Span | undefined>()
  // Post-order: each node's first kept token, from its children's.
  const stack: Array<[CNode, number]> = [[node, 0]]
  while (stack.length) {
    const top = stack[stack.length - 1]
    const [n, i] = top
    if ((n as any)[FIXED]) { first.set(n, n.span); stack.pop(); continue }
    if (i < n.children.length) {
      top[1] = i + 1
      const c = n.children[i]
      if (isNode(c) && !first.has(c)) stack.push([c, 0])
      continue
    }
    let f: Span | undefined
    for (const c of n.children) {
      if (!c || 'object' !== typeof c) continue
      const s = (c as any).kind === 'token'
        ? (isTrivia(c as CTokenRef) ? undefined : (c as CTokenRef).span)
        : isNode(c) ? first.get(c) : undefined
      if (s) { f = s; break }
    }
    first.set(n, f)
    stack.pop()
  }
  // Pre-order: a node with no token of its own takes its parent's span.
  const todo: Array<[CNode, Span]> = [[node, parent ?? zeroSpan()]]
  while (todo.length) {
    const [n, p] = todo.pop()!
    if ((n as any)[FIXED]) continue
    const f = first.get(n)
    n.span = f ? { ...f } : { ...p }
    Object.defineProperty(n, FIXED, { value: true, enumerable: false })
    for (const c of n.children) if (isNode(c)) todo.push([c, n.span])
  }
}

const FIXED = Symbol('spans')
