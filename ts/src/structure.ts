/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Post-processing pass that turns the flat token list captured by the
// external_declaration chomper into a structured concrete-syntax tree.
//
// Approach: recursive-descent over a TokenStream that hides trivia from
// grammar-level decisions but emits trivia tokens in source order as
// siblings of the next real token. Each parse* function returns a node
// (or null) and advances the stream; the caller wires it into a parent
// node.
//
// This is a deliberate trade: we get a clean structured tree without
// reworking jsonic's grammar machinery for the full C grammar, at the
// cost of doing the parse twice (once to chomp the tokens, once here to
// structure them). Future slices may collapse this into in-line jsonic
// rules; for now the approach lets each C construct live as a small
// composable function.

import type { Token } from '@tabnas/parser'
import { parseExpression } from './expr.js'

export interface Span {
  start: number; end: number; line: number; col: number
}

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

const PRESERVED_TRIVIA = new Set([
  'TRIVIA_LINE_COMMENT', 'TRIVIA_BLOCK_COMMENT', 'TRIVIA_LINE_CONT',
])

const STORAGE_CLASS = new Set([
  'KW_TYPEDEF', 'KW_EXTERN', 'KW_STATIC', 'KW_AUTO', 'KW_REGISTER',
  'KW__THREAD_LOCAL', 'KW_THREAD_LOCAL', 'KW_CONSTEXPR',
  'KW___THREAD',
])

const TYPE_QUALIFIER = new Set([
  'KW_CONST', 'KW_VOLATILE', 'KW_RESTRICT', 'KW__ATOMIC',
  'KW___CONST__', 'KW___CONST',
  'KW___VOLATILE__', 'KW___VOLATILE',
  'KW___RESTRICT__', 'KW___RESTRICT',
])

const FUNCTION_SPECIFIER = new Set([
  'KW_INLINE', 'KW___INLINE__', 'KW___INLINE',
  'KW__NORETURN',
])

const SIMPLE_TYPE_SPEC = new Set([
  'KW_VOID', 'KW_CHAR', 'KW_SHORT', 'KW_INT', 'KW_LONG', 'KW_FLOAT',
  'KW_DOUBLE', 'KW_SIGNED', 'KW_UNSIGNED', 'KW_BOOL', 'KW__BOOL',
  'KW__COMPLEX', 'KW__IMAGINARY',
  'KW___SIGNED__', 'KW___SIGNED',
  'KW___INT8', 'KW___INT16', 'KW___INT32', 'KW___INT64',
])

const ATTRIBUTE_OPENERS = new Set([
  'KW___ATTRIBUTE__', 'KW___ATTRIBUTE',
  'KW___DECLSPEC',
])

// True for identifier-like tokens (plain IDs and macro-name IDs that
// the lexer flagged via the macro table). TYPEDEF_NAME is NOT included
// here — it's treated specially by callers when relevant.
function isIdLike(name: string | null): boolean {
  return name === 'ID' || name === 'MACRO_NAME'
}

function isSpecifierStart(name: string): boolean {
  return STORAGE_CLASS.has(name) ||
         TYPE_QUALIFIER.has(name) ||
         FUNCTION_SPECIFIER.has(name) ||
         SIMPLE_TYPE_SPEC.has(name) ||
         ATTRIBUTE_OPENERS.has(name) ||
         name === 'KW_STRUCT' || name === 'KW_UNION' || name === 'KW_ENUM' ||
         name === 'KW_TYPEOF' || name === 'KW_TYPEOF_UNQUAL' ||
         name === 'KW___TYPEOF__' || name === 'KW___TYPEOF' ||
         name === 'KW__BITINT' ||
         name === 'KW_ALIGNAS' || name === 'KW__ALIGNAS' ||
         name === 'KW___EXTENSION__' ||
         name === 'TYPEDEF_NAME'
}

function tokenRef(t: Token): CTokenRef {
  return {
    kind: 'token',
    tname: t.name,
    src: t.src,
    span: { start: t.sI, end: t.sI + t.len, line: t.rI, col: t.cI },
  }
}

function makeNode(kind: string, startSpan?: Span): CNode {
  return {
    kind,
    span: startSpan ?? { start: 0, end: 0, line: 1, col: 1 },
    children: [],
    trivia: { leading: [], trailing: [] },
  }
}

// Clone-ish span from a token.
function spanOf(t: Token): Span {
  return { start: t.sI, end: t.sI + t.len, line: t.rI, col: t.cI }
}

// ---- TokenStream ----------------------------------------------------

export class TokenStream {
  i: number = 0
  constructor(public tokens: Token[]) {}

  // Skip past trivia and return the next real token, or null at end.
  peek(off: number = 0): Token | null {
    let i = this.i
    let seen = 0
    while (i < this.tokens.length) {
      const t = this.tokens[i]
      if (PRESERVED_TRIVIA.has(t.name)) { i++; continue }
      if (seen === off) return t
      seen++
      i++
    }
    return null
  }

  peekName(off: number = 0): string | null {
    return this.peek(off)?.name ?? null
  }

  done(): boolean { return this.peek() === null }

  // Consume the next real token along with any preceding trivia.
  // Returns the trivia refs followed by the real token's ref.
  take(): { trivia: CTokenRef[]; tkn: Token; ref: CTokenRef } | null {
    const trivia: CTokenRef[] = []
    while (this.i < this.tokens.length) {
      const t = this.tokens[this.i]
      if (PRESERVED_TRIVIA.has(t.name)) {
        trivia.push(tokenRef(t))
        this.i++
        continue
      }
      this.i++
      return { trivia, tkn: t, ref: tokenRef(t) }
    }
    return null
  }

  // Push the trivia and the just-taken real token onto a node's children.
  takeInto(node: CNode): Token | null {
    const taken = this.take()
    if (!taken) return null
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    return taken.tkn
  }

  mark(): number { return this.i }
  restore(m: number) { this.i = m }
}

// ---- Helpers for balanced punctuator skipping -----------------------

function consumeBalanced(
  ts: TokenStream, node: CNode,
  open: string, close: string,
): boolean {
  if (ts.peekName() !== open) return false
  ts.takeInto(node) // open
  let depth = 1
  while (depth > 0 && !ts.done()) {
    const n = ts.peekName()
    if (n === open) depth++
    else if (n === close) depth--
    ts.takeInto(node)
  }
  return depth === 0
}

// ---- Specifier parsing ----------------------------------------------

export function parseDeclarationSpecifiers(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  // C23 [[ ... ]] at the head also opens a declaration.
  const c23Head = isC23AttributeOpen(ts)
  if (!isSpecifierStart(startTkn.name) && !c23Head) return null
  const node = makeNode('declaration_specifiers', spanOf(startTkn))

  // The legal sequence permits a single TYPEDEF_NAME (after which any
  // further ID belongs to the declarator). Track it to avoid confusing
  // `T x` with `T int`-style nonsense.
  let sawTypedefName = false

  while (true) {
    const tkn = ts.peek()
    if (!tkn) break
    const n = tkn.name

    if (n === 'TYPEDEF_NAME') {
      if (sawTypedefName) break
      sawTypedefName = true
      ts.takeInto(node)
      continue
    }
    if (STORAGE_CLASS.has(n) || TYPE_QUALIFIER.has(n) ||
        FUNCTION_SPECIFIER.has(n) || SIMPLE_TYPE_SPEC.has(n) ||
        n === 'KW___EXTENSION__' ||
        n === 'KW_TYPEOF' || n === 'KW_TYPEOF_UNQUAL' ||
        n === 'KW___TYPEOF__' || n === 'KW___TYPEOF' ||
        n === 'KW__BITINT' ||
        n === 'KW_ALIGNAS' || n === 'KW__ALIGNAS') {
      // typeof/_BitInt/alignas have a parenthesised argument list — fold
      // it into the specifier node.
      ts.takeInto(node)
      if ((n === 'KW_TYPEOF' || n === 'KW_TYPEOF_UNQUAL' ||
           n === 'KW___TYPEOF__' || n === 'KW___TYPEOF' ||
           n === 'KW__BITINT' ||
           n === 'KW_ALIGNAS' || n === 'KW__ALIGNAS') &&
          ts.peekName() === 'PUNC_LPAREN') {
        consumeBalanced(ts, node, 'PUNC_LPAREN', 'PUNC_RPAREN')
      }
      continue
    }
    if (ATTRIBUTE_OPENERS.has(n)) {
      const attr = parseAttributeSpec(ts)
      if (attr) node.children.push(attr)
      else ts.takeInto(node)
      continue
    }
    if (isC23AttributeOpen(ts)) {
      const attr = parseC23AttributeSpec(ts)
      if (attr) node.children.push(attr)
      else ts.takeInto(node)
      continue
    }
    if (n === 'KW_STRUCT' || n === 'KW_UNION') {
      const sus = parseStructOrUnionSpec(ts)
      if (sus) node.children.push(sus)
      continue
    }
    if (n === 'KW_ENUM') {
      const en = parseEnumSpec(ts)
      if (en) node.children.push(en)
      continue
    }
    break
  }

  if (node.children.length === 0) return null
  return node
}

