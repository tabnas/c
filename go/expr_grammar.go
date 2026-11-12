/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"strings"
	"sync"

	tabnasexpr "github.com/tabnas/expr/go"
	tabnas "github.com/tabnas/parser/go"
)

// C's expressions, read by @tabnas/expr. Port of ts/src/expr-grammar.ts,
// which has the design.
//
// The grammar's contexts push `val`, the rule an expression starts from,
// where C's grammar names an expression (an initializer, a condition, an
// argument). expr parses the expression with C's operator table, and its
// evaluate callback turns each operation of the S-expression into the
// node C's tree holds for it, from the root down once the expression has
// ended (evaluateCExpr). The table sets the options expr has for a
// language like C: a binding power on a call's and a subscript's
// parenthesis, a cast accepted where its group holds a type name, the
// comma operator beside separators, values side by side refused, a
// required content, and the conditional as a ternary with binding powers.
//
// A token expr does not hand over with the operation (an opener, a
// separator, a conditional's `:`) is reached through the links the sub-lex
// hook makes as the tokens are lexed (linkToken).

// fixedTokenMu guards the brief, synchronous mutation of the global
// tabnas.FixedTokens table done while installing @tabnas/expr (see
// withInstanceFixedTokens).
var fixedTokenMu sync.Mutex

// withInstanceFixedTokens runs fn while the global tabnas.FixedTokens table
// temporarily maps each C token source to THIS instance's tin, then restores
// it. @tabnas/expr's Go port binds its operators to tins it finds in the
// global tabnas.FixedTokens table; the TypeScript expr instead consults the
// instance's fixed tokens. Without this shim, expr would mint fresh `#E+`
// tins distinct from the PUNC_*/KW_* tins our lexer emits, and no operator
// alt would ever match. The mutation is synchronous and reverted before the
// call returns, so other parsers in the process are unaffected.
func withInstanceFixedTokens(j *tabnas.Tabnas, fn func() error) error {
	fixedTokenMu.Lock()
	defer fixedTokenMu.Unlock()

	type prev struct {
		tin tabnas.Tin
		had bool
	}
	saved := map[string]prev{}
	for name, src := range AllTokenNamesAndSources() {
		old, had := tabnas.FixedTokens[src]
		saved[src] = prev{old, had}
		tabnas.FixedTokens[src] = j.Token(name)
	}
	defer func() {
		for src, p := range saved {
			if p.had {
				tabnas.FixedTokens[src] = p.tin
			} else {
				delete(tabnas.FixedTokens, src)
			}
		}
	}()

	return fn()
}

// ---- C's operator table ---------------------------------------------
//
// Binding powers on a 1,000 ladder, loosest first. Left-associative
// operators have left < right, right-associative ones left > right.

const (
	unaryPower   = 16_000
	postfixPower = 17_000
)

