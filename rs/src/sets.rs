/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The token-name sets the grammar and the rule actions dispatch on.
//!
//! The first group is installed as engine token sets, so the grammar
//! document can name them (`#SIMPLE_TYPE_HEAD` and the rest); the
//! second group is read directly by conditions and helpers. Both come
//! from `ts/src/c.ts`, where the same names appear in the `tokenSet`
//! option and as `Set<string>` constants.

/// Simple type specifiers. `unsigned`, `signed`, `long` and `short`
/// stack, so the dispatch alternates allow several before the
/// declarator name. Type qualifiers are here too, because a
/// declaration may start with one, and so are the tagged-type
/// keywords, which `spec_loop` dispatches onwards.
pub const SIMPLE_TYPE_HEAD: &[&str] = &[
    "KW_VOID",
    "KW_CHAR",
    "KW_SHORT",
    "KW_INT",
    "KW_LONG",
    "KW_FLOAT",
    "KW_DOUBLE",
    "KW_SIGNED",
    "KW_UNSIGNED",
    "KW_BOOL",
    "KW__BOOL",
    "KW___SIGNED__",
    "KW___SIGNED",
    "KW___INT8",
    "KW___INT16",
    "KW___INT32",
    "KW___INT64",
    "KW__COMPLEX",
    "KW__IMAGINARY",
    "TYPEDEF_NAME",
    "KW_CONST",
    "KW_VOLATILE",
    "KW_RESTRICT",
    "KW__ATOMIC",
    "KW___CONST__",
    "KW___CONST",
    "KW___VOLATILE__",
    "KW___VOLATILE",
    "KW___RESTRICT__",
    "KW___RESTRICT",
    "KW_STRUCT",
    "KW_UNION",
    "KW_ENUM",
];

/// A leading storage-class keyword the dispatcher accepts ahead of a
/// type specifier. `KW_TYPEDEF` is in the set so `typedef int T;` takes
/// the structured path and the finaliser registers `T` as a typedef
/// name, exactly as the legacy chomp does.
pub const STORAGE_PREFIX: &[&str] = &[
    "KW_STATIC",
    "KW_EXTERN",
    "KW_TYPEDEF",
    "KW_AUTO",
    "KW_REGISTER",
    "KW__THREAD_LOCAL",
    "KW_THREAD_LOCAL",
    "KW_CONSTEXPR",
    "KW___THREAD",
    "KW_INLINE",
    "KW___INLINE__",
    "KW___INLINE",
    "KW___EXTENSION__",
];

/// The head of a declaration that is not held to the rules: armed
/// (`c-grammar.jsonic`, `external_declaration`). Every keyword that can
/// start a declaration's specifiers.
pub const DECL_HEAD: &[&str] = &[
    "KW_VOID",
    "KW_CHAR",
    "KW_SHORT",
    "KW_INT",
    "KW_LONG",
    "KW_FLOAT",
    "KW_DOUBLE",
    "KW_SIGNED",
    "KW_UNSIGNED",
    "KW_BOOL",
    "KW__BOOL",
    "KW___SIGNED__",
    "KW___SIGNED",
    "KW___INT8",
    "KW___INT16",
    "KW___INT32",
    "KW___INT64",
    "KW__COMPLEX",
    "KW__IMAGINARY",
    "KW___COMPLEX__",
    "KW__DECIMAL32",
    "KW__DECIMAL64",
    "KW__DECIMAL128",
    "KW__BITINT",
    "KW___BUILTIN_VA_LIST",
    "KW___AUTO_TYPE",
    "KW_TYPEOF",
    "KW_TYPEOF_UNQUAL",
    "KW___TYPEOF__",
    "KW___TYPEOF",
    "TYPEDEF_NAME",
    "KW_CONST",
    "KW_VOLATILE",
    "KW_RESTRICT",
    "KW__ATOMIC",
    "KW___CONST__",
    "KW___CONST",
    "KW___VOLATILE__",
    "KW___VOLATILE",
    "KW___RESTRICT__",
    "KW___RESTRICT",
    "KW_STRUCT",
    "KW_UNION",
    "KW_ENUM",
    "KW_STATIC",
    "KW_EXTERN",
    "KW_TYPEDEF",
    "KW_AUTO",
    "KW_REGISTER",
    "KW__THREAD_LOCAL",
    "KW_THREAD_LOCAL",
    "KW_CONSTEXPR",
    "KW___THREAD",
    "KW_INLINE",
    "KW___INLINE__",
    "KW___INLINE",
    "KW___FORCEINLINE",
    "KW__NORETURN",
    "KW__ALIGNAS",
    "KW_ALIGNAS",
    "KW___EXTENSION__",
    "KW___ATTRIBUTE__",
    "KW___ATTRIBUTE",
    "KW___DECLSPEC",
];

