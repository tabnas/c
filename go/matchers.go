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
// (testable without the engine) over a cut, returning (name, consumed,
// bad) and the lexer mode the token leaves; a thin engine wrapper turns
// that into a *tabnas.Token via lex.Token / lex.Bad, sets the mode and
// advances the cursor. All matchers share the symbol/macro/mode state via
// the per-parse CMeta (see getMeta).
//
// Each token is cut from the text the lexer holds: the whole source, or in
// a parse from a reader a window of it (lex.window, admin ADR-30), where
// lex.Src is the window's text and the cursor counts from the window's
// start (its row and column are the source's). A scan reads forward from
// the cursor to what ends its token, so one that stops inside the window
// gives what the whole text gives. One whose answer could change with more
// text, a scan that reaches the window's end, answers edge; the wrapper
// then asks the window for twice what it holds past the cursor (lex.Fill)
// and cuts again over the grown text. Where the window does not grow, the
// source ends there, and the cut is made with the end of the window taken
// for the end of the source (final). A long token so costs its length to
// read, not its square. In a whole text every cut is final.

// cut is what a scan reads: the text the lexer holds, the cursor in it, the
// mode the cut is made in, and whether the end of the text is the source's.
type cut struct {
	src   string
	sI    int
	meta  *CMeta
	mode  LexMode
	final bool
	// windowed: the text is a window of a source read from a reader; ri and
	// ci are the cursor's row and column in the source.
	windowed bool
	ri, ci   int
}

// short reports whether fewer than n bytes of the text lie at and past i
// while the source may have more: a scan that needs them answers edge.
func (c *cut) short(i, n int) bool {
	return !c.final && len(c.src) < i+n
}

// scanResult is the outcome of a pure matcher scan.
//
//	edge                 -> the scan read to the end of a window that may
//	                        grow: cut again over more text
//	name == ""           -> not my prefix (wrapper returns nil)
//	bad  != ""           -> error (wrapper returns lex.Bad(bad))
//	otherwise            -> token named `name` consuming `consumed` bytes,
//	                        value = src[sI:sI+consumed]; mode, if set, is
//	                        the lexer mode after it
type scanResult struct {
	name     string
	consumed int
	bad      string
	edge     bool
	mode     *LexMode
}

func no() scanResult                 { return scanResult{} }
func hit(n string, c int) scanResult { return scanResult{name: n, consumed: c} }
func bad(why string) scanResult      { return scanResult{bad: why} }
func edge() scanResult               { return scanResult{edge: true} }

// hitMode is a hit that leaves the lexer in mode m.
func hitMode(n string, c int, m LexMode) scanResult {
	return scanResult{name: n, consumed: c, mode: &m}
}

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

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
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
func scanWhitespace(c *cut) scanResult {
	src, sI := c.src, c.sI
	if sI >= len(src) {
		if c.final {
			return no()
		}
		return edge()
	}
	c0 := src[sI]
	if c0 != 32 && c0 != 9 && c0 != 11 && c0 != 12 && c0 != 13 && c0 != 10 {
		return no()
	}
	i := sI
	for i < len(src) {
		ch := src[i]
		if ch == 32 || ch == 9 || ch == 11 || ch == 12 || ch == 13 {
			i++
			continue
		}
		if ch == 10 {
			if c.mode.InDirective {
				break // newline ends a directive
			}
			i++
			continue
		}
		break
	}
	if i == len(src) && !c.final {
		return edge()
	}
	if i == sI {
		return no()
	}
	return hit("#SP", i-sI)
}

