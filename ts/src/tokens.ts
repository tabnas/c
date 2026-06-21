/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Token name catalog for the C concrete-syntax parser.
//
// Every token a C source can produce gets a stable name here. Lex matchers
// resolve names to tins (token integers) via lex.tokenize(name) and emit
// tokens carrying these names. Grammar rules reference the same names.
//
// Naming convention:
//   PUNC_*  punctuators and operators (one token per literal form)
//   KW_*    keywords (C23 + extension keywords)
//   LIT_*   literals (integer, float, char, string, header-name)
//   ID      ordinary identifier
//   TYPEDEF_NAME  identifier currently registered as a typedef in scope
//   MACRO_NAME    identifier currently registered as a macro
//   PP_*    preprocessor markers
//   TRIVIA_* preserved trivia (comments, whitespace if captured)


// ---- C23 keywords ----
// Pulled from N3096 §6.4.1 plus C23 additions (alignas/alignof/bool/false/
// nullptr/static_assert/thread_local/true/typeof/typeof_unqual and the
// underscore-prefixed legacy spellings).
export const C23_KEYWORDS: string[] = [
  'auto', 'break', 'case', 'char', 'const', 'constexpr', 'continue',
  'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for',
  'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return',
  'short', 'signed', 'sizeof', 'static', 'struct', 'switch',
  'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',

  // C23 unprefixed
  'alignas', 'alignof', 'bool', 'false', 'nullptr',
  'static_assert', 'thread_local', 'true',
  'typeof', 'typeof_unqual',

  // Underscore-prefixed (still valid in C23)
  '_Alignas', '_Alignof', '_Atomic', '_BitInt', '_Bool', '_Complex',
  '_Decimal32', '_Decimal64', '_Decimal128',
  '_Generic', '_Imaginary', '_Noreturn', '_Static_assert',
  '_Thread_local',
]

// ---- Compiler extension keywords ----
// GCC, Clang, MSVC. Recognized as keywords so the grammar can place them.
export const EXT_KEYWORDS: string[] = [
  // GCC / Clang
  '__attribute__', '__attribute',
  '__asm__', '__asm', 'asm',
  '__inline__', '__inline',
  '__signed__', '__signed',
  '__volatile__', '__volatile',
  '__const__', '__const',
  '__restrict__', '__restrict',
  '__typeof__', '__typeof',
  '__alignof__', '__alignof',
  '__extension__',
  '__label__',
  '__thread',
  '__auto_type',
  '__builtin_va_arg', '__builtin_va_list', '__builtin_offsetof',
  '__builtin_choose_expr', '__builtin_types_compatible_p',
  '__real__', '__imag__',
  '__complex__',
  '__func__', '__FUNCTION__', '__PRETTY_FUNCTION__',

  // MSVC
  '__declspec',
  '__cdecl', '__stdcall', '__fastcall', '__thiscall', '__vectorcall',
  '__forceinline',
  '__int8', '__int16', '__int32', '__int64',
  '__ptr32', '__ptr64',
  '__unaligned',
  '__w64',
  '__pragma',

  // Clang
  '_Nonnull', '_Nullable', '_Null_unspecified',
]

