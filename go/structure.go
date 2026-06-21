/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import tabnas "github.com/tabnas/parser/go"

// Legacy structuring post-processor. Port of ../ts/src/structure.ts (the
// recursive-descent fallback that turns an external_declaration's absorbed
// token list into a structured declaration / function_definition / statement
// CST), plus the finalizeExternalDeclaration / registerTypedefIfApplicable /
// registerMacrosFromTree / startsNewExternalDeclaration helpers ported from
// c.ts.
//
// Approach: recursive-descent over a TokenStream that hides trivia from
// grammar-level decisions but emits trivia tokens in source order as siblings
// of the next real token. Each parse* function returns a node (or nil) and
// advances the stream.
//
// KNOWN GAPS (acceptable per M5): the cast/type-name body inside expressions
// is captured as opaque tokens (no nested declarator structuring); K&R
// function definitions are captured but their declaration-list is opaque.
// These match the TS behaviour.

// ---- token-name sets ------------------------------------------------

var preservedTrivia = map[string]bool{
	"TRIVIA_LINE_COMMENT": true, "TRIVIA_BLOCK_COMMENT": true, "TRIVIA_LINE_CONT": true,
}

var storageClass = map[string]bool{
	"KW_TYPEDEF": true, "KW_EXTERN": true, "KW_STATIC": true, "KW_AUTO": true,
	"KW_REGISTER": true, "KW__THREAD_LOCAL": true, "KW_THREAD_LOCAL": true,
	"KW_CONSTEXPR": true, "KW___THREAD": true,
}

var typeQualifier = map[string]bool{
	"KW_CONST": true, "KW_VOLATILE": true, "KW_RESTRICT": true, "KW__ATOMIC": true,
	"KW___CONST__": true, "KW___CONST": true,
	"KW___VOLATILE__": true, "KW___VOLATILE": true,
	"KW___RESTRICT__": true, "KW___RESTRICT": true,
}

var functionSpecifier = map[string]bool{
	"KW_INLINE": true, "KW___INLINE__": true, "KW___INLINE": true,
	"KW__NORETURN": true,
}

var simpleTypeSpec = map[string]bool{
	"KW_VOID": true, "KW_CHAR": true, "KW_SHORT": true, "KW_INT": true,
	"KW_LONG": true, "KW_FLOAT": true, "KW_DOUBLE": true, "KW_SIGNED": true,
	"KW_UNSIGNED": true, "KW_BOOL": true, "KW__BOOL": true,
	"KW__COMPLEX": true, "KW__IMAGINARY": true,
	"KW___SIGNED__": true, "KW___SIGNED": true,
	"KW___INT8": true, "KW___INT16": true, "KW___INT32": true, "KW___INT64": true,
}

var attributeOpeners = map[string]bool{
	"KW___ATTRIBUTE__": true, "KW___ATTRIBUTE": true, "KW___DECLSPEC": true,
}

func isIdLike(name string) bool {
	return name == "ID" || name == "MACRO_NAME"
}

func isSpecifierStart(name string) bool {
	return storageClass[name] || typeQualifier[name] || functionSpecifier[name] ||
		simpleTypeSpec[name] || attributeOpeners[name] ||
		name == "KW_STRUCT" || name == "KW_UNION" || name == "KW_ENUM" ||
		name == "KW_TYPEOF" || name == "KW_TYPEOF_UNQUAL" ||
		name == "KW___TYPEOF__" || name == "KW___TYPEOF" ||
		name == "KW__BITINT" ||
		name == "KW_ALIGNAS" || name == "KW__ALIGNAS" ||
		name == "KW___EXTENSION__" ||
		name == "TYPEDEF_NAME"
}

// ---- TokenStream ----------------------------------------------------

// TokenStream is a recursive-descent cursor over a token slice that hides
// preserved trivia from grammar decisions but emits it in order on take.
type TokenStream struct {
	tokens []*tabnas.Token
	i      int
}

// NewTokenStream builds a stream over toks.
func NewTokenStream(toks []*tabnas.Token) *TokenStream {
	return &TokenStream{tokens: toks}
}

// peek returns the off-th non-trivia token ahead, or nil.
func (ts *TokenStream) peek(off ...int) *tabnas.Token {
	target := 0
	if len(off) > 0 {
		target = off[0]
	}
	i := ts.i
	seen := 0
	for i < len(ts.tokens) {
		t := ts.tokens[i]
		if preservedTrivia[t.Name] {
			i++
			continue
		}
		if seen == target {
			return t
		}
		seen++
		i++
	}
	return nil
}

// peekName returns the off-th non-trivia token name, or "".
func (ts *TokenStream) peekName(off ...int) string {
	t := ts.peek(off...)
	if t == nil {
		return ""
	}
	return t.Name
}

func (ts *TokenStream) done() bool { return ts.peek() == nil }

// taken bundles the trivia refs, the real token, and its ref.
type taken struct {
	trivia []any
	tkn    *tabnas.Token
	ref    map[string]any
}

// take consumes the next real token along with preceding trivia.
func (ts *TokenStream) take() *taken {
	var trivia []any
	for ts.i < len(ts.tokens) {
		t := ts.tokens[ts.i]
		if preservedTrivia[t.Name] {
			trivia = append(trivia, tokenRef(t))
			ts.i++
			continue
		}
		ts.i++
		return &taken{trivia: trivia, tkn: t, ref: tokenRef(t)}
	}
	return nil
}

// takeInto pushes trivia + the real token onto node and returns the token.
func (ts *TokenStream) takeInto(node CNode) *tabnas.Token {
	t := ts.take()
	if t == nil {
		return nil
	}
	for _, tr := range t.trivia {
		appendChild(node, tr)
	}
	appendChild(node, t.ref)
	return t.tkn
}

func (ts *TokenStream) mark() int     { return ts.i }
func (ts *TokenStream) restore(m int) { ts.i = m }

// ---- balanced punctuator skipping -----------------------------------

func consumeBalanced(ts *TokenStream, node CNode, open, close string) bool {
	if ts.peekName() != open {
		return false
	}
	ts.takeInto(node)
	depth := 1
	for depth > 0 && !ts.done() {
		n := ts.peekName()
		if n == open {
			depth++
		} else if n == close {
			depth--
		}
		ts.takeInto(node)
	}
	return depth == 0
}

// childrenLen returns len(node["children"]).
func childrenLen(node CNode) int {
	c, _ := node["children"].([]any)
	return len(c)
}

// ---- specifier parsing ----------------------------------------------

func parseDeclarationSpecifiers(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	c23Head := isC23AttributeOpen(ts)
	if !isSpecifierStart(startTkn.Name) && !c23Head {
		return nil
	}
	node := makeNode("declaration_specifiers", tokenSpan(startTkn))
	sawTypedefName := false

	for {
		tkn := ts.peek()
		if tkn == nil {
			break
		}
		n := tkn.Name

		if n == "TYPEDEF_NAME" {
			if sawTypedefName {
				break
			}
			sawTypedefName = true
			ts.takeInto(node)
			continue
		}
		if storageClass[n] || typeQualifier[n] || functionSpecifier[n] ||
			simpleTypeSpec[n] || n == "KW___EXTENSION__" ||
			n == "KW_TYPEOF" || n == "KW_TYPEOF_UNQUAL" ||
			n == "KW___TYPEOF__" || n == "KW___TYPEOF" ||
			n == "KW__BITINT" ||
			n == "KW_ALIGNAS" || n == "KW__ALIGNAS" {
			ts.takeInto(node)
			if (n == "KW_TYPEOF" || n == "KW_TYPEOF_UNQUAL" ||
				n == "KW___TYPEOF__" || n == "KW___TYPEOF" ||
				n == "KW__BITINT" ||
				n == "KW_ALIGNAS" || n == "KW__ALIGNAS") &&
				ts.peekName() == "PUNC_LPAREN" {
				consumeBalanced(ts, node, "PUNC_LPAREN", "PUNC_RPAREN")
			}
			continue
		}
		if attributeOpeners[n] {
			attr := parseAttributeSpec(ts)
			if attr != nil {
				appendChild(node, attr)
			} else {
				ts.takeInto(node)
			}
			continue
		}
		if isC23AttributeOpen(ts) {
			attr := parseC23AttributeSpec(ts)
			if attr != nil {
				appendChild(node, attr)
			} else {
				ts.takeInto(node)
			}
			continue
		}
		if n == "KW_STRUCT" || n == "KW_UNION" {
			sus := parseStructOrUnionSpec(ts)
			if sus != nil {
				appendChild(node, sus)
			}
			continue
		}
		if n == "KW_ENUM" {
			en := parseEnumSpec(ts)
			if en != nil {
				appendChild(node, en)
			}
			continue
		}
		break
	}

	if childrenLen(node) == 0 {
		return nil
	}
	return node
}

