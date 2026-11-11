/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"strings"

	tabnas "github.com/tabnas/parser/go"
)

// C's expressions, as precedence climbing in the grammar's rules
// (c-grammar.jsonic, "expressions"). Port of ts/src/expression.ts, which
// has the design: each level of C's expression grammar is a rule, every
// repetition is a replace loop at one depth, and a node whose existence
// only a later token decides (a binary operator after its left operand, a
// postfix operator after its operand, a comma after the first item) is
// wrapped in place when that token arrives.

// juxtaposed is what never directly follows an operand in C: an
// identifier or a literal.
var juxtaposed = setOf(
	"ID", "TYPEDEF_NAME", "MACRO_NAME",
	"LIT_INT", "LIT_FLOAT", "LIT_CHAR", "LIT_STRING",
)

// binaryPrecedence is the binary operators' precedence, by token name: a
// larger number binds tighter. C's levels, from `||` to the
// multiplicative operators.
var binaryPrecedence = map[string]int{
	"PUNC_OR_OR":   4,
	"PUNC_AND_AND": 5,
	"PUNC_PIPE":    6,
	"PUNC_CARET":   7,
	"PUNC_AMP":     8,
	"PUNC_EQ":      9, "PUNC_NE": 9,
	"PUNC_LT": 10, "PUNC_LE": 10, "PUNC_GT": 10, "PUNC_GE": 10,
	"PUNC_LSHIFT": 11, "PUNC_RSHIFT": 11,
	"PUNC_PLUS": 12, "PUNC_MINUS": 12,
	"PUNC_STAR": 13, "PUNC_SLASH": 13, "PUNC_PERCENT": 13,
}

// expressionRules are the rules that build an expression, which a context
// reads back through r.Child.Node.
var expressionRules = setOf(
	"val", "expression", "assignment_expression", "conditional_expression",
	"binary", "binary_rhs", "cast_expression", "unary_expression",
	"postfix_expression", "postfix_more", "primary_expression",
)

func isExpressionRule(r *tabnas.Rule) bool {
	return r != nil && r != tabnas.NoRule && expressionRules[r.Name]
}

// childIsExpr reports whether r's child is an expression rule with a node.
func childIsExpr(r *tabnas.Rule) bool {
	return r.Child != nil && r.Child != tabnas.NoRule &&
		isExpressionRule(r.Child) && childNode(r) != nil
}

// freshChild is the child rule a close state has not attached yet: a
// rule's bc runs each time its close state is entered, after every child
// it pushed returns.
func freshChild(r *tabnas.Rule) *tabnas.Rule {
	child := r.Child
	if child == nil || child == tabnas.NoRule {
		return nil
	}
	if seen, _ := r.U["seenChild"].(*tabnas.Rule); seen == child {
		return nil
	}
	if _, ok := child.Node.(CNode); !ok {
		return nil
	}
	r.U["seenChild"] = child
	return child
}

// carryOn marks a replace that carries a node on: the replacing rule's bo
// finds it.
func carryOn(r *tabnas.Rule) {
	r.K["cont"] = r.Node
}

// isCarried reports whether the rule was carried its node, and forgets
// the mark.
func isCarried(r *tabnas.Rule) bool {
	carried, ok := r.K["cont"]
	if !ok {
		return false
	}
	delete(r.K, "cont")
	cn, _ := carried.(CNode)
	rn, _ := r.Node.(CNode)
	if cn == nil || rn == nil {
		return carried == nil && r.Node == nil
	}
	return sameNode(cn, rn)
}

// wrapInPlace turns node into a new node of kind whose first child is
// what node was. The new node takes the old one's span, as the node a
// rule wraps always gave its wrapper.
func wrapInPlace(node CNode, kind string) CNode {
	inner := make(CNode, len(node))
	for k, v := range node {
		inner[k] = v
	}
	for k := range node {
		delete(node, k)
	}
	node["kind"] = kind
	node["span"] = inner["span"]
	node["children"] = []any{inner}
	node["trivia"] = map[string]any{"leading": []any{}, "trailing": []any{}}
	return inner
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

// relay is a transparent rule's bc: its node is the node of the rule it
// pushed.
func relay(r *tabnas.Rule, _ *tabnas.Context) {
	if child := freshChild(r); child != nil {
		r.Node = child.Node
	}
}

// fresh: a rule starts with no node of its own (the engine hands a pushed
// rule its parent's node, which it must not write to).
func fresh(r *tabnas.Rule, _ *tabnas.Context) {
	if !isCarried(r) {
		r.Node = nil
	}
}

func uStr(r *tabnas.Rule, key string) string {
	s, _ := r.U[key].(string)
	return s
}

func intOr(v any, d int) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	}
	return d
}

