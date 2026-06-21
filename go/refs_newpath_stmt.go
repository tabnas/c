/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// registerStatementRefs binds compound_statement and the statement family
// handlers. Port of the c.ts phase B4 refs.
func registerStatementRefs(
	cond func(string, tabnas.AltCond),
	action func(string, tabnas.AltAction),
	state func(string, tabnas.StateAction),
) {
	// ---- compound_statement ----
	state("@compound_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("compound_statement", nil)
	})
	action("@cs-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	action("@cs-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@compound_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "block_item" && childNode(r) != nil && !takenHas(r, "taken") {
			pushKids(ruleNode(r), childNode(r))
			takenSet(r, "taken")[r.Child] = true
		}
	})

	// ---- block_item / statement dispatchers ----
	state("@block_item-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childNode(r) != nil {
			r.Node = childNode(r)
		}
	})
	state("@statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "expression_statement" &&
			childNode(r) == nil {
			return
		}
		if childNode(r) != nil {
			r.Node = childNode(r)
		}
	})
	action("@stmt-empty", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := makeNode("expression_statement", nil)
		pushTokenWithTrivia(node, r.O0)
		r.Node = node
	})

	// ---- expression_statement ----
	state("@expression_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("expression_statement", nil)
	})
	action("@es-take-expr", func(_ *tabnas.Rule, _ *tabnas.Context) {})
	state("@expression_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "val" && childNode(r) != nil &&
			!sameNode(childNode(r), ruleNode(r)) && !kBool(r, "exprAttached") {
			pushKids(ruleNode(r), childNode(r))
			r.K["exprAttached"] = true
		}
	})
	action("@es-finalize", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})

	// ---- jump_statement ----
	state("@jump_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "jump_statement" {
			return
		}
		r.Node = makeNode("jump_statement", nil)
	})
	cond("@js-reentry", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "started")
	})
	action("@js-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := ruleNode(r)
		node["jumpKind"] = tkn.Src
		pushTokenWithTrivia(node, tkn)
		r.K["started"] = true
	})
	cond("@js-needs-label", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return ruleNode(r)["jumpKind"] == "goto" && !kBool(r, "tookLabel")
	})
	action("@js-take-label", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookLabel"] = true
	})
	cond("@js-needs-expr", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return ruleNode(r)["jumpKind"] == "return" && !kBool(r, "tookExpr")
	})
	action("@js-take-expr", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["tookExpr"] = true
	})
	state("@jump_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "val" && childNode(r) != nil &&
			!sameNode(childNode(r), ruleNode(r)) && kBool(r, "tookExpr") && !kBool(r, "exprAttached") {
			pushKids(ruleNode(r), childNode(r))
			r.K["exprAttached"] = true
		}
	})
	action("@js-finalize", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})

	// ---- paren_condition ----
	state("@paren_condition-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("paren_condition", nil)
	})
	action("@pc-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	action("@pc-take-expr", func(_ *tabnas.Rule, _ *tabnas.Context) {})
	state("@paren_condition-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "val" && childNode(r) != nil &&
			!sameNode(childNode(r), ruleNode(r)) && !kBool(r, "exprAttached") {
			pushKids(ruleNode(r), childNode(r))
			r.K["exprAttached"] = true
		}
	})
	action("@pc-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})

	registerControlFlowRefs(cond, action, state)
}

