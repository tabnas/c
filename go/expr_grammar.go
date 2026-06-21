/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"strings"
	"sync"

	tabnasexpr "github.com/tabnas/expr/go"
	tabnas "github.com/tabnas/parser/go"
)

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

// Wiring for @tabnas/expr on the C jsonic instance. Port of
// ../ts/src/expr-grammar.ts.
//
// The op table reuses the PUNC_*/KW_* tins c.go already registered, so the
// expr plugin's alts match the very tokens the C lexer emits. evaluateCExpr
// converts @tabnas/expr's S-expression Op nodes into the C CST shapes.

// cOpTable returns the full C operator catalog in the map form @tabnas/expr's
// Go option reader expects (map[string]any of map[string]any). Mirrors
// C_OP_TABLE in expr-grammar.ts.
func cOpTable() map[string]any {
	inf := func(src string, left, right int) map[string]any {
		return map[string]any{"src": src, "infix": true, "left": left, "right": right}
	}
	pre := func(src string, right int) map[string]any {
		return map[string]any{"src": src, "prefix": true, "right": right}
	}
	suf := func(src string, left int) map[string]any {
		return map[string]any{"src": src, "suffix": true, "left": left}
	}
	return map[string]any{
		// comma (lowest binary; left-assoc)
		"comma": inf(",", 1000, 1001),

		// assignment (right-assoc — left > right)
		"assign": inf("=", 2001, 2000),
		"plus_a": inf("+=", 2001, 2000),
		"minus_a": inf("-=", 2001, 2000),
		"star_a": inf("*=", 2001, 2000),
		"slash_a": inf("/=", 2001, 2000),
		"pct_a": inf("%=", 2001, 2000),
		"lsh_a": inf("<<=", 2001, 2000),
		"rsh_a": inf(">>=", 2001, 2000),
		"amp_a": inf("&=", 2001, 2000),
		"crt_a": inf("^=", 2001, 2000),
		"pipe_a": inf("|=", 2001, 2000),

		// ternary
		"tern": map[string]any{"src": []any{"?", ":"}, "ternary": true, "left": 3001, "right": 3000},

		// binary (left-assoc)
		"or": inf("||", 4000, 4001),
		"and": inf("&&", 5000, 5001),
		"bor": inf("|", 6000, 6001),
		"bxor": inf("^", 7000, 7001),
		"band": inf("&", 8000, 8001),
		"eq": inf("==", 9000, 9001),
		"ne": inf("!=", 9000, 9001),
		"lt": inf("<", 10000, 10001),
		"le": inf("<=", 10000, 10001),
		"gt": inf(">", 10000, 10001),
		"ge": inf(">=", 10000, 10001),
		"lsh": inf("<<", 11000, 11001),
		"rsh": inf(">>", 11000, 11001),
		"plus": inf("+", 12000, 12001),
		"minus": inf("-", 12000, 12001),
		"star": inf("*", 13000, 13001),
		"slash": inf("/", 13000, 13001),
		"pct": inf("%", 13000, 13001),

		// prefix unary
		"pre_inc": pre("++", 16000),
		"pre_dec": pre("--", 16000),
		"unary_p": pre("+", 16000),
		"unary_n": pre("-", 16000),
		"lnot": pre("!", 16000),
		"bnot": pre("~", 16000),
		"deref": pre("*", 16000),
		"addr": pre("&", 16000),
		"sizeof": pre("sizeof", 16000),
		"alignof": pre("_Alignof", 16000),
		"alignof_g": pre("alignof", 16000),
		"gnualignof": pre("__alignof__", 16000),
		"gnualignof_s": pre("__alignof", 16000),

		// postfix
		"post_inc": suf("++", 17000),
		"post_dec": suf("--", 17000),

		// member access (left-assoc)
		"dot": inf(".", 17000, 17001),
		"arrow": inf("->", 17000, 17001),

		// paren forms
		"paren": map[string]any{"osrc": "(", "csrc": ")", "paren": true,
			"preval": map[string]any{"active": false}},
		"call": map[string]any{"osrc": "(", "csrc": ")", "paren": true,
			"preval": map[string]any{"active": true}},
		"subscript": map[string]any{"osrc": "[", "csrc": "]", "paren": true,
			"preval": map[string]any{"active": true, "required": true}},
	}
}

// assignNames is the set of assignment op names (suffixed -infix).
var assignNames = map[string]bool{
	"assign-infix": true, "plus_a-infix": true, "minus_a-infix": true,
	"star_a-infix": true, "slash_a-infix": true, "pct_a-infix": true,
	"lsh_a-infix": true, "rsh_a-infix": true, "amp_a-infix": true,
	"crt_a-infix": true, "pipe_a-infix": true,
}

