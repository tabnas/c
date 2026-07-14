/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// registerNewPathRefs binds all new-path structured-dispatch handlers onto the
// ref map via the provided cond/action/state registrars. Called from
// makeGrammarRefs. Port of the c.ts makeGrammarRefs region (~2630-5440).
func registerNewPathRefs(g regFns, extended bool) {
	cond, action, state := g.cond, g.action, g.state

	// ---- dispatch gates --------------------------------------------------
	cond("@plain-and-first-iter", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !extended && len(kTokens(r)) == 0
	})
	cond("@plain-as23-and-first", func(r *tabnas.Rule, ctx *tabnas.Context) bool {
		if extended {
			return false
		}
		if len(kTokens(r)) > 0 {
			return false
		}
		a := ctxTokAt(ctx, 0)
		b := ctxTokAt(ctx, 1)
		return a != nil && b != nil && a.SI+len(a.Src) == b.SI
	})
	cond("@looks-simple-decl", func(r *tabnas.Rule, ctx *tabnas.Context) bool {
		return looksSimpleDecl(r, ctx)
	})

	registerDeclRefs(cond, action, state)
	registerStructEnumRefs(cond, action, state)
	registerInitializerRefs(cond, action, state)
	registerStatementRefs(cond, action, state)
	registerExprSupportRefs(cond, action, state)
}

// ---- declarations & declarators ----------------------------------------

