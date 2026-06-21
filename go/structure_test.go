/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

// These tests parse declarations end-to-end via Parse and assert the
// structured CST shapes produced by the ported legacy structurer
// (structure.go + expr.go). They mirror a representative subset of the
// TypeScript suite in ../ts/test/c.test.ts.
//
// extended:true matches the TS shared instance (so __attribute__ etc. lex).

func parseTU(t *testing.T, src string) CNode {
	t.Helper()
	out, err := Parse(src, map[string]any{"extended": true})
	if err != nil {
		t.Fatalf("Parse(%q) error: %v", src, err)
	}
	tu, ok := out.(CNode)
	if !ok {
		t.Fatalf("Parse(%q) returned %T, want CNode", src, out)
	}
	if tu["kind"] != "translation_unit" {
		t.Fatalf("root kind = %v, want translation_unit", tu["kind"])
	}
	return tu
}

func tuChildren(t *testing.T, tu CNode) []any {
	t.Helper()
	ch, _ := tu["children"].([]any)
	return ch
}

// findKindByValue searches node recursively for the first node whose "kind"
// field equals kind. (findKind in structure.go searches by key existence.)
func findKindByValue(node any, kind string) CNode {
	m, ok := node.(map[string]any)
	if !ok {
		return nil
	}
	if m["kind"] == kind {
		return m
	}
	if children, ok := m["children"].([]any); ok {
		for _, c := range children {
			if hit := findKindByValue(c, kind); hit != nil {
				return hit
			}
		}
	}
	return nil
}

// walkTokenSrcs returns token srcs in source order under node.
func walkTokenSrcs(node any) []string {
	var out []string
	var visit func(n any)
	visit = func(n any) {
		m, ok := n.(map[string]any)
		if !ok {
			return
		}
		if m["kind"] == "token" {
			if s, ok := m["src"].(string); ok {
				out = append(out, s)
			}
			return
		}
		if children, ok := m["children"].([]any); ok {
			for _, c := range children {
				visit(c)
			}
		}
	}
	visit(node)
	return out
}

func childKindCount(node CNode, kind string) int {
	ch, _ := node["children"].([]any)
	n := 0
	for _, c := range ch {
		if nodeKind(c) == kind {
			n++
		}
	}
	return n
}

func TestStructureSimpleDeclaration(t *testing.T) {
	tu := parseTU(t, "int x = 1;")
	ext := tuChildren(t, tu)[0].(CNode)
	if ext["declKind"] != "declaration" {
		t.Fatalf("declKind = %v, want declaration", ext["declKind"])
	}
	specs := findKindByValue(ext, "declaration_specifiers")
	if specs == nil {
		t.Fatal("no declaration_specifiers")
	}
	if got := walkTokenSrcs(specs); len(got) != 1 || got[0] != "int" {
		t.Fatalf("specifier tokens = %v, want [int]", got)
	}
	idl := findKindByValue(ext, "init_declarator_list")
	if idl == nil {
		t.Fatal("no init_declarator_list")
	}
	id := findKindByValue(idl, "init_declarator")
	if id == nil || id["declaredName"] != "x" {
		t.Fatalf("init_declarator declaredName = %v, want x", id["declaredName"])
	}
	initN := findKindByValue(id, "initializer")
	if initN == nil {
		t.Fatal("no initializer")
	}
	if got := walkTokenSrcs(initN); len(got) != 1 || got[0] != "1" {
		t.Fatalf("initializer tokens = %v, want [1]", got)
	}
}

func TestStructureMultipleDeclarators(t *testing.T) {
	tu := parseTU(t, "int a, b = 2, c;")
	idl := findKindByValue(tuChildren(t, tu)[0], "init_declarator_list")
	if idl == nil {
		t.Fatal("no init_declarator_list")
	}
	ch, _ := idl["children"].([]any)
	var names []string
	for _, c := range ch {
		if nodeKind(c) == "init_declarator" {
			names = append(names, c.(CNode)["declaredName"].(string))
		}
	}
	if len(names) != 3 || names[0] != "a" || names[1] != "b" || names[2] != "c" {
		t.Fatalf("declared names = %v, want [a b c]", names)
	}
}

