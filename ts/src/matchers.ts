/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Focused lex matchers for the C parser. Each matcher does one job and
// returns either a Token or undefined (signalling "not my prefix").
//
// All matchers share access to the symbol/macro/mode state via
// ctx.meta.cmeta; see ./symbols.ts for the shape.
//
// Matcher contract (jsonic LexMatcher):
//   (lex, rule, tI?) => Token | undefined
// On a hit:
//   - Call lex.token(name, val, src) to construct the Token.
//   - Advance lex.pnt.sI / rI / cI by the consumed length.

import type { Lex, Rule, Token } from '@tabnas/parser'
import {
  C23_KEYWORDS,
  EXT_KEYWORDS,
  PUNCTUATORS,
  keywordTokenName,
} from './tokens.js'
import type { CMeta } from './symbols.js'

const RESERVED = new Set<string>([...C23_KEYWORDS, ...EXT_KEYWORDS])

// Helpers --------------------------------------------------------------

function getMeta(lex: Lex): CMeta {
  return (lex.ctx.meta as any).cmeta as CMeta
}

function source(lex: Lex): string {
  return lex.ctx.src()
}

// Advance the lex point by `len` characters, updating row/col counters.
function advance(lex: Lex, src: string, len: number): void {
  const pnt = lex.pnt
  for (let i = 0; i < len; i++) {
    const c = src.charCodeAt(pnt.sI + i)
    if (c === 10) { // \n
      pnt.rI++
      pnt.cI = 1
    } else {
      pnt.cI++
    }
  }
  pnt.sI += len
}

// Build a token, then advance the point. lex.token captures the current
// pnt at construction, so positions reflect the start of the token.
function emit(
  lex: Lex,
  name: string,
  val: any,
  src: string,
  consumed: number,
): Token {
  const tkn = lex.token(name as any, val, src)
  advance(lex, source(lex), consumed)
  return tkn
}

// Whitespace ------------------------------------------------------------
// C whitespace excludes newline when we are inside a preprocessor directive
// (newline terminates the directive). Outside directives newline is just
// space.

export function makeWhitespaceMatcher() {
  return function whitespace(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    if (sI >= src.length) return undefined
    const c0 = src.charCodeAt(sI)
    // Quick reject: only spaces, tabs, vertical tab, form feed, CR, LF.
    if (c0 !== 32 && c0 !== 9 && c0 !== 11 && c0 !== 12 && c0 !== 13 && c0 !== 10) {
      return undefined
    }
    const meta = getMeta(lex)
    let i = sI
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 32 || c === 9 || c === 11 || c === 12 || c === 13) {
        i++
        continue
      }
      if (c === 10) {
        if (meta.mode.inDirective) break // newline ends a directive
        i++
        continue
      }
      break
    }
    if (i === sI) return undefined
    // Emit as a space token jsonic will treat as ignorable; we use the
    // built-in '#SP' machinery here by returning undefined? No — we want to
    // preserve trivia. Instead emit an ignored token with our own name.
    return emit(lex, '#SP', src.substring(sI, i), src.substring(sI, i), i - sI)
  }
}

// Line continuation (backslash + newline) ------------------------------
// In C this is logical-line splicing performed by the preprocessor before
// tokenisation. We treat it as trivia so it survives in the CST.

export function makeLineContMatcher() {
  return function lineCont(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    if (src.charCodeAt(sI) !== 92 /* \ */) return undefined
    let consumed = 0
    if (src.charCodeAt(sI + 1) === 10) consumed = 2
    else if (src.charCodeAt(sI + 1) === 13 && src.charCodeAt(sI + 2) === 10) consumed = 3
    else if (src.charCodeAt(sI + 1) === 13) consumed = 2
    else return undefined
    const text = src.substring(sI, sI + consumed)
    return emit(lex, 'TRIVIA_LINE_CONT', text, text, consumed)
  }
}

// Line comment // ... ---------------------------------------------------

export function makeLineCommentMatcher() {
  return function lineComment(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    if (src.charCodeAt(sI) !== 47 /* / */) return undefined
    if (src.charCodeAt(sI + 1) !== 47) return undefined
    let i = sI + 2
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 10 || c === 13) break
      i++
    }
    const text = src.substring(sI, i)
    return emit(lex, 'TRIVIA_LINE_COMMENT', text, text, i - sI)
  }
}

// Block comment /* ... */ ----------------------------------------------

