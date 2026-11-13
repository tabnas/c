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
//
// Each token is cut from the text the lexer holds: the whole source, or in
// a parse from a reader a window of it (`lex.window`, admin ADR-30), where
// `lex.src` is the window's text and `lex.pnt.sI` counts from the window's
// start (its row and column are the source's). A cut reads forward from
// the cursor to what ends its token, so one that stops inside the window
// gives what the whole text gives. One whose answer could change with
// more text, a scan that reaches the window's end, answers EDGE before it
// makes a token, moves the cursor or changes the lexer's mode; the matcher
// then asks the window for twice what it holds past the cursor
// (`lex.fill`) and cuts again over the grown text (`windowed`). Where the
// window does not grow, the source ends there, and the cut is made with
// the end of the window taken for the end of the source (`final`). A long
// token so costs its length to read, not its square. In a whole text every
// cut is final.

import type { Lex, Rule, Token } from '@tabnas/parser'
import {
  C23_KEYWORDS,
  EXT_KEYWORDS,
  PUNCTUATORS,
  keywordTokenName,
} from './tokens.js'
import type { CMeta, LexMode } from './symbols.js'

const RESERVED = new Set<string>([...C23_KEYWORDS, ...EXT_KEYWORDS])

// Helpers --------------------------------------------------------------

function getMeta(lex: Lex): CMeta {
  return (lex.ctx.meta as any).cmeta as CMeta
}

// The lexer's mode for a cut at the cursor. The engine cuts a token again
// over a grown window where a read met the window's end, so a cut at the
// place the mode last changed is a cut of that token again, and it reads
// the mode the first cut found: the change is made once, whatever the
// number of cuts.
function modeAt(lex: Lex): LexMode {
  const meta = getMeta(lex)
  const at = meta.modeAt
  if (undefined !== at && at.rI === lex.pnt.rI && at.cI === lex.pnt.cI) {
    Object.assign(meta.mode, at.before)
  }
  return meta.mode
}

// Change the lexer's mode at the cursor, keeping the mode as it was there.
function changeMode(lex: Lex, change: Partial<LexMode>): void {
  const meta = getMeta(lex)
  const before = { ...modeAt(lex) }
  meta.modeAt = { rI: lex.pnt.rI, cI: lex.pnt.cI, before }
  Object.assign(meta.mode, change)
}

// What a cut answers where its scan read to the end of the text the lexer
// holds while the source may have more: see the note above.
const EDGE: unique symbol = Symbol('c-edge')
type Cut = Token | undefined | typeof EDGE

// A matcher from a cut over the text the lexer holds, cut again over a
// grown window wherever it answers EDGE.
function windowed(
  cut: (lex: Lex, src: string, final: boolean) => Cut,
): (lex: Lex, rule: Rule) => Token | undefined {
  return function (lex: Lex, _rule: Rule): Token | undefined {
    let final = !lex.windowed
    for (;;) {
      const src = lex.src
      const tkn = cut(lex, src, final)
      if (EDGE !== tkn) return tkn
      const held = src.length - lex.pnt.sI
      lex.fill(Math.max(held + 1, 2 * held))
      if (lex.src.length <= src.length) final = true
    }
  }
}

// Whether fewer than `n` characters of `src` lie at and past `i` while
// the source may have more: a cut that needs them answers EDGE.
function short(src: string, i: number, n: number, final: boolean): boolean {
  return !final && src.length < i + n
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
  text: string,
  name: string,
  val: any,
  src: string,
  consumed: number,
): Token {
  const tkn = lex.token(name as any, val, src)
  advance(lex, text, consumed)
  return tkn
}

// Whitespace ------------------------------------------------------------
// C whitespace excludes newline when we are inside a preprocessor directive
// (newline terminates the directive). Outside directives newline is just
// space.

export function makeWhitespaceMatcher() {
  return windowed(function whitespace(lex, src, final) {
    const sI = lex.pnt.sI
    if (sI >= src.length) return final ? undefined : EDGE
    const c0 = src.charCodeAt(sI)
    // Quick reject: only spaces, tabs, vertical tab, form feed, CR, LF.
    if (c0 !== 32 && c0 !== 9 && c0 !== 11 && c0 !== 12 && c0 !== 13 && c0 !== 10) {
      return undefined
    }
    const mode = modeAt(lex)
    let i = sI
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 32 || c === 9 || c === 11 || c === 12 || c === 13) {
        i++
        continue
      }
      if (c === 10) {
        if (mode.inDirective) break // newline ends a directive
        i++
        continue
      }
      break
    }
    if (i === src.length && !final) return EDGE
    // An ignored token with our own name, so the trivia is preserved.
    const text = src.substring(sI, i)
    return emit(lex, src, '#SP', text, text, i - sI)
  })
}