func TestStructurePointerArrayFunctionDeclarators(t *testing.T) {
	tu := parseTU(t, "int *p; int a[10]; int f(int x);")
	decls := tuChildren(t, tu)
	if len(decls) != 3 {
		t.Fatalf("got %d external declarations, want 3", len(decls))
	}
	if findKindByValue(decls[0], "pointer") == nil {
		t.Error("declaration 0: no pointer")
	}
	if id := findKindByValue(decls[0], "init_declarator"); id == nil || id["declaredName"] != "p" {
		t.Error("declaration 0: declaredName != p")
	}
	if findKindByValue(decls[1], "array_postfix") == nil {
		t.Error("declaration 1: no array_postfix")
	}
	if id := findKindByValue(decls[1], "init_declarator"); id == nil || id["declaredName"] != "a" {
		t.Error("declaration 1: declaredName != a")
	}
	if findKindByValue(decls[2], "function_postfix") == nil {
		t.Error("declaration 2: no function_postfix")
	}
	if id := findKindByValue(decls[2], "init_declarator"); id == nil || id["declaredName"] != "f" {
		t.Error("declaration 2: declaredName != f")
	}
}

func TestStructureFunctionDefinition(t *testing.T) {
	tu := parseTU(t, "int main(void) { return 0; }")
	ext := tuChildren(t, tu)[0].(CNode)
	if ext["declKind"] != "function_definition" {
		t.Fatalf("declKind = %v, want function_definition", ext["declKind"])
	}
	if findKindByValue(ext, "declaration_specifiers") == nil {
		t.Error("no declaration_specifiers")
	}
	if findKindByValue(ext, "declarator") == nil {
		t.Error("no declarator")
	}
	if findKindByValue(ext, "compound_statement") == nil {
		t.Error("no compound_statement")
	}
}

func TestStructureFunctionDefinitionWithExpr(t *testing.T) {
	tu := parseTU(t, "int f(int a){ return a + 1; }")
	ext := tuChildren(t, tu)[0].(CNode)
	if ext["declKind"] != "function_definition" {
		t.Fatalf("declKind = %v, want function_definition", ext["declKind"])
	}
	jump := findKindByValue(ext, "jump_statement")
	if jump == nil {
		t.Fatal("no jump_statement")
	}
	bin := findKindByValue(jump, "binary_expression")
	if bin == nil {
		t.Fatal("no binary_expression in return")
	}
	if bin["op"] != "+" {
		t.Fatalf("binary op = %v, want +", bin["op"])
	}
}

func TestStructureStructDefinition(t *testing.T) {
	tu := parseTU(t, "struct S { int x; int y; };")
	ss := findKindByValue(tuChildren(t, tu)[0], "struct_specifier")
	if ss == nil {
		t.Fatal("no struct_specifier")
	}
	if ss["tagName"] != "S" {
		t.Fatalf("tagName = %v, want S", ss["tagName"])
	}
	if findKindByValue(ss, "member_decl_list") == nil {
		t.Error("no member_decl_list")
	}
}

func TestStructureStructMembers(t *testing.T) {
	tu := parseTU(t, "struct S { int x; char *p; double d; };")
	ml := findKindByValue(tuChildren(t, tu)[0], "member_decl_list")
	if ml == nil {
		t.Fatal("no member_decl_list")
	}
	if n := childKindCount(ml, "struct_declaration"); n != 3 {
		t.Fatalf("struct_declaration count = %d, want 3", n)
	}
	ch, _ := ml["children"].([]any)
	var fields []string
	for _, c := range ch {
		if nodeKind(c) == "struct_declaration" {
			if findKindByValue(c, "specifier_qualifier_list") == nil {
				t.Error("member has no specifier_qualifier_list")
			}
			if findKindByValue(c, "struct_declarator_list") == nil {
				t.Error("member has no struct_declarator_list")
			}
			sd := findKindByValue(c, "struct_declarator")
			if sd != nil {
				if name, ok := sd["declaredName"].(string); ok {
					fields = append(fields, name)
				}
			}
		}
	}
	if len(fields) != 3 || fields[0] != "x" || fields[1] != "p" || fields[2] != "d" {
		t.Fatalf("field names = %v, want [x p d]", fields)
	}
}