export function makeBlockCommentMatcher() {
  return function blockComment(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    if (src.charCodeAt(sI) !== 47 /* / */) return undefined
    if (src.charCodeAt(sI + 1) !== 42 /* * */) return undefined
    let i = sI + 2
    while (i < src.length - 1) {
      if (src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47) {
        i += 2
        const text = src.substring(sI, i)
        return emit(lex, 'TRIVIA_BLOCK_COMMENT', text, text, i - sI)
      }
      i++
    }
    return lex.bad('unterminated_comment', sI, src.length)
  }
}

// Preprocessor directive opener ----------------------------------------
// Emits PP_HASH only when '#' (or '%:') appears at the start of a logical
// line — i.e. preceded only by whitespace since the last unspliced newline.

function atLineStart(src: string, sI: number): boolean {
  let i = sI - 1
  while (i >= 0) {
    const c = src.charCodeAt(i)
    if (c === 10) return true
    if (c === 32 || c === 9) { i--; continue }
    if (c === 13) return true
    return false
  }
  return true
}

export function makePPDirectiveOpenerMatcher() {
  return function ppDirective(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    const c0 = src.charCodeAt(sI)
    let consumed = 0
    if (c0 === 35 /* # */) {
      consumed = 1
    } else if (c0 === 37 /* % */ && src.charCodeAt(sI + 1) === 58 /* : */) {
      consumed = 2
    } else {
      return undefined
    }
    if (!atLineStart(src, sI)) return undefined
    const meta = getMeta(lex)
    meta.mode.inDirective = true
    meta.mode.directiveName = null
    meta.mode.expectHeaderName = false
    const text = src.substring(sI, sI + consumed)
    return emit(lex, 'PP_HASH', text, text, consumed)
  }
}

// Directive newline terminator -----------------------------------------
// Emits PP_NEWLINE only when in directive mode; resets mode flags.

export function makePPNewlineMatcher() {
  return function ppNewline(lex: Lex, _rule: Rule): Token | undefined {
    const meta = getMeta(lex)
    if (!meta.mode.inDirective) return undefined
    const src = source(lex)
    const sI = lex.pnt.sI
    const c0 = src.charCodeAt(sI)
    if (c0 !== 10 && c0 !== 13) return undefined
    let consumed = 1
    if (c0 === 13 && src.charCodeAt(sI + 1) === 10) consumed = 2
    meta.mode.inDirective = false
    meta.mode.directiveName = null
    meta.mode.expectHeaderName = false
    const text = src.substring(sI, sI + consumed)
    return emit(lex, 'PP_NEWLINE', text, text, consumed)
  }
}

// Header name <foo.h> or "foo.h" — only valid inside #include / #embed --

export function makeHeaderNameMatcher() {
  return function headerName(lex: Lex, _rule: Rule): Token | undefined {
    const meta = getMeta(lex)
    if (!meta.mode.inDirective || !meta.mode.expectHeaderName) return undefined
    const src = source(lex)
    const sI = lex.pnt.sI
    const c0 = src.charCodeAt(sI)
    let close: number
    if (c0 === 60 /* < */) close = 62 /* > */
    else if (c0 === 34 /* " */) close = 34
    else return undefined
    let i = sI + 1
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 10) return lex.bad('unterminated_header_name', sI, i)
      if (c === close) {
        i++
        meta.mode.expectHeaderName = false
        const text = src.substring(sI, i)
        return emit(lex, 'LIT_HEADER_NAME', text, text, i - sI)
      }
      i++
    }
    return lex.bad('unterminated_header_name', sI, src.length)
  }
}

// Identifier (and keyword/typedef-name/macro-name reclassification) ----

const ID_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/

export function makeIdentifierMatcher() {
  return function identifier(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    const c0 = src.charCodeAt(sI)
    // Fast reject: must start with letter, _, or $ (gcc allows $).
    const isStart =
      (c0 >= 65 && c0 <= 90) ||
      (c0 >= 97 && c0 <= 122) ||
      c0 === 95 || c0 === 36
    if (!isStart) return undefined
    const m = ID_RE.exec(src.substring(sI))
    if (!m) return undefined
    const word = m[0]
    const meta = getMeta(lex)

    // Reserved word?
    if (RESERVED.has(word)) {
      const tname = keywordTokenName(word)!
      // If we are in a directive and this is the first identifier, record
      // the directive name and arm the header-name flag for include/embed.
      if (meta.mode.inDirective && meta.mode.directiveName === null) {
        meta.mode.directiveName = word
      }
      return emit(lex, tname, word, word, word.length)
    }

    // Inside a directive, the first identifier names the directive.
    if (meta.mode.inDirective && meta.mode.directiveName === null) {
      meta.mode.directiveName = word
      if (word === 'include' || word === 'embed' || word === 'include_next') {
        meta.mode.expectHeaderName = true
      }
      // Common directives are not C reserved words; emit a normal ID and
      // let the directive grammar dispatch on the value.
      return emit(lex, 'ID', word, word, word.length)
    }

    // Typedef-name disambiguation. A name in scope as a typedef becomes
    // TYPEDEF_NAME; the parser uses this distinction to choose between
    // declaration and expression alts.
    //
    // Note: we do NOT emit TYPEDEF_NAME inside directive bodies — there the
    // name is just a token, semantics deferred.
    if (!meta.mode.inDirective && meta.symbols.isTypedef(word)) {
      return emit(lex, 'TYPEDEF_NAME', word, word, word.length)
    }

    // Macro-name tagging: identifiers previously seen in a #define
    // surface as MACRO_NAME so call sites can be distinguished from
    // ordinary function calls. The grammar accepts MACRO_NAME wherever
    // it accepts ID.
    if (!meta.mode.inDirective && meta.macros.has(word)) {
      return emit(lex, 'MACRO_NAME', word, word, word.length)
    }

    return emit(lex, 'ID', word, word, word.length)
  }
}

