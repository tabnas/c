/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"sort"
	"testing"
)

// Parameter-list, call-expression, and macro-tagging themes. Mirrors the
// 'parameters: …' (slice 8), 'macro tagging: …' (slice 9), and 'calls: …'
// (slice 10) tests in ../ts/test/c.test.ts.

func TestParametersVoidPrototype(t *testing.T) {
	// TS: 'parameters: void prototype'
	tu := parseTU(t, "int main(void);")
	fp := mustFind(t, tuChildren(t, tu)[0], "function_postfix")
	ptl := mustFind(t, fp, "parameter_type_list")
	params := childrenOfKind(ptl, "parameter_declaration")
	if len(params) != 1 {
		t.Fatalf("parameter_declaration count = %d, want 1", len(params))
	}
}

func TestParametersANSINamed(t *testing.T) {
	// TS: 'parameters: ANSI prototype with named parameters'
	tu := parseTU(t, "int add(int a, int b);")
	ptl := mustFind(t, tuChildren(t, tu)[0], "parameter_type_list")
	params := childrenOfKind(ptl, "parameter_declaration")
	if len(params) != 2 {
		t.Fatalf("parameter_declaration count = %d, want 2", len(params))
	}
	var names []string
	for _, p := range params {
		names = append(names, fieldStr(p, "declaredName"))
	}
	if !eqStrs(names, []string{"a", "b"}) {
		t.Fatalf("declaredNames = %v, want [a b]", names)
	}
}

func TestParametersVariadicEllipsis(t *testing.T) {
	// TS: 'parameters: variadic ellipsis'
	tu := parseTU(t, "int printf(const char *fmt, ...);")
	ptl := mustFind(t, tuChildren(t, tu)[0], "parameter_type_list")
	if v, _ := ptl["variadic"].(bool); !v {
		t.Errorf("parameter_type_list.variadic = %v, want true", ptl["variadic"])
	}
	if findKindByValue(ptl, "parameter_variadic") == nil {
		t.Error("no parameter_variadic")
	}
}

func TestParametersAbstractDeclarators(t *testing.T) {
	// TS: 'parameters: abstract declarators (after typedef registration)'
	src := `
      typedef unsigned long size_t;
      int qsort(void *, size_t, size_t, int (*)(const void *, const void *));
    `
	tu := parseTU(t, src)
	// Find the qsort declaration (the one containing a function_postfix).
	var decl CNode
	for _, c := range tuChildren(t, tu) {
		if findKindByValue(c, "function_postfix") != nil {
			decl = c.(CNode)
			break
		}
	}
	if decl == nil {
		t.Fatal("expected the qsort declaration")
	}
	ptl := mustFind(t, decl, "parameter_type_list")
	// Count direct children only: the fn-pointer parameter's inner
	// function_postfix has its own nested ptl.
	params := childrenOfKind(ptl, "parameter_declaration")
	if len(params) != 4 {
		t.Fatalf("parameter_declaration count = %d, want 4", len(params))
	}
	for i, p := range params {
		if _, has := p["declaredName"]; has {
			t.Errorf("parameter %d carries declaredName %v, want none (abstract)",
				i, p["declaredName"])
		}
	}
}

func TestParametersKandRIdentifierList(t *testing.T) {
	// TS: 'parameters: identifier_list shape detected for K&R prototypes'
	tu := parseTU(t, "int f(a, b);")
	fp := mustFind(t, tuChildren(t, tu)[0], "function_postfix")
	if findKindByValue(fp, "identifier_list") == nil {
		t.Fatal("no identifier_list")
	}
}

// ---- calls -------------------------------------------------------------

func TestCallsSimpleFunctionCall(t *testing.T) {
	// TS: 'calls: simple function call wraps as call_expression'
	tu := parseTU(t, "void g(void) { f(1, 2); }")
	expr := mustFind(t, tuChildren(t, tu)[0], "expression_statement")
	call := mustFind(t, expr, "call_expression")
	if call["callee"] != "f" {
		t.Errorf("callee = %v, want f", call["callee"])
	}
	if m, _ := call["isMacro"].(bool); m {
		t.Errorf("isMacro = %v, want false", call["isMacro"])
	}
	if findKindByValue(call, "argument_list") == nil {
		t.Error("no argument_list")
	}
}

