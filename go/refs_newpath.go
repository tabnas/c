/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"reflect"

	tabnas "github.com/tabnas/parser/go"
)

// sameNode reports whether a and b are the same underlying map (CST node
// identity, mirroring TS `===`). Two distinct nil maps compare equal.
func sameNode(a, b CNode) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return reflect.ValueOf(a).Pointer() == reflect.ValueOf(b).Pointer()
}

// New-path structured-dispatch ref handlers. Port of the c.ts makeGrammarRefs
// region (~lines 2630-5440) covering declarations, declarators, specifiers,
// struct/union/enum + members/bitfields/enumerators, initializers, and the
// statement family. Wired by registerNewPathRefs, called from makeGrammarRefs.

// regFns bundles the local cond/action/state registrars from makeGrammarRefs.
type regFns struct {
	cond   func(string, tabnas.AltCond)
	action func(string, tabnas.AltAction)
	state  func(string, tabnas.StateAction)
}

// ---- shared helpers ----------------------------------------------------

// kStr returns the string value of r.K[key] ("" if absent).
func kStr(r *tabnas.Rule, key string) string {
	s, _ := r.K[key].(string)
	return s
}

// kNode returns r.K[key] as a CNode (nil if absent/wrong type).
func kNode(r *tabnas.Rule, key string) CNode {
	n, _ := r.K[key].(CNode)
	return n
}

// uNode returns r.U[key] as a CNode (nil if absent/wrong type).
func uNode(r *tabnas.Rule, key string) CNode {
	n, _ := r.U[key].(CNode)
	return n
}

// uBool returns the bool value of r.U[key] (false if absent).
func uBool(r *tabnas.Rule, key string) bool {
	b, _ := r.U[key].(bool)
	return b
}

// childNode returns r.Child.Node as a CNode (nil if no child / wrong type).
func childNode(r *tabnas.Rule) CNode {
	if r.Child == nil || r.Child == tabnas.NoRule {
		return nil
	}
	n, _ := r.Child.Node.(CNode)
	return n
}

// childName returns r.Child.Name ("" if no child).
func childName(r *tabnas.Rule) string {
	if r.Child == nil || r.Child == tabnas.NoRule {
		return ""
	}
	return r.Child.Name
}

// parentRule returns r.Parent (nil if NoRule).
func parentRule(r *tabnas.Rule) *tabnas.Rule {
	if r.Parent == nil || r.Parent == tabnas.NoRule {
		return nil
	}
	return r.Parent
}

// pushKids appends child CNode/token-ref to node["children"].
func pushKids(node CNode, child any) {
	node["children"] = append(node["children"].([]any), child)
}

// kidsOf returns node["children"] as []any (nil-safe).
func kidsOf(node CNode) []any {
	if node == nil {
		return nil
	}
	c, _ := node["children"].([]any)
	return c
}

// takenSet returns (creating if needed) the *tabnas.Rule set stored at r.K[key].
func takenSet(r *tabnas.Rule, key string) map[*tabnas.Rule]bool {
	if s, ok := r.K[key].(map[*tabnas.Rule]bool); ok {
		return s
	}
	s := map[*tabnas.Rule]bool{}
	r.K[key] = s
	return s
}

// takenHas reports whether r.Child is in the set at r.K[key].
func takenHas(r *tabnas.Rule, key string) bool {
	s, ok := r.K[key].(map[*tabnas.Rule]bool)
	if !ok {
		return false
	}
	return s[r.Child]
}

// stateTokOC returns r.C0 in close phase else r.O0 (TS: state==='c'?c0:o0).
func stateTokOC(r *tabnas.Rule) *tabnas.Token {
	if r.State == tabnas.CLOSE {
		return r.C0
	}
	return r.O0
}

// stateTokCO returns r.O0 in open phase else r.C0 (TS: state==='o'?o0:c0).
func stateTokCO(r *tabnas.Rule) *tabnas.Token {
	if r.State == tabnas.OPEN {
		return r.O0
	}
	return r.C0
}