func registerControlFlowRefs(
	cond func(string, tabnas.AltCond),
	action func(string, tabnas.AltAction),
	state func(string, tabnas.StateAction),
) {
	// ---- if_statement ----
	state("@if_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "ifNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("if_statement", nil)
		r.K["ifNode"] = r.Node
		clearStmtState(r)
	})
	action("@if-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	cond("@if-needs-cond", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "tookCond")
	})
	cond("@if-needs-then", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookCond") && !kBool(r, "tookThen")
	})
	cond("@if-needs-else-kw", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookThen") && !kBool(r, "elseSeen")
	})
	action("@if-take-else-kw", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["elseSeen"] = true
	})
	cond("@if-needs-else-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "elseSeen") && !kBool(r, "tookElse")
	})
	state("@if_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childNode(r) == nil {
			return
		}
		if childName(r) == "paren_condition" && !kBool(r, "tookCond") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookCond"] = true
			return
		}
		if childName(r) == "statement" {
			if !kBool(r, "tookThen") {
				pushKids(ruleNode(r), childNode(r))
				r.K["tookThen"] = true
			} else if kBool(r, "elseSeen") && !kBool(r, "tookElse") {
				pushKids(ruleNode(r), childNode(r))
				r.K["tookElse"] = true
			}
		}
	})

	// ---- while_statement ----
	state("@while_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "whileNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("while_statement", nil)
		r.K["whileNode"] = r.Node
		clearStmtState(r)
	})
	action("@while-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	cond("@while-needs-cond", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "tookCond")
	})
	cond("@while-needs-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookCond") && !kBool(r, "tookBody")
	})
	state("@while_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childNode(r) == nil {
			return
		}
		if childName(r) == "paren_condition" && !kBool(r, "tookCond") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookCond"] = true
			return
		}
		if childName(r) == "statement" && !kBool(r, "tookBody") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookBody"] = true
		}
	})

	// ---- do_statement ----
	state("@do_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "doNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("do_statement", nil)
		r.K["doNode"] = r.Node
		clearStmtState(r)
	})
	action("@do-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	cond("@do-needs-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "tookBody")
	})
	cond("@do-needs-while", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookBody") && !kBool(r, "tookWhile")
	})
	action("@do-take-while", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookWhile"] = true
	})
	cond("@do-needs-cond", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookWhile") && !kBool(r, "tookCond")
	})
	cond("@do-needs-semi", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookCond") && !kBool(r, "tookSemi")
	})
	action("@do-take-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookSemi"] = true
	})
	state("@do_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childNode(r) == nil {
			return
		}
		if childName(r) == "statement" && !kBool(r, "tookBody") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookBody"] = true
			return
		}
		if childName(r) == "paren_condition" && !kBool(r, "tookCond") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookCond"] = true
		}
	})

	// ---- switch_statement ----
	state("@switch_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "switchNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("switch_statement", nil)
		r.K["switchNode"] = r.Node
		clearStmtState(r)
	})
	action("@switch-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	cond("@switch-needs-cond", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "tookCond")
	})
	cond("@switch-needs-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookCond") && !kBool(r, "tookBody")
	})
	state("@switch_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childNode(r) == nil {
			return
		}
		if childName(r) == "paren_condition" && !kBool(r, "tookCond") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookCond"] = true
			return
		}
		if childName(r) == "statement" && !kBool(r, "tookBody") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookBody"] = true
		}
	})

	// ---- for_statement ----
	state("@for_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "forNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("for_statement", nil)
		r.K["forNode"] = r.Node
		clearStmtState(r)
	})
	action("@for-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	cond("@for-needs-controls", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "tookControls")
	})
	cond("@for-needs-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookControls") && !kBool(r, "tookBody")
	})
	state("@for_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childNode(r) == nil {
			return
		}
		if childName(r) == "for_controls" && !kBool(r, "tookControls") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookControls"] = true
			return
		}
		if childName(r) == "statement" && !kBool(r, "tookBody") {
			pushKids(ruleNode(r), childNode(r))
			r.K["tookBody"] = true
		}
	})

	// ---- for_controls ----
	state("@for_controls-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "fcNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("for_controls", nil)
		r.K["fcNode"] = r.Node
		clearStmtState(r)
	})
	action("@fc-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	cond("@fc-needs-cond", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookInit") && !kBool(r, "tookCond")
	})
	cond("@fc-needs-iter", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookCond") && !kBool(r, "tookIter")
	})
	action("@fc-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@for_controls-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		switch childName(r) {
		case "for_init":
			if !kBool(r, "tookInit") {
				node := ruleNode(r)
				pushKids(node, cn)
				node["init"] = cn
				r.K["tookInit"] = true
			}
		case "for_cond":
			if !kBool(r, "tookCond") {
				node := ruleNode(r)
				pushKids(node, cn)
				node["cond"] = cn
				r.K["tookCond"] = true
			}
		case "for_iter":
			if !kBool(r, "tookIter") {
				node := ruleNode(r)
				pushKids(node, cn)
				node["iter"] = cn
				r.K["tookIter"] = true
			}
		}
	})

	// ---- for_init ----
	state("@for_init-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "for_init" {
			return
		}
		r.Node = makeNode("for_init", nil)
	})
	action("@fi-empty-take-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["took"] = "empty"
	})
	action("@fi-mark-decl", func(r *tabnas.Rule, _ *tabnas.Context) { r.K["took"] = "decl" })
	action("@fi-mark-expr", func(r *tabnas.Rule, _ *tabnas.Context) { r.K["took"] = "expr" })
	cond("@fi-needs-semi", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kStr(r, "took") == "expr" && !kBool(r, "tookSemi")
	})
	action("@fi-take-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookSemi"] = true
	})
	state("@for_init-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		node := ruleNode(r)
		if kStr(r, "took") == "decl" && childName(r) == "simple_declaration" &&
			node["value"] == nil {
			pushKids(node, cn)
			node["value"] = cn
		} else if kStr(r, "took") == "expr" && childName(r) == "val" &&
			!sameNode(cn, node) && node["value"] == nil {
			pushKids(node, cn)
			node["value"] = cn
		}
	})

	// ---- for_cond ----
	state("@for_cond-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "for_cond" {
			return
		}
		r.Node = makeNode("for_cond", nil)
	})
	action("@fcond-empty-take-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["took"] = "empty"
	})
	action("@fcond-mark-expr", func(r *tabnas.Rule, _ *tabnas.Context) { r.K["took"] = "expr" })
	cond("@fcond-needs-semi", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kStr(r, "took") == "expr" && !kBool(r, "tookSemi")
	})
	action("@fcond-take-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookSemi"] = true
	})
	state("@for_cond-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		node := ruleNode(r)
		if kStr(r, "took") == "expr" && childName(r) == "val" &&
			!sameNode(cn, node) && node["value"] == nil {
			pushKids(node, cn)
			node["value"] = cn
		}
	})

	// ---- for_iter ----
	state("@for_iter-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "for_iter" {
			return
		}
		r.Node = makeNode("for_iter", nil)
	})
	action("@fiter-empty", func(_ *tabnas.Rule, _ *tabnas.Context) {})
	action("@fiter-mark-expr", func(r *tabnas.Rule, _ *tabnas.Context) { r.K["took"] = "expr" })
	state("@for_iter-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		node := ruleNode(r)
		if kStr(r, "took") == "expr" && childName(r) == "val" &&
			!sameNode(cn, node) && node["value"] == nil {
			pushKids(node, cn)
			node["value"] = cn
		}
	})

	// ---- labeled_statement ----
	state("@labeled_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "labeled_statement" {
			return
		}
		r.Node = makeNode("labeled_statement", nil)
	})
	action("@lbl-take-case", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		node["labelKind"] = "case"
		pushTokenWithTrivia(node, r.O0)
		r.K["kind"] = "case"
	})
	action("@lbl-take-default", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		node["labelKind"] = "default"
		pushTokenWithTrivia(node, r.O0)
		r.K["kind"] = "default"
	})
	action("@lbl-take-name", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		node["labelKind"] = "label"
		node["labelName"] = r.O0.Src
		pushTokenWithTrivia(node, r.O0)
		r.K["kind"] = "label"
	})
	cond("@lbl-needs-expr", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kStr(r, "kind") == "case" && !kBool(r, "tookExpr")
	})
	action("@lbl-mark-expr", func(r *tabnas.Rule, _ *tabnas.Context) { r.K["tookExpr"] = true })
	cond("@lbl-needs-colon", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "tookColon")
	})
	action("@lbl-take-colon", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookColon"] = true
	})
	cond("@lbl-needs-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookColon") && !kBool(r, "tookBody")
	})
	state("@labeled_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		if kStr(r, "kind") == "case" && childName(r) == "val" &&
			!sameNode(cn, ruleNode(r)) && !kBool(r, "exprAttached") {
			pushKids(ruleNode(r), cn)
			r.K["exprAttached"] = true
			return
		}
		if childName(r) == "statement" && !kBool(r, "tookBody") {
			pushKids(ruleNode(r), cn)
			r.K["tookBody"] = true
		}
	})
}
