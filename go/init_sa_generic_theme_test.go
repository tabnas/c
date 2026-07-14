/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

// Designated-initializer, static_assert, and _Generic themes. Mirrors the
// 'init: …' / 'static_assert: …' (slice 14), 'phase O: …', and
// '_Generic: …' tests in ../ts/test/c.test.ts.

func TestInitDesignatedFieldDesignators(t *testing.T) {
	// TS: 'init: designated initializer with .field designators'
	tu := parseTU(t, "struct S s = { .x = 1, .y = 2, .z = 3 };")
	il := mustFind(t, tuChildren(t, tu)[0], "initializer_list")
	items := childrenOfKind(il, "initializer_item")
	if len(items) != 3 {
		t.Fatalf("initializer_item count = %d, want 3", len(items))
	}
	want := []string{"x", "y", "z"}
	for i, it := range items {
		desig := findKindByValue(it, "designation")
		if desig == nil {
			t.Fatalf("item %d: no designation", i)
		}
		md := findKindByValue(desig, "member_designator")
		if md == nil || md["memberName"] != want[i] {
			t.Errorf("item %d memberName = %v, want %s",
				i, fieldStr(md, "memberName"), want[i])
		}
	}
}

func TestInitDesignatedIndexDesignators(t *testing.T) {
	// TS: 'init: designated initializer with [index] designators'
	tu := parseTU(t, "int a[5] = { [0] = 10, [4] = 50 };")
	il := mustFind(t, tuChildren(t, tu)[0], "initializer_list")
	items := childrenOfKind(il, "initializer_item")
	if len(items) != 2 {
		t.Fatalf("initializer_item count = %d, want 2", len(items))
	}
	for i, it := range items {
		desig := findKindByValue(it, "designation")
		if desig == nil {
			t.Fatalf("item %d: no designation", i)
		}
		if findKindByValue(desig, "index_designator") == nil {
			t.Errorf("item %d: no index_designator", i)
		}
	}
}

func TestInitNestedInitializerList(t *testing.T) {
	// TS: 'init: nested initializer_list inside an initializer_item'
	tu := parseTU(t, "int m[2][2] = { { 1, 2 }, { 3, 4 } };")
	il := mustFind(t, tuChildren(t, tu)[0], "initializer_list")
	items := childrenOfKind(il, "initializer_item")
	if len(items) != 2 {
		t.Fatalf("initializer_item count = %d, want 2", len(items))
	}
	for i, it := range items {
		val := field(it, "value")
		if val == nil {
			t.Fatalf("item %d: no value", i)
		}
		if findKindByValue(val, "initializer_list") == nil {
			t.Errorf("item %d: value has no nested initializer_list", i)
		}
	}
}

// ---- static_assert -------------------------------------------------------

func TestStaticAssertConditionAndMessage(t *testing.T) {
	// TS: 'static_assert: condition + message split into fields'
	tu := parseTU(t, `static_assert(sizeof(int) == 4, "expected 32-bit int");`)
	sa := mustFind(t, tuChildren(t, tu)[0], "static_assert_declaration")
	cond := field(sa, "condition")
	if cond == nil {
		t.Fatal("no condition")
	}
	if cond["kind"] != "binary_expression" {
		t.Errorf("condition kind = %v, want binary_expression", cond["kind"])
	}
	if cond["op"] != "==" {
		t.Errorf("condition op = %v, want ==", cond["op"])
	}
	msg := field(sa, "message")
	if msg == nil {
		t.Fatal("no message")
	}
	if msg["kind"] != "literal_expression" {
		t.Errorf("message kind = %v, want literal_expression", msg["kind"])
	}
	if msg["literalKind"] != "LIT_STRING" {
		t.Errorf("message literalKind = %v, want LIT_STRING", msg["literalKind"])
	}
}

func TestStaticAssertConditionOnly(t *testing.T) {
	// TS: 'static_assert: condition only (no message)'
	tu := parseTU(t, "_Static_assert(1 + 1 == 2);")
	sa := mustFind(t, tuChildren(t, tu)[0], "static_assert_declaration")
	if field(sa, "condition") == nil {
		t.Error("no condition")
	}
	if _, has := sa["message"]; has {
		t.Errorf("message = %v, want unset", sa["message"])
	}
}

func TestStaticAssertCommaInCondExpression(t *testing.T) {
	// TS: 'phase O: top-level static_assert with comma in cond expression'
	tu := parseTU(t, `static_assert(sizeof(int[2]) == 8, "size");`)
	sa := mustFind(t, tuChildren(t, tu)[0], "static_assert_declaration")
	cond := field(sa, "condition")
	if cond == nil {
		t.Fatal("no condition")
	}
	if cond["kind"] != "binary_expression" {
		t.Errorf("condition kind = %v, want binary_expression", cond["kind"])
	}
	msg := field(sa, "message")
	if msg == nil || msg["kind"] != "literal_expression" {
		t.Errorf("message kind = %v, want literal_expression", fieldStr(msg, "kind"))
	}
}

// ---- _Generic ------------------------------------------------------------

func TestGenericSelection(t *testing.T) {
	// TS: '_Generic: controlling expression and three associations'
	src := `
      void g(int x) {
        int r = _Generic(x,
          int:    1,
          double: 2,
          default: 0
        );
      }
    `
	tu := parseTU(t, src)
	gs := mustFind(t, tuChildren(t, tu)[0], "generic_selection")
	ctl := field(gs, "controlling")
	if ctl == nil {
		t.Fatal("no controlling")
	}
	expr := field(ctl, "expression")
	if expr == nil || expr["kind"] != "identifier_expression" {
		t.Fatalf("controlling.expression kind = %v, want identifier_expression",
			fieldStr(expr, "kind"))
	}
	if expr["name"] != "x" {
		t.Errorf("controlling.expression name = %v, want x", expr["name"])
	}
	assocs := nodeSlice(gs, "associations")
	if len(assocs) != 3 {
		t.Fatalf("associations count = %d, want 3", len(assocs))
	}
	var kinds []string
	for _, a := range assocs {
		kinds = append(kinds, fieldStr(a, "associationKind"))
	}
	if !eqStrs(kinds, []string{"type", "type", "default"}) {
		t.Fatalf("associationKinds = %v, want [type type default]", kinds)
	}
	for i, a := range assocs {
		val := field(a, "value")
		if val == nil {
			t.Errorf("association %d: no value", i)
			continue
		}
		if val["kind"] != "literal_expression" {
			t.Errorf("association %d value kind = %v, want literal_expression",
				i, val["kind"])
		}
	}
}
