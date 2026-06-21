/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import "strings"

// Token name catalog for the C concrete-syntax parser. Port of
// ../ts/src/tokens.ts.
//
// Every token a C source can produce gets a stable name here. Lex matchers
// resolve names to tins and emit tokens carrying these names; grammar rules
// reference the same names.
//
// Naming convention:
//   PUNC_*        punctuators and operators (one token per literal form)
//   KW_*          keywords (C23 + extension keywords)
//   LIT_*         literals (integer, float, char, string, header-name)
//   ID            ordinary identifier
//   TYPEDEF_NAME  identifier currently registered as a typedef in scope
//   MACRO_NAME    identifier currently registered as a macro
//   PP_*          preprocessor markers
//   TRIVIA_*      preserved trivia (comments, line continuations)

// C23Keywords are the C23 standard keywords (N3096 §6.4.1 plus C23 additions
// and the underscore-prefixed legacy spellings).
var C23Keywords = []string{
	"auto", "break", "case", "char", "const", "constexpr", "continue",
	"default", "do", "double", "else", "enum", "extern", "float", "for",
	"goto", "if", "inline", "int", "long", "register", "restrict", "return",
	"short", "signed", "sizeof", "static", "struct", "switch",
	"typedef", "union", "unsigned", "void", "volatile", "while",

	// C23 unprefixed
	"alignas", "alignof", "bool", "false", "nullptr",
	"static_assert", "thread_local", "true",
	"typeof", "typeof_unqual",

	// Underscore-prefixed (still valid in C23)
	"_Alignas", "_Alignof", "_Atomic", "_BitInt", "_Bool", "_Complex",
	"_Decimal32", "_Decimal64", "_Decimal128",
	"_Generic", "_Imaginary", "_Noreturn", "_Static_assert",
	"_Thread_local",
}

// ExtKeywords are the GCC/Clang/MSVC extension keywords, recognized so the
// grammar can place them.
var ExtKeywords = []string{
	// GCC / Clang
	"__attribute__", "__attribute",
	"__asm__", "__asm", "asm",
	"__inline__", "__inline",
	"__signed__", "__signed",
	"__volatile__", "__volatile",
	"__const__", "__const",
	"__restrict__", "__restrict",
	"__typeof__", "__typeof",
	"__alignof__", "__alignof",
	"__extension__",
	"__label__",
	"__thread",
	"__auto_type",
	"__builtin_va_arg", "__builtin_va_list", "__builtin_offsetof",
	"__builtin_choose_expr", "__builtin_types_compatible_p",
	"__real__", "__imag__",
	"__complex__",
	"__func__", "__FUNCTION__", "__PRETTY_FUNCTION__",

	// MSVC
	"__declspec",
	"__cdecl", "__stdcall", "__fastcall", "__thiscall", "__vectorcall",
	"__forceinline",
	"__int8", "__int16", "__int32", "__int64",
	"__ptr32", "__ptr64",
	"__unaligned",
	"__w64",
	"__pragma",

	// Clang
	"_Nonnull", "_Nullable", "_Null_unspecified",
}

// Punctuator is a (name, source) pair.
type Punctuator struct {
	Name string
	Src  string
}