// specOwnerRule locates the rule owning the per-declaration spec scaffolding.
// Port of specOwner in c.ts.
func specOwnerRule(r *tabnas.Rule) *tabnas.Rule {
	if r.Name == "simple_declaration" || r.Name == "struct_declaration" {
		return r
	}
	return r.Parent
}

// clearStmtState strips shared control-flow tracking keys. Port of
// clearStmtState in c.ts.
func clearStmtState(r *tabnas.Rule) {
	for _, k := range []string{
		"tookCond", "tookBody", "tookThen", "elseSeen", "tookElse",
		"tookWhile", "tookSemi", "tookInit", "tookIter", "tookControls",
	} {
		delete(r.K, k)
	}
}

// ---- @looks-simple-decl support ----------------------------------------

const fetchDeepCap = 256

var simpleTypeHeadSet = map[string]bool{
	"KW_VOID": true, "KW_CHAR": true, "KW_SHORT": true, "KW_INT": true, "KW_LONG": true,
	"KW_FLOAT": true, "KW_DOUBLE": true,
	"KW_SIGNED": true, "KW_UNSIGNED": true,
	"KW_BOOL": true, "KW__BOOL": true,
	"KW___SIGNED__": true, "KW___SIGNED": true,
	"KW___INT8": true, "KW___INT16": true, "KW___INT32": true, "KW___INT64": true,
	"KW__COMPLEX": true, "KW__IMAGINARY": true,
	"TYPEDEF_NAME": true,
	"KW_CONST": true, "KW_VOLATILE": true, "KW_RESTRICT": true, "KW__ATOMIC": true,
	"KW___CONST__": true, "KW___CONST": true,
	"KW___VOLATILE__": true, "KW___VOLATILE": true,
	"KW___RESTRICT__": true, "KW___RESTRICT": true,
	"KW_STRUCT": true, "KW_UNION": true, "KW_ENUM": true,
}

var storagePrefixSet = map[string]bool{
	"KW_STATIC": true, "KW_EXTERN": true, "KW_TYPEDEF": true,
	"KW_AUTO": true, "KW_REGISTER": true,
	"KW__THREAD_LOCAL": true, "KW_THREAD_LOCAL": true, "KW_CONSTEXPR": true,
	"KW___THREAD": true,
	"KW_INLINE": true, "KW___INLINE__": true, "KW___INLINE": true,
	"KW___EXTENSION__": true,
}

var unsupportedBodyTokens = map[string]bool{
	"KW_STATIC_ASSERT": true, "KW__STATIC_ASSERT": true,
	"KW_ASM": true, "KW___ASM": true, "KW___ASM__": true,
	"PP_HASH": true,
}

// fetchDeep returns the lexed token at lookahead index idx, lexing forward and
// pushing onto ctx.T as needed. Port of fetchDeep in c.ts. The Go lexer's
// Next() already skips IGNORE tokens internally.
func fetchDeep(ctx *tabnas.Context, idx int) *tabnas.Token {
	if idx >= fetchDeepCap {
		return nil
	}
	isReal := func(t *tabnas.Token) bool {
		return t != nil && t != ctx.NOTOKEN && t.Name != ""
	}
	if idx < len(ctx.T) && isReal(ctx.T[idx]) {
		return ctx.T[idx]
	}
	if ctx.Lex == nil {
		return nil
	}
	for len(ctx.T) <= idx {
		tkn := ctx.Lex.Next(ctx.Rule)
		if tkn == nil {
			return nil
		}
		ctx.T = append(ctx.T, tkn)
		if tkn.Name == "#ZZ" {
			break
		}
	}
	if idx < len(ctx.T) {
		if r := ctx.T[idx]; isReal(r) {
			return r
		}
	}
	return nil
}

// tokName returns t.Name, or "" if t is nil.
func tokName(t *tabnas.Token) string {
	if t == nil {
		return ""
	}
	return t.Name
}

// ctxTokAt returns ctx.T[i] or nil.
func ctxTokAt(ctx *tabnas.Context, i int) *tabnas.Token {
	if ctx == nil || i < 0 || i >= len(ctx.T) {
		return nil
	}
	return ctx.T[i]
}

