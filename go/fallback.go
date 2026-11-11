/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"strings"

	tabnas "github.com/tabnas/parser/go"
)

// The armed fallback: how an external declaration the rules cannot parse
// becomes an unknown declaration, where the parser up to 0.5 handed it to
// a structurer that took any token run. Port of ts/src/fallback.ts, which
// has the design.
//
// external_declaration dispatches on its head (c-grammar.jsonic). A route
// the parser has always held to the rules is strict: a declaration the
// rules cannot parse there is refused. Every other route is armed. An
// armed declaration is the token run the 0.5 parser's chomp absorbed, and
// that run ends where the chomp ended it: after a `;` at brace depth 0,
// after the newline that ends a `#` line, after a `}` back to depth 0
// when the next token starts a declaration (startsNewDeclaration), or at
// the end. Inside it every rule below external_declaration has a bail
// (its first alternate, which ends the state once the declaration has
// failed) and a catch-all (its last, which fails the declaration where no
// other alternate matches), and every alternate that takes a token is
// fenced at the chomp's end. The plugin records the tokens it lexes (the
// sub-lex hook in c.go), and the engine's count of the tokens taken
// (ctx.VAbs) says how many of them the declaration holds.

// ExtDecl is the state of the external declaration being parsed.
type ExtDecl struct {
	// Armed: the route is armed, not strict.
	Armed bool
	// Failed: an armed declaration the rules failed on; every state bails.
	Failed bool
	// Unknown: the declaration is an unknown one, its children its tokens.
	Unknown bool
	// Trailing: the rules ended an armed declaration before the chomp's
	// end, and the rest of the run follows what they built, flat.
	Trailing bool
	// The chomp's state over the tokens taken so far.
	Scanned    int
	Depth      int
	Terminated bool
	JustClosed bool
	First      string
	// Crashed is a panic a ref raised in an armed declaration, which
	// failed it (the declaration is then unknown).
	Crashed any
	// Locals are the open local scopes, innermost last: a rule that
	// catches a failure below it and reads the rest of its tokens flat
	// (asm_operand). A failure inside one fails the scope, not the
	// declaration.
	Locals []*LocalScope
	// TypedefNames are the names a strict typedef declaration's rules
	// found, bound when the declaration ends.
	TypedefNames []string
}

// LocalScope is a rule that catches a failure below it.
type LocalScope struct {
	VAbs   int
	Failed bool
}

func newExtDecl() *ExtDecl { return &ExtDecl{} }

// edOf is the state of the external declaration being parsed, or nil.
func edOf(ctx *tabnas.Context) *ExtDecl {
	m := ctxCMeta(ctx)
	if m == nil {
		return nil
	}
	return m.ED
}

func innermost(ed *ExtDecl) *LocalScope {
	if ed == nil || len(ed.Locals) == 0 {
		return nil
	}
	return ed.Locals[len(ed.Locals)-1]
}

// openLocal opens a local scope at the tokens taken so far.
func openLocal(ctx *tabnas.Context) *LocalScope {
	ed := edOf(ctx)
	if ed == nil {
		return nil
	}
	scope := &LocalScope{VAbs: ctx.VAbs}
	ed.Locals = append(ed.Locals, scope)
	return scope
}

// closeLocal closes a local scope (and any left open inside it).
func closeLocal(ctx *tabnas.Context, scope *LocalScope) {
	ed := edOf(ctx)
	if ed == nil || scope == nil {
		return
	}
	for i := len(ed.Locals) - 1; i >= 0; i-- {
		if ed.Locals[i] == scope {
			ed.Locals = ed.Locals[:i]
			return
		}
	}
}

// tokensSince is the tokens taken since a count of tokens taken.
func tokensSince(ctx *tabnas.Context, vAbs int) []*tabnas.Token {
	m := ctxCMeta(ctx)
	if m == nil || m.Rec == nil {
		return nil
	}
	from := vAbs - m.RecBase
	if from < 0 {
		from = 0
	}
	to := ctx.VAbs - m.RecBase
	if to > len(m.Rec) {
		to = len(m.Rec)
	}
	if from >= to {
		return nil
	}
	return m.Rec[from:to]
}

// bracketDepth is the depth of `(` and `[` a run of tokens leaves open.
func bracketDepth(tokens []*tabnas.Token) int {
	d := 0
	for _, t := range tokens {
		switch t.Name {
		case "PUNC_LPAREN", "PUNC_LBRACKET":
			d++
		case "PUNC_RPAREN", "PUNC_RBRACKET":
			d--
		}
	}
	return d
}