// Punctuators lists every punctuator/operator literal form. Order matters for
// longest-match in the dispatcher: longer forms first within a same-prefix
// group.
var Punctuators = []Punctuator{
	// 4-char
	{"PUNC_ELLIPSIS", "..."},

	// 3-char
	{"PUNC_LSHIFT_ASSIGN", "<<="},
	{"PUNC_RSHIFT_ASSIGN", ">>="},
	{"PUNC_HASH_HASH_ALT", "%:%:"},

	// 2-char
	{"PUNC_ARROW", "->"},
	{"PUNC_PLUS_PLUS", "++"},
	{"PUNC_MINUS_MINUS", "--"},
	{"PUNC_LSHIFT", "<<"},
	{"PUNC_RSHIFT", ">>"},
	{"PUNC_LE", "<="},
	{"PUNC_GE", ">="},
	{"PUNC_EQ", "=="},
	{"PUNC_NE", "!="},
	{"PUNC_AND_AND", "&&"},
	{"PUNC_OR_OR", "||"},
	{"PUNC_PLUS_ASSIGN", "+="},
	{"PUNC_MINUS_ASSIGN", "-="},
	{"PUNC_STAR_ASSIGN", "*="},
	{"PUNC_SLASH_ASSIGN", "/="},
	{"PUNC_PERCENT_ASSIGN", "%="},
	{"PUNC_AMP_ASSIGN", "&="},
	{"PUNC_CARET_ASSIGN", "^="},
	{"PUNC_PIPE_ASSIGN", "|="},
	{"PUNC_HASH_HASH", "##"},
	// C digraphs / alt-tokens
	{"PUNC_LBRACKET_ALT", "<:"},
	{"PUNC_RBRACKET_ALT", ":>"},
	{"PUNC_LBRACE_ALT", "<%"},
	{"PUNC_RBRACE_ALT", "%>"},
	{"PUNC_HASH_ALT", "%:"},
	// C23 attribute brackets are [[ and ]] which we keep as two LBRACKETs;
	// grammar reassembles them from a [ [ pair in attribute context.

	// 1-char
	{"PUNC_LPAREN", "("},
	{"PUNC_RPAREN", ")"},
	{"PUNC_LBRACE", "{"},
	{"PUNC_RBRACE", "}"},
	{"PUNC_LBRACKET", "["},
	{"PUNC_RBRACKET", "]"},
	{"PUNC_SEMI", ";"},
	{"PUNC_COMMA", ","},
	{"PUNC_DOT", "."},
	{"PUNC_QUESTION", "?"},
	{"PUNC_COLON", ":"},
	{"PUNC_ASSIGN", "="},
	{"PUNC_PLUS", "+"},
	{"PUNC_MINUS", "-"},
	{"PUNC_STAR", "*"},
	{"PUNC_SLASH", "/"},
	{"PUNC_PERCENT", "%"},
	{"PUNC_AMP", "&"},
	{"PUNC_PIPE", "|"},
	{"PUNC_CARET", "^"},
	{"PUNC_TILDE", "~"},
	{"PUNC_BANG", "!"},
	{"PUNC_LT", "<"},
	{"PUNC_GT", ">"},
	{"PUNC_HASH", "#"},
	{"PUNC_AT", "@"},        // not standard C; some extensions use it
	{"PUNC_BACKSLASH", "\\"}, // line-continuation already handled separately
}

// SpecialTokens are token names not derived from punctuators or keywords.
var SpecialTokens = []string{
	"ID",
	"TYPEDEF_NAME",
	"MACRO_NAME",
	"LIT_INT",
	"LIT_FLOAT",
	"LIT_CHAR",
	"LIT_STRING",
	"LIT_HEADER_NAME", // <foo.h> or "foo.h" inside #include
	"PP_HASH",         // start-of-line # that opens a directive
	"PP_NEWLINE",      // logical end-of-directive newline
	"PP_RAW",          // opaque token within a directive body
	"TRIVIA_LINE_COMMENT",
	"TRIVIA_BLOCK_COMMENT",
	"TRIVIA_LINE_CONT",
}

// ReservedWords is the set of all C identifier-like reserved words.
var ReservedWords = func() map[string]struct{} {
	m := make(map[string]struct{}, len(C23Keywords)+len(ExtKeywords))
	for _, w := range C23Keywords {
		m[w] = struct{}{}
	}
	for _, w := range ExtKeywords {
		m[w] = struct{}{}
	}
	return m
}()

// isKWNameChar reports whether c is kept verbatim in a KW_ token name; all
// other bytes become '_' (mirrors the TS /[^A-Za-z0-9_]/g replace).
func isKWNameChar(c byte) bool {
	return (c >= 'A' && c <= 'Z') ||
		(c >= 'a' && c <= 'z') ||
		(c >= '0' && c <= '9') ||
		c == '_'
}

// KeywordTokenName returns the canonical token name for a keyword, or "" if
// the word is not reserved.
func KeywordTokenName(word string) string {
	if _, ok := ReservedWords[word]; !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString("KW_")
	for i := 0; i < len(word); i++ {
		c := word[i]
		if isKWNameChar(c) {
			b.WriteByte(c)
		} else {
			b.WriteByte('_')
		}
	}
	return strings.ToUpper(b.String())
}

// AllTokenNamesAndSources returns the full name→source map this parser uses,
// suitable for one-shot registration via the fixed-token options.
func AllTokenNamesAndSources() map[string]string {
	out := make(map[string]string)
	for _, p := range Punctuators {
		out[p.Name] = p.Src
	}
	// Keywords are matched as identifiers then reclassified, but registering
	// them as fixed tokens lets grammar rules name them.
	for _, kw := range C23Keywords {
		out[KeywordTokenName(kw)] = kw
	}
	for _, kw := range ExtKeywords {
		out[KeywordTokenName(kw)] = kw
	}
	return out
}
