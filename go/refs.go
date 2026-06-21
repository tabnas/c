/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// makeGrammarRefs returns the @-named condition/action/state handlers the C
// grammar binds. Port of makeGrammarRefs in c.ts (the ~471-entry ref map),
// done incrementally. Any @ref referenced by the grammar's c:/a: fields but
// absent here is given a typed no-op stub by scanAndStubRefs at install time
// (false-returning condition / no-op action), so the grammar always installs.
//
// Phase hooks (@rule-bo/bc/ao/ac) are tabnas.StateAction and are wired to
// their rule by the engine's Grammar() via the key name. Alt refs are
// tabnas.AltCond (c:) or tabnas.AltAction (a:).
//
// Ported so far: the extension gate and the top-level chomp path
// (translation_unit / extdecl_loop / external_declaration token accumulation),
// which yields a token-fidelity CST. The structured dispatch
// (simple_declaration etc.) and the legacy finaliser (structure.go) are still
// being ported; until then declarations are captured as raw token children.
func makeGrammarRefs(opts COptions) map[tabnas.FuncRef]any {
	extended := opts.Extended
	ref := map[tabnas.FuncRef]any{}

	cond := func(name string, fn tabnas.AltCond) { ref[tabnas.FuncRef(name)] = fn }
	action := func(name string, fn tabnas.AltAction) { ref[tabnas.FuncRef(name)] = fn }
	state := func(name string, fn tabnas.StateAction) { ref[tabnas.FuncRef(name)] = fn }

	// --- extension gate ---------------------------------------------------
	cond("@extended-on", func(_ *tabnas.Rule, _ *tabnas.Context) bool { return extended })
	cond("@extended-off", func(_ *tabnas.Rule, _ *tabnas.Context) bool { return !extended })
	cond("@ext-and-first-iter", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return extended && len(kTokens(r)) == 0
	})

	// --- translation_unit -------------------------------------------------
	state("@translation_unit-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("translation_unit", nil)
	})
	state("@translation_unit-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n, ok := r.Node.(CNode); ok {
			structureConditionalGroups(n)
		}
	})

	// --- extdecl_loop -----------------------------------------------------
	state("@extdecl_loop-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if r.Child == nil || r.Child == tabnas.NoRule {
			return
		}
		child, ok := r.Child.Node.(CNode)
		if !ok || child["kind"] != "external_declaration" {
			return
		}
		if n, ok := r.Node.(CNode); ok {
			appendChild(n, child)
		}
	})

	// --- external_declaration --------------------------------------------
	state("@external_declaration-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if n, ok := r.Node.(CNode); !ok || n["kind"] != "external_declaration" {
			r.Node = makeNode("external_declaration", nil)
		}
		if _, ok := r.K["tokens"]; !ok {
			r.K["tokens"] = []*tabnas.Token{}
		}
		if _, ok := r.K["depth"]; !ok {
			r.K["depth"] = 0
		}
		if _, ok := r.K["terminated"]; !ok {
			r.K["terminated"] = false
		}
	})

	action("@absorb-token", absorbToken)

	cond("@terminated", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		t, _ := r.K["terminated"].(bool)
		return t
	})
	cond("@just-closed-and-decl-ahead", func(r *tabnas.Rule, ctx *tabnas.Context) bool {
		jc, _ := r.K["justClosedBrace"].(bool)
		return jc && startsNewExternalDeclaration(ctx)
	})
	action("@finalize-extdecl", func(r *tabnas.Rule, ctx *tabnas.Context) {
		finalizeExternalDeclaration(r, ctx)
	})

	// --- new-path dispatch markers ---------------------------------------
	action("@mark-new-path", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.U["newPath"] = true
	})
	cond("@new-path", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		np, _ := r.U["newPath"].(bool)
		return np
	})
	cond("@is-first-iter", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return len(kTokens(r)) == 0
	})

	// =====================================================================
	// Top-level preprocessor directives. Ported from c.ts lines ~5410-5775.
	// =====================================================================

	// ---- external_declaration new-path finaliser (c.ts @finalize-new-path)
	// Splices the directive/declaration wrapper child's children into the
	// external_declaration node and copies its declKind, so a preprocessor
	// directive yields `external_declaration{children:[<directive>],
	// declKind:"declaration"}` matching the legacy CST.
	action("@finalize-new-path", func(r *tabnas.Rule, ctx *tabnas.Context) {
		if r.Child == nil || r.Child == tabnas.NoRule {
			return
		}
		childNode, ok := r.Child.Node.(CNode)
		if !ok {
			return
		}
		node := ruleNode(r)
		if node == nil {
			return
		}
		childName := r.Child.Name
		wrapAsSingle := childName == "static_assert_declaration" ||
			childName == "asm_statement"
		if wrapAsSingle {
			node["children"] = []any{childNode}
			node["declKind"] = "declaration"
		} else {
			kids, _ := childNode["children"].([]any)
			cp := make([]any, len(kids))
			copy(cp, kids)
			node["children"] = cp
			if dk, ok := childNode["declKind"].(string); ok && dk != "" {
				node["declKind"] = dk
			} else {
				node["declKind"] = "declaration"
			}
		}
		node["viaPath"] = "grammar"
		// Register declared typedef names (set by simple_declaration path).
		if r.Child.U != nil {
			if isT, _ := r.Child.U["isTypedef"].(bool); isT {
				if names, ok := r.Child.U["declaredNames"].([]any); ok {
					if cm := ctxCMeta(ctx); cm != nil {
						for _, nm := range names {
							if s, ok := nm.(string); ok {
								cm.Symbols.BindTypedef(s)
								reclassifyLookaheadTypedef(ctx, s)
							}
						}
					}
				}
			}
		}
	})

	// ---- preprocessor_directive dispatcher (c.ts @preprocessor_directive-*)
	state("@preprocessor_directive-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := makeNode("preprocessor_directive_wrapper", nil)
		node["declKind"] = "declaration"
		r.Node = node
	})
	state("@preprocessor_directive-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if r.Child == nil || r.Child == tabnas.NoRule {
			return
		}
		child, ok := r.Child.Node.(CNode)
		if !ok || kBool(r, "directiveAttached") {
			return
		}
		switch r.Child.Name {
		case "define_directive", "undef_directive", "include_directive",
			"conditional_directive", "simple_directive":
			appendChild(ruleNode(r), child)
			r.K["directiveAttached"] = true
		}
	})

	// ---- preprocessor_directive dispatch ---------------------------------
	cond("@ppd-is-define", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return o1Src(r) == "define"
	})
	cond("@ppd-is-undef", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return o1Src(r) == "undef"
	})
	cond("@ppd-is-include", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		s := o1Src(r)
		return s == "include" || s == "include_next" || s == "embed"
	})
	cond("@ppd-is-conditional", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		s := o1Src(r)
		return s == "if" || s == "ifdef" || s == "ifndef" ||
			s == "elif" || s == "elifdef" || s == "elifndef" ||
			s == "else" || s == "endif"
	})
	cond("@ppd-is-simple", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		s := o1Src(r)
		return s == "pragma" || s == "error" || s == "warning" || s == "line"
	})

	// ---- define_directive ------------------------------------------------
	state("@define_directive-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["defNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("define_directive", nil)
		r.K["defNode"] = node
		r.Node = node
	})
	cond("@def-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "defHashTaken")
	})
	action("@def-take-hash", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["defHashTaken"] = true
	})
	cond("@def-need-keyword", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "defHashTaken") && !kBool(r, "defKwTaken")
	})
	action("@def-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["defKwTaken"] = true
	})
	cond("@def-need-name", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "defKwTaken") && !kBool(r, "defNameTaken")
	})
	action("@def-take-name", func(r *tabnas.Rule, ctx *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["macroName"] = tkn.Src
		r.K["defNameTaken"] = true
		r.K["defNameTokenEnd"] = tkn.SI + len(tkn.Src)
		// Register the macro as soon as the name lands so subsequent
		// identifier classifications see it.
		if cm := ctxCMeta(ctx); cm != nil && cm.Macros != nil && tkn.Src != "" {
			cm.Macros.Define(&MacroDef{Name: tkn.Src, IsFunctionLike: false})
			reclassifyLookahead(ctx, tkn.Src, "ID", "MACRO_NAME")
		}
	})
	cond("@def-paren-adjacent", func(r *tabnas.Rule, ctx *tabnas.Context) bool {
		if !kBool(r, "defNameTaken") || kBool(r, "defParamsTaken") ||
			kBool(r, "defBodyTaken") {
			return false
		}
		t0 := ctxTok0(ctx)
		if t0 == nil || t0.Name != "PUNC_LPAREN" {
			return false
		}
		end, _ := r.K["defNameTokenEnd"].(int)
		return t0.SI == end
	})
	cond("@def-need-body", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "defNameTaken") && !kBool(r, "defBodyTaken")
	})
	cond("@def-need-newline", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "defBodyTaken") && !kBool(r, "defNewlineTaken")
	})
	action("@def-take-newline", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["defNewlineTaken"] = true
	})
	state("@define_directive-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if r.Child == nil || r.Child == tabnas.NoRule {
			return
		}
		child, ok := r.Child.Node.(CNode)
		if !ok {
			return
		}
		node := ruleNode(r)
		if r.Child.Name == "macro_parameter_list" && !kBool(r, "defParamsTaken") {
			appendChild(node, child)
			node["macroKind"] = "function-like"
			if mp, ok := child["macroParams"]; ok {
				node["macroParams"] = mp
			} else {
				node["macroParams"] = []any{}
			}
			if v, ok := child["macroVariadic"].(bool); ok && v {
				node["macroVariadic"] = true
			}
			r.K["defParamsTaken"] = true
			return
		}
		if r.Child.Name == "macro_body" && !kBool(r, "defBodyTaken") {
			appendChild(node, child)
			if _, ok := node["macroKind"]; !ok {
				node["macroKind"] = "object-like"
			}
			r.K["defBodyTaken"] = true
		}
	})

	// ---- macro_parameter_list --------------------------------------------
	state("@macro_parameter_list-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["mplNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("macro_parameter_list", nil)
		node["macroParams"] = []any{}
		r.K["mplNode"] = node
		r.Node = node
	})
	cond("@mpl-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "mplOpen")
	})
	action("@mpl-take-lparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["mplOpen"] = true
	})
	action("@mpl-take-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@mpl-take-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@mpl-take-ellipsis", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		pushTokenWithTrivia(node, r.C0)
		node["macroVariadic"] = true
	})
	action("@mpl-take-param", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["macroParams"] = append(node["macroParams"].([]any), tkn.Src)
	})
	action("@mpl-absorb-other", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})

	// ---- macro_body ------------------------------------------------------
	state("@macro_body-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["mbNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("macro_body", nil)
		r.K["mbNode"] = node
		r.Node = node
	})
	cond("@mb-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "mbAny")
	})
	action("@mb-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := stateTok(r)
		pushTokenWithTrivia(ruleNode(r), tkn)
		r.K["mbAny"] = true
	})

	// ---- undef_directive -------------------------------------------------
	state("@undef_directive-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["undNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("undef_directive", nil)
		r.K["undNode"] = node
		r.Node = node
	})
	cond("@undef-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "undHashTaken")
	})
	action("@undef-take-hash", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["undHashTaken"] = true
	})
	cond("@undef-need-keyword", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "undHashTaken") && !kBool(r, "undKwTaken")
	})
	action("@undef-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
		r.K["undKwTaken"] = true
	})
	cond("@undef-need-name", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "undKwTaken") && !kBool(r, "undNameTaken")
	})
	action("@undef-take-name", func(r *tabnas.Rule, ctx *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["macroName"] = tkn.Src
		r.K["undNameTaken"] = true
		if cm := ctxCMeta(ctx); cm != nil && cm.Macros != nil && tkn.Src != "" {
			cm.Macros.Undefine(tkn.Src)
			reclassifyLookahead(ctx, tkn.Src, "MACRO_NAME", "ID")
		}
	})
	action("@undef-take-newline", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@undef-absorb-trailing", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})

	// ---- include_directive -----------------------------------------------
	state("@include_directive-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["incNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("include_directive", nil)
		r.K["incNode"] = node
		r.Node = node
	})
	cond("@inc-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "incHashTaken")
	})
	action("@inc-take-hash", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["incHashTaken"] = true
	})
	cond("@inc-need-keyword", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "incHashTaken") && !kBool(r, "incKwTaken")
	})
	action("@inc-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["includeForm"] = tkn.Src
		r.K["incKwTaken"] = true
	})
	cond("@inc-need-header", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "incKwTaken") && !kBool(r, "incHeaderTaken")
	})
	action("@inc-take-header", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["headerName"] = tkn.Src
		if len(tkn.Src) > 0 && tkn.Src[0] == '<' {
			node["headerKind"] = "angled"
		} else {
			node["headerKind"] = "quoted"
		}
		r.K["incHeaderTaken"] = true
	})
	cond("@inc-need-form", func(r *tabnas.Rule, ctx *tabnas.Context) bool {
		if !kBool(r, "incKwTaken") || kBool(r, "incHeaderTaken") ||
			kBool(r, "incFormTaken") {
			return false
		}
		t0 := ctxTok0(ctx)
		return t0 != nil && t0.Name != "PP_NEWLINE"
	})
	action("@inc-take-newline", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	state("@include_directive-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if r.Child == nil || r.Child == tabnas.NoRule {
			return
		}
		child, ok := r.Child.Node.(CNode)
		if !ok {
			return
		}
		if r.Child.Name == "header_form" && !kBool(r, "incFormTaken") {
			appendChild(ruleNode(r), child)
			r.K["incFormTaken"] = true
		}
	})

	// ---- header_form -----------------------------------------------------
	state("@header_form-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["hfNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("header_form", nil)
		r.K["hfNode"] = node
		r.Node = node
	})
	cond("@hf-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "hfAny")
	})
	action("@hf-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), stateTok(r))
		r.K["hfAny"] = true
	})

	// ---- conditional_directive -------------------------------------------
	state("@conditional_directive-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["condNode"].(CNode); ok {
				r.Node = n
				return
			}
		}
		node := makeNode("conditional_directive", nil)
		r.K["condNode"] = node
		r.Node = node
	})
	cond("@cond-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "condHashTaken")
	})
	action("@cond-take-hash", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["condHashTaken"] = true
	})
	cond("@cond-need-keyword", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "condHashTaken") && !kBool(r, "condKwTaken")
	})
	action("@cond-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		node["directive"] = tkn.Src
		r.K["condKwTaken"] = true
	})
	action("@cond-take-newline", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@cond-absorb", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})

	// ---- simple_directive ------------------------------------------------
	state("@simple_directive-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		if isRecursion(r) {
			if n, ok := r.K["sd2Node"].(CNode); ok {
				r.Node = n
				return
			}
		}
		// Kind decided in @sd2-take-keyword; default unknown_directive.
		node := makeNode("unknown_directive", nil)
		r.K["sd2Node"] = node
		r.Node = node
	})
	cond("@sd2-reentered", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "sd2HashTaken")
	})
	action("@sd2-take-hash", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
		r.K["sd2HashTaken"] = true
	})
	cond("@sd2-need-keyword", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return kBool(r, "sd2HashTaken") && !kBool(r, "sd2KwTaken")
	})
	action("@sd2-take-keyword", func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.C0
		node := ruleNode(r)
		pushTokenWithTrivia(node, tkn)
		kindMap := map[string]string{
			"pragma":  "pragma_directive",
			"error":   "error_directive",
			"warning": "warning_directive",
			"line":    "line_directive",
		}
		if k, ok := kindMap[tkn.Src]; ok {
			node["kind"] = k
		} else {
			node["kind"] = "unknown_directive"
		}
		r.K["sd2KwTaken"] = true
	})
	action("@sd2-take-newline", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})
	action("@sd2-absorb", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.C0)
	})

	// --- new-path structured dispatch (declarations, declarators,
	// specifiers, struct/union/enum, initializers, statements) ---------
	registerNewPathRefs(regFns{cond: cond, action: action, state: state}, extended)

	return ref
}