// cOpTable is C's operator table, in the map form expr's Go option reader
// takes. Mirrors C_OP_TABLE in ts/src/expr-grammar.ts.
func cOpTable() map[string]any {
	inf := func(src string, left, right int) map[string]any {
		return map[string]any{"src": src, "infix": true, "left": left, "right": right}
	}
	pre := func(src string) map[string]any {
		return map[string]any{"src": src, "prefix": true, "right": unaryPower}
	}
	suf := func(src string) map[string]any {
		return map[string]any{"src": src, "suffix": true, "left": postfixPower}
	}
	comma := inf(",", 1_000, 1_001)
	comma["separator"] = true
	return map[string]any{
		// The comma operator, which gives way to a separator wherever the
		// context separates on `,` (a call's arguments, an initializer).
		"comma": comma,

		// Assignment, right-associative.
		"assign":  inf("=", 2_001, 2_000),
		"plus_a":  inf("+=", 2_001, 2_000),
		"minus_a": inf("-=", 2_001, 2_000),
		"star_a":  inf("*=", 2_001, 2_000),
		"slash_a": inf("/=", 2_001, 2_000),
		"pct_a":   inf("%=", 2_001, 2_000),
		"lsh_a":   inf("<<=", 2_001, 2_000),
		"rsh_a":   inf(">>=", 2_001, 2_000),
		"amp_a":   inf("&=", 2_001, 2_000),
		"crt_a":   inf("^=", 2_001, 2_000),
		"pipe_a":  inf("|=", 2_001, 2_000),

		// The conditional, right-associative, placed by its binding powers:
		// it binds tighter than assignment and the comma operator, and its
		// middle term is a whole expression.
		"tern": map[string]any{"src": []any{"?", ":"}, "ternary": true, "left": 3_001, "right": 3_000},

		// The binary operators, from `||` to the multiplicative ones.
		"or":    inf("||", 4_000, 4_001),
		"and":   inf("&&", 5_000, 5_001),
		"bor":   inf("|", 6_000, 6_001),
		"bxor":  inf("^", 7_000, 7_001),
		"band":  inf("&", 8_000, 8_001),
		"eq":    inf("==", 9_000, 9_001),
		"ne":    inf("!=", 9_000, 9_001),
		"lt":    inf("<", 10_000, 10_001),
		"le":    inf("<=", 10_000, 10_001),
		"gt":    inf(">", 10_000, 10_001),
		"ge":    inf(">=", 10_000, 10_001),
		"lsh":   inf("<<", 11_000, 11_001),
		"rsh":   inf(">>", 11_000, 11_001),
		"plus":  inf("+", 12_000, 12_001),
		"minus": inf("-", 12_000, 12_001),
		"star":  inf("*", 13_000, 13_001),
		"slash": inf("/", 13_000, 13_001),
		"pct":   inf("%", 13_000, 13_001),

		// The prefix operators, and the cast at their level.
		"pre_inc":      pre("++"),
		"pre_dec":      pre("--"),
		"unary_p":      pre("+"),
		"unary_n":      pre("-"),
		"lnot":         pre("!"),
		"bnot":         pre("~"),
		"deref":        pre("*"),
		"addr":         pre("&"),
		"sizeof":       pre("sizeof"),
		"alignof":      pre("_Alignof"),
		"alignof_g":    pre("alignof"),
		"gnualignof":   pre("__alignof__"),
		"gnualignof_s": pre("__alignof"),
		"cast": map[string]any{
			"osrc": "(", "csrc": ")", "cast": true, "right": unaryPower,
			"accept": func(term any) bool {
				return isNode(term) && nodeKind(term) == "type_name"
			},
		},

		// The postfix operators, one level, left to right.
		"post_inc": suf("++"),
		"post_dec": suf("--"),
		"dot":      inf(".", postfixPower, postfixPower+1),
		"arrow":    inf("->", postfixPower, postfixPower+1),

		// A group, whose content is required; a call, whose content is its
		// arguments, separated; a subscript.
		"paren": map[string]any{
			"osrc": "(", "csrc": ")", "paren": true,
			"preval":  map[string]any{"active": false},
			"content": map[string]any{"required": true},
		},
		"call": map[string]any{
			"osrc": "(", "csrc": ")", "paren": true, "left": postfixPower,
			"preval":  map[string]any{"active": true},
			"content": map[string]any{"separated": true},
		},
		"subscript": map[string]any{
			"osrc": "[", "csrc": "]", "paren": true, "left": postfixPower,
			"preval":  map[string]any{"active": true, "required": true},
			"content": map[string]any{"required": true},
		},
	}
}

var assignOps = setOf(
	"assign-infix", "plus_a-infix", "minus_a-infix", "star_a-infix",
	"slash_a-infix", "pct_a-infix", "lsh_a-infix", "rsh_a-infix",
	"amp_a-infix", "crt_a-infix", "pipe_a-infix",
)

// ---- The links between an operation's tokens --------------------------
//
// expr hands evaluate each operation's own token: an operator's, a
// paren's closer, a conditional's `?`. The opener of a paren, the commas
// between a call's arguments and a conditional's `:` are reached from
// it, through links made as the tokens are lexed: a closer's Use["open"]
// is its opener, an opener's Use["seps"] the commas directly inside it,
// and a `?`'s Use["colon"] the `:` that answers it.

type linkLevel struct {
	opener *tabnas.Token
	qs     []*tabnas.Token
}