/// The operators of C's expression rules (`crate::expression` has
/// their precedence).
pub const ASSIGN_OP: &[&str] = &[
    "PUNC_ASSIGN",
    "PUNC_PLUS_ASSIGN",
    "PUNC_MINUS_ASSIGN",
    "PUNC_STAR_ASSIGN",
    "PUNC_SLASH_ASSIGN",
    "PUNC_PERCENT_ASSIGN",
    "PUNC_LSHIFT_ASSIGN",
    "PUNC_RSHIFT_ASSIGN",
    "PUNC_AMP_ASSIGN",
    "PUNC_CARET_ASSIGN",
    "PUNC_PIPE_ASSIGN",
];
pub const BINARY_OP: &[&str] = &[
    "PUNC_OR_OR",
    "PUNC_AND_AND",
    "PUNC_PIPE",
    "PUNC_CARET",
    "PUNC_AMP",
    "PUNC_EQ",
    "PUNC_NE",
    "PUNC_LT",
    "PUNC_LE",
    "PUNC_GT",
    "PUNC_GE",
    "PUNC_LSHIFT",
    "PUNC_RSHIFT",
    "PUNC_PLUS",
    "PUNC_MINUS",
    "PUNC_STAR",
    "PUNC_SLASH",
    "PUNC_PERCENT",
];
pub const INCDEC: &[&str] = &["PUNC_PLUS_PLUS", "PUNC_MINUS_MINUS"];
pub const UNARY_OP: &[&str] = &[
    "PUNC_PLUS",
    "PUNC_MINUS",
    "PUNC_BANG",
    "PUNC_TILDE",
    "PUNC_STAR",
    "PUNC_AMP",
];
pub const MEMBER_NAME: &[&str] = &["ID", "TYPEDEF_NAME", "MACRO_NAME"];

/// The storage classes and function specifiers `spec_loop` takes
/// anywhere among the specifiers: C's, and the extensions' (in extended
/// mode).
pub const STORAGE_STD: &[&str] = &[
    "KW_STATIC",
    "KW_EXTERN",
    "KW_TYPEDEF",
    "KW_AUTO",
    "KW_REGISTER",
    "KW__THREAD_LOCAL",
    "KW_THREAD_LOCAL",
    "KW_CONSTEXPR",
    "KW_INLINE",
];
pub const STORAGE_EXT: &[&str] = &[
    "KW___THREAD",
    "KW___INLINE__",
    "KW___INLINE",
    "KW___EXTENSION__",
];

/// Specifier keywords `spec_loop` takes as tokens, beside the type heads
/// and the storage classes: C's, and the extensions'.
pub const SPEC_KEYWORD: &[&str] = &[
    "KW__NORETURN",
    "KW__DECIMAL32",
    "KW__DECIMAL64",
    "KW__DECIMAL128",
];
pub const SPEC_KEYWORD_EXT: &[&str] = &[
    "KW___FORCEINLINE",
    "KW___BUILTIN_VA_LIST",
    "KW___AUTO_TYPE",
    "KW___COMPLEX__",
];

/// Specifiers with a parenthesised argument: C's, and the extensions'.
pub const PAREN_SPEC: &[&str] = &["KW_TYPEOF", "KW_TYPEOF_UNQUAL", "KW_ALIGNAS", "KW__ALIGNAS"];
pub const PAREN_SPEC_EXT: &[&str] = &["KW___TYPEOF__", "KW___TYPEOF"];

/// A pointer's qualifiers: C's, and the extensions' spellings.
pub const PTR_QUALIFIER: &[&str] = &["KW_CONST", "KW_VOLATILE", "KW_RESTRICT", "KW__ATOMIC"];
pub const PTR_QUALIFIER_EXT: &[&str] = &[
    "KW___CONST__",
    "KW___CONST",
    "KW___VOLATILE__",
    "KW___VOLATILE",
    "KW___RESTRICT__",
    "KW___RESTRICT",
];

pub const ASM_KEYWORD: &[&str] = &["KW_ASM", "KW___ASM", "KW___ASM__"];

/// What never directly follows an operand in C: an identifier or a
/// literal.
pub const JUXTAPOSED: &[&str] = &[
    "ID",
    "TYPEDEF_NAME",
    "MACRO_NAME",
    "LIT_INT",
    "LIT_FLOAT",
    "LIT_CHAR",
    "LIT_STRING",
];