func isC23AttributeOpen(ts *TokenStream) bool {
	a := ts.peek()
	b := ts.peek(1)
	if a == nil || b == nil {
		return false
	}
	if a.Name != "PUNC_LBRACKET" || b.Name != "PUNC_LBRACKET" {
		return false
	}
	return a.SI+len(a.Src) == b.SI
}

func isC23AttributeClose(ts *TokenStream) bool {
	a := ts.peek()
	b := ts.peek(1)
	if a == nil || b == nil {
		return false
	}
	if a.Name != "PUNC_RBRACKET" || b.Name != "PUNC_RBRACKET" {
		return false
	}
	return a.SI+len(a.Src) == b.SI
}

func parseC23AttributeSpec(ts *TokenStream) CNode {
	if !isC23AttributeOpen(ts) {
		return nil
	}
	startTkn := ts.peek()
	node := makeNode("attribute_spec", tokenSpan(startTkn))
	node["attributeForm"] = "c23"
	items := []any{}
	ts.takeInto(node) // first '['
	ts.takeInto(node) // second '['

	for !ts.done() {
		if isC23AttributeClose(ts) {
			ts.takeInto(node)
			ts.takeInto(node)
			break
		}
		if ts.peekName() == "PUNC_COMMA" {
			ts.takeInto(node)
			continue
		}
		item := parseAttributeItem(ts)
		if item != nil {
			appendChild(node, item)
			items = append(items, item)
		} else {
			ts.takeInto(node)
		}
	}
	node["items"] = items
	return node
}

func parseAnyAttributeSpec(ts *TokenStream) CNode {
	head := ts.peek()
	if head == nil {
		return nil
	}
	if attributeOpeners[head.Name] {
		return parseAttributeSpec(ts)
	}
	if isC23AttributeOpen(ts) {
		return parseC23AttributeSpec(ts)
	}
	return nil
}

func parseAttributeSpec(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil || !attributeOpeners[startTkn.Name] {
		return nil
	}
	node := makeNode("attribute_spec", tokenSpan(startTkn))
	switch {
	case hasPrefix(startTkn.Src, "__attribute"):
		node["attributeForm"] = "gcc"
	case startTkn.Src == "__declspec":
		node["attributeForm"] = "msvc"
	default:
		node["attributeForm"] = "unknown"
	}
	ts.takeInto(node) // __attribute__ / __declspec / __attribute

	if ts.peekName() != "PUNC_LPAREN" {
		return node
	}
	ts.takeInto(node) // outer '('

	needsCloseOuter := false
	if node["attributeForm"] == "gcc" && ts.peekName() == "PUNC_LPAREN" {
		ts.takeInto(node) // inner '('
		needsCloseOuter = true
	}

	items := []any{}
	for !ts.done() && ts.peekName() != "PUNC_RPAREN" {
		if ts.peekName() == "PUNC_COMMA" {
			ts.takeInto(node)
			continue
		}
		item := parseAttributeItem(ts)
		if item != nil {
			appendChild(node, item)
			items = append(items, item)
		} else {
			ts.takeInto(node)
		}
	}
	node["items"] = items

	if ts.peekName() == "PUNC_RPAREN" {
		ts.takeInto(node)
	}
	if needsCloseOuter && ts.peekName() == "PUNC_RPAREN" {
		ts.takeInto(node)
	}
	return node
}

func parseAttributeItem(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	nameOk := startTkn.Name == "ID" || startTkn.Name == "TYPEDEF_NAME" ||
		startTkn.Name == "MACRO_NAME" || hasPrefix(startTkn.Name, "KW_")
	if !nameOk {
		return nil
	}
	node := makeNode("attribute_item", tokenSpan(startTkn))
	nameTaken := ts.take()
	for _, tr := range nameTaken.trivia {
		appendChild(node, tr)
	}
	appendChild(node, nameTaken.ref)
	node["attributeName"] = nameTaken.tkn.Src

	if ts.peekName() == "PUNC_COLON" && ts.peekName(1) == "PUNC_COLON" {
		ts.takeInto(node)
		ts.takeInto(node)
		tail := ts.peek()
		if tail != nil && (tail.Name == "ID" || tail.Name == "TYPEDEF_NAME" ||
			tail.Name == "MACRO_NAME" || hasPrefix(tail.Name, "KW_")) {
			t := ts.take()
			for _, tr := range t.trivia {
				appendChild(node, tr)
			}
			appendChild(node, t.ref)
			node["attributePrefix"] = node["attributeName"]
			node["attributeName"] = t.tkn.Src
		}
	}

	if ts.peekName() == "PUNC_LPAREN" {
		args := makeNode("attribute_argument_list", tokenSpan(ts.peek()))
		ts.takeInto(args) // '('
		for !ts.done() && ts.peekName() != "PUNC_RPAREN" {
			a := parseExpression(ts, map[string]bool{"PUNC_COMMA": true, "PUNC_RPAREN": true})
			if a != nil {
				appendChild(args, a)
			} else {
				ts.takeInto(args)
			}
			if ts.peekName() == "PUNC_COMMA" {
				ts.takeInto(args)
			}
		}
		if ts.peekName() == "PUNC_RPAREN" {
			ts.takeInto(args)
		}
		appendChild(node, args)
		node["argumentList"] = args
	}

	return node
}

func parseStructOrUnionSpec(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil || (startTkn.Name != "KW_STRUCT" && startTkn.Name != "KW_UNION") {
		return nil
	}
	kind := "union_specifier"
	if startTkn.Name == "KW_STRUCT" {
		kind = "struct_specifier"
	}
	node := makeNode(kind, tokenSpan(startTkn))
	ts.takeInto(node) // 'struct' or 'union'

	for ts.peek() != nil && attributeOpeners[ts.peekName()] {
		a := parseAttributeSpec(ts)
		if a != nil {
			appendChild(node, a)
		}
	}

	next := ts.peek()
	if next != nil && (isIdLike(next.Name) || next.Name == "TYPEDEF_NAME") {
		t := ts.take()
		for _, tr := range t.trivia {
			appendChild(node, tr)
		}
		appendChild(node, t.ref)
		node["tagName"] = t.tkn.Src
	}

	if ts.peekName() == "PUNC_LBRACE" {
		body := makeNode("member_decl_list", tokenSpan(ts.peek()))
		ts.takeInto(body) // '{'
		for !ts.done() && ts.peekName() != "PUNC_RBRACE" {
			member := parseStructDeclaration(ts)
			if member != nil {
				appendChild(body, member)
			} else {
				ts.takeInto(body)
			}
		}
		if ts.peekName() == "PUNC_RBRACE" {
			ts.takeInto(body)
		}
		appendChild(node, body)
	}

	return node
}