// LinkState is the parse's state of the links: the open brackets, each
// with the `?`s at its level still waiting for their `:`.
type LinkState struct {
	levels []*linkLevel
	last   *tabnas.Token
}

func newLinks() *LinkState {
	return &LinkState{levels: []*linkLevel{{}}}
}

var linkOpeners = setOf("PUNC_LPAREN", "PUNC_LBRACKET", "PUNC_LBRACE")

var linkCloserOf = map[string]string{
	"PUNC_RPAREN":   "PUNC_LPAREN",
	"PUNC_RBRACKET": "PUNC_LBRACKET",
	"PUNC_RBRACE":   "PUNC_LBRACE",
}

func tokenUse(tkn *tabnas.Token) map[string]any {
	if tkn.Use == nil {
		tkn.Use = map[string]any{}
	}
	return tkn.Use
}

// linkToken links a token the lexer gave the parser, in the order it gave
// them. A token given again at the same place (the engine's relex) takes
// the place of the one before it.
func linkToken(links *LinkState, tkn *tabnas.Token) {
	if last := links.last; last != nil && last.SI == tkn.SI {
		was := tokenUse(last)
		now := tokenUse(tkn)
		for _, key := range []string{"open", "seps", "colon"} {
			if v, ok := was[key]; ok {
				if _, has := now[key]; !has {
					now[key] = v
				}
			}
		}
		for _, level := range links.levels {
			if level.opener == last {
				level.opener = tkn
			}
			for i, q := range level.qs {
				if q == last {
					level.qs[i] = tkn
				}
			}
		}
		links.last = tkn
		return
	}
	links.last = tkn
	top := links.levels[len(links.levels)-1]
	name := tkn.Name
	if linkOpeners[name] {
		links.levels = append(links.levels, &linkLevel{opener: tkn})
		return
	}
	if opens, ok := linkCloserOf[name]; ok {
		for i := len(links.levels) - 1; i > 0; i-- {
			opener := links.levels[i].opener
			if opener.Name == opens {
				tokenUse(tkn)["open"] = opener
				links.levels = links.levels[:i]
				break
			}
		}
		return
	}
	switch name {
	case "PUNC_COMMA":
		if top.opener != nil {
			use := tokenUse(top.opener)
			seps, _ := use["seps"].([]*tabnas.Token)
			use["seps"] = append(seps, tkn)
		}
	case "PUNC_QUESTION":
		top.qs = append(top.qs, tkn)
	case "PUNC_COLON":
		if n := len(top.qs); n > 0 {
			q := top.qs[n-1]
			top.qs = top.qs[:n-1]
			tokenUse(q)["colon"] = tkn
		}
	case "PUNC_SEMI":
		top.qs = top.qs[:0]
	}
}

func linkedToken(tkn *tabnas.Token, key string) *tabnas.Token {
	if tkn == nil || tkn.Use == nil {
		return nil
	}
	t, _ := tkn.Use[key].(*tabnas.Token)
	return t
}

func linkedSeps(tkn *tabnas.Token) []*tabnas.Token {
	if tkn == nil || tkn.Use == nil {
		return nil
	}
	seps, _ := tkn.Use["seps"].([]*tabnas.Token)
	return seps
}

// ---- evaluate: an operation as C's node -----------------------------

func termNode(term any) CNode {
	if isNode(term) {
		return term.(map[string]any)
	}
	return nil
}

func termAt(terms []any, i int) any {
	if i < len(terms) {
		return terms[i]
	}
	return nil
}

func pushTerm(node CNode, term any) {
	if n := termNode(term); n != nil {
		appendChild(node, n)
	}
}

func dropTok(node CNode, tkn *tabnas.Token) {
	if tkn != nil && !tkn.IsNoToken() {
		dropToken(node, tkn)
	}
}

func keepTok(node CNode, tkn *tabnas.Token) {
	if tkn != nil && !tkn.IsNoToken() {
		keepToken(node, tkn)
	}
}

// An infix operation: the left operand, the operator's comments, the
// right operand.
func evalInfix(kind string, op *tabnasexpr.Op, terms []any) CNode {
	out := makeNode(kind, nil)
	pushTerm(out, termAt(terms, 0))
	dropTok(out, op.Token)
	pushTerm(out, termAt(terms, 1))
	return out
}

