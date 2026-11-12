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
// The full ref map is ported: the extension gate, the translation unit,
// the conditional groups and the
// external declarations with the armed fallback (fallback.go), the
// preprocessor directive family (below), the declaration, specifier,
// initializer and statement refs (refs_newpath*.go), and the extension
// constructs: inline asm, attribute specs, static_assert (refs_ext.go).
func makeGrammarRefs(opts COptions) map[tabnas.FuncRef]any {
	extended := opts.Extended
	ref := map[tabnas.FuncRef]any{}

	// The parser (v0.2) leaves a fresh rule's K/U/N maps nil until first
	// written, and requires handlers to allocate them (EnsureK/EnsureU/
	// EnsureN) before writing. The canonical TS engine keeps these as
	// always-present objects, so the ported handlers write r.K/r.U/r.N
	// directly. Ensure the maps exist before every handler runs so those
	// direct writes never hit a nil map. Empty maps are indistinguishable
	// from nil in the parser's len-guarded propagation, so this is
	// behaviour-preserving.
	cond := func(name string, fn tabnas.AltCond) {
		ref[tabnas.FuncRef(name)] = tabnas.AltCond(func(r *tabnas.Rule, ctx *tabnas.Context) bool {
			r.EnsureK()
			r.EnsureU()
			r.EnsureN()
			return fn(r, ctx)
		})
	}
	action := func(name string, fn tabnas.AltAction) {
		ref[tabnas.FuncRef(name)] = tabnas.AltAction(func(r *tabnas.Rule, ctx *tabnas.Context) {
			r.EnsureK()
			r.EnsureU()
			r.EnsureN()
			fn(r, ctx)
		})
	}
	state := func(name string, fn tabnas.StateAction) {
		ref[tabnas.FuncRef(name)] = tabnas.StateAction(func(r *tabnas.Rule, ctx *tabnas.Context) {
			r.EnsureK()
			r.EnsureU()
			r.EnsureN()
			fn(r, ctx)
		})
	}

	// --- extension gate ---------------------------------------------------
	cond("@extended-on", func(_ *tabnas.Rule, _ *tabnas.Context) bool { return extended })
	cond("@extended-off", func(_ *tabnas.Rule, _ *tabnas.Context) bool { return !extended })
	// The plain-mode C23 attribute head: two adjacent `[`.
	cond("@plain-as23", func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		if extended || len(ctx.T) < 2 {
			return false
		}
		a, b := ctx.T[0], ctx.T[1]
		return a != nil && b != nil && !a.IsNoToken() && !b.IsNoToken() &&
			a.SI+len(a.Src) == b.SI
	})

	// --- translation_unit -------------------------------------------------
	state("@translation_unit-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("translation_unit", nil)
	})
	state("@translation_unit-bc", func(r *tabnas.Rule, ctx *tabnas.Context) {
		if n, ok := r.Node.(CNode); ok {
			fixSpansIn(ctx, n)
		}
	})

	// --- extdecl_loop -----------------------------------------------------
	// r.Node is the container's (the translation unit's, or a conditional
	// branch's); bc appends each completed external declaration and each
	// conditional group, but a group's opener, which the group takes.
	state("@extdecl_loop-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := r.Child
		if child == nil || child == tabnas.NoRule || child.Node == nil {
			return
		}
		if last, _ := r.U["lastChild"].(*tabnas.Rule); last == child {
			return
		}
		r.U["lastChild"] = child
		node, ok := child.Node.(CNode)
		if !ok {
			return
		}
		switch node["kind"] {
		case "external_declaration":
			if conditionalOf(node, conditionalOpeners) != nil {
				r.U["opener"] = node
			} else {
				appendChild(ruleNode(r), node)
			}
		case "conditional_group":
			appendChild(ruleNode(r), node)
		}
	})
	cond("@opens-group", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return uNode(r, "opener") != nil
	})
	// A branch's items end at the line of the next branch or the `#endif`.
	cond("@ends-branch", func(r *tabnas.Rule, ctx *tabnas.Context) bool {
		return kBool(r, "inBranch") && directiveAhead(ctx, conditionalBranchEnds)
	})

	// --- conditional_group ------------------------------------------------
	// The group takes its opener from the items loop that pushed it.
	state("@conditional_group-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("conditional_group", nil)
		if loop := parentRule(r); loop != nil {
			loop.EnsureU()
			r.U["opener"] = loop.U["opener"]
			delete(loop.U, "opener")
		}
	})
	cond("@next-branch", func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		return directiveAhead(ctx, conditionalBranches)
	})
	cond("@group-endif", func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		return directiveAhead(ctx, conditionalEndif)
	})
	cond("@endif-taken", func(r *tabnas.Rule, _ *tabnas.Context) bool { return uBool(r, "endifTaken") })
	state("@conditional_group-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := r.Child
		if child == nil || child == tabnas.NoRule || child.Node == nil {
			return
		}
		if last, _ := r.U["lastChild"].(*tabnas.Rule); last == child {
			return
		}
		r.U["lastChild"] = child
		node, ok := child.Node.(CNode)
		if !ok {
			return
		}
		switch node["kind"] {
		case "conditional_branch":
			appendChild(ruleNode(r), node)
		case "external_declaration":
			appendChild(ruleNode(r), node)
			r.U["endifTaken"] = true
		}
	})
	action("@cg-end", func(r *tabnas.Rule, ctx *tabnas.Context) {
		if n := ruleNode(r); n != nil {
			fixSpansIn(ctx, n)
		}
	})

	// --- conditional_branch -----------------------------------------------
	// The first branch's line is the group's opener; a later branch parses
	// its own.
	state("@conditional_branch-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("conditional_branch", nil)
		if group := parentRule(r); group != nil {
			group.EnsureU()
			if opener, _ := group.U["opener"].(CNode); opener != nil {
				delete(group.U, "opener")
				takeBranchHead(r, opener)
			}
		}
	})
	cond("@branch-has-head", func(r *tabnas.Rule, _ *tabnas.Context) bool { return uBool(r, "headTaken") })
	cond("@branch-needs-items", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return uBool(r, "headTaken") && !uBool(r, "itemsTaken")
	})
	state("@conditional_branch-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := r.Child
		if child == nil || child == tabnas.NoRule {
			return
		}
		if last, _ := r.U["lastChild"].(*tabnas.Rule); last == child {
			return
		}
		r.U["lastChild"] = child
		if child.Name == "external_declaration" && !uBool(r, "headTaken") {
			if n, ok := child.Node.(CNode); ok {
				takeBranchHead(r, n)
			}
		} else if child.Name == "extdecl_loop" {
			r.U["itemsTaken"] = true
		}
	})

	// --- external_declaration --------------------------------------------
	// Each declaration starts with a fresh node and state; the fallback's
	// token record is trimmed to the tokens it has not yet taken.
	state("@external_declaration-bo", func(r *tabnas.Rule, ctx *tabnas.Context) {
		r.Node = makeNode("external_declaration", nil)
		if m := ctxCMeta(ctx); m != nil {
			startDeclaration(m, ctx)
		}
	})

	// An armed route (fallback.go).
	action("@arm", func(_ *tabnas.Rule, ctx *tabnas.Context) {
		if ed := edOf(ctx); ed != nil {
			ed.Armed = true
		}
	})
	cond("@c-failed", func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		ed := edOf(ctx)
		return ed != nil && ed.Failed
	})
	// The rules failed on an armed declaration: it is an unknown one, its
	// children the tokens it has taken, flat; unknown_declaration takes the
	// rest of the run.
	action("@to-unknown", func(r *tabnas.Rule, ctx *tabnas.Context) {
		ed := edOf(ctx)
		m := ctxCMeta(ctx)
		if ed == nil || m == nil {
			return
		}
		ed.Unknown = true
		node := ruleNode(r)
		node["children"] = []any{}
		for _, tkn := range takenTokens(m, ctx) {
			pushTokenWithTrivia(node, tkn)
		}
	})
	// An external declaration no rule starts: unknown from its first token.
	action("@unk-start", func(_ *tabnas.Rule, ctx *tabnas.Context) {
		if ed := edOf(ctx); ed != nil {
			ed.Armed = true
			ed.Unknown = true
		}
	})
	// The rules ended an armed declaration before the chomp's end: the rest
	// of the run follows, flat.
	cond("@armed-runs-on", func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		ed := edOf(ctx)
		return ed != nil && ed.Armed && !ed.Failed && !ed.Unknown && !chompEnded(ctx)
	})
	action("@extdecl-trailing", func(r *tabnas.Rule, ctx *tabnas.Context) {
		spliceDeclaration(r, ctx)
		if ed := edOf(ctx); ed != nil {
			ed.Trailing = true
		}
	})
	// The declaration the rules built.
	action("@extdecl-built", func(r *tabnas.Rule, ctx *tabnas.Context) {
		spliceDeclaration(r, ctx)
		finishExternalDeclaration(ruleNode(r), ctx)
	})

	// --- unknown_declaration ------------------------------------------------
	action("@unk-take", func(r *tabnas.Rule, _ *tabnas.Context) {
		pushTokenWithTrivia(ruleNode(r), r.O0)
	})
	cond("@unk-ended", func(_ *tabnas.Rule, ctx *tabnas.Context) bool { return chompEnded(ctx) })
	action("@unk-end", func(r *tabnas.Rule, ctx *tabnas.Context) {
		finishExternalDeclaration(ruleNode(r), ctx)
	})

	// =====================================================================
	// Top-level preprocessor directives. Ported from c.ts lines ~5410-5775.
	// =====================================================================

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
		// identifier classifications see it. An armed line binds its macro
		// when it ends, as 0.5 did (finishExternalDeclaration).
		ed := edOf(ctx)
		if cm := ctxCMeta(ctx); cm != nil && cm.Macros != nil && tkn.Src != "" &&
			kBool(r, "topLine") && !(ed != nil && ed.Armed) {
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
		ed := edOf(ctx)
		if cm := ctxCMeta(ctx); cm != nil && cm.Macros != nil && tkn.Src != "" &&
			kBool(r, "topLine") && !(ed != nil && ed.Armed) {
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

	// --- extension constructs (inline asm, in-body preprocessor lines,
	// attribute specs, static_assert declarations) ----------------------
	registerExtRefs(regFns{cond: cond, action: action, state: state})

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

// ---- conditional groups and the end of an external declaration ---------

// The directive names that open a conditional group, start its later
// branches, and end it.
var (
	conditionalOpeners    = setOf("if", "ifdef", "ifndef")
	conditionalBranches   = setOf("elif", "elifdef", "elifndef", "else")
	conditionalEndif      = setOf("endif")
	conditionalBranchEnds = setOf("elif", "elifdef", "elifndef", "else", "endif")
)

// conditionalOf is the conditional directive an external declaration is,
// when its name is one of names.
func conditionalOf(node CNode, names map[string]bool) CNode {
	kids, _ := node["children"].([]any)
	for _, c := range kids {
		cm, ok := c.(map[string]any)
		if !ok || cm["kind"] != "conditional_directive" {
			continue
		}
		d, _ := cm["directive"].(string)
		if names[d] {
			return cm
		}
		return nil
	}
	return nil
}

// directiveAhead is true when the next line is a `#` line whose directive
// is one of names (the alternate has fetched its first two tokens).
func directiveAhead(ctx *tabnas.Context, names map[string]bool) bool {
	if len(ctx.T) < 2 {
		return false
	}
	a, b := ctx.T[0], ctx.T[1]
	return a != nil && b != nil && a.Name == "PP_HASH" && names[b.Src]
}

// takeBranchHead makes head, its directive's external declaration, a
// branch's first child.
func takeBranchHead(r *tabnas.Rule, head CNode) {
	node := ruleNode(r)
	appendChild(node, head)
	kind := "unknown"
	kids, _ := head["children"].([]any)
	for _, c := range kids {
		if cm, ok := c.(map[string]any); ok && cm["kind"] == "conditional_directive" {
			kind, _ = cm["directive"].(string)
			break
		}
	}
	node["branchKind"] = kind
	r.U["headTaken"] = true
}

// spliceDeclaration splices the declaration a dispatch rule built into the
// external declaration's node. simple_declaration's children become the
// external declaration's own; a static_assert or asm statement is its one
// child.
func spliceDeclaration(r *tabnas.Rule, ctx *tabnas.Context) {
	child := r.Child
	if child == nil || child == tabnas.NoRule {
		return
	}
	childNode, ok := child.Node.(CNode)
	if !ok || childNode == nil || sameNode(childNode, ruleNode(r)) {
		return
	}
	node := ruleNode(r)
	if child.Name == "static_assert_declaration" || child.Name == "asm_statement" {
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
	ed := edOf(ctx)
	if ed == nil || child.U == nil {
		return
	}
	if isT, _ := child.U["isTypedef"].(bool); isT {
		if names, ok := child.U["declaredNames"].([]any); ok {
			ed.TypedefNames = []string{}
			for _, nm := range names {
				if s, ok := nm.(string); ok {
					ed.TypedefNames = append(ed.TypedefNames, s)
				}
			}
		}
	}
}

// finishExternalDeclaration finishes an external declaration: its kind,
// and the names it binds.
//
// A strict declaration binds the typedef names its rules found. An armed
// one (and an unknown one) is the token run the 0.5 parser handed its
// structurer, and binds what 0.5 bound for that run, read from its tokens:
// the typedef names of a run that starts with `typedef` and ends with `;`
// (registerTypedefIfApplicable), and the macro each `#define` and `#undef`
// line in it names (registerMacrosFromTokens), unless the run is an
// unknown declaration that does not start with `#`, which the structurer
// did not read. The names decide how later tokens lex, so binding them as
// 0.5 did keeps what the parser accepts.
func finishExternalDeclaration(node CNode, ctx *tabnas.Context) {
	ed := edOf(ctx)
	if ed == nil || node == nil {
		return
	}
	if ed.Unknown {
		node["declKind"] = "unknown"
	} else if dk, _ := node["declKind"].(string); dk == "" {
		node["declKind"] = "unknown"
	}
	fixSpansIn(ctx, node)
	cm := ctxCMeta(ctx)
	if ed.Armed {
		tokens := takenTokens(cm, ctx)
		registerTypedefIfApplicable(tokens, ctx)
		// 0.5 bound the macros of the lines its structurer read as
		// directives: a `#` line's own, and those of a declaration it
		// built. An unknown declaration that does not start with `#`
		// binds none.
		var first *tabnas.Token
		for _, t := range tokens {
			if !triviaTokenNames[t.Name] {
				first = t
				break
			}
		}
		if !ed.Unknown || (first != nil && first.Name == "PP_HASH") {
			registerMacrosFromTokens(tokens, ctx)
		}
	} else if ed.TypedefNames != nil {
		for _, name := range ed.TypedefNames {
			cm.Symbols.BindTypedef(name)
			reclassifyLookaheadTypedef(ctx, name)
		}
	}
}

// registerMacrosFromTokens binds and unbinds, in order, the macros a run's
// `#define` and `#undef` lines name, as 0.5's structurer read them: the
// token after the directive name, when it is an identifier, a macro name
// or a typedef name; a define is function-like when a `(` follows the name
// with no space.
func registerMacrosFromTokens(tokens []*tabnas.Token, ctx *tabnas.Context) {
	cm := ctxCMeta(ctx)
	if cm == nil || cm.Macros == nil {
		return
	}
	ts := make([]*tabnas.Token, 0, len(tokens))
	for _, t := range tokens {
		if !triviaTokenNames[t.Name] {
			ts = append(ts, t)
		}
	}
	isName := func(n string) bool {
		return n == "ID" || n == "MACRO_NAME" || n == "TYPEDEF_NAME"
	}
	for i := 0; i < len(ts); i++ {
		if ts[i].Name != "PP_HASH" {
			continue
		}
		dn := ""
		if i+1 < len(ts) {
			dn = ts[i+1].Src
		}
		var nameTkn *tabnas.Token
		if i+2 < len(ts) {
			nameTkn = ts[i+2]
		}
		if dn == "define" && nameTkn != nil && isName(nameTkn.Name) {
			fnLike := false
			if i+3 < len(ts) {
				next := ts[i+3]
				fnLike = next.Name == "PUNC_LPAREN" && next.SI == nameTkn.SI+len(nameTkn.Src)
			}
			var params []string
			variadic := false
			if fnLike {
				params = []string{}
				for j := i + 4; j < len(ts); j++ {
					t := ts[j]
					if t.Name == "PUNC_RPAREN" || t.Name == "PP_NEWLINE" {
						break
					}
					if t.Name == "PUNC_ELLIPSIS" {
						variadic = true
					} else if isName(t.Name) {
						params = append(params, t.Src)
					}
				}
			}
			cm.Macros.Define(&MacroDef{
				Name: nameTkn.Src, IsFunctionLike: fnLike, Params: params, Variadic: variadic,
			})
			reclassifyLookahead(ctx, nameTkn.Src, "ID", "MACRO_NAME")
		} else if dn == "undef" && nameTkn != nil && isName(nameTkn.Name) {
			cm.Macros.Undefine(nameTkn.Src)
			reclassifyLookahead(ctx, nameTkn.Src, "MACRO_NAME", "ID")
		}
	}
}
