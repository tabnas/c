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