// A comma expression holds every operand of a chain of commas: expr
// builds `a, b, c` left to right, `[, [, a b] c]`, and the inner one is
// the outer one's first operand. A parenthesised one is a group's.
func evalComma(ctx *tabnas.Context, op *tabnasexpr.Op, terms []any) CNode {
	left := termNode(termAt(terms, 0))
	var out CNode
	if left != nil && nodeKind(left) == "comma_expression" {
		out = left
		unfixSpan(ctx, out)
	} else {
		out = makeNode("comma_expression", nil)
		if left != nil {
			appendChild(out, left)
		}
	}
	dropTok(out, op.Token)
	pushTerm(out, termAt(terms, 1))
	return out
}

func evalMember(op *tabnasexpr.Op, terms []any) CNode {
	out := makeNode("member_expression", nil)
	pushTerm(out, termAt(terms, 0))
	dropTok(out, op.Token)
	name := termNode(termAt(terms, 1))
	if name != nil {
		appendChild(out, name)
		if s, ok := name["name"].(string); ok {
			out["memberName"] = s
		}
	}
	out["op"] = op.Src
	return out
}

func evalConditional(op *tabnasexpr.Op, terms []any) CNode {
	out := makeNode("conditional_expression", nil)
	pushTerm(out, termAt(terms, 0))
	dropTok(out, op.Token)
	pushTerm(out, termAt(terms, 1))
	dropTok(out, linkedToken(op.Token, "colon"))
	pushTerm(out, termAt(terms, 2))
	return out
}

func evalUnary(op *tabnasexpr.Op, terms []any) CNode {
	out := makeNode("unary_expression", nil)
	out["op"] = op.Src
	dropTok(out, op.Token)
	pushTerm(out, termAt(terms, 0))
	return out
}

func evalPostfix(op *tabnasexpr.Op, terms []any) CNode {
	out := makeNode("postfix_unary_expression", nil)
	pushTerm(out, termAt(terms, 0))
	dropTok(out, op.Token)
	out["op"] = op.Src
	return out
}

func evalCall(op *tabnasexpr.Op, terms []any) CNode {
	out := makeNode("call_expression", nil)
	callee := termNode(termAt(terms, 0))
	if callee != nil {
		appendChild(out, callee)
		if nodeKind(callee) == "identifier_expression" {
			out["callee"] = callee["name"]
			out["isMacro"] = identifierIsMacro(callee)
		}
	}
	closer := op.Token
	opener := linkedToken(closer, "open")
	seps := linkedSeps(opener)
	args := makeNode("argument_list", nil)
	dropTok(args, opener)
	for i := 1; i < len(terms); i++ {
		if i > 1 && i-2 < len(seps) {
			dropTok(args, seps[i-2])
		}
		pushTerm(args, terms[i])
	}
	dropTok(args, closer)
	appendChild(out, args)
	return out
}

// identifierIsMacro reports whether an identifier_expression's own token
// is a MACRO_NAME (comments before it left out).
func identifierIsMacro(id CNode) bool {
	kids, _ := id["children"].([]any)
	for _, c := range kids {
		cm, ok := c.(map[string]any)
		if !ok || nodeKind(cm) != "token" {
			continue
		}
		tname, _ := cm["tname"].(string)
		if strings.HasPrefix(tname, "TRIVIA") {
			continue
		}
		return tname == "MACRO_NAME"
	}
	return false
}

func evalSubscript(op *tabnasexpr.Op, terms []any) CNode {
	out := makeNode("subscript_expression", nil)
	pushTerm(out, termAt(terms, 0))
	closer := op.Token
	index := makeNode("index_list", nil)
	dropTok(index, linkedToken(closer, "open"))
	for i := 1; i < len(terms); i++ {
		pushTerm(index, terms[i])
	}
	dropTok(index, closer)
	appendChild(out, index)
	return out
}