func parseStructDeclaration(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	n0 := startTkn.Name
	if n0 == "KW_STATIC_ASSERT" || n0 == "KW__STATIC_ASSERT" {
		return parseStaticAssertDeclaration(ts)
	}
	if n0 == "PUNC_SEMI" {
		empty := makeNode("struct_declaration", tokenSpan(startTkn))
		ts.takeInto(empty)
		return empty
	}

	node := makeNode("struct_declaration", tokenSpan(startTkn))
	sql := parseDeclarationSpecifiers(ts)
	if sql != nil {
		sql["kind"] = "specifier_qualifier_list"
		appendChild(node, sql)
	}

	if ts.peekName() != "PUNC_SEMI" && !ts.done() {
		sdl := parseStructDeclaratorList(ts)
		if sdl != nil {
			appendChild(node, sdl)
		}
	}

	if ts.peekName() == "PUNC_SEMI" {
		ts.takeInto(node)
	}
	return node
}

func parseStructDeclaratorList(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("struct_declarator_list", tokenSpan(startTkn))
	first := parseStructDeclarator(ts)
	if first == nil {
		return nil
	}
	appendChild(node, first)
	for ts.peekName() == "PUNC_COMMA" {
		ts.takeInto(node)
		next := parseStructDeclarator(ts)
		if next == nil {
			break
		}
		appendChild(node, next)
	}
	return node
}

func parseStructDeclarator(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("struct_declarator", tokenSpan(startTkn))

	if ts.peekName() != "PUNC_COLON" {
		d := parseDeclarator(ts, false)
		if d != nil {
			appendChild(node, d)
			if name, ok := d["declaredName"]; ok {
				node["declaredName"] = name
			}
		}
	}

	if ts.peekName() == "PUNC_COLON" {
		bf := makeNode("bitfield_width", tokenSpan(ts.peek()))
		ts.takeInto(bf) // ':'
		parenD, bracketD := 0, 0
		for !ts.done() {
			n := ts.peekName()
			if n == "PUNC_LPAREN" {
				parenD++
				ts.takeInto(bf)
				continue
			}
			if n == "PUNC_RPAREN" {
				if parenD == 0 {
					break
				}
				parenD--
				ts.takeInto(bf)
				continue
			}
			if n == "PUNC_LBRACKET" {
				bracketD++
				ts.takeInto(bf)
				continue
			}
			if n == "PUNC_RBRACKET" {
				if bracketD == 0 {
					break
				}
				bracketD--
				ts.takeInto(bf)
				continue
			}
			if parenD == 0 && bracketD == 0 && (n == "PUNC_COMMA" || n == "PUNC_SEMI") {
				break
			}
			ts.takeInto(bf)
		}
		appendChild(node, bf)
	}

	for ts.peek() != nil && attributeOpeners[ts.peekName()] {
		a := parseAttributeSpec(ts)
		if a != nil {
			appendChild(node, a)
		} else {
			break
		}
	}

	if childrenLen(node) > 0 {
		return node
	}
	return nil
}

func parseEnumSpec(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil || startTkn.Name != "KW_ENUM" {
		return nil
	}
	node := makeNode("enum_specifier", tokenSpan(startTkn))
	ts.takeInto(node) // 'enum'

	for ts.peek() != nil && attributeOpeners[ts.peekName()] {
		a := parseAttributeSpec(ts)
		if a != nil {
			appendChild(node, a)
		}
	}

	next := ts.peek()
	if next != nil && (isIdLike(next.Name) || next.Name == "TYPEDEF_NAME") {
		t := ts.take()
		for _, tr := range t.trivia {
			appendChild(node, tr)
		}
		appendChild(node, t.ref)
		node["tagName"] = t.tkn.Src
	}

	if ts.peekName() == "PUNC_COLON" {
		ts.takeInto(node)
		ts2 := parseDeclarationSpecifiers(ts)
		if ts2 != nil {
			appendChild(node, ts2)
		}
	}

	if ts.peekName() == "PUNC_LBRACE" {
		body := makeNode("enumerator_list", tokenSpan(ts.peek()))
		ts.takeInto(body) // '{'
		for !ts.done() && ts.peekName() != "PUNC_RBRACE" {
			e := parseEnumerator(ts)
			if e != nil {
				appendChild(body, e)
			} else {
				ts.takeInto(body)
			}
			if ts.peekName() == "PUNC_COMMA" {
				ts.takeInto(body)
			}
		}
		if ts.peekName() == "PUNC_RBRACE" {
			ts.takeInto(body)
		}
		appendChild(node, body)
	}

	return node
}

func parseEnumerator(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	n := startTkn.Name
	if n != "ID" && n != "TYPEDEF_NAME" && n != "MACRO_NAME" {
		return nil
	}
	node := makeNode("enumerator", tokenSpan(startTkn))
	t := ts.take()
	for _, tr := range t.trivia {
		appendChild(node, tr)
	}
	appendChild(node, t.ref)
	node["declaredName"] = t.tkn.Src

	for {
		a := parseAnyAttributeSpec(ts)
		if a == nil {
			break
		}
		appendChild(node, a)
	}

	if ts.peekName() == "PUNC_ASSIGN" {
		ts.takeInto(node) // '='
		spanTkn := ts.peek()
		if spanTkn == nil {
			spanTkn = startTkn
		}
		initN := makeNode("initializer", tokenSpan(spanTkn))
		parenD, bracketD := 0, 0
		for !ts.done() {
			nn := ts.peekName()
			if nn == "PUNC_LPAREN" {
				parenD++
				ts.takeInto(initN)
				continue
			}
			if nn == "PUNC_RPAREN" {
				if parenD == 0 {
					break
				}
				parenD--
				ts.takeInto(initN)
				continue
			}
			if nn == "PUNC_LBRACKET" {
				bracketD++
				ts.takeInto(initN)
				continue
			}
			if nn == "PUNC_RBRACKET" {
				if bracketD == 0 {
					break
				}
				bracketD--
				ts.takeInto(initN)
				continue
			}
			if parenD == 0 && bracketD == 0 && (nn == "PUNC_COMMA" || nn == "PUNC_RBRACE") {
				break
			}
			ts.takeInto(initN)
		}
		appendChild(node, initN)
	}
	return node
}

// ---- declarator parsing ---------------------------------------------

func parseDeclarator(ts *TokenStream, abstract bool) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	kind := "declarator"
	if abstract {
		kind = "abstract_declarator"
	}
	node := makeNode(kind, tokenSpan(startTkn))

	for ts.peekName() == "PUNC_STAR" {
		ptr := makeNode("pointer", tokenSpan(ts.peek()))
		ts.takeInto(ptr) // '*'
		for {
			n := ts.peekName()
			if n != "" && (typeQualifier[n] ||
				n == "KW___PTR32" || n == "KW___PTR64" || n == "KW___UNALIGNED") {
				ts.takeInto(ptr)
				continue
			}
			if n != "" && attributeOpeners[n] {
				a := parseAttributeSpec(ts)
				if a != nil {
					appendChild(ptr, a)
				} else {
					break
				}
				continue
			}
			break
		}
		appendChild(node, ptr)
	}

	dd := parseDirectDeclarator(ts, abstract)
	if dd == nil {
		if abstract && childrenLen(node) > 0 {
			return node
		}
		if childrenLen(node) > 0 {
			return node
		}
		return nil
	}
	appendChild(node, dd)
	if name, ok := dd["declaredName"]; ok {
		node["declaredName"] = name
	}
	return node
}

func parseDirectDeclarator(ts *TokenStream, abstract bool) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	kind := "direct_declarator"
	if abstract {
		kind = "direct_abstract_declarator"
	}
	node := makeNode(kind, tokenSpan(startTkn))

	n0 := ts.peekName()
	if isIdLike(n0) {
		t := ts.take()
		for _, tr := range t.trivia {
			appendChild(node, tr)
		}
		appendChild(node, t.ref)
		node["declaredName"] = t.tkn.Src
	} else if n0 == "PUNC_LPAREN" {
		m := ts.mark()
		ts.takeInto(node) // '('
		inner := ts.peek()
		if inner != nil && (inner.Name == "PUNC_STAR" || inner.Name == "PUNC_LPAREN" ||
			isIdLike(inner.Name) || attributeOpeners[inner.Name]) {
			sub := parseDeclarator(ts, abstract)
			if sub != nil {
				appendChild(node, sub)
				if name, ok := sub["declaredName"]; ok {
					node["declaredName"] = name
				}
			}
			if ts.peekName() == "PUNC_RPAREN" {
				ts.takeInto(node)
			}
		} else {
			ts.restore(m)
		}
	} else if !abstract {
		return nil
	}

	for !ts.done() {
		n := ts.peekName()
		if n == "PUNC_LBRACKET" {
			arr := makeNode("array_postfix", tokenSpan(ts.peek()))
			consumeBalanced(ts, arr, "PUNC_LBRACKET", "PUNC_RBRACKET")
			appendChild(node, arr)
			continue
		}
		if n == "PUNC_LPAREN" {
			fn := parseFunctionPostfix(ts)
			if fn != nil {
				appendChild(node, fn)
			}
			continue
		}
		break
	}

	if childrenLen(node) == 0 && !abstract {
		return nil
	}
	return node
}

