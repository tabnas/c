/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// registerExprSupportRefs binds the expression-support sub-rules reached from
// val: type_name, sizeof_type_form, cast_or_compound_literal,
// compound_literal_body, string_atom, statement_expression, and the
// _Generic family. Port of the c.ts phase C.2-C.7 refs.
func registerExprSupportRefs(
	cond func(string, tabnas.AltCond),
	action func(string, tabnas.AltAction),
	state func(string, tabnas.StateAction),
) {
	// ---- type_name ----
	state("@type_name-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "tnNode"); n != nil {
				r.Node = n
				return
			}
		}
		node := makeNode("type_name", nil)
		r.K["tnNode"] = node
		r.K["tnTaken"] = false
		r.K["depth"] = 0
		r.Node = node
	})
	cond("@tn-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kNode(r, "tnNode") != nil && kBool(r, "tnTaken")
	})
	action("@tn-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := stateTokOC(r)
		pushTokenWithTrivia(ruleNode(r), tkn)
		r.K["tnTaken"] = true
		d, _ := r.K["depth"].(int)
		switch tkn.Name {
		case "PUNC_LPAREN", "PUNC_LBRACKET":
			d++
		case "PUNC_RPAREN", "PUNC_RBRACKET":
			d--
		}
		r.K["depth"] = d
	})
	cond("@tn-balanced", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		d, _ := r.K["depth"].(int)
		return d == 0
	})

	// ---- sizeof_type_form ----
	state("@sizeof_type_form-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("unary_expression", nil)
	})
	action("@stf-take-kw", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := ruleNode(r)
		node["op"] = tkn.Src
		pushTokenWithTrivia(node, tkn)
		r.K["kwTaken"] = true
	})
	cond("@stf-needs-lparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "kwTaken") && !kBool(r, "tookLparen")
	})
	action("@stf-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookLparen"] = true
	})
	cond("@stf-needs-rparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookLparen") && !kBool(r, "tookRparen")
	})
	action("@stf-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["tookRparen"] = true
	})
	state("@sizeof_type_form-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "type_name" && childNode(r) != nil && !kBool(r, "typeNameAttached") {
			node := ruleNode(r)
			pushKids(node, childNode(r))
			node["operand"] = childNode(r)
			r.K["typeNameAttached"] = true
		}
	})

	// ---- cast_or_compound_literal ----
	state("@cast_or_compound_literal-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["children"] = []any{}
	})
	action("@cocl-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["lparenTkn"] = r.O0
	})
	cond("@cocl-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		_, ok := r.K["lparenTkn"].(*tabnas.Token)
		return ok
	})
	cond("@cocl-needs-rparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "tookRparen")
	})
	action("@cocl-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["rparenTkn"] = r.C0
		r.K["tookRparen"] = true
	})
	cond("@cocl-needs-decision", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "tookRparen") && kStr(r, "decided") == ""
	})
	action("@cocl-mark-cl", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["decided"] = "compound_literal"
	})
	action("@cocl-mark-cast", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["decided"] = "cast"
	})
	state("@cast_or_compound_literal-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		switch childName(r) {
		case "type_name":
			if kNode(r, "typeName") == nil {
				r.K["typeName"] = cn
			}
		case "initializer_list", "compound_literal_body":
			if kNode(r, "compoundBody") == nil {
				r.K["compoundBody"] = cn
			}
		case "val":
			if kNode(r, "castOperand") == nil {
				r.K["castOperand"] = cn
			}
		}
	})
	action("@cocl-finalize", func(r *tabnas.Rule, _ *tabnas.Context) {
		decided := kStr(r, "decided")
		if decided == "" {
			decided = "cast"
		}
		tn := kNode(r, "typeName")
		var node CNode
		lparen, _ := r.K["lparenTkn"].(*tabnas.Token)
		rparen, _ := r.K["rparenTkn"].(*tabnas.Token)
		if decided == "compound_literal" {
			node = makeNode("compound_literal", nil)
			if lparen != nil {
				pushTokenWithTrivia(node, lparen)
			}
			if tn != nil {
				pushKids(node, tn)
				node["typeName"] = tn
			}
			if rparen != nil {
				pushTokenWithTrivia(node, rparen)
			}
			if cb := kNode(r, "compoundBody"); cb != nil {
				pushKids(node, cb)
			}
		} else {
			node = makeNode("cast_expression", nil)
			if lparen != nil {
				pushTokenWithTrivia(node, lparen)
			}
			if tn != nil {
				pushKids(node, tn)
				node["typeName"] = tn
			}
			if rparen != nil {
				pushTokenWithTrivia(node, rparen)
			}
			if co := kNode(r, "castOperand"); co != nil {
				pushKids(node, co)
				node["operand"] = co
			}
		}
		r.Node = node
		parent := parentRule(r)
		if parent != nil && parent.Child != nil && parent.Child != tabnas.NoRule &&
			parent.Child.Name == r.Name {
			parent.Child.Node = node
		}
	})

	// ---- compound_literal_body ----
	state("@compound_literal_body-bo", func(_ *tabnas.Rule, _ *tabnas.Context) {})
	state("@compound_literal_body-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "initializer_list" && childNode(r) != nil && !kBool(r, "relayed") {
			r.Node = childNode(r)
			r.K["relayed"] = true
		}
	})

	// ---- string_atom ----
	state("@string_atom-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "saNode"); n != nil {
				r.Node = n
				return
			}
		}
		node := makeNode("literal_expression", nil)
		node["literalKind"] = "LIT_STRING"
		r.K["saNode"] = node
		r.K["taken"] = false
		r.Node = node
	})
	cond("@sa-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "taken")
	})
	action("@sa-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := stateTokOC(r)
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		if !kBool(r, "taken") {
			node["value"] = tkn.Src
			r.K["taken"] = true
		} else {
			cur, _ := node["value"].(string)
			node["value"] = cur + tkn.Src
		}
	})

	// ---- statement_expression ----
	state("@statement_expression-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("statement_expression", nil)
	})
	action("@se-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	action("@se-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@statement_expression-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "compound_statement" && childNode(r) != nil && !kBool(r, "bodyAttached") {
			pushKids(ruleNode(r), childNode(r))
			r.K["bodyAttached"] = true
		}
	})

	registerGenericRefs(cond, action, state)
}