// A parenthesised expression.
func evalGroup(op *tabnasexpr.Op, terms []any) CNode {
	out := makeNode("paren_expression", nil)
	closer := op.Token
	dropTok(out, linkedToken(closer, "open"))
	for _, t := range terms {
		pushTerm(out, t)
	}
	dropTok(out, closer)
	return out
}

// The nodes a postfix operator builds, each over its first child node: a
// compound literal's postfix chain is built over its brace list.
var postfixKinds = setOf(
	"member_expression", "subscript_expression", "call_expression",
	"postfix_unary_expression",
)

// A cast: `( type-name )` and its operand. A brace list in the operand's
// place is a compound literal, which binds as a postfix expression does:
// expr builds the postfix operators after it into the cast's operand, so
// the compound literal takes the brace list's place under them.
func evalCast(ctx *tabnas.Context, op *tabnasexpr.Op, terms []any) CNode {
	closer := op.Token
	opener := linkedToken(closer, "open")
	typeName := termNode(termAt(terms, 0))
	operand := termNode(termAt(terms, 1))

	parens := func(kind string, body CNode) CNode {
		out := makeNode(kind, nil)
		keepTok(out, opener)
		if typeName != nil {
			appendChild(out, typeName)
		}
		keepTok(out, closer)
		if body != nil {
			appendChild(out, body)
		}
		return out
	}

	var chain []CNode
	n := operand
	for n != nil && postfixKinds[nodeKind(n)] {
		chain = append(chain, n)
		kids := childNodes(n)
		if len(kids) == 0 {
			n = nil
			break
		}
		n = kids[0]
	}
	if n != nil && nodeKind(n) == "initializer_list" {
		literal := parens("compound_literal", n)
		if len(chain) == 0 {
			return literal
		}
		parent := chain[len(chain)-1]
		kids, _ := parent["children"].([]any)
		for i, c := range kids {
			if cm, ok := c.(map[string]any); ok && sameNode(cm, n) {
				kids[i] = literal
				break
			}
		}
		// The chain's nodes start with the compound literal's `(` now.
		for _, c := range chain {
			unfixSpan(ctx, c)
		}
		return operand
	}
	return parens("cast_expression", operand)
}

// evaluateCExpr is expr's evaluate: an operation of the S-expression as
// C's node. Each operation's node is given its span as it is built, from
// the innermost out: the span of the first token it keeps, which every
// expression's node has. An external declaration gives the rest of its
// tree theirs when it ends, and an expression parsed on its own (the
// start rule `val`) has no declaration to give them.
func evaluateCExpr(_ *tabnas.Rule, ctx *tabnas.Context, op *tabnasexpr.Op, terms []any) any {
	out := evaluateOp(ctx, op, terms)
	if n := termNode(out); n != nil {
		fixSpansIn(ctx, n)
	}
	return out
}

func evaluateOp(ctx *tabnas.Context, op *tabnasexpr.Op, terms []any) any {
	name := op.Name
	if op.Cast {
		return evalCast(ctx, op, terms)
	}
	if op.Paren {
		switch name {
		case "call-paren":
			return evalCall(op, terms)
		case "subscript-paren":
			return evalSubscript(op, terms)
		}
		return evalGroup(op, terms)
	}
	if op.Ternary {
		return evalConditional(op, terms)
	}
	if op.Infix {
		if name == "comma-infix" {
			return evalComma(ctx, op, terms)
		}
		if assignOps[name] {
			out := evalInfix("assignment_expression", op, terms)
			out["op"] = op.Src
			return out
		}
		if name == "dot-infix" || name == "arrow-infix" {
			return evalMember(op, terms)
		}
		out := evalInfix("binary_expression", op, terms)
		out["op"] = op.Src
		return out
	}
	if op.Prefix {
		return evalUnary(op, terms)
	}
	if op.Suffix {
		return evalPostfix(op, terms)
	}
	out := makeNode("expression", nil)
	for _, t := range terms {
		pushTerm(out, t)
	}
	return out
}

// ---- val: where an expression starts --------------------------------

// The rules of expr's own: a `val` they push is a term of the expression
// being read, not a new one.
var exprOwnRules = setOf("val", "expr", "paren", "ternary", "list", "map", "elem", "pair")

