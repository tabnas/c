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

	return ref
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