func parseFunctionPostfix(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil || startTkn.Name != "PUNC_LPAREN" {
		return nil
	}
	node := makeNode("function_postfix", tokenSpan(startTkn))
	ts.takeInto(node) // '('

	if ts.peekName() == "PUNC_RPAREN" {
		ts.takeInto(node)
		return node
	}

	if ts.peekName() == "KW_VOID" && ts.peekName(1) == "PUNC_RPAREN" {
		ptl := makeNode("parameter_type_list", tokenSpan(ts.peek()))
		voidParam := makeNode("parameter_declaration", tokenSpan(ts.peek()))
		voidSpec := makeNode("declaration_specifiers", tokenSpan(ts.peek()))
		appendChild(voidParam, voidSpec)
		ts.takeInto(voidSpec) // 'void'
		appendChild(ptl, voidParam)
		appendChild(node, ptl)
		ts.takeInto(node) // ')'
		return node
	}

	if looksLikeKRIdentifierList(ts) {
		list := makeNode("identifier_list", tokenSpan(ts.peek()))
		for !ts.done() && ts.peekName() != "PUNC_RPAREN" {
			ts.takeInto(list)
		}
		appendChild(node, list)
		if ts.peekName() == "PUNC_RPAREN" {
			ts.takeInto(node)
		}
		return node
	}

	ptl := makeNode("parameter_type_list", tokenSpan(ts.peek()))
	for !ts.done() && ts.peekName() != "PUNC_RPAREN" {
		if ts.peekName() == "PUNC_ELLIPSIS" {
			ell := makeNode("parameter_variadic", tokenSpan(ts.peek()))
			ts.takeInto(ell)
			appendChild(ptl, ell)
			ptl["variadic"] = true
			break
		}
		p := parseParameterDeclaration(ts)
		if p != nil {
			appendChild(ptl, p)
		} else {
			ts.takeInto(ptl)
		}
		if ts.peekName() == "PUNC_COMMA" {
			ts.takeInto(ptl)
		}
	}
	appendChild(node, ptl)
	if ts.peekName() == "PUNC_RPAREN" {
		ts.takeInto(node)
	}
	return node
}

func looksLikeKRIdentifierList(ts *TokenStream) bool {
	i := 0
	expectId := true
	for {
		t := ts.peek(i)
		if t == nil {
			return false
		}
		n := t.Name
		if expectId {
			if !isIdLike(n) {
				return false
			}
			expectId = false
		} else {
			if n == "PUNC_RPAREN" {
				return i > 0
			}
			if n == "PUNC_COMMA" {
				expectId = true
			} else {
				return false
			}
		}
		i++
		if i > 256 {
			return false
		}
	}
}

func parseParameterDeclaration(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("parameter_declaration", tokenSpan(startTkn))
	specs := parseDeclarationSpecifiers(ts)
	if specs != nil {
		appendChild(node, specs)
	}

	next := ts.peekName()
	if next == "PUNC_COMMA" || next == "PUNC_RPAREN" || next == "" {
		if childrenLen(node) > 0 {
			return node
		}
		return nil
	}

	m := ts.mark()
	d := parseDeclarator(ts, false)
	if d == nil || (d["declaredName"] == nil && findKind(d, "declaredName") == nil) {
		ts.restore(m)
		d = parseDeclarator(ts, true)
	}
	if d != nil {
		appendChild(node, d)
		if name, ok := d["declaredName"]; ok {
			node["declaredName"] = name
		}
	}
	if childrenLen(node) > 0 {
		return node
	}
	return nil
}

// findKind searches node (recursively) for the first node having the given key.
func findKind(node any, key string) CNode {
	m, ok := node.(map[string]any)
	if !ok {
		return nil
	}
	if _, has := m[key]; has {
		return m
	}
	if children, ok := m["children"].([]any); ok {
		for _, c := range children {
			if hit := findKind(c, key); hit != nil {
				return hit
			}
		}
	}
	return nil
}

// ---- init-declarator-list -------------------------------------------

func parseInitDeclaratorList(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("init_declarator_list", tokenSpan(startTkn))

	first := parseInitDeclarator(ts)
	if first == nil {
		return nil
	}
	appendChild(node, first)

	for ts.peekName() == "PUNC_COMMA" {
		ts.takeInto(node) // ','
		next := parseInitDeclarator(ts)
		if next == nil {
			break
		}
		appendChild(node, next)
	}
	return node
}

func parseInitDeclarator(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	decl := parseDeclarator(ts, false)
	if decl == nil {
		return nil
	}
	node := makeNode("init_declarator", tokenSpan(startTkn))
	appendChild(node, decl)
	if name, ok := decl["declaredName"]; ok {
		node["declaredName"] = name
	}

	for {
		n := ts.peekName()
		if n == "" {
			break
		}
		if n == "KW___ASM__" || n == "KW___ASM" || n == "KW_ASM" {
			asmNode := makeNode("asm_label", tokenSpan(ts.peek()))
			ts.takeInto(asmNode)
			if ts.peekName() == "PUNC_LPAREN" {
				consumeBalanced(ts, asmNode, "PUNC_LPAREN", "PUNC_RPAREN")
			}
			appendChild(node, asmNode)
			continue
		}
		if attributeOpeners[n] {
			a := parseAttributeSpec(ts)
			if a != nil {
				appendChild(node, a)
			} else {
				break
			}
			continue
		}
		break
	}

	if ts.peekName() == "PUNC_ASSIGN" {
		ts.takeInto(node) // '='
		initN := parseInitializer(ts)
		if initN != nil {
			appendChild(node, initN)
		}
	}
	return node
}

// ---- initializers ---------------------------------------------------

func parseInitializer(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("initializer", tokenSpan(startTkn))
	if ts.peekName() == "PUNC_LBRACE" {
		il := parseInitializerList(ts)
		if il != nil {
			appendChild(node, il)
		}
		return node
	}
	expr := parseExpression(ts, map[string]bool{"PUNC_COMMA": true, "PUNC_SEMI": true, "PUNC_RBRACE": true})
	if expr != nil {
		appendChild(node, expr)
	}
	return node
}

func parseInitializerList(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil || startTkn.Name != "PUNC_LBRACE" {
		return nil
	}
	node := makeNode("initializer_list", tokenSpan(startTkn))
	ts.takeInto(node) // '{'
	for !ts.done() && ts.peekName() != "PUNC_RBRACE" {
		item := parseInitializerItem(ts)
		if item != nil {
			appendChild(node, item)
		} else {
			ts.takeInto(node)
		}
		if ts.peekName() == "PUNC_COMMA" {
			ts.takeInto(node)
		}
	}
	if ts.peekName() == "PUNC_RBRACE" {
		ts.takeInto(node)
	}
	return node
}

