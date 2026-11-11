/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Package tabnasc is the Go port of @tabnas/c — a Tabnas parser plugin
// (layered on @tabnas/jsonic) that parses C source into a concrete syntax
// tree, preserving macros and compiler extensions. Port of ../ts/src/c.ts.
//
// STATUS: complete and at parity. It builds the same tree as the
// TypeScript, with the same rules: the lexer (matchers.go/tokens.go/
// symbols.go), node helpers (cst.go/node.go), grammar install + ref map
// (grammar_install.go/refs.go), C's expression rules (expression.go), the
// armed fallback (fallback.go), the members API (members.go), and the
// declaration, statement and extension refs (refs_newpath*.go,
// refs_ext.go). TestCsmithCorpus matches the TypeScript golden fixtures
// 100/100. See AGENTS.md and docs/rules.md.
package tabnasc

import (
	_ "embed"

	jsonic "github.com/tabnas/jsonic/go"
	tabnas "github.com/tabnas/parser/go"
)

// VERSION is this module's version. It MUST equal ts/package.json
// "version": the release orchestrator rewrites both, and
// TestVersionMatchesPackageJSON fails the build if they drift.
const VERSION = "0.5.16"

// grammarText is the C grammar, single-sourced from c-grammar.jsonic (the TS
// build copies it here). Embedded from file because the grammar contains
// backticks, which rules out a Go raw-string literal.
//
//go:embed c-grammar.jsonic
var grammarText string

// Grammar returns the embedded C grammar text (jsonic-DSL source).
func Grammar() string { return grammarText }

// COptions are the plugin options. Mirrors the TypeScript COptions.
type COptions struct {
	// Extended enables the GCC/Clang/MSVC extension constructs
	// (__attribute__, __declspec, inline asm, etc.).
	Extended bool
}

// Defaults mirrors the TypeScript C.defaults.
var Defaults = COptions{Extended: false}

func boolPtr(b bool) *bool { return &b }

// resolveOptions merges the caller options map with defaults. Mirrors the TS
// resolveOptions.
func resolveOptions(opts map[string]any) COptions {
	out := Defaults
	if opts != nil {
		if v, ok := opts["extended"].(bool); ok {
			out.Extended = v
		}
	}
	return out
}

// specialTokenNames are the non-punctuator, non-keyword token names that need
// stable tins (mirrors the registration list in c.ts).
var specialTokenNames = []string{
	"ID", "TYPEDEF_NAME", "MACRO_NAME",
	"LIT_INT", "LIT_FLOAT", "LIT_CHAR", "LIT_STRING", "LIT_HEADER_NAME",
	"PP_HASH", "PP_NEWLINE", "PP_RAW",
	"TRIVIA_LINE_COMMENT", "TRIVIA_BLOCK_COMMENT", "TRIVIA_LINE_CONT",
}

// preserveTriviaNames are trivia tokens kept and attached to the next token.
var preserveTriviaNames = map[string]bool{
	"TRIVIA_LINE_COMMENT": true, "TRIVIA_BLOCK_COMMENT": true, "TRIVIA_LINE_CONT": true,
}

// dropTriviaNames are trivia tokens silently discarded.
var dropTriviaNames = map[string]bool{
	"#SP": true, "#LN": true, "#CM": true,
}

// anyCTokenNames returns the wildcard token-name set (ANY_C_TOKEN) used by the
// dispatch's lookahead and by unknown_declaration.
func anyCTokenNames() []string {
	names := []string{
		"ID", "TYPEDEF_NAME", "MACRO_NAME",
		"LIT_INT", "LIT_FLOAT", "LIT_CHAR", "LIT_STRING", "LIT_HEADER_NAME",
		"PP_HASH", "PP_NEWLINE", "PP_RAW",
	}
	for _, p := range Punctuators {
		names = append(names, p.Name)
	}
	for _, kw := range C23Keywords {
		names = append(names, KeywordTokenName(kw))
	}
	for _, kw := range ExtKeywords {
		names = append(names, KeywordTokenName(kw))
	}
	return names
}

// kwTokenNames returns every keyword token name (the KW_TOKEN set).
func kwTokenNames() []string {
	out := make([]string, 0, len(C23Keywords)+len(ExtKeywords))
	for _, kw := range C23Keywords {
		out = append(out, KeywordTokenName(kw))
	}
	for _, kw := range ExtKeywords {
		out = append(out, KeywordTokenName(kw))
	}
	return out
}