// True when the head of `ts` is the C23 `[[` attribute opener: two
// adjacent PUNC_LBRACKETs in the source (no intervening characters).
function isC23AttributeOpen(ts: TokenStream): boolean {
  const a = ts.peek()
  const b = ts.peek(1)
  if (!a || !b) return false
  if (a.name !== 'PUNC_LBRACKET' || b.name !== 'PUNC_LBRACKET') return false
  return a.sI + a.len === b.sI
}

// True when the head of `ts` is the C23 `]]` attribute closer.
function isC23AttributeClose(ts: TokenStream): boolean {
  const a = ts.peek()
  const b = ts.peek(1)
  if (!a || !b) return false
  if (a.name !== 'PUNC_RBRACKET' || b.name !== 'PUNC_RBRACKET') return false
  return a.sI + a.len === b.sI
}

// Parse a C23 `[[ items ]]` attribute spec. Returns null if the head
// isn't `[[`.
export function parseC23AttributeSpec(ts: TokenStream): CNode | null {
  if (!isC23AttributeOpen(ts)) return null
  const startTkn = ts.peek()!
  const node = makeNode('attribute_spec', spanOf(startTkn))
  node.attributeForm = 'c23'
  node.items = [] as any[]
  ts.takeInto(node) // first '['
  ts.takeInto(node) // second '['

  while (!ts.done()) {
    if (isC23AttributeClose(ts)) {
      ts.takeInto(node) // first ']'
      ts.takeInto(node) // second ']'
      break
    }
    if (ts.peekName() === 'PUNC_COMMA') {
      ts.takeInto(node)
      continue
    }
    const item = parseAttributeItem(ts)
    if (item) {
      node.children.push(item)
      node.items.push(item)
    } else {
      ts.takeInto(node)
    }
  }
  return node
}

// Generic attribute spec parser that dispatches between GCC, MSVC, and
// C23 forms. Returns null if no attribute starts here.
export function parseAnyAttributeSpec(ts: TokenStream): CNode | null {
  const head = ts.peek()
  if (!head) return null
  if (ATTRIBUTE_OPENERS.has(head.name)) return parseAttributeSpec(ts)
  if (isC23AttributeOpen(ts)) return parseC23AttributeSpec(ts)
  return null
}

export function parseAttributeSpec(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn || !ATTRIBUTE_OPENERS.has(startTkn.name)) return null
  const node = makeNode('attribute_spec', spanOf(startTkn))
  node.attributeForm = startTkn.src.startsWith('__attribute')
    ? 'gcc'
    : startTkn.src === '__declspec'
      ? 'msvc'
      : 'unknown'
  ts.takeInto(node) // __attribute__ / __declspec / __attribute

  // GCC: __attribute__((...))  — double parens. The inner parens hold a
  // comma-separated attribute list.
  // MSVC: __declspec(...)      — single parens, list.
  if (ts.peekName() !== 'PUNC_LPAREN') return node
  ts.takeInto(node) // outer '('

  let needsCloseOuter = false
  if (node.attributeForm === 'gcc' && ts.peekName() === 'PUNC_LPAREN') {
    ts.takeInto(node) // inner '('
    needsCloseOuter = true
  }

  // Attribute item list inside the (innermost) parentheses.
  node.items = [] as any[]
  while (!ts.done() && ts.peekName() !== 'PUNC_RPAREN') {
    if (ts.peekName() === 'PUNC_COMMA') {
      ts.takeInto(node)
      continue
    }
    const item = parseAttributeItem(ts)
    if (item) {
      node.children.push(item)
      node.items.push(item)
    } else {
      // Defensive: avoid infinite loop on unrecognised tokens.
      ts.takeInto(node)
    }
  }

  if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(node) // inner / sole ')'
  if (needsCloseOuter && ts.peekName() === 'PUNC_RPAREN') ts.takeInto(node)
  return node
}

// Single GCC / MSVC attribute item: name (optional :: namespace) plus
// optional argument list.
function parseAttributeItem(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  // The name slot can be an identifier OR a reserved word like
  // `const`, `__const__`, `nothrow` etc. Accept any non-punctuator.
  const nameOk = startTkn.name === 'ID' ||
                 startTkn.name === 'TYPEDEF_NAME' ||
                 startTkn.name === 'MACRO_NAME' ||
                 startTkn.name.startsWith('KW_')
  if (!nameOk) return null
  const node = makeNode('attribute_item', spanOf(startTkn))
  const nameTaken = ts.take()!
  for (const tr of nameTaken.trivia) node.children.push(tr)
  node.children.push(nameTaken.ref)
  node.attributeName = nameTaken.tkn.src

  // C23 namespaced form: `prefix :: name`.
  if (ts.peekName() === 'PUNC_COLON' && ts.peekName(1) === 'PUNC_COLON') {
    // Take both colons.
    ts.takeInto(node)
    ts.takeInto(node)
    const tail = ts.peek()
    if (tail && (tail.name === 'ID' || tail.name === 'TYPEDEF_NAME' ||
                 tail.name === 'MACRO_NAME' || tail.name.startsWith('KW_'))) {
      const t = ts.take()!
      for (const tr of t.trivia) node.children.push(tr)
      node.children.push(t.ref)
      node.attributePrefix = node.attributeName
      node.attributeName = t.tkn.src
    }
  }

  // Optional argument list.
  if (ts.peekName() === 'PUNC_LPAREN') {
    const args = makeNode('attribute_argument_list', spanOf(ts.peek()!))
    ts.takeInto(args) // '('
    while (!ts.done() && ts.peekName() !== 'PUNC_RPAREN') {
      // Each argument is an assignment-expression; commas separate.
      const a = parseExpression(
        ts, new Set(['PUNC_COMMA', 'PUNC_RPAREN']),
      )
      if (a) args.children.push(a)
      else ts.takeInto(args)
      if (ts.peekName() === 'PUNC_COMMA') ts.takeInto(args)
    }
    if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(args)
    node.children.push(args)
    node.argumentList = args
  }

  return node
}

export function parseStructOrUnionSpec(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn || (startTkn.name !== 'KW_STRUCT' && startTkn.name !== 'KW_UNION')) return null
  const kind = startTkn.name === 'KW_STRUCT' ? 'struct_specifier' : 'union_specifier'
  const node = makeNode(kind, spanOf(startTkn))
  ts.takeInto(node) // 'struct' or 'union'

  // Optional attribute spec between keyword and tag/body.
  while (ts.peek() && ATTRIBUTE_OPENERS.has(ts.peekName()!)) {
    const a = parseAttributeSpec(ts)
    if (a) node.children.push(a)
  }

  // Optional tag identifier.
  const next = ts.peek()
  if (next && (isIdLike(next.name) || next.name === 'TYPEDEF_NAME')) {
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    node.tagName = taken.tkn.src
  }

  // Optional body — split into struct_declaration nodes.
  if (ts.peekName() === 'PUNC_LBRACE') {
    const body = makeNode('member_decl_list', spanOf(ts.peek()!))
    ts.takeInto(body) // '{'
    while (!ts.done() && ts.peekName() !== 'PUNC_RBRACE') {
      const member = parseStructDeclaration(ts)
      if (member) {
        body.children.push(member)
      } else {
        // Defensive: take one token to avoid infinite loop.
        ts.takeInto(body)
      }
    }
    if (ts.peekName() === 'PUNC_RBRACE') ts.takeInto(body) // '}'
    node.children.push(body)
  }

  return node
}

