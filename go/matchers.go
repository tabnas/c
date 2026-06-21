/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"regexp"
	"sort"
	"strings"

	tabnas "github.com/tabnas/parser/go"
)

// Focused lex matchers for the C parser. Port of ../ts/src/matchers.ts.
//
// Each matcher does one job. The logic lives in a pure `scan*` function
// (testable without the engine) returning (name, consumed, bad); a thin
// engine wrapper turns that into a *tabnas.Token via lex.Token / lex.Bad and
// advances the cursor. All matchers share the symbol/macro/mode state via the
// per-parse CMeta (see getMeta).

// scanResult is the outcome of a pure matcher scan.
//   name == ""           -> not my prefix (wrapper returns nil)
//   bad  != ""           -> error (wrapper returns lex.Bad(bad))
//   otherwise            -> token named `name` consuming `consumed` bytes,
//                           value = src[sI:sI+consumed]
type scanResult struct {
	name     string
	consumed int
	bad      string
}

func no() scanResult                  { return scanResult{} }
func hit(n string, c int) scanResult  { return scanResult{name: n, consumed: c} }
func bad(why string) scanResult       { return scanResult{bad: why} }

// getMeta returns the per-parse CMeta from the engine context.
func getMeta(lex *tabnas.Lex) *CMeta {
	if lex.Ctx == nil || lex.Ctx.Meta == nil {
		return nil
	}
	if m, ok := lex.Ctx.Meta["cmeta"].(*CMeta); ok {
		return m
	}
	return nil
}

// ---- char-class helpers (byte level, mirroring charCodeAt) ----

func isDigit(c byte) bool   { return c >= '0' && c <= '9' }
func isIDStart(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '$'
}
func isIDCont(c byte) bool { return isIDStart(c) || isDigit(c) }

// at returns src[i] or 0 if out of range (mirrors charCodeAt → NaN-ish guard).
func at(src string, i int) byte {
	if i < 0 || i >= len(src) {
		return 0
	}
	return src[i]
}

// ---- regexes (anchored, ported verbatim from matchers.ts) ----

var (
	intRE = regexp.MustCompile(`^(` +
		`0[xX][0-9a-fA-F](?:['0-9a-fA-F])*` + // hex
		`|0[bB][01](?:['01])*` + // binary (C23)
		`|0(?:['0-7])*` + // octal (also matches lone 0)
		`|[1-9](?:['0-9])*` + // decimal
		`)([uUlL]*[wWbBzZ]*[uUlL]*)?`)

	floatDecRE = regexp.MustCompile(`^(?:` +
		`(?:[0-9](?:['0-9])*)?\.[0-9](?:['0-9])*(?:[eE][+-]?[0-9](?:['0-9])*)?` +
		`|[0-9](?:['0-9])*\.(?:[eE][+-]?[0-9](?:['0-9])*)?` +
		`|[0-9](?:['0-9])*[eE][+-]?[0-9](?:['0-9])*` +
		`)[fFlLdD]?[fFlL]?`)

	floatHexRE = regexp.MustCompile(`^0[xX](?:` +
		`[0-9a-fA-F](?:['0-9a-fA-F])*\.(?:[0-9a-fA-F](?:['0-9a-fA-F])*)?` +
		`|\.[0-9a-fA-F](?:['0-9a-fA-F])*` +
		`|[0-9a-fA-F](?:['0-9a-fA-F])*` +
		`)[pP][+-]?[0-9](?:['0-9])*[fFlL]?`)

	charPrefixRE = regexp.MustCompile(`^(L|u8|u|U)?'`)
	strPrefixRE  = regexp.MustCompile(`^(u8|u|U|L)?(R)?"`)
	floatHasSig  = regexp.MustCompile(`[.eEpPfFlL]`)
)

// reserved is the keyword set used for identifier reclassification.
var reserved = ReservedWords

// ---- scan functions (pure) ----

// scanWhitespace: spaces/tabs/VT/FF/CR/LF; LF ends a directive (so excluded
// from the run when inDirective).
func scanWhitespace(src string, sI int, meta *CMeta) scanResult {
	if sI >= len(src) {
		return no()
	}
	c0 := src[sI]
	if c0 != 32 && c0 != 9 && c0 != 11 && c0 != 12 && c0 != 13 && c0 != 10 {
		return no()
	}
	i := sI
	for i < len(src) {
		c := src[i]
		if c == 32 || c == 9 || c == 11 || c == 12 || c == 13 {
			i++
			continue
		}
		if c == 10 {
			if meta != nil && meta.Mode.InDirective {
				break // newline ends a directive
			}
			i++
			continue
		}
		break
	}
	if i == sI {
		return no()
	}
	return hit("#SP", i-sI)
}

