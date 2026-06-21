/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// Legacy structuring post-processor. Port of ../ts/src/structure.ts (the
// recursive-descent fallback that turns an external_declaration's absorbed
// token list into a structured declaration / function_definition / statement
// CST).
//
// STATUS: in progress. Until the full TokenStream + parse* recursion is
// ported, finalizeExternalDeclaration leaves the chomp's raw token children in
// place (a faithful token-fidelity CST), and the typedef-detection pass still
// registers typedef names so lex-time TYPEDEF_NAME reclassification works.

// finalizeExternalDeclaration is the @finalize-extdecl close action. The full
// version (M5) builds the structured declaration; for now it records typedef
// names from the absorbed tokens so downstream declarations lex correctly, and
// leaves the raw token children on the node.
func finalizeExternalDeclaration(r *tabnas.Rule, ctx *tabnas.Context) {
	toks := kTokens(r)
	if name := typedefNameFromTokens(toks); name != "" {
		if cm := ctxCMeta(ctx); cm != nil {
			cm.Symbols.BindTypedef(name)
		}
		reclassifyLookaheadTypedef(ctx, name)
	}
}

// reclassifyLookaheadTypedef rewrites any already-fetched lookahead token that
// names a just-bound typedef from ID to TYPEDEF_NAME in place, so the parser
// sees the new classification even though the token was lexed before the
// typedef was registered. Mirrors the in-place reclassification the TS
// identifier matcher / finaliser performs.
func reclassifyLookaheadTypedef(ctx *tabnas.Context, name string) {
	if ctx == nil || ctx.Inst == nil {
		return
	}
	tin := ctx.Inst.Token("TYPEDEF_NAME")
	for _, t := range ctx.T {
		if t != nil && t.Name == "ID" && t.Src == name {
			t.Name = "TYPEDEF_NAME"
			t.Tin = tin
		}
	}
}

// typedefNameFromTokens returns the declared name of a simple
// `typedef <specs> <ID> ;` declaration, or "" if the tokens don't look like a
// (non-pointer, non-derived) typedef. This is a deliberately conservative
// subset of the full structurer's typedef detection — enough to keep typedef
// disambiguation working for common cases.
func typedefNameFromTokens(toks []*tabnas.Token) string {
	sig := make([]*tabnas.Token, 0, len(toks))
	for _, t := range toks {
		switch t.Name {
		case "TRIVIA_LINE_COMMENT", "TRIVIA_BLOCK_COMMENT", "TRIVIA_LINE_CONT",
			"#SP", "#LN", "#CM":
			continue
		}
		sig = append(sig, t)
	}
	if len(sig) < 3 || sig[0].Name != "KW_TYPEDEF" {
		return ""
	}
	if sig[len(sig)-1].Name != "PUNC_SEMI" {
		return ""
	}
	// The declared name is the last identifier before the `;`, provided the
	// token before it is not a `,` (multi-declarator) or `)`/`]` (derived).
	nameTok := sig[len(sig)-2]
	if nameTok.Name != "ID" {
		return ""
	}
	if len(sig) >= 3 {
		switch sig[len(sig)-3].Name {
		case "PUNC_COMMA", "PUNC_RPAREN", "PUNC_RBRACKET", "PUNC_STAR":
			return ""
		}
	}
	return nameTok.Src
}

// startsNewExternalDeclaration reports whether the upcoming token(s) begin a
// new external declaration (used by @just-closed-and-decl-ahead to decide
// whether a top-level `}` ended a function body). The full version inspects
// the lookahead for a declaration head; the conservative version returns false
// so brace-closed units finalize at their terminator or EOF instead.
func startsNewExternalDeclaration(_ *tabnas.Context) bool {
	return false
}

// ctxCMeta returns the per-parse CMeta from the context, or nil.
func ctxCMeta(ctx *tabnas.Context) *CMeta {
	if ctx == nil || ctx.Meta == nil {
		return nil
	}
	if m, ok := ctx.Meta["cmeta"].(*CMeta); ok {
		return m
	}
	return nil
}