// ---- directive ref helpers ---------------------------------------------

// o1Src returns r.O1.Src, or "" if r.O1 is nil.
func o1Src(r *tabnas.Rule) string {
	if r.O1 == nil {
		return ""
	}
	return r.O1.Src
}

// isRecursion reports whether this rule replaced a prior instance of the same
// rule (TS: prev && prev.name === rule.name), used by -bo hooks to reuse the
// in-progress node across r:-recursion.
func isRecursion(r *tabnas.Rule) bool {
	return r.Prev != nil && r.Prev != tabnas.NoRule && r.Prev.Name == r.Name
}

// ruleNode returns r.Node as a CNode (nil if unset/wrong type).
func ruleNode(r *tabnas.Rule) CNode {
	n, _ := r.Node.(CNode)
	return n
}

// kBool returns the bool value of r.K[key] (false if absent).
func kBool(r *tabnas.Rule, key string) bool {
	b, _ := r.K[key].(bool)
	return b
}

// stateTok returns r.C0 when the rule is in close phase, else r.O0 (TS:
// rule.state === 'c' ? rule.c0 : rule.o0).
func stateTok(r *tabnas.Rule) *tabnas.Token {
	if r.State == tabnas.CLOSE {
		return r.C0
	}
	return r.O0
}

// ctxTok0 returns ctx.T[0] or nil.
func ctxTok0(ctx *tabnas.Context) *tabnas.Token {
	if ctx == nil || len(ctx.T) == 0 {
		return nil
	}
	return ctx.T[0]
}