// scanLineCont: backslash + newline (logical-line splice), kept as trivia.
func scanLineCont(src string, sI int) scanResult {
	if at(src, sI) != '\\' {
		return no()
	}
	switch {
	case at(src, sI+1) == 10:
		return hit("TRIVIA_LINE_CONT", 2)
	case at(src, sI+1) == 13 && at(src, sI+2) == 10:
		return hit("TRIVIA_LINE_CONT", 3)
	case at(src, sI+1) == 13:
		return hit("TRIVIA_LINE_CONT", 2)
	}
	return no()
}

// scanLineComment: // ... to end of line.
func scanLineComment(src string, sI int) scanResult {
	if at(src, sI) != '/' || at(src, sI+1) != '/' {
		return no()
	}
	i := sI + 2
	for i < len(src) {
		c := src[i]
		if c == 10 || c == 13 {
			break
		}
		i++
	}
	return hit("TRIVIA_LINE_COMMENT", i-sI)
}

// scanBlockComment: /* ... */.
func scanBlockComment(src string, sI int) scanResult {
	if at(src, sI) != '/' || at(src, sI+1) != '*' {
		return no()
	}
	i := sI + 2
	for i < len(src)-1 {
		if src[i] == '*' && src[i+1] == '/' {
			return hit("TRIVIA_BLOCK_COMMENT", (i+2)-sI)
		}
		i++
	}
	return bad("unterminated_comment")
}

// atLineStart reports whether sI is preceded only by spaces/tabs since the
// last newline.
func atLineStart(src string, sI int) bool {
	i := sI - 1
	for i >= 0 {
		c := src[i]
		if c == 10 {
			return true
		}
		if c == 32 || c == 9 {
			i--
			continue
		}
		if c == 13 {
			return true
		}
		return false
	}
	return true
}

// scanPPOpen: '#' or '%:' at line start opens a directive; sets mode.
func scanPPOpen(src string, sI int, meta *CMeta) scanResult {
	c0 := at(src, sI)
	consumed := 0
	if c0 == '#' {
		consumed = 1
	} else if c0 == '%' && at(src, sI+1) == ':' {
		consumed = 2
	} else {
		return no()
	}
	if !atLineStart(src, sI) {
		return no()
	}
	if meta != nil {
		meta.Mode.InDirective = true
		meta.Mode.DirectiveName = ""
		meta.Mode.ExpectHeaderName = false
	}
	return hit("PP_HASH", consumed)
}

// scanPPNewline: newline that terminates a directive; resets mode.
func scanPPNewline(src string, sI int, meta *CMeta) scanResult {
	if meta == nil || !meta.Mode.InDirective {
		return no()
	}
	c0 := at(src, sI)
	if c0 != 10 && c0 != 13 {
		return no()
	}
	consumed := 1
	if c0 == 13 && at(src, sI+1) == 10 {
		consumed = 2
	}
	meta.Mode.InDirective = false
	meta.Mode.DirectiveName = ""
	meta.Mode.ExpectHeaderName = false
	return hit("PP_NEWLINE", consumed)
}

// scanHeaderName: <foo.h> or "foo.h" inside #include / #embed.
func scanHeaderName(src string, sI int, meta *CMeta) scanResult {
	if meta == nil || !meta.Mode.InDirective || !meta.Mode.ExpectHeaderName {
		return no()
	}
	c0 := at(src, sI)
	var closeC byte
	if c0 == '<' {
		closeC = '>'
	} else if c0 == '"' {
		closeC = '"'
	} else {
		return no()
	}
	i := sI + 1
	for i < len(src) {
		c := src[i]
		if c == 10 {
			return bad("unterminated_header_name")
		}
		if c == closeC {
			i++
			meta.Mode.ExpectHeaderName = false
			return hit("LIT_HEADER_NAME", i-sI)
		}
		i++
	}
	return bad("unterminated_header_name")
}

