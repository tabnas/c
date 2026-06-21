/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

// C-expression parser. Port of ../ts/src/expr.ts.
//
// The TypeScript original delegates binary-operator precedence to
// @tabnas/expr's `testing.prattify` / `testing.opify` helpers. Those symbols
// are NOT exported by the Go @tabnas/expr package, so this port carries a
// small self-contained Pratt loop (cExprOp + cPrattify + cAppendTerm) that
// reproduces the same behaviour over [op, left, right] slices. The result is
// then converted to the CST node shapes (binary_expression, etc.) the rest of
// the codebase consumes.
//
// Atoms, prefix unary forms, postfix forms (call / subscript / member), casts,
// sizeof, _Generic, statement-expressions, and compound literals remain
// hand-rolled — those constructs don't fit the prefix/infix/suffix
// classification cleanly enough to be worth expressing through the Pratt loop.
//
// expr.go and structure.go are the same Go package, so they share TokenStream
// and CNode directly (the TS `import type { TokenStream, CNode }` becomes
// nothing).

// cExprOp is the minimal operator description used by the local Pratt loop. It
// mirrors the fields prattify actually reads (left/right precedence, terms,
// src).
type cExprOp struct {
	src   string
	left  int
	right int
	terms int
}

var cTypeKeywords = map[string]bool{
	"KW_VOID": true, "KW_CHAR": true, "KW_SHORT": true, "KW_INT": true,
	"KW_LONG": true, "KW_FLOAT": true, "KW_DOUBLE": true, "KW_SIGNED": true,
	"KW_UNSIGNED": true, "KW_BOOL": true, "KW__BOOL": true,
	"KW__COMPLEX": true, "KW__IMAGINARY": true,
	"KW___SIGNED__": true, "KW___SIGNED": true,
	"KW___INT8": true, "KW___INT16": true, "KW___INT32": true, "KW___INT64": true,
	"KW_CONST": true, "KW_VOLATILE": true, "KW_RESTRICT": true, "KW__ATOMIC": true,
	"KW___CONST__": true, "KW___CONST": true,
	"KW___VOLATILE__": true, "KW___VOLATILE": true,
	"KW___RESTRICT__": true, "KW___RESTRICT": true,
	"KW_STRUCT": true, "KW_UNION": true, "KW_ENUM": true,
	"KW_TYPEOF": true, "KW_TYPEOF_UNQUAL": true,
	"KW___TYPEOF__": true, "KW___TYPEOF": true,
	"KW__BITINT": true,
}

// Binary operators (C23 §6.5 levels 4..13), keyed by token name.
var cInfixByToken = map[string]*cExprOp{
	"PUNC_OR_OR":   {src: "||", left: 4000, right: 4001, terms: 2},
	"PUNC_AND_AND": {src: "&&", left: 5000, right: 5001, terms: 2},
	"PUNC_PIPE":    {src: "|", left: 6000, right: 6001, terms: 2},
	"PUNC_CARET":   {src: "^", left: 7000, right: 7001, terms: 2},
	"PUNC_AMP":     {src: "&", left: 8000, right: 8001, terms: 2},
	"PUNC_EQ":      {src: "==", left: 9000, right: 9001, terms: 2},
	"PUNC_NE":      {src: "!=", left: 9000, right: 9001, terms: 2},
	"PUNC_LT":      {src: "<", left: 10000, right: 10001, terms: 2},
	"PUNC_LE":      {src: "<=", left: 10000, right: 10001, terms: 2},
	"PUNC_GT":      {src: ">", left: 10000, right: 10001, terms: 2},
	"PUNC_GE":      {src: ">=", left: 10000, right: 10001, terms: 2},
	"PUNC_LSHIFT":  {src: "<<", left: 11000, right: 11001, terms: 2},
	"PUNC_RSHIFT":  {src: ">>", left: 11000, right: 11001, terms: 2},
	"PUNC_PLUS":    {src: "+", left: 12000, right: 12001, terms: 2},
	"PUNC_MINUS":   {src: "-", left: 12000, right: 12001, terms: 2},
	"PUNC_STAR":    {src: "*", left: 13000, right: 13001, terms: 2},
	"PUNC_SLASH":   {src: "/", left: 13000, right: 13001, terms: 2},
	"PUNC_PERCENT": {src: "%", left: 13000, right: 13001, terms: 2},
}