// struct_declaration:
//   specifier_qualifier_list struct_declarator_list? ';'
// | static_assert_declaration
// | ';'                              (empty member, GCC extension)
export function parseStructDeclaration(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null

  // static_assert at member level.
  const n0 = startTkn.name
  if (n0 === 'KW_STATIC_ASSERT' || n0 === 'KW__STATIC_ASSERT') {
    return parseStaticAssertDeclaration(ts)
  }

  // Empty member: just `;`.
  if (n0 === 'PUNC_SEMI') {
    const empty = makeNode('struct_declaration', spanOf(startTkn))
    ts.takeInto(empty)
    return empty
  }

  const node = makeNode('struct_declaration', spanOf(startTkn))
  // specifier_qualifier_list — same shape as declaration_specifiers but
  // without storage classes and function specifiers. We reuse the
  // common parser; bogus storage-classes inside a struct are a semantic
  // error, not a parse error.
  const sql = parseDeclarationSpecifiers(ts)
  if (sql) {
    sql.kind = 'specifier_qualifier_list'
    node.children.push(sql)
  }

  // Optional struct_declarator_list.
  if (ts.peekName() !== 'PUNC_SEMI' && !ts.done()) {
    const sdl = parseStructDeclaratorList(ts)
    if (sdl) node.children.push(sdl)
  }

  if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
  return node
}

// struct_declarator_list:
//   struct_declarator (',' struct_declarator)*
// struct_declarator:
//   declarator
// | declarator? ':' constant_expression          (bitfield)
export function parseStructDeclaratorList(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('struct_declarator_list', spanOf(startTkn))
  const first = parseStructDeclarator(ts)
  if (!first) return null
  node.children.push(first)
  while (ts.peekName() === 'PUNC_COMMA') {
    ts.takeInto(node)
    const next = parseStructDeclarator(ts)
    if (!next) break
    node.children.push(next)
  }
  return node
}

export function parseStructDeclarator(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('struct_declarator', spanOf(startTkn))

  // Optional declarator (absent in `: 4` anonymous bitfields).
  if (ts.peekName() !== 'PUNC_COLON') {
    const d = parseDeclarator(ts, false)
    if (d) {
      node.children.push(d)
      if (d.declaredName) node.declaredName = d.declaredName
    }
  }

  // Optional bitfield width: `:` constant-expression.
  if (ts.peekName() === 'PUNC_COLON') {
    const bf = makeNode('bitfield_width', spanOf(ts.peek()!))
    ts.takeInto(bf) // ':'
    // Constant-expression — opaque until top-level `,` or `;`.
    let parenD = 0, bracketD = 0
    while (!ts.done()) {
      const n = ts.peekName()
      if (n === 'PUNC_LPAREN') { parenD++; ts.takeInto(bf); continue }
      if (n === 'PUNC_RPAREN') {
        if (parenD === 0) break
        parenD--; ts.takeInto(bf); continue
      }
      if (n === 'PUNC_LBRACKET') { bracketD++; ts.takeInto(bf); continue }
      if (n === 'PUNC_RBRACKET') {
        if (bracketD === 0) break
        bracketD--; ts.takeInto(bf); continue
      }
      if (parenD === 0 && bracketD === 0 &&
          (n === 'PUNC_COMMA' || n === 'PUNC_SEMI')) break
      ts.takeInto(bf)
    }
    node.children.push(bf)
  }

  // Optional trailing attribute spec.
  while (ts.peek() && ATTRIBUTE_OPENERS.has(ts.peekName()!)) {
    const a = parseAttributeSpec(ts)
    if (a) node.children.push(a); else break
  }

  return node.children.length > 0 ? node : null
}

export function parseEnumSpec(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn || startTkn.name !== 'KW_ENUM') return null
  const node = makeNode('enum_specifier', spanOf(startTkn))
  ts.takeInto(node) // 'enum'

  while (ts.peek() && ATTRIBUTE_OPENERS.has(ts.peekName()!)) {
    const a = parseAttributeSpec(ts)
    if (a) node.children.push(a)
  }

  const next = ts.peek()
  if (next && (isIdLike(next.name) || next.name === 'TYPEDEF_NAME')) {
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    node.tagName = taken.tkn.src
  }

  // C23: optional ': type-specifier' for fixed-underlying-type enums.
  if (ts.peekName() === 'PUNC_COLON') {
    ts.takeInto(node)
    const ts2 = parseDeclarationSpecifiers(ts)
    if (ts2) node.children.push(ts2)
  }

  // Optional body — split into enumerator nodes.
  if (ts.peekName() === 'PUNC_LBRACE') {
    const body = makeNode('enumerator_list', spanOf(ts.peek()!))
    ts.takeInto(body) // '{'
    while (!ts.done() && ts.peekName() !== 'PUNC_RBRACE') {
      const e = parseEnumerator(ts)
      if (e) body.children.push(e)
      else ts.takeInto(body)
      if (ts.peekName() === 'PUNC_COMMA') ts.takeInto(body)
    }
    if (ts.peekName() === 'PUNC_RBRACE') ts.takeInto(body) // '}'
    node.children.push(body)
  }

  return node
}

// enumerator: enumeration-constant attribute-specifier-seq? ('=' const-expr)?
export function parseEnumerator(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const n = startTkn.name
  if (n !== 'ID' && n !== 'TYPEDEF_NAME' && n !== 'MACRO_NAME') return null
  const node = makeNode('enumerator', spanOf(startTkn))
  const taken = ts.take()!
  for (const tr of taken.trivia) node.children.push(tr)
  node.children.push(taken.ref)
  node.declaredName = taken.tkn.src

  // Optional [[attribute]] in C23 / __attribute__ in GCC.
  while (true) {
    const a = parseAnyAttributeSpec(ts)
    if (!a) break
    node.children.push(a)
  }

  if (ts.peekName() === 'PUNC_ASSIGN') {
    ts.takeInto(node) // '='
    // Constant-expression — opaque until top-level `,` or `}`.
    const init = makeNode('initializer', spanOf(ts.peek() || startTkn))
    let parenD = 0, bracketD = 0
    while (!ts.done()) {
      const nn = ts.peekName()
      if (nn === 'PUNC_LPAREN') { parenD++; ts.takeInto(init); continue }
      if (nn === 'PUNC_RPAREN') {
        if (parenD === 0) break
        parenD--; ts.takeInto(init); continue
      }
      if (nn === 'PUNC_LBRACKET') { bracketD++; ts.takeInto(init); continue }
      if (nn === 'PUNC_RBRACKET') {
        if (bracketD === 0) break
        bracketD--; ts.takeInto(init); continue
      }
      if (parenD === 0 && bracketD === 0 &&
          (nn === 'PUNC_COMMA' || nn === 'PUNC_RBRACE')) break
      ts.takeInto(init)
    }
    node.children.push(init)
  }
  return node
}

// ---- Declarator parsing ---------------------------------------------

export function parseDeclarator(ts: TokenStream, abstract = false): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode(abstract ? 'abstract_declarator' : 'declarator', spanOf(startTkn))

  // Pointer prefix: '*' qualifier* (repeated).
  while (ts.peekName() === 'PUNC_STAR') {
    const ptr = makeNode('pointer', spanOf(ts.peek()!))
    ts.takeInto(ptr) // '*'
    while (true) {
      const n = ts.peekName()
      if (n && (TYPE_QUALIFIER.has(n) ||
                n === 'KW___PTR32' || n === 'KW___PTR64' ||
                n === 'KW___UNALIGNED')) {
        ts.takeInto(ptr)
        continue
      }
      if (n && ATTRIBUTE_OPENERS.has(n)) {
        const a = parseAttributeSpec(ts)
        if (a) ptr.children.push(a); else break
        continue
      }
      break
    }
    node.children.push(ptr)
  }

  // direct declarator
  const dd = parseDirectDeclarator(ts, abstract)
  if (!dd) {
    if (abstract && node.children.length > 0) return node
    return node.children.length > 0 ? node : null
  }
  node.children.push(dd)
  if (dd.declaredName) node.declaredName = dd.declaredName
  return node
}