// skipLeadingAttributes walks past leading attribute specs starting at ctx.T[i].
// Port of skipLeadingAttributes in c.ts.
func skipLeadingAttributes(ctx *tabnas.Context, i int) int {
	for {
		t := ctxTokAt(ctx, i)
		if t == nil {
			return i
		}
		if t.Name == "KW___ATTRIBUTE__" || t.Name == "KW___ATTRIBUTE" ||
			t.Name == "KW___DECLSPEC" {
			fetchBound := i + 64
			fetchAt := func(idx int) *tabnas.Token {
				if idx < len(ctx.T) {
					return ctx.T[idx]
				}
				if idx <= fetchBound {
					return fetchDeep(ctx, idx)
				}
				return nil
			}
			if tokName(fetchAt(i+1)) != "PUNC_LPAREN" {
				return i
			}
			j := i + 1
			depth := 0
			sawClose := false
			for {
				tj := fetchAt(j)
				if tj == nil {
					break
				}
				if tj.Name == "PUNC_LPAREN" {
					depth++
				} else if tj.Name == "PUNC_RPAREN" {
					depth--
					if depth == 0 {
						j++
						sawClose = true
						break
					}
				}
				j++
			}
			if !sawClose {
				return i
			}
			for k := 0; k < 8; k++ {
				fetchAt(j + k)
			}
			i = j
			continue
		}
		if t.Name == "PUNC_LBRACKET" {
			tNext := ctxTokAt(ctx, i+1)
			if tNext == nil || tNext.Name != "PUNC_LBRACKET" ||
				t.SI+len(t.Src) != tNext.SI {
				return i
			}
			fetchBound := i + 64
			fetchAt := func(idx int) *tabnas.Token {
				if idx < len(ctx.T) {
					return ctx.T[idx]
				}
				if idx <= fetchBound {
					return fetchDeep(ctx, idx)
				}
				return nil
			}
			j := i + 2
			depth := 0
			sawClose := false
			for {
				tj := fetchAt(j)
				if tj == nil {
					break
				}
				if tj.Name == "PUNC_LBRACKET" {
					depth++
				} else if tj.Name == "PUNC_RBRACKET" {
					tj1 := fetchAt(j + 1)
					if depth == 0 && tj1 != nil && tj1.Name == "PUNC_RBRACKET" &&
						tj.SI+len(tj.Src) == tj1.SI {
						j += 2
						sawClose = true
						break
					}
					depth--
				}
				j++
			}
			if !sawClose {
				return i
			}
			for k := 0; k < 8; k++ {
				fetchAt(j + k)
			}
			i = j
			continue
		}
		return i
	}
}

// skipTaggedSpec walks past a struct/union/enum specifier. Port of
// skipTaggedSpec in c.ts.
func skipTaggedSpec(ctx *tabnas.Context, i int) int {
	head := ctxTokAt(ctx, i)
	if head == nil {
		head = fetchDeep(ctx, i)
	}
	if head == nil {
		return i
	}
	if head.Name != "KW_STRUCT" && head.Name != "KW_UNION" && head.Name != "KW_ENUM" {
		return i
	}
	i++ // keyword
	i = skipLeadingAttributes(ctx, i)
	tagN := tokName(fetchDeep(ctx, i))
	if tagN == "ID" || tagN == "TYPEDEF_NAME" || tagN == "MACRO_NAME" {
		i++
	}
	if head.Name == "KW_ENUM" && tokName(fetchDeep(ctx, i)) == "PUNC_COLON" {
		i++
		for {
			n := tokName(fetchDeep(ctx, i))
			if n == "" || !simpleTypeHeadSet[n] {
				break
			}
			i++
		}
	}
	if tokName(fetchDeep(ctx, i)) == "PUNC_LBRACE" {
		depth := 0
		start := i
		for i < start+4096 {
			t := fetchDeep(ctx, i)
			if t == nil {
				break
			}
			if t.Name == "PUNC_LBRACE" {
				depth++
			} else if t.Name == "PUNC_RBRACE" {
				depth--
				if depth == 0 {
					i++
					break
				}
			}
			i++
		}
	}
	return i
}