// registerGenericRefs binds the C11 _Generic family. Port of phase C.5 refs.
func registerGenericRefs(
	cond func(string, tabnas.AltCond),
	action func(string, tabnas.AltAction),
	state func(string, tabnas.StateAction),
) {
	// ---- generic_selection ----
	state("@generic_selection-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "gsNode"); n != nil {
				r.Node = n
				return
			}
		}
		node := makeNode("generic_selection", nil)
		node["associations"] = []any{}
		r.K["gsNode"] = node
		r.Node = node
	})
	cond("@gs-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "kwTaken")
	})
	action("@gs-take-kw", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["kwTaken"] = true
	})
	cond("@gs-need-lparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "kwTaken") && !kBool(r, "lparenTaken")
	})
	action("@gs-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["lparenTaken"] = true
	})
	cond("@gs-need-ctrl", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "lparenTaken") && !kBool(r, "ctrlTaken")
	})
	cond("@gs-need-comma", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "ctrlTaken") && !kBool(r, "commaTaken")
	})
	action("@gs-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["commaTaken"] = true
		r.K["lastWasAssoc"] = false
	})
	cond("@gs-need-association", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "commaTaken") && !kBool(r, "lastWasAssoc")
	})
	cond("@gs-after-association", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "lastWasAssoc")
	})
	cond("@gs-need-rparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "lastWasAssoc") && !kBool(r, "rparenTaken")
	})
	action("@gs-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["rparenTaken"] = true
	})
	state("@generic_selection-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		switch childName(r) {
		case "generic_controlling_expression":
			if !kBool(r, "ctrlTaken") {
				node := ruleNode(r)
				pushKids(node, cn)
				node["controlling"] = cn
				r.K["ctrlTaken"] = true
			}
		case "generic_association":
			if !takenHas(r, "takenAssocs") {
				node := ruleNode(r)
				pushKids(node, cn)
				node["associations"] = append(node["associations"].([]any), cn)
				takenSet(r, "takenAssocs")[r.Child] = true
				r.K["lastWasAssoc"] = true
			}
		}
	})

	// ---- generic_controlling_expression ----
	state("@generic_controlling_expression-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("generic_controlling_expression", nil)
	})
	state("@generic_controlling_expression-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "val" && childNode(r) != nil &&
			!sameNode(childNode(r), ruleNode(r)) && !kBool(r, "exprAttached") {
			node := ruleNode(r)
			pushKids(node, childNode(r))
			node["expression"] = childNode(r)
			r.K["exprAttached"] = true
		}
	})

	// ---- generic_association ----
	state("@generic_association-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "gaNode"); n != nil {
				r.Node = n
				return
			}
		}
		node := makeNode("generic_association", nil)
		r.K["gaNode"] = node
		delete(r.K, "gaKind")
		r.K["gaColonTaken"] = false
		r.K["gaValueTaken"] = false
		r.K["gaTypeAttached"] = false
		r.Node = node
	})
	cond("@ga-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kStr(r, "gaKind") != ""
	})
	action("@ga-take-default", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		node["associationKind"] = "default"
		pushTokenWithTrivia(node, r.O0)
		r.K["gaKind"] = "default"
	})
	action("@ga-mark-type", func(r *tabnas.Rule, _ *tabnas.Context) {
		ruleNode(r)["associationKind"] = "type"
		r.K["gaKind"] = "type"
	})
	cond("@ga-need-colon", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kStr(r, "gaKind") != "" && !kBool(r, "gaColonTaken")
	})
	action("@ga-take-colon", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["gaColonTaken"] = true
	})
	cond("@ga-need-value", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "gaColonTaken") && !kBool(r, "gaValueTaken")
	})
	state("@generic_association-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		switch childName(r) {
		case "type_name_assoc":
			if !kBool(r, "gaTypeAttached") {
				node := ruleNode(r)
				pushKids(node, cn)
				node["typeName"] = cn
				r.K["gaTypeAttached"] = true
			}
		case "val":
			if !sameNode(cn, ruleNode(r)) && !kBool(r, "gaValueTaken") {
				node := ruleNode(r)
				pushKids(node, cn)
				node["value"] = cn
				r.K["gaValueTaken"] = true
			}
		}
	})

	// ---- type_name_assoc ----
	state("@type_name_assoc-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "tnaNode"); n != nil {
				r.Node = n
				return
			}
		}
		node := makeNode("type_name", nil)
		r.K["tnaNode"] = node
		r.K["tnaDepth"] = 0
		r.Node = node
	})
	cond("@tna-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kNode(r, "tnaNode") != nil
	})
	action("@tna-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := stateTokOC(r)
		pushTokenWithTrivia(ruleNode(r), tkn)
		d, _ := r.K["tnaDepth"].(int)
		switch tkn.Name {
		case "PUNC_LPAREN", "PUNC_LBRACKET":
			d++
		case "PUNC_RPAREN", "PUNC_RBRACKET":
			d--
		}
		r.K["tnaDepth"] = d
	})
	cond("@tna-stop", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		d, _ := r.K["tnaDepth"].(int)
		return d == 0
	})
}