// scanIdentifier: ID / keyword / TYPEDEF_NAME / MACRO_NAME, with directive
// and typedef/macro reclassification. Mutates meta.mode as a side effect.
func scanIdentifier(src string, sI int, meta *CMeta) scanResult {
	if !isIDStart(at(src, sI)) {
		return no()
	}
	i := sI + 1
	for i < len(src) && isIDCont(src[i]) {
		i++
	}
	word := src[sI:i]

	// Reserved word?
	if _, ok := reserved[word]; ok {
		tname := KeywordTokenName(word)
		if meta != nil && meta.Mode.InDirective && meta.Mode.DirectiveName == "" {
			meta.Mode.DirectiveName = word
		}
		return hit(tname, i-sI)
	}

	// Inside a directive, the first identifier names the directive.
	if meta != nil && meta.Mode.InDirective && meta.Mode.DirectiveName == "" {
		meta.Mode.DirectiveName = word
		if word == "include" || word == "embed" || word == "include_next" {
			meta.Mode.ExpectHeaderName = true
		}
		return hit("ID", i-sI)
	}

	if meta != nil && !meta.Mode.InDirective && meta.Symbols.IsTypedef(word) {
		return hit("TYPEDEF_NAME", i-sI)
	}

	if meta != nil && !meta.Mode.InDirective && meta.Macros.Has(word) {
		return hit("MACRO_NAME", i-sI)
	}

	return hit("ID", i-sI)
}

// scanInteger: dec/hex/oct/binary integer with separators and suffixes.
func scanInteger(src string, sI int) scanResult {
	c0 := at(src, sI)
	if c0 < '0' || c0 > '9' {
		return no()
	}
	rest := src[sI:]
	m := intRE.FindStringSubmatch(rest)
	if m == nil {
		return no()
	}
	full := m[0]
	core := m[1]
	after := at(rest, len(full))
	isHex := strings.HasPrefix(core, "0x") || strings.HasPrefix(core, "0X")
	// Disambiguate from float: '.', 'e', 'E' after the int part defers to
	// the float matcher (except hex, where 'e' is a hex digit, not exponent).
	if after == '.' || after == 'e' || after == 'E' {
		if isHex {
			// keep the int (a trailing e is a hex digit)
		} else {
			return no()
		}
	}
	if isHex && (after == '.' || after == 'p' || after == 'P') {
		return no()
	}
	return hit("LIT_INT", len(full))
}

// scanFloat: decimal or hex floating literal.
func scanFloat(src string, sI int) scanResult {
	c0 := at(src, sI)
	c1 := at(src, sI+1)
	startsDigit := c0 >= '0' && c0 <= '9'
	startsDot := c0 == '.' && c1 >= '0' && c1 <= '9'
	if !startsDigit && !startsDot {
		return no()
	}
	rest := src[sI:]
	text := floatHexRE.FindString(rest)
	if text == "" {
		text = floatDecRE.FindString(rest)
	}
	if text == "" {
		return no()
	}
	// Reject pure integers (no dot/exp/suffix and not hex); let int take them.
	if !floatHasSig.MatchString(text) &&
		!strings.HasPrefix(text, "0x") && !strings.HasPrefix(text, "0X") {
		return no()
	}
	return hit("LIT_FLOAT", len(text))
}

// scanChar: character literal with optional encoding prefix.
func scanChar(src string, sI int) scanResult {
	rest := src[sI:]
	pm := charPrefixRE.FindString(rest)
	if pm == "" {
		return no()
	}
	i := sI + len(pm)
	for i < len(src) {
		c := src[i]
		if c == 10 {
			return bad("unterminated_char")
		}
		if c == '\\' {
			i += 2
			continue
		}
		if c == '\'' {
			i++
			return hit("LIT_CHAR", i-sI)
		}
		i++
	}
	return bad("unterminated_char")
}