// evaluateCExpr converts an @tabnas/expr Op node + evaluated terms into the C
// CST shape. Port of evaluateCExpr in expr-grammar.ts.
func evaluateCExpr(_ *tabnas.Rule, _ *tabnas.Context, op *tabnasexpr.Op, terms []any) any {
	span := firstTermSpan(terms)

	name := op.Name

	if name == "comma-infix" || name == "comma" {
		out := makeNode("comma_expression", span)
		for _, t := range terms {
			if nodeKind(t) == "comma_expression" {
				for _, c := range t.(map[string]any)["children"].([]any) {
					appendChild(out, c)
				}
			} else if t != nil {
				appendChild(out, t)
			}
		}
		return out
	}

	if op.Ternary {
		out := makeNode("conditional_expression", span)
		if len(terms) > 0 && terms[0] != nil {
			appendChild(out, terms[0])
			out["cond"] = terms[0]
		}
		if len(terms) > 1 && terms[1] != nil {
			appendChild(out, terms[1])
			out["then"] = terms[1]
		}
		if len(terms) > 2 && terms[2] != nil {
			appendChild(out, terms[2])
			out["else"] = terms[2]
		}
		return out
	}

	if assignNames[name] {
		out := makeNode("assignment_expression", span)
		if len(terms) > 0 && terms[0] != nil {
			appendChild(out, terms[0])
			out["left"] = terms[0]
		}
		if len(terms) > 1 && terms[1] != nil {
			appendChild(out, terms[1])
			out["right"] = terms[1]
		}
		out["op"] = op.Src
		return out
	}

	if name == "dot-infix" || name == "arrow-infix" {
		out := makeNode("member_expression", span)
		if len(terms) > 0 && terms[0] != nil {
			appendChild(out, terms[0])
			out["object"] = terms[0]
		}
		if len(terms) > 1 && terms[1] != nil {
			appendChild(out, terms[1])
			if m, ok := terms[1].(map[string]any); ok {
				if n, ok := m["name"]; ok {
					out["memberName"] = n
				}
			}
		}
		out["op"] = op.Src
		return out
	}

	if name == "call-paren" {
		out := makeNode("call_expression", span)
		if len(terms) > 0 && terms[0] != nil {
			callee := terms[0]
			appendChild(out, callee)
			if cm, ok := callee.(map[string]any); ok && cm["kind"] == "identifier_expression" {
				out["callee"] = cm["name"]
				out["isMacro"] = identifierIsMacro(cm)
			}
		}
		args := makeNode("argument_list", span)
		if len(terms) > 1 {
			switch t := terms[1].(type) {
			case []any:
				for _, a := range t {
					appendChild(args, a)
				}
			case map[string]any:
				if t["kind"] == "comma_expression" {
					for _, c := range t["children"].([]any) {
						if nodeKind(c) != "token" {
							appendChild(args, c)
						}
					}
				} else {
					appendChild(args, t)
				}
			default:
				if terms[1] != nil {
					appendChild(args, terms[1])
				}
			}
		}
		appendChild(out, args)
		return out
	}

	if name == "subscript-paren" {
		out := makeNode("subscript_expression", span)
		if len(terms) > 0 && terms[0] != nil {
			appendChild(out, terms[0])
			out["target"] = terms[0]
		}
		idx := makeNode("index_list", span)
		if len(terms) > 1 && terms[1] != nil {
			appendChild(idx, terms[1])
		}
		appendChild(out, idx)
		return out
	}

	if name == "paren-paren" {
		out := makeNode("paren_expression", span)
		if len(terms) > 0 && terms[0] != nil {
			appendChild(out, terms[0])
		}
		return out
	}

	if op.Prefix {
		out := makeNode("unary_expression", span)
		out["op"] = op.Src
		if len(terms) > 0 && terms[0] != nil {
			appendChild(out, terms[0])
			out["operand"] = terms[0]
		}
		return out
	}
	if op.Suffix {
		out := makeNode("postfix_unary_expression", span)
		out["op"] = op.Src
		if len(terms) > 0 && terms[0] != nil {
			appendChild(out, terms[0])
			out["target"] = terms[0]
		}
		return out
	}
	if op.Infix {
		out := makeNode("binary_expression", span)
		out["op"] = op.Src
		if len(terms) > 0 && terms[0] != nil {
			appendChild(out, terms[0])
			out["left"] = terms[0]
		}
		if len(terms) > 1 && terms[1] != nil {
			appendChild(out, terms[1])
			out["right"] = terms[1]
		}
		return out
	}

	// Defensive fallback.
	out := makeNode("expression", span)
	for _, t := range terms {
		if t != nil {
			appendChild(out, t)
		}
	}
	return out
}

