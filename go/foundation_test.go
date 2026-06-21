/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

func TestKeywordTokenName(t *testing.T) {
	cases := map[string]string{
		"int":           "KW_INT",
		"_Alignas":      "KW__ALIGNAS",
		"__attribute__": "KW___ATTRIBUTE__",
		"static_assert": "KW_STATIC_ASSERT",
		"notakeyword":   "",
	}
	for in, want := range cases {
		if got := KeywordTokenName(in); got != want {
			t.Errorf("KeywordTokenName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAllTokenNamesAndSources(t *testing.T) {
	m := AllTokenNamesAndSources()
	if m["PUNC_ARROW"] != "->" {
		t.Errorf("PUNC_ARROW = %q, want ->", m["PUNC_ARROW"])
	}
	if m["KW_INT"] != "int" {
		t.Errorf("KW_INT = %q, want int", m["KW_INT"])
	}
	if len(m) < len(Punctuators)+len(C23Keywords) {
		t.Errorf("token map too small: %d", len(m))
	}
}

func TestSymbolTableScopes(t *testing.T) {
	st := NewSymbolTable()
	st.BindTypedef("T")
	if !st.IsTypedef("T") {
		t.Fatal("T should be a typedef")
	}
	// Inner ordinary binding shadows outer typedef.
	st.Enter(ScopeBlock)
	st.BindOrdinary("T")
	if st.IsTypedef("T") {
		t.Fatal("inner ordinary T should shadow outer typedef")
	}
	st.Exit()
	if !st.IsTypedef("T") {
		t.Fatal("T should be a typedef again after exit")
	}
	// Tags are a separate namespace.
	st.BindTag("S", TagStruct)
	if !st.HasTag("S") || st.IsBound("S") {
		t.Fatal("tag S should be a tag, not a bound name")
	}
}

func TestMacroTable(t *testing.T) {
	mt := NewMacroTable()
	mt.Define(&MacroDef{Name: "FOO", IsFunctionLike: false})
	if !mt.Has("FOO") {
		t.Fatal("FOO should be defined")
	}
	mt.Undefine("FOO")
	if mt.Has("FOO") {
		t.Fatal("FOO should be undefined")
	}
}