func parseInitializerItem(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("initializer_item", tokenSpan(startTkn))

	if ts.peekName() == "PUNC_DOT" || ts.peekName() == "PUNC_LBRACKET" {
		desig := parseDesignation(ts)
		if desig != nil {
			appendChild(node, desig)
			node["designation"] = desig
		}
	}

	if ts.peekName() == "PUNC_LBRACE" {
		sub := parseInitializerList(ts)
		if sub != nil {
			initN := makeNode("initializer", spanFromNode(sub))
			appendChild(initN, sub)
			appendChild(node, initN)
			node["value"] = initN
		}
	} else {
		expr := parseExpression(ts, map[string]bool{"PUNC_COMMA": true, "PUNC_RBRACE": true})
		if expr != nil {
			appendChild(node, expr)
			node["value"] = expr
		}
	}
	if childrenLen(node) > 0 {
		return node
	}
	return nil
}

func parseStaticAssertDeclaration(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("static_assert_declaration", tokenSpan(startTkn))
	ts.takeInto(node) // 'static_assert' / '_Static_assert'
	if ts.peekName() != "PUNC_LPAREN" {
		if ts.peekName() == "PUNC_SEMI" {
			ts.takeInto(node)
		}
		return node
	}
	ts.takeInto(node) // '('
	cond := parseExpression(ts, map[string]bool{"PUNC_COMMA": true, "PUNC_RPAREN": true})
	if cond != nil {
		appendChild(node, cond)
		node["condition"] = cond
	}
	if ts.peekName() == "PUNC_COMMA" {
		ts.takeInto(node) // ','
		msg := parseExpression(ts, map[string]bool{"PUNC_RPAREN": true})
		if msg != nil {
			appendChild(node, msg)
			node["message"] = msg
		}
	}
	if ts.peekName() == "PUNC_RPAREN" {
		ts.takeInto(node)
	}
	if ts.peekName() == "PUNC_SEMI" {
		ts.takeInto(node)
	}
	return node
}

func parseDesignation(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("designation", tokenSpan(startTkn))
	any := false
	for {
		n := ts.peekName()
		if n == "PUNC_DOT" {
			d := makeNode("member_designator", tokenSpan(ts.peek()))
			ts.takeInto(d) // '.'
			memTkn := ts.peek()
			if memTkn != nil && (memTkn.Name == "ID" || memTkn.Name == "TYPEDEF_NAME" ||
				memTkn.Name == "MACRO_NAME") {
				t := ts.take()
				for _, tr := range t.trivia {
					appendChild(d, tr)
				}
				appendChild(d, t.ref)
				d["memberName"] = t.tkn.Src
			}
			appendChild(node, d)
			any = true
			continue
		}
		if n == "PUNC_LBRACKET" {
			d := makeNode("index_designator", tokenSpan(ts.peek()))
			consumeBalanced(ts, d, "PUNC_LBRACKET", "PUNC_RBRACKET")
			appendChild(node, d)
			any = true
			continue
		}
		break
	}
	if !any {
		return nil
	}
	if ts.peekName() == "PUNC_ASSIGN" {
		ts.takeInto(node)
	}
	return node
}

// ---- compound statement & statements --------------------------------

func parseCompoundStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil || startTkn.Name != "PUNC_LBRACE" {
		return nil
	}
	node := makeNode("compound_statement", tokenSpan(startTkn))
	ts.takeInto(node) // '{'
	for !ts.done() && ts.peekName() != "PUNC_RBRACE" {
		item := parseBlockItem(ts)
		if item != nil {
			appendChild(node, item)
		} else {
			ts.takeInto(node)
		}
	}
	if ts.peekName() == "PUNC_RBRACE" {
		ts.takeInto(node)
	}
	return node
}

func parseBlockItem(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	if startTkn.Name == "PP_HASH" {
		return takePreprocessorLine(ts)
	}
	n0 := startTkn.Name
	if isSpecifierStart(n0) || n0 == "KW_STATIC_ASSERT" || n0 == "KW__STATIC_ASSERT" ||
		isC23AttributeOpen(ts) {
		decl := parseDeclaration(ts)
		if decl != nil {
			return decl
		}
	}
	return parseStatement(ts)
}

func parseDeclaration(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	if startTkn.Name == "KW_STATIC_ASSERT" || startTkn.Name == "KW__STATIC_ASSERT" {
		return parseStaticAssertDeclaration(ts)
	}
	node := makeNode("declaration", tokenSpan(startTkn))
	specs := parseDeclarationSpecifiers(ts)
	if specs != nil {
		appendChild(node, specs)
	}
	if ts.peekName() != "PUNC_SEMI" && !ts.done() {
		idl := parseInitDeclaratorList(ts)
		if idl != nil {
			appendChild(node, idl)
		}
	}
	if ts.peekName() == "PUNC_SEMI" {
		ts.takeInto(node)
	}
	if childrenLen(node) > 0 {
		return node
	}
	return nil
}

func parseStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	n0 := startTkn.Name

	if n0 == "PUNC_LBRACE" {
		return parseCompoundStatement(ts)
	}
	if n0 == "PUNC_SEMI" {
		e := makeNode("expression_statement", tokenSpan(startTkn))
		ts.takeInto(e)
		return e
	}
	if n0 == "KW_IF" {
		return parseIfStatement(ts)
	}
	if n0 == "KW_SWITCH" {
		return parseSwitchStatement(ts)
	}
	if n0 == "KW_WHILE" {
		return parseWhileStatement(ts)
	}
	if n0 == "KW_DO" {
		return parseDoStatement(ts)
	}
	if n0 == "KW_FOR" {
		return parseForStatement(ts)
	}
	if n0 == "KW_GOTO" || n0 == "KW_CONTINUE" || n0 == "KW_BREAK" || n0 == "KW_RETURN" {
		return parseJumpStatement(ts)
	}
	if n0 == "KW_CASE" || n0 == "KW_DEFAULT" {
		return parseLabeledStatement(ts)
	}
	if isIdLike(n0) && ts.peekName(1) == "PUNC_COLON" {
		return parseLabeledStatement(ts)
	}
	if n0 == "KW___ASM__" || n0 == "KW___ASM" || n0 == "KW_ASM" {
		return parseAsmStatement(ts)
	}
	return parseExpressionStatement(ts)
}

func parseIfStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("if_statement", tokenSpan(startTkn))
	ts.takeInto(node) // 'if'
	if ts.peekName() == "PUNC_LPAREN" {
		cond := makeNode("paren_condition", tokenSpan(ts.peek()))
		consumeBalanced(ts, cond, "PUNC_LPAREN", "PUNC_RPAREN")
		appendChild(node, cond)
	}
	thenStmt := parseStatement(ts)
	if thenStmt != nil {
		appendChild(node, thenStmt)
	}
	if ts.peekName() == "KW_ELSE" {
		ts.takeInto(node) // 'else'
		elseStmt := parseStatement(ts)
		if elseStmt != nil {
			appendChild(node, elseStmt)
		}
	}
	return node
}

func parseSwitchStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("switch_statement", tokenSpan(startTkn))
	ts.takeInto(node) // 'switch'
	if ts.peekName() == "PUNC_LPAREN" {
		cond := makeNode("paren_condition", tokenSpan(ts.peek()))
		consumeBalanced(ts, cond, "PUNC_LPAREN", "PUNC_RPAREN")
		appendChild(node, cond)
	}
	body := parseStatement(ts)
	if body != nil {
		appendChild(node, body)
	}
	return node
}

func parseWhileStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("while_statement", tokenSpan(startTkn))
	ts.takeInto(node) // 'while'
	if ts.peekName() == "PUNC_LPAREN" {
		cond := makeNode("paren_condition", tokenSpan(ts.peek()))
		consumeBalanced(ts, cond, "PUNC_LPAREN", "PUNC_RPAREN")
		appendChild(node, cond)
	}
	body := parseStatement(ts)
	if body != nil {
		appendChild(node, body)
	}
	return node
}

func parseDoStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("do_statement", tokenSpan(startTkn))
	ts.takeInto(node) // 'do'
	body := parseStatement(ts)
	if body != nil {
		appendChild(node, body)
	}
	if ts.peekName() == "KW_WHILE" {
		ts.takeInto(node)
	}
	if ts.peekName() == "PUNC_LPAREN" {
		cond := makeNode("paren_condition", tokenSpan(ts.peek()))
		consumeBalanced(ts, cond, "PUNC_LPAREN", "PUNC_RPAREN")
		appendChild(node, cond)
	}
	if ts.peekName() == "PUNC_SEMI" {
		ts.takeInto(node)
	}
	return node
}

func parseForStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("for_statement", tokenSpan(startTkn))
	ts.takeInto(node) // 'for'
	if ts.peekName() == "PUNC_LPAREN" {
		ctl := makeNode("for_controls", tokenSpan(ts.peek()))
		ts.takeInto(ctl) // '('

		initSpan := ts.peek()
		if initSpan == nil {
			initSpan = startTkn
		}
		initNode := makeNode("for_init", tokenSpan(initSpan))
		if ts.peekName() != "PUNC_SEMI" && !ts.done() {
			t0 := ts.peek()
			if isSpecifierStart(t0.Name) || t0.Name == "KW_STATIC_ASSERT" ||
				t0.Name == "KW__STATIC_ASSERT" || isC23AttributeOpen(ts) {
				decl := parseDeclaration(ts)
				if decl != nil {
					appendChild(initNode, decl)
					initNode["value"] = decl
				}
			} else {
				expr := parseExpression(ts, map[string]bool{"PUNC_SEMI": true})
				if expr != nil {
					appendChild(initNode, expr)
					initNode["value"] = expr
				}
				if ts.peekName() == "PUNC_SEMI" {
					ts.takeInto(initNode)
				}
			}
		} else if ts.peekName() == "PUNC_SEMI" {
			ts.takeInto(initNode)
		}
		appendChild(ctl, initNode)
		ctl["init"] = initNode

		condSpan := ts.peek()
		if condSpan == nil {
			condSpan = startTkn
		}
		condNode := makeNode("for_cond", tokenSpan(condSpan))
		if ts.peekName() != "PUNC_SEMI" && ts.peekName() != "PUNC_RPAREN" {
			expr := parseExpression(ts, map[string]bool{"PUNC_SEMI": true, "PUNC_RPAREN": true})
			if expr != nil {
				appendChild(condNode, expr)
				condNode["value"] = expr
			}
		}
		if ts.peekName() == "PUNC_SEMI" {
			ts.takeInto(condNode)
		}
		appendChild(ctl, condNode)
		ctl["cond"] = condNode

		iterSpan := ts.peek()
		if iterSpan == nil {
			iterSpan = startTkn
		}
		iterNode := makeNode("for_iter", tokenSpan(iterSpan))
		if ts.peekName() != "PUNC_RPAREN" {
			expr := parseExpression(ts, map[string]bool{"PUNC_RPAREN": true})
			if expr != nil {
				appendChild(iterNode, expr)
				iterNode["value"] = expr
			}
		}
		appendChild(ctl, iterNode)
		ctl["iter"] = iterNode

		if ts.peekName() == "PUNC_RPAREN" {
			ts.takeInto(ctl)
		}
		appendChild(node, ctl)
	}
	body := parseStatement(ts)
	if body != nil {
		appendChild(node, body)
	}
	return node
}

func parseJumpStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("jump_statement", tokenSpan(startTkn))
	node["jumpKind"] = startTkn.Src
	ts.takeInto(node) // jump keyword
	if ts.peekName() != "PUNC_SEMI" && !ts.done() {
		expr := parseExpression(ts, map[string]bool{"PUNC_SEMI": true})
		if expr != nil {
			appendChild(node, expr)
		}
	}
	if ts.peekName() == "PUNC_SEMI" {
		ts.takeInto(node)
	}
	return node
}

func parseLabeledStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("labeled_statement", tokenSpan(startTkn))
	if startTkn.Name == "KW_CASE" {
		node["labelKind"] = "case"
		ts.takeInto(node) // 'case'
		parenD := 0
		for !ts.done() {
			n := ts.peekName()
			if n == "PUNC_LPAREN" {
				parenD++
				ts.takeInto(node)
				continue
			}
			if n == "PUNC_RPAREN" {
				if parenD == 0 {
					break
				}
				parenD--
				ts.takeInto(node)
				continue
			}
			if parenD == 0 && n == "PUNC_COLON" {
				break
			}
			ts.takeInto(node)
		}
	} else if startTkn.Name == "KW_DEFAULT" {
		node["labelKind"] = "default"
		ts.takeInto(node) // 'default'
	} else {
		node["labelKind"] = "label"
		node["labelName"] = startTkn.Src
		ts.takeInto(node) // ID
	}
	if ts.peekName() == "PUNC_COLON" {
		ts.takeInto(node)
	}
	inner := parseStatement(ts)
	if inner != nil {
		appendChild(node, inner)
	}
	return node
}

func parseExpressionStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("expression_statement", tokenSpan(startTkn))
	expr := parseExpression(ts, map[string]bool{"PUNC_SEMI": true})
	if expr != nil {
		appendChild(node, expr)
	}
	if ts.peekName() == "PUNC_SEMI" {
		ts.takeInto(node)
	}
	return node
}

func parseAsmStatement(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("asm_statement", tokenSpan(startTkn))
	quals := []any{}
	ts.takeInto(node) // asm keyword
	for {
		n := ts.peekName()
		if n == "KW_VOLATILE" || n == "KW___VOLATILE__" || n == "KW___VOLATILE" ||
			n == "KW_INLINE" || n == "KW___INLINE__" || n == "KW___INLINE" || n == "KW_GOTO" {
			quals = append(quals, ts.peek().Src)
			ts.takeInto(node)
			continue
		}
		break
	}
	node["qualifiers"] = quals
	if ts.peekName() != "PUNC_LPAREN" {
		if ts.peekName() == "PUNC_SEMI" {
			ts.takeInto(node)
		}
		return node
	}
	ts.takeInto(node) // '('

	tmplSpan := ts.peek()
	if tmplSpan == nil {
		tmplSpan = startTkn
	}
	template := makeNode("asm_template", tokenSpan(tmplSpan))
	t := parseExpression(ts, map[string]bool{"PUNC_COLON": true, "PUNC_RPAREN": true})
	if t != nil {
		appendChild(template, t)
		template["expression"] = t
	}
	appendChild(node, template)
	node["template"] = template

	sections := []string{"asm_outputs", "asm_inputs", "asm_clobbers", "asm_labels"}
	sectionIdx := 0
	for ts.peekName() == "PUNC_COLON" && sectionIdx < len(sections) {
		ts.takeInto(node) // ':'
		secSpan := ts.peek()
		if secSpan == nil {
			secSpan = startTkn
		}
		sec := makeNode(sections[sectionIdx], tokenSpan(secSpan))
		for !ts.done() && ts.peekName() != "PUNC_COLON" && ts.peekName() != "PUNC_RPAREN" {
			var item CNode
			if sectionIdx <= 1 {
				item = parseAsmOperand(ts)
			} else if sectionIdx == 2 {
				item = parseAsmClobber(ts)
			} else {
				item = parseAsmLabel(ts)
			}
			if item != nil {
				appendChild(sec, item)
			} else {
				ts.takeInto(sec)
			}
			if ts.peekName() == "PUNC_COMMA" {
				ts.takeInto(sec)
			}
		}
		appendChild(node, sec)
		node[sections[sectionIdx]] = sec
		sectionIdx++
	}

	if ts.peekName() == "PUNC_RPAREN" {
		ts.takeInto(node)
	}
	if ts.peekName() == "PUNC_SEMI" {
		ts.takeInto(node)
	}
	return node
}

