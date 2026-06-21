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

// Output shape:
//   conditional_group
//     branches: [
//       { kind: 'conditional_branch', branchKind: 'if'|'ifdef'|'ifndef'|
//                                                   'elif'|'elifdef'|
//                                                   'elifndef'|'else',
//         children: [<the directive node>, <body external_declarations>] }
//       ...
//     ]
//     endif: <the conditional_directive node, kept verbatim>

interface AnyNode {
  kind?: string
  span?: any
  children?: any[]
  branches?: any[]
  endif?: any
  branchKind?: string
  directive?: any
  body?: any[]
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
  const out: any[] = []
  let i = 0
  while (i < ch.length) {
    const c = ch[i] as any
    const dir = leadingConditionalDirective(c)
    if (dir && /^(if|ifdef|ifndef)$/.test(dir.directive)) {
      const consumed = tryBuildConditionalGroup(ch, i)
      if (consumed) {
        out.push(consumed.node)
        i = consumed.next
        continue
      }
    }
    out.push(c)
    i++
  }
  parent.children = out
  // Recurse into preserved children (e.g. function bodies).
  for (const c of out) {
    if (c && c.kind && Array.isArray(c.children)) {
      structureConditionalGroups(c)
    }
  }
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

// Attempt to build a conditional_group starting at index `from`. Returns
// the new node and the index after the closing #endif, or null if no
// matching #endif was found at the same nesting level.
function tryBuildConditionalGroup(
  children: any[], from: number,
): { node: AnyNode; next: number } | null {
  // First pass: scan ahead with a depth counter to find the matching
  // #endif. If none, bail.
  let depth = 0
  let endIdx = -1
  for (let i = from; i < children.length; i++) {
    const dir = leadingConditionalDirective(children[i])
    if (!dir) continue
    if (/^(if|ifdef|ifndef)$/.test(dir.directive)) depth++
    else if (dir.directive === 'endif') {
      depth--
      if (depth === 0) { endIdx = i; break }
    }
  }
  if (endIdx < 0) return null

  // Second pass: split [from … endIdx-1] into branches at top-level
  // #elif/#else.
  const startCh = children[from] as AnyNode
  const groupNode = makeNode('conditional_group', startCh.span)
  groupNode.branches = [] as any[]
  let branchStart = from
  let innerDepth = 0
  for (let i = from + 1; i < endIdx; i++) {
    const dir = leadingConditionalDirective(children[i])
    if (!dir) continue
    if (/^(if|ifdef|ifndef)$/.test(dir.directive)) innerDepth++
    else if (dir.directive === 'endif') innerDepth--
    else if (innerDepth === 0 &&
             /^(elif|elifdef|elifndef|else)$/.test(dir.directive)) {
      pushBranch(groupNode, children, branchStart, i)
      branchStart = i
    }
  }
  pushBranch(groupNode, children, branchStart, endIdx)

  // Endif as a separate field (the directive itself, for full fidelity).
  groupNode.endif = children[endIdx]
  // Also append it to children so a depth-first walk still emits the
  // raw tokens in order.
  groupNode.children!.push(...groupNode.branches!)
  groupNode.children!.push(children[endIdx])

  return { node: groupNode, next: endIdx + 1 }
}

function pushBranch(group: AnyNode, children: any[], from: number, to: number): void {
  const head = children[from]
  const dir = leadingConditionalDirective(head)
  const branch = makeNode('conditional_branch', head.span)
  branch.branchKind = dir ? dir.directive : 'unknown'
  // The directive itself is preserved on a side field; the branch's
  // `children` list holds just the body items so consumers can iterate
  // them without filtering.
  branch.directive = head
  // Recurse into body so nested #if … #endif inside a branch also get
  // grouped.
  const inner = makeNode('__branch_body__', head.span)
  for (let k = from + 1; k < to; k++) inner.children!.push(children[k])
  structureConditionalGroups(inner)
  // Final children: the directive followed by the (possibly grouped)
  // body, so a depth-first walk still yields original tokens.
  branch.children = [head, ...inner.children!]
  // Body-only view for consumers.
  branch.body = inner.children!
  group.branches!.push(branch)
}
