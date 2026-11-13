/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"strings"
	"testing"

	tabnas "github.com/tabnas/parser/go"
)

// Every repetition is a replace loop (admin's and parser's "Repetition is
// replacement, never a push chain"): over 10,000 items of each, the
// deepest rule the parse reaches is as deep as over one item. Port of
// ts/test/repeat.test.ts.

const manyItems = 10000

func maxRuleDepth(t *testing.T, src string, extended bool) int {
	t.Helper()
	j, err := MakeC(map[string]any{"extended": extended})
	if err != nil {
		t.Fatal(err)
	}
	max := 0
	j.Sub(nil, func(rule *tabnas.Rule, _ *tabnas.Context) {
		if rule.D > max {
			max = rule.D
		}
	})
	if _, err := j.Parse(src); err != nil {
		t.Fatalf("parse: %v", err)
	}
	return max
}

func TestRepetitionIsReplacement(t *testing.T) {
	rep := strings.Repeat
	cases := []struct {
		name string
		make func(n int) string
		ext  bool
	}{
		{"external declarations", func(n int) string { return rep("int a;\n", n) }, false},
		{"block items", func(n int) string { return "void f(void) {" + rep(" x;", n) + " }" }, false},
		{"init declarators", func(n int) string { return "int a" + rep(", a", n-1) + ";" }, false},
		{"specifiers", func(n int) string { return rep("const ", n) + "int x;" }, false},
		{"a binary chain", func(n int) string { return "int x = a" + rep(" + a", n) + ";" }, false},
		{"a comma expression", func(n int) string { return "void f(void) { a" + rep(", a", n) + "; }" }, false},
		{"arguments", func(n int) string { return "int x = f(a" + rep(", a", n-1) + ");" }, false},
		{"a postfix chain", func(n int) string { return "int x = a" + rep("[0]", n) + ";" }, false},
		{"member accesses", func(n int) string { return "int x = a" + rep(".b", n) + ";" }, false},
		{"adjacent strings", func(n int) string { return "char *s = " + rep(`"a" `, n) + ";" }, false},
		{"brace-list items", func(n int) string { return "int x[] = { 1" + rep(", 1", n-1) + " };" }, false},
		{"struct members", func(n int) string { return "struct S {" + rep(" int a;", n) + " };" }, false},
		{"enumerators", func(n int) string { return "enum E { A" + rep(", A", n-1) + " };" }, false},
		{"parameters", func(n int) string { return "void f(int" + rep(", int", n-1) + ");" }, false},
		{"an unknown declaration's tokens", func(n int) string { return "foo" + rep(" a", n) + ";" }, false},
		{"a macro body", func(n int) string { return "#define X" + rep(" a", n) + "\n" }, true},
		{"a conditional branch's declarations", func(n int) string { return "#if A\n" + rep("int a;\n", n) + "#endif\n" }, false},
		{"a conditional group's branches", func(n int) string { return "#if A\n" + rep("#elif B\n", n) + "#endif\n" }, false},
		{"conditional groups", func(n int) string { return rep("#if A\n#endif\n", n) }, false},
		{"asm operands", func(n int) string {
			return `void f(void) { asm("" : "r" (a)` + rep(`, "r" (a)`, n-1) + "); }"
		}, true},
		{"an asm operand's flat tokens", func(n int) string {
			return `void f(void) { asm("" : "r" (a)` + rep(" b", n) + "); }"
		}, true},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			one := maxRuleDepth(t, c.make(1), c.ext)
			many := maxRuleDepth(t, c.make(manyItems), c.ext)
			if many != one {
				t.Errorf("%s: depth %d over %d items, %d over one", c.name, many, manyItems, one)
			}
		})
	}
}