// The contexts whose expression is a full one, where a comma is the comma
// operator; in every other a comma ends the expression, for the context to
// take (an assignment or a conditional expression, in C's grammar).
var fullExpressionRules = setOf(
	"expression_statement", "jump_statement", "paren_condition",
	"for_init", "for_cond", "for_iter", "asm_value",
)

// The C rules a `val` pushes for a term, whose node is the term's.
var termRules = setOf(
	"type_name", "sizeof_type_form", "initializer_list", "string_atom",
	"generic_selection", "statement_expression",
)

// C's values: an identifier or a literal, which never directly follows an
// operand.
var juxtaposedNames = []string{
	"ID", "TYPEDEF_NAME", "MACRO_NAME",
	"LIT_INT", "LIT_FLOAT", "LIT_CHAR", "LIT_STRING",
}

// atom is a literal or an identifier, from its one token.
func atom(kind string, tkn *tabnas.Token) CNode {
	node := makeNode(kind, tokenRef(tkn)["span"].(map[string]any))
	keepToken(node, tkn)
	if kind == "literal_expression" {
		node["literalKind"] = tkn.Name
		node["value"] = tkn.Src
	} else {
		node["name"] = tkn.Src
	}
	return node
}

func atomAction(kind string) tabnas.AltAction {
	return func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = atom(kind, r.O0)
	}
}

// groupContent reports whether the val is the first term of a group's
// content, where a type name is the group's own (a cast's or a compound
// literal's).
func groupContent(r *tabnas.Rule, _ *tabnas.Context) bool {
	paren := r.Parent
	if paren == nil || paren == tabnas.NoRule || paren.Name != "paren" {
		return false
	}
	group, _ := paren.U["expr_paren_group"].(bool)
	_, items := paren.U["expr_items"]
	return group && !items
}

// isRootRule reports whether r is the parse's first rule, with no parent.
func isRootRule(r *tabnas.Rule) bool {
	return r == nil || r == tabnas.NoRule || r.Parent == nil || r.Parent == tabnas.NoRule
}