// Line continuation (backslash + newline) ------------------------------
// In C this is logical-line splicing performed by the preprocessor before
// tokenisation. We treat it as trivia so it survives in the CST.

export function makeLineContMatcher() {
  return windowed(function lineCont(lex, src, final) {
    const sI = lex.pnt.sI
    if (short(src, sI, 1, final)) return EDGE
    if (src.charCodeAt(sI) !== 92 /* \ */) return undefined
    if (short(src, sI, 3, final)) return EDGE
    let consumed = 0
    if (src.charCodeAt(sI + 1) === 10) consumed = 2
    else if (src.charCodeAt(sI + 1) === 13 && src.charCodeAt(sI + 2) === 10) consumed = 3
    else if (src.charCodeAt(sI + 1) === 13) consumed = 2
    else return undefined
    const text = src.substring(sI, sI + consumed)
    return emit(lex, src, 'TRIVIA_LINE_CONT', text, text, consumed)
  })
}

// Line comment // ... ---------------------------------------------------

export function makeLineCommentMatcher() {
  return windowed(function lineComment(lex, src, final) {
    const sI = lex.pnt.sI
    if (short(src, sI, 2, final)) return EDGE
    if (src.charCodeAt(sI) !== 47 /* / */) return undefined
    if (src.charCodeAt(sI + 1) !== 47) return undefined
    let i = sI + 2
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 10 || c === 13) break
      i++
    }
    if (i === src.length && !final) return EDGE
    const text = src.substring(sI, i)
    return emit(lex, src, 'TRIVIA_LINE_COMMENT', text, text, i - sI)
  })
}

// Block comment /* ... */ ----------------------------------------------

export function makeBlockCommentMatcher() {
  return windowed(function blockComment(lex, src, final) {
    const sI = lex.pnt.sI
    if (short(src, sI, 2, final)) return EDGE
    if (src.charCodeAt(sI) !== 47 /* / */) return undefined
    if (src.charCodeAt(sI + 1) !== 42 /* * */) return undefined
    let i = sI + 2
    while (i < src.length - 1) {
      if (src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47) {
        i += 2
        const text = src.substring(sI, i)
        return emit(lex, src, 'TRIVIA_BLOCK_COMMENT', text, text, i - sI)
      }
      i++
    }
    if (!final) return EDGE
    return lex.bad('unterminated_comment', sI, src.length)
  })
}

// Preprocessor directive opener ----------------------------------------
// Emits PP_HASH only when '#' (or '%:') appears at the start of a logical
// line — i.e. preceded only by whitespace since the last unspliced newline.

// Whether only spaces and tabs stand between the start of a line and the
// cursor. The scan reads back through the text the lexer holds. A window
// keeps the space after the last token the parser does not ignore, so a
// scan that reaches the window's start has met that token's end: the
// cursor's column says whether a line began there (one the line's `\n`
// began), or else the directive newline that ended there did (a lone `\r`,
// which starts no column).
function atLineStart(lex: Lex, src: string, sI: number): boolean {
  let i = sI - 1
  while (i >= 0) {
    const c = src.charCodeAt(i)
    if (c === 10) return true
    if (c === 32 || c === 9) { i--; continue }
    if (c === 13) return true
    return false
  }
  if (!lex.windowed) return true
  const pnt = lex.pnt
  if (pnt.cI - 1 === sI) return true
  const end = modeAt(lex).ppNewlineEnd
  return null != end && end.rI === pnt.rI && end.cI === pnt.cI - sI
}

export function makePPDirectiveOpenerMatcher() {
  return windowed(function ppDirective(lex, src, final) {
    const sI = lex.pnt.sI
    if (short(src, sI, 2, final)) return EDGE
    const c0 = src.charCodeAt(sI)
    let consumed = 0
    if (c0 === 35 /* # */) {
      consumed = 1
    } else if (c0 === 37 /* % */ && src.charCodeAt(sI + 1) === 58 /* : */) {
      consumed = 2
    } else {
      return undefined
    }
    if (!atLineStart(lex, src, sI)) return undefined
    changeMode(lex, { inDirective: true, directiveName: null, expectHeaderName: false })
    const text = src.substring(sI, sI + consumed)
    return emit(lex, src, 'PP_HASH', text, text, consumed)
  })
}