// Integer literal ------------------------------------------------------
// dec, hex, oct, binary, with C23 ' digit separators and integer suffixes
// (u/U, l/L, ll/LL, wb/WB, plus combinations).

const INT_RE = new RegExp(
  '^(' +
    '0[xX][0-9a-fA-F](?:[\'0-9a-fA-F])*' + // hex
    '|0[bB][01](?:[\'01])*' +              // binary (C23)
    '|0(?:[\'0-7])*' +                      // octal (also matches lone 0)
    '|[1-9](?:[\'0-9])*' +                  // decimal
  ')([uUlL]*[wWbBzZ]*[uUlL]*)?',
)

export function makeIntegerMatcher() {
  return function integer(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    const c0 = src.charCodeAt(sI)
    if (c0 < 48 || c0 > 57) return undefined
    const rest = src.substring(sI)
    const m = INT_RE.exec(rest)
    if (!m) return undefined
    // Disambiguate from float: if the next char after the integer part is
    // '.', 'e', 'E', 'p', 'P', defer to the float matcher.
    const after = rest.charCodeAt(m[0].length)
    if (after === 46 /* . */ || after === 101 /* e */ || after === 69 /* E */) {
      // For hex literals only p/P signals exponent.
      if (m[1].startsWith('0x') || m[1].startsWith('0X')) {
        // hex without . or p in m[1]: a trailing 'e' is not a float exponent
        // (it could be a hex digit), so we keep the int.
      } else {
        return undefined
      }
    }
    if ((m[1].startsWith('0x') || m[1].startsWith('0X')) &&
        (after === 46 || after === 112 /* p */ || after === 80 /* P */)) {
      return undefined
    }
    const text = m[0]
    return emit(lex, 'LIT_INT', text, text, text.length)
  }
}

// Floating literal -----------------------------------------------------

const FLOAT_DEC_RE = new RegExp(
  '^(?:' +
    '(?:[0-9](?:[\'0-9])*)?\\.[0-9](?:[\'0-9])*(?:[eE][+-]?[0-9](?:[\'0-9])*)?' +
    '|[0-9](?:[\'0-9])*\\.(?:[eE][+-]?[0-9](?:[\'0-9])*)?' +
    '|[0-9](?:[\'0-9])*[eE][+-]?[0-9](?:[\'0-9])*' +
  ')[fFlLdD]?[fFlL]?',
)

const FLOAT_HEX_RE = new RegExp(
  '^0[xX](?:' +
    '[0-9a-fA-F](?:[\'0-9a-fA-F])*\\.(?:[0-9a-fA-F](?:[\'0-9a-fA-F])*)?' +
    '|\\.[0-9a-fA-F](?:[\'0-9a-fA-F])*' +
    '|[0-9a-fA-F](?:[\'0-9a-fA-F])*' +
  ')[pP][+-]?[0-9](?:[\'0-9])*[fFlL]?',
)

export function makeFloatMatcher() {
  return function float(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    const c0 = src.charCodeAt(sI)
    // Must start with digit or '.' followed by digit.
    const c1 = src.charCodeAt(sI + 1)
    const startsDigit = c0 >= 48 && c0 <= 57
    const startsDot = c0 === 46 && c1 >= 48 && c1 <= 57
    if (!startsDigit && !startsDot) return undefined
    const rest = src.substring(sI)
    let m = FLOAT_HEX_RE.exec(rest)
    if (!m) m = FLOAT_DEC_RE.exec(rest)
    if (!m) return undefined
    // Reject pure integers without dot, exponent or float suffix; let the
    // integer matcher take them.
    const text = m[0]
    if (!/[.eEpPfFlL]/.test(text) && !text.startsWith('0x') && !text.startsWith('0X')) {
      return undefined
    }
    return emit(lex, 'LIT_FLOAT', text, text, text.length)
  }
}

