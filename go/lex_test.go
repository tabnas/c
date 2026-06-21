/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"testing"

	tabnas "github.com/tabnas/parser/go"
)

// lexNames drives the C lexer over src and returns the non-trivia token name
// stream. It exercises the custom matchers (and their lex-mode state machine)
// without needing the grammar.
func lexNames(t *testing.T, src string) []string {
	t.Helper()
	j, err := MakeC()
	if err != nil {
		t.Fatalf("MakeC: %v", err)
	}
	cfg := j.Config()
	lex := tabnas.NewLex(src, cfg)
	lex.Ctx = &tabnas.Context{Meta: map[string]any{"cmeta": MakeCMeta()}}

	var out []string
	for i := 0; i < len(src)+10; i++ {
		tkn := lex.Next()
		if tkn == nil {
			break
		}
		if tkn.Tin == tabnas.TinZZ {
			break
		}
		if tkn.Tin == tabnas.TinBD {
			out = append(out, "BAD:"+tkn.Why)
			break
		}
		switch tkn.Name {
		case "#SP", "#LN", "#CM",
			"TRIVIA_LINE_COMMENT", "TRIVIA_BLOCK_COMMENT", "TRIVIA_LINE_CONT":
			continue
		}
		out = append(out, tkn.Name)
	}
	return out
}

func eqStrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestLexBasic(t *testing.T) {
	cases := []struct {
		src  string
		want []string
	}{
		{"int x = 1;", []string{"KW_INT", "ID", "PUNC_ASSIGN", "LIT_INT", "PUNC_SEMI"}},
		{"a + b * 3", []string{"ID", "PUNC_PLUS", "ID", "PUNC_STAR", "LIT_INT"}},
		{"ptr->field", []string{"ID", "PUNC_ARROW", "ID"}},
		{"x <<= 2", []string{"ID", "PUNC_LSHIFT_ASSIGN", "LIT_INT"}},
		{"0x1F + 3.14 + 'c' + \"hi\"", []string{
			"LIT_INT", "PUNC_PLUS", "LIT_FLOAT", "PUNC_PLUS",
			"LIT_CHAR", "PUNC_PLUS", "LIT_STRING"}},
		{"unsigned long long n;", []string{
			"KW_UNSIGNED", "KW_LONG", "KW_LONG", "ID", "PUNC_SEMI"}},
		// keyword vs identifier boundary: int_value is one ID, not int + _value
		{"int_value", []string{"ID"}},
		// line comment is trivia; only the declaration tokens remain
		{"// hi\nint y;", []string{"KW_INT", "ID", "PUNC_SEMI"}},
	}
	for _, c := range cases {
		got := lexNames(t, c.src)
		if !eqStrs(got, c.want) {
			t.Errorf("lex %q\n  got  %v\n  want %v", c.src, got, c.want)
		}
	}
}

func TestLexDirectiveStateMachine(t *testing.T) {
	// #include <stdio.h>: the opener arms directive mode, `include` arms the
	// header-name flag, and <stdio.h> lexes as one LIT_HEADER_NAME (not as
	// `<` `stdio` `.` `h` `>`). The newline closes the directive.
	got := lexNames(t, "#include <stdio.h>\nint x;")
	want := []string{
		"PP_HASH", "ID", "LIT_HEADER_NAME", "PP_NEWLINE",
		"KW_INT", "ID", "PUNC_SEMI",
	}
	if !eqStrs(got, want) {
		t.Errorf("directive lex\n  got  %v\n  want %v", got, want)
	}
}

func TestLexTypedefNameReclassification(t *testing.T) {
	// With T bound as a typedef in the shared cmeta, the identifier matcher
	// emits TYPEDEF_NAME for T but ID for a plain name.
	j, err := MakeC()
	if err != nil {
		t.Fatalf("MakeC: %v", err)
	}
	cfg := j.Config()
	cm := MakeCMeta()
	cm.Symbols.BindTypedef("T")
	lex := tabnas.NewLex("T x;", cfg)
	lex.Ctx = &tabnas.Context{Meta: map[string]any{"cmeta": cm}}

	var names []string
	for i := 0; i < 20; i++ {
		tkn := lex.Next()
		if tkn == nil || tkn.Tin == tabnas.TinZZ {
			break
		}
		if tkn.Name == "#SP" {
			continue
		}
		names = append(names, tkn.Name)
	}
	want := []string{"TYPEDEF_NAME", "ID", "PUNC_SEMI"}
	if !eqStrs(names, want) {
		t.Errorf("typedef reclassification\n  got  %v\n  want %v", names, want)
	}
}
