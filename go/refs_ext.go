/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// Extension-construct grammar-ref handlers: inline assembly (asm_statement
// and sub-rules), attribute specs (GCC / MSVC / C23 forms + items + argument lists), and top-level
// static_assert declarations. Port of the corresponding c.ts makeGrammarRefs
// regions (phases C.8, B4.2.4, G.1-G.4, I.1 / phase O).
//
// Registered from makeGrammarRefs via registerExtRefs; before this port
// these @refs were installed as silent no-op stubs by scanAndStubRefs.

// kInt returns the int value of r.K[key] (0 if absent).
func kInt(r *tabnas.Rule, key string) int {
	n, _ := r.K[key].(int)
	return n
}

func registerExtRefs(reg regFns) {
	cond, action, state := reg.cond, reg.action, reg.state

	// ==================================================================
	// asm_statement (phase C.8 — structured form)
	//
	// State machine across r:-recursion via rule.k:
	//   .started       KW consumed (open-state re-entry sentinel)
	//   .lparenTaken   `(` consumed (qualifier loop done)
	//   .templateTaken asm_template returned
	//   .sectionIdx    next section to take (0..3)
	//   .lastWasColon  the previous matched alt was a section-colon
	//                  (so we expect a section next, even if empty)
	//   .rparenTaken   `)` consumed (sections done)
	//   .semiTaken     `;` consumed (rule finalised)
	// ==================================================================
	state("@asm_statement-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["asmNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("asm_statement", nil)
		node["qualifiers"] = []any{}
		r.K["asmNode"] = node
		r.K["sectionIdx"] = 0
		r.Node = node
	})
	cond("@asm-reentry", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "started")
	})
	action("@asm-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["started"] = true
	})
	cond("@asm-need-qualifier", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "started") && !kBool(r, "lparenTaken")
	})
	action("@asm-take-qualifier", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		if quals, ok := node["qualifiers"].([]any); ok {
			node["qualifiers"] = append(quals, tkn.Src)
		}
		pushTokenWithTrivia(node, tkn)
	})
	cond("@asm-need-lparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "started") && !kBool(r, "lparenTaken")
	})
	action("@asm-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["lparenTaken"] = true
	})
	cond("@asm-need-template", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "lparenTaken") && !kBool(r, "templateTaken")
	})
	cond("@asm-need-section-colon", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "templateTaken") && !kBool(r, "rparenTaken") &&
			!kBool(r, "lastWasColon") && kInt(r, "sectionIdx") < 4
	})
	action("@asm-take-section-colon", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["lastWasColon"] = true
	})
	cond("@asm-need-section", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "lastWasColon") && !kBool(r, "rparenTaken")
	})
	cond("@asm-need-rparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "lparenTaken") && !kBool(r, "rparenTaken")
	})
	action("@asm-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["rparenTaken"] = true
	})
	cond("@asm-need-semi", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "semiTaken")
	})
	action("@asm-take-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["semiTaken"] = true
	})
	state("@asm_statement-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := childNode(r)
		if child == nil {
			return
		}
		node := ruleNode(r)
		if childName(r) == "asm_template" && !kBool(r, "templateTaken") {
			pushKids(node, child)
			r.K["templateTaken"] = true
			return
		}
		if childName(r) == "asm_section" && !takenHas(r, "takenSecs") {
			idx := kInt(r, "sectionIdx")
			kindMap := []string{"asm_outputs", "asm_inputs",
				"asm_clobbers", "asm_labels"}
			kind := ""
			if idx >= 0 && idx < len(kindMap) {
				kind = kindMap[idx]
				child["kind"] = kind
			}
			pushKids(node, child)
			r.K["sectionIdx"] = idx + 1
			r.K["lastWasColon"] = false
			takenSet(r, "takenSecs")[r.Child] = true
		}
	})

	// ---- asm_template ------------------------------------------------
	state("@asm_template-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("asm_template", nil)
	})
	state("@asm_template-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childIsExpr(r) && !sameNode(childNode(r), ruleNode(r)) && !uBool(r, "exprAttached") {
			pushKids(ruleNode(r), childNode(r))
			r.U["exprAttached"] = true
		}
	})

	// ---- asm_section -------------------------------------------------
	state("@asm_section-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["asecNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("asm_section", nil)
		r.K["asecNode"] = r.Node
		r.K["asecOpened"] = false
		delete(r.K, "takenItems")
	})
	// The needs-* conds peek t0 to decide whether to dispatch a
	// sub-rule. They have no side effects (jsonic may re-evaluate
	// alts). The dispatch only fires when (a) the parent section
	// index matches the kind and (b) t0 is a valid head for an item
	// of that kind. On empty section / past-last-item, t0 is `:` or
	// `)` and all needs-* return false; the open's s:[] fallback
	// exits the rule cleanly.
	cond("@asec-operands", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		idx, ok := asmSectionIndex(r)
		return ok && (idx == 0 || idx == 1)
	})
	cond("@asec-clobbers", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		idx, ok := asmSectionIndex(r)
		return ok && idx == 2
	})
	cond("@asec-labels", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		idx, ok := asmSectionIndex(r)
		return ok && idx == 3
	})
	action("@asec-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@asm_section-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childNode(r) == nil {
			return
		}
		switch childName(r) {
		case "asm_operand", "asm_clobber", "asm_label_ref":
			if !takenHas(r, "takenItems") {
				pushKids(ruleNode(r), childNode(r))
				takenSet(r, "takenItems")[r.Child] = true
			}
		}
	})

	// ---- asm_operand ---------------------------------------------------
	state("@asm_operand-bo", func(r *tabnas.Rule, ctx *tabnas.Context) {
		r.Node = makeNode("asm_operand", nil)
		// The operand catches a failure below it (fallback.go).
		r.U["scope"] = openLocal(ctx)
	})
	cond("@aop-failed", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		sc, _ := r.U["scope"].(*LocalScope)
		return sc != nil && sc.Failed
	})
	// The structured parts could not read the operand: its tokens so far,
	// flat, and asm_operand_rest takes the rest.
	action("@aop-flatten", func(r *tabnas.Rule, ctx *tabnas.Context) {
		sc, _ := r.U["scope"].(*LocalScope)
		if sc == nil {
			return
		}
		toks := tokensSince(ctx, sc.VAbs)
		node := ruleNode(r)
		node["children"] = []any{}
		for _, t := range toks {
			pushTokenWithTrivia(node, t)
		}
		r.K["aorDepth"] = bracketDepth(toks)
		closeLocal(ctx, sc)
	})
	cond("@aop-needs-constraint", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !uBool(r, "constraint") && !uBool(r, "value")
	})
	cond("@aop-needs-value", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !uBool(r, "value")
	})
	action("@aop-end", func(r *tabnas.Rule, ctx *tabnas.Context) {
		sc, _ := r.U["scope"].(*LocalScope)
		closeLocal(ctx, sc)
	})
	// Tokens after the parts: the rest of the operand, flat.
	action("@aop-trailing", func(r *tabnas.Rule, ctx *tabnas.Context) {
		sc, _ := r.U["scope"].(*LocalScope)
		if sc == nil {
			return
		}
		r.K["aorDepth"] = bracketDepth(tokensSince(ctx, sc.VAbs))
		closeLocal(ctx, sc)
	})
	state("@asm_operand-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := r.Child
		if child == nil || child == tabnas.NoRule || childNode(r) == nil {
			return
		}
		if last, _ := r.U["lastChild"].(*tabnas.Rule); last == child {
			return
		}
		part := map[string]string{
			"asm_name": "name", "asm_constraint": "constraint", "asm_value": "value",
		}
		key, ok := part[child.Name]
		if !ok {
			return
		}
		appendChild(ruleNode(r), childNode(r))
		r.U[key] = true
		r.U["lastChild"] = child
	})

	// ---- asm_operand_rest ------------------------------------------------
	cond("@aor-stop", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return intOr(r.K["aorDepth"], 0) == 0
	})
	action("@aor-end", func(r *tabnas.Rule, _ *tabnas.Context) { r.U["ended"] = true })
	cond("@aor-ended", func(r *tabnas.Rule, _ *tabnas.Context) bool { return uBool(r, "ended") })
	action("@aor-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		pushTokenWithTrivia(ruleNode(r), tkn)
		switch tkn.Name {
		case "PUNC_LPAREN", "PUNC_LBRACKET":
			r.K["aorDepth"] = intOr(r.K["aorDepth"], 0) + 1
		case "PUNC_RPAREN", "PUNC_RBRACKET":
			r.K["aorDepth"] = intOr(r.K["aorDepth"], 0) - 1
		}
	})

	// ---- asm_name, asm_constraint, asm_value ------------------------------
	state("@asm_name-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("asm_name", nil)
	})
	action("@aname-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		pushTokenWithTrivia(node, r.O0)
		pushTokenWithTrivia(node, r.O1)
		if len(r.O) > 2 {
			pushTokenWithTrivia(node, r.O[2])
		}
	})
	state("@asm_constraint-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("asm_constraint", nil)
	})
	action("@acon-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["value"] = tkn.Src
	})
	state("@asm_value-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("asm_value", nil)
	})
	action("@aval-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	state("@asm_value-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childIsExpr(r) && !sameNode(childNode(r), ruleNode(r)) && !uBool(r, "exprAttached") {
			appendChild(ruleNode(r), childNode(r))
			r.U["exprAttached"] = true
		}
	})
	action("@aval-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})

	// ---- asm_clobber -------------------------------------------------
	state("@asm_clobber-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("asm_clobber", nil)
	})
	action("@acl-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["value"] = tkn.Src
	})

	// ---- asm_label_ref -----------------------------------------------
	state("@asm_label_ref-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("asm_label_ref", nil)
	})
	action("@alr-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["labelName"] = tkn.Src
	})

	// ==================================================================
	// attribute_spec_gcc (phase G.2)
	//
	// `__attribute__ (( <items> ))` — state machine across r:-recursion
	// via rule.k: kwTaken → outerLparen → innerLparen → item/comma loop
	// → innerRparen → outerRparen.
	// ==================================================================
	state("@attribute_spec_gcc-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["asgNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("attribute_spec", nil)
		node["attributeForm"] = "gcc"
		r.K["asgNode"] = node
		r.Node = node
	})
	cond("@asg-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asgKwTaken")
	})
	action("@asg-take-kw", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["asgKwTaken"] = true
	})
	cond("@asg-need-outer-lparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asgKwTaken") && !kBool(r, "asgOuterLparen")
	})
	action("@asg-take-outer-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["asgOuterLparen"] = true
	})
	cond("@asg-need-inner-lparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asgOuterLparen") && !kBool(r, "asgInnerLparen")
	})
	action("@asg-take-inner-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["asgInnerLparen"] = true
	})
	cond("@asg-need-comma", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asgInnerLparen") && kBool(r, "asgLastWasItem") &&
			!kBool(r, "asgInnerRparen")
	})
	action("@asg-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["asgLastWasItem"] = false
	})
	cond("@asg-need-item", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asgInnerLparen") && !kBool(r, "asgLastWasItem") &&
			!kBool(r, "asgInnerRparen")
	})
	cond("@asg-need-inner-rparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asgInnerLparen") && !kBool(r, "asgInnerRparen")
	})
	action("@asg-take-inner-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["asgInnerRparen"] = true
	})
	cond("@asg-need-outer-rparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asgInnerRparen") && !kBool(r, "asgOuterRparen")
	})
	action("@asg-take-outer-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["asgOuterRparen"] = true
	})
	state("@attribute_spec_gcc-bc", attrSpecTakeItem("asgLastWasItem"))

	// ==================================================================
	// attribute_spec_msvc (phase G.3): `__declspec ( <items> )`
	// ==================================================================
	state("@attribute_spec_msvc-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["asm2Node"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("attribute_spec", nil)
		node["attributeForm"] = "msvc"
		r.K["asm2Node"] = node
		r.Node = node
	})
	cond("@asm2-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asm2KwTaken")
	})
	action("@asm2-take-kw", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["asm2KwTaken"] = true
	})
	cond("@asm2-need-lparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asm2KwTaken") && !kBool(r, "asm2Lparen")
	})
	action("@asm2-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["asm2Lparen"] = true
	})
	cond("@asm2-need-comma", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asm2Lparen") && kBool(r, "asm2LastWasItem") &&
			!kBool(r, "asm2Rparen")
	})
	action("@asm2-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["asm2LastWasItem"] = false
	})
	cond("@asm2-need-item", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asm2Lparen") && !kBool(r, "asm2LastWasItem") &&
			!kBool(r, "asm2Rparen")
	})
	cond("@asm2-need-rparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "asm2Lparen") && !kBool(r, "asm2Rparen")
	})
	action("@asm2-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["asm2Rparen"] = true
	})
	state("@attribute_spec_msvc-bc", attrSpecTakeItem("asm2LastWasItem"))

	// ==================================================================
	// attribute_spec_c23 (phase G.1): `[[ <items> ]]`
	//
	// Adjacency conds use the Token's sI/src-length to ensure two `[`
	// (or `]`) are physically adjacent in the source — this is what
	// distinguishes `[[…]]` from a nested array subscript `[ [x] ]`.
	// ==================================================================
	cond("@as23-adjacent-open", func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		a := ctxTokAt(ctx, 0)
		b := ctxTokAt(ctx, 1)
		return a != nil && b != nil && a.SI+len(a.Src) == b.SI
	})
	cond("@as23-adjacent-close", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		a, b := r.C0, r.C1
		return a != nil && b != nil && a.SI+len(a.Src) == b.SI
	})
	state("@attribute_spec_c23-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["as23Node"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("attribute_spec", nil)
		node["attributeForm"] = "c23"
		r.K["as23Node"] = node
		r.Node = node
	})
	cond("@as23-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "as23Open")
	})
	action("@as23-take-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		pushTokenWithTrivia(ruleNode(r), r.O1)
		r.K["as23Open"] = true
	})
	cond("@as23-need-comma", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "as23Open") && kBool(r, "as23LastWasItem") &&
			!kBool(r, "as23Closed")
	})
	action("@as23-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["as23LastWasItem"] = false
	})
	cond("@as23-need-item", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "as23Open") && !kBool(r, "as23LastWasItem") &&
			!kBool(r, "as23Closed")
	})
	cond("@as23-need-close", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "as23Open") && !kBool(r, "as23Closed")
	})
	action("@as23-take-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		pushTokenWithTrivia(ruleNode(r), r.C1)
		r.K["as23Closed"] = true
	})
	state("@attribute_spec_c23-bc", attrSpecTakeItem("as23LastWasItem"))

	// ==================================================================
	// attribute_item (phase G.4): name (optional `::` namespace) plus
	// optional argument list.
	// ==================================================================
	state("@attribute_item-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["aiNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("attribute_item", nil)
		r.K["aiNode"] = r.Node
	})
	cond("@ai-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "aiNameTaken")
	})
	action("@ai-take-name", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["attributeName"] = tkn.Src
		r.K["aiNameTaken"] = true
	})
	cond("@ai-need-colon-1", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		// The alt's `s: 'PUNC_COLON PUNC_COLON'` ensures both colons
		// are physically present (parse_alts force-fetches both); the
		// cond just gates by rule state.
		return kBool(r, "aiNameTaken") && !kBool(r, "aiPrefixed")
	})
	action("@ai-take-colon-1", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["aiColon1"] = true
	})
	cond("@ai-need-colon-2", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "aiColon1") && !kBool(r, "aiColon2")
	})
	action("@ai-take-colon-2", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["aiColon2"] = true
	})
	cond("@ai-need-prefixed-name", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "aiColon2") && !kBool(r, "aiPrefixed")
	})
	action("@ai-take-prefixed-name", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["attributePrefix"] = node["attributeName"]
		node["attributeName"] = tkn.Src
		r.K["aiPrefixed"] = true
	})
	cond("@ai-need-args", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "aiNameTaken") && !kBool(r, "aiArgsTaken")
	})
	state("@attribute_item-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "attribute_argument_list" && childNode(r) != nil &&
			!kBool(r, "aiArgsTaken") {
			node := ruleNode(r)
			pushKids(node, childNode(r))
			r.K["aiArgsTaken"] = true
		}
	})

	// ---- attribute_argument_list (phase G.4) --------------------------
	state("@attribute_argument_list-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["aalNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("attribute_argument_list", nil)
		r.K["aalNode"] = r.Node
	})
	cond("@aal-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "aalLparen")
	})
	action("@aal-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["aalLparen"] = true
	})
	action("@aal-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@aal-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@attribute_argument_list-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childIsExpr(r) &&
			!sameNode(childNode(r), ruleNode(r)) && !takenHas(r, "takenArgs") {
			pushKids(ruleNode(r), childNode(r))
			takenSet(r, "takenArgs")[r.Child] = true
		}
	})

	// ==================================================================
	// static_assert_declaration (phase I.1 / phase O)
	//
	// `static_assert ( <cond> (, <message>)? ) ;` — state machine
	// across r:-recursion via rule.k: saKwTaken → saLparen →
	// saCondTaken → saComma → saMsgTaken → saRparen → saSemi.
	// ==================================================================
	state("@static_assert_declaration-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["saNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("static_assert_declaration", nil)
		r.K["saNode"] = node
		r.Node = node
	})
	cond("@said-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "saKwTaken")
	})
	action("@said-take-kw", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["saKwTaken"] = true
	})
	cond("@said-need-lparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "saKwTaken") && !kBool(r, "saLparen")
	})
	action("@said-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["saLparen"] = true
		// Phase O: suppress comma-op while parsing the cond / msg vals
		// so the `,` separator lands as a static_assert separator
		// rather than being absorbed by C_OP_TABLE['comma'] in
		// @jsonic/expr's Pratt loop.
		r.N["no_comma_op"] = r.N["no_comma_op"] + 1
	})
	cond("@said-need-cond", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "saLparen") && !kBool(r, "saCondTaken")
	})
	action("@said-mark-cond", func(_ *tabnas.Rule, _ *tabnas.Context) {
		// Cond will be picked up via -bc on val return.
	})
	cond("@said-need-comma", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "saCondTaken") && !kBool(r, "saComma") &&
			!kBool(r, "saRparen")
	})
	action("@said-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["saComma"] = true
	})
	cond("@said-need-msg", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "saComma") && !kBool(r, "saMsgTaken")
	})
	action("@said-mark-msg", func(_ *tabnas.Rule, _ *tabnas.Context) {
		// Msg picked up via -bc.
	})
	cond("@said-need-rparen", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "saCondTaken") && !kBool(r, "saRparen")
	})
	action("@said-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["saRparen"] = true
	})
	cond("@said-need-semi", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "saRparen") && !kBool(r, "saSemi")
	})
	action("@said-take-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["saSemi"] = true
	})
	state("@static_assert_declaration-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if !childIsExpr(r) || sameNode(childNode(r), ruleNode(r)) {
			return
		}
		node := ruleNode(r)
		if !kBool(r, "saCondTaken") {
			pushKids(node, childNode(r))
			r.K["saCondTaken"] = true
		} else if kBool(r, "saComma") && !kBool(r, "saMsgTaken") {
			pushKids(node, childNode(r))
			r.K["saMsgTaken"] = true
		}
	})
}

// attrSpecTakeItem returns the shared -bc handler for the three
// attribute_spec_* forms: attach a returned attribute_item onto the spec
// node's children, and mark lastWasItem via the given k key.
func attrSpecTakeItem(lastWasItemKey string) tabnas.StateAction {
	return func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) != "attribute_item" || childNode(r) == nil ||
			takenHas(r, "takenItems") {
			return
		}
		node := ruleNode(r)
		pushKids(node, childNode(r))
		r.K[lastWasItemKey] = true
		takenSet(r, "takenItems")[r.Child] = true
	}
}

// asmSectionIndex is which of an asm statement's sections an asm_section
// rule reads: 0 outputs, 1 inputs, 2 clobbers, 3 labels.
func asmSectionIndex(r *tabnas.Rule) (int, bool) {
	parent := parentRule(r)
	if parent == nil || parent.K == nil {
		return 0, false
	}
	v, ok := parent.K["sectionIdx"]
	if !ok {
		return 0, false
	}
	return intOr(v, 0), true
}