// ---- Punctuators ----
// (name, source). A separate token per literal form keeps lex matchers tiny
// and makes grammar rules readable. Order matters for longest-match in the
// dispatcher: longer forms first within a same-prefix group.
export const PUNCTUATORS: Array<[string, string]> = [
  // 4-char
  ['PUNC_ELLIPSIS', '...'],

  // 3-char
  ['PUNC_LSHIFT_ASSIGN', '<<='],
  ['PUNC_RSHIFT_ASSIGN', '>>='],
  ['PUNC_HASH_HASH_ALT', '%:%:'],

  // 2-char
  ['PUNC_ARROW', '->'],
  ['PUNC_PLUS_PLUS', '++'],
  ['PUNC_MINUS_MINUS', '--'],
  ['PUNC_LSHIFT', '<<'],
  ['PUNC_RSHIFT', '>>'],
  ['PUNC_LE', '<='],
  ['PUNC_GE', '>='],
  ['PUNC_EQ', '=='],
  ['PUNC_NE', '!='],
  ['PUNC_AND_AND', '&&'],
  ['PUNC_OR_OR', '||'],
  ['PUNC_PLUS_ASSIGN', '+='],
  ['PUNC_MINUS_ASSIGN', '-='],
  ['PUNC_STAR_ASSIGN', '*='],
  ['PUNC_SLASH_ASSIGN', '/='],
  ['PUNC_PERCENT_ASSIGN', '%='],
  ['PUNC_AMP_ASSIGN', '&='],
  ['PUNC_CARET_ASSIGN', '^='],
  ['PUNC_PIPE_ASSIGN', '|='],
  ['PUNC_HASH_HASH', '##'],
  // C digraphs / alt-tokens
  ['PUNC_LBRACKET_ALT', '<:'],
  ['PUNC_RBRACKET_ALT', ':>'],
  ['PUNC_LBRACE_ALT', '<%'],
  ['PUNC_RBRACE_ALT', '%>'],
  ['PUNC_HASH_ALT', '%:'],
  // C23 attribute brackets are [[ and ]] which we keep as two LBRACKETs;
  // grammar reassembles them from a [ [ pair in attribute context.

  // 1-char
  ['PUNC_LPAREN', '('],
  ['PUNC_RPAREN', ')'],
  ['PUNC_LBRACE', '{'],
  ['PUNC_RBRACE', '}'],
  ['PUNC_LBRACKET', '['],
  ['PUNC_RBRACKET', ']'],
  ['PUNC_SEMI', ';'],
  ['PUNC_COMMA', ','],
  ['PUNC_DOT', '.'],
  ['PUNC_QUESTION', '?'],
  ['PUNC_COLON', ':'],
  ['PUNC_ASSIGN', '='],
  ['PUNC_PLUS', '+'],
  ['PUNC_MINUS', '-'],
  ['PUNC_STAR', '*'],
  ['PUNC_SLASH', '/'],
  ['PUNC_PERCENT', '%'],
  ['PUNC_AMP', '&'],
  ['PUNC_PIPE', '|'],
  ['PUNC_CARET', '^'],
  ['PUNC_TILDE', '~'],
  ['PUNC_BANG', '!'],
  ['PUNC_LT', '<'],
  ['PUNC_GT', '>'],
  ['PUNC_HASH', '#'],
  ['PUNC_AT', '@'], // not standard C; some extensions use it
  ['PUNC_BACKSLASH', '\\'], // line-continuation already handled separately
]

// ---- Token names not derived from punctuators or keywords ----
export const SPECIAL_TOKENS: string[] = [
  'ID',
  'TYPEDEF_NAME',
  'MACRO_NAME',
  'LIT_INT',
  'LIT_FLOAT',
  'LIT_CHAR',
  'LIT_STRING',
  'LIT_HEADER_NAME',     // <foo.h> or "foo.h" inside #include
  'PP_HASH',             // start-of-line # that opens a directive
  'PP_NEWLINE',          // logical end-of-directive newline
  'PP_RAW',              // opaque token within a directive body
  'TRIVIA_LINE_COMMENT',
  'TRIVIA_BLOCK_COMMENT',
  'TRIVIA_LINE_CONT',
]

// ---- Helper: build a Set of all C identifier-like reserved words ----
export const RESERVED_WORDS: Set<string> = new Set<string>([
  ...C23_KEYWORDS,
  ...EXT_KEYWORDS,
])

// Returns canonical token name for a keyword, or null if not reserved.
export function keywordTokenName(word: string): string | null {
  if (!RESERVED_WORDS.has(word)) return null
  // KW_<UPPER> with non-letters preserved as underscores.
  return 'KW_' + word.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
}

// Full list of token names this parser uses, suitable for one-shot
// registration with jsonic.options({ fixed: { token: { ... } } }).
export function allTokenNamesAndSources(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, src] of PUNCTUATORS) {
    out[name] = src
  }
  // keywords are matched as identifiers then reclassified, so they don't
  // need a fixed src — but registering them lets grammar rules name them.
  for (const kw of [...C23_KEYWORDS, ...EXT_KEYWORDS]) {
    const name = keywordTokenName(kw)!
    // Use the keyword spelling as the fixed src so jsonic can match it as a
    // fixed token; the identifier matcher would still produce ID for non-
    // reserved names.
    out[name] = kw
  }
  return out
}
