/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

// Expression-shape theme (postfix, cast, sizeof, string concatenation).
// Mirrors the 'expr: …' tests (slice 12) in ../ts/test/c.test.ts.

func TestExprPostfixSubscriptAndMember(t *testing.T) {
	// TS: 'expr: postfix subscript and member access'
	tu := parseTU(t, "void g(void) { x = a[i].field->next; }")
	stmt := mustFind(t, tuChildren(t, tu)[0], "expression_statement")
	var asn CNode
	for _, c := range kidsOf(stmt) {
		if nodeKind(c) == "assignment_expression" {
			asn = c.(CNode)
			break
		}
	}
	if asn == nil {
		t.Fatal("no assignment_expression")
	}
	// RHS: member_expression (->) → member_expression (.) → subscript.
	rhs := field(asn, "right")
	if rhs == nil || rhs["kind"] != "member_expression" {
		t.Fatalf("rhs kind = %v, want member_expression", rhs["kind"])
	}
	if rhs["op"] != "->" {
		t.Errorf("rhs op = %v, want ->", rhs["op"])
	}
	if rhs["memberName"] != "next" {
		t.Errorf("rhs memberName = %v, want next", rhs["memberName"])
	}
	obj := field(rhs, "object")
	if obj == nil || obj["kind"] != "member_expression" {
		t.Fatalf("rhs.object kind = %v, want member_expression", obj["kind"])
	}
	if obj["op"] != "." {
		t.Errorf("rhs.object op = %v, want .", obj["op"])
	}
	if obj["memberName"] != "field" {
		t.Errorf("rhs.object memberName = %v, want field", obj["memberName"])
	}
	sub := field(obj, "object")
	if sub == nil || sub["kind"] != "subscript_expression" {
		t.Fatalf("rhs.object.object kind = %v, want subscript_expression", sub["kind"])
	}
}

func TestExprCastWithTypedefName(t *testing.T) {
	// TS: 'expr: cast expression detected when paren head is a typedef-name'
	tu := parseTU(t, "typedef int T; void g(void) { int x = (T) y; }")
	var fn any
	for _, c := range tuChildren(t, tu) {
		if m, ok := c.(map[string]any); ok && m["declKind"] == "function_definition" {
			fn = c
			break
		}
	}
	if fn == nil {
		t.Fatal("no function_definition")
	}
	cast := mustFind(t, fn, "cast_expression")
	if cast["typeName"] == nil {
		t.Error("cast_expression has no typeName")
	}
	op := field(cast, "operand")
	if op == nil || op["kind"] != "identifier_expression" {
		t.Fatalf("operand kind = %v, want identifier_expression", op["kind"])
	}
	if op["name"] != "y" {
		t.Errorf("operand name = %v, want y", op["name"])
	}
}

func TestExprSizeofExpression(t *testing.T) {
	// TS: 'expr: sizeof on an expression'
	tu := parseTU(t, "void g(void) { int n = sizeof x; }")
	u := mustFind(t, tuChildren(t, tu)[0], "unary_expression")
	if u["op"] != "sizeof" {
		t.Fatalf("op = %v, want sizeof", u["op"])
	}
	op := field(u, "operand")
	if op == nil || op["kind"] != "identifier_expression" {
		t.Fatalf("operand kind = %v, want identifier_expression", op["kind"])
	}
}

func TestExprSizeofTypeName(t *testing.T) {
	// TS: 'expr: sizeof on a type-name'
	tu := parseTU(t, "void g(void) { int n = sizeof(int); }")
	u := mustFind(t, tuChildren(t, tu)[0], "unary_expression")
	if u["op"] != "sizeof" {
		t.Fatalf("op = %v, want sizeof", u["op"])
	}
	op := field(u, "operand")
	if op == nil || op["kind"] != "type_name" {
		t.Fatalf("operand kind = %v, want type_name", op["kind"])
	}
}

func TestExprAdjacentStringConcat(t *testing.T) {
	// TS: 'expr: adjacent string literals concatenate into one
	// literal_expression'
	tu := parseTU(t, `void g(void) { const char *s = "foo" "bar"; }`)
	lit := mustFind(t, tuChildren(t, tu)[0], "literal_expression")
	if lit["literalKind"] != "LIT_STRING" {
		t.Fatalf("literalKind = %v, want LIT_STRING", lit["literalKind"])
	}
	n := 0
	for _, c := range kidsOf(lit) {
		if m, ok := c.(map[string]any); ok &&
			m["kind"] == "token" && m["tname"] == "LIT_STRING" {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("LIT_STRING token count = %d, want 2", n)
	}
}
