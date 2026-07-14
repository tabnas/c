/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

// Inline-assembly and attribute themes. Mirrors the 'asm: …' (slice 17)
// and 'attributes: …' (slice 16 + C23 additions) tests in
// ../ts/test/c.test.ts.

func TestAsmTemplateOnly(t *testing.T) {
	// TS: 'asm: template only (no operands)'
	tu := parseTU(t, `void f(void) { __asm__("nop"); }`)
	a := mustFind(t, tuChildren(t, tu)[0], "asm_statement")
	if quals := strSlice(a["qualifiers"]); len(quals) != 0 {
		t.Errorf("qualifiers = %v, want []", quals)
	}
	tpl := field(a, "template")
	if tpl == nil {
		t.Fatal("no template")
	}
	expr := field(tpl, "expression")
	if expr == nil || expr["kind"] != "literal_expression" {
		t.Fatalf("template.expression kind = %v, want literal_expression",
			fieldStr(expr, "kind"))
	}
	if expr["literalKind"] != "LIT_STRING" {
		t.Errorf("template.expression literalKind = %v, want LIT_STRING",
			expr["literalKind"])
	}
	if _, has := a["asm_outputs"]; has {
		t.Errorf("asm_outputs = %v, want unset", a["asm_outputs"])
	}
}

func TestAsmFullExtendedForm(t *testing.T) {
	// TS: 'asm: full extended form with outputs/inputs/clobbers'
	src := `
      int add(int a, int b) {
        int r;
        __asm__ volatile (
          "addl %2, %0"
          : "=r" (r)
          : "0" (a), "r" (b)
          : "cc"
        );
        return r;
      }
    `
	tu := parseTU(t, src)
	a := mustFind(t, tuChildren(t, tu)[0], "asm_statement")
	if quals := strSlice(a["qualifiers"]); !eqStrs(quals, []string{"volatile"}) {
		t.Errorf("qualifiers = %v, want [volatile]", quals)
	}
	if field(a, "template") == nil {
		t.Error("no template")
	}
	// outputs
	outputs := field(a, "asm_outputs")
	if outputs == nil {
		t.Fatal("no asm_outputs")
	}
	outOps := childrenOfKind(outputs, "asm_operand")
	if len(outOps) != 1 {
		t.Fatalf("output operand count = %d, want 1", len(outOps))
	}
	constraint := field(outOps[0], "constraint")
	if constraint == nil || constraint["value"] != `"=r"` {
		t.Errorf("output constraint value = %v, want \"=r\"",
			fieldStr(constraint, "value"))
	}
	valExpr := field(field(outOps[0], "value"), "expression")
	if valExpr == nil || valExpr["kind"] != "identifier_expression" {
		t.Fatalf("output value.expression kind = %v, want identifier_expression",
			fieldStr(valExpr, "kind"))
	}
	if valExpr["name"] != "r" {
		t.Errorf("output value.expression name = %v, want r", valExpr["name"])
	}
	// inputs (two operands)
	inputs := field(a, "asm_inputs")
	if inputs == nil {
		t.Fatal("no asm_inputs")
	}
	if inOps := childrenOfKind(inputs, "asm_operand"); len(inOps) != 2 {
		t.Fatalf("input operand count = %d, want 2", len(inOps))
	}
	// clobbers
	clobbers := field(a, "asm_clobbers")
	if clobbers == nil {
		t.Fatal("no asm_clobbers")
	}
	cl := childrenOfKind(clobbers, "asm_clobber")
	if len(cl) != 1 {
		t.Fatalf("clobber count = %d, want 1", len(cl))
	}
	if cl[0]["value"] != `"cc"` {
		t.Errorf("clobber value = %v, want \"cc\"", cl[0]["value"])
	}
}

