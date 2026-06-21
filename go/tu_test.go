/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "testing"

// tokenSrcs walks a CST node depth-first and returns the src of every
// kind:"token" leaf, in order.
func tokenSrcs(n any) []string {
	var out []string
	var visit func(any)
	visit = func(x any) {
		m, ok := x.(map[string]any)
		if !ok {
			return
		}
		if m["kind"] == "token" {
			if s, ok := m["src"].(string); ok {
				out = append(out, s)
			}
			return
		}
		if kids, ok := m["children"].([]any); ok {
			for _, c := range kids {
				visit(c)
			}
		}
	}
	visit(n)
	return out
}

// tokenNames is like tokenSrcs but returns each token's tname.
func tokenNames(n any) []string {
	var out []string
	var visit func(any)
	visit = func(x any) {
		m, ok := x.(map[string]any)
		if !ok {
			return
		}
		if m["kind"] == "token" {
			if s, ok := m["tname"].(string); ok {
				out = append(out, s)
			}
			return
		}
		if kids, ok := m["children"].([]any); ok {
			for _, c := range kids {
				visit(c)
			}
		}
	}
	visit(n)
	return out
}

func TestTranslationUnitTokenFidelity(t *testing.T) {
	out, err := Parse("int x = 1;\nchar *p;")
	if err != nil {
		t.Fatalf("parse err: %v", err)
	}
	m, ok := out.(map[string]any)
	if !ok || m["kind"] != "translation_unit" {
		t.Fatalf("root = %v", out)
	}
	// Two external declarations.
	kids := m["children"].([]any)
	if len(kids) != 2 {
		t.Fatalf("expected 2 external_declarations, got %d", len(kids))
	}
	for _, k := range kids {
		if km := k.(map[string]any); km["kind"] != "external_declaration" {
			t.Fatalf("child kind = %v", km["kind"])
		}
	}
	// Every source token is preserved in order (token fidelity).
	got := tokenSrcs(out)
	want := []string{"int", "x", "=", "1", ";", "char", "*", "p", ";"}
	if !eqStrs(got, want) {
		t.Errorf("token srcs\n  got  %v\n  want %v", got, want)
	}
}

func TestTypedefTrackingThroughFinalizer(t *testing.T) {
	// `typedef int T;` registers T; the later `T y;` must lex T as
	// TYPEDEF_NAME (proving the finaliser bound it into cmeta.symbols).
	out, err := Parse("typedef int T;\nT y;")
	if err != nil {
		t.Fatalf("parse err: %v", err)
	}
	names := tokenNames(out)
	// Find the T that appears after the first ';'.
	sawSemi := false
	foundTypedefName := false
	for i, nm := range names {
		if nm == "PUNC_SEMI" {
			sawSemi = true
			continue
		}
		if sawSemi && nm == "TYPEDEF_NAME" {
			foundTypedefName = true
			_ = i
			break
		}
	}
	if !foundTypedefName {
		t.Errorf("second T not reclassified as TYPEDEF_NAME: %v", names)
	}
}

func TestParseComments(t *testing.T) {
	// Line/block comments are trivia: not separate tokens, but the real
	// tokens are still captured (and comments ride as leading trivia).
	out, err := Parse("/* c */ int x; // trailing")
	if err != nil {
		t.Fatalf("parse err: %v", err)
	}
	got := tokenSrcs(out)
	// Includes the leading block comment (attached as a leading-trivia ref)
	// plus the declaration tokens.
	hasInt, hasX, hasSemi := false, false, false
	for _, s := range got {
		switch s {
		case "int":
			hasInt = true
		case "x":
			hasX = true
		case ";":
			hasSemi = true
		}
	}
	if !hasInt || !hasX || !hasSemi {
		t.Errorf("declaration tokens missing: %v", got)
	}
}
