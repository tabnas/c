/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "sort"

// The named members of a node that repeat one of its children. Port of
// ts/src/members.ts.
//
// The tree holds each subtree once, in `children`. Some callers read a
// node by name instead (a cast's operand, a conditional's branches, an
// asm statement's sections), which the tree held as members up to 0.5;
// Member(node, name) gives them back, from the node's children, by kind or
// by place among its child nodes (its children that are nodes, its tokens
// left out). A member a node does not have is nil; a list member
// (`associations`, `items`) is a []any, empty when there is none.
//
// TypeScript's member and Rust's member answer the same, and
// test/spec/members.tsv holds all three to it.

type memberPick func(node CNode) any

func ofKind(kind string) memberPick {
	return func(node CNode) any {
		for _, c := range childNodes(node) {
			if c["kind"] == kind {
				return c
			}
		}
		return nil
	}
}

func allOfKind(kind string) memberPick {
	return func(node CNode) any {
		out := []any{}
		for _, c := range childNodes(node) {
			if c["kind"] == kind {
				out = append(out, c)
			}
		}
		return out
	}
}

func nth(i int) memberPick {
	return func(node CNode) any {
		kids := childNodes(node)
		if i < len(kids) {
			return kids[i]
		}
		return nil
	}
}

func lastNode(node CNode) any {
	kids := childNodes(node)
	if len(kids) == 0 {
		return nil
	}
	return kids[len(kids)-1]
}

// lastBut is the last child node that is not of the given kind.
func lastBut(kind string) memberPick {
	return func(node CNode) any {
		var out any
		for _, c := range childNodes(node) {
			if c["kind"] != kind {
				out = c
			}
		}
		return out
	}
}

var members = map[string]map[string]memberPick{
	"unary_expression":         {"operand": lastNode},
	"postfix_unary_expression": {"target": nth(0)},
	"subscript_expression":     {"target": nth(0)},
	"member_expression":        {"object": nth(0)},
	"cast_expression":          {"typeName": ofKind("type_name"), "operand": lastBut("type_name")},
	"compound_literal":         {"typeName": ofKind("type_name")},
	"conditional_expression":   {"cond": nth(0), "then": nth(1), "else": nth(2)},
	"initializer_item":         {"designation": ofKind("designation"), "value": lastBut("designation")},
	"for_controls": {
		"init": ofKind("for_init"), "cond": ofKind("for_cond"), "iter": ofKind("for_iter"),
	},
	"for_init":                  {"value": nth(0)},
	"for_cond":                  {"value": nth(0)},
	"for_iter":                  {"value": nth(0)},
	"static_assert_declaration": {"condition": nth(0), "message": nth(1)},
	"generic_selection": {
		"controlling":  ofKind("generic_controlling_expression"),
		"associations": allOfKind("generic_association"),
	},
	"generic_association":            {"typeName": ofKind("type_name"), "value": lastBut("type_name")},
	"generic_controlling_expression": {"expression": nth(0)},
	"asm_template":                   {"expression": nth(0)},
	"asm_value":                      {"expression": nth(0)},
	"attribute_spec":                 {"items": allOfKind("attribute_item")},
	"attribute_item":                 {"argumentList": ofKind("attribute_argument_list")},
	"asm_statement": {
		"template":     ofKind("asm_template"),
		"asm_outputs":  ofKind("asm_outputs"),
		"asm_inputs":   ofKind("asm_inputs"),
		"asm_clobbers": ofKind("asm_clobbers"),
		"asm_labels":   ofKind("asm_labels"),
	},
	"asm_operand": {
		"asmName": ofKind("asm_name"), "constraint": ofKind("asm_constraint"),
		"value": ofKind("asm_value"),
	},
	"conditional_group": {
		"endif": func(node CNode) any {
			l, _ := lastNode(node).(CNode)
			if l != nil && l["kind"] != "conditional_branch" {
				return l
			}
			return nil
		},
	},
	"conditional_branch": {"directive": nth(0)},
}

// MemberNames is the members a node of kind has, by name, sorted.
func MemberNames(kind string) []string {
	out := []string{}
	for name := range members[kind] {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Member is the member name of node, from its children: a node (a
// map[string]any), a []any of nodes for a list member, or nil.
func Member(node any, name string) any {
	if !isNode(node) {
		return nil
	}
	n := node.(map[string]any)
	kind, _ := n["kind"].(string)
	pick, ok := members[kind][name]
	if !ok {
		return nil
	}
	v := pick(n)
	if c, ok := v.(CNode); ok && c == nil {
		return nil
	}
	return v
}