function parseDirectDeclarator(ts: TokenStream, abstract: boolean): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode(abstract ? 'direct_abstract_declarator' : 'direct_declarator', spanOf(startTkn))

  // Primary: ID, or '(' declarator ')', or empty (abstract).
  const n0 = ts.peekName()
  if (isIdLike(n0)) {
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    node.declaredName = taken.tkn.src
  } else if (n0 === 'PUNC_LPAREN') {
    // Could be parenthesised subdeclarator OR the start of a function
    // postfix (parameter list) on an abstract declarator. Disambiguate:
    // peek the first non-trivia token inside `(`.
    const m = ts.mark()
    ts.takeInto(node) // '('
    const inner = ts.peek()
    if (inner && (inner.name === 'PUNC_STAR' ||
                  inner.name === 'PUNC_LPAREN' ||
                  isIdLike(inner.name) ||
                  ATTRIBUTE_OPENERS.has(inner.name))) {
      // Subdeclarator
      const sub = parseDeclarator(ts, abstract)
      if (sub) {
        node.children.push(sub)
        if (sub.declaredName) node.declaredName = sub.declaredName
      }
      // Expect ')'
      if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(node)
    } else {
      // Looked like a function parameter list directly — rewind and let
      // postfix loop pick it up.
      ts.restore(m)
    }
  } else if (!abstract) {
    return null
  }

  // Postfixes: '[' ... ']' or '(' parameter_list ')'.
  while (!ts.done()) {
    const n = ts.peekName()
    if (n === 'PUNC_LBRACKET') {
      const arr = makeNode('array_postfix', spanOf(ts.peek()!))
      consumeBalanced(ts, arr, 'PUNC_LBRACKET', 'PUNC_RBRACKET')
      node.children.push(arr)
      continue
    }
    if (n === 'PUNC_LPAREN') {
      const fn = parseFunctionPostfix(ts)
      if (fn) node.children.push(fn)
      continue
    }
    break
  }

  if (node.children.length === 0 && !abstract) return null
  return node
}

// '(' parameter_type_list? ')'  or  '(' identifier_list? ')'  (K&R)
export function parseFunctionPostfix(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn || startTkn.name !== 'PUNC_LPAREN') return null
  const node = makeNode('function_postfix', spanOf(startTkn))
  ts.takeInto(node) // '('

  // Empty list — `()` (K&R unspecified prototype).
  if (ts.peekName() === 'PUNC_RPAREN') {
    ts.takeInto(node)
    return node
  }

  // ANSI prototype with explicit `void` and no params.
  if (ts.peekName() === 'KW_VOID' && ts.peekName(1) === 'PUNC_RPAREN') {
    const ptl = makeNode('parameter_type_list', spanOf(ts.peek()!))
    const voidParam = makeNode('parameter_declaration', spanOf(ts.peek()!))
    const voidSpec = makeNode('declaration_specifiers', spanOf(ts.peek()!))
    voidParam.children.push(voidSpec)
    ts.takeInto(voidSpec) // 'void'
    ptl.children.push(voidParam)
    node.children.push(ptl)
    ts.takeInto(node) // ')'
    return node
  }

  // Detect K&R identifier list: every comma-separated item is a single
  // ID with no specifier. Lookahead-only — falls back to ANSI parsing
  // if the head doesn't match.
  if (looksLikeKRIdentifierList(ts)) {
    const list = makeNode('identifier_list', spanOf(ts.peek()!))
    while (!ts.done() && ts.peekName() !== 'PUNC_RPAREN') {
      ts.takeInto(list)
    }
    node.children.push(list)
    if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(node)
    return node
  }

  // ANSI parameter type list.
  const ptl = makeNode('parameter_type_list', spanOf(ts.peek()!))
  while (!ts.done() && ts.peekName() !== 'PUNC_RPAREN') {
    if (ts.peekName() === 'PUNC_ELLIPSIS') {
      const ell = makeNode('parameter_variadic', spanOf(ts.peek()!))
      ts.takeInto(ell)
      ptl.children.push(ell)
      ptl.variadic = true
      break
    }
    const p = parseParameterDeclaration(ts)
    if (p) ptl.children.push(p)
    else {
      // Defensive: avoid infinite loop on tokens we don't recognise.
      ts.takeInto(ptl)
    }
    if (ts.peekName() === 'PUNC_COMMA') ts.takeInto(ptl)
  }
  node.children.push(ptl)
  if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(node)
  return node
}

function looksLikeKRIdentifierList(ts: TokenStream): boolean {
  // The current position is the first token after `(`. K&R: every
  // comma-separated item is exactly one ID and the closing ')' follows
  // the last ID.
  let i = 0
  let expectId = true
  while (true) {
    const t = ts.peek(i)
    if (!t) return false
    const n = t.name
    if (expectId) {
      if (!isIdLike(n)) return false
      expectId = false
    } else {
      if (n === 'PUNC_RPAREN') return i > 0
      if (n === 'PUNC_COMMA') { expectId = true } else { return false }
    }
    i++
    if (i > 256) return false // safety
  }
}

// parameter_declaration:
//   declaration_specifiers (declarator | abstract_declarator)?
export function parseParameterDeclaration(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('parameter_declaration', spanOf(startTkn))
  const specs = parseDeclarationSpecifiers(ts)
  if (specs) node.children.push(specs)

  // Optional declarator. Decide concrete vs abstract: if the next
  // non-trivia token is `,` or `)` (no declarator at all) we still emit
  // an empty parameter (just the specs). Otherwise try a concrete
  // declarator first, fall back to abstract.
  const next = ts.peekName()
  if (next === 'PUNC_COMMA' || next === 'PUNC_RPAREN' || next === null) {
    return node.children.length > 0 ? node : null
  }

  const m = ts.mark()
  let d = parseDeclarator(ts, false)
  if (!d || (!d.declaredName && !findKind(d, 'declaredName'))) {
    // No identifier — fall back to abstract declarator.
    ts.restore(m)
    d = parseDeclarator(ts, true)
  }
  if (d) {
    node.children.push(d)
    if (d.declaredName) node.declaredName = d.declaredName
  }
  return node.children.length > 0 ? node : null
}

// Tiny helper used above to detect whether a (possibly-abstract)
// declarator has any concrete name in it. Searches recursively.
function findKind(node: any, key: string): any {
  if (!node) return null
  if (node[key] !== undefined) return node
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const hit = findKind(c, key)
      if (hit) return hit
    }
  }
  return null
}

// ---- init-declarator-list -------------------------------------------

export function parseInitDeclaratorList(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('init_declarator_list', spanOf(startTkn))

  const first = parseInitDeclarator(ts)
  if (!first) return null
  node.children.push(first)

  while (ts.peekName() === 'PUNC_COMMA') {
    ts.takeInto(node) // ','
    const next = parseInitDeclarator(ts)
    if (!next) break
    node.children.push(next)
  }
  return node
}

export function parseInitDeclarator(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const decl = parseDeclarator(ts, false)
  if (!decl) return null
  // Optional asm-label and attribute-specifiers between declarator and `=`.
  const node = makeNode('init_declarator', spanOf(startTkn))
  node.children.push(decl)
  if (decl.declaredName) node.declaredName = decl.declaredName

  while (true) {
    const n = ts.peekName()
    if (!n) break
    if (n === 'KW___ASM__' || n === 'KW___ASM' || n === 'KW_ASM') {
      const asmNode = makeNode('asm_label', spanOf(ts.peek()!))
      ts.takeInto(asmNode)
      if (ts.peekName() === 'PUNC_LPAREN') {
        consumeBalanced(ts, asmNode, 'PUNC_LPAREN', 'PUNC_RPAREN')
      }
      node.children.push(asmNode)
      continue
    }
    if (ATTRIBUTE_OPENERS.has(n)) {
      const a = parseAttributeSpec(ts)
      if (a) node.children.push(a); else break
      continue
    }
    break
  }

  if (ts.peekName() === 'PUNC_ASSIGN') {
    ts.takeInto(node) // '='
    const init = parseInitializer(ts)
    if (init) node.children.push(init)
  }
  return node
}

