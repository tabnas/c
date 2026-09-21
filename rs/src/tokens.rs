/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! Token name catalog for the C concrete-syntax parser.
//!
//! Every token a C source can produce gets a stable name here. Lex
//! matchers resolve names to tins (token integers) and emit tokens
//! carrying these names; grammar rules reference the same names.
//!
//! Port of `ts/src/tokens.ts`.

/// C23 keywords: N3096 section 6.4.1 plus the C23 additions and the
/// underscore-prefixed legacy spellings.
pub const C23_KEYWORDS: &[&str] = &[
    "auto",
    "break",
    "case",
    "char",
    "const",
    "constexpr",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extern",
    "float",
    "for",
    "goto",
    "if",
    "inline",
    "int",
    "long",
    "register",
    "restrict",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "struct",
    "switch",
    "typedef",
    "union",
    "unsigned",
    "void",
    "volatile",
    "while",
    // C23 unprefixed
    "alignas",
    "alignof",
    "bool",
    "false",
    "nullptr",
    "static_assert",
    "thread_local",
    "true",
    "typeof",
    "typeof_unqual",
    // Underscore-prefixed (still valid in C23)
    "_Alignas",
    "_Alignof",
    "_Atomic",
    "_BitInt",
    "_Bool",
    "_Complex",
    "_Decimal32",
    "_Decimal64",
    "_Decimal128",
    "_Generic",
    "_Imaginary",
    "_Noreturn",
    "_Static_assert",
    "_Thread_local",
];

/// Compiler extension keywords: GCC, Clang, MSVC. Recognized as keywords
/// so the grammar can place them.
pub const EXT_KEYWORDS: &[&str] = &[
    // GCC / Clang
    "__attribute__",
    "__attribute",
    "__asm__",
    "__asm",
    "asm",
    "__inline__",
    "__inline",
    "__signed__",
    "__signed",
    "__volatile__",
    "__volatile",
    "__const__",
    "__const",
    "__restrict__",
    "__restrict",
    "__typeof__",
    "__typeof",
    "__alignof__",
    "__alignof",
    "__extension__",
    "__label__",
    "__thread",
    "__auto_type",
    "__builtin_va_arg",
    "__builtin_va_list",
    "__builtin_offsetof",
    "__builtin_choose_expr",
    "__builtin_types_compatible_p",
    "__real__",
    "__imag__",
    "__complex__",
    "__func__",
    "__FUNCTION__",
    "__PRETTY_FUNCTION__",
    // MSVC
    "__declspec",
    "__cdecl",
    "__stdcall",
    "__fastcall",
    "__thiscall",
    "__vectorcall",
    "__forceinline",
    "__int8",
    "__int16",
    "__int32",
    "__int64",
    "__ptr32",
    "__ptr64",
    "__unaligned",
    "__w64",
    "__pragma",
    // Clang
    "_Nonnull",
    "_Nullable",
    "_Null_unspecified",
];