// C is the Tabnas plugin entry point. Port of the C plugin in c.ts.
func C(j *tabnas.Tabnas, opts map[string]any) error {
	copts := resolveOptions(opts)

	// 1. Register punctuator + keyword token names with their fixed sources,
	//    and the special token names, so every token has a stable tin. We
	//    register in deterministic slice order (NOT via a map) so the tins
	//    are identical across runs; the grammar resolution depends on
	//    stable tins. We disable jsonic's
	//    built-in matchers and drive lexing with our own.
	for _, p := range Punctuators {
		j.Token(p.Name, p.Src)
	}
	for _, kw := range C23Keywords {
		j.Token(KeywordTokenName(kw), kw)
	}
	for _, kw := range ExtKeywords {
		j.Token(KeywordTokenName(kw), kw)
	}
	for _, name := range specialTokenNames {
		j.Token(name)
	}

	j.SetOptions(tabnas.Options{
		Fixed:   &tabnas.FixedOptions{Lex: boolPtr(false)},
		Space:   &tabnas.SpaceOptions{Lex: boolPtr(false)},
		Line:    &tabnas.LineOptions{Lex: boolPtr(false)},
		Text:    &tabnas.TextOptions{Lex: boolPtr(false)},
		Number:  &tabnas.NumberOptions{Lex: boolPtr(false)},
		String:  &tabnas.StringOptions{Lex: boolPtr(false)},
		Comment: &tabnas.CommentOptions{Lex: boolPtr(false)},
		Value:   &tabnas.ValueOptions{Lex: boolPtr(false)},
		Match:   &tabnas.MatchOptions{Lex: boolPtr(true)},
		Rule:    &tabnas.RuleOptions{Start: "translation_unit", Finish: boolPtr(false)},
	})

	// Token sets referenced by the grammar. All names now resolve to tins.
	j.SetOptions(tabnas.Options{
		TokenSet: map[string][]string{
			"IGNORE": {
				"#SP", "#LN", "#CM",
				"TRIVIA_LINE_COMMENT", "TRIVIA_BLOCK_COMMENT", "TRIVIA_LINE_CONT",
			},
			"ANY_C_TOKEN": anyCTokenNames(),
			"SIMPLE_TYPE_HEAD": {
				"KW_VOID", "KW_CHAR", "KW_SHORT", "KW_INT", "KW_LONG",
				"KW_FLOAT", "KW_DOUBLE",
				"KW_SIGNED", "KW_UNSIGNED",
				"KW_BOOL", "KW__BOOL",
				"KW___SIGNED__", "KW___SIGNED",
				"KW___INT8", "KW___INT16", "KW___INT32", "KW___INT64",
				"KW__COMPLEX", "KW__IMAGINARY",
				"TYPEDEF_NAME",
				"KW_CONST", "KW_VOLATILE", "KW_RESTRICT", "KW__ATOMIC",
				"KW___CONST__", "KW___CONST",
				"KW___VOLATILE__", "KW___VOLATILE",
				"KW___RESTRICT__", "KW___RESTRICT",
				"KW_STRUCT", "KW_UNION", "KW_ENUM",
			},
			"STORAGE_PREFIX": {
				"KW_STATIC", "KW_EXTERN", "KW_TYPEDEF",
				"KW_AUTO", "KW_REGISTER",
				"KW__THREAD_LOCAL", "KW_THREAD_LOCAL", "KW_CONSTEXPR",
				"KW___THREAD",
				"KW_INLINE", "KW___INLINE__", "KW___INLINE",
				"KW___EXTENSION__",
			},
			// The head of a declaration that is not held to the rules:
			// armed (c-grammar.jsonic, external_declaration). Every keyword
			// that can start a declaration's specifiers.
			"DECL_HEAD": {
				"KW_VOID", "KW_CHAR", "KW_SHORT", "KW_INT", "KW_LONG",
				"KW_FLOAT", "KW_DOUBLE", "KW_SIGNED", "KW_UNSIGNED",
				"KW_BOOL", "KW__BOOL", "KW___SIGNED__", "KW___SIGNED",
				"KW___INT8", "KW___INT16", "KW___INT32", "KW___INT64",
				"KW__COMPLEX", "KW__IMAGINARY", "KW___COMPLEX__",
				"KW__DECIMAL32", "KW__DECIMAL64", "KW__DECIMAL128",
				"KW__BITINT", "KW___BUILTIN_VA_LIST", "KW___AUTO_TYPE",
				"KW_TYPEOF", "KW_TYPEOF_UNQUAL", "KW___TYPEOF__", "KW___TYPEOF",
				"TYPEDEF_NAME",
				"KW_CONST", "KW_VOLATILE", "KW_RESTRICT", "KW__ATOMIC",
				"KW___CONST__", "KW___CONST", "KW___VOLATILE__", "KW___VOLATILE",
				"KW___RESTRICT__", "KW___RESTRICT",
				"KW_STRUCT", "KW_UNION", "KW_ENUM",
				"KW_STATIC", "KW_EXTERN", "KW_TYPEDEF", "KW_AUTO", "KW_REGISTER",
				"KW__THREAD_LOCAL", "KW_THREAD_LOCAL", "KW_CONSTEXPR", "KW___THREAD",
				"KW_INLINE", "KW___INLINE__", "KW___INLINE", "KW___FORCEINLINE",
				"KW__NORETURN", "KW__ALIGNAS", "KW_ALIGNAS",
				"KW___EXTENSION__",
				"KW___ATTRIBUTE__", "KW___ATTRIBUTE", "KW___DECLSPEC",
			},
			// The operators of C's expression rules (expression.go has
			// their precedence).
			"ASSIGN_OP": {
				"PUNC_ASSIGN", "PUNC_PLUS_ASSIGN", "PUNC_MINUS_ASSIGN",
				"PUNC_STAR_ASSIGN", "PUNC_SLASH_ASSIGN", "PUNC_PERCENT_ASSIGN",
				"PUNC_LSHIFT_ASSIGN", "PUNC_RSHIFT_ASSIGN", "PUNC_AMP_ASSIGN",
				"PUNC_CARET_ASSIGN", "PUNC_PIPE_ASSIGN",
			},
			"BINARY_OP": {
				"PUNC_OR_OR", "PUNC_AND_AND", "PUNC_PIPE", "PUNC_CARET", "PUNC_AMP",
				"PUNC_EQ", "PUNC_NE", "PUNC_LT", "PUNC_LE", "PUNC_GT", "PUNC_GE",
				"PUNC_LSHIFT", "PUNC_RSHIFT", "PUNC_PLUS", "PUNC_MINUS",
				"PUNC_STAR", "PUNC_SLASH", "PUNC_PERCENT",
			},
			"INCDEC": {"PUNC_PLUS_PLUS", "PUNC_MINUS_MINUS"},
			"UNARY_OP": {
				"PUNC_PLUS", "PUNC_MINUS", "PUNC_BANG", "PUNC_TILDE",
				"PUNC_STAR", "PUNC_AMP",
			},
			"MEMBER_NAME": {"ID", "TYPEDEF_NAME", "MACRO_NAME"},
			// The storage classes and function specifiers spec_loop takes
			// anywhere among the specifiers: C's, and the extensions' (in
			// extended mode).
			"STORAGE_STD": {
				"KW_STATIC", "KW_EXTERN", "KW_TYPEDEF", "KW_AUTO", "KW_REGISTER",
				"KW__THREAD_LOCAL", "KW_THREAD_LOCAL", "KW_CONSTEXPR", "KW_INLINE",
			},
			"STORAGE_EXT": {"KW___THREAD", "KW___INLINE__", "KW___INLINE", "KW___EXTENSION__"},
			// Specifier keywords spec_loop takes as tokens, beside the type
			// heads and the storage classes: C's, and the extensions'.
			"SPEC_KEYWORD": {
				"KW__NORETURN", "KW__DECIMAL32", "KW__DECIMAL64", "KW__DECIMAL128",
			},
			"SPEC_KEYWORD_EXT": {
				"KW___FORCEINLINE", "KW___BUILTIN_VA_LIST", "KW___AUTO_TYPE",
				"KW___COMPLEX__",
			},
			// Specifiers with a parenthesised argument: C's, and the
			// extensions'.
			"PAREN_SPEC":     {"KW_TYPEOF", "KW_TYPEOF_UNQUAL", "KW_ALIGNAS", "KW__ALIGNAS"},
			"PAREN_SPEC_EXT": {"KW___TYPEOF__", "KW___TYPEOF"},
			// A pointer's qualifiers: C's, and the extensions' spellings.
			"PTR_QUALIFIER": {"KW_CONST", "KW_VOLATILE", "KW_RESTRICT", "KW__ATOMIC"},
			"PTR_QUALIFIER_EXT": {
				"KW___CONST__", "KW___CONST", "KW___VOLATILE__", "KW___VOLATILE",
				"KW___RESTRICT__", "KW___RESTRICT",
			},
			"ASM_KEYWORD": {"KW_ASM", "KW___ASM", "KW___ASM__"},
			// What never directly follows an operand in C: an identifier or
			// a literal.
			"JUXTAPOSED": {
				"ID", "TYPEDEF_NAME", "MACRO_NAME",
				"LIT_INT", "LIT_FLOAT", "LIT_CHAR", "LIT_STRING",
			},
			"KW_TOKEN": kwTokenNames(),
			"SIZEOF_KW": {
				"KW_SIZEOF",
				"KW__ALIGNOF", "KW_ALIGNOF",
				"KW___ALIGNOF__", "KW___ALIGNOF",
			},
		},
	})

	// 2. Resolve every emittable token name to its tin and install the custom
	//    lex matchers.
	tinByName := make(map[string]tabnas.Tin)
	for name := range AllTokenNamesAndSources() {
		tinByName[name] = j.Token(name)
	}
	for _, name := range specialTokenNames {
		tinByName[name] = j.Token(name)
	}
	for _, name := range []string{"#SP", "#LN", "#CM"} {
		tinByName[name] = j.Token(name)
	}

	j.SetOptions(tabnas.Options{
		Lex: &tabnas.LexOptions{Match: cMatchers(tinByName)},
	})

	// 3. Install the per-parse CMeta on ctx before parsing.
	j.SetOptions(tabnas.Options{
		Parse: &tabnas.ParseOptions{
			Prepare: map[string]func(ctx *tabnas.Context){
				"cmeta": func(ctx *tabnas.Context) {
					if ctx.Meta == nil {
						ctx.Meta = map[string]any{}
					}
					if _, ok := ctx.Meta["cmeta"]; !ok {
						ctx.Meta["cmeta"] = MakeCMeta()
					}
					// A cmeta handed in may have parsed before: the record,
					// the declaration state and the spans given are this
					// parse's.
					if m, ok := ctx.Meta["cmeta"].(*CMeta); ok {
						m.Rec = []*tabnas.Token{}
						m.RecBase = 0
						m.ED = nil
						m.Fixed = map[uintptr]CNode{}
					}
				},
			},
		},
	})

	// 4. Sub-lex hook: buffer preserved trivia and attach it to the next
	//    non-trivia token's Use["leading"], so comments survive in source
	//    order even though the parser IGNOREs them.
	j.Sub(func(tkn *tabnas.Token, _ *tabnas.Rule, ctx *tabnas.Context) {
		if tkn == nil || tkn.IsNoToken() || ctx.Meta == nil {
			return
		}
		m, ok := ctx.Meta["cmeta"].(*CMeta)
		if !ok || m == nil {
			return
		}
		if preserveTriviaNames[tkn.Name] {
			m.PendingTrivia = append(m.PendingTrivia, tkn)
			return
		}
		if dropTriviaNames[tkn.Name] {
			return
		}
		if len(m.PendingTrivia) > 0 {
			if tkn.Use == nil {
				tkn.Use = map[string]any{}
			}
			tkn.Use["leading"] = m.PendingTrivia
			m.PendingTrivia = nil
		}
		// The tokens the parser takes, in order, for the armed fallback
		// (fallback.go).
		if tkn.Name != "#ZZ" {
			recordToken(m, tkn)
		}
	}, nil)

	// 5. C's expressions start from a rule named `val`, as jsonic's do.
	//    Clear jsonic's, alternates and actions both, so that C's is the
	//    only one. Then parse and install the embedded grammar with the
	//    @-ref map and the armed fallback (fallback.go), stripping the
	//    extension rules in plain-C mode.
	j.Rule("val", func(rs *tabnas.RuleSpec, _ *tabnas.Parser) { rs.Clear() })
	if err := installGrammar(j, copts); err != nil {
		return err
	}

	return nil
}