// Directive newline terminator -----------------------------------------
// Emits PP_NEWLINE only when in directive mode; resets mode flags.

export function makePPNewlineMatcher() {
  return windowed(function ppNewline(lex, src, final) {
    if (!modeAt(lex).inDirective) return undefined
    const sI = lex.pnt.sI
    if (short(src, sI, 2, final)) return EDGE
    const c0 = src.charCodeAt(sI)
    if (c0 !== 10 && c0 !== 13) return undefined
    let consumed = 1
    if (c0 === 13 && src.charCodeAt(sI + 1) === 10) consumed = 2
    const text = src.substring(sI, sI + consumed)
    let rI = lex.pnt.rI
    let cI = lex.pnt.cI
    for (let i = 0; i < consumed; i++) {
      if (10 === text.charCodeAt(i)) { rI++; cI = 1 } else cI++
    }
    changeMode(lex, {
      inDirective: false, directiveName: null, expectHeaderName: false,
      ppNewlineEnd: { rI, cI },
    })
    return emit(lex, src, 'PP_NEWLINE', text, text, consumed)
  })
}

// Header name <foo.h> or "foo.h" — only valid inside #include / #embed --

export function makeHeaderNameMatcher() {
  return windowed(function headerName(lex, src, final) {
    const mode = modeAt(lex)
    if (!mode.inDirective || !mode.expectHeaderName) return undefined
    const sI = lex.pnt.sI
    if (short(src, sI, 1, final)) return EDGE
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
        changeMode(lex, { expectHeaderName: false })
        const text = src.substring(sI, i)
        return emit(lex, src, 'LIT_HEADER_NAME', text, text, i - sI)
      }
      i++
    }
    if (!final) return EDGE
    return lex.bad('unterminated_header_name', sI, src.length)
  })
}

// Identifier (and keyword/typedef-name/macro-name reclassification) ----

const ID_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/

export function makeIdentifierMatcher() {
  return windowed(function identifier(lex, src, final) {
    const sI = lex.pnt.sI
    if (short(src, sI, 1, final)) return EDGE
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
    if (sI + word.length === src.length && !final) return EDGE
    const meta = getMeta(lex)
    const mode = modeAt(lex)

    // Reserved word?
    if (RESERVED.has(word)) {
      const tname = keywordTokenName(word)!
      // If we are in a directive and this is the first identifier, record
      // the directive name and arm the header-name flag for include/embed.
      if (mode.inDirective && mode.directiveName === null) {
        changeMode(lex, { directiveName: word })
      }
      return emit(lex, src, tname, word, word, word.length)
    }

    // Inside a directive, the first identifier names the directive.
    if (mode.inDirective && mode.directiveName === null) {
      changeMode(lex, {
        directiveName: word,
        expectHeaderName:
          word === 'include' || word === 'embed' || word === 'include_next' ||
          mode.expectHeaderName,
      })
      // Common directives are not C reserved words; emit a normal ID and
      // let the directive grammar dispatch on the value.
      return emit(lex, src, 'ID', word, word, word.length)
    }

    // Typedef-name disambiguation. A name in scope as a typedef becomes
    // TYPEDEF_NAME; the parser uses this distinction to choose between
    // declaration and expression alts.
    //
    // Note: we do NOT emit TYPEDEF_NAME inside directive bodies — there the
    // name is just a token, semantics deferred.
    if (!mode.inDirective && meta.symbols.isTypedef(word)) {
      return emit(lex, src, 'TYPEDEF_NAME', word, word, word.length)
    }

    // Macro-name tagging: identifiers previously seen in a #define
    // surface as MACRO_NAME so call sites can be distinguished from
    // ordinary function calls. The grammar accepts MACRO_NAME wherever
    // it accepts ID.
    if (!mode.inDirective && meta.macros.has(word)) {
      return emit(lex, src, 'MACRO_NAME', word, word, word.length)
    }

    return emit(lex, src, 'ID', word, word, word.length)
  })
}