// Assignment operators — all share precedence; right-associative (left>right).
var cAssignByToken = map[string]*cExprOp{
	"PUNC_ASSIGN":         {src: "=", left: 2001, right: 2000, terms: 2},
	"PUNC_PLUS_ASSIGN":    {src: "+=", left: 2001, right: 2000, terms: 2},
	"PUNC_MINUS_ASSIGN":   {src: "-=", left: 2001, right: 2000, terms: 2},
	"PUNC_STAR_ASSIGN":    {src: "*=", left: 2001, right: 2000, terms: 2},
	"PUNC_SLASH_ASSIGN":   {src: "/=", left: 2001, right: 2000, terms: 2},
	"PUNC_PERCENT_ASSIGN": {src: "%=", left: 2001, right: 2000, terms: 2},
	"PUNC_LSHIFT_ASSIGN":  {src: "<<=", left: 2001, right: 2000, terms: 2},
	"PUNC_RSHIFT_ASSIGN":  {src: ">>=", left: 2001, right: 2000, terms: 2},
	"PUNC_AMP_ASSIGN":     {src: "&=", left: 2001, right: 2000, terms: 2},
	"PUNC_CARET_ASSIGN":   {src: "^=", left: 2001, right: 2000, terms: 2},
	"PUNC_PIPE_ASSIGN":    {src: "|=", left: 2001, right: 2000, terms: 2},
}

var cPrefixOps = map[string]bool{
	"PUNC_PLUS_PLUS": true, "PUNC_MINUS_MINUS": true,
	"PUNC_PLUS": true, "PUNC_MINUS": true, "PUNC_BANG": true, "PUNC_TILDE": true,
	"PUNC_STAR": true, "PUNC_AMP": true,
	"KW_SIZEOF": true, "KW__ALIGNOF": true, "KW_ALIGNOF": true,
	"KW___ALIGNOF__": true, "KW___ALIGNOF": true,
	"KW___REAL__": true, "KW___IMAG__": true, "KW___EXTENSION__": true,
}

var cPostfixOps = map[string]bool{
	"PUNC_PLUS_PLUS": true, "PUNC_MINUS_MINUS": true,
}

// ---- self-contained Pratt loop --------------------------------------
//
// An expression tree is a *cExprTree wrapping a []any of the form
// [*cExprOp, left, right]. The op token (with its trivia) is carried alongside
// in the cExprTree.carry field — Go slices can't have arbitrary extra fields
// the way the TS JS arrays can.
//
// cPrattify integrates a new op into an existing tree by precedence, returning
// the (possibly new) root tree. cAppendTerm fills the slot left open by the
// integration with the freshly-parsed right operand. This replicates the TS
// appendTerm + prattify pair.

// opCarry holds the op-token ref and its leading trivia for a tree node.
type opCarry struct {
	trivia []any
	ref    map[string]any
}

// cExprTree wraps the op-array slice plus the per-node op-token carry. Using a
// pointer wrapper means re-pointing the slice in one place is visible to all
// holders (mirrors the TS in-place array mutation / the Go expr ListRef trick).
type cExprTree struct {
	val   []any    // [*cExprOp, left, right...]
	carry *opCarry // op-token + trivia for THIS node
}

func (t *cExprTree) op() *cExprOp { return t.val[0].(*cExprOp) }

// cAppendTerm fills the deepest open slot of the tree with term. prattify
// leaves the array short by exactly one term in the slot it resolved.
func cAppendTerm(node *cExprTree, term any) {
	cur := node
	for {
		op := cur.op()
		if len(cur.val)-1 < op.terms {
			cur.val = append(cur.val, term)
			return
		}
		last := cur.val[len(cur.val)-1]
		if sub, ok := last.(*cExprTree); ok {
			cur = sub
			continue
		}
		break
	}
	node.val = append(node.val, term)
}

