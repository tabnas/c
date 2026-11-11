/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// What an external declaration binds when it ends, read from its tokens
// (finishExternalDeclaration in refs.go): the typedef names of a run that
// starts with `typedef`, and the lookahead tokens a binding reclassifies.
// Ported from c.ts, where these helpers sit beside the plugin.

// reclassifyLookahead rewrites any already-fetched lookahead token whose src
// equals name from one token name to another, in place. Generalises
// reclassifyLookaheadTypedef for the macro define/undef paths.
func reclassifyLookahead(ctx *tabnas.Context, name, from, to string) {
	if ctx == nil || ctx.Inst == nil {
		return
	}
	fromTin := ctx.Inst.Token(from)
	toTin := ctx.Inst.Token(to)
	for _, t := range ctx.T {
		if t != nil && t.Name == from && t.Src == name && t.Tin == fromTin {
			t.Name = to
			t.Tin = toTin
		}
	}
}

// ---- typedef detection (ported from c.ts) ---------------------------

var triviaTokenNames = map[string]bool{
	"TRIVIA_LINE_COMMENT": true, "TRIVIA_BLOCK_COMMENT": true, "TRIVIA_LINE_CONT": true,
	"#SP": true, "#LN": true, "#CM": true,
}

var ptrQualifierTokenNames = map[string]bool{
	"KW_CONST": true, "KW_VOLATILE": true, "KW_RESTRICT": true, "KW__ATOMIC": true,
	"KW___CONST__": true, "KW___CONST": true,
	"KW___VOLATILE__": true, "KW___VOLATILE": true,
	"KW___RESTRICT__": true, "KW___RESTRICT": true,
}

var typeSpecKeywordNames = map[string]bool{
	"KW_VOID": true, "KW_CHAR": true, "KW_SHORT": true, "KW_INT": true,
	"KW_LONG": true, "KW_FLOAT": true, "KW_DOUBLE": true, "KW_SIGNED": true,
	"KW_UNSIGNED": true, "KW_BOOL": true, "KW__BOOL": true,
	"KW__COMPLEX": true, "KW__IMAGINARY": true,
	"KW___SIGNED__": true, "KW___SIGNED": true,
	"KW___INT8": true, "KW___INT16": true, "KW___INT32": true, "KW___INT64": true,
	"KW_STRUCT": true, "KW_UNION": true, "KW_ENUM": true,
	"KW_TYPEOF": true, "KW_TYPEOF_UNQUAL": true,
	"KW___TYPEOF__": true, "KW___TYPEOF": true,
	"KW__BITINT": true,
}

var storageClassNames = map[string]bool{
	"KW_TYPEDEF": true, "KW_EXTERN": true, "KW_STATIC": true, "KW_AUTO": true,
	"KW_REGISTER": true, "KW__THREAD_LOCAL": true, "KW_THREAD_LOCAL": true,
	"KW_CONSTEXPR": true, "KW___THREAD": true,
}

var functionSpecifierNames = map[string]bool{
	"KW_INLINE": true, "KW___INLINE__": true, "KW___INLINE": true,
	"KW__NORETURN": true,
}

func isSpecifierKw(name string) bool {
	return storageClassNames[name] || typeSpecKeywordNames[name] ||
		ptrQualifierTokenNames[name] || functionSpecifierNames[name] ||
		name == "TYPEDEF_NAME"
}