// pushTokenWithTrivia appends a token's leading-trivia refs then the token ref
// to node["children"]. Port of pushTokenWithTrivia in c.ts.
func pushTokenWithTrivia(node CNode, tkn *tabnas.Token) {
	if node == nil || tkn == nil {
		return
	}
	for _, tr := range leadingTriviaRefs(tkn) {
		appendChild(node, tr)
	}
	appendChild(node, tokenRef(tkn))
}

// kTokens returns the absorbed-token slice from r.K (nil-safe).
func kTokens(r *tabnas.Rule) []*tabnas.Token {
	if r.K == nil {
		return nil
	}
	if t, ok := r.K["tokens"].([]*tabnas.Token); ok {
		return t
	}
	return nil
}

// absorbToken is @absorb-token: append one token (and any leading trivia) to
// the external_declaration node and update brace-depth/terminator state.
func absorbToken(r *tabnas.Rule, _ *tabnas.Context) {
	node, _ := r.Node.(CNode)
	if node == nil {
		return
	}
	toks := kTokens(r)
	tkn := r.O0

	if tkn.Use != nil {
		if leading, ok := tkn.Use["leading"].([]any); ok {
			for _, ltAny := range leading {
				if lt, ok := ltAny.(*tabnas.Token); ok {
					appendChild(node, tokenRef(lt))
					toks = append(toks, lt)
				}
			}
		}
	}
	toks = append(toks, tkn)
	appendChild(node, tokenRef(tkn))

	r.K["justClosedBrace"] = false
	depth, _ := r.K["depth"].(int)
	switch {
	case tkn.Name == "PUNC_LBRACE":
		depth++
	case tkn.Name == "PUNC_RBRACE":
		depth--
		if depth <= 0 {
			r.K["justClosedBrace"] = true
		}
	case tkn.Name == "PUNC_SEMI" && depth == 0:
		r.K["terminated"] = true
	case tkn.Name == "PP_NEWLINE" && depth == 0 && firstNonTriviaIs(toks, "PP_HASH"):
		r.K["terminated"] = true
	}
	r.K["depth"] = depth
	r.K["tokens"] = toks
}

// firstNonTriviaIs reports whether the first non-trivia token in toks has the
// given name.
func firstNonTriviaIs(toks []*tabnas.Token, name string) bool {
	for _, t := range toks {
		switch t.Name {
		case "TRIVIA_LINE_COMMENT", "TRIVIA_BLOCK_COMMENT", "TRIVIA_LINE_CONT",
			"#SP", "#LN", "#CM":
			continue
		}
		return t.Name == name
	}
	return false
}