// cPrattify integrates op into the existing tree by precedence and returns the
// outermost tree. The new op's right operand slot is left open for
// cAppendTerm. carry is the op-token carry for the new op.
func cPrattify(node *cExprTree, op *cExprOp, carry *opCarry) *cExprTree {
	exprOp := node.op()
	// op lower-or-equal precedence: wrap the whole tree.
	if op.left <= exprOp.right {
		wrapped := &cExprTree{val: []any{op, node}, carry: carry}
		return wrapped
	}
	// op higher precedence: drill into the rightmost term.
	end := exprOp.terms
	if end < len(node.val) {
		if sub, ok := node.val[end].(*cExprTree); ok {
			subOp := sub.op()
			if subOp.right < op.left {
				node.val[end] = cPrattify(sub, op, carry)
				return node
			}
		}
		node.val[end] = &cExprTree{val: []any{op, node.val[end]}, carry: carry}
		return node
	}
	return node
}

// ---- entry ----------------------------------------------------------

func parseExpression(ts *TokenStream, stoppers map[string]bool) CNode {
	return parseCommaExpr(ts, stoppers)
}

func isStop(name string, stoppers map[string]bool) bool {
	return name == "" || stoppers[name]
}

func parseCommaExpr(ts *TokenStream, stoppers map[string]bool) CNode {
	first := parseAssignmentExpression(ts, stoppers)
	if first == nil {
		return nil
	}
	if stoppers["PUNC_COMMA"] || ts.peekName() != "PUNC_COMMA" {
		return first
	}
	node := makeNode("comma_expression", spanFromNode(first))
	appendChild(node, first)
	for ts.peekName() == "PUNC_COMMA" && !stoppers["PUNC_COMMA"] {
		ts.takeInto(node) // ','
		next := parseAssignmentExpression(ts, stoppers)
		if next == nil {
			break
		}
		appendChild(node, next)
	}
	return node
}

func parseAssignmentExpression(ts *TokenStream, stoppers map[string]bool) CNode {
	left := parseConditionalExpression(ts, stoppers)
	if left == nil {
		return nil
	}
	opName := ts.peekName()
	if opName == "" || stoppers[opName] {
		return left
	}
	op := cAssignByToken[opName]
	if op == nil {
		return left
	}
	node := makeNode("assignment_expression", spanFromNode(left))
	appendChild(node, left)
	node["left"] = left
	ts.takeInto(node) // '=' / '+=' / etc.
	node["op"] = op.src
	right := parseAssignmentExpression(ts, stoppers) // right-assoc
	if right != nil {
		appendChild(node, right)
		node["right"] = right
	}
	return node
}

func parseConditionalExpression(ts *TokenStream, stoppers map[string]bool) CNode {
	cond := parseBinaryExpression(ts, stoppers)
	if cond == nil {
		return nil
	}
	if ts.peekName() != "PUNC_QUESTION" {
		return cond
	}
	node := makeNode("conditional_expression", spanFromNode(cond))
	appendChild(node, cond)
	node["cond"] = cond
	ts.takeInto(node) // '?'
	then := parseExpression(ts, unionStoppers(stoppers, "PUNC_COLON"))
	if then != nil {
		appendChild(node, then)
		node["then"] = then
	}
	if ts.peekName() == "PUNC_COLON" {
		ts.takeInto(node)
	}
	els := parseAssignmentExpression(ts, stoppers)
	if els != nil {
		appendChild(node, els)
		node["else"] = els
	}
	return node
}

func parseBinaryExpression(ts *TokenStream, stoppers map[string]bool) CNode {
	first := parseUnary(ts, stoppers)
	if first == nil {
		return nil
	}
	var tree *cExprTree // nil until the first infix op

	var leaf any = first // the standalone leaf when no infix seen yet
	for {
		n := ts.peekName()
		if isStop(n, stoppers) {
			break
		}
		op := cInfixByToken[n]
		if op == nil {
			break
		}
		taken := ts.take()
		if taken == nil {
			break
		}
		carry := &opCarry{trivia: taken.trivia, ref: taken.ref}
		right := parseUnary(ts, stoppers)
		if right == nil {
			break
		}
		if tree == nil {
			tree = &cExprTree{val: []any{op, leaf, right}, carry: carry}
		} else {
			tree = cPrattify(tree, op, carry)
			cAppendTerm(tree, right)
		}
	}
	if tree == nil {
		return first
	}
	return cExprTreeToCST(tree)
}

