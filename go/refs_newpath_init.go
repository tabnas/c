/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// registerInitializerRefs binds initializer_list / initializer_item /
// designation / designator handlers. Port of the c.ts phase C.4 refs.
func registerInitializerRefs(
	cond func(string, tabnas.AltCond),
	action func(string, tabnas.AltAction),
	state func(string, tabnas.StateAction),
) {
	// ---- initializer_list ----
	state("@initializer_list-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "ilNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("initializer_list", nil)
		r.K["ilNode"] = r.Node
		r.K["opened"] = false
		delete(r.K, "takenItems")
	})
	action("@il-take-lbrace", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["opened"] = true
	})
	cond("@il-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "opened")
	})
	action("@il-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@il-take-rbrace", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@initializer_list-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "initializer_item" && childNode(r) != nil &&
			!takenHas(r, "takenItems") {
			pushKids(ruleNode(r), childNode(r))
			takenSet(r, "takenItems")[r.Child] = true
		}
	})

	// ---- initializer_item ----
	state("@initializer_item-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "iiNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("initializer_item", nil)
		r.K["iiNode"] = r.Node
		r.K["hasDesig"] = false
		r.K["tookEq"] = false
		r.K["gotValue"] = false
		r.K["desigAttached"] = false
	})
	cond("@ii-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookEq")
	})
	action("@ii-mark-has-desig", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["hasDesig"] = true
	})
	action("@ii-mark-nested", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["nestedKind"] = "list"
	})
	cond("@ii-needs-eq", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "hasDesig") && !kBool(r, "tookEq")
	})
	action("@ii-take-eq", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookEq"] = true
	})
	cond("@ii-needs-value", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "hasDesig") && kBool(r, "tookEq") && !kBool(r, "gotValue")
	})
	state("@initializer_item-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		// Capture the raw child node (may not be a C-CST map). The val
		// case below accepts a non-CNode raw @tabnas/expr op-array too —
		// see the comment there.
		var rawChild any
		if r.Child != nil && r.Child != tabnas.NoRule {
			rawChild = r.Child.Node
		}
		if rawChild == nil {
			return
		}
		cn := childNode(r)
		switch childName(r) {
		case "designation":
			if cn != nil && !kBool(r, "desigAttached") {
				node := ruleNode(r)
				pushKids(node, cn)
				node["designation"] = cn
				r.K["desigAttached"] = true
			}
		case "initializer_list":
			if cn != nil && !kBool(r, "gotValue") {
				init := makeNode("initializer", nil)
				pushKids(init, cn)
				node := ruleNode(r)
				pushKids(node, init)
				node["value"] = init
				r.K["gotValue"] = true
			}
		case "val":
			// Mirror the TS @initializer_item-bc which pushes
			// rule.child.node directly regardless of its shape
			// (ts/src/c.ts). When an item value is a prefix/operator
			// expression in a brace initializer (e.g. the `-7` of
			// `{5,-7,20}`), @tabnas/expr's evaluate callback never fires
			// for it — the surrounding C grammar's comma close pre-empts
			// the expr rule's evaluating after-close — so the val child's
			// node is the raw, unevaluated op-array (a *tabnas.ListRef in
			// the Go port). childNode() returns nil for that because it
			// only type-asserts a C-CST map, so it would otherwise be
			// silently dropped and the item would render with zero
			// children. The reference fixtures keep the raw value, which
			// toFixture serialises as an empty `{}` child, so push the
			// raw node here too. Use cn (the asserted map) when it is a
			// real CST node, else fall back to the raw op-array.
			if !kBool(r, "gotValue") {
				if cn != nil {
					if sameNode(cn, ruleNode(r)) {
						return
					}
					node := ruleNode(r)
					pushKids(node, cn)
					node["value"] = cn
					r.K["gotValue"] = true
				} else {
					node := ruleNode(r)
					pushKids(node, rawChild)
					node["value"] = rawChild
					r.K["gotValue"] = true
				}
			}
		}
	})

	// ---- designation ----
	state("@designation-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "dsNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("designation", nil)
		r.K["dsNode"] = r.Node
		delete(r.K, "takenDrs")
	})
	state("@designation-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "designator" && childNode(r) != nil &&
			!takenHas(r, "takenDrs") {
			pushKids(ruleNode(r), childNode(r))
			takenSet(r, "takenDrs")[r.Child] = true
		}
	})

	// ---- designator ----
	state("@designator-bo", func(_ *tabnas.Rule, _ *tabnas.Context) {})
	action("@dr-take-dot", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("member_designator", nil)
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["kind"] = "member"
	})
	action("@dr-take-lbracket", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("index_designator", nil)
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["kind"] = "index"
	})
	cond("@dr-needs-id", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kStr(r, "kind") == "member" && !kBool(r, "tookId")
	})
	action("@dr-take-id", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		node["memberName"] = tkn.Src
		pushTokenWithTrivia(node, tkn)
		r.K["tookId"] = true
	})
	cond("@dr-needs-rbracket", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kStr(r, "kind") == "index" && !kBool(r, "tookRbracket")
	})
	action("@dr-take-rbracket", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookRbracket"] = true
	})
	state("@designator-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if kStr(r, "kind") == "index" && childName(r) == "val" &&
			childNode(r) != nil && !sameNode(childNode(r), ruleNode(r)) &&
			!kBool(r, "idxExprAttached") {
			pushKids(ruleNode(r), childNode(r))
			r.K["idxExprAttached"] = true
		}
	})
}