func TestAsmGotoQualifierWithLabels(t *testing.T) {
	// TS: 'asm: goto qualifier with labels section'
	src := `
      void f(void) {
        __asm__ goto ("jmp %l[done]" : : : : done);
      done:
        return;
      }
    `
	tu := parseTU(t, src)
	a := mustFind(t, tuChildren(t, tu)[0], "asm_statement")
	if quals := strSlice(a["qualifiers"]); !eqStrs(quals, []string{"goto"}) {
		t.Errorf("qualifiers = %v, want [goto]", quals)
	}
	labelsSec := field(a, "asm_labels")
	if labelsSec == nil {
		t.Fatal("no asm_labels")
	}
	labels := childrenOfKind(labelsSec, "asm_label_ref")
	if len(labels) != 1 {
		t.Fatalf("asm_label_ref count = %d, want 1", len(labels))
	}
	if labels[0]["labelName"] != "done" {
		t.Errorf("labelName = %v, want done", labels[0]["labelName"])
	}
}

func TestAsmOperandWithAsmNamePrefix(t *testing.T) {
	// TS: 'asm: operand with [asm-name] prefix'
	src := `
      void f(int x) {
        int r;
        __asm__("movl %[in], %[out]"
                : [out] "=r" (r)
                : [in]  "r"  (x));
      }
    `
	tu := parseTU(t, src)
	a := mustFind(t, tuChildren(t, tu)[0], "asm_statement")
	outputs := field(a, "asm_outputs")
	if outputs == nil {
		t.Fatal("no asm_outputs")
	}
	outOps := childrenOfKind(outputs, "asm_operand")
	if len(outOps) == 0 {
		t.Fatal("no output asm_operand")
	}
	if outOps[0]["asmName"] == nil {
		t.Error("output operand has no asmName")
	}
	constraint := field(outOps[0], "constraint")
	if constraint == nil || constraint["value"] != `"=r"` {
		t.Errorf("output constraint value = %v, want \"=r\"",
			fieldStr(constraint, "value"))
	}
}

// ---- attributes ------------------------------------------------------------

func TestAttributesGCCListNamesAndArgs(t *testing.T) {
	// TS: 'attributes: GCC __attribute__ list with names and args'
	src := "__attribute__((noreturn, format(printf, 1, 2), nonnull(1, 2)))" +
		" void die(const char *fmt, ...);"
	tu := parseTU(t, src)
	at := mustFind(t, tuChildren(t, tu)[0], "attribute_spec")
	if at["attributeForm"] != "gcc" {
		t.Errorf("attributeForm = %v, want gcc", at["attributeForm"])
	}
	items := nodeSlice(at, "items")
	if len(items) != 3 {
		t.Fatalf("items count = %d, want 3", len(items))
	}
	var names []string
	for _, it := range items {
		names = append(names, fieldStr(it, "attributeName"))
	}
	if !eqStrs(names, []string{"noreturn", "format", "nonnull"}) {
		t.Fatalf("attributeNames = %v, want [noreturn format nonnull]", names)
	}
	// noreturn has no argument list.
	if _, has := items[0]["argumentList"]; has {
		t.Errorf("noreturn argumentList = %v, want unset", items[0]["argumentList"])
	}
	// format(printf, 1, 2): three arguments.
	fmtArgs := field(items[1], "argumentList")
	if fmtArgs == nil {
		t.Fatal("format item has no argumentList")
	}
	n := 0
	for _, c := range kidsOf(fmtArgs) {
		switch nodeKind(c) {
		case "identifier_expression", "literal_expression":
			n++
		}
	}
	if n != 3 {
		t.Fatalf("format argument count = %d, want 3", n)
	}
}

func TestAttributesMSVCDeclspec(t *testing.T) {
	// TS: 'attributes: MSVC __declspec single parens'
	tu := parseTU(t, "__declspec(dllexport) void f(void);")
	at := mustFind(t, tuChildren(t, tu)[0], "attribute_spec")
	if at["attributeForm"] != "msvc" {
		t.Errorf("attributeForm = %v, want msvc", at["attributeForm"])
	}
	items := nodeSlice(at, "items")
	if len(items) != 1 {
		t.Fatalf("items count = %d, want 1", len(items))
	}
	if items[0]["attributeName"] != "dllexport" {
		t.Errorf("attributeName = %v, want dllexport", items[0]["attributeName"])
	}
}