// cExprTreeToCST walks the Pratt tree depth-first and emits binary_expression
// nodes whose children preserve source order (left, opToken, right).
func cExprTreeToCST(node any) CNode {
	tree, ok := node.(*cExprTree)
	if !ok {
		if cn, ok := node.(CNode); ok {
			return cn
		}
		return nil
	}
	op := tree.op()
	left := cExprTreeToCST(tree.val[1])
	var right CNode
	if len(tree.val) > 2 {
		right = cExprTreeToCST(tree.val[2])
	}
	out := makeNode("binary_expression", spanFromNode(left))
	if left != nil {
		appendChild(out, left)
		out["left"] = left
	}
	if tree.carry != nil {
		for _, tr := range tree.carry.trivia {
			appendChild(out, tr)
		}
		appendChild(out, tree.carry.ref)
	}
	if right != nil {
		appendChild(out, right)
		out["right"] = right
	}
	out["op"] = op.src
	return out
}

// ---- unary / postfix / primary --------------------------------------

func parseUnary(ts *TokenStream, stoppers map[string]bool) CNode {
	n := ts.peekName()
	if n != "" && cPrefixOps[n] {
		startTkn := ts.peek()
		node := makeNode("unary_expression", tokenSpan(startTkn))
		opTkn := ts.takeInto(node)
		node["op"] = opTkn.Src
		if (n == "KW_SIZEOF" || n == "KW__ALIGNOF" || n == "KW_ALIGNOF" ||
			n == "KW___ALIGNOF__" || n == "KW___ALIGNOF") &&
			ts.peekName() == "PUNC_LPAREN" && cLooksLikeTypeName(ts, 1) {
			tn := makeNode("type_name", tokenSpan(ts.peek()))
			cConsumeBalanced(ts, tn, "PUNC_LPAREN", "PUNC_RPAREN")
			appendChild(node, tn)
			node["operand"] = tn
			return node
		}
		operand := parseUnary(ts, stoppers)
		if operand != nil {
			appendChild(node, operand)
			node["operand"] = operand
		}
		return node
	}
	return parsePostfix(ts, stoppers)
}