// firstTermSpan returns terms[0].span or zeroSpan.
func firstTermSpan(terms []any) map[string]any {
	if len(terms) > 0 {
		if m, ok := terms[0].(map[string]any); ok {
			if s, ok := m["span"].(map[string]any); ok {
				return s
			}
		}
	}
	return zeroSpan()
}

// identifierIsMacro reports whether an identifier_expression node's id token
// was a MACRO_NAME.
func identifierIsMacro(idNode map[string]any) bool {
	children, ok := idNode["children"].([]any)
	if !ok {
		return false
	}
	for _, c := range children {
		if cm, ok := c.(map[string]any); ok && cm["kind"] == "token" {
			return cm["tname"] == "MACRO_NAME"
		}
	}
	return false
}

// installExpr installs @tabnas/expr with the C operator catalog and adds the
// C-atom open alts to the val rule. Port of installExpr in expr-grammar.ts.
func installExpr(j *tabnas.Tabnas) error {
	if err := withInstanceFixedTokens(j, func() error {
		return j.Use(tabnasexpr.Expr, map[string]any{
			"op":       cOpTable(),
			"evaluate": evaluateCExpr,
		})
	}); err != nil {
		return err
	}

	tin := func(name string) tabnas.Tin { return j.Token(name) }
	set := func(name string) []tabnas.Tin { return j.TokenSet(name) }
	single := func(name string) [][]tabnas.Tin { return [][]tabnas.Tin{{tin(name)}} }

	j.Rule("val", func(rs *tabnas.RuleSpec, _ *tabnas.Parser) {
		// Multi-token discriminators, prepended so they fire before
		// @tabnas/expr's prefix-op machinery and jsonic's `{`→map handling.
		rs.PrependOpen(
			&tabnas.AltSpec{
				S: [][]tabnas.Tin{set("SIZEOF_KW"), {tin("PUNC_LPAREN")}, set("SIMPLE_TYPE_HEAD")},
				B: 3, P: "sizeof_type_form", G: "c-sizeof-type",
			},
			&tabnas.AltSpec{
				S: [][]tabnas.Tin{{tin("PUNC_LPAREN")}, set("SIMPLE_TYPE_HEAD")},
				B: 2, P: "cast_or_compound_literal", G: "c-cast-or-cl",
			},
			&tabnas.AltSpec{
				S: [][]tabnas.Tin{{tin("PUNC_LPAREN")}, {tin("PUNC_LBRACE")}},
				B: 2, P: "statement_expression", G: "c-stmt-expr",
			},
			&tabnas.AltSpec{
				S: single("KW__GENERIC"), B: 1, P: "generic_selection", G: "c-generic",
			},
			&tabnas.AltSpec{
				S: single("PUNC_LBRACE"), B: 1, P: "initializer_list", G: "c-init-list",
			},
		)

		// C-atom recognisers (appended).
		rs.AddOpen(
			&tabnas.AltSpec{
				S: [][]tabnas.Tin{set("C_ATOM"), set("C_PAREN_OPEN")},
				B: 1, P: "expr", A: cParenPrevalAction,
				U: map[string]any{"paren_preval": true}, G: "c-atom,c-call-preval",
			},
			&tabnas.AltSpec{S: single("LIT_INT"), A: makeAtomAction("literal_expression", "LIT_INT"), G: "c-atom,c-int"},
			&tabnas.AltSpec{S: single("LIT_FLOAT"), A: makeAtomAction("literal_expression", "LIT_FLOAT"), G: "c-atom,c-float"},
			&tabnas.AltSpec{S: single("LIT_CHAR"), A: makeAtomAction("literal_expression", "LIT_CHAR"), G: "c-atom,c-char"},
			&tabnas.AltSpec{S: single("LIT_STRING"), B: 1, P: "string_atom", G: "c-atom,c-str"},
			&tabnas.AltSpec{S: single("ID"), A: makeIDAction(), G: "c-atom,c-id"},
			&tabnas.AltSpec{S: single("MACRO_NAME"), A: makeIDAction(), G: "c-atom,c-macro"},
			&tabnas.AltSpec{S: single("TYPEDEF_NAME"), A: makeIDAction(), G: "c-atom,c-typedef"},
			&tabnas.AltSpec{S: single("KW_NULLPTR"), A: makeAtomAction("literal_expression", "KW_NULLPTR"), G: "c-atom,c-nullptr"},
			&tabnas.AltSpec{S: single("KW_TRUE"), A: makeAtomAction("literal_expression", "KW_TRUE"), G: "c-atom,c-true"},
			&tabnas.AltSpec{S: single("KW_FALSE"), A: makeAtomAction("literal_expression", "KW_FALSE"), G: "c-atom,c-false"},
		)

		// Copy a sub-rule's CST node onto val.node after it closes.
		subRuleNames := map[string]bool{
			"sizeof_type_form": true, "cast_or_compound_literal": true,
			"initializer_list": true, "string_atom": true,
			"generic_selection": true, "statement_expression": true,
		}
		rs.AddBC(func(r *tabnas.Rule, _ *tabnas.Context) {
			if r.Child != nil && r.Child != tabnas.NoRule &&
				subRuleNames[r.Child.Name] && r.Child.Node != nil {
				r.Node = r.Child.Node
			}
		})

		// C-terminator close alts (exit val cleanly on ; , ) ] } :).
		// Bail val on `,`/`:` only outside an @tabnas/expr paren OR ternary
		// form — inside those, the comma/colon belongs to expr (the Go expr
		// port tracks ternary with its own expr_ternary counter).
		notInParen := tabnas.AltCond(func(r *tabnas.Rule, _ *tabnas.Context) bool {
			return r.N["expr_paren"] == 0 && r.N["expr_ternary"] == 0
		})
		rs.AddClose(
			&tabnas.AltSpec{S: single("PUNC_SEMI"), B: 1, G: "c-end-stmt"},
			&tabnas.AltSpec{S: single("PUNC_COMMA"), C: notInParen, B: 1, G: "c-end-comma"},
			&tabnas.AltSpec{S: single("PUNC_RPAREN"), B: 1, G: "c-end-paren"},
			&tabnas.AltSpec{S: single("PUNC_RBRACKET"), B: 1, G: "c-end-bracket"},
			&tabnas.AltSpec{S: single("PUNC_RBRACE"), B: 1, G: "c-end-brace"},
			&tabnas.AltSpec{S: single("PUNC_COLON"), C: notInParen, B: 1, G: "c-end-colon"},
		)

		// Restore an object CST node clobbered by tabnas core's val close
		// (see the long note in expr-grammar.ts / AGENTS.md). Runs after
		// jsonic's own @val-ac.
		rs.AddAC(func(r *tabnas.Rule, _ *tabnas.Context) {
			cn, ok := r.U["cNode"]
			if !ok || cn == nil {
				return
			}
			restore := false
			if r.Node == nil {
				restore = true
			} else if m, isMap := r.Node.(map[string]any); !isMap {
				restore = true
			} else if _, hasKind := m["kind"]; !hasKind {
				restore = true
			}
			if restore {
				r.Node = cn
			}
		})
	})

	return nil
}