/// `sizeof` and the alignment operators, whose parenthesised type form
/// a `val` alternate has to tell from the expression form.
pub const SIZEOF_KW: &[&str] = &[
    "KW_SIZEOF",
    "KW__ALIGNOF",
    "KW_ALIGNOF",
    "KW___ALIGNOF__",
    "KW___ALIGNOF",
];

/// Trivia whose source is kept in the tree: comments and line
/// continuations, re-emitted as token references ahead of the next
/// non-trivia token.
pub const PRESERVE_TRIVIA_NAMES: &[&str] = &[
    "TRIVIA_LINE_COMMENT",
    "TRIVIA_BLOCK_COMMENT",
    "TRIVIA_LINE_CONT",
];

/// Trivia dropped from the tree entirely. Spans on real tokens still
/// carry the positional information.
pub const DROP_TRIVIA_NAMES: &[&str] = &["#SP", "#LN", "#CM"];

/// Any trivia, kept or dropped.
pub fn is_trivia(name: &str) -> bool {
    PRESERVE_TRIVIA_NAMES.contains(&name) || DROP_TRIVIA_NAMES.contains(&name)
}

/// Type qualifiers in declarator pointer position, used to walk past
/// `* const`, `* volatile` and the rest when locating a declared name.
pub const PTR_QUALIFIER_TOKEN_NAMES: &[&str] = &[
    "KW_CONST",
    "KW_VOLATILE",
    "KW_RESTRICT",
    "KW__ATOMIC",
    "KW___CONST__",
    "KW___CONST",
    "KW___VOLATILE__",
    "KW___VOLATILE",
    "KW___RESTRICT__",
    "KW___RESTRICT",
];

/// Tokens that begin a type specifier in declaration specifiers. The
/// boundary between specifiers and declarators is the first token that
/// is not one of these.
pub const TYPE_SPEC_KEYWORD_NAMES: &[&str] = &[
    "KW_VOID",
    "KW_CHAR",
    "KW_SHORT",
    "KW_INT",
    "KW_LONG",
    "KW_FLOAT",
    "KW_DOUBLE",
    "KW_SIGNED",
    "KW_UNSIGNED",
    "KW_BOOL",
    "KW__BOOL",
    "KW__COMPLEX",
    "KW__IMAGINARY",
    "KW___SIGNED__",
    "KW___SIGNED",
    "KW___INT8",
    "KW___INT16",
    "KW___INT32",
    "KW___INT64",
    "KW_STRUCT",
    "KW_UNION",
    "KW_ENUM",
    "KW_TYPEOF",
    "KW_TYPEOF_UNQUAL",
    "KW___TYPEOF__",
    "KW___TYPEOF",
    "KW__BITINT",
];

pub const STORAGE_CLASS_NAMES: &[&str] = &[
    "KW_TYPEDEF",
    "KW_EXTERN",
    "KW_STATIC",
    "KW_AUTO",
    "KW_REGISTER",
    "KW__THREAD_LOCAL",
    "KW_THREAD_LOCAL",
    "KW_CONSTEXPR",
    "KW___THREAD",
];

/// Type qualifiers, which are the pointer qualifiers under another
/// name in the canonical source.
pub const TYPE_QUALIFIER_NAMES: &[&str] = PTR_QUALIFIER_TOKEN_NAMES;

pub const FUNCTION_SPECIFIER_NAMES: &[&str] =
    &["KW_INLINE", "KW___INLINE__", "KW___INLINE", "KW__NORETURN"];

pub fn is_specifier_kw(name: &str) -> bool {
    STORAGE_CLASS_NAMES.contains(&name)
        || TYPE_SPEC_KEYWORD_NAMES.contains(&name)
        || TYPE_QUALIFIER_NAMES.contains(&name)
        || FUNCTION_SPECIFIER_NAMES.contains(&name)
        || name == "TYPEDEF_NAME"
}

/// Tokens whose function bodies 0.5's validator declined. The validator
/// answers as it did in 0.5, so which declarations extended mode holds to
/// the rules is 0.5's: a body that holds one of these is armed (the rules
/// build it, and it is an unknown declaration where they cannot), where
/// 0.5 handed it to its structurer.
pub const UNSUPPORTED_BODY_TOKENS: &[&str] = &[
    "KW_STATIC_ASSERT",
    "KW__STATIC_ASSERT",
    // Function bodies that contain extension constructs (inline
    // assembly, preprocessor lines).
    "KW_ASM",
    "KW___ASM",
    "KW___ASM__",
    "PP_HASH",
];