func matchClose(tokens []*tabnas.Token, from int, open, close string) int {
	depth := 0
	for i := from; i < len(tokens); i++ {
		n := tokens[i].Name
		if n == open {
			depth++
		} else if n == close {
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

func findDeclaredName(tokens []*tabnas.Token) string {
	i := 0
	for i < len(tokens) {
		t := tokens[i]
		if triviaTokenNames[t.Name] {
			i++
			continue
		}
		if t.Name == "PUNC_STAR" {
			i++
			continue
		}
		if ptrQualifierTokenNames[t.Name] {
			i++
			continue
		}
		if t.Name == "KW___ATTRIBUTE__" || t.Name == "KW___ATTRIBUTE" ||
			t.Name == "KW___ASM__" || t.Name == "KW___ASM" || t.Name == "KW_ASM" ||
			t.Name == "KW___DECLSPEC" {
			j := i + 1
			for j < len(tokens) && triviaTokenNames[tokens[j].Name] {
				j++
			}
			if j < len(tokens) && tokens[j].Name == "PUNC_LPAREN" {
				close := matchClose(tokens, j, "PUNC_LPAREN", "PUNC_RPAREN")
				if close < 0 {
					return ""
				}
				i = close + 1
				continue
			}
			i++
			continue
		}
		if t.Name == "PUNC_LPAREN" {
			close := matchClose(tokens, i, "PUNC_LPAREN", "PUNC_RPAREN")
			if close < 0 {
				return ""
			}
			inner := tokens[i+1 : close]
			var firstNonTrivia *tabnas.Token
			for _, x := range inner {
				if !triviaTokenNames[x.Name] {
					firstNonTrivia = x
					break
				}
			}
			looksLikeSubdeclarator := firstNonTrivia != nil && (firstNonTrivia.Name == "PUNC_STAR" ||
				firstNonTrivia.Name == "PUNC_LPAREN" ||
				firstNonTrivia.Name == "KW___ATTRIBUTE__" ||
				firstNonTrivia.Name == "KW___ATTRIBUTE" ||
				firstNonTrivia.Name == "ID")
			if looksLikeSubdeclarator {
				if innerName := findDeclaredName(inner); innerName != "" {
					return innerName
				}
			}
			i = close + 1
			continue
		}
		if t.Name == "PUNC_LBRACKET" {
			close := matchClose(tokens, i, "PUNC_LBRACKET", "PUNC_RBRACKET")
			if close < 0 {
				return ""
			}
			i = close + 1
			continue
		}
		if t.Name == "ID" || t.Name == "TYPEDEF_NAME" {
			return t.Src
		}
		return ""
	}
	return ""
}

func splitDeclarators(tokens []*tabnas.Token) [][]*tabnas.Token {
	var out [][]*tabnas.Token
	start := 0
	parenDepth, bracketDepth, braceDepth := 0, 0, 0
	for i := 0; i < len(tokens); i++ {
		n := tokens[i].Name
		switch n {
		case "PUNC_LPAREN":
			parenDepth++
		case "PUNC_RPAREN":
			parenDepth--
		case "PUNC_LBRACKET":
			bracketDepth++
		case "PUNC_RBRACKET":
			bracketDepth--
		case "PUNC_LBRACE":
			braceDepth++
		case "PUNC_RBRACE":
			braceDepth--
		case "PUNC_COMMA":
			if parenDepth == 0 && bracketDepth == 0 && braceDepth == 0 {
				out = append(out, tokens[start:i])
				start = i + 1
			}
		}
	}
	out = append(out, tokens[start:])
	return out
}

func declaratorPart(tokens []*tabnas.Token) []*tabnas.Token {
	parenDepth, bracketDepth := 0, 0
	for i := 0; i < len(tokens); i++ {
		n := tokens[i].Name
		switch n {
		case "PUNC_LPAREN":
			parenDepth++
		case "PUNC_RPAREN":
			parenDepth--
		case "PUNC_LBRACKET":
			bracketDepth++
		case "PUNC_RBRACKET":
			bracketDepth--
		case "PUNC_ASSIGN":
			if parenDepth == 0 && bracketDepth == 0 {
				return tokens[:i]
			}
		}
	}
	return tokens
}

func findSpecBoundary(tokens []*tabnas.Token) int {
	i := 0
	sawTypedefName := false
	for i < len(tokens) {
		t := tokens[i]
		if triviaTokenNames[t.Name] {
			i++
			continue
		}
		if t.Name == "TYPEDEF_NAME" {
			if sawTypedefName {
				return i
			}
			sawTypedefName = true
			i++
			continue
		}
		if t.Name == "KW_STRUCT" || t.Name == "KW_UNION" || t.Name == "KW_ENUM" {
			i++
			for i < len(tokens) && triviaTokenNames[tokens[i].Name] {
				i++
			}
			if i < len(tokens) && (tokens[i].Name == "ID" || tokens[i].Name == "TYPEDEF_NAME") {
				i++
			}
			for i < len(tokens) && triviaTokenNames[tokens[i].Name] {
				i++
			}
			if i < len(tokens) && tokens[i].Name == "PUNC_LBRACE" {
				close := matchClose(tokens, i, "PUNC_LBRACE", "PUNC_RBRACE")
				if close < 0 {
					return len(tokens)
				}
				i = close + 1
			}
			continue
		}
		if isSpecifierKw(t.Name) && t.Name != "TYPEDEF_NAME" {
			i++
			continue
		}
		if t.Name == "KW___ATTRIBUTE__" || t.Name == "KW___ATTRIBUTE" || t.Name == "KW___DECLSPEC" {
			i++
			for i < len(tokens) && triviaTokenNames[tokens[i].Name] {
				i++
			}
			if i < len(tokens) && tokens[i].Name == "PUNC_LPAREN" {
				close := matchClose(tokens, i, "PUNC_LPAREN", "PUNC_RPAREN")
				if close < 0 {
					return len(tokens)
				}
				i = close + 1
			}
			continue
		}
		return i
	}
	return i
}

// registerTypedefIfApplicable detects `typedef <specs> <declarators> ;` and
// binds each declared name as a typedef (and reclassifies lookahead tokens).
// Port of registerTypedefIfApplicable in c.ts.
func registerTypedefIfApplicable(tokens []*tabnas.Token, ctx *tabnas.Context) {
	var filtered []*tabnas.Token
	for _, t := range tokens {
		if !triviaTokenNames[t.Name] {
			filtered = append(filtered, t)
		}
	}
	if len(filtered) < 3 {
		return
	}
	if filtered[0].Name != "KW_TYPEDEF" {
		return
	}
	last := filtered[len(filtered)-1]
	if last.Name != "PUNC_SEMI" {
		return
	}
	body := filtered[:len(filtered)-1]
	specEnd := findSpecBoundary(body)
	if specEnd > len(body) {
		specEnd = len(body)
	}
	declList := body[specEnd:]
	if len(declList) == 0 {
		return
	}
	cm := ctxCMeta(ctx)
	for _, decl := range splitDeclarators(declList) {
		justDecl := declaratorPart(decl)
		name := findDeclaredName(justDecl)
		if name != "" {
			if cm != nil {
				cm.Symbols.BindTypedef(name)
			}
			reclassifyLookaheadTypedef(ctx, name)
		}
	}
}

// reclassifyLookaheadTypedef rewrites any already-fetched lookahead token that
// names a just-bound typedef from ID to TYPEDEF_NAME in place.
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