func pushChild(r *tabnas.Rule, child *tabnas.Rule) {
	if n := ruleNode(r); n != nil {
		appendChild(n, child.Node)
	}
}

// registerExpressionRefs installs the expression rules' refs.
func registerExpressionRefs(f regFns) {
	cond, action, state := f.cond, f.action, f.state

	// ---- val: the rule an expression starts from ----------------------
	action("@val-start", func(r *tabnas.Rule, _ *tabnas.Context) { r.Node = nil })
	// An expression parsed on its own (the start rule `val`): its spans,
	// as an external declaration's are given when it ends.
	action("@val-end", func(r *tabnas.Rule, ctx *tabnas.Context) {
		relay(r, ctx)
		if r.Parent == nil || r.Parent == tabnas.NoRule {
			if n, ok := r.Node.(CNode); ok && isNode(n) {
				fixSpansIn(ctx, n)
			}
		}
	})

	// ---- expression: the comma operator --------------------------------
	state("@expression-bo", fresh)
	state("@expression-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := freshChild(r)
		if child == nil {
			return
		}
		if nodeKind(r.Node) == "comma_expression" {
			pushChild(r, child)
		} else {
			r.Node = child.Node
		}
	})
	action("@comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		if nodeKind(node) != "comma_expression" {
			wrapInPlace(node, "comma_expression")
		}
		dropToken(node, r.C0)
		carryOn(r)
	})

	// ---- assignment ------------------------------------------------------
	state("@assignment_expression-bo", fresh)
	state("@assignment_expression-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := freshChild(r)
		if child == nil {
			return
		}
		if uBool(r, "op") {
			pushChild(r, child)
			r.U["done"] = true
		} else {
			r.Node = child.Node
		}
	})
	action("@assign", func(r *tabnas.Rule, _ *tabnas.Context) {
		op := r.C0
		node := ruleNode(r)
		wrapInPlace(node, "assignment_expression")
		node["op"] = op.Src
		dropToken(node, op)
		r.U["op"] = true
	})
	cond("@asg-done", func(r *tabnas.Rule, _ *tabnas.Context) bool { return uBool(r, "done") })

	// ---- conditional -------------------------------------------------------
	state("@conditional_expression-bo", fresh)
	state("@conditional_expression-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := freshChild(r)
		if child == nil {
			return
		}
		stage := uStr(r, "stage")
		if stage == "then" || stage == "else" {
			pushChild(r, child)
			if stage == "else" {
				r.U["stage"] = "done"
			}
		} else {
			r.Node = child.Node
		}
	})
	action("@cond-q", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		wrapInPlace(node, "conditional_expression")
		dropToken(node, r.C0)
		r.U["stage"] = "then"
	})
	cond("@cond-at-then", func(r *tabnas.Rule, _ *tabnas.Context) bool { return uStr(r, "stage") == "then" })
	action("@cond-colon", func(r *tabnas.Rule, _ *tabnas.Context) {
		dropToken(ruleNode(r), r.C0)
		r.U["stage"] = "else"
	})
	cond("@cond-done", func(r *tabnas.Rule, _ *tabnas.Context) bool { return uStr(r, "stage") == "done" })
	cond("@cond-at-test", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		_, ok := r.U["stage"]
		return !ok
	})

	// ---- binary operators: precedence climbing ---------------------------
	state("@binary-bo", func(r *tabnas.Rule, ctx *tabnas.Context) {
		fresh(r, ctx)
		r.U["min"] = intOr(r.K["min"], 0)
	})
	state("@binary-bc", relay)
	// The token after the operand (the operator alternate before this one
	// fetched it) is not an identifier or a literal.
	cond("@not-juxtaposed", func(_ *tabnas.Rule, ctx *tabnas.Context) bool {
		t := ctxTok0(ctx)
		return !(t != nil && juxtaposed[t.Name])
	})
	state("@binary_rhs-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		isCarried(r)
		r.U["min"] = intOr(r.K["binMin"], 0)
	})
	state("@binary_rhs-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if child := freshChild(r); child != nil {
			pushChild(r, child)
		}
	})
	cond("@bin-binds", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		prec, ok := binaryPrecedence[r.C0.Name]
		return ok && prec >= intOr(r.U["min"], 0)
	})
	action("@bin-op", func(r *tabnas.Rule, _ *tabnas.Context) {
		op := r.C0
		node := ruleNode(r)
		wrapInPlace(node, "binary_expression")
		node["op"] = op.Src
		dropToken(node, op)
		r.K["binMin"] = intOr(r.U["min"], 0)
		r.K["min"] = binaryPrecedence[op.Name] + 1
		carryOn(r)
	})

	// ---- casts and compound literals ---------------------------------------
	state("@cast_expression-bo", fresh)
	state("@cast_expression-bc", relay)
	cond("@cast-was-cl", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		if nodeKind(r.Node) == "compound_literal" && !uBool(r, "postfixed") {
			r.U["postfixed"] = true
			carryOn(r)
			return true
		}
		return false
	})

	state("@cast_or_compound_literal-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = makeNode("cast_expression", nil)
	})
	action("@cocl-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		keepToken(ruleNode(r), r.O0)
	})
	state("@cast_or_compound_literal-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := freshChild(r)
		if child == nil {
			return
		}
		pushChild(r, child)
		if child.Name == "type_name" {
			return
		}
		r.U["done"] = true
	})
	action("@cocl-cl", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		node["kind"] = "compound_literal"
		keepToken(node, r.C0)
	})
	action("@cocl-cast", func(r *tabnas.Rule, _ *tabnas.Context) {
		keepToken(ruleNode(r), r.C0)
	})
	cond("@cocl-done", func(r *tabnas.Rule, _ *tabnas.Context) bool { return uBool(r, "done") })

	// ---- unary -------------------------------------------------------------
	state("@unary_expression-bo", fresh)
	state("@unary_expression-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := freshChild(r)
		if child == nil {
			return
		}
		if uBool(r, "prefix") {
			pushChild(r, child)
			// A prefix operator's node takes its operand's span, as the
			// node an operator builds takes its first term's.
			ruleNode(r)["span"] = child.Node.(CNode)["span"]
		} else {
			r.Node = child.Node
		}
	})
	action("@prefix", func(r *tabnas.Rule, _ *tabnas.Context) {
		op := r.O0
		node := makeNode("unary_expression", nil)
		node["op"] = op.Src
		dropToken(node, op)
		r.Node = node
		r.U["prefix"] = true
	})

	// ---- postfix -----------------------------------------------------------
	state("@postfix_expression-bo", fresh)
	state("@postfix_expression-bc", relay)
	state("@postfix_more-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		isCarried(r)
	})
	state("@postfix_more-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := freshChild(r)
		if child == nil {
			return
		}
		switch uStr(r, "pending") {
		case "subscript":
			if idx := uNode(r, "index"); idx != nil {
				appendChild(idx, child.Node)
			}
		case "call":
			// The argument list takes its call's span, as it always has.
			cn := child.Node.(CNode)
			cn["span"] = ruleNode(r)["span"]
			pushChild(r, child)
			r.U["args"] = cn
		}
	})
	action("@subscript", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		wrapInPlace(node, "subscript_expression")
		index := makeNode("index_list", node["span"].(map[string]any))
		dropToken(index, r.C0)
		appendChild(node, index)
		r.U["index"] = index
		r.U["pending"] = "subscript"
	})
	cond("@pm-in-subscript", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return uStr(r, "pending") == "subscript"
	})
	cond("@pm-free", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		_, ok := r.U["pending"]
		return !ok
	})
	action("@pf-carry", func(r *tabnas.Rule, _ *tabnas.Context) { carryOn(r) })
	action("@pm-rbracket", func(r *tabnas.Rule, _ *tabnas.Context) {
		dropToken(uNode(r, "index"), r.C0)
		carryOn(r)
	})
	action("@call", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := ruleNode(r)
		callee := wrapInPlace(node, "call_expression")
		if nodeKind(callee) == "identifier_expression" {
			node["callee"] = callee["name"]
			isMacro := false
			kids, _ := callee["children"].([]any)
			for _, c := range kids {
				cm, ok := c.(map[string]any)
				if !ok || cm["kind"] != "token" {
					continue
				}
				tn, _ := cm["tname"].(string)
				if strings.HasPrefix(tn, "TRIVIA") {
					continue
				}
				isMacro = tn == "MACRO_NAME"
				break
			}
			node["isMacro"] = isMacro
		}
		r.U["pending"] = "call"
		r.K["callParen"] = r.C0
	})
	cond("@pm-in-call", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return uStr(r, "pending") == "call"
	})
	action("@pm-rparen", func(r *tabnas.Rule, _ *tabnas.Context) {
		dropToken(uNode(r, "args"), r.C0)
		carryOn(r)
	})
	action("@member", func(r *tabnas.Rule, _ *tabnas.Context) {
		op := r.C0
		name := r.C1
		node := ruleNode(r)
		wrapInPlace(node, "member_expression")
		dropToken(node, op)
		appendChild(node, atom("identifier_expression", name))
		node["memberName"] = name.Src
		node["op"] = op.Src
		carryOn(r)
	})
	action("@postfix", func(r *tabnas.Rule, _ *tabnas.Context) {
		op := r.C0
		node := ruleNode(r)
		wrapInPlace(node, "postfix_unary_expression")
		node["op"] = op.Src
		dropToken(node, op)
		carryOn(r)
	})

	// ---- arguments ---------------------------------------------------------
	state("@argument_list-bo", func(r *tabnas.Rule, _ *tabnas.Context) {
		carried := isCarried(r)
		r.U["carried"] = carried
		if !carried {
			node := makeNode("argument_list", nil)
			if lp, ok := r.K["callParen"].(*tabnas.Token); ok && lp != nil {
				dropToken(node, lp)
			}
			r.Node = node
		}
		delete(r.K, "callParen")
	})
	state("@argument_list-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		if child := freshChild(r); child != nil {
			pushChild(r, child)
		}
	})
	cond("@args-first", func(r *tabnas.Rule, _ *tabnas.Context) bool { return !uBool(r, "carried") })
	action("@args-comma", func(r *tabnas.Rule, _ *tabnas.Context) {
		dropToken(ruleNode(r), r.C0)
		carryOn(r)
	})

	// ---- primary -----------------------------------------------------------
	state("@primary_expression-bo", fresh)
	state("@primary_expression-bc", func(r *tabnas.Rule, _ *tabnas.Context) {
		child := freshChild(r)
		if child == nil {
			return
		}
		if uBool(r, "paren") {
			pushChild(r, child)
			ruleNode(r)["span"] = child.Node.(CNode)["span"]
		} else {
			r.Node = child.Node
		}
	})
	action("@lit", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = atom("literal_expression", r.O0)
	})
	action("@ident", func(r *tabnas.Rule, _ *tabnas.Context) {
		r.Node = atom("identifier_expression", r.O0)
	})
	action("@paren-open", func(r *tabnas.Rule, _ *tabnas.Context) {
		node := makeNode("paren_expression", nil)
		dropToken(node, r.O0)
		r.Node = node
		r.U["paren"] = true
	})
	cond("@paren-pending", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return uBool(r, "paren") && !uBool(r, "parenClosed")
	})
	cond("@paren-free", func(r *tabnas.Rule, _ *tabnas.Context) bool {
		return !uBool(r, "paren") || uBool(r, "parenClosed")
	})
	action("@paren-close", func(r *tabnas.Rule, _ *tabnas.Context) {
		dropToken(ruleNode(r), r.C0)
		r.U["parenClosed"] = true
	})
}