func registerDeclRefs(
	cond func(string, tabnas.AltCond),
	action func(string, tabnas.AltAction),
	state func(string, tabnas.StateAction),
) {
	// ---- simple_declaration ----
	state("@simple_declaration-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := makeNode("declaration", nil)
		node["declKind"] = "declaration"
		r.Node = node
		r.U["specs"] = makeNode("declaration_specifiers", nil)
		r.U["idl"] = makeNode("init_declarator_list", nil)
		for _, k := range []string{
			"ssNode", "ssKwTaken", "ssTagTaken", "ssBodyTaken",
			"esNode", "esKwTaken", "esTagTaken", "esUtypeTaken",
			"esBodyTaken", "esUtypeAttached",
			"elNode", "elOpened", "takenEnums",
			"mdlNode", "mdlOpened", "takenSecs", "takenItems",
			"ilNode", "ilOpened", "iiNode", "hasDesig", "tookEq",
			"declarator", "directDeclarator", "lastPointer",
		} {
			delete(r.K, k)
		}
		clearStmtState(r)
	})

	action("@absorb-spec-storage", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := specOwnerRule(r)
		tkn := r.O0
		pushTokenWithTrivia(uNode(owner, "specs"), tkn)
		if tkn.Name == "KW_TYPEDEF" {
			owner.EnsureU()["isTypedef"] = true
		}
	})
	action("@absorb-spec-type", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := specOwnerRule(r)
		pushTokenWithTrivia(uNode(owner, "specs"), r.O0)
	})

	// ---- bit_int_paren ----
	action("@bip-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := specOwnerRule(r)
		if specs := uNode(owner, "specs"); specs != nil {
			pushTokenWithTrivia(specs, r.O0)
		}
	})
	action("@bip-mark-val", func(_ *tabnas.Rule, _ *tabnas.Context) {})
	state("@bit_int_paren-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if kBool(r, "bipValAttached") {
			return
		}
		if childName(r) == "val" && childNode(r) != nil {
			owner := specOwnerRule(r)
			if specs := uNode(owner, "specs"); specs != nil {
				pushKids(specs, childNode(r))
				r.K["bipValAttached"] = true
			}
		}
	})
	action("@bip-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := specOwnerRule(r)
		if specs := uNode(owner, "specs"); specs != nil {
			pushTokenWithTrivia(specs, r.C0)
		}
	})

	action("@simple-decl-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(uNode(r, "idl"), r.C0)
	})

	// ---- init_declarator ----
	state("@init_declarator-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "init_declarator" {
			return
		}
		r.Node = makeNode("init_declarator", nil)
		r.K["declarator"] = makeNode("declarator", nil)
		r.K["directDeclarator"] = makeNode("direct_declarator", nil)
	})
	action("@idecl-name", func(r *tabnas.Rule, _ *tabnas.Context) {
		idTkn := stateTokOC(r)
		dd := kNode(r, "directDeclarator")
		decl := kNode(r, "declarator")
		node := ruleNode(r)
		pushTokenWithTrivia(dd, idTkn)
		dd["declaredName"] = idTkn.Src
		pushKids(decl, dd)
		decl["declaredName"] = idTkn.Src
		pushKids(node, decl)
		node["declaredName"] = idTkn.Src
		r.K["named"] = true
	})
	cond("@idecl-named", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "named")
	})
	action("@idecl-paren-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		lparen := r.O0
		dd := kNode(r, "directDeclarator")
		decl := kNode(r, "declarator")
		node := ruleNode(r)
		pushTokenWithTrivia(dd, lparen)
		pushKids(decl, dd)
		pushKids(node, decl)
		r.K["idclParenPending"] = true
	})
	cond("@idecl-paren-pending", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "idclParenPending") && !kBool(r, "parenClosed")
	})
	action("@idecl-paren-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(kNode(r, "directDeclarator"), r.C0)
		r.K["parenClosed"] = true
		r.K["named"] = true
	})

	// ---- paren_inner_declarator ----
	state("@paren_inner_declarator-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if kBool(r, "pidInit") {
			return
		}
		r.K["pidInit"] = true
		r.K["declarator"] = makeNode("declarator", nil)
		r.K["directDeclarator"] = makeNode("direct_declarator", nil)
	})
	cond("@pid-named", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "named")
	})
	action("@pid-name", func(r *tabnas.Rule, _ *tabnas.Context) {
		idTkn := stateTokOC(r)
		dd := kNode(r, "directDeclarator")
		decl := kNode(r, "declarator")
		pushTokenWithTrivia(dd, idTkn)
		dd["declaredName"] = idTkn.Src
		pushKids(decl, dd)
		decl["declaredName"] = idTkn.Src
		r.K["named"] = true
		if !kBool(r, "attached") {
			outer := parentRule(r) // init_declarator
			outerDD := kNode(outer, "directDeclarator")
			pushKids(outerDD, decl)
			outerDD["declaredName"] = idTkn.Src
			kNode(outer, "declarator")["declaredName"] = idTkn.Src
			ruleNode(outer)["declaredName"] = idTkn.Src
			r.K["attached"] = true
		}
	})

	// ---- pointer ----
	action("@absorb-pointer", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := parentRule(r) // init_declarator
		ptr := makeNode("pointer", nil)
		pushTokenWithTrivia(ptr, r.O0)
		pushKids(kNode(owner, "declarator"), ptr)
		r.K["lastPointer"] = ptr
	})
	action("@absorb-pq-const", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := parentRule(r) // pointer_list
		if owner == nil {
			return
		}
		if ptr, ok := owner.K["lastPointer"].(CNode); ok {
			pushTokenWithTrivia(ptr, r.O0)
		}
	})

	// ---- array_postfix ----
	state("@array_postfix-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("array_postfix", nil)
	})
	action("@arr-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	action("@arr-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		owner := parentRule(r)
		if dd := kNode(owner, "directDeclarator"); dd != nil {
			pushKids(dd, ruleNode(r))
		} else if decl := kNode(owner, "declarator"); decl != nil {
			pushKids(decl, ruleNode(r))
		}
	})
	state("@array_postfix-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "val" && childNode(r) != nil && uNode(r, "size") == nil {
			pushKids(ruleNode(r), childNode(r))
			r.U["size"] = childNode(r)
		}
	})

	// ---- function_postfix ----
	state("@function_postfix-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("function_postfix", nil)
		r.K["ptl"] = makeNode("parameter_type_list", nil)
	})
	action("@fn-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	action("@fn-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		owner := parentRule(r)
		if owner != nil {
			if dd, ok := owner.K["directDeclarator"].(CNode); ok {
				pushKids(dd, ruleNode(r))
			}
		}
	})
	action("@ptl-attach-and-end", func(r *tabnas.Rule, _ *tabnas.Context) {
		fn := parentRule(r) // function_postfix
		if ptl := kNode(fn, "ptl"); ptl != nil && len(kidsOf(ptl)) > 0 {
			pushKids(ruleNode(fn), ptl)
		}
	})
	action("@ptl-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		fn := parentRule(r)
		pushTokenWithTrivia(kNode(fn, "ptl"), r.C0)
	})

	// ---- identifier_list ----
	state("@identifier_list-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "identifier_list" {
			return
		}
		r.Node = makeNode("identifier_list", nil)
	})
	action("@idlist-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), stateTokCO(r))
	})
	action("@idlist-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@idlist-attach", func(r *tabnas.Rule, _ *tabnas.Context) {
		fn := parentRule(r)
		if fn != nil && ruleNode(fn) != nil && ruleNode(r) != nil {
			pushKids(ruleNode(fn), ruleNode(r))
		}
	})
	action("@ptl-take-ellipsis", func(r *tabnas.Rule, _ *tabnas.Context) {
		fn := parentRule(r)
		ptl := kNode(fn, "ptl")
		pushTokenWithTrivia(ptl, r.C0)
		pv := makeNode("parameter_variadic", nil)
		pushTokenWithTrivia(pv, r.C1)
		pushKids(ptl, pv)
		ptl["variadic"] = true
		if len(kidsOf(ptl)) > 0 {
			pushKids(ruleNode(fn), ptl)
		}
	})

	// ---- parameter_declaration ----
	state("@parameter_declaration-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n := ruleNode(r); n != nil && n["kind"] == "parameter_declaration" {
			return
		}
		r.Node = makeNode("parameter_declaration", nil)
		r.K["specs"] = makeNode("declaration_specifiers", nil)
		delete(r.K, "declarator")
		delete(r.K, "directDeclarator")
		r.K["assembled"] = false
		r.K["named"] = false
	})
	cond("@param-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kNode(r, "declarator") != nil
	})
	action("@param-spec", func(r *tabnas.Rule, _ *tabnas.Context) {
		var owner *tabnas.Rule
		if r.Name == "parameter_declaration" {
			owner = r
		} else {
			owner = parentRule(r)
		}
		pushTokenWithTrivia(kNode(owner, "specs"), r.O0)
	})
	action("@param-name", func(r *tabnas.Rule, _ *tabnas.Context) {
		idTkn := r.C0
		node := ruleNode(r)
		node["declaredName"] = idTkn.Src
		if decl := kNode(r, "declarator"); decl != nil {
			dd := makeNode("direct_declarator", nil)
			pushTokenWithTrivia(dd, idTkn)
			dd["declaredName"] = idTkn.Src
			pushKids(decl, dd)
			decl["declaredName"] = idTkn.Src
		} else {
			decl := makeNode("declarator", nil)
			dd := makeNode("direct_declarator", nil)
			pushTokenWithTrivia(dd, idTkn)
			dd["declaredName"] = idTkn.Src
			pushKids(decl, dd)
			decl["declaredName"] = idTkn.Src
			r.K["declarator"] = decl
		}
	})
	action("@param-pointer", func(r *tabnas.Rule, _ *tabnas.Context) {
		if kNode(r, "declarator") == nil {
			r.K["declarator"] = makeNode("declarator", nil)
		}
		ptr := makeNode("pointer", nil)
		pushTokenWithTrivia(ptr, r.C0)
		pushKids(kNode(r, "declarator"), ptr)
	})
	action("@param-paren-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		if kNode(r, "declarator") == nil {
			r.K["declarator"] = makeNode("declarator", nil)
		}
		pushTokenWithTrivia(kNode(r, "declarator"), r.C0)
		r.K["paramParenPending"] = true
	})
	cond("@param-paren-pending", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "paramParenPending")
	})
	cond("@param-can-paren-form", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "paramParenDone") && !kBool(r, "paramParenPending")
	})
	action("@param-paren-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		if kNode(r, "declarator") == nil {
			return
		}
		pushTokenWithTrivia(kNode(r, "declarator"), r.C0)
		r.K["paramParenPending"] = false
		r.K["paramParenDone"] = true
	})
	cond("@param-need-fn-postfix", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "paramParenDone") && !kBool(r, "paramFnPostfixDone")
	})

	// ---- param_paren_inner ----
	cond("@ppi-named", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "ppiNamed")
	})
	action("@ppi-pointer", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := parentRule(r) // parameter_declaration
		if kNode(owner, "declarator") == nil {
			owner.EnsureK()["declarator"] = makeNode("declarator", nil)
		}
		ptr := makeNode("pointer", nil)
		pushTokenWithTrivia(ptr, r.C0)
		pushKids(kNode(owner, "declarator"), ptr)
	})
	action("@ppi-name", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := parentRule(r) // parameter_declaration
		idTkn := stateTokCO(r)
		if kNode(owner, "declarator") == nil {
			owner.EnsureK()["declarator"] = makeNode("declarator", nil)
		}
		decl := kNode(owner, "declarator")
		dd := makeNode("direct_declarator", nil)
		pushTokenWithTrivia(dd, idTkn)
		dd["declaredName"] = idTkn.Src
		pushKids(decl, dd)
		decl["declaredName"] = idTkn.Src
		ruleNode(owner)["declaredName"] = idTkn.Src
		r.K["ppiNamed"] = true
	})
	state("@parameter_declaration-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		if !kBool(r, "specsAttached") {
			pushKids(node, kNode(r, "specs"))
			r.K["specsAttached"] = true
		}
		if !kBool(r, "declAttached") && kNode(r, "declarator") != nil {
			pushKids(node, kNode(r, "declarator"))
			r.K["declAttached"] = true
		}
		if !kBool(r, "ptlAttached") {
			ptl := parentRule(r)
			if ptl != nil && ptl.Name == "parameter_type_list" {
				fn := parentRule(ptl)
				if fn != nil {
					if fnPtl, ok := fn.K["ptl"].(CNode); ok && node != nil {
						pushKids(fnPtl, node)
						r.K["ptlAttached"] = true
					}
				}
			}
		}
	})

	// ---- init_declarator initializer ----
	action("@idecl-take-eq", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.U["eqTrivia"] = leadingTriviaRefs(r.C0)
		r.U["eqTokenRef"] = tokenRef(r.C0)
		r.U["hasInit"] = true
	})
	state("@init_declarator-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if uBool(r, "hasInit") && childNode(r) != nil {
			initNode := childNode(r)
			if initNode["kind"] != "initializer" {
				wrapped := makeNode("initializer", nil)
				pushKids(wrapped, initNode)
				initNode = wrapped
			}
			node := ruleNode(r)
			if tr, ok := r.U["eqTrivia"].([]any); ok {
				for _, t := range tr {
					pushKids(node, t)
				}
			}
			pushKids(node, r.U["eqTokenRef"])
			pushKids(node, initNode)
		}
	})

	// ---- initializer wrapper ----
	state("@initializer-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("initializer", nil)
	})
	state("@initializer-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childNode(r) != nil {
			pushKids(ruleNode(r), childNode(r))
		}
	})

	// ---- simple_declaration bc / finalize ----
	state("@simple_declaration-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		switch childName(r) {
		case "init_declarator":
			if cn != nil && cn["kind"] == "init_declarator" {
				pushKids(uNode(r, "idl"), cn)
				if dn, ok := cn["declaredName"].(string); ok && dn != "" {
					names, _ := r.U["declaredNames"].([]any)
					r.U["declaredNames"] = append(names, dn)
					if _, ok := r.U["declaredName"]; !ok {
						r.U["declaredName"] = dn
					}
				}
			}
		case "struct_specifier", "enum_specifier":
			if cn != nil && !uBool(r, "taggedSpecAttached") {
				pushKids(uNode(r, "specs"), cn)
				r.U["taggedSpecAttached"] = true
			}
		case "compound_statement":
			if cn != nil && cn["kind"] == "compound_statement" && uNode(r, "fnBody") == nil {
				r.U["fnBody"] = cn
			}
		}
	})
	action("@simple-decl-finalize", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		pushKids(node, uNode(r, "specs"))
		if idl := uNode(r, "idl"); idl != nil && len(kidsOf(idl)) > 0 {
			pushKids(node, idl)
		}
		pushTokenWithTrivia(node, r.C0)
	})

	// ---- function definition ----
	action("@simple-decl-start-fn-body", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.U["startedFnBody"] = true
	})
	cond("@fn-body-done", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return uNode(r, "fnBody") != nil && !uBool(r, "fnDefDone")
	})
	action("@simple-decl-finalize-fn", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.U["fnDefDone"] = true
		node := ruleNode(r)
		node["declKind"] = "function_definition"
		pushKids(node, uNode(r, "specs"))
		idl := uNode(r, "idl")
		if idl != nil && len(kidsOf(idl)) > 0 {
			firstId, _ := kidsOf(idl)[0].(CNode)
			if firstId != nil && firstId["kind"] == "init_declarator" {
				fk := kidsOf(firstId)
				if len(fk) > 0 {
					if decl, ok := fk[0].(CNode); ok && decl["kind"] == "declarator" {
						pushKids(node, decl)
					}
				}
			}
		}
		pushKids(node, uNode(r, "fnBody"))
	})

	// ---- spec_loop tagged-specifier relay ----
	state("@spec_loop-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		switch childName(r) {
		case "struct_specifier", "enum_specifier",
			"attribute_spec_gcc", "attribute_spec_msvc", "attribute_spec_c23":
			if !takenHas(r, "takenTagged") {
				owner := specOwnerRule(r)
				if specs := uNode(owner, "specs"); specs != nil {
					pushKids(specs, cn)
					takenSet(r, "takenTagged")[r.Child] = true
				}
			}
		}
	})
}