func parsePostfix(ts *TokenStream, stoppers map[string]bool) CNode {
	target := parsePrimary(ts, stoppers)
	if target == nil {
		return nil
	}
	for {
		n := ts.peekName()
		if n == "" || stoppers[n] {
			break
		}
		switch {
		case n == "PUNC_LBRACKET":
			node := makeNode("subscript_expression", spanFromNode(target))
			appendChild(node, target)
			node["target"] = target
			idx := makeNode("index_list", tokenSpan(ts.peek()))
			cConsumeBalanced(ts, idx, "PUNC_LBRACKET", "PUNC_RBRACKET")
			appendChild(node, idx)
			target = node
		case n == "PUNC_LPAREN":
			node := makeNode("call_expression", spanFromNode(target))
			appendChild(node, target)
			if callee := unwrapCallee(target); callee != nil {
				node["callee"] = callee["src"]
				node["isMacro"] = callee["tname"] == "MACRO_NAME"
			}
			args := makeNode("argument_list", tokenSpan(ts.peek()))
			ts.takeInto(args) // '('
			for !ts.done() && ts.peekName() != "PUNC_RPAREN" {
				a := parseAssignmentExpression(ts, map[string]bool{"PUNC_COMMA": true, "PUNC_RPAREN": true})
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
			target = node
		case n == "PUNC_DOT" || n == "PUNC_ARROW":
			node := makeNode("member_expression", spanFromNode(target))
			appendChild(node, target)
			node["object"] = target
			opTkn := ts.takeInto(node)
			node["op"] = opTkn.Src
			memTkn := ts.peek()
			if memTkn != nil && (memTkn.Name == "ID" || memTkn.Name == "TYPEDEF_NAME" ||
				memTkn.Name == "MACRO_NAME") {
				taken := ts.take()
				for _, tr := range taken.trivia {
					appendChild(node, tr)
				}
				appendChild(node, taken.ref)
				node["memberName"] = taken.tkn.Src
			}
			target = node
		case cPostfixOps[n]:
			node := makeNode("postfix_unary_expression", spanFromNode(target))
			appendChild(node, target)
			node["target"] = target
			opTkn := ts.takeInto(node)
			node["op"] = opTkn.Src
			target = node
		default:
			return target
		}
	}
	return target
}

func unwrapCallee(node CNode) map[string]any {
	if nodeKind(node) != "identifier_expression" {
		return nil
	}
	children, _ := node["children"].([]any)
	for _, c := range children {
		if cm, ok := c.(map[string]any); ok && cm["kind"] == "token" {
			return cm
		}
	}
	return nil
}

func parsePrimary(ts *TokenStream, stoppers map[string]bool) CNode {
	t := ts.peek()
	if t == nil {
		return nil
	}
	n := t.Name
	if n == "KW_NULLPTR" || n == "KW_TRUE" || n == "KW_FALSE" {
		node := makeNode("literal_expression", tokenSpan(t))
		taken := ts.take()
		for _, tr := range taken.trivia {
			appendChild(node, tr)
		}
		appendChild(node, taken.ref)
		node["literalKind"] = n
		node["value"] = taken.tkn.Src
		return node
	}
	if n == "LIT_INT" || n == "LIT_FLOAT" || n == "LIT_CHAR" || n == "LIT_STRING" {
		node := makeNode("literal_expression", tokenSpan(t))
		taken := ts.take()
		for _, tr := range taken.trivia {
			appendChild(node, tr)
		}
		appendChild(node, taken.ref)
		node["literalKind"] = n
		node["value"] = taken.tkn.Src
		if n == "LIT_STRING" {
			for ts.peekName() == "LIT_STRING" {
				more := ts.take()
				for _, tr := range more.trivia {
					appendChild(node, tr)
				}
				appendChild(node, more.ref)
			}
		}
		return node
	}
	if n == "ID" || n == "MACRO_NAME" || n == "TYPEDEF_NAME" {
		node := makeNode("identifier_expression", tokenSpan(t))
		taken := ts.take()
		for _, tr := range taken.trivia {
			appendChild(node, tr)
		}
		appendChild(node, taken.ref)
		node["name"] = taken.tkn.Src
		return node
	}
	if n == "KW__GENERIC" {
		return parseGenericSelection(ts)
	}
	if n == "PUNC_LPAREN" {
		// GCC statement-expression `({ ... })`.
		if ts.peekName(1) == "PUNC_LBRACE" {
			node := makeNode("statement_expression", tokenSpan(t))
			cConsumeBalanced(ts, node, "PUNC_LPAREN", "PUNC_RPAREN")
			return node
		}
		if cLooksLikeTypeName(ts, 1) {
			m := ts.mark()
			opener := ts.take() // '('
			tn := makeNode("type_name", tokenSpan(opener.tkn))
			appendChild(tn, opener.ref)
			depth := 1
			for !ts.done() && depth > 0 {
				nn := ts.peekName()
				if nn == "PUNC_LPAREN" {
					depth++
				} else if nn == "PUNC_RPAREN" {
					depth--
					if depth == 0 {
						ts.takeInto(tn) // closing ')'
						break
					}
				}
				ts.takeInto(tn)
			}
			if ts.peekName() == "PUNC_LBRACE" {
				cl := makeNode("compound_literal", spanFromNode(tn))
				appendChild(cl, tn)
				cl["typeName"] = tn
				initN := makeNode("initializer_list", tokenSpan(ts.peek()))
				cConsumeBalanced(ts, initN, "PUNC_LBRACE", "PUNC_RBRACE")
				appendChild(cl, initN)
				return cl
			}
			operand := parseUnary(ts, stoppers)
			if operand != nil {
				cast := makeNode("cast_expression", spanFromNode(tn))
				appendChild(cast, tn)
				appendChild(cast, operand)
				cast["typeName"] = tn
				cast["operand"] = operand
				return cast
			}
			ts.restore(m)
		}
		node := makeNode("paren_expression", tokenSpan(t))
		ts.takeInto(node) // '('
		inner := parseExpression(ts, map[string]bool{"PUNC_RPAREN": true})
		if inner != nil {
			appendChild(node, inner)
		}
		if ts.peekName() == "PUNC_RPAREN" {
			ts.takeInto(node)
		}
		return node
	}
	return nil
}

func cLooksLikeTypeName(ts *TokenStream, off int) bool {
	t := ts.peek(off)
	if t == nil {
		return false
	}
	if t.Name == "TYPEDEF_NAME" {
		return true
	}
	return cTypeKeywords[t.Name]
}

func parseGenericSelection(ts *TokenStream) CNode {
	startTkn := ts.peek()
	node := makeNode("generic_selection", tokenSpan(startTkn))
	ts.takeInto(node) // '_Generic'
	if ts.peekName() != "PUNC_LPAREN" {
		return node
	}
	ts.takeInto(node) // '('
	ctrl := parseExpression(ts, map[string]bool{"PUNC_COMMA": true, "PUNC_RPAREN": true})
	if ctrl != nil {
		wrap := makeNode("generic_controlling_expression", spanFromNode(ctrl))
		appendChild(wrap, ctrl)
		wrap["expression"] = ctrl
		appendChild(node, wrap)
		node["controlling"] = wrap
	}
	assocs := []any{}
	for ts.peekName() == "PUNC_COMMA" {
		ts.takeInto(node) // ','
		ga := parseGenericAssociation(ts)
		if ga != nil {
			appendChild(node, ga)
			assocs = append(assocs, ga)
		} else {
			break
		}
	}
	node["associations"] = assocs
	if ts.peekName() == "PUNC_RPAREN" {
		ts.takeInto(node)
	}
	return node
}

func parseGenericAssociation(ts *TokenStream) CNode {
	startTkn := ts.peek()
	if startTkn == nil {
		return nil
	}
	node := makeNode("generic_association", tokenSpan(startTkn))
	if startTkn.Name == "KW_DEFAULT" {
		ts.takeInto(node)
		node["associationKind"] = "default"
	} else {
		tn := makeNode("type_name", tokenSpan(startTkn))
		parenD, bracketD := 0, 0
		for !ts.done() {
			n := ts.peekName()
			if n == "PUNC_LPAREN" {
				parenD++
				ts.takeInto(tn)
				continue
			}
			if n == "PUNC_RPAREN" {
				if parenD == 0 {
					break
				}
				parenD--
				ts.takeInto(tn)
				continue
			}
			if n == "PUNC_LBRACKET" {
				bracketD++
				ts.takeInto(tn)
				continue
			}
			if n == "PUNC_RBRACKET" {
				if bracketD == 0 {
					break
				}
				bracketD--
				ts.takeInto(tn)
				continue
			}
			if parenD == 0 && bracketD == 0 &&
				(n == "PUNC_COLON" || n == "PUNC_COMMA" || n == "PUNC_RPAREN") {
				break
			}
			ts.takeInto(tn)
		}
		appendChild(node, tn)
		node["typeName"] = tn
		node["associationKind"] = "type"
	}
	if ts.peekName() == "PUNC_COLON" {
		ts.takeInto(node)
	}
	expr := parseExpression(ts, map[string]bool{"PUNC_COMMA": true, "PUNC_RPAREN": true})
	if expr != nil {
		appendChild(node, expr)
		node["value"] = expr
	}
	return node
}

// cConsumeBalanced mirrors structure.go's consumeBalanced (kept separate to
// match the TS file boundary; both behave identically).
func cConsumeBalanced(ts *TokenStream, node CNode, open, close string) bool {
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

// spanFromNode returns n["span"] as a map, or zeroSpan.
func spanFromNode(n any) map[string]any {
	if m, ok := n.(map[string]any); ok {
		if s, ok := m["span"].(map[string]any); ok {
			return s
		}
	}
	return zeroSpan()
}

// unionStoppers returns a copy of stoppers with extra added.
func unionStoppers(stoppers map[string]bool, extra ...string) map[string]bool {
	out := make(map[string]bool, len(stoppers)+len(extra))
	for k, v := range stoppers {
		out[k] = v
	}
	for _, e := range extra {
		out[e] = true
	}
	return out
}
