/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Conditional-group folding: a translation-unit-level post-pass that
// collapses contiguous runs of `#if`/`#ifdef`/`#ifndef` … `#elif` …
// `#else` … `#endif` directives into a single conditional_group node.
// Best-effort: an unmatched `#endif` or an unterminated `#if` leaves
// the surrounding children unchanged so the rest of the tree stays
// intact.
//
// The walker is structural — it only inspects already-parsed
// conditional_directive nodes embedded as the first child of an
// external_declaration — so it has zero dependency on the token
// stream or the rest of the grammar.

// Output shape uses `children` as the one structural interface. A
// conditional_group contains conditional_branch nodes followed by the
// closing directive; each branch contains its opening directive followed by
// its body. `branchKind` and `endif` remain scalar/leaf conveniences.

interface AnyNode {
  kind?: string
  span?: any
  children?: any[]
  endif?: any
  branchKind?: string
  directive?: any
  [extra: string]: any
}

function makeNode(kind: string, span?: any): AnyNode {
  return {
    kind,
    span: span || { start: 0, end: 0, line: 1, col: 1 },
    children: [],
    trivia: { leading: [], trailing: [] },
  } as AnyNode
}

export function structureConditionalGroups(parent: AnyNode): void {
  if (!Array.isArray(parent.children)) return
  const ch = parent.children
  const out = foldRange(ch, 0, ch.length, indexConditionalGroups(ch))
  parent.children = out
  // Recurse into preserved children (e.g. function bodies).
  for (const c of out) {
    if (c && c.kind && Array.isArray(c.children)) {
      structureConditionalGroups(c)
    }
  }
}

interface ConditionalMatch {
  end: number
  branches: number[]
}

// Index every matched run and its top-level branch markers in one pass. This
// prevents each nested or unmatched opener from scanning the suffix again.
function indexConditionalGroups(children: any[]): Map<number, ConditionalMatch> {
  const matches = new Map<number, ConditionalMatch>()
  const stack: Array<{ open: number; branches: number[] }> = []
  for (let i = 0; i < children.length; i++) {
    const dir = leadingConditionalDirective(children[i])
    if (!dir) continue
    if (/^(if|ifdef|ifndef)$/.test(dir.directive)) {
      stack.push({ open: i, branches: [] })
    } else if (/^(elif|elifdef|elifndef|else)$/.test(dir.directive)) {
      if (stack.length > 0) stack[stack.length - 1].branches.push(i)
    } else if (dir.directive === 'endif' && stack.length > 0) {
      const frame = stack.pop()!
      matches.set(frame.open, { end: i, branches: frame.branches })
    }
  }
  return matches
}

function foldRange(
  children: any[], from: number, to: number,
  matches: Map<number, ConditionalMatch>,
): any[] {
  const out: any[] = []
  let i = from
  while (i < to) {
    const match = matches.get(i)
    if (match && match.end < to) {
      out.push(buildConditionalGroup(children, i, match, matches))
      i = match.end + 1
    } else {
      out.push(children[i])
      i++
    }
  }
  return out
}

// Return the conditional_directive node embedded as the first child of
// an external_declaration, if any.
function leadingConditionalDirective(node: any): any | null {
  if (!node || node.kind !== 'external_declaration') return null
  const first = (node.children || []).find(
    (c: any) => c && c.kind === 'conditional_directive',
  )
  return first || null
}

function buildConditionalGroup(
  children: any[], from: number, match: ConditionalMatch,
  matches: Map<number, ConditionalMatch>,
): AnyNode {
  const startCh = children[from] as AnyNode
  const groupNode = makeNode('conditional_group', startCh.span)
  const starts = [from, ...match.branches]
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : match.end
    groupNode.children!.push(buildBranch(children, starts[i], end, matches))
  }
  groupNode.endif = children[match.end]
  groupNode.children!.push(children[match.end])
  return groupNode
}

function buildBranch(
  children: any[], from: number, to: number,
  matches: Map<number, ConditionalMatch>,
): AnyNode {
  const head = children[from]
  const dir = leadingConditionalDirective(head)
  const branch = makeNode('conditional_branch', head.span)
  branch.branchKind = dir ? dir.directive : 'unknown'
  // The directive stays available by name, but structural traversal uses
  // children exclusively.
  branch.directive = head
  branch.children = [head, ...foldRange(children, from + 1, to, matches)]
  return branch
}