// cParenPrevalAction builds the atom CST for a call/subscript preval. Port of
// cParenPrevalAction.
func cParenPrevalAction(r *tabnas.Rule, _ *tabnas.Context) {
	tkn := r.O0
	if strings.HasPrefix(tkn.Name, "LIT_") {
		node := makeNode("literal_expression", tokenSpan(tkn))
		for _, tr := range leadingTriviaRefs(tkn) {
			appendChild(node, tr)
		}
		appendChild(node, tokenRef(tkn))
		node["literalKind"] = tkn.Name
		node["value"] = tkn.Src
		r.Node = node
	} else {
		node := makeNode("identifier_expression", tokenSpan(tkn))
		for _, tr := range leadingTriviaRefs(tkn) {
			appendChild(node, tr)
		}
		appendChild(node, tokenRef(tkn))
		node["name"] = tkn.Src
		r.Node = node
	}
}

// makeAtomAction builds a leaf literal_expression CST node. Port of
// makeAtomAction.
func makeAtomAction(kind, literalKind string) tabnas.AltAction {
	return func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := makeNode(kind, tokenSpan(tkn))
		for _, tr := range leadingTriviaRefs(tkn) {
			appendChild(node, tr)
		}
		appendChild(node, tokenRef(tkn))
		node["literalKind"] = literalKind
		node["value"] = tkn.Src
		r.Node = node
		r.U["cNode"] = node
	}
}

// makeIDAction builds a leaf identifier_expression CST node. Port of
// makeIdAction.
func makeIDAction() tabnas.AltAction {
	return func(r *tabnas.Rule, _ *tabnas.Context) {
		tkn := r.O0
		node := makeNode("identifier_expression", tokenSpan(tkn))
		for _, tr := range leadingTriviaRefs(tkn) {
			appendChild(node, tr)
		}
		appendChild(node, tokenRef(tkn))
		node["name"] = tkn.Src
		r.Node = node
		r.U["cNode"] = node
	}
}
