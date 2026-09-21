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

/// The C atoms a call or subscript can follow. Distinct from jsonic's
/// standard `VAL` set, so the implicit-list close alternates do not
/// fire on them.
pub const C_ATOM: &[&str] = &[
    "LIT_INT",
    "LIT_FLOAT",
    "LIT_CHAR",
    "LIT_STRING",
    "ID",
    "MACRO_NAME",
    "TYPEDEF_NAME",
];

/// The openers that turn an atom into a call or a subscript.
pub const C_PAREN_OPEN: &[&str] = &["PUNC_LPAREN", "PUNC_LBRACKET"];

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

/// Statement kinds the structured grammar path does not cover. A
/// function body that mentions one of these cannot be structured by
/// `block_item` dispatch, so the gate rejects the structured path and
/// the legacy chomp handles the whole declaration.
pub const UNSUPPORTED_BODY_TOKENS: &[&str] = &[
    "KW_STATIC_ASSERT",
    "KW__STATIC_ASSERT",
    // A body carrying inline assembly or a preprocessor line goes
    // through the legacy structuring path, which has the full
    // asm-operand and pp-line shapes.
    "KW_ASM",
    "KW___ASM",
    "KW___ASM__",
    "PP_HASH",
];
