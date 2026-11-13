/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"reflect"
	"strings"

	tabnas "github.com/tabnas/parser/go"
)

// The few operations every rule uses to build a node, beside cst.go's.
// Port of ts/src/node.ts.
//
// A rule builds its node from the tokens its alternates consume and the
// nodes of the rules it pushes. A token is either KEPT, as a child token
// reference, or DROPPED, where the node holds what it says in a field (an
// operator as `op`) or not at all (a call's parentheses). Either way the
// comments and line continuations the lexer put before it (the sub-lex
// hook attaches them to the next token's Use["leading"]) become children
// of the node at that place, so no comment is lost.

// isNode reports whether v is a node of the tree: not a token reference,
// not a raw value.
func isNode(v any) bool {
	m, ok := v.(map[string]any)
	if !ok || m == nil {
		return false
	}
	k, ok := m["kind"].(string)
	if !ok || k == "token" {
		return false
	}
	_, ok = m["children"].([]any)
	return ok
}

// childNodes is a node's child nodes, its tokens left out.
func childNodes(node CNode) []CNode {
	kids, _ := node["children"].([]any)
	out := make([]CNode, 0, len(kids))
	for _, c := range kids {
		if isNode(c) {
			out = append(out, c.(map[string]any))
		}
	}
	return out
}

// keepToken keeps tkn as a child of node, after the trivia before it.
func keepToken(node CNode, tkn *tabnas.Token) {
	pushTokenWithTrivia(node, tkn)
}

// dropToken drops tkn from the tree but keeps the trivia before it, as
// children of node at this place.
func dropToken(node CNode, tkn *tabnas.Token) {
	if node == nil || tkn == nil {
		return
	}
	for _, tr := range leadingTriviaRefs(tkn) {
		appendChild(node, tr)
	}
}

// nodeID is a node's identity: the map it is.
func nodeID(n CNode) uintptr { return reflect.ValueOf(n).Pointer() }

func isTriviaRef(m map[string]any) bool {
	t, _ := m["tname"].(string)
	return strings.HasPrefix(t, "TRIVIA_")
}

func copySpan(s map[string]any) map[string]any {
	out := make(map[string]any, len(s))
	for k, v := range s {
		out[k] = v
	}
	return out
}

// fixSpans gives every node in a subtree its span: the span of the first
// token it keeps, comments and line continuations left out; a node that
// keeps no token takes its parent's. Run once a subtree is complete: an
// external declaration when it ends, an expression parsed on its own. A
// node already given its span (an external declaration inside a
// conditional group), which `fixed` records, is not walked again. The
// walks are iterative: a chain of operators nests as deep as it is long.
func fixSpans(node CNode, parent map[string]any, fixed map[uintptr]CNode) {
	if node == nil {
		return
	}
	isFixed := func(n CNode) bool {
		if fixed == nil {
			return false
		}
		_, ok := fixed[nodeID(n)]
		return ok
	}
	type frame struct {
		n CNode
		i int
	}
	// Post-order: each node's first kept token, from its children's.
	first := map[uintptr]map[string]any{}
	seen := map[uintptr]bool{}
	stack := []*frame{{n: node}}
	for len(stack) > 0 {
		top := stack[len(stack)-1]
		n := top.n
		id := nodeID(n)
		if isFixed(n) {
			s, _ := n["span"].(map[string]any)
			first[id] = s
			seen[id] = true
			stack = stack[:len(stack)-1]
			continue
		}
		kids, _ := n["children"].([]any)
		if top.i < len(kids) {
			c := kids[top.i]
			top.i++
			if isNode(c) {
				cm := c.(map[string]any)
				if !seen[nodeID(cm)] {
					stack = append(stack, &frame{n: cm})
				}
			}
			continue
		}
		var f map[string]any
		for _, c := range kids {
			cm, ok := c.(map[string]any)
			if !ok || cm == nil {
				continue
			}
			var s map[string]any
			if k, _ := cm["kind"].(string); k == "token" {
				if !isTriviaRef(cm) {
					s, _ = cm["span"].(map[string]any)
				}
			} else if isNode(cm) {
				s = first[nodeID(cm)]
			}
			if s != nil {
				f = s
				break
			}
		}
		first[id] = f
		seen[id] = true
		stack = stack[:len(stack)-1]
	}
	// Pre-order: a node with no token of its own takes its parent's span.
	if parent == nil {
		parent = zeroSpan()
	}
	type item struct {
		n CNode
		p map[string]any
	}
	todo := []item{{node, parent}}
	for len(todo) > 0 {
		it := todo[len(todo)-1]
		todo = todo[:len(todo)-1]
		n := it.n
		if isFixed(n) {
			continue
		}
		if f := first[nodeID(n)]; f != nil {
			n["span"] = copySpan(f)
		} else {
			n["span"] = copySpan(it.p)
		}
		if fixed != nil {
			fixed[nodeID(n)] = n
		}
		span := n["span"].(map[string]any)
		kids, _ := n["children"].([]any)
		for _, c := range kids {
			if isNode(c) {
				todo = append(todo, item{c.(map[string]any), span})
			}
		}
	}
}

// unfixSpan forgets that a node was given its span, so the next fixSpans
// over a tree holding it gives it one again: a node that an evaluation
// built and a later one extended (a comma expression, a compound literal's
// postfix chain).
func unfixSpan(ctx *tabnas.Context, node CNode) {
	if m := ctxCMeta(ctx); m != nil && m.Fixed != nil && node != nil {
		delete(m.Fixed, nodeID(node))
	}
}

// fixSpansIn runs fixSpans with the parse's record of the nodes already
// given their spans.
func fixSpansIn(ctx *tabnas.Context, node CNode) {
	var fixed map[uintptr]CNode
	if m := ctxCMeta(ctx); m != nil {
		if m.Fixed == nil {
			m.Fixed = map[uintptr]CNode{}
		}
		fixed = m.Fixed
	}
	fixSpans(node, nil, fixed)
}