// Promote `ID(args)` and `MACRO_NAME(args)` patterns inside `node`'s
// flat children list into nested call_expression nodes. Recurses into
// any non-token children. The grammatical context is "anywhere an
// expression can appear" — call sites have the same shape regardless
// of the surrounding statement form.
//
// Sets isMacro: true on calls whose callee token was MACRO_NAME.
function structureCallsInPlace(node: CNode): void {
  if (!Array.isArray(node.children)) return
  const ch = node.children
  const out: Array<CNode | CTokenRef> = []
  let i = 0
  while (i < ch.length) {
    const c = ch[i] as any
    // Recurse into existing nested nodes first.
    if (c.kind !== 'token') {
      structureCallsInPlace(c)
      out.push(c)
      i++
      continue
    }
    // Identifier-ish callee token followed by '(' (skipping trivia)?
    if ((c.tname === 'ID' || c.tname === 'MACRO_NAME')) {
      let j = i + 1
      // skip trivia between callee and '('
      while (j < ch.length && (ch[j] as any).kind === 'token' &&
             PRESERVED_TRIVIA.has((ch[j] as any).tname)) j++
      if (j < ch.length && (ch[j] as any).kind === 'token' &&
          (ch[j] as any).tname === 'PUNC_LPAREN') {
        // Find matching ')' in flat children.
        let depth = 1
        let k = j + 1
        while (k < ch.length && depth > 0) {
          const cl = ch[k] as any
          if (cl.kind === 'token') {
            if (cl.tname === 'PUNC_LPAREN') depth++
            else if (cl.tname === 'PUNC_RPAREN') {
              depth--
              if (depth === 0) break
            }
          }
          k++
        }
        if (depth === 0) {
          const callNode = makeNode('call_expression', c.span)
          callNode.callee = c.src
          callNode.isMacro = c.tname === 'MACRO_NAME'
          // The callee token + any leading trivia after it (between
          // callee and `(`).
          callNode.children.push(c)
          for (let m = i + 1; m < j; m++) callNode.children.push(ch[m])
          // Argument-list node carrying `(` … `)` plus structured
          // sub-call recursion.
          const argList = makeNode('argument_list', (ch[j] as any).span)
          argList.children.push(ch[j]) // '('
          // Slice out the inner tokens, recurse on a synthetic node to
          // structure nested calls, then flatten back.
          const inner: any[] = []
          for (let m = j + 1; m < k; m++) inner.push(ch[m])
          const innerNode: CNode = {
            kind: '__inner__',
            span: argList.span,
            children: inner,
            trivia: { leading: [], trailing: [] },
          }
          structureCallsInPlace(innerNode)
          for (const ic of innerNode.children) argList.children.push(ic)
          argList.children.push(ch[k]) // ')'
          callNode.children.push(argList)
          out.push(callNode)
          i = k + 1
          continue
        }
      }
    }
    out.push(c)
    i++
  }
  node.children = out
}

// Initializer: assignment-expression OR brace-enclosed initializer-list.
export function parseInitializer(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('initializer', spanOf(startTkn))
  if (ts.peekName() === 'PUNC_LBRACE') {
    const il = parseInitializerList(ts)
    if (il) node.children.push(il)
    return node
  }
  // Plain expression initializer — assignment-precedence (no top-level
  // comma).
  const expr = parseExpression(
    ts, new Set(['PUNC_COMMA', 'PUNC_SEMI', 'PUNC_RBRACE']),
  )
  if (expr) node.children.push(expr)
  return node
}

// initializer-list:
//   '{' (designation? initializer (',' designation? initializer)* ','?)? '}'
//
// Each item becomes an initializer_item node. designation is captured
// as a leading designator_list child when present.
export function parseInitializerList(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn || startTkn.name !== 'PUNC_LBRACE') return null
  const node = makeNode('initializer_list', spanOf(startTkn))
  ts.takeInto(node) // '{'
  while (!ts.done() && ts.peekName() !== 'PUNC_RBRACE') {
    const item = parseInitializerItem(ts)
    if (item) node.children.push(item)
    else ts.takeInto(node) // defensive — preserve unrecognised tokens
    if (ts.peekName() === 'PUNC_COMMA') ts.takeInto(node)
  }
  if (ts.peekName() === 'PUNC_RBRACE') ts.takeInto(node)
  return node
}

function parseInitializerItem(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('initializer_item', spanOf(startTkn))

  // Designation — one or more `. ID` / `[ const-expr ]` followed by `=`.
  if (ts.peekName() === 'PUNC_DOT' || ts.peekName() === 'PUNC_LBRACKET') {
    const desig = parseDesignation(ts)
    if (desig) {
      node.children.push(desig)
      node.designation = desig
    }
  }

  // The value: a nested initializer-list or an assignment-expression.
  if (ts.peekName() === 'PUNC_LBRACE') {
    const sub = parseInitializerList(ts)
    if (sub) {
      const init = makeNode('initializer', sub.span)
      init.children.push(sub)
      node.children.push(init)
      node.value = init
    }
  } else {
    const expr = parseExpression(
      ts, new Set(['PUNC_COMMA', 'PUNC_RBRACE']),
    )
    if (expr) {
      node.children.push(expr)
      node.value = expr
    }
  }
  return node.children.length > 0 ? node : null
}

// _Static_assert ( const-expression [, string-literal] ) ;
//
// Splits the parenthesised arguments into a condition expression and
// an optional message. The condition uses the Pratt parser (so binary
// operators show up structured) and the message is the trailing
// string literal preserved verbatim.
export function parseStaticAssertDeclaration(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('static_assert_declaration', spanOf(startTkn))
  ts.takeInto(node) // 'static_assert' / '_Static_assert'
  if (ts.peekName() !== 'PUNC_LPAREN') {
    if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
    return node
  }
  ts.takeInto(node) // '('
  // Condition: an assignment-expression up to ',' or ')'.
  const cond = parseExpression(
    ts, new Set(['PUNC_COMMA', 'PUNC_RPAREN']),
  )
  if (cond) {
    node.children.push(cond)
    node.condition = cond
  }
  if (ts.peekName() === 'PUNC_COMMA') {
    ts.takeInto(node) // ','
    const msg = parseExpression(ts, new Set(['PUNC_RPAREN']))
    if (msg) {
      node.children.push(msg)
      node.message = msg
    }
  }
  if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(node)
  if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
  return node
}

function parseDesignation(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('designation', spanOf(startTkn))
  let any = false
  while (true) {
    const n = ts.peekName()
    if (n === 'PUNC_DOT') {
      const d = makeNode('member_designator', spanOf(ts.peek()!))
      ts.takeInto(d) // '.'
      const memTkn = ts.peek()
      if (memTkn && (memTkn.name === 'ID' || memTkn.name === 'TYPEDEF_NAME' ||
                     memTkn.name === 'MACRO_NAME')) {
        const taken = ts.take()!
        for (const tr of taken.trivia) d.children.push(tr)
        d.children.push(taken.ref)
        d.memberName = taken.tkn.src
      }
      node.children.push(d)
      any = true
      continue
    }
    if (n === 'PUNC_LBRACKET') {
      const d = makeNode('index_designator', spanOf(ts.peek()!))
      consumeBalanced(ts, d, 'PUNC_LBRACKET', 'PUNC_RBRACKET')
      node.children.push(d)
      any = true
      continue
    }
    break
  }
  if (!any) return null
  if (ts.peekName() === 'PUNC_ASSIGN') ts.takeInto(node)
  return node
}

// ---- compound statement & statements --------------------------------

// '{' (declaration | statement)* '}'
export function parseCompoundStatement(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn || startTkn.name !== 'PUNC_LBRACE') return null
  const node = makeNode('compound_statement', spanOf(startTkn))
  ts.takeInto(node) // '{'
  while (!ts.done() && ts.peekName() !== 'PUNC_RBRACE') {
    const item = parseBlockItem(ts)
    if (item) {
      node.children.push(item)
    } else {
      // Defensive: avoid infinite loop on unrecognised tokens.
      ts.takeInto(node)
    }
  }
  if (ts.peekName() === 'PUNC_RBRACE') ts.takeInto(node) // '}'
  return node
}

// Either a declaration or a statement.
export function parseBlockItem(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null

  // Preprocessor lines aren't structured at this level — fall through
  // to a raw_token to preserve them as opaque siblings.
  if (startTkn.name === 'PP_HASH') {
    return takePreprocessorLine(ts)
  }

  // Declaration if the head is a specifier, attribute, or the C23
  // `static_assert` keyword (or its underscore form), or a C23 `[[`
  // attribute spec.
  const n0 = startTkn.name
  if (isSpecifierStart(n0) ||
      n0 === 'KW_STATIC_ASSERT' || n0 === 'KW__STATIC_ASSERT' ||
      isC23AttributeOpen(ts)) {
    const decl = parseDeclaration(ts)
    if (decl) return decl
  }

  return parseStatement(ts)
}

// Re-usable inner-declaration parser: declaration_specifiers
// init_declarator_list? `;`. Returns a `declaration` node, mirroring
// the shape produced for top-level declarations by structureExternal-
// Declaration.
export function parseDeclaration(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null

  // static_assert is its own declaration shape.
  if (startTkn.name === 'KW_STATIC_ASSERT' ||
      startTkn.name === 'KW__STATIC_ASSERT') {
    return parseStaticAssertDeclaration(ts)
  }

  const node = makeNode('declaration', spanOf(startTkn))
  const specs = parseDeclarationSpecifiers(ts)
  if (specs) node.children.push(specs)
  if (ts.peekName() !== 'PUNC_SEMI' && !ts.done()) {
    const idl = parseInitDeclaratorList(ts)
    if (idl) node.children.push(idl)
  }
  if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
  return node.children.length > 0 ? node : null
}