// scanLineCont: backslash + newline (logical-line splice), kept as trivia.
func scanLineCont(c *cut) scanResult {
	src, sI := c.src, c.sI
	if c.short(sI, 1) {
		return edge()
	}
	if at(src, sI) != '\\' {
		return no()
	}
	if c.short(sI, 3) {
		return edge()
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

// scanLineComment: `//` to end of line (newline not consumed).
func scanLineComment(c *cut) scanResult {
	src, sI := c.src, c.sI
	if c.short(sI, 2) {
		return edge()
	}
	if at(src, sI) != '/' || at(src, sI+1) != '/' {
		return no()
	}
	i := sI + 2
	for i < len(src) {
		ch := src[i]
		if ch == 10 || ch == 13 {
			break
		}
		i++
	}
	if i == len(src) && !c.final {
		return edge()
	}
	return hit("TRIVIA_LINE_COMMENT", i-sI)
}

// scanBlockComment: `/* ... */`; unterminated is an error.
func scanBlockComment(c *cut) scanResult {
	src, sI := c.src, c.sI
	if c.short(sI, 2) {
		return edge()
	}
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
	if !c.final {
		return edge()
	}
	return bad("unterminated_comment")
}

// atLineStart: only spaces/tabs between the previous newline (or start) and
// sI. The scan reads back through the text the lexer holds. A window keeps
// the space after the last token the parser does not ignore, so a scan that
// reaches the window's start has met that token's end: the cursor's column
// says whether a line began there (one the line's `\n` began), or else the
// directive newline that ended there did (a lone `\r`, which starts no
// column).
func atLineStart(c *cut) bool {
	src, sI := c.src, c.sI
	i := sI - 1
	for i >= 0 {
		ch := src[i]
		if ch == 10 {
			return true
		}
		if ch == 32 || ch == 9 {
			i--
			continue
		}
		if ch == 13 {
			return true
		}
		return false
	}
	if !c.windowed || c.ci-1 == sI {
		return true
	}
	end := c.mode.PPNewlineEnd
	return end[0] == c.ri && end[1] == c.ci-sI
}

// scanPPOpen: `#` or `%:` at the start of a logical line opens a directive.
func scanPPOpen(c *cut) scanResult {
	src, sI := c.src, c.sI
	if c.short(sI, 2) {
		return edge()
	}
	c0 := at(src, sI)
	consumed := 0
	if c0 == '#' {
		consumed = 1
	} else if c0 == '%' && at(src, sI+1) == ':' {
		consumed = 2
	} else {
		return no()
	}
	if !atLineStart(c) {
		return no()
	}
	m := c.mode
	m.InDirective = true
	m.DirectiveName = ""
	m.ExpectHeaderName = false
	return hitMode("PP_HASH", consumed, m)
}

// scanPPNewline: in a directive, the newline that ends it.
func scanPPNewline(c *cut) scanResult {
	if c.meta == nil || !c.mode.InDirective {
		return no()
	}
	src, sI := c.src, c.sI
	if c.short(sI, 2) {
		return edge()
	}
	c0 := at(src, sI)
	if c0 != 10 && c0 != 13 {
		return no()
	}
	consumed := 1
	if c0 == 13 && at(src, sI+1) == 10 {
		consumed = 2
	}
	ri, ci := c.ri, c.ci
	for k := 0; k < consumed; k++ {
		if src[sI+k] == 10 {
			ri++
			ci = 1
		} else {
			ci++
		}
	}
	m := c.mode
	m.InDirective = false
	m.DirectiveName = ""
	m.ExpectHeaderName = false
	m.PPNewlineEnd = [2]int{ri, ci}
	return hitMode("PP_NEWLINE", consumed, m)
}

// scanHeaderName: `<...>` or `"..."` right after #include / #embed.
func scanHeaderName(c *cut) scanResult {
	if c.meta == nil || !c.mode.InDirective || !c.mode.ExpectHeaderName {
		return no()
	}
	src, sI := c.src, c.sI
	if c.short(sI, 1) {
		return edge()
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
		ch := src[i]
		if ch == 10 {
			return bad("unterminated_header_name")
		}
		if ch == closeC {
			i++
			m := c.mode
			m.ExpectHeaderName = false
			return hitMode("LIT_HEADER_NAME", i-sI, m)
		}
		i++
	}
	if !c.final {
		return edge()
	}
	return bad("unterminated_header_name")
}

// scanIdentifier: identifier with keyword / typedef-name / macro-name /
// directive-name reclassification. Mirrors makeIdentifierMatcher.
func scanIdentifier(c *cut) scanResult {
	src, sI, meta := c.src, c.sI, c.meta
	if c.short(sI, 1) {
		return edge()
	}
	if !isIDStart(at(src, sI)) {
		return no()
	}
	i := sI + 1
	for i < len(src) && isIDCont(src[i]) {
		i++
	}
	if i == len(src) && !c.final {
		return edge()
	}
	word := src[sI:i]
	mode := c.mode

	if _, ok := reserved[word]; ok {
		tname := KeywordTokenName(word)
		if meta != nil && mode.InDirective && mode.DirectiveName == "" {
			mode.DirectiveName = word
			return hitMode(tname, i-sI, mode)
		}
		return hit(tname, i-sI)
	}

	// Inside a directive, the first identifier names the directive.
	if meta != nil && mode.InDirective && mode.DirectiveName == "" {
		mode.DirectiveName = word
		if word == "include" || word == "embed" || word == "include_next" {
			mode.ExpectHeaderName = true
		}
		return hitMode("ID", i-sI, mode)
	}

	if meta != nil && !mode.InDirective && meta.Symbols.IsTypedef(word) {
		return hit("TYPEDEF_NAME", i-sI)
	}

	if meta != nil && !mode.InDirective && meta.Macros.Has(word) {
		return hit("MACRO_NAME", i-sI)
	}

	return hit("ID", i-sI)
}

// numberRunEnd: a number's characters from sI, as a preprocessing number
// runs: a digit, or a `.` and a digit, then digits, letters, `_`, `.`, `'`,
// and a sign after an exponent's letter. A number's pattern matches within
// them and looks at most one character past its match, so a cut whose run
// reaches the window's end answers edge, and one whose run stops inside the
// window gives what the whole text gives.
func numberRunEnd(src string, sI int) int {
	i := sI
	for i < len(src) {
		ch := src[i]
		if isIDCont(ch) && ch != '$' || ch == '.' || ch == '\'' {
			i++
			continue
		}
		if (ch == '+' || ch == '-') && i > sI {
			p := src[i-1]
			if p == 'e' || p == 'E' || p == 'p' || p == 'P' {
				i++
				continue
			}
		}
		break
	}
	return i
}

// scanInteger: integer literal; defers to float when a '.', exponent or (for
// hex) 'p' follows the integer part.
func scanInteger(c *cut) scanResult {
	src, sI := c.src, c.sI
	if c.short(sI, 1) {
		return edge()
	}
	c0 := at(src, sI)
	if c0 < '0' || c0 > '9' {
		return no()
	}
	if numberRunEnd(src, sI) == len(src) && !c.final {
		return edge()
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
	if after == '.' || after == 'e' || after == 'E' {
		if isHex {
			// hex without . or p in core: a trailing 'e' is a hex digit, keep int.
		} else {
			return no()
		}
	}
	if isHex && (after == '.' || after == 'p' || after == 'P') {
		return no()
	}
	return hit("LIT_INT", len(full))
}

// scanFloat: floating literal (decimal or hex).
func scanFloat(c *cut) scanResult {
	src, sI := c.src, c.sI
	if c.short(sI, 2) {
		return edge()
	}
	c0 := at(src, sI)
	c1 := at(src, sI+1)
	startsDigit := c0 >= '0' && c0 <= '9'
	startsDot := c0 == '.' && c1 >= '0' && c1 <= '9'
	if !startsDigit && !startsDot {
		return no()
	}
	if numberRunEnd(src, sI) == len(src) && !c.final {
		return edge()
	}
	rest := src[sI:]
	text := floatHexRE.FindString(rest)
	if text == "" {
		text = floatDecRE.FindString(rest)
	}
	if text == "" {
		return no()
	}
	// Reject pure integers without dot, exponent or float suffix.
	if !floatHasSig.MatchString(text) &&
		!strings.HasPrefix(text, "0x") && !strings.HasPrefix(text, "0X") {
		return no()
	}
	return hit("LIT_FLOAT", len(text))
}

// scanChar: character literal with optional encoding prefix.
func scanChar(c *cut) scanResult {
	src, sI := c.src, c.sI
	// The longest prefix and its quote: `u8'`.
	if c.short(sI, 3) {
		return edge()
	}
	rest := src[sI:]
	pm := charPrefixRE.FindString(rest)
	if pm == "" {
		return no()
	}
	i := sI + len(pm)
	for i < len(src) {
		ch := src[i]
		if ch == 10 {
			return bad("unterminated_char")
		}
		if ch == '\\' {
			i += 2
			continue
		}
		if ch == '\'' {
			i++
			return hit("LIT_CHAR", i-sI)
		}
		i++
	}
	if !c.final {
		return edge()
	}
	return bad("unterminated_char")
}

// scanString: string literal with optional encoding prefix; raw strings
// (R"delim(...)delim") as an extension.
func scanString(c *cut) scanResult {
	src, sI := c.src, c.sI
	// The longest prefix and its quote: `u8R"`.
	if c.short(sI, 4) {
		return edge()
	}
	rest := src[sI:]
	pm := strPrefixRE.FindStringSubmatch(rest)
	if pm == nil {
		return no()
	}
	isRaw := pm[2] == "R"
	i := sI + len(pm[0])
	if isRaw {
		delimEnd := i
		for delimEnd < len(src) && src[delimEnd] != '(' {
			delimEnd++
		}
		if delimEnd >= len(src) {
			if !c.final {
				return edge()
			}
			return bad("unterminated_string")
		}
		delim := src[i:delimEnd]
		closer := ")" + delim + "\""
		close := strings.Index(src[delimEnd+1:], closer)
		if close < 0 {
			if !c.final {
				return edge()
			}
			return bad("unterminated_string")
		}
		end := (delimEnd + 1) + close + len(closer)
		return hit("LIT_STRING", end-sI)
	}
	for i < len(src) {
		ch := src[i]
		if ch == 10 {
			return bad("unterminated_string")
		}
		if ch == '\\' {
			i += 2
			continue
		}
		if ch == '"' {
			i++
			return hit("LIT_STRING", i-sI)
		}
		i++
	}
	if !c.final {
		return edge()
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

// longestPunctuator is the byte length of the longest punctuator.
var longestPunctuator = func() int {
	if len(sortedPunctuators) == 0 {
		return 0
	}
	return len(sortedPunctuators[0].Src)
}()

// scanPunctuator: longest-first punctuator match.
func scanPunctuator(c *cut) scanResult {
	src, sI := c.src, c.sI
	if c.short(sI, longestPunctuator) {
		return edge()
	}
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

// modeFor is the lexer mode for a cut at the cursor. The engine cuts a token
// again over a grown window where a read met the window's end, so a cut at
// the place the mode last changed is a cut of that token again, and it reads
// the mode the first cut found: the change is made once, whatever the number
// of cuts.
func modeFor(meta *CMeta, pnt *tabnas.Point) LexMode {
	if meta == nil || meta.Mode == nil {
		return LexMode{}
	}
	if at := meta.ModeAt; at != nil && at.ri == pnt.RI && at.ci == pnt.CI {
		*meta.Mode = at.before
	}
	return *meta.Mode
}

// wrap turns a pure scan into an engine LexMatcher. tinByName resolves token
// names captured at plugin-init time. A scan that answers edge is made again
// over a window grown to twice what it held past the cursor, until it
// answers otherwise or the window no longer grows.
func wrap(tinByName map[string]tabnas.Tin, scan func(c *cut) scanResult) tabnas.MakeLexMatcher {
	return func(_ *tabnas.LexConfig, _ *tabnas.Options) tabnas.LexMatcher {
		return func(lex *tabnas.Lex, _ *tabnas.Rule) *tabnas.Token {
			pnt := lex.Cursor()
			meta := getMeta(lex)
			c := cut{
				meta: meta, mode: modeFor(meta, pnt),
				final: !lex.Windowed(), windowed: lex.Windowed(),
				ri: pnt.RI, ci: pnt.CI,
			}
			var res scanResult
			for {
				c.src, c.sI = lex.Src, pnt.SI
				res = scan(&c)
				if !res.edge {
					break
				}
				held := len(c.src) - c.sI
				lex.Fill(max(held+1, 2*held))
				if len(lex.Src) <= len(c.src) {
					c.final = true
				}
			}
			if res.bad != "" {
				return lex.Bad(res.bad)
			}
			if res.name == "" {
				return nil
			}
			if res.mode != nil && meta != nil && meta.Mode != nil {
				meta.ModeAt = &modeAt{ri: pnt.RI, ci: pnt.CI, before: *meta.Mode}
				*meta.Mode = *res.mode
			}
			src := c.src
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
	mk := func(order int, scan func(c *cut) scanResult) *tabnas.MatchSpec {
		return &tabnas.MatchSpec{Order: order, Make: wrap(tinByName, scan)}
	}
	return map[string]*tabnas.MatchSpec{
		"c_line_cont":     mk(100, scanLineCont),
		"c_block_comment": mk(110, scanBlockComment),
		"c_line_comment":  mk(120, scanLineComment),
		"c_pp_newline":    mk(130, scanPPNewline),
		"c_pp_open":       mk(140, scanPPOpen),
		"c_header_name":   mk(150, scanHeaderName),
		"c_whitespace":    mk(160, scanWhitespace),
		"c_string":        mk(200, scanString),
		"c_char":          mk(210, scanChar),
		"c_float":         mk(220, scanFloat),
		"c_int":           mk(230, scanInteger),
		"c_identifier":    mk(240, scanIdentifier),
		"c_punctuator":    mk(900, scanPunctuator),
	}
}
