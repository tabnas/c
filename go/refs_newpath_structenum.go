/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// registerStructEnumRefs binds struct/union/enum + member/bitfield/enumerator
// handlers. Port of the c.ts phase F refs.
func registerStructEnumRefs(
	cond func(string, tabnas.AltCond),
	action func(string, tabnas.AltAction),
	state func(string, tabnas.StateAction),
) {
	// ---- struct_specifier / union_specifier ----
	state("@struct_specifier-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "ssNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("struct_specifier", nil)
		r.K["ssNode"] = r.Node
		r.K["ssTagTaken"] = false
		r.K["ssBodyTaken"] = false
	})
	cond("@ss-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "ssKwTaken")
	})
	action("@ss-take-kw", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := ruleNode(r)
		if tkn.Name == "KW_UNION" {
			node["kind"] = "union_specifier"
		} else {
			node["kind"] = "struct_specifier"
		}
		pushTokenWithTrivia(node, tkn)
		r.K["ssKwTaken"] = true
	})
	cond("@ss-need-tag", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "ssKwTaken") && !kBool(r, "ssTagTaken") && !kBool(r, "ssBodyTaken")
	})
	action("@ss-take-tag", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["tagName"] = tkn.Src
		r.K["ssTagTaken"] = true
	})
	cond("@ss-need-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "ssKwTaken") && !kBool(r, "ssBodyTaken")
	})
	state("@struct_specifier-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "member_decl_list" && childNode(r) != nil && !kBool(r, "ssBodyTaken") {
			pushKids(ruleNode(r), childNode(r))
			r.K["ssBodyTaken"] = true
		}
	})

	// ---- member_decl_list ----
	state("@member_decl_list-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "mdlNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("member_decl_list", nil)
		r.K["mdlNode"] = r.Node
		r.K["mdlOpened"] = false
	})
	cond("@mdl-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "mdlOpened")
	})
	action("@mdl-take-lbrace", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["mdlOpened"] = true
	})
	action("@mdl-take-rbrace", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@mdl-take-empty-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@member_decl_list-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "struct_declaration" && childNode(r) != nil &&
			!takenHas(r, "takenMembers") {
			pushKids(ruleNode(r), childNode(r))
			takenSet(r, "takenMembers")[r.Child] = true
		}
	})

	// ---- struct_declaration ----
	state("@struct_declaration-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "sdNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("struct_declaration", nil)
		r.U["specs"] = makeNode("specifier_qualifier_list", nil)
		r.U["sdl"] = makeNode("struct_declarator_list", nil)
		r.K["sdNode"] = r.Node
	})
	cond("@sd-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "sdSpecsAttached")
	})
	action("@sd-absorb-spec-storage", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := specOwnerRule(r)
		pushTokenWithTrivia(uNode(owner, "specs"), r.O0)
	})
	action("@sd-absorb-spec-type", func(r *tabnas.Rule, _ *tabnas.Context) {
		owner := specOwnerRule(r)
		pushTokenWithTrivia(uNode(owner, "specs"), r.O0)
	})
	cond("@sd-need-decl-first", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !kBool(r, "sdAnyDecl")
	})
	action("@sd-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(uNode(r, "sdl"), r.C0)
	})
	action("@sd-take-semi", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		if !kBool(r, "sdSpecsAttached") {
			pushKids(node, uNode(r, "specs"))
			r.K["sdSpecsAttached"] = true
		}
		if sdl := uNode(r, "sdl"); len(kidsOf(sdl)) > 0 && !kBool(r, "sdSdlAttached") {
			pushKids(node, sdl)
			r.K["sdSdlAttached"] = true
		}
		pushTokenWithTrivia(node, r.C0)
	})
	state("@struct_declaration-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "struct_declarator" && childNode(r) != nil &&
			!takenHas(r, "takenSdrs") {
			pushKids(uNode(r, "sdl"), childNode(r))
			r.K["sdAnyDecl"] = true
			takenSet(r, "takenSdrs")[r.Child] = true
		}
	})

	// ---- struct_declarator ----
	state("@struct_declarator-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "sdrNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("struct_declarator", nil)
		r.K["sdrNode"] = r.Node
	})
	cond("@sdr-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "sdrDeclTaken")
	})
	action("@sdr-mark-anon-bf", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.K["sdrAnonBf"] = true
	})
	cond("@sdr-need-bf", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "sdrDeclTaken") && !kBool(r, "sdrBfTaken")
	})
	state("@struct_declarator-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		switch childName(r) {
		case "init_declarator":
			if !kBool(r, "sdrDeclTaken") {
				var decl CNode
				for _, c := range kidsOf(cn) {
					if cm, ok := c.(CNode); ok && cm["kind"] == "declarator" {
						decl = cm
						break
					}
				}
				if decl != nil {
					pushKids(ruleNode(r), decl)
					if dn, ok := cn["declaredName"].(string); ok && dn != "" {
						ruleNode(r)["declaredName"] = dn
					}
				}
				r.K["sdrDeclTaken"] = true
			}
		case "bitfield_width":
			if !kBool(r, "sdrBfTaken") {
				pushKids(ruleNode(r), cn)
				r.K["sdrBfTaken"] = true
			}
		}
	})

	// ---- bitfield_width ----
	state("@bitfield_width-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("bitfield_width", nil)
	})
	action("@bfw-take-colon", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	state("@bitfield_width-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "val" && childNode(r) != nil &&
			!sameNode(childNode(r), ruleNode(r)) && !kBool(r, "bfExprAttached") {
			pushKids(ruleNode(r), childNode(r))
			r.K["bfExprAttached"] = true
		}
	})

	// ---- enum_specifier ----
	state("@enum_specifier-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "esNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("enum_specifier", nil)
		r.K["esNode"] = r.Node
	})
	cond("@es-tag-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "esKwTaken")
	})
	action("@es-take-kw", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["esKwTaken"] = true
	})
	cond("@es-need-tag", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "esKwTaken") && !kBool(r, "esTagTaken") &&
			!kBool(r, "esUtypeTaken") && !kBool(r, "esBodyTaken")
	})
	action("@es-take-tag", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["tagName"] = tkn.Src
		r.K["esTagTaken"] = true
	})
	cond("@es-need-utype", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "esKwTaken") && !kBool(r, "esUtypeTaken") && !kBool(r, "esBodyTaken")
	})
	action("@es-take-utype-colon", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["esUtypeTaken"] = true
	})
	cond("@es-need-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "esKwTaken") && !kBool(r, "esBodyTaken")
	})
	state("@enum_specifier-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		cn := childNode(r)
		if cn == nil {
			return
		}
		switch childName(r) {
		case "enum_utype_specs":
			if !kBool(r, "esUtypeAttached") {
				for _, c := range kidsOf(cn) {
					pushKids(ruleNode(r), c)
				}
				r.K["esUtypeAttached"] = true
			}
		case "enumerator_list":
			if !kBool(r, "esBodyTaken") {
				pushKids(ruleNode(r), cn)
				r.K["esBodyTaken"] = true
			}
		}
	})

	// ---- enum_utype_specs ----
	state("@enum_utype_specs-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("declaration_specifiers", nil)
		r.U["specs"] = r.Node
	})
	action("@eus-absorb-spec", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(uNode(r, "specs"), r.O0)
	})

	// ---- enumerator_list ----
	state("@enumerator_list-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "elNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("enumerator_list", nil)
		r.K["elNode"] = r.Node
		r.K["elOpened"] = false
	})
	cond("@el-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "elOpened")
	})
	action("@el-take-lbrace", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["elOpened"] = true
	})
	action("@el-take-rbrace", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@el-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@enumerator_list-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "enumerator" && childNode(r) != nil &&
			!takenHas(r, "takenEnums") {
			pushKids(ruleNode(r), childNode(r))
			takenSet(r, "takenEnums")[r.Child] = true
		}
	})

	// ---- enumerator ----
	state("@enumerator-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n := kNode(r, "enrNode"); n != nil {
				r.Node = n
				return
			}
		}
		r.Node = makeNode("enumerator", nil)
		r.K["enrNode"] = r.Node
	})
	cond("@enr-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "enrNameTaken")
	})
	action("@enr-take-name", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["declaredName"] = tkn.Src
		r.K["enrNameTaken"] = true
	})
	cond("@enr-need-eq", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "enrNameTaken") && !kBool(r, "enrEqTaken")
	})
	action("@enr-take-eq", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["enrEqTaken"] = true
	})
	state("@enumerator-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if childName(r) == "val" && childNode(r) != nil &&
			!sameNode(childNode(r), ruleNode(r)) && !kBool(r, "enrValueAttached") {
			init := makeNode("initializer", nil)
			pushKids(init, childNode(r))
			pushKids(ruleNode(r), init)
			r.K["enrValueAttached"] = true
		}
		if childName(r) == "attribute_spec_c23" && childNode(r) != nil {
			if !takenHas(r, "enrAttrTaken") {
				pushKids(ruleNode(r), childNode(r))
				takenSet(r, "enrAttrTaken")[r.Child] = true
			}
		}
	})
}