// MakeC builds a jsonic engine with the C plugin installed — the Go
// equivalent of `new Tabnas().use(jsonic).use(C)`.
func MakeC(opts ...map[string]any) (*jsonic.Jsonic, error) {
	var pluginOpts map[string]any
	if len(opts) > 0 {
		pluginOpts = opts[0]
	}
	return makeCOn(jsonic.Make(), pluginOpts)
}

// makeCOn installs the C plugin on base, jsonic's grammar, and declares
// this parser's own window setting: lex.window false, so that ParseReader
// reads a reader whole (admin ADR-30). The plugin's matchers are not yet
// verified at the window's edge, and C's own window comes with its
// streaming work; a base that declares the window must not carry it to
// them, so the setting comes last, after everything the base and the
// plugin set.
func makeCOn(base *jsonic.Jsonic, pluginOpts map[string]any) (*jsonic.Jsonic, error) {
	if err := base.Use(C, pluginOpts); err != nil {
		return base, err
	}
	no := false
	base.SetOptions(tabnas.Options{Lex: &tabnas.LexOptions{Window: &no}})
	return base, nil
}

// Parse is the one-call entry point: build a C-enabled engine and parse src.
func Parse(src string, opts ...map[string]any) (any, error) {
	j, err := MakeC(opts...)
	if err != nil {
		return nil, err
	}
	return j.Parse(src)
}
