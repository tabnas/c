/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

// Statement-variety theme. Mirrors the 'statements: …' and 'for: …' tests
// in ../ts/test/c.test.ts (slices for statement structuring and the
// for_controls 3-way split).

func TestStatementsBlockItems(t *testing.T) {
	// TS: 'statements: function body decomposes into block items'
	tu := parseTU(t, "int f(void) { int x = 1; x = x + 1; return x; }")
	cs := mustFind(t, tuChildren(t, tu)[0], "compound_statement")
	var items []CNode
	for _, c := range kidsOf(cs) {
		switch nodeKind(c) {
		case "declaration", "expression_statement", "jump_statement":
			items = append(items, c.(CNode))
		}
	}
	if len(items) != 3 {
		t.Fatalf("block item count = %d, want 3", len(items))
	}
	if items[0]["kind"] != "declaration" {
		t.Errorf("item 0 kind = %v, want declaration", items[0]["kind"])
	}
	if items[1]["kind"] != "expression_statement" {
		t.Errorf("item 1 kind = %v, want expression_statement", items[1]["kind"])
	}
	if items[2]["kind"] != "jump_statement" {
		t.Errorf("item 2 kind = %v, want jump_statement", items[2]["kind"])
	}
	if items[2]["jumpKind"] != "return" {
		t.Errorf("item 2 jumpKind = %v, want return", items[2]["jumpKind"])
	}
}

func TestStatementsIfElseWhileFor(t *testing.T) {
	// TS: 'statements: if/else, while, for'
	src := `
      int f(int n) {
        if (n > 0) return 1; else return 0;
        while (n--) ;
        for (int i = 0; i < 10; i++) n += i;
      }
    `
	tu := parseTU(t, src)
	cs := mustFind(t, tuChildren(t, tu)[0], "compound_statement")
	for _, kind := range []string{
		"if_statement", "while_statement", "for_statement", "for_controls",
	} {
		if findKindByValue(cs, kind) == nil {
			t.Errorf("no %s in function body", kind)
		}
	}
}

func TestStatementsSwitchCaseDefault(t *testing.T) {
	// TS: 'statements: switch with case and default labels'
	src := `
      int f(int x) {
        switch (x) {
          case 1: return 1;
          case 2: return 2;
          default: return 0;
        }
      }
    `
	tu := parseTU(t, src)
	sw := mustFind(t, tuChildren(t, tu)[0], "switch_statement")
	labels := collectKind(sw, "labeled_statement")
	if len(labels) != 3 {
		t.Fatalf("labeled_statement count = %d, want 3", len(labels))
	}
	var kinds []string
	for _, l := range labels {
		kinds = append(kinds, fieldStr(l, "labelKind"))
	}
	if !eqStrs(kinds, []string{"case", "case", "default"}) {
		t.Fatalf("labelKinds = %v, want [case case default]", kinds)
	}
}

func TestStatementsGotoLabel(t *testing.T) {
	// TS: 'statements: goto + label'
	tu := parseTU(t, "void f(void) { goto out; out: return; }")
	cs := mustFind(t, tuChildren(t, tu)[0], "compound_statement")
	jmp := mustFind(t, cs, "jump_statement")
	if jmp["jumpKind"] != "goto" {
		t.Errorf("jumpKind = %v, want goto", jmp["jumpKind"])
	}
	lbl := mustFind(t, cs, "labeled_statement")
	if lbl["labelKind"] != "label" {
		t.Errorf("labelKind = %v, want label", lbl["labelKind"])
	}
	if lbl["labelName"] != "out" {
		t.Errorf("labelName = %v, want out", lbl["labelName"])
	}
}

func TestStatementsDoWhile(t *testing.T) {
	// TS: 'statements: do/while'
	tu := parseTU(t, "void f(void) { do { } while (0); }")
	if findKindByValue(tuChildren(t, tu)[0], "do_statement") == nil {
		t.Fatal("no do_statement")
	}
}

func TestForInitDeclCondIterStructured(t *testing.T) {
	// TS: 'for: init declaration / cond / iter all structured'
	tu := parseTU(t, "void g(void) { for (int i = 0; i < 10; i++) ; }")
	fs := mustFind(t, tuChildren(t, tu)[0], "for_statement")
	ctl := mustFind(t, fs, "for_controls")

	init := field(ctl, "init")
	if init == nil {
		t.Fatal("no for_controls.init")
	}
	initVal := field(init, "value")
	if initVal == nil || initVal["kind"] != "declaration" {
		t.Fatalf("init.value.kind = %v, want declaration", initVal["kind"])
	}
	if id := findKindByValue(init, "init_declarator"); id == nil || id["declaredName"] != "i" {
		t.Errorf("init declaredName != i")
	}

	condVal := field(field(ctl, "cond"), "value")
	if condVal == nil || condVal["kind"] != "binary_expression" {
		t.Fatalf("cond.value.kind = %v, want binary_expression", condVal["kind"])
	}
	if condVal["op"] != "<" {
		t.Errorf("cond op = %v, want <", condVal["op"])
	}

	iterVal := field(field(ctl, "iter"), "value")
	if iterVal == nil || iterVal["kind"] != "postfix_unary_expression" {
		t.Fatalf("iter.value.kind = %v, want postfix_unary_expression", iterVal["kind"])
	}
	if iterVal["op"] != "++" {
		t.Errorf("iter op = %v, want ++", iterVal["op"])
	}
}

func TestForInitExpressionForm(t *testing.T) {
	// TS: 'for: init expression form'
	tu := parseTU(t, "void g(void) { int i; for (i = 0; i < 10; i++) ; }")
	fs := mustFind(t, tuChildren(t, tu)[0], "for_statement")
	ctl := mustFind(t, fs, "for_controls")
	initVal := field(field(ctl, "init"), "value")
	if initVal == nil || initVal["kind"] != "assignment_expression" {
		t.Fatalf("init.value.kind = %v, want assignment_expression", initVal["kind"])
	}
	if initVal["op"] != "=" {
		t.Errorf("init op = %v, want =", initVal["op"])
	}
}

func TestForEmptyControls(t *testing.T) {
	// TS: 'for: empty controls (for(;;))'
	tu := parseTU(t, "void g(void) { for (;;) break; }")
	fs := mustFind(t, tuChildren(t, tu)[0], "for_statement")
	ctl := mustFind(t, fs, "for_controls")
	for _, slot := range []string{"init", "cond", "iter"} {
		n := field(ctl, slot)
		if n == nil {
			t.Errorf("for_controls.%s missing", slot)
			continue
		}
		if _, has := n["value"]; has {
			t.Errorf("for_controls.%s.value = %v, want unset", slot, n["value"])
		}
	}
}
