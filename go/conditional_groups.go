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
	out := foldConditionalRange(chRaw, 0, len(chRaw), indexConditionalGroups(chRaw))
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

type conditionalMatch struct {
	end      int
	branches []int
}

type conditionalFrame struct {
	open     int
	branches []int
}

// indexConditionalGroups resolves all matching delimiters and top-level
// branch markers in one pass, so nested and unmatched openers never rescan a
// suffix of the input.
func indexConditionalGroups(children []any) map[int]conditionalMatch {
	matches := map[int]conditionalMatch{}
	stack := []conditionalFrame{}
	for i, child := range children {
		dir := leadingConditionalDirective(child)
		if dir == nil {
			continue
		}
		word, _ := dir["directive"].(string)
		if isIfOpen(word) {
			stack = append(stack, conditionalFrame{open: i})
		} else if isElseLike(word) && len(stack) > 0 {
			top := len(stack) - 1
			stack[top].branches = append(stack[top].branches, i)
		} else if word == "endif" && len(stack) > 0 {
			top := len(stack) - 1
			frame := stack[top]
			stack = stack[:top]
			matches[frame.open] = conditionalMatch{end: i, branches: frame.branches}
		}
	}
	return matches
}

func foldConditionalRange(children []any, from, to int, matches map[int]conditionalMatch) []any {
	out := make([]any, 0, to-from)
	for i := from; i < to; {
		match, ok := matches[i]
		if ok && match.end < to {
			out = append(out, buildConditionalGroup(children, i, match, matches))
			i = match.end + 1
		} else {
			out = append(out, children[i])
			i++
		}
	}
	return out
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

func buildConditionalGroup(
	children []any, from int, match conditionalMatch, matches map[int]conditionalMatch,
) CNode {
	startCh, _ := children[from].(CNode)
	groupNode := makeNode("conditional_group", spanOfNode(startCh))
	starts := append([]int{from}, match.branches...)
	kids := groupNode["children"].([]any)
	for i, start := range starts {
		end := match.end
		if i+1 < len(starts) {
			end = starts[i+1]
		}
		kids = append(kids, buildBranch(children, start, end, matches))
	}
	groupNode["endif"] = children[match.end]
	kids = append(kids, children[match.end])
	groupNode["children"] = kids
	return groupNode
}

// buildBranch constructs a conditional_branch node for children[from:to].
func buildBranch(
	children []any, from, to int, matches map[int]conditionalMatch,
) CNode {
	head, _ := children[from].(CNode)
	dir := leadingConditionalDirective(children[from])
	branch := makeNode("conditional_branch", spanOfNode(head))
	if dir != nil {
		branch["branchKind"] = dir["directive"]
	} else {
		branch["branchKind"] = "unknown"
	}
	branch["directive"] = head
	body := foldConditionalRange(children, from+1, to, matches)
	final := make([]any, 0, 1+len(body))
	final = append(final, head)
	final = append(final, body...)
	branch["children"] = final
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