// Top-level statement dispatch.
export function parseStatement(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const n0 = startTkn.name

  if (n0 === 'PUNC_LBRACE') return parseCompoundStatement(ts)
  if (n0 === 'PUNC_SEMI') {
    const e = makeNode('expression_statement', spanOf(startTkn))
    ts.takeInto(e)
    return e
  }

  if (n0 === 'KW_IF') return parseIfStatement(ts)
  if (n0 === 'KW_SWITCH') return parseSwitchStatement(ts)
  if (n0 === 'KW_WHILE') return parseWhileStatement(ts)
  if (n0 === 'KW_DO') return parseDoStatement(ts)
  if (n0 === 'KW_FOR') return parseForStatement(ts)

  if (n0 === 'KW_GOTO' || n0 === 'KW_CONTINUE' ||
      n0 === 'KW_BREAK' || n0 === 'KW_RETURN') {
    return parseJumpStatement(ts)
  }

  if (n0 === 'KW_CASE' || n0 === 'KW_DEFAULT') {
    return parseLabeledStatement(ts)
  }

  // ID ':' starts a labeled statement; otherwise it's an expression
  // statement.
  if (isIdLike(n0) && ts.peekName(1) === 'PUNC_COLON') {
    return parseLabeledStatement(ts)
  }

  // GCC: `__asm__ (…);` as a statement.
  if (n0 === 'KW___ASM__' || n0 === 'KW___ASM' || n0 === 'KW_ASM') {
    return parseAsmStatement(ts)
  }

  return parseExpressionStatement(ts)
}

function parseIfStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('if_statement', spanOf(startTkn))
  ts.takeInto(node) // 'if'
  if (ts.peekName() === 'PUNC_LPAREN') {
    const cond = makeNode('paren_condition', spanOf(ts.peek()!))
    consumeBalanced(ts, cond, 'PUNC_LPAREN', 'PUNC_RPAREN')
    node.children.push(cond)
  }
  const thenStmt = parseStatement(ts)
  if (thenStmt) node.children.push(thenStmt)
  if (ts.peekName() === 'KW_ELSE') {
    ts.takeInto(node) // 'else'
    const elseStmt = parseStatement(ts)
    if (elseStmt) node.children.push(elseStmt)
  }
  return node
}

function parseSwitchStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('switch_statement', spanOf(startTkn))
  ts.takeInto(node) // 'switch'
  if (ts.peekName() === 'PUNC_LPAREN') {
    const cond = makeNode('paren_condition', spanOf(ts.peek()!))
    consumeBalanced(ts, cond, 'PUNC_LPAREN', 'PUNC_RPAREN')
    node.children.push(cond)
  }
  const body = parseStatement(ts)
  if (body) node.children.push(body)
  return node
}

function parseWhileStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('while_statement', spanOf(startTkn))
  ts.takeInto(node) // 'while'
  if (ts.peekName() === 'PUNC_LPAREN') {
    const cond = makeNode('paren_condition', spanOf(ts.peek()!))
    consumeBalanced(ts, cond, 'PUNC_LPAREN', 'PUNC_RPAREN')
    node.children.push(cond)
  }
  const body = parseStatement(ts)
  if (body) node.children.push(body)
  return node
}

function parseDoStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('do_statement', spanOf(startTkn))
  ts.takeInto(node) // 'do'
  const body = parseStatement(ts)
  if (body) node.children.push(body)
  if (ts.peekName() === 'KW_WHILE') ts.takeInto(node)
  if (ts.peekName() === 'PUNC_LPAREN') {
    const cond = makeNode('paren_condition', spanOf(ts.peek()!))
    consumeBalanced(ts, cond, 'PUNC_LPAREN', 'PUNC_RPAREN')
    node.children.push(cond)
  }
  if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
  return node
}

function parseForStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('for_statement', spanOf(startTkn))
  ts.takeInto(node) // 'for'
  if (ts.peekName() === 'PUNC_LPAREN') {
    const ctl = makeNode('for_controls', spanOf(ts.peek()!))
    ts.takeInto(ctl) // '('

    // init: declaration | expression | empty
    const initNode = makeNode('for_init', spanOf(ts.peek() || startTkn))
    if (ts.peekName() !== 'PUNC_SEMI' && !ts.done()) {
      const t0 = ts.peek()!
      if (isSpecifierStart(t0.name) ||
          t0.name === 'KW_STATIC_ASSERT' || t0.name === 'KW__STATIC_ASSERT' ||
          isC23AttributeOpen(ts)) {
        const decl = parseDeclaration(ts)
        if (decl) {
          initNode.children.push(decl)
          initNode.value = decl
        }
        // The declaration's terminating ';' is part of the declaration
        // node, so we don't expect to see another `;` here.
      } else {
        const expr = parseExpression(ts, new Set(['PUNC_SEMI']))
        if (expr) {
          initNode.children.push(expr)
          initNode.value = expr
        }
        if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(initNode)
      }
    } else if (ts.peekName() === 'PUNC_SEMI') {
      ts.takeInto(initNode) // empty init: just `;`
    }
    ctl.children.push(initNode)
    ctl.init = initNode

    // cond: expression?
    const condNode = makeNode('for_cond', spanOf(ts.peek() || startTkn))
    if (ts.peekName() !== 'PUNC_SEMI' && ts.peekName() !== 'PUNC_RPAREN') {
      const expr = parseExpression(ts, new Set(['PUNC_SEMI', 'PUNC_RPAREN']))
      if (expr) {
        condNode.children.push(expr)
        condNode.value = expr
      }
    }
    if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(condNode)
    ctl.children.push(condNode)
    ctl.cond = condNode

    // iter: expression?
    const iterNode = makeNode('for_iter', spanOf(ts.peek() || startTkn))
    if (ts.peekName() !== 'PUNC_RPAREN') {
      const expr = parseExpression(ts, new Set(['PUNC_RPAREN']))
      if (expr) {
        iterNode.children.push(expr)
        iterNode.value = expr
      }
    }
    ctl.children.push(iterNode)
    ctl.iter = iterNode

    if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(ctl)
    node.children.push(ctl)
  }
  const body = parseStatement(ts)
  if (body) node.children.push(body)
  return node
}

function parseJumpStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('jump_statement', spanOf(startTkn))
  node.jumpKind = startTkn.src
  ts.takeInto(node) // jump keyword
  // For `return <expr>;` and `goto <label>;`, parse the rest as an
  // expression. Plain `break;` / `continue;` and bare `return;` will
  // produce an empty expression and pass through.
  if (ts.peekName() !== 'PUNC_SEMI' && !ts.done()) {
    const expr = parseExpression(ts, new Set(['PUNC_SEMI']))
    if (expr) node.children.push(expr)
  }
  if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
  return node
}

function parseLabeledStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('labeled_statement', spanOf(startTkn))
  if (startTkn.name === 'KW_CASE') {
    node.labelKind = 'case'
    ts.takeInto(node) // 'case'
    // const-expr until top-level `:`
    let parenD = 0
    while (!ts.done()) {
      const n = ts.peekName()
      if (n === 'PUNC_LPAREN') { parenD++; ts.takeInto(node); continue }
      if (n === 'PUNC_RPAREN') {
        if (parenD === 0) break
        parenD--; ts.takeInto(node); continue
      }
      if (parenD === 0 && n === 'PUNC_COLON') break
      ts.takeInto(node)
    }
  } else if (startTkn.name === 'KW_DEFAULT') {
    node.labelKind = 'default'
    ts.takeInto(node) // 'default'
  } else {
    // ID ':'
    node.labelKind = 'label'
    node.labelName = startTkn.src
    ts.takeInto(node) // ID
  }
  if (ts.peekName() === 'PUNC_COLON') ts.takeInto(node)
  // The labeled body is a statement.
  const inner = parseStatement(ts)
  if (inner) node.children.push(inner)
  return node
}

function parseExpressionStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('expression_statement', spanOf(startTkn))
  // Use the Pratt parser to structure the expression up to `;`.
  const expr = parseExpression(ts, new Set(['PUNC_SEMI']))
  if (expr) node.children.push(expr)
  if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
  return node
}