func TestAttributesC23Nodiscard(t *testing.T) {
	// TS: 'attributes: C23 [[nodiscard]] on a function declaration'
	tu := parseTU(t, "[[nodiscard]] int compute(int n);")
	at := mustFind(t, tuChildren(t, tu)[0], "attribute_spec")
	if at["attributeForm"] != "c23" {
		t.Errorf("attributeForm = %v, want c23", at["attributeForm"])
	}
	items := nodeSlice(at, "items")
	if len(items) != 1 {
		t.Fatalf("items count = %d, want 1", len(items))
	}
	if items[0]["attributeName"] != "nodiscard" {
		t.Errorf("attributeName = %v, want nodiscard", items[0]["attributeName"])
	}
}

func TestAttributesC23NamespacedGnuPure(t *testing.T) {
	// TS: 'attributes: C23 namespaced [[gnu::pure]]'
	tu := parseTU(t, "[[gnu::pure]] int g(int n);")
	at := mustFind(t, tuChildren(t, tu)[0], "attribute_spec")
	if at["attributeForm"] != "c23" {
		t.Errorf("attributeForm = %v, want c23", at["attributeForm"])
	}
	items := nodeSlice(at, "items")
	if len(items) != 1 {
		t.Fatalf("items count = %d, want 1", len(items))
	}
	if items[0]["attributePrefix"] != "gnu" {
		t.Errorf("attributePrefix = %v, want gnu", items[0]["attributePrefix"])
	}
	if items[0]["attributeName"] != "pure" {
		t.Errorf("attributeName = %v, want pure", items[0]["attributeName"])
	}
}

func TestAttributesC23DeprecatedWithArgumentList(t *testing.T) {
	// TS: 'attributes: C23 [[deprecated("reason")]] with argument list'
	tu := parseTU(t, `[[deprecated("use g instead")]] int old(void);`)
	at := mustFind(t, tuChildren(t, tu)[0], "attribute_spec")
	items := nodeSlice(at, "items")
	if len(items) != 1 {
		t.Fatalf("items count = %d, want 1", len(items))
	}
	if items[0]["attributeName"] != "deprecated" {
		t.Errorf("attributeName = %v, want deprecated", items[0]["attributeName"])
	}
	al := field(items[0], "argumentList")
	if al == nil {
		t.Fatal("no argumentList")
	}
	lits := childrenOfKind(al, "literal_expression")
	if len(lits) != 1 {
		t.Fatalf("literal argument count = %d, want 1", len(lits))
	}
	if lits[0]["literalKind"] != "LIT_STRING" {
		t.Errorf("argument literalKind = %v, want LIT_STRING", lits[0]["literalKind"])
	}
}

func TestAttributesC23OnEnumerator(t *testing.T) {
	// TS: 'attributes: C23 [[…]] on enumerator'
	tu := parseTU(t, "enum E { A [[deprecated]] = 1, B };")
	en := mustFind(t, tuChildren(t, tu)[0], "enum_specifier")
	el := mustFind(t, en, "enumerator_list")
	enums := childrenOfKind(el, "enumerator")
	if len(enums) == 0 {
		t.Fatal("no enumerators")
	}
	at := findKindByValue(enums[0], "attribute_spec")
	if at == nil {
		t.Fatal("enumerator A has no attribute_spec")
	}
	if at["attributeForm"] != "c23" {
		t.Errorf("attributeForm = %v, want c23", at["attributeForm"])
	}
	items := nodeSlice(at, "items")
	if len(items) == 0 {
		t.Fatal("attribute_spec has no items")
	}
	if items[0]["attributeName"] != "deprecated" {
		t.Errorf("attributeName = %v, want deprecated", items[0]["attributeName"])
	}
}

func TestAttributesConstKeywordName(t *testing.T) {
	// TS: 'attributes: const-keyword name accepted
	// (e.g. __attribute__((const)))'
	tu := parseTU(t, "__attribute__((const)) int f(int);")
	at := mustFind(t, tuChildren(t, tu)[0], "attribute_spec")
	items := nodeSlice(at, "items")
	if len(items) != 1 {
		t.Fatalf("items count = %d, want 1", len(items))
	}
	if items[0]["attributeName"] != "const" {
		t.Errorf("attributeName = %v, want const", items[0]["attributeName"])
	}
}