// scanString: string literal with optional encoding/raw prefix.
func scanString(src string, sI int) scanResult {
	rest := src[sI:]
	pm := strPrefixRE.FindStringSubmatch(rest)
	if pm == nil {
		return no()
	}
	isRaw := pm[2] == "R"
	i := sI + len(pm[0])
	if isRaw {
		// R"delim(...)delim"
		delimEnd := i
		for delimEnd < len(src) && src[delimEnd] != '(' {
			delimEnd++
		}
		if delimEnd >= len(src) {
			return bad("unterminated_string")
		}
		delim := src[i:delimEnd]
		closer := ")" + delim + "\""
		close := strings.Index(src[delimEnd+1:], closer)
		if close < 0 {
			return bad("unterminated_string")
		}
		end := (delimEnd + 1) + close + len(closer)
		return hit("LIT_STRING", end-sI)
	}
	for i < len(src) {
		c := src[i]
		if c == 10 {
			return bad("unterminated_string")
		}
		if c == '\\' {
			i += 2
			continue
		}
		if c == '"' {
			i++
			return hit("LIT_STRING", i-sI)
		}
		i++
	}
	return bad("unterminated_string")
}

// sortedPunctuators is the punctuator catalog, longest source first.
var sortedPunctuators = func() []Punctuator {
	ps := make([]Punctuator, len(Punctuators))
	copy(ps, Punctuators)
	sort.SliceStable(ps, func(i, j int) bool {
		return len(ps[i].Src) > len(ps[j].Src)
	})
	return ps
}()

// scanPunctuator: longest-first punctuator match.
func scanPunctuator(src string, sI int) scanResult {
	for _, p := range sortedPunctuators {
		if sI+len(p.Src) <= len(src) && src[sI:sI+len(p.Src)] == p.Src {
			return hit(p.Name, len(p.Src))
		}
	}
	return no()
}

// ---- engine wrappers ----

// advancePoint advances the lex cursor by `consumed` bytes, updating row/col.
func advancePoint(pnt *tabnas.Point, src string, consumed int) {
	for i := 0; i < consumed; i++ {
		if pnt.SI+i < len(src) && src[pnt.SI+i] == '\n' {
			pnt.RI++
			pnt.CI = 1
		} else {
			pnt.CI++
		}
	}
	pnt.SI += consumed
}

// wrap turns a pure scan into an engine LexMatcher. tinByName resolves token
// names captured at plugin-init time.
func wrap(tinByName map[string]tabnas.Tin, scan func(src string, sI int, meta *CMeta) scanResult) tabnas.MakeLexMatcher {
	return func(_ *tabnas.LexConfig, _ *tabnas.Options) tabnas.LexMatcher {
		return func(lex *tabnas.Lex, _ *tabnas.Rule) *tabnas.Token {
			pnt := lex.Cursor()
			src := lex.Src
			res := scan(src, pnt.SI, getMeta(lex))
			if res.bad != "" {
				return lex.Bad(res.bad)
			}
			if res.name == "" {
				return nil
			}
			tin := tinByName[res.name]
			text := src[pnt.SI : pnt.SI+res.consumed]
			tkn := lex.Token(res.name, tin, text, text)
			advancePoint(pnt, src, res.consumed)
			return tkn
		}
	}
}

// cMatchers builds the ordered match-spec map for the C lexer. tinByName must
// contain every token name the matchers can emit (resolved via j.Token at
// plugin init). Order mirrors allMatchers() in matchers.ts (lower = first).
func cMatchers(tinByName map[string]tabnas.Tin) map[string]*tabnas.MatchSpec {
	mk := func(order int, scan func(string, int, *CMeta) scanResult) *tabnas.MatchSpec {
		return &tabnas.MatchSpec{Order: order, Make: wrap(tinByName, scan)}
	}
	// Adapters for scans that don't need meta.
	noMeta := func(f func(string, int) scanResult) func(string, int, *CMeta) scanResult {
		return func(src string, sI int, _ *CMeta) scanResult { return f(src, sI) }
	}
	return map[string]*tabnas.MatchSpec{
		"c_line_cont":     mk(100, noMeta(scanLineCont)),
		"c_block_comment": mk(110, noMeta(scanBlockComment)),
		"c_line_comment":  mk(120, noMeta(scanLineComment)),
		"c_pp_newline":    mk(130, scanPPNewline),
		"c_pp_open":       mk(140, scanPPOpen),
		"c_header_name":   mk(150, scanHeaderName),
		"c_whitespace":    mk(160, scanWhitespace),
		"c_string":        mk(200, noMeta(scanString)),
		"c_char":          mk(210, noMeta(scanChar)),
		"c_float":         mk(220, noMeta(scanFloat)),
		"c_int":           mk(230, noMeta(scanInteger)),
		"c_identifier":    mk(240, scanIdentifier),
		"c_punctuator":    mk(900, noMeta(scanPunctuator)),
	}
}