func parseAsmOperand(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("asm_operand", tokenSpan(startTkn))

	if startTkn.Name == "PUNC_LBRACKET" {
		nameNode := makeNode("asm_name", tokenSpan(startTkn))
		consumeBalanced(ts, nameNode, "PUNC_LBRACKET", "PUNC_RBRACKET")
		appendChild(node, nameNode)
		node["asmName"] = nameNode
	}

	if ts.peekName() == "LIT_STRING" {
		t := ts.take()
		for _, tr := range t.trivia {
			appendChild(node, tr)
		}
		constraint := makeNode("asm_constraint", tokenSpan(t.tkn))
		appendChild(constraint, t.ref)
		constraint["value"] = t.tkn.Src
		appendChild(node, constraint)
		node["constraint"] = constraint
	}

	if ts.peekName() == "PUNC_LPAREN" {
		expr := makeNode("asm_value", tokenSpan(ts.peek()))
		ts.takeInto(expr) // '('
		inner := parseExpression(ts, map[string]bool{"PUNC_RPAREN": true})
		if inner != nil {
			appendChild(expr, inner)
			expr["expression"] = inner
		}
		if ts.peekName() == "PUNC_RPAREN" {
			ts.takeInto(expr)
		}
		appendChild(node, expr)
		node["value"] = expr
	}

	if childrenLen(node) > 0 {
		return node
	}
	return nil
}

func parseAsmClobber(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil || startTkn.Name != "LIT_STRING" {
		return nil
	}
	node := makeNode("asm_clobber", tokenSpan(startTkn))
	t := ts.take()
	for _, tr := range t.trivia {
		appendChild(node, tr)
	}
	appendChild(node, t.ref)
	node["value"] = t.tkn.Src
	return node
}

func parseAsmLabel(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	if !isIdLike(startTkn.Name) && startTkn.Name != "TYPEDEF_NAME" {
		return nil
	}
	node := makeNode("asm_label_ref", tokenSpan(startTkn))
	t := ts.take()
	for _, tr := range t.trivia {
		appendChild(node, tr)
	}
	appendChild(node, t.ref)
	node["labelName"] = t.tkn.Src
	return node
}

func takePreprocessorLine(ts *TokenStream) CNode {
	if dir := parseDirective(ts); dir != nil {
		return dir
	}
	startTkn := ts.peek()
	node := makeNode("preprocessor_line", tokenSpan(startTkn))
	for !ts.done() {
		n := ts.peekName()
		if n == "PP_NEWLINE" {
			ts.takeInto(node)
			break
		}
		ts.takeInto(node)
	}
	return node
}

// ---- preprocessor directives ----------------------------------------

func directiveName(ts *TokenStream, hashOff int) string {
	t := ts.peek(hashOff + 1)
	if t == nil {
		return ""
	}
	return t.Src
}

func parseDirective(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil || startTkn.Name != "PP_HASH" {
		return nil
	}
	dn := directiveName(ts, 0)
	switch dn {
	case "define":
		return parseDefineDirective(ts)
	case "undef":
		return parseUndefDirective(ts)
	case "include", "include_next", "embed":
		return parseIncludeDirective(ts, dn)
	case "if", "ifdef", "ifndef", "elif", "elifdef", "elifndef", "else", "endif":
		return parseConditionalDirective(ts, dn)
	case "pragma":
		return parseSimpleDirective(ts, "pragma_directive")
	case "error":
		return parseSimpleDirective(ts, "error_directive")
	case "warning":
		return parseSimpleDirective(ts, "warning_directive")
	case "line":
		return parseSimpleDirective(ts, "line_directive")
	default:
		return parseSimpleDirective(ts, "unknown_directive")
	}
}

func parseSimpleDirective(ts *TokenStream, kind string) CNode {
	startTkn := ts.peek()
	node := makeNode(kind, tokenSpan(startTkn))
	ts.takeInto(node) // PP_HASH
	for !ts.done() {
		n := ts.peekName()
		if n == "PP_NEWLINE" {
			ts.takeInto(node)
			break
		}
		ts.takeInto(node)
	}
	return node
}

func parseDefineDirective(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("define_directive", tokenSpan(startTkn))
	ts.takeInto(node) // PP_HASH
	ts.takeInto(node) // 'define'

	nameTkn := ts.peek()
	if nameTkn != nil && (isIdLike(nameTkn.Name) || nameTkn.Name == "TYPEDEF_NAME" ||
		nameTkn.Name == "MACRO_NAME") {
		t := ts.take()
		for _, tr := range t.trivia {
			appendChild(node, tr)
		}
		appendChild(node, t.ref)
		node["macroName"] = t.tkn.Src

		lookahead := ts.peek()
		if lookahead != nil && lookahead.Name == "PUNC_LPAREN" &&
			lookahead.SI == t.tkn.SI+len(t.tkn.Src) {
			node["macroKind"] = "function-like"
			params := makeNode("macro_parameter_list", tokenSpan(lookahead))
			ts.takeInto(params) // '('
			macroParams := []any{}
			for !ts.done() && ts.peekName() != "PUNC_RPAREN" {
				tk := ts.peek()
				if tk.Name == "PUNC_ELLIPSIS" {
					node["macroVariadic"] = true
					ts.takeInto(params)
				} else if tk.Name == "PUNC_COMMA" {
					ts.takeInto(params)
				} else if isIdLike(tk.Name) || tk.Name == "TYPEDEF_NAME" {
					ts.takeInto(params)
					macroParams = append(macroParams, tk.Src)
				} else {
					ts.takeInto(params)
				}
			}
			if ts.peekName() == "PUNC_RPAREN" {
				ts.takeInto(params)
			}
			node["macroParams"] = macroParams
			appendChild(node, params)
		} else {
			node["macroKind"] = "object-like"
		}
	} else {
		node["macroKind"] = "object-like"
	}

	bodySpan := ts.peek()
	if bodySpan == nil {
		bodySpan = startTkn
	}
	body := makeNode("macro_body", tokenSpan(bodySpan))
	for !ts.done() {
		n := ts.peekName()
		if n == "PP_NEWLINE" {
			break
		}
		ts.takeInto(body)
	}
	appendChild(node, body)
	if ts.peekName() == "PP_NEWLINE" {
		ts.takeInto(node)
	}
	return node
}

func parseUndefDirective(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("undef_directive", tokenSpan(startTkn))
	ts.takeInto(node) // PP_HASH
	ts.takeInto(node) // 'undef'
	nameTkn := ts.peek()
	if nameTkn != nil && (isIdLike(nameTkn.Name) || nameTkn.Name == "TYPEDEF_NAME" ||
		nameTkn.Name == "MACRO_NAME") {
		t := ts.take()
		for _, tr := range t.trivia {
			appendChild(node, tr)
		}
		appendChild(node, t.ref)
		node["macroName"] = t.tkn.Src
	}
	for !ts.done() {
		n := ts.peekName()
		if n == "PP_NEWLINE" {
			ts.takeInto(node)
			break
		}
		ts.takeInto(node)
	}
	return node
}

func parseIncludeDirective(ts *TokenStream, name string) CNode {
	startTkn := ts.peek()
	node := makeNode("include_directive", tokenSpan(startTkn))
	node["includeForm"] = name
	ts.takeInto(node) // PP_HASH
	ts.takeInto(node) // include keyword

	next := ts.peek()
	if next != nil {
		if next.Name == "LIT_HEADER_NAME" {
			t := ts.take()
			for _, tr := range t.trivia {
				appendChild(node, tr)
			}
			appendChild(node, t.ref)
			node["headerName"] = t.tkn.Src
			if hasPrefix(t.tkn.Src, "<") {
				node["headerKind"] = "angled"
			} else {
				node["headerKind"] = "quoted"
			}
		} else {
			hf := makeNode("header_form", tokenSpan(next))
			for !ts.done() {
				n := ts.peekName()
				if n == "PP_NEWLINE" {
					break
				}
				ts.takeInto(hf)
			}
			appendChild(node, hf)
		}
	}

	if ts.peekName() == "PP_NEWLINE" {
		ts.takeInto(node)
	}
	return node
}

func parseConditionalDirective(ts *TokenStream, name string) CNode {
	startTkn := ts.peek()
	node := makeNode("conditional_directive", tokenSpan(startTkn))
	node["directive"] = name
	ts.takeInto(node) // PP_HASH
	ts.takeInto(node) // directive keyword
	for !ts.done() {
		n := ts.peekName()
		if n == "PP_NEWLINE" {
			ts.takeInto(node)
			break
		}
		ts.takeInto(node)
	}
	return node
}