// isFunctionBodySupported reports whether the `{...}` body at lbraceI contains
// only constructs the grammar can structure. Port of isFunctionBodySupported.
func isFunctionBodySupported(ctx *tabnas.Context, lbraceI int) bool {
	braceDepth := 0
	for i := lbraceI; i < lbraceI+4096; i++ {
		t := fetchDeep(ctx, i)
		if t == nil {
			return false
		}
		n := t.Name
		if n == "#ZZ" {
			return false
		}
		if unsupportedBodyTokens[n] {
			return false
		}
		if n == "PUNC_LBRACE" {
			braceDepth++
			continue
		}
		if n == "PUNC_RBRACE" {
			braceDepth--
			if braceDepth == 0 {
				return true
			}
			continue
		}
	}
	return false
}

// hasAttributeAt reports whether ctx.T[i] begins an attribute spec
// (GCC __attribute__/__attribute, MSVC __declspec, or C23 [[).
func hasAttributeAt(ctx *tabnas.Context, i int) bool {
	t := ctxTokAt(ctx, i)
	if t == nil {
		return false
	}
	switch t.Name {
	case "KW___ATTRIBUTE__", "KW___ATTRIBUTE", "KW___DECLSPEC":
		return true
	case "PUNC_LBRACKET":
		t2 := ctxTokAt(ctx, i+1)
		return t2 != nil && t2.Name == "PUNC_LBRACKET" && t.SI+len(t.Src) == t2.SI
	}
	return false
}