// recordToken records a token the lexer gave the parser. Called from the
// sub-lex hook for every token that is not trivia; the engine takes them
// in the order they are lexed.
func recordToken(m *CMeta, tkn *tabnas.Token) {
	if m.Rec == nil {
		m.Rec = []*tabnas.Token{}
		m.RecBase = 0
	}
	// A re-announced token (the engine's relex undo) replaces the last.
	if n := len(m.Rec); n > 0 && m.Rec[n-1] != nil && m.Rec[n-1].SI == tkn.SI {
		m.Rec[n-1] = tkn
		return
	}
	m.Rec = append(m.Rec, tkn)
}

// startDeclaration starts an external declaration: drop the record's
// tokens the previous ones took, and reset the state.
func startDeclaration(m *CMeta, ctx *tabnas.Context) *ExtDecl {
	if m.Rec == nil {
		m.Rec = []*tabnas.Token{}
		m.RecBase = 0
	}
	taken := ctx.VAbs - m.RecBase
	if taken > 0 {
		if taken >= len(m.Rec) {
			m.Rec = []*tabnas.Token{}
		} else {
			// A copy, so the record does not keep every token the parse
			// has taken alive behind its slice.
			m.Rec = append([]*tabnas.Token(nil), m.Rec[taken:]...)
		}
	}
	m.RecBase = ctx.VAbs
	m.ED = newExtDecl()
	return m.ED
}

// takenTokens is the tokens the declaration has taken, in order.
func takenTokens(m *CMeta, ctx *tabnas.Context) []*tabnas.Token {
	n := ctx.VAbs - m.RecBase
	if n <= 0 || m.Rec == nil {
		return nil
	}
	if n > len(m.Rec) {
		n = len(m.Rec)
	}
	return m.Rec[:n]
}

// chompSync brings the chomp's state up to the tokens taken.
func chompSync(m *CMeta, ed *ExtDecl, ctx *tabnas.Context) int {
	n := ctx.VAbs - m.RecBase
	rec := m.Rec
	for i := ed.Scanned; i < n && i < len(rec); i++ {
		name := rec[i].Name
		if i == 0 {
			ed.First = name
		}
		ed.JustClosed = false
		switch {
		case name == "PUNC_LBRACE":
			ed.Depth++
		case name == "PUNC_RBRACE":
			ed.Depth--
			if ed.Depth <= 0 {
				ed.JustClosed = true
			}
		case name == "PUNC_SEMI" && ed.Depth == 0:
			ed.Terminated = true
		case name == "PP_NEWLINE" && ed.Depth == 0 && ed.First == "PP_HASH":
			ed.Terminated = true
		}
	}
	scanned := n
	if len(rec) < scanned {
		scanned = len(rec)
	}
	if scanned > ed.Scanned {
		ed.Scanned = scanned
	}
	return n
}

// chompEnded is true when the chomp would end the declaration after the
// tokens taken, given the next token (ctx.T[0], which the caller has
// fetched).
func chompEnded(ctx *tabnas.Context) bool {
	m := ctxCMeta(ctx)
	if m == nil || m.ED == nil {
		return false
	}
	ed := m.ED
	n := chompSync(m, ed, ctx)
	if n <= 0 {
		return false
	}
	if ed.Terminated {
		return true
	}
	return ed.JustClosed && startsNewDeclaration(ctx)
}

// fenced: an armed declaration that has reached the chomp's end takes no
// more tokens.
func fenced(ctx *tabnas.Context) bool {
	ed := edOf(ctx)
	if ed == nil || !ed.Armed || ed.Failed {
		return false
	}
	return chompEnded(ctx)
}

// Token-name sets of the chomp's own test (startsNewDeclaration),
// unchanged from 0.5.
var (
	chompStorageClass = setOf(
		"KW_TYPEDEF", "KW_EXTERN", "KW_STATIC", "KW_AUTO", "KW_REGISTER",
		"KW__THREAD_LOCAL", "KW_THREAD_LOCAL", "KW_CONSTEXPR",
		"KW___THREAD",
	)
	chompTypeSpecKeyword = setOf(
		"KW_VOID", "KW_CHAR", "KW_SHORT", "KW_INT", "KW_LONG", "KW_FLOAT",
		"KW_DOUBLE", "KW_SIGNED", "KW_UNSIGNED", "KW_BOOL", "KW__BOOL",
		"KW__COMPLEX", "KW__IMAGINARY",
		"KW___SIGNED__", "KW___SIGNED",
		"KW___INT8", "KW___INT16", "KW___INT32", "KW___INT64",
		"KW_STRUCT", "KW_UNION", "KW_ENUM",
		"KW_TYPEOF", "KW_TYPEOF_UNQUAL",
		"KW___TYPEOF__", "KW___TYPEOF",
		"KW__BITINT",
	)
	chompTypeQualifier = setOf(
		"KW_CONST", "KW_VOLATILE", "KW_RESTRICT", "KW__ATOMIC",
		"KW___CONST__", "KW___CONST",
		"KW___VOLATILE__", "KW___VOLATILE",
		"KW___RESTRICT__", "KW___RESTRICT",
	)
	chompFunctionSpecifier = setOf(
		"KW_INLINE", "KW___INLINE__", "KW___INLINE",
		"KW__NORETURN",
	)
)