// Character literal ----------------------------------------------------

const CHAR_PREFIX_RE = /^(L|u8|u|U)?'/

export function makeCharLiteralMatcher() {
  return function charLit(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    const rest = src.substring(sI)
    const pm = CHAR_PREFIX_RE.exec(rest)
    if (!pm) return undefined
    let i = sI + pm[0].length
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 10) return lex.bad('unterminated_char', sI, i)
      if (c === 92 /* \ */) { i += 2; continue }
      if (c === 39 /* ' */) {
        i++
        const text = src.substring(sI, i)
        return emit(lex, 'LIT_CHAR', text, text, i - sI)
      }
      i++
    }
    return lex.bad('unterminated_char', sI, src.length)
  }
}

// String literal -------------------------------------------------------
// Encoding-prefixes: u8, u, U, L. Raw strings (R"...") are a C++ feature
// that some compilers extend to C; supported as an extension.

const STR_PREFIX_RE = /^(u8|u|U|L)?(R)?"/

export function makeStringLiteralMatcher() {
  return function stringLit(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    const rest = src.substring(sI)
    const pm = STR_PREFIX_RE.exec(rest)
    if (!pm) return undefined
    const isRaw = pm[2] === 'R'
    let i = sI + pm[0].length
    if (isRaw) {
      // R"delim(...)delim"
      let delimEnd = i
      while (delimEnd < src.length && src.charCodeAt(delimEnd) !== 40 /* ( */) {
        delimEnd++
      }
      if (delimEnd >= src.length) return lex.bad('unterminated_string', sI, src.length)
      const delim = src.substring(i, delimEnd)
      const closer = ')' + delim + '"'
      const close = src.indexOf(closer, delimEnd + 1)
      if (close < 0) return lex.bad('unterminated_string', sI, src.length)
      const end = close + closer.length
      const text = src.substring(sI, end)
      return emit(lex, 'LIT_STRING', text, text, end - sI)
    }
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 10) return lex.bad('unterminated_string', sI, i)
      if (c === 92 /* \ */) { i += 2; continue }
      if (c === 34 /* " */) {
        i++
        const text = src.substring(sI, i)
        return emit(lex, 'LIT_STRING', text, text, i - sI)
      }
      i++
    }
    return lex.bad('unterminated_string', sI, src.length)
  }
}

// Punctuator dispatch --------------------------------------------------
// One matcher; tries longest-first against the punctuator catalog.

export function makePunctuatorMatcher() {
  // Pre-sort once, longest source first.
  const sorted = [...PUNCTUATORS].sort((a, b) => b[1].length - a[1].length)
  return function punctuator(lex: Lex, _rule: Rule): Token | undefined {
    const src = source(lex)
    const sI = lex.pnt.sI
    for (const [name, p] of sorted) {
      let ok = true
      for (let i = 0; i < p.length; i++) {
        if (src.charCodeAt(sI + i) !== p.charCodeAt(i)) { ok = false; break }
      }
      if (ok) {
        return emit(lex, name, p, p, p.length)
      }
    }
    return undefined
  }
}

// All matchers, ordered. Lower order = tried first.
// jsonic dispatches by ascending order; we want trivia and special-mode
// matchers to win against generic ones.
export function allMatchers(): Array<{ name: string; order: number; make: () => any }> {
  return [
    { name: 'c_line_cont',     order: 100, make: () => makeLineContMatcher() },
    { name: 'c_block_comment', order: 110, make: () => makeBlockCommentMatcher() },
    { name: 'c_line_comment',  order: 120, make: () => makeLineCommentMatcher() },
    { name: 'c_pp_newline',    order: 130, make: () => makePPNewlineMatcher() },
    { name: 'c_pp_open',       order: 140, make: () => makePPDirectiveOpenerMatcher() },
    { name: 'c_header_name',   order: 150, make: () => makeHeaderNameMatcher() },
    { name: 'c_whitespace',    order: 160, make: () => makeWhitespaceMatcher() },
    { name: 'c_string',        order: 200, make: () => makeStringLiteralMatcher() },
    { name: 'c_char',          order: 210, make: () => makeCharLiteralMatcher() },
    { name: 'c_float',         order: 220, make: () => makeFloatMatcher() },
    { name: 'c_int',           order: 230, make: () => makeIntegerMatcher() },
    { name: 'c_identifier',    order: 240, make: () => makeIdentifierMatcher() },
    { name: 'c_punctuator',    order: 900, make: () => makePunctuatorMatcher() },
  ]
}