func TestCallsMacroInvocationIsMacro(t *testing.T) {
	// TS: 'calls: macro invocation tagged isMacro'
	tu := parseTU(t, "#define INC(x) ((x)+1)\nvoid g(void) { int y = INC(5); }")
	initN := mustFind(t, tuChildren(t, tu)[1], "initializer")
	call := mustFind(t, initN, "call_expression")
	if call["callee"] != "INC" {
		t.Errorf("callee = %v, want INC", call["callee"])
	}
	if m, _ := call["isMacro"].(bool); !m {
		t.Errorf("isMacro = %v, want true", call["isMacro"])
	}
}

func TestCallsNestedRecursivelyStructured(t *testing.T) {
	// TS: 'calls: nested function call recursively structured'
	tu := parseTU(t, "void g(void) { return f(g(1), h(2)); }")
	ret := mustFind(t, tuChildren(t, tu)[0], "jump_statement")
	outer := mustFind(t, ret, "call_expression")
	if outer["callee"] != "f" {
		t.Fatalf("outer callee = %v, want f", outer["callee"])
	}
	var inner []string
	for _, c := range collectKind(outer, "call_expression") {
		if !sameNode(c, outer) {
			inner = append(inner, fieldStr(c, "callee"))
		}
	}
	sort.Strings(inner)
	if !eqStrs(inner, []string{"g", "h"}) {
		t.Fatalf("inner callees = %v, want [g h]", inner)
	}
}

// ---- macro tagging -------------------------------------------------------

func TestMacroTaggingDefineBodyReference(t *testing.T) {
	// TS: 'macro tagging: identifier in #define body becomes MACRO_NAME later'
	tu := parseTU(t, "#define MAX 100\nint x = MAX;")
	decl := tuChildren(t, tu)[1]
	maxTok := findTokenBySrcNode(decl, "MAX")
	if maxTok == nil || maxTok["tname"] != "MACRO_NAME" {
		t.Errorf("MAX tname = %v, want MACRO_NAME", fieldStr(maxTok, "tname"))
	}
	xTok := findTokenBySrcNode(decl, "x")
	if xTok == nil || xTok["tname"] != "ID" {
		t.Errorf("x tname = %v, want ID", fieldStr(xTok, "tname"))
	}
}

func TestMacroTaggingFunctionLikeReference(t *testing.T) {
	// TS: 'macro tagging: function-like macro reference in expression'
	tu := parseTU(t, "#define INC(x) ((x)+1)\nint y = INC(5);")
	decl := tuChildren(t, tu)[1]
	incTok := findTokenBySrcNode(decl, "INC")
	if incTok == nil || incTok["tname"] != "MACRO_NAME" {
		t.Errorf("INC tname = %v, want MACRO_NAME", fieldStr(incTok, "tname"))
	}
}

func TestMacroTaggingUndefRemoves(t *testing.T) {
	// TS: 'macro tagging: undef removes the macro name'
	tu := parseTU(t, "#define X 1\nint a = X;\n#undef X\nint b = X;")
	kids := tuChildren(t, tu)
	if len(kids) < 4 {
		t.Fatalf("got %d external declarations, want 4", len(kids))
	}
	before := findTokenBySrcNode(kids[1], "X")
	if before == nil || before["tname"] != "MACRO_NAME" {
		t.Errorf("pre-undef X tname = %v, want MACRO_NAME", fieldStr(before, "tname"))
	}
	after := findTokenBySrcNode(kids[3], "X")
	if after == nil || after["tname"] != "ID" {
		t.Errorf("post-undef X tname = %v, want ID", fieldStr(after, "tname"))
	}
}
