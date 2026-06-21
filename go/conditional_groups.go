/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

// Conditional-group folding: a translation-unit-level post-pass that collapses
// contiguous runs of #if/#ifdef/#ifndef … #elif … #else … #endif directives
// into a single conditional_group node. Port of ../ts/src/conditional-groups.ts.
//
// Best-effort: an unmatched #endif or unterminated #if leaves the surrounding
// children unchanged. The walker is structural — it only inspects already-
// parsed conditional_directive nodes embedded as the first child of an
// external_declaration — so it has zero dependency on the token stream.

func isIfOpen(d string) bool {
	return d == "if" || d == "ifdef" || d == "ifndef"
}

func isElseLike(d string) bool {
	return d == "elif" || d == "elifdef" || d == "elifndef" || d == "else"
}

// structureConditionalGroups folds conditional directives in parent.children
// in place, then recurses into preserved children.
func structureConditionalGroups(parent CNode) {
	chRaw, ok := parent["children"].([]any)
	if !ok {
		return
	}
	out := make([]any, 0, len(chRaw))
	i := 0
	for i < len(chRaw) {
		c := chRaw[i]
		dir := leadingConditionalDirective(c)
		if dir != nil {
			if d, _ := dir["directive"].(string); isIfOpen(d) {
				if node, next, built := tryBuildConditionalGroup(chRaw, i); built {
					out = append(out, node)
					i = next
					continue
				}
			}
		}
		out = append(out, c)
		i++
	}
	parent["children"] = out
	// Recurse into preserved children (e.g. function bodies).
	for _, c := range out {
		if cm, ok := c.(CNode); ok {
			if _, hasKind := cm["kind"]; hasKind {
				if _, hasCh := cm["children"].([]any); hasCh {
					structureConditionalGroups(cm)
				}
			}
		}
	}
}

// leadingConditionalDirective returns the conditional_directive node embedded
// as the first child of an external_declaration, or nil.
func leadingConditionalDirective(node any) CNode {
	nm, ok := node.(CNode)
	if !ok || nm["kind"] != "external_declaration" {
		return nil
	}
	children, ok := nm["children"].([]any)
	if !ok {
		return nil
	}
	for _, c := range children {
		if cm, ok := c.(CNode); ok && cm["kind"] == "conditional_directive" {
			return cm
		}
	}
	return nil
}

// tryBuildConditionalGroup attempts to build a conditional_group starting at
// index `from`. Returns the new node, the index after the closing #endif, and
// true; or false if no matching #endif at the same nesting level.
func tryBuildConditionalGroup(children []any, from int) (CNode, int, bool) {
	// First pass: find the matching #endif by depth.
	depth := 0
	endIdx := -1
	for i := from; i < len(children); i++ {
		dir := leadingConditionalDirective(children[i])
		if dir == nil {
			continue
		}
		d, _ := dir["directive"].(string)
		if isIfOpen(d) {
			depth++
		} else if d == "endif" {
			depth--
			if depth == 0 {
				endIdx = i
				break
			}
		}
	}
	if endIdx < 0 {
		return nil, 0, false
	}

	startCh, _ := children[from].(CNode)
	groupNode := makeNode("conditional_group", spanOfNode(startCh))
	branches := []any{}

	// Second pass: split [from … endIdx-1] into branches at top-level
	// #elif/#else.
	branchStart := from
	innerDepth := 0
	for i := from + 1; i < endIdx; i++ {
		dir := leadingConditionalDirective(children[i])
		if dir == nil {
			continue
		}
		d, _ := dir["directive"].(string)
		if isIfOpen(d) {
			innerDepth++
		} else if d == "endif" {
			innerDepth--
		} else if innerDepth == 0 && isElseLike(d) {
			branches = append(branches, buildBranch(children, branchStart, i))
			branchStart = i
		}
	}
	branches = append(branches, buildBranch(children, branchStart, endIdx))

	groupNode["branches"] = branches
	groupNode["endif"] = children[endIdx]
	// Append branches + endif to children so a depth-first walk still emits
	// the raw tokens in order.
	kids := groupNode["children"].([]any)
	kids = append(kids, branches...)
	kids = append(kids, children[endIdx])
	groupNode["children"] = kids

	return groupNode, endIdx + 1, true
}

// buildBranch constructs a conditional_branch node for children[from:to].
func buildBranch(children []any, from, to int) CNode {
	head, _ := children[from].(CNode)
	dir := leadingConditionalDirective(children[from])
	branch := makeNode("conditional_branch", spanOfNode(head))
	if dir != nil {
		branch["branchKind"] = dir["directive"]
	} else {
		branch["branchKind"] = "unknown"
	}
	branch["directive"] = head
	// Recurse into body so nested #if … #endif inside a branch also group.
	inner := makeNode("__branch_body__", spanOfNode(head))
	innerKids := []any{}
	for k := from + 1; k < to; k++ {
		innerKids = append(innerKids, children[k])
	}
	inner["children"] = innerKids
	structureConditionalGroups(inner)
	body := inner["children"].([]any)
	// Final children: directive followed by the (possibly grouped) body.
	final := make([]any, 0, 1+len(body))
	final = append(final, head)
	final = append(final, body...)
	branch["children"] = final
	branch["body"] = body
	return branch
}

// spanOfNode returns n["span"] as a map, or nil.
func spanOfNode(n CNode) map[string]any {
	if n == nil {
		return nil
	}
	if s, ok := n["span"].(map[string]any); ok {
		return s
	}
	return nil
}