// installExpr installs @tabnas/expr with C's operator table, and gives
// `val` C's own alternates: the forms that start an expression (a type
// name after `sizeof (`, a statement expression, `_Generic`, a brace list,
// a cast's type name) and C's atoms.
func installExpr(j *tabnas.Tabnas) error {
	values := make([]any, 0, len(juxtaposedNames))
	for _, name := range juxtaposedNames {
		values = append(values, name)
	}
	if err := withInstanceFixedTokens(j, func() error {
		return j.Use(tabnasexpr.Expr, map[string]any{
			"op":        cOpTable(),
			"evaluate":  evaluateCExpr,
			"juxtapose": false,
			"values":    values,
		})
	}); err != nil {
		return err
	}

	tin := func(name string) tabnas.Tin { return j.Token(name) }
	set := func(name string) []tabnas.Tin { return j.TokenSet(name) }
	one := func(name string) [][]tabnas.Tin { return [][]tabnas.Tin{{tin(name)}} }

	j.Rule("val", func(rs *tabnas.RuleSpec, _ *tabnas.Parser) {
		// A new expression, from one of C's contexts: expr's counters start
		// again (the expression around a statement expression or a brace
		// list is not this one's), and the context says whether a comma
		// separates.
		rs.PrependBO(func(r *tabnas.Rule, _ *tabnas.Context) {
			if p := r.Parent; p != nil && p != tabnas.NoRule && !exprOwnRules[p.Name] {
				n := r.EnsureN()
				n["expr"] = 0
				n["expr_prefix"] = 0
				n["expr_suffix"] = 0
				n["expr_paren"] = 0
				n["expr_ternary"] = 0
				if fullExpressionRules[p.Name] {
					n["expr_sep"] = 0
				} else {
					n["expr_sep"] = 1
				}
				n["dlist"] = 0
				n["dmap"] = 0
				n["pk"] = 0
			}
			r.Node = tabnas.Undefined
		})

		// The forms that expr's own alternates would take otherwise: a type
		// name after `sizeof (`, a statement expression `( {`, `_Generic`, a
		// brace list, and a type name as a group's content (a cast's).
		rs.PrependOpen(
			&tabnas.AltSpec{
				S: [][]tabnas.Tin{set("SIZEOF_KW"), {tin("PUNC_LPAREN")}, set("SIMPLE_TYPE_HEAD")},
				B: 3, P: "sizeof_type_form", G: "c-sizeof-type",
			},
			&tabnas.AltSpec{
				S: [][]tabnas.Tin{{tin("PUNC_LPAREN")}, {tin("PUNC_LBRACE")}},
				B: 2, P: "statement_expression", G: "c-stmt-expr",
			},
			&tabnas.AltSpec{S: one("KW__GENERIC"), B: 1, P: "generic_selection", G: "c-generic"},
			&tabnas.AltSpec{S: one("PUNC_LBRACE"), B: 1, P: "initializer_list", G: "c-brace-list"},
			&tabnas.AltSpec{
				S: [][]tabnas.Tin{set("SIMPLE_TYPE_HEAD")}, B: 1, C: groupContent,
				P: "type_name", G: "c-type-name",
			},
		)

		// C's atoms.
		rs.AddOpen(
			&tabnas.AltSpec{S: one("LIT_INT"), A: atomAction("literal_expression"), G: "c-atom,c-int"},
			&tabnas.AltSpec{S: one("LIT_FLOAT"), A: atomAction("literal_expression"), G: "c-atom,c-float"},
			&tabnas.AltSpec{S: one("LIT_CHAR"), A: atomAction("literal_expression"), G: "c-atom,c-char"},
			&tabnas.AltSpec{S: one("KW_NULLPTR"), A: atomAction("literal_expression"), G: "c-atom,c-nullptr"},
			&tabnas.AltSpec{S: one("KW_TRUE"), A: atomAction("literal_expression"), G: "c-atom,c-true"},
			&tabnas.AltSpec{S: one("KW_FALSE"), A: atomAction("literal_expression"), G: "c-atom,c-false"},
			&tabnas.AltSpec{S: one("LIT_STRING"), B: 1, P: "string_atom", G: "c-atom,c-str"},
			&tabnas.AltSpec{S: one("ID"), A: atomAction("identifier_expression"), G: "c-atom,c-id"},
			&tabnas.AltSpec{S: one("MACRO_NAME"), A: atomAction("identifier_expression"), G: "c-atom,c-macro"},
			&tabnas.AltSpec{S: one("TYPEDEF_NAME"), A: atomAction("identifier_expression"), G: "c-atom,c-typedef"},
		)

		// The expression ends where no operator follows. An identifier or a
		// literal, which never directly follows an operand in C, expr
		// refuses before this (its `values`).
		rs.AddClose(&tabnas.AltSpec{G: "c-val-end"})

		// A C rule a term pushed: its node is the term's.
		rs.AddBC(func(r *tabnas.Rule, _ *tabnas.Context) {
			child := r.Child
			if child == nil || child == tabnas.NoRule || !termRules[child.Name] {
				return
			}
			if _, ok := child.Node.(CNode); !ok {
				return
			}
			if seen, _ := r.U["seenTerm"].(*tabnas.Rule); seen == child {
				return
			}
			r.EnsureU()["seenTerm"] = child
			r.Node = child.Node
		})

		// An expression parsed on its own (the start rule `val`): its
		// spans, as an external declaration's are given when it ends.
		rs.AddAC(func(r *tabnas.Rule, ctx *tabnas.Context) {
			if !isRootRule(r) {
				return
			}
			if n, ok := r.Node.(CNode); ok && isNode(n) {
				fixSpansIn(ctx, n)
			}
		})
	})
	return nil
}

// isExpressionRule reports whether r is the rule an expression is built
// in, whose node a context reads back.
func isExpressionRule(r *tabnas.Rule) bool {
	return r != nil && r != tabnas.NoRule && r.Name == "val"
}

// childIsExpr reports whether r's child is an expression rule with a node.
func childIsExpr(r *tabnas.Rule) bool {
	return r.Child != nil && r.Child != tabnas.NoRule &&
		isExpressionRule(r.Child) && childNode(r) != nil
}
