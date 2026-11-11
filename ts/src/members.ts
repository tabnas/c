/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// The named members of a node that repeat one of its children.
//
// The tree holds each subtree once, in `children`. Some callers read a
// node by name instead (a cast's operand, a conditional's branches, an
// asm statement's sections), which the tree held as members up to 0.5;
// `member(node, name)` gives them back, from the node's children, by kind
// or by place among its child nodes (its children that are nodes, its
// tokens left out). A member a node does not have is undefined; a list
// member (`associations`, `items`) is an array, empty when there is none.
//
// Go's Member and Rust's member answer the same, and test/spec/members.tsv
// holds all three to it.

import { CNode, isNode, childNodes } from './node.js'

type Pick = (node: CNode) => CNode | CNode[] | undefined

const ofKind = (kind: string): Pick => (node) =>
  childNodes(node).find((c) => c.kind === kind)

const allOfKind = (kind: string): Pick => (node) =>
  childNodes(node).filter((c) => c.kind === kind)

const nth = (i: number): Pick => (node) => childNodes(node)[i]

const last: Pick = (node) => {
  const kids = childNodes(node)
  return kids[kids.length - 1]
}

// The last child node that is not of the given kind.
const lastBut = (kind: string): Pick => (node) => {
  const kids = childNodes(node).filter((c) => c.kind !== kind)
  return kids[kids.length - 1]
}

const MEMBERS: Record<string, Record<string, Pick>> = {
  unary_expression: { operand: last },
  postfix_unary_expression: { target: nth(0) },
  subscript_expression: { target: nth(0) },
  member_expression: { object: nth(0) },
  cast_expression: { typeName: ofKind('type_name'), operand: lastBut('type_name') },
  compound_literal: { typeName: ofKind('type_name') },
  conditional_expression: { cond: nth(0), then: nth(1), else: nth(2) },
  initializer_item: { designation: ofKind('designation'), value: lastBut('designation') },
  for_controls: {
    init: ofKind('for_init'), cond: ofKind('for_cond'), iter: ofKind('for_iter'),
  },
  for_init: { value: nth(0) },
  for_cond: { value: nth(0) },
  for_iter: { value: nth(0) },
  static_assert_declaration: { condition: nth(0), message: nth(1) },
  generic_selection: {
    controlling: ofKind('generic_controlling_expression'),
    associations: allOfKind('generic_association'),
  },
  generic_association: { typeName: ofKind('type_name'), value: lastBut('type_name') },
  generic_controlling_expression: { expression: nth(0) },
  asm_template: { expression: nth(0) },
  asm_value: { expression: nth(0) },
  attribute_spec: { items: allOfKind('attribute_item') },
  attribute_item: { argumentList: ofKind('attribute_argument_list') },
  asm_statement: {
    template: ofKind('asm_template'),
    asm_outputs: ofKind('asm_outputs'),
    asm_inputs: ofKind('asm_inputs'),
    asm_clobbers: ofKind('asm_clobbers'),
    asm_labels: ofKind('asm_labels'),
  },
  asm_operand: {
    asmName: ofKind('asm_name'), constraint: ofKind('asm_constraint'),
    value: ofKind('asm_value'),
  },
  conditional_group: {
    endif: (node) => {
      const l = last(node) as CNode | undefined
      return l && 'conditional_branch' !== l.kind ? l : undefined
    },
  },
  conditional_branch: { directive: nth(0) },
}

// The members a node of `kind` has, by name.
export function memberNames(kind: string): string[] {
  return Object.keys(MEMBERS[kind] || {})
}

// The member `name` of `node`, from its children: a node, an array of
// nodes for a list member, or undefined. Typed `any`, as the tree's own
// members are, so a caller reads it as it read the member.
export function member(node: any, name: string): any {
  if (!isNode(node)) return undefined
  const pick = (MEMBERS[node.kind] || {})[name]
  return pick ? pick(node) : undefined
}
