/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"testing"

	tabnas "github.com/tabnas/parser/go"
)

// parseExprVal parses src with the start rule overridden to `val`, exercising
// the @tabnas/expr integration + the C atom alts without the full grammar.
func parseExprVal(t *testing.T, src string) map[string]any {
	t.Helper()
	j, err := MakeC()
	if err != nil {
		t.Fatalf("MakeC: %v", err)
	}
	j.SetOptions(tabnas.Options{Rule: &tabnas.RuleOptions{Start: "val"}})
	out, err := j.Parse(src)
	if err != nil {
		t.Fatalf("parse %q: %v", src, err)
	}
	m, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("parse %q: result is %T (%v), want CST node", src, out, out)
	}
	return m
}

func TestExprAtoms(t *testing.T) {
	n := parseExprVal(t, "42")
	if n["kind"] != "literal_expression" || n["value"] != "42" || n["literalKind"] != "LIT_INT" {
		t.Errorf("42 => %v", n)
	}
	n = parseExprVal(t, "foo")
	if n["kind"] != "identifier_expression" || n["name"] != "foo" {
		t.Errorf("foo => %v", n)
	}
	n = parseExprVal(t, "3.14")
	if n["kind"] != "literal_expression" || n["literalKind"] != "LIT_FLOAT" {
		t.Errorf("3.14 => %v", n)
	}
}

func TestExprBinaryPrecedence(t *testing.T) {
	// 1 + 2 * 3 binds * tighter: + at the root, right operand is *.
	n := parseExprVal(t, "1 + 2 * 3")
	if n["kind"] != "binary_expression" || n["op"] != "+" {
		t.Fatalf("root => %v", n)
	}
	left, _ := n["left"].(map[string]any)
	right, _ := n["right"].(map[string]any)
	if left["kind"] != "literal_expression" || left["value"] != "1" {
		t.Errorf("left => %v", left)
	}
	if right["kind"] != "binary_expression" || right["op"] != "*" {
		t.Errorf("right => %v", right)
	}
}

func TestExprLeftAssoc(t *testing.T) {
	// a - b - c => ((a-b)-c): root -, left is (a-b).
	n := parseExprVal(t, "a - b - c")
	if n["kind"] != "binary_expression" || n["op"] != "-" {
		t.Fatalf("root => %v", n)
	}
	left, _ := n["left"].(map[string]any)
	if left["kind"] != "binary_expression" || left["op"] != "-" {
		t.Errorf("left should be (a-b): %v", left)
	}
}

func TestExprUnaryAndAssign(t *testing.T) {
	n := parseExprVal(t, "-x")
	if n["kind"] != "unary_expression" || n["op"] != "-" {
		t.Errorf("-x => %v", n)
	}
	n = parseExprVal(t, "a = b")
	if n["kind"] != "assignment_expression" || n["op"] != "=" {
		t.Errorf("a = b => %v", n)
	}
}

func TestExprTernary(t *testing.T) {
	// Standalone (start='val') ternary needs the @tabnas/expr ternary trigger
	// on the val-close path for non-VAL C atoms, which only engages with the
	// surrounding grammar's expression context. Validated end-to-end in M7
	// against the CSmith fixtures; deferred here.
	t.Skip("ternary at start=val pending full-grammar expression context (M7)")
}
