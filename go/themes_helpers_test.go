/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

// Shared helpers for the theme test files (statements, parameters, calls,
// macros, expressions, initializers, static_assert, _Generic, asm,
// attributes). These mirror the walkTokens/findKind/findTokenBySrc helpers
// in ../ts/test/c.test.ts.

// asNode converts any to CNode (nil if not a map).
func asNode(v any) CNode {
	n, _ := v.(map[string]any)
	return n
}

// field returns node[key] as a CNode (nil if absent/not a node), or the
// node's member key (Member), which the tree holds as one of its children.
func field(node CNode, key string) CNode {
	if node == nil {
		return nil
	}
	if v, ok := node[key]; ok {
		return asNode(v)
	}
	return asNode(Member(node, key))
}

// fieldStr returns node[key] as a string ("" if absent).
func fieldStr(node CNode, key string) string {
	if node == nil {
		return ""
	}
	s, _ := node[key].(string)
	return s
}

// collectKind returns every descendant of node (depth-first, source order)
// whose kind equals kind. Mirrors the ad-hoc visit() collectors in c.test.ts.
func collectKind(node any, kind string) []CNode {
	var out []CNode
	var visit func(n any)
	visit = func(n any) {
		m, ok := n.(map[string]any)
		if !ok {
			return
		}
		if m["kind"] == kind {
			out = append(out, m)
		}
		if children, ok := m["children"].([]any); ok {
			for _, c := range children {
				visit(c)
			}
		}
	}
	visit(node)
	return out
}

// childrenOfKind returns the direct children of node with the given kind.
func childrenOfKind(node CNode, kind string) []CNode {
	var out []CNode
	ch, _ := node["children"].([]any)
	for _, c := range ch {
		if nodeKind(c) == kind {
			out = append(out, c.(CNode))
		}
	}
	return out
}

// findTokenBySrcNode walks node's token refs in source order and returns the
// first with the given src (nil if none). Mirrors findTokenBySrc in c.test.ts.
func findTokenBySrcNode(node any, src string) CNode {
	var found CNode
	var visit func(n any)
	visit = func(n any) {
		if found != nil {
			return
		}
		m, ok := n.(map[string]any)
		if !ok {
			return
		}
		if m["kind"] == "token" {
			if s, _ := m["src"].(string); s == src {
				found = m
			}
			return
		}
		if children, ok := m["children"].([]any); ok {
			for _, c := range children {
				visit(c)
			}
		}
	}
	visit(node)
	return found
}

// mustFind fails the test if findKindByValue(node, kind) is nil.
func mustFind(t *testing.T, node any, kind string) CNode {
	t.Helper()
	n := findKindByValue(node, kind)
	if n == nil {
		t.Fatalf("no %s node found", kind)
	}
	return n
}

// strSlice converts a []any of strings to []string.
func strSlice(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// nodeSlice returns node[key] as a []CNode (nil-safe), for fields holding
// arrays of nodes, or the node's list member key (Member), such as
// attribute_spec.items and generic_selection.associations.
func nodeSlice(node CNode, key string) []CNode {
	if node == nil {
		return nil
	}
	v, ok := node[key]
	if !ok {
		v = Member(node, key)
	}
	arr, _ := v.([]any)
	out := make([]CNode, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// parseTU parses src in extended mode (the TypeScript suite's shared
// instance) and returns the translation unit.
func parseTU(t *testing.T, src string) CNode {
	t.Helper()
	out, err := Parse(src, map[string]any{"extended": true})
	if err != nil {
		t.Fatalf("Parse(%q) error: %v", src, err)
	}
	tu, ok := out.(CNode)
	if !ok {
		t.Fatalf("Parse(%q) returned %T, want CNode", src, out)
	}
	if tu["kind"] != "translation_unit" {
		t.Fatalf("root kind = %v, want translation_unit", tu["kind"])
	}
	return tu
}

func tuChildren(t *testing.T, tu CNode) []any {
	t.Helper()
	ch, _ := tu["children"].([]any)
	return ch
}

// findKindByValue searches node recursively for the first node whose "kind"
// field equals kind. (findKind in structure.go searches by key existence.)
func findKindByValue(node any, kind string) CNode {
	m, ok := node.(map[string]any)
	if !ok {
		return nil
	}
	if m["kind"] == kind {
		return m
	}
	if children, ok := m["children"].([]any); ok {
		for _, c := range children {
			if hit := findKindByValue(c, kind); hit != nil {
				return hit
			}
		}
	}
	return nil
}

// walkTokenSrcs returns token srcs in source order under node.
func walkTokenSrcs(node any) []string {
	var out []string
	var visit func(n any)
	visit = func(n any) {
		m, ok := n.(map[string]any)
		if !ok {
			return
		}
		if m["kind"] == "token" {
			if s, ok := m["src"].(string); ok {
				out = append(out, s)
			}
			return
		}
		if children, ok := m["children"].([]any); ok {
			for _, c := range children {
				visit(c)
			}
		}
	}
	visit(node)
	return out
}

func childKindCount(node CNode, kind string) int {
	ch, _ := node["children"].([]any)
	n := 0
	for _, c := range ch {
		if nodeKind(c) == kind {
			n++
		}
	}
	return n
}