// A number's characters from sI, as a preprocessing number runs: a digit,
// or a `.` and a digit, then digits, letters, `_`, `.`, `'`, and a sign
// after an exponent's letter. A number's pattern matches within them and
// looks at most one character past its match, so a cut whose run reaches
// the window's end answers EDGE, and one whose run stops inside the window
// gives what the whole text gives.
function numberRunEnd(src: string, sI: number): number {
  let i = sI
  while (i < src.length) {
    const c = src.charCodeAt(i)
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 95 || c === 46 || c === 39) {
      i++
      continue
    }
    if ((c === 43 || c === 45) && i > sI) {
      const p = src.charCodeAt(i - 1)
      if (p === 101 || p === 69 || p === 112 || p === 80) { i++; continue }
    }
    break
  }
  return i
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
  return windowed(function integer(lex, src, final) {
    const sI = lex.pnt.sI
    if (short(src, sI, 1, final)) return EDGE
    const c0 = src.charCodeAt(sI)
    if (c0 < 48 || c0 > 57) return undefined
    if (numberRunEnd(src, sI) === src.length && !final) return EDGE
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
    return emit(lex, src, 'LIT_INT', text, text, text.length)
  })
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
  return windowed(function float(lex, src, final) {
    const sI = lex.pnt.sI
    if (short(src, sI, 2, final)) return EDGE
    const c0 = src.charCodeAt(sI)
    // Must start with digit or '.' followed by digit.
    const c1 = src.charCodeAt(sI + 1)
    const startsDigit = c0 >= 48 && c0 <= 57
    const startsDot = c0 === 46 && c1 >= 48 && c1 <= 57
    if (!startsDigit && !startsDot) return undefined
    if (numberRunEnd(src, sI) === src.length && !final) return EDGE
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
    return emit(lex, src, 'LIT_FLOAT', text, text, text.length)
  })
}

// Character literal ----------------------------------------------------

const CHAR_PREFIX_RE = /^(L|u8|u|U)?'/

export function makeCharLiteralMatcher() {
  return windowed(function charLit(lex, src, final) {
    const sI = lex.pnt.sI
    // The longest prefix and its quote: `u8'`.
    if (short(src, sI, 3, final)) return EDGE
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
        return emit(lex, src, 'LIT_CHAR', text, text, i - sI)
      }
      i++
    }
    if (!final) return EDGE
    return lex.bad('unterminated_char', sI, src.length)
  })
}

// String literal -------------------------------------------------------
// Encoding-prefixes: u8, u, U, L. Raw strings (R"...") are a C++ feature
// that some compilers extend to C; supported as an extension.

const STR_PREFIX_RE = /^(u8|u|U|L)?(R)?"/

export function makeStringLiteralMatcher() {
  return windowed(function stringLit(lex, src, final) {
    const sI = lex.pnt.sI
    // The longest prefix and its quote: `u8R"`.
    if (short(src, sI, 4, final)) return EDGE
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
      if (delimEnd >= src.length) {
        if (!final) return EDGE
        return lex.bad('unterminated_string', sI, src.length)
      }
      const delim = src.substring(i, delimEnd)
      const closer = ')' + delim + '"'
      const close = src.indexOf(closer, delimEnd + 1)
      if (close < 0) {
        if (!final) return EDGE
        return lex.bad('unterminated_string', sI, src.length)
      }
      const end = close + closer.length
      const text = src.substring(sI, end)
      return emit(lex, src, 'LIT_STRING', text, text, end - sI)
    }
    while (i < src.length) {
      const c = src.charCodeAt(i)
      if (c === 10) return lex.bad('unterminated_string', sI, i)
      if (c === 92 /* \ */) { i += 2; continue }
      if (c === 34 /* " */) {
        i++
        const text = src.substring(sI, i)
        return emit(lex, src, 'LIT_STRING', text, text, i - sI)
      }
      i++
    }
    if (!final) return EDGE
    return lex.bad('unterminated_string', sI, src.length)
  })
}

// Punctuator dispatch --------------------------------------------------
// One matcher; tries longest-first against the punctuator catalog.

export function makePunctuatorMatcher() {
  // Pre-sort once, longest source first.
  const sorted = [...PUNCTUATORS].sort((a, b) => b[1].length - a[1].length)
  const longest = sorted.length > 0 ? sorted[0][1].length : 0
  return windowed(function punctuator(lex, src, final) {
    const sI = lex.pnt.sI
    if (short(src, sI, longest, final)) return EDGE
    for (const [name, p] of sorted) {
      let ok = true
      for (let i = 0; i < p.length; i++) {
        if (src.charCodeAt(sI + i) !== p.charCodeAt(i)) { ok = false; break }
      }
      if (ok) {
        return emit(lex, src, name, p, p, p.length)
      }
    }
    return undefined
  })
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