func setOf(names ...string) map[string]bool {
	out := make(map[string]bool, len(names))
	for _, n := range names {
		out[n] = true
	}
	return out
}

// startsNewDeclaration is true when the next token is one that starts an
// external declaration. The chomp asked this after a `}` back to depth 0,
// to tell a function body's end from a struct body's.
func startsNewDeclaration(ctx *tabnas.Context) bool {
	for i := 0; i < len(ctx.T); i++ {
		tkn := ctx.T[i]
		if tkn == nil {
			break
		}
		n := tkn.Name
		switch n {
		case "#SP", "#LN", "#CM",
			"TRIVIA_LINE_COMMENT", "TRIVIA_BLOCK_COMMENT", "TRIVIA_LINE_CONT":
			continue
		case "#ZZ", "PP_HASH", "PUNC_HASH":
			return true
		}
		if chompStorageClass[n] || chompTypeSpecKeyword[n] ||
			chompTypeQualifier[n] || chompFunctionSpecifier[n] {
			return true
		}
		switch n {
		case "KW___ATTRIBUTE__", "KW___ATTRIBUTE", "KW___DECLSPEC",
			"KW___EXTENSION__", "TYPEDEF_NAME":
			return true
		}
		return false
	}
	return false
}

// fallbackAbove are the rules above the fallback: they are not given the
// bail and the catch-all, and their refs are not wrapped.
var fallbackAbove = setOf(
	"translation_unit", "extdecl_loop", "conditional_group",
	"conditional_branch", "external_declaration", "unknown_declaration",
)

func altTokenCount(s any) int {
	switch v := s.(type) {
	case []any:
		return len(v)
	case string:
		return len(strings.Fields(v))
	}
	return 0
}

// altTakesToken: an alternate takes a token when it matches more tokens
// than it gives back.
func altTakesToken(alt map[string]any) bool {
	b := 0
	if v, ok := alt["b"]; ok {
		b = cfgInt(v)
	}
	return altTokenCount(alt["s"])-b > 0
}