// ---- top-level dispatch ---------------------------------------------

// structuredResult holds the children + declKind produced from an
// external_declaration's token list.
type structuredResult struct {
	declKind string
	children []any
}

// structureExternalDeclaration parses a single external_declaration from the
// token list. Returns nil if parsing fails (caller retains the flat refs).
func structureExternalDeclaration(tokens []*tabnas.Token) *structuredResult {
	ts := NewTokenStream(tokens)
	if ts.done() {
		return nil
	}

	head := ts.peekName()
	if head == "KW_STATIC_ASSERT" || head == "KW__STATIC_ASSERT" {
		sa := parseStaticAssertDeclaration(ts)
		return &structuredResult{declKind: "declaration", children: []any{sa}}
	}

	if ts.peekName() == "PP_HASH" {
		dir := parseDirective(ts)
		if dir != nil {
			out := []any{dir}
			for !ts.done() {
				t := ts.take()
				if t == nil {
					break
				}
				for _, tr := range t.trivia {
					out = append(out, tr)
				}
				out = append(out, t.ref)
			}
			return &structuredResult{declKind: "declaration", children: out}
		}
		return nil
	}

	specs := parseDeclarationSpecifiers(ts)

	if specs == nil && !isIdLike(ts.peekName()) && ts.peekName() != "PUNC_STAR" &&
		ts.peekName() != "PUNC_LPAREN" {
		return nil
	}

	decls := parseInitDeclaratorList(ts)
	tail := ts.peekName()

	out := []any{}
	if specs != nil {
		out = append(out, specs)
	}

	if tail == "PUNC_SEMI" {
		if decls != nil {
			out = append(out, decls)
		}
		for !ts.done() {
			t := ts.take()
			if t == nil {
				break
			}
			for _, tr := range t.trivia {
				out = append(out, tr)
			}
			out = append(out, t.ref)
		}
		return &structuredResult{declKind: "declaration", children: out}
	}

	if tail == "PUNC_LBRACE" {
		if decls != nil {
			dc, _ := decls["children"].([]any)
			var single CNode
			if len(dc) == 1 {
				single, _ = dc[0].(CNode)
			}
			if single != nil && nodeKind(single) == "init_declarator" {
				sc, _ := single["children"].([]any)
				if len(sc) == 1 && nodeKind(sc[0]) == "declarator" {
					out = append(out, sc[0])
				} else {
					out = append(out, decls)
				}
			} else {
				out = append(out, decls)
			}
		}
		body := parseCompoundStatement(ts)
		if body != nil {
			out = append(out, body)
		}
		for !ts.done() {
			t := ts.take()
			if t == nil {
				break
			}
			for _, tr := range t.trivia {
				out = append(out, tr)
			}
			out = append(out, t.ref)
		}
		return &structuredResult{declKind: "function_definition", children: out}
	}

	// K&R-style function definition: declaration-list before '{'.
	if tail != "" && tail != "PUNC_SEMI" {
		krStart := ts.mark()
		sawBrace := false
		for !ts.done() {
			if ts.peekName() == "PUNC_LBRACE" {
				sawBrace = true
				break
			}
			if ts.take() == nil {
				break
			}
		}
		if sawBrace {
			ts.restore(krStart)
			krList := makeNode("kr_declaration_list", tokenSpan(ts.peek()))
			for !ts.done() && ts.peekName() != "PUNC_LBRACE" {
				ts.takeInto(krList)
			}
			if decls != nil {
				out = append(out, decls)
			}
			out = append(out, krList)
			body := parseCompoundStatement(ts)
			if body != nil {
				out = append(out, body)
			}
			for !ts.done() {
				t := ts.take()
				if t == nil {
					break
				}
				for _, tr := range t.trivia {
					out = append(out, tr)
				}
				out = append(out, t.ref)
			}
			return &structuredResult{declKind: "function_definition", children: out}
		}
		ts.restore(krStart)
	}

	return nil
}

// hasPrefix reports whether s starts with prefix (small helper to avoid an
// extra import in callers).
func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// ---- finalizer + typedef/macro registration (ported from c.ts) ------

// finalizeExternalDeclaration is the @finalize-extdecl close action. Port of
// finalizeExternalDeclaration in c.ts: register typedef names, then upgrade the
// flat token-ref children to a structured tree (or mark unknown).
func finalizeExternalDeclaration(r *tabnas.Rule, ctx *tabnas.Context) {
	tokens := kTokens(r)
	registerTypedefIfApplicable(tokens, ctx)
	structured := structureExternalDeclaration(tokens)
	node, _ := r.Node.(CNode)
	if structured != nil {
		if node != nil {
			node["children"] = structured.children
			node["declKind"] = structured.declKind
			node["viaPath"] = "legacy"
		}
		registerMacrosFromTree(node, ctx)
	} else {
		if node != nil {
			node["declKind"] = "unknown"
			node["viaPath"] = "legacy-unknown"
		}
	}
}

// registerMacrosFromTree walks a freshly-structured node and records any
// define_directive macros into cmeta.Macros (and #undef removes them),
// reclassifying already-fetched lookahead tokens. Port of c.ts.
func registerMacrosFromTree(node any, ctx *tabnas.Context) {
	cm := ctxCMeta(ctx)
	if cm == nil {
		return
	}
	var visit func(n any)
	visit = func(n any) {
		m, ok := n.(map[string]any)
		if !ok || m == nil {
			return
		}
		kind, _ := m["kind"].(string)
		if kind == "define_directive" {
			if name, ok := m["macroName"].(string); ok && name != "" {
				params, _ := toStringSlice(m["macroParams"])
				variadic, _ := m["macroVariadic"].(bool)
				cm.Macros.Define(&MacroDef{
					Name:           name,
					IsFunctionLike: m["macroKind"] == "function-like",
					Params:         params,
					Variadic:       variadic,
				})
				reclassifyLookahead(ctx, name, "ID", "MACRO_NAME")
			}
		} else if kind == "undef_directive" {
			if name, ok := m["macroName"].(string); ok && name != "" {
				cm.Macros.Undefine(name)
				reclassifyLookahead(ctx, name, "MACRO_NAME", "ID")
			}
		}
		if children, ok := m["children"].([]any); ok {
			for _, c := range children {
				visit(c)
			}
		}
	}
	visit(node)
}

// toStringSlice converts a []any of strings to []string.
func toStringSlice(v any) ([]string, bool) {
	sl, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(sl))
	for _, e := range sl {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out, true
}

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

// startsNewExternalDeclaration reports whether the upcoming token(s) begin a
// new external declaration. Port of startsNewExternalDeclaration in c.ts.
func startsNewExternalDeclaration(ctx *tabnas.Context) bool {
	if ctx == nil {
		return false
	}
	i := 0
	for i < len(ctx.T) {
		tkn := ctx.T[i]
		if tkn == nil {
			break
		}
		if triviaTokenNames[tkn.Name] {
			i++
			continue
		}
		n := tkn.Name
		if n == "#ZZ" {
			return true
		}
		if n == "PP_HASH" {
			return true
		}
		if n == "PUNC_HASH" {
			return true
		}
		if storageClassNames[n] {
			return true
		}
		if typeSpecKeywordNames[n] {
			return true
		}
		if ptrQualifierTokenNames[n] {
			return true
		}
		if functionSpecifierNames[n] {
			return true
		}
		if n == "KW___ATTRIBUTE__" || n == "KW___ATTRIBUTE" {
			return true
		}
		if n == "KW___DECLSPEC" {
			return true
		}
		if n == "KW___EXTENSION__" {
			return true
		}
		if n == "TYPEDEF_NAME" {
			return true
		}
		return false
	}
	return false
}

// ---- preserved helpers (unchanged from the prior stub) --------------

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
