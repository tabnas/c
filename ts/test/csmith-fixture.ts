/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Fixture-friendly serialization of a C-CST node. Walks `kind`,
// `children`, and a stable whitelist of scalar metadata fields so the
// resulting JSON has no cross-reference duplication (which the parser
// uses internally for ergonomic .left/.right/.target etc accessors).
//
// The same function is used to (a) write fixtures and (b) re-serialize
// a fresh parse for assertion, so tests compare structurally-equivalent
// JSON in both directions.

const SCALAR_KEYS = [
  // common metadata
  'declKind',
  'declaredName',
  'callee',
  'isMacro',
  'op',
  // statements
  'jumpKind',
  'labelKind',
  'labelName',
  'qualifiers',
  // literals + identifiers
  'literalKind',
  'value',
  'name',
  // members + designators
  'memberName',
  // calls / generics
  'associationKind',
  // tags
  'tagName',
  // attributes
  'attributeForm',
  'attributeName',
  'attributePrefix',
  // preprocessor
  'directive',
  'macroName',
  'macroKind',
  'macroParams',
  'macroVariadic',
  'includeForm',
  'headerKind',
  'headerName',
  'branchKind',
] as const

export interface FixtureNode {
  k: string
  children?: FixtureNode[]
  [extra: string]: any
}

// Trivia tokens (comments and line continuations) are dropped from
// fixtures — they're huge in csmith output (a 1KB block comment per
// file) and not structurally meaningful. The source corpus retains
// them for full-fidelity testing where needed.
const TRIVIA_TOKENS = new Set([
  'TRIVIA_LINE_COMMENT', 'TRIVIA_BLOCK_COMMENT', 'TRIVIA_LINE_CONT',
])

export function toFixture(node: any): FixtureNode | null {
  if (!node || typeof node !== 'object') return null
  if (node.kind === 'token') {
    if (TRIVIA_TOKENS.has(node.tname)) return null
    // Tokens carry just `t` (token name) and `s` (source); spans are
    // recoverable from the corpus file by lex re-run.
    return { k: 'tok', t: node.tname, s: node.src }
  }
  const out: FixtureNode = { k: node.kind }
  for (const key of SCALAR_KEYS) {
    if (!(key in node)) continue
    const v = node[key]
    if (v === undefined || v === null) continue
    if (typeof v === 'object' && !Array.isArray(v)) continue
    if (Array.isArray(v) && v.some((x) => typeof x === 'object')) continue
    out[key] = v
  }
  if (Array.isArray(node.children) && node.children.length > 0) {
    const kids = node.children
      .map((c: any) => toFixture(c))
      .filter((x: FixtureNode | null) => x !== null) as FixtureNode[]
    if (kids.length > 0) out.children = kids
  }
  return out
}

export function fixtureJson(node: any): string {
  // Compact single-line per item, plus a trailing newline so git diffs
  // line up.
  return JSON.stringify(toFixture(node)) + '\n'
}