func TestStructureBitfields(t *testing.T) {
	tu := parseTU(t, "struct B { unsigned int flag : 1; int : 7; int n; };")
	ml := findKindByValue(tuChildren(t, tu)[0], "member_decl_list")
	if ml == nil {
		t.Fatal("no member_decl_list")
	}
	if n := childKindCount(ml, "struct_declaration"); n != 3 {
		t.Fatalf("struct_declaration count = %d, want 3", n)
	}
	ch, _ := ml["children"].([]any)
	var members []CNode
	for _, c := range ch {
		if nodeKind(c) == "struct_declaration" {
			members = append(members, c.(CNode))
		}
	}
	// Member 0: named bitfield.
	if findKindByValue(members[0], "bitfield_width") == nil {
		t.Error("member 0 has no bitfield_width")
	}
	if sd := findKindByValue(members[0], "struct_declarator"); sd == nil || sd["declaredName"] != "flag" {
		t.Error("member 0 declaredName != flag")
	}
	// Member 1: anonymous bitfield (no declared name).
	if findKindByValue(members[1], "bitfield_width") == nil {
		t.Error("member 1 has no bitfield_width")
	}
}

func TestStructureEnumWithFixedType(t *testing.T) {
	tu := parseTU(t, "enum E : int { A, B, C };")
	en := findKindByValue(tuChildren(t, tu)[0], "enum_specifier")
	if en == nil {
		t.Fatal("no enum_specifier")
	}
	if en["tagName"] != "E" {
		t.Fatalf("tagName = %v, want E", en["tagName"])
	}
	if findKindByValue(en, "enumerator_list") == nil {
		t.Error("no enumerator_list")
	}
}

func TestStructureEnumMembers(t *testing.T) {
	tu := parseTU(t, "enum E { A, B = 2, C, };")
	el := findKindByValue(tuChildren(t, tu)[0], "enumerator_list")
	if el == nil {
		t.Fatal("no enumerator_list")
	}
	ch, _ := el["children"].([]any)
	var names []string
	var enums []CNode
	for _, c := range ch {
		if nodeKind(c) == "enumerator" {
			enums = append(enums, c.(CNode))
			names = append(names, c.(CNode)["declaredName"].(string))
		}
	}
	if len(names) != 3 || names[0] != "A" || names[1] != "B" || names[2] != "C" {
		t.Fatalf("enumerator names = %v, want [A B C]", names)
	}
	if findKindByValue(enums[1], "initializer") == nil {
		t.Error("enumerator B has no initializer")
	}
}

func TestStructureTypedefStruct(t *testing.T) {
	tu := parseTU(t, "typedef struct { int x; } S;")
	ext := tuChildren(t, tu)[0].(CNode)
	if ext["declKind"] != "declaration" {
		t.Fatalf("declKind = %v, want declaration", ext["declKind"])
	}
	if findKindByValue(ext, "struct_specifier") == nil {
		t.Error("no struct_specifier")
	}
	if id := findKindByValue(ext, "init_declarator"); id == nil || id["declaredName"] != "S" {
		t.Errorf("typedef name = %v, want S", id["declaredName"])
	}
}

func TestStructureAttributeOnDeclaration(t *testing.T) {
	tu := parseTU(t, "__attribute__((noreturn)) void die(void);")
	ext := tuChildren(t, tu)[0].(CNode)
	if ext["declKind"] != "declaration" {
		t.Fatalf("declKind = %v, want declaration", ext["declKind"])
	}
	if findKindByValue(ext, "attribute_spec") == nil {
		t.Error("no attribute_spec")
	}
}

func TestStructureInitializerExpression(t *testing.T) {
	tu := parseTU(t, "int x = 2 * 3 + 4;")
	initN := findKindByValue(tuChildren(t, tu)[0], "initializer")
	if initN == nil {
		t.Fatal("no initializer")
	}
	// Top-level op should be '+' (lower precedence than '*').
	bin := findKindByValue(initN, "binary_expression")
	if bin == nil {
		t.Fatal("no binary_expression")
	}
	if bin["op"] != "+" {
		t.Fatalf("top-level op = %v, want + (precedence: 2*3 binds tighter)", bin["op"])
	}
	// The left operand of '+' is itself a '*' binary_expression.
	left, _ := bin["left"].(map[string]any)
	if left == nil || left["op"] != "*" {
		t.Fatalf("left operand op = %v, want *", left["op"])
	}
}