// looksSimpleDecl is @looks-simple-decl. Port of the c.ts cond.
//
// NOTE: attribute (GCC/MSVC/C23) handlers are not yet ported in this batch,
// so attribute-prefixed declarations are routed to the legacy chomp path by
// bailing here rather than skipping past the attributes.
func looksSimpleDecl(r *tabnas.Rule, ctx *tabnas.Context) bool {
	if len(kTokens(r)) > 0 {
		return false
	}
	if hasAttributeAt(ctx, 0) {
		return false
	}
	i := 0
	i = skipLeadingAttributes(ctx, i)
	if storagePrefixSet[tokName(ctxTokAt(ctx, i))] {
		i++
	}
	if hasAttributeAt(ctx, i) {
		return false
	}
	i = skipLeadingAttributes(ctx, i)
	typeStart := i
	for i < 256 {
		n := tokName(fetchDeep(ctx, i))
		if n == "" {
			break
		}
		if n == "KW_STRUCT" || n == "KW_UNION" || n == "KW_ENUM" {
			before := i
			i = skipTaggedSpec(ctx, i)
			if i == before {
				break
			}
			continue
		}
		if simpleTypeHeadSet[n] {
			i++
			continue
		}
		if n == "KW__BITINT" {
			i++
			if tokName(fetchDeep(ctx, i)) != "PUNC_LPAREN" {
				return false
			}
			d := 1
			i++
			for i < fetchDeepCap && d > 0 {
				m := tokName(fetchDeep(ctx, i))
				if m == "" {
					return false
				}
				if m == "PUNC_LPAREN" {
					d++
				} else if m == "PUNC_RPAREN" {
					d--
				}
				i++
			}
			if d != 0 {
				return false
			}
			continue
		}
		i = skipLeadingAttributes(ctx, i)
		if i != typeStart && tokName(fetchDeep(ctx, i)) == n {
			break
		}
		beforeAttr := i
		i = skipLeadingAttributes(ctx, i)
		if i == beforeAttr {
			break
		}
	}
	if i == typeStart {
		return false
	}
	if tokName(ctxTokAt(ctx, i)) == "PUNC_SEMI" {
		return true
	}
	if tokName(ctxTokAt(ctx, i)) == "PUNC_LPAREN" {
		p := i + 1
		if tokName(fetchDeep(ctx, p)) != "PUNC_STAR" {
			return false
		}
		for p < i+8 && tokName(fetchDeep(ctx, p)) == "PUNC_STAR" {
			p++
		}
		innerName := tokName(fetchDeep(ctx, p))
		if innerName != "ID" && innerName != "TYPEDEF_NAME" && innerName != "MACRO_NAME" {
			return false
		}
		p++
		for tokName(fetchDeep(ctx, p)) == "PUNC_LBRACKET" {
			bd := 1
			p++
			for p < fetchDeepCap && bd > 0 {
				n2 := tokName(fetchDeep(ctx, p))
				if n2 == "" {
					return false
				}
				if n2 == "PUNC_LBRACKET" {
					bd++
				} else if n2 == "PUNC_RBRACKET" {
					bd--
				}
				p++
			}
			if bd != 0 {
				return false
			}
		}
		if tokName(fetchDeep(ctx, p)) != "PUNC_RPAREN" {
			return false
		}
		p++
		post1 := tokName(fetchDeep(ctx, p))
		if post1 != "PUNC_LPAREN" && post1 != "PUNC_LBRACKET" {
			return false
		}
		for {
			start := tokName(fetchDeep(ctx, p))
			if start != "PUNC_LPAREN" && start != "PUNC_LBRACKET" {
				break
			}
			closer := "PUNC_RPAREN"
			if start == "PUNC_LBRACKET" {
				closer = "PUNC_RBRACKET"
			}
			depth := 0
			closed := false
			for p < fetchDeepCap {
				n2 := tokName(fetchDeep(ctx, p))
				if n2 == "" {
					return false
				}
				if n2 == start {
					depth++
				} else if n2 == closer {
					depth--
				}
				if depth == 0 && n2 != start {
					closed = true
					break
				}
				p++
			}
			if !closed {
				return false
			}
			p++
		}
		return tokName(fetchDeep(ctx, p)) == "PUNC_SEMI"
	}
	sawPointer := tokName(fetchDeep(ctx, i)) == "PUNC_STAR"
	for i < 64 {
		n := tokName(fetchDeep(ctx, i))
		if n == "PUNC_STAR" {
			i++
			continue
		}
		if n == "KW_CONST" || n == "KW_VOLATILE" || n == "KW_RESTRICT" || n == "KW__ATOMIC" {
			if !sawPointer {
				break
			}
			i++
			continue
		}
		break
	}
	idName := tokName(fetchDeep(ctx, i))
	if idName != "ID" && idName != "TYPEDEF_NAME" && idName != "MACRO_NAME" {
		return false
	}
	i++
	after := tokName(fetchDeep(ctx, i))
	if after != "PUNC_SEMI" && after != "PUNC_ASSIGN" && after != "PUNC_COMMA" &&
		after != "PUNC_LBRACKET" && after != "PUNC_LPAREN" {
		return false
	}
	if after == "PUNC_LBRACKET" {
		j := i
		for {
			depth := 0
			closed := false
			for j < 32 {
				n2 := tokName(fetchDeep(ctx, j))
				if n2 == "" {
					return false
				}
				if n2 == "PUNC_LBRACKET" {
					depth++
				} else if n2 == "PUNC_RBRACKET" {
					depth--
				}
				if depth == 0 && n2 != "PUNC_LBRACKET" {
					closed = true
					break
				}
				j++
			}
			if !closed {
				return false
			}
			next := tokName(fetchDeep(ctx, j+1))
			if next == "" {
				return false
			}
			if next != "PUNC_LBRACKET" {
				break
			}
			j++
		}
	}
	if after == "PUNC_LPAREN" {
		depth := 0
		j := i
		closed := false
		const safety = 4096
		for j < i+safety {
			n2 := tokName(fetchDeep(ctx, j))
			if n2 == "" || n2 == "#ZZ" {
				return false
			}
			if n2 == "PUNC_LPAREN" {
				depth++
			} else if n2 == "PUNC_RPAREN" {
				depth--
			}
			if depth == 0 && n2 != "PUNC_LPAREN" {
				closed = true
				break
			}
			j++
		}
		if !closed {
			return false
		}
		post := tokName(fetchDeep(ctx, j+1))
		if post != "PUNC_SEMI" && post != "PUNC_LBRACE" {
			return false
		}
		if post == "PUNC_LBRACE" {
			if !isFunctionBodySupported(ctx, j+1) {
				return false
			}
		}
	}
	return true
}
