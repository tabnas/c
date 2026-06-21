/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// Concrete-syntax-tree node helpers. CST nodes are represented as
// map[string]any to mirror the dynamic JS objects the TypeScript parser
// produces, so the two runtimes serialise to the same JSON (the cross-runtime
// parity contract). Every node carries:
//
//	kind:     string
//	span:     {start,end,line,col}
//	children: []any
//	trivia:   {leading:[]any, trailing:[]any}
//
// plus per-kind fields (value, name, op, left, right, ...). Token references
// are {kind:"token", tname, src, span}.

// CNode is the CST node type alias for readability.
type CNode = map[string]any

// zeroSpan is the {0,0,1,1} fallback span.
func zeroSpan() map[string]any {
	return map[string]any{"start": 0, "end": 0, "line": 1, "col": 1}
}

// tokenSpan returns the span for a token, or nil.
func tokenSpan(tkn *tabnas.Token) map[string]any {
	if tkn == nil {
		return nil
	}
	return map[string]any{
		"start": tkn.SI,
		"end":   tkn.SI + len(tkn.Src),
		"line":  tkn.RI,
		"col":   tkn.CI,
	}
}

// makeNode builds an empty CST node of the given kind. A nil span becomes
// zeroSpan.
func makeNode(kind string, span map[string]any) CNode {
	if span == nil {
		span = zeroSpan()
	}
	return CNode{
		"kind":     kind,
		"span":     span,
		"children": []any{},
		"trivia":   map[string]any{"leading": []any{}, "trailing": []any{}},
	}
}

// tokenRef builds a {kind:"token", ...} reference node for a token.
func tokenRef(tkn *tabnas.Token) map[string]any {
	return map[string]any{
		"kind":  "token",
		"tname": tkn.Name,
		"src":   tkn.Src,
		"span":  tokenSpan(tkn),
	}
}

// appendChild appends a child to node["children"].
func appendChild(node CNode, child any) {
	node["children"] = append(node["children"].([]any), child)
}

// nodeKind returns n["kind"] as a string, or "" if n is not a CST node.
func nodeKind(n any) string {
	if m, ok := n.(map[string]any); ok {
		if k, ok := m["kind"].(string); ok {
			return k
		}
	}
	return ""
}

// leadingTriviaRefs returns token-ref nodes for the leading trivia attached to
// tkn by the sub-lex hook (tkn.Use["leading"], a []any of *tabnas.Token).
func leadingTriviaRefs(tkn *tabnas.Token) []any {
	if tkn.Use == nil {
		return nil
	}
	raw, ok := tkn.Use["leading"].([]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, len(raw))
	for _, lt := range raw {
		if t, ok := lt.(*tabnas.Token); ok {
			out = append(out, tokenRef(t))
		}
	}
	return out
}