/// Punctuators as `(name, source)`. A separate token per literal form
/// keeps the lex matchers tiny and the grammar rules readable. Order
/// matters for longest-match in the dispatcher: longer forms first
/// within a same-prefix group.
pub const PUNCTUATORS: &[(&str, &str)] = &[
    // 4-char
    ("PUNC_ELLIPSIS", "..."),
    // 3-char
    ("PUNC_LSHIFT_ASSIGN", "<<="),
    ("PUNC_RSHIFT_ASSIGN", ">>="),
    ("PUNC_HASH_HASH_ALT", "%:%:"),
    // 2-char
    ("PUNC_ARROW", "->"),
    ("PUNC_PLUS_PLUS", "++"),
    ("PUNC_MINUS_MINUS", "--"),
    ("PUNC_LSHIFT", "<<"),
    ("PUNC_RSHIFT", ">>"),
    ("PUNC_LE", "<="),
    ("PUNC_GE", ">="),
    ("PUNC_EQ", "=="),
    ("PUNC_NE", "!="),
    ("PUNC_AND_AND", "&&"),
    ("PUNC_OR_OR", "||"),
    ("PUNC_PLUS_ASSIGN", "+="),
    ("PUNC_MINUS_ASSIGN", "-="),
    ("PUNC_STAR_ASSIGN", "*="),
    ("PUNC_SLASH_ASSIGN", "/="),
    ("PUNC_PERCENT_ASSIGN", "%="),
    ("PUNC_AMP_ASSIGN", "&="),
    ("PUNC_CARET_ASSIGN", "^="),
    ("PUNC_PIPE_ASSIGN", "|="),
    ("PUNC_HASH_HASH", "##"),
    // C digraphs / alt-tokens
    ("PUNC_LBRACKET_ALT", "<:"),
    ("PUNC_RBRACKET_ALT", ":>"),
    ("PUNC_LBRACE_ALT", "<%"),
    ("PUNC_RBRACE_ALT", "%>"),
    ("PUNC_HASH_ALT", "%:"),
    // 1-char
    ("PUNC_LPAREN", "("),
    ("PUNC_RPAREN", ")"),
    ("PUNC_LBRACE", "{"),
    ("PUNC_RBRACE", "}"),
    ("PUNC_LBRACKET", "["),
    ("PUNC_RBRACKET", "]"),
    ("PUNC_SEMI", ";"),
    ("PUNC_COMMA", ","),
    ("PUNC_DOT", "."),
    ("PUNC_QUESTION", "?"),
    ("PUNC_COLON", ":"),
    ("PUNC_ASSIGN", "="),
    ("PUNC_PLUS", "+"),
    ("PUNC_MINUS", "-"),
    ("PUNC_STAR", "*"),
    ("PUNC_SLASH", "/"),
    ("PUNC_PERCENT", "%"),
    ("PUNC_AMP", "&"),
    ("PUNC_PIPE", "|"),
    ("PUNC_CARET", "^"),
    ("PUNC_TILDE", "~"),
    ("PUNC_BANG", "!"),
    ("PUNC_LT", "<"),
    ("PUNC_GT", ">"),
    ("PUNC_HASH", "#"),
    ("PUNC_AT", "@"),
    ("PUNC_BACKSLASH", "\\"),
];

/// Token names not derived from punctuators or keywords.
pub const SPECIAL_TOKENS: &[&str] = &[
    "ID",
    "TYPEDEF_NAME",
    "MACRO_NAME",
    "LIT_INT",
    "LIT_FLOAT",
    "LIT_CHAR",
    "LIT_STRING",
    "LIT_HEADER_NAME",
    "PP_HASH",
    "PP_NEWLINE",
    "PP_RAW",
    "TRIVIA_LINE_COMMENT",
    "TRIVIA_BLOCK_COMMENT",
    "TRIVIA_LINE_CONT",
];

/// True when `word` is a C or extension keyword.
pub fn is_reserved(word: &str) -> bool {
    C23_KEYWORDS.contains(&word) || EXT_KEYWORDS.contains(&word)
}

/// `KW_<UPPER>` for any word, reserved or not. The JavaScript original
/// is `'KW_' + word.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()`; the
/// character class is spelled out here rather than written as `\w`,
/// which the `regex` crate would make Unicode-aware.
pub fn keyword_token_name_unchecked(word: &str) -> String {
    let mut out = String::with_capacity(word.len() + 3);
    out.push_str("KW_");
    for ch in word.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.extend(ch.to_uppercase());
        } else {
            out.push('_');
        }
    }
    out
}

/// Every keyword token name, C23 first then the extensions, in the
/// order `tokens.ts` declares them.
pub fn keyword_token_names() -> Vec<String> {
    C23_KEYWORDS
        .iter()
        .chain(EXT_KEYWORDS.iter())
        .map(|keyword| keyword_token_name_unchecked(keyword))
        .collect()
}

/// Names of the tokens the chomper's wildcard alternate position
/// accepts. Port of `anyCTokenNames` in `ts/src/c.ts`: the `TRIVIA_*`
/// names are deliberately absent, because they are ignored and reach
/// the tree as `use.leading` on the next token instead.
pub fn any_c_token_names() -> Vec<String> {
    let mut names: Vec<String> = [
        "ID",
        "TYPEDEF_NAME",
        "MACRO_NAME",
        "LIT_INT",
        "LIT_FLOAT",
        "LIT_CHAR",
        "LIT_STRING",
        "LIT_HEADER_NAME",
        "PP_HASH",
        "PP_NEWLINE",
        "PP_RAW",
    ]
    .iter()
    .map(|name| (*name).to_string())
    .collect();
    for (name, _) in PUNCTUATORS {
        names.push((*name).to_string());
    }
    names.extend(keyword_token_names());
    names
}