// GCC inline assembly statement:
//
//   asm-keyword qualifier* ( template
//                            : output-operand-list
//                            : input-operand-list
//                            : clobber-list
//                            : label-list )
//
// Trailing colons are optional; a missing operand list between two
// colons is allowed. Operands carry an optional [asm-name], a
// constraint string, and a parenthesised expression. Clobbers are
// strings; labels are identifiers.
function parseAsmStatement(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('asm_statement', spanOf(startTkn))
  node.qualifiers = [] as string[]
  ts.takeInto(node) // asm keyword
  // Optional volatile/inline/goto qualifiers.
  while (true) {
    const n = ts.peekName()
    if (n === 'KW_VOLATILE' || n === 'KW___VOLATILE__' || n === 'KW___VOLATILE' ||
        n === 'KW_INLINE' || n === 'KW___INLINE__' || n === 'KW___INLINE' ||
        n === 'KW_GOTO') {
      const t = ts.peek()!
      node.qualifiers.push(t.src)
      ts.takeInto(node)
      continue
    }
    break
  }
  if (ts.peekName() !== 'PUNC_LPAREN') {
    if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
    return node
  }
  ts.takeInto(node) // '('

  // Section sequence: template, then up to 4 colon-separated operand
  // sections.
  const template = makeNode('asm_template', spanOf(ts.peek() || startTkn))
  // Template is a string-literal expression (possibly multi-string,
  // e.g. "movl %0, %1\n\t" "addl %2, %0").
  const t = parseExpression(ts, new Set(['PUNC_COLON', 'PUNC_RPAREN']))
  if (t) {
    template.children.push(t)
    template.expression = t
  }
  node.children.push(template)
  node.template = template

  const sections = [
    'asm_outputs', 'asm_inputs', 'asm_clobbers', 'asm_labels',
  ] as const
  let sectionIdx = 0
  while (ts.peekName() === 'PUNC_COLON' && sectionIdx < sections.length) {
    ts.takeInto(node) // ':'
    const sec = makeNode(sections[sectionIdx], spanOf(ts.peek() || startTkn))
    while (!ts.done() && ts.peekName() !== 'PUNC_COLON' &&
           ts.peekName() !== 'PUNC_RPAREN') {
      const item = sectionIdx <= 1
        ? parseAsmOperand(ts)
        : sectionIdx === 2
          ? parseAsmClobber(ts)
          : parseAsmLabel(ts)
      if (item) sec.children.push(item)
      else ts.takeInto(sec)
      if (ts.peekName() === 'PUNC_COMMA') ts.takeInto(sec)
    }
    node.children.push(sec)
    ;(node as any)[sections[sectionIdx]] = sec
    sectionIdx++
  }

  if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(node)
  if (ts.peekName() === 'PUNC_SEMI') ts.takeInto(node)
  return node
}

// asm operand: [asm-name] string-constraint ( c-expression )
function parseAsmOperand(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  const node = makeNode('asm_operand', spanOf(startTkn))

  // Optional [asm-name].
  if (startTkn.name === 'PUNC_LBRACKET') {
    const nameNode = makeNode('asm_name', spanOf(startTkn))
    consumeBalanced(ts, nameNode, 'PUNC_LBRACKET', 'PUNC_RBRACKET')
    node.children.push(nameNode)
    node.asmName = nameNode
  }

  // Constraint string.
  if (ts.peekName() === 'LIT_STRING') {
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    const constraint = makeNode('asm_constraint', taken.tkn ? spanOf(taken.tkn) : node.span)
    constraint.children.push(taken.ref)
    constraint.value = taken.tkn.src
    node.children.push(constraint)
    node.constraint = constraint
  }

  // ( c-expression )
  if (ts.peekName() === 'PUNC_LPAREN') {
    const expr = makeNode('asm_value', spanOf(ts.peek()!))
    ts.takeInto(expr) // '('
    const inner = parseExpression(ts, new Set(['PUNC_RPAREN']))
    if (inner) {
      expr.children.push(inner)
      expr.expression = inner
    }
    if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(expr)
    node.children.push(expr)
    node.value = expr
  }

  return node.children.length > 0 ? node : null
}

// asm clobber: a single string literal.
function parseAsmClobber(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn || startTkn.name !== 'LIT_STRING') return null
  const node = makeNode('asm_clobber', spanOf(startTkn))
  const taken = ts.take()!
  for (const tr of taken.trivia) node.children.push(tr)
  node.children.push(taken.ref)
  node.value = taken.tkn.src
  return node
}

// asm label: identifier (or label name).
function parseAsmLabel(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn) return null
  if (!isIdLike(startTkn.name) && startTkn.name !== 'TYPEDEF_NAME') return null
  const node = makeNode('asm_label_ref', spanOf(startTkn))
  const taken = ts.take()!
  for (const tr of taken.trivia) node.children.push(tr)
  node.children.push(taken.ref)
  node.labelName = taken.tkn.src
  return node
}

function takePreprocessorLine(ts: TokenStream): CNode {
  return parseDirective(ts) || (() => {
    // Defensive fallback — shouldn't be reached.
    const startTkn = ts.peek()!
    const node = makeNode('preprocessor_line', spanOf(startTkn))
    while (!ts.done()) {
      const n = ts.peekName()
      if (n === 'PP_NEWLINE') { ts.takeInto(node); break }
      ts.takeInto(node)
    }
    return node
  })()
}

// ---- Preprocessor directives ---------------------------------------

// Discover the directive name (the first non-trivia token after the
// opening PP_HASH). Returns the lowercase src ('define', 'include',
// 'if', 'ifdef', 'ifndef', 'elif', 'else', 'endif', 'pragma', 'error',
// 'warning', 'line', 'undef', 'embed', 'include_next') or null.
function directiveName(ts: TokenStream, hashOff: number = 0): string | null {
  const t = ts.peek(hashOff + 1)
  if (!t) return null
  return t.src
}

export function parseDirective(ts: TokenStream): CNode | null {
  const startTkn = ts.peek()
  if (!startTkn || startTkn.name !== 'PP_HASH') return null
  const dn = directiveName(ts) || ''
  switch (dn) {
    case 'define':       return parseDefineDirective(ts)
    case 'undef':        return parseUndefDirective(ts)
    case 'include':
    case 'include_next':
    case 'embed':        return parseIncludeDirective(ts, dn)
    case 'if':
    case 'ifdef':
    case 'ifndef':
    case 'elif':
    case 'elifdef':
    case 'elifndef':
    case 'else':
    case 'endif':        return parseConditionalDirective(ts, dn)
    case 'pragma':       return parseSimpleDirective(ts, 'pragma_directive')
    case 'error':        return parseSimpleDirective(ts, 'error_directive')
    case 'warning':      return parseSimpleDirective(ts, 'warning_directive')
    case 'line':         return parseSimpleDirective(ts, 'line_directive')
    default:             return parseSimpleDirective(ts, 'unknown_directive')
  }
}

function parseSimpleDirective(ts: TokenStream, kind: string): CNode {
  const startTkn = ts.peek()!
  const node = makeNode(kind, spanOf(startTkn))
  ts.takeInto(node) // PP_HASH
  while (!ts.done()) {
    const n = ts.peekName()
    if (n === 'PP_NEWLINE') { ts.takeInto(node); break }
    ts.takeInto(node)
  }
  return node
}

// `#define ID` or `#define ID(params) body`. Function-like form requires
// no space between ID and `(`; we approximate this by checking that the
// `(` token immediately follows the macro-name token in the source.
export function parseDefineDirective(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('define_directive', spanOf(startTkn))
  ts.takeInto(node) // PP_HASH
  // 'define' keyword token.
  ts.takeInto(node)

  // Macro name.
  const nameTkn = ts.peek()
  if (nameTkn && (isIdLike(nameTkn.name) || nameTkn.name === 'TYPEDEF_NAME' ||
                  nameTkn.name === 'MACRO_NAME')) {
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    node.macroName = taken.tkn.src

    // Function-like? Check positional adjacency in source: `(` directly
    // after the name (no whitespace). The matcher emits `#SP` for any
    // gap which would have been buffered as trivia BEFORE the `(` if
    // present — but we drop whitespace, so check token spans.
    const lookahead = ts.peek()
    if (lookahead && lookahead.name === 'PUNC_LPAREN' &&
        lookahead.sI === taken.tkn.sI + taken.tkn.len) {
      node.macroKind = 'function-like'
      const params = makeNode('macro_parameter_list', spanOf(lookahead))
      ts.takeInto(params) // '('
      node.macroParams = []
      while (!ts.done() && ts.peekName() !== 'PUNC_RPAREN') {
        const t = ts.peek()!
        if (t.name === 'PUNC_ELLIPSIS') {
          node.macroVariadic = true
          ts.takeInto(params)
        } else if (t.name === 'PUNC_COMMA') {
          ts.takeInto(params)
        } else if (isIdLike(t.name) || t.name === 'TYPEDEF_NAME') {
          ts.takeInto(params)
          node.macroParams.push(t.src)
        } else {
          ts.takeInto(params) // tolerant
        }
      }
      if (ts.peekName() === 'PUNC_RPAREN') ts.takeInto(params)
      node.children.push(params)
    } else {
      node.macroKind = 'object-like'
    }
  } else {
    node.macroKind = 'object-like'
  }

  // Body: every remaining token until PP_NEWLINE.
  const body = makeNode('macro_body', spanOf(ts.peek() || startTkn))
  while (!ts.done()) {
    const n = ts.peekName()
    if (n === 'PP_NEWLINE') break
    ts.takeInto(body)
  }
  node.children.push(body)
  if (ts.peekName() === 'PP_NEWLINE') ts.takeInto(node)
  return node
}