// withFallback gives every rule below external_declaration the bail and
// the catch-all, puts the fence on every alternate that takes a token,
// and wraps the refs the rules use: a lifecycle action does nothing once
// the declaration has failed, and a ref that panics in an armed
// declaration fails it. It works on the grammar's parsed rule map, before
// the map becomes a GrammarSpec.
func withFallback(ruleMap map[string]any, ref map[tabnas.FuncRef]any) {
	used := map[string]bool{}
	fencedOf := map[string]string{}
	for name, rv := range ruleMap {
		if fallbackAbove[name] {
			continue
		}
		rm, ok := rv.(map[string]any)
		if !ok {
			continue
		}
		for _, state := range []string{"open", "close"} {
			arr, ok := rm[state].([]any)
			if !ok || len(arr) == 0 {
				continue
			}
			for _, item := range arr {
				alt, ok := item.(map[string]any)
				if !ok {
					continue
				}
				for _, key := range []string{"a", "c"} {
					if s, ok := alt[key].(string); ok {
						used[s] = true
					}
				}
				if altTakesToken(alt) {
					if c, ok := alt["c"].(string); ok {
						fencedOf[c+"~fenced"] = c
						alt["c"] = c + "~fenced"
					} else if alt["c"] == nil {
						alt["c"] = "@c-unfenced"
					}
				}
			}
			// A rule that catches a failure below it has its catch first,
			// and the bail after it.
			at := 0
			if first, ok := arr[0].(map[string]any); ok {
				if g, ok := first["g"].(string); ok && strings.HasPrefix(g, "catch-") {
					at = 1
				}
			}
			bail := map[string]any{"c": "@c-bailing", "g": "c-bail"}
			out := make([]any, 0, len(arr)+2)
			out = append(out, arr[:at]...)
			out = append(out, bail)
			out = append(out, arr[at:]...)
			out = append(out, map[string]any{"c": "@c-armed", "a": "@c-fail", "g": "c-fail"})
			rm[state] = out
		}
		for _, phase := range []string{"bo", "ao", "bc", "ac"} {
			used["@"+name+"-"+phase] = true
		}
	}
	for key := range used {
		fn, ok := ref[tabnas.FuncRef(key)]
		if !ok || strings.HasSuffix(key, "~fenced") {
			continue
		}
		lifecycle := strings.HasSuffix(key, "-bo") || strings.HasSuffix(key, "-ao") ||
			strings.HasSuffix(key, "-bc") || strings.HasSuffix(key, "-ac")
		ref[tabnas.FuncRef(key)] = wrapFallbackRef(fn, lifecycle)
	}
	for name, cond := range fencedOf {
		inner, _ := ref[tabnas.FuncRef(cond)].(tabnas.AltCond)
		ref[tabnas.FuncRef(name)] = tabnas.AltCond(func(r *tabnas.Rule, ctx *tabnas.Context) bool {
			if fenced(ctx) {
				return false
			}
			return inner != nil && inner(r, ctx)
		})
	}
	ref["@c-unfenced"] = tabnas.AltCond(func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		return !fenced(ctx)
	})
	ref["@c-bailing"] = tabnas.AltCond(func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		ed := edOf(ctx)
		if ed == nil {
			return false
		}
		sc := innermost(ed)
		return ed.Failed || (sc != nil && sc.Failed)
	})
	ref["@c-armed"] = tabnas.AltCond(func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		ed := edOf(ctx)
		if ed == nil || ed.Failed {
			return false
		}
		if sc := innermost(ed); sc != nil {
			return !sc.Failed
		}
		return ed.Armed
	})
	ref["@c-fail"] = tabnas.AltAction(func(_ *tabnas.Rule, ctx *tabnas.Context) {
		if ed := edOf(ctx); ed != nil {
			if sc := innermost(ed); sc != nil {
				sc.Failed = true
			} else {
				ed.Failed = true
			}
		}
	})
}

// fallbackGuard decides how a wrapped ref runs: skip is true when a
// lifecycle action must do nothing (the declaration or its scope has
// failed), and guarded when a panic must fail the declaration.
func fallbackGuard(ctx *tabnas.Context, lifecycle bool) (ed *ExtDecl, sc *LocalScope, skip, guarded bool) {
	ed = edOf(ctx)
	if ed == nil {
		return nil, nil, false, false
	}
	sc = innermost(ed)
	if lifecycle && (ed.Failed || (sc != nil && sc.Failed)) {
		return ed, sc, true, false
	}
	return ed, sc, false, ed.Armed || sc != nil
}

// failOnPanic recovers a panic in a guarded ref and fails the scope or the
// declaration with it. A parse error the engine raises is not caught.
func failOnPanic(ed *ExtDecl, sc *LocalScope) {
	p := recover()
	if p == nil {
		return
	}
	if _, isErr := p.(*tabnas.TabnasError); isErr {
		panic(p)
	}
	if sc != nil {
		sc.Failed = true
	} else {
		ed.Failed = true
	}
	ed.Crashed = p
}

func wrapFallbackRef(fn any, lifecycle bool) any {
	switch f := fn.(type) {
	case tabnas.AltCond:
		return tabnas.AltCond(func(r *tabnas.Rule, ctx *tabnas.Context) (out bool) {
			ed, sc, skip, guarded := fallbackGuard(ctx, lifecycle)
			if skip {
				return false
			}
			if guarded {
				defer failOnPanic(ed, sc)
			}
			return f(r, ctx)
		})
	case tabnas.AltAction:
		return tabnas.AltAction(func(r *tabnas.Rule, ctx *tabnas.Context) {
			ed, sc, skip, guarded := fallbackGuard(ctx, lifecycle)
			if skip {
				return
			}
			if guarded {
				defer failOnPanic(ed, sc)
			}
			f(r, ctx)
		})
	case tabnas.StateAction:
		return tabnas.StateAction(func(r *tabnas.Rule, ctx *tabnas.Context) {
			ed, sc, skip, guarded := fallbackGuard(ctx, lifecycle)
			if skip {
				return
			}
			if guarded {
				defer failOnPanic(ed, sc)
			}
			f(r, ctx)
		})
	}
	return fn
}