export function parseUndefDirective(ts: TokenStream): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('undef_directive', spanOf(startTkn))
  ts.takeInto(node) // PP_HASH
  ts.takeInto(node) // 'undef'
  const nameTkn = ts.peek()
  if (nameTkn && (isIdLike(nameTkn.name) || nameTkn.name === 'TYPEDEF_NAME' ||
                  nameTkn.name === 'MACRO_NAME')) {
    const taken = ts.take()!
    for (const tr of taken.trivia) node.children.push(tr)
    node.children.push(taken.ref)
    node.macroName = taken.tkn.src
  }
  while (!ts.done()) {
    const n = ts.peekName()
    if (n === 'PP_NEWLINE') { ts.takeInto(node); break }
    ts.takeInto(node)
  }
  return node
}

export function parseIncludeDirective(ts: TokenStream, name: string): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('include_directive', spanOf(startTkn))
  node.includeForm = name // 'include' | 'include_next' | 'embed'
  ts.takeInto(node) // PP_HASH
  ts.takeInto(node) // include keyword

  const next = ts.peek()
  if (next) {
    if (next.name === 'LIT_HEADER_NAME') {
      const taken = ts.take()!
      for (const tr of taken.trivia) node.children.push(tr)
      node.children.push(taken.ref)
      node.headerName = taken.tkn.src
      node.headerKind = taken.tkn.src.startsWith('<') ? 'angled' : 'quoted'
    } else {
      // Macro-form include: capture remaining tokens as a header_form node.
      const hf = makeNode('header_form', spanOf(next))
      while (!ts.done()) {
        const n = ts.peekName()
        if (n === 'PP_NEWLINE') break
        ts.takeInto(hf)
      }
      node.children.push(hf)
    }
  }

  if (ts.peekName() === 'PP_NEWLINE') ts.takeInto(node)
  return node
}

export function parseConditionalDirective(ts: TokenStream, name: string): CNode {
  const startTkn = ts.peek()!
  const node = makeNode('conditional_directive', spanOf(startTkn))
  node.directive = name // 'if' | 'ifdef' | 'ifndef' | 'elif' | ...
  ts.takeInto(node) // PP_HASH
  ts.takeInto(node) // directive keyword
  // Condition tokens until PP_NEWLINE (empty for #else / #endif).
  while (!ts.done()) {
    const n = ts.peekName()
    if (n === 'PP_NEWLINE') { ts.takeInto(node); break }
    ts.takeInto(node)
  }
  return node
}

// (Conditional-group folding moved to src/conditional-groups.ts in phase K.)

// ---- top-level dispatch ---------------------------------------------

// Parse a single external_declaration from the token list. Returns the
// structured children to install on the external_declaration node, plus
// the recognised declKind. If parsing fails (unrecognised structure),
// returns null and the caller should retain the flat token-ref children.
export function structureExternalDeclaration(tokens: Token[]): {
  declKind: 'declaration' | 'function_definition' | 'declaration_list' | 'unknown'
  children: Array<CNode | CTokenRef>
} | null {
  // Filter out the trailing/preceding non-token entries; we only consume
  // jsonic Tokens here.
  const ts = new TokenStream(tokens)
  if (ts.done()) return null

  // Top-level static_assert.
  const head = ts.peekName()
  if (head === 'KW_STATIC_ASSERT' || head === 'KW__STATIC_ASSERT') {
    const sa = parseStaticAssertDeclaration(ts)
    return { declKind: 'declaration', children: [sa] }
  }

  // Preprocessor lines: structure as a directive node and treat the
  // whole external_declaration as that one directive.
  if (ts.peekName() === 'PP_HASH') {
    const dir = parseDirective(ts)
    if (dir) {
      // Drain any trailing tokens (shouldn't be any normally).
      const out: Array<CNode | CTokenRef> = [dir]
      while (!ts.done()) {
        const taken = ts.take()
        if (!taken) break
        for (const tr of taken.trivia) out.push(tr)
        out.push(taken.ref)
      }
      return { declKind: 'declaration', children: out }
    }
    return null
  }

  // Specifiers (optional). C23 [[ … ]] at the head is folded into the
  // declaration_specifiers list by parseDeclarationSpecifiers.
  const specs = parseDeclarationSpecifiers(ts)

  // If no specifiers AND no declarator follows (e.g. just `;`), bail.
  if (!specs && !isIdLike(ts.peekName()) && ts.peekName() !== 'PUNC_STAR' &&
      ts.peekName() !== 'PUNC_LPAREN') {
    return null
  }

  // The init-declarator-list is optional (e.g. `struct S;` has none).
  const declaratorsStart = ts.mark()
  const decls = parseInitDeclaratorList(ts)

  // After declarator list, expect either `;` (declaration) or `{` (function
  // definition with body), or a comma-separated init-decl-list already
  // consumed and the trailing punctuation.
  const tail = ts.peekName()

  const out: Array<CNode | CTokenRef> = []
  if (specs) out.push(specs)

  if (tail === 'PUNC_SEMI') {
    if (decls) out.push(decls)
    // Consume the ';' and any trailing tokens (shouldn't be any, but if
    // there are, append them as raw refs to preserve fidelity).
    while (!ts.done()) {
      const taken = ts.take()
      if (!taken) break
      for (const tr of taken.trivia) out.push(tr)
      out.push(taken.ref)
    }
    return { declKind: 'declaration', children: out }
  }

  if (tail === 'PUNC_LBRACE') {
    // Function definition. The init-declarator-list parse may have
    // produced one declarator with no initializer — that's the
    // function's declarator.
    if (decls) {
      // Promote the single init_declarator to a plain declarator if it
      // has no initializer (idiomatic for function definitions).
      const single = decls.children.length === 1 ? decls.children[0] as CNode : null
      if (single && single.kind === 'init_declarator' &&
          single.children.length === 1 &&
          (single.children[0] as CNode).kind === 'declarator') {
        out.push(single.children[0] as CNode)
      } else {
        out.push(decls)
      }
    }
    const body = parseCompoundStatement(ts)
    if (body) out.push(body)
    // Append any unexpected trailing content.
    while (!ts.done()) {
      const taken = ts.take()
      if (!taken) break
      for (const tr of taken.trivia) out.push(tr)
      out.push(taken.ref)
    }
    return { declKind: 'function_definition', children: out }
  }

  // K&R-style function definition: declarator IDs followed by
  // declaration-list before `{`. Detect by finding `{` later.
  if (tail && tail !== 'PUNC_SEMI') {
    // Defensive: if the next tokens before any `{` look like a
    // declaration-list, capture them as a nested declaration_list node
    // and keep going until `{`.
    const krStart = ts.mark()
    let sawBrace = false
    while (!ts.done()) {
      if (ts.peekName() === 'PUNC_LBRACE') { sawBrace = true; break }
      // Just consume one token at a time; we'll structure later.
      const taken = ts.take()
      if (!taken) break
    }
    if (sawBrace) {
      ts.restore(krStart)
      const krList = makeNode('kr_declaration_list', spanOf(ts.peek()!))
      while (!ts.done() && ts.peekName() !== 'PUNC_LBRACE') {
        ts.takeInto(krList)
      }
      if (decls) out.push(decls)
      out.push(krList)
      const body = parseCompoundStatement(ts)
      if (body) out.push(body)
      while (!ts.done()) {
        const taken = ts.take()
        if (!taken) break
        for (const tr of taken.trivia) out.push(tr)
        out.push(taken.ref)
      }
      return { declKind: 'function_definition', children: out }
    }
    ts.restore(krStart)
  }

  // Couldn't structure cleanly — give up.
  // (Caller falls back to the flat token-ref list.)
  return null
}
