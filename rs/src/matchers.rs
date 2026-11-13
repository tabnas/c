/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! Focused lex matchers for the C parser. Each one does a single job
//! and returns either a token or `None`, meaning "not my prefix".
//!
//! Port of `ts/src/matchers.ts`. The canonical matchers are driven by
//! JavaScript regular expressions whose character classes are written
//! out in full (`[A-Za-z_$]`, `[0-9a-fA-F]`, and so on). They are hand
//! written scanners here rather than `regex` patterns, both because the
//! canonical ones index by character code and because `\d`, `\w`, `\s`
//! and `\b` in the `regex` crate are Unicode aware where JavaScript's
//! are not. Nothing in this file widens a class past ASCII.
//!
//! Each token is cut from the text the lexer holds: the whole source, or
//! in a parse from a reader a window of it (`lex.window`, admin ADR-30).
//! A scan reads the characters from the cursor ([`Look`], over
//! `Lexer::window`) as far as it needs, forward to what ends its token,
//! so one that stops inside the window gives what the whole text gives.
//! One whose answer could change with more text, a scan that reaches the
//! window's end, answers [`Cut::Edge`] before it makes a token, moves the
//! cursor or changes the lexer's mode; the matcher then asks the window
//! for twice what it holds past the cursor (`Lexer::fill`) and cuts again
//! over the grown text. Where the window does not grow, the source ends
//! there, and the cut is made with the end of the window taken for the end
//! of the source (`last`). A long token so costs its length to read, not
//! its square. In a whole text every cut is the last.

use std::collections::HashMap;
use std::sync::Arc;

use tabnas::{Context, ImperativeLexMatcher, Lexer, Rule, Tin, Token, Value};

use crate::state::{with_state, LexMode};
use crate::tokens::{is_reserved, keyword_token_name_unchecked};

/// Token identities the matchers emit, resolved once at install time.
#[derive(Debug, Clone, Default)]
pub struct Tins {
    map: HashMap<String, Tin>,
}

impl Tins {
    pub fn insert(&mut self, name: &str, tin: Tin) {
        self.map.insert(name.to_string(), tin);
    }

    pub fn get(&self, name: &str) -> Tin {
        self.map.get(name).copied().unwrap_or(-1)
    }
}

/// Emit a token of `name` covering `consumed` characters of the
/// remaining source, then advance the cursor. The canonical `emit`
/// builds the token before advancing so its position is the start of
/// the token; the captured `point` does the same here.
fn emit(lexer: &mut Lexer<'_>, tins: &Tins, name: &str, consumed: usize) -> Option<Token> {
    let text: String = lexer.remaining().chars().take(consumed).collect();
    if text.is_empty() {
        return None;
    }
    let point = lexer.point();
    let token = lexer.token(
        name,
        tins.get(name),
        Value::String(text.clone()),
        text.as_str(),
        point,
    );
    lexer.advance_chars(text.chars().count());
    Some(token)
}

/// A diagnostic token over `[from, to)` character offsets relative to
/// the cursor, as the canonical `lex.bad(code, sI, end)` produces.
fn bad(lexer: &Lexer<'_>, code: &str, from_chars: usize, to_chars: usize) -> Option<Token> {
    let base = lexer.point().site.pos;
    Some(lexer.bad_span(code, base + from_chars, base + to_chars))
}

/// The characters from the cursor to the end of the text the lexer holds,
/// decoded as far as a scan reads them, so that a cut costs what it reads
/// and not what is left of the source.
pub(crate) struct Look<'a> {
    chars: std::str::Chars<'a>,
    read: Vec<char>,
}

impl<'a> Look<'a> {
    fn new(text: &'a str) -> Self {
        Look {
            chars: text.chars(),
            read: Vec::new(),
        }
    }

    /// The character at `index`, or `None` past the text.
    fn get(&mut self, index: usize) -> Option<char> {
        while self.read.len() <= index {
            self.read.push(self.chars.next()?);
        }
        Some(self.read[index])
    }

    /// The character at `index`, or `'\0'` past the text.
    fn at(&mut self, index: usize) -> char {
        self.get(index).unwrap_or('\0')
    }

    /// The characters from `from` up to `to`, or to the end of the text.
    fn slice(&mut self, from: usize, to: usize) -> &[char] {
        let _ = self.get(to.saturating_sub(1));
        let end = to.min(self.read.len());
        &self.read[from.min(end)..end]
    }

    /// How many characters the text holds: all of them, decoded.
    fn count(&mut self) -> usize {
        self.read.extend(self.chars.by_ref());
        self.read.len()
    }
}

/// What a scan answers.
pub(crate) enum Cut {
    /// Not this matcher's token.
    No,
    /// The scan read to the end of a window that may grow: cut again over
    /// more text.
    Edge,
    /// A token named so, of so many characters, and the lexer mode after
    /// it where it changes the mode.
    Hit(String, usize, Option<LexMode>),
    /// A refusal with its code, over `[from, to)` characters from the
    /// cursor.
    Bad(&'static str, usize, usize),
}

/// What a scan reads beside the characters at the cursor.
pub(crate) struct Scope<'a> {
    /// Whether the end of the text the lexer holds is the source's.
    last: bool,
    /// The lexer mode the cut is made in.
    mode: &'a LexMode,
    /// The text the lexer holds before the cursor, and whether it is a
    /// window of a source read from a reader.
    before: &'a str,
    windowed: bool,
    /// The cursor's position in the source, in characters, and its column.
    pos: usize,
    ci: usize,
}

impl Scope<'_> {
    /// Whether fewer than `n` characters lie at and past `index` while the
    /// source may have more: a scan that needs them answers `Cut::Edge`.
    fn short(&self, look: &mut Look<'_>, index: usize, n: usize) -> bool {
        !self.last && n > 0 && look.get(index + n - 1).is_none()
    }
}

fn hit(name: &str, consumed: usize) -> Cut {
    Cut::Hit(name.to_string(), consumed, None)
}

/// The lexer mode for a cut at the cursor. The engine cuts a token again
/// over a grown window where a read met the window's end, so a cut at the
/// place the mode last changed is a cut of that token again, and it reads
/// the mode the first cut found: the change is made once, whatever the
/// number of cuts.
fn mode_for(pos: usize) -> LexMode {
    with_state(|state| {
        if let Some((at, before)) = &state.mode_at {
            if *at == pos {
                state.mode = before.clone();
            }
        }
        state.mode.clone()
    })
}

/// Run `scan` at the cursor over the text the lexer holds, cutting again
/// over a grown window wherever it answers `Cut::Edge`, and make what it
/// answers: a token (setting the mode it leaves), a refusal, or nothing.
fn cut(
    lexer: &mut Lexer<'_>,
    tins: &Tins,
    scan: &dyn Fn(&mut Look<'_>, &Scope<'_>) -> Cut,
) -> Option<Token> {
    let point = lexer.point();
    let pos = point.site.pos;
    let mode = mode_for(pos);
    let windowed = lexer.windowed();
    let mut last = !windowed;
    loop {
        let (answer, held) = {
            let source = lexer.source();
            let window = lexer.window();
            let before = &source[..source.len() - window.len()];
            let scope = Scope {
                last,
                mode: &mode,
                before,
                windowed,
                pos,
                ci: point.site.ci,
            };
            let mut look = Look::new(window);
            let answer = scan(&mut look, &scope);
            (answer, window.len())
        };
        match answer {
            Cut::Edge => {
                let chars = lexer.window().chars().count();
                lexer.fill((chars + 1).max(2 * chars));
                if lexer.window().len() <= held {
                    last = true;
                }
            }
            Cut::No => return None,
            Cut::Bad(code, from, to) => return bad(lexer, code, from, to),
            Cut::Hit(name, consumed, after) => {
                if let Some(after) = after {
                    with_state(|state| {
                        state.mode_at = Some((pos, state.mode.clone()));
                        state.mode = after;
                    });
                }
                return emit(lexer, tins, &name, consumed);
            }
        }
    }
}

// ---------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------

/// C whitespace, minus the newline that terminates a preprocessor
/// directive.
fn whitespace(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    let Some(first) = look.get(0) else {
        return if scope.last { Cut::No } else { Cut::Edge };
    };
    if !matches!(first, ' ' | '\t' | '\u{0b}' | '\u{0c}' | '\r' | '\n') {
        return Cut::No;
    }
    let mut index = 0;
    loop {
        match look.get(index) {
            Some(' ' | '\t' | '\u{0b}' | '\u{0c}' | '\r') => index += 1,
            Some('\n') => {
                if scope.mode.in_directive {
                    break;
                }
                index += 1;
            }
            Some(_) => break,
            None => {
                if !scope.last {
                    return Cut::Edge;
                }
                break;
            }
        }
    }
    if index == 0 {
        return Cut::No;
    }
    hit("#SP", index)
}

// ---------------------------------------------------------------------
// Line continuation
// ---------------------------------------------------------------------

fn line_cont(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if scope.short(look, 0, 1) {
        return Cut::Edge;
    }
    if look.at(0) != '\\' {
        return Cut::No;
    }
    if scope.short(look, 0, 3) {
        return Cut::Edge;
    }
    let consumed = if look.at(1) == '\n' {
        2
    } else if look.at(1) == '\r' && look.at(2) == '\n' {
        3
    } else if look.at(1) == '\r' {
        2
    } else {
        return Cut::No;
    };
    hit("TRIVIA_LINE_CONT", consumed)
}

// ---------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------

fn line_comment(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if scope.short(look, 0, 2) {
        return Cut::Edge;
    }
    if look.at(0) != '/' || look.at(1) != '/' {
        return Cut::No;
    }
    let mut index = 2;
    loop {
        match look.get(index) {
            Some('\n' | '\r') => break,
            Some(_) => index += 1,
            None => {
                if !scope.last {
                    return Cut::Edge;
                }
                break;
            }
        }
    }
    hit("TRIVIA_LINE_COMMENT", index)
}

fn block_comment(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if scope.short(look, 0, 2) {
        return Cut::Edge;
    }
    if look.at(0) != '/' || look.at(1) != '*' {
        return Cut::No;
    }
    let mut index = 2;
    while look.get(index + 1).is_some() {
        if look.at(index) == '*' && look.at(index + 1) == '/' {
            return hit("TRIVIA_BLOCK_COMMENT", index + 2);
        }
        index += 1;
    }
    if !scope.last {
        return Cut::Edge;
    }
    // The canonical matcher reports the span from the opener to the end
    // of the WHOLE source.
    Cut::Bad("unterminated_comment", 0, look.count())
}

// ---------------------------------------------------------------------
// Preprocessor boundaries
// ---------------------------------------------------------------------

/// True when only spaces and tabs separate the cursor from the start of a
/// logical line. The scan reads back through the text the lexer holds. A
/// window keeps the space after the last token the parser does not
/// ignore, so a scan that reaches the window's start has met that token's
/// end: the source's start, the cursor's column (a line the line's `\n`
/// began), or else the directive newline that ended there (a lone `\r`,
/// which starts no column) say whether a line began there.
fn at_line_start(scope: &Scope<'_>) -> bool {
    let mut spaces = 0;
    for character in scope.before.chars().rev() {
        match character {
            '\n' | '\r' => return true,
            ' ' | '\t' => spaces += 1,
            _ => return false,
        }
    }
    if !scope.windowed || scope.ci == spaces + 1 {
        return true;
    }
    let low = scope.pos - spaces;
    low == 0 || scope.mode.pp_newline_end == Some(low)
}

fn pp_directive_open(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if scope.short(look, 0, 2) {
        return Cut::Edge;
    }
    let consumed = if look.at(0) == '#' {
        1
    } else if look.at(0) == '%' && look.at(1) == ':' {
        2
    } else {
        return Cut::No;
    };
    if !at_line_start(scope) {
        return Cut::No;
    }
    let mut mode = scope.mode.clone();
    mode.in_directive = true;
    mode.directive_name = None;
    mode.expect_header_name = false;
    Cut::Hit("PP_HASH".to_string(), consumed, Some(mode))
}

fn pp_newline(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if !scope.mode.in_directive {
        return Cut::No;
    }
    if scope.short(look, 0, 2) {
        return Cut::Edge;
    }
    let first = look.at(0);
    if first != '\n' && first != '\r' {
        return Cut::No;
    }
    let consumed = if first == '\r' && look.at(1) == '\n' {
        2
    } else {
        1
    };
    let mut mode = scope.mode.clone();
    mode.in_directive = false;
    mode.directive_name = None;
    mode.expect_header_name = false;
    mode.pp_newline_end = Some(scope.pos + consumed);
    Cut::Hit("PP_NEWLINE".to_string(), consumed, Some(mode))
}

fn header_name(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if !(scope.mode.in_directive && scope.mode.expect_header_name) {
        return Cut::No;
    }
    if scope.short(look, 0, 1) {
        return Cut::Edge;
    }
    let close = match look.at(0) {
        '<' => '>',
        '"' => '"',
        _ => return Cut::No,
    };
    let mut index = 1;
    while let Some(character) = look.get(index) {
        if character == '\n' {
            return Cut::Bad("unterminated_header_name", 0, index);
        }
        if character == close {
            let mut mode = scope.mode.clone();
            mode.expect_header_name = false;
            return Cut::Hit("LIT_HEADER_NAME".to_string(), index + 1, Some(mode));
        }
        index += 1;
    }
    if !scope.last {
        return Cut::Edge;
    }
    Cut::Bad("unterminated_header_name", 0, index)
}

// ---------------------------------------------------------------------
// Identifiers, keywords, typedef names and macro names
// ---------------------------------------------------------------------

fn is_id_start(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_' || character == '$'
}

fn is_id_part(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '$'
}

fn identifier(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if scope.short(look, 0, 1) {
        return Cut::Edge;
    }
    if !is_id_start(look.at(0)) {
        return Cut::No;
    }
    let mut index = 1;
    loop {
        match look.get(index) {
            Some(character) if is_id_part(character) => index += 1,
            Some(_) => break,
            None => {
                if !scope.last {
                    return Cut::Edge;
                }
                break;
            }
        }
    }
    let word: String = look.slice(0, index).iter().collect();
    let mode = scope.mode;

    if is_reserved(&word) {
        let name = keyword_token_name_unchecked(&word);
        if mode.in_directive && mode.directive_name.is_none() {
            let mut after = mode.clone();
            after.directive_name = Some(word);
            return Cut::Hit(name, index, Some(after));
        }
        return Cut::Hit(name, index, None);
    }

    if mode.in_directive && mode.directive_name.is_none() {
        let mut after = mode.clone();
        if word == "include" || word == "embed" || word == "include_next" {
            after.expect_header_name = true;
        }
        after.directive_name = Some(word);
        return Cut::Hit("ID".to_string(), index, Some(after));
    }

    let name = with_state(|state| {
        if !mode.in_directive && state.symbols.is_typedef(&word) {
            "TYPEDEF_NAME"
        } else if !mode.in_directive && state.macros.has(&word) {
            "MACRO_NAME"
        } else {
            "ID"
        }
    });
    hit(name, index)
}

// ---------------------------------------------------------------------
// Numeric literals
// ---------------------------------------------------------------------

/// The characters of a number from the cursor, as a preprocessing number
/// runs: a digit, or a `.` and a digit, then digits, letters, `_`, `.`,
/// `'`, and a sign after an exponent's letter; `None` where the run
/// reaches the end of the text. A number's pattern matches within them and
/// looks at most one character past its match.
fn number_run(look: &mut Look<'_>) -> Option<usize> {
    let mut index = 0;
    loop {
        let character = look.get(index)?;
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '\'') {
            index += 1;
            continue;
        }
        if matches!(character, '+' | '-')
            && index > 0
            && matches!(look.at(index - 1), 'e' | 'E' | 'p' | 'P')
        {
            index += 1;
            continue;
        }
        return Some(index);
    }
}

/// The characters a number's scan reads: its run and the character after
/// it, or an edge where the run reaches the end of a window that may grow.
fn number_text<'l>(look: &'l mut Look<'_>, scope: &Scope<'_>) -> Result<&'l [char], Cut> {
    let run = match number_run(look) {
        Some(run) => run,
        None if scope.last => look.count(),
        None => return Err(Cut::Edge),
    };
    Ok(look.slice(0, run + 1))
}

/// Digits of a run that may carry C23 `'` separators: one leading digit
/// accepted by `first`, then any number of `'` or digits accepted by
/// `rest`. Returns the number of characters consumed, or zero.
fn digit_run(text: &[char], from: usize, accept: impl Fn(char) -> bool + Copy) -> usize {
    if from >= text.len() || !accept(text[from]) {
        return 0;
    }
    let mut index = from + 1;
    while index < text.len() && (text[index] == '\'' || accept(text[index])) {
        index += 1;
    }
    index - from
}

fn is_octal(character: char) -> bool {
    ('0'..='7').contains(&character)
}

fn is_binary(character: char) -> bool {
    character == '0' || character == '1'
}

/// The integer-literal scanner, spelling out `INT_RE`. Returns the
/// length of the numeric part and the length of the whole match
/// (numeric part plus suffix).
fn scan_integer(text: &[char]) -> Option<(usize, usize)> {
    let number = if at(text, 0) == '0' && matches!(at(text, 1), 'x' | 'X') {
        let run = digit_run(text, 2, |character| character.is_ascii_hexdigit());
        if run == 0 {
            0
        } else {
            2 + run
        }
    } else {
        0
    };
    let number = if number > 0 {
        number
    } else if at(text, 0) == '0' && matches!(at(text, 1), 'b' | 'B') {
        let run = digit_run(text, 2, is_binary);
        if run == 0 {
            0
        } else {
            2 + run
        }
    } else {
        0
    };
    let number = if number > 0 {
        number
    } else if at(text, 0) == '0' {
        // Octal, which also matches a lone `0`.
        let mut index = 1;
        while index < text.len() && (text[index] == '\'' || is_octal(text[index])) {
            index += 1;
        }
        index
    } else if ('1'..='9').contains(&at(text, 0)) {
        digit_run(text, 0, |character| character.is_ascii_digit())
    } else {
        0
    };
    if number == 0 {
        return None;
    }
    // `([uUlL]*[wWbBzZ]*[uUlL]*)?`, greedy and without backtracking:
    // the three classes are disjoint.
    let mut index = number;
    while index < text.len() && matches!(text[index], 'u' | 'U' | 'l' | 'L') {
        index += 1;
    }
    while index < text.len() && matches!(text[index], 'w' | 'W' | 'b' | 'B' | 'z' | 'Z') {
        index += 1;
    }
    while index < text.len() && matches!(text[index], 'u' | 'U' | 'l' | 'L') {
        index += 1;
    }
    Some((number, index))
}

fn integer(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if scope.short(look, 0, 1) {
        return Cut::Edge;
    }
    if !look.at(0).is_ascii_digit() {
        return Cut::No;
    }
    let text = match number_text(look, scope) {
        Ok(text) => text,
        Err(edge) => return edge,
    };
    let Some((_, whole)) = scan_integer(text) else {
        return Cut::No;
    };
    let hex = at(text, 0) == '0' && matches!(at(text, 1), 'x' | 'X');
    let after = at(text, whole);
    if after == '.' || after == 'e' || after == 'E' {
        // For a hex literal only `p`/`P` introduces an exponent, so a
        // trailing `e` stays part of the integer.
        if !hex {
            return Cut::No;
        }
    }
    if hex && (after == '.' || after == 'p' || after == 'P') {
        return Cut::No;
    }
    hit("LIT_INT", whole)
}

/// `FLOAT_HEX_RE`.
fn scan_float_hex(text: &[char]) -> Option<usize> {
    if at(text, 0) != '0' || !matches!(at(text, 1), 'x' | 'X') {
        return None;
    }
    let hexit = |character: char| character.is_ascii_hexdigit();
    let mantissa = {
        let run = digit_run(text, 2, hexit);
        if run > 0 && at(text, 2 + run) == '.' {
            // `hex+ . hex*`
            let fraction = digit_run(text, 2 + run + 1, hexit);
            Some(2 + run + 1 + fraction)
        } else if at(text, 2) == '.' {
            // `. hex+`
            let fraction = digit_run(text, 3, hexit);
            if fraction == 0 {
                None
            } else {
                Some(3 + fraction)
            }
        } else if run > 0 {
            // `hex+`
            Some(2 + run)
        } else {
            None
        }
    }?;
    let mut index = mantissa;
    if !matches!(at(text, index), 'p' | 'P') {
        return None;
    }
    index += 1;
    if matches!(at(text, index), '+' | '-') {
        index += 1;
    }
    let exponent = digit_run(text, index, |character| character.is_ascii_digit());
    if exponent == 0 {
        return None;
    }
    index += exponent;
    if matches!(at(text, index), 'f' | 'F' | 'l' | 'L') {
        index += 1;
    }
    Some(index)
}

/// The optional decimal exponent `(?:[eE][+-]?[0-9](['0-9])*)?`.
/// Returns the characters consumed, which is zero when absent.
fn decimal_exponent(text: &[char], from: usize) -> usize {
    if !matches!(at(text, from), 'e' | 'E') {
        return 0;
    }
    let mut index = from + 1;
    if matches!(at(text, index), '+' | '-') {
        index += 1;
    }
    let digits = digit_run(text, index, |character| character.is_ascii_digit());
    if digits == 0 {
        return 0;
    }
    index + digits - from
}

/// `FLOAT_DEC_RE`, alternative by alternative in the order the pattern
/// declares them.
fn scan_float_dec(text: &[char]) -> Option<usize> {
    let digit = |character: char| character.is_ascii_digit();
    let lead = digit_run(text, 0, digit);

    // `(?:[0-9](['0-9])*)?\.[0-9](['0-9])*(?:exp)?`
    for start in [lead, 0] {
        if start > 0 && lead == 0 {
            continue;
        }
        if at(text, start) == '.' {
            let fraction = digit_run(text, start + 1, digit);
            if fraction > 0 {
                let mut index = start + 1 + fraction;
                index += decimal_exponent(text, index);
                return Some(index + float_suffix(text, index));
            }
        }
        if start == 0 {
            break;
        }
    }

    // `[0-9](['0-9])*\.(?:exp)?`
    if lead > 0 && at(text, lead) == '.' {
        let mut index = lead + 1;
        index += decimal_exponent(text, index);
        return Some(index + float_suffix(text, index));
    }

    // `[0-9](['0-9])*[eE][+-]?[0-9](['0-9])*`
    if lead > 0 {
        let exponent = decimal_exponent(text, lead);
        if exponent > 0 {
            let index = lead + exponent;
            return Some(index + float_suffix(text, index));
        }
    }

    None
}

/// `[fFlLdD]?[fFlL]?`.
fn float_suffix(text: &[char], from: usize) -> usize {
    let mut index = from;
    if matches!(at(text, index), 'f' | 'F' | 'l' | 'L' | 'd' | 'D') {
        index += 1;
    }
    if matches!(at(text, index), 'f' | 'F' | 'l' | 'L') {
        index += 1;
    }
    index - from
}

fn float(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    if scope.short(look, 0, 2) {
        return Cut::Edge;
    }
    let first = look.at(0);
    let starts_digit = first.is_ascii_digit();
    let starts_dot = first == '.' && look.at(1).is_ascii_digit();
    if !starts_digit && !starts_dot {
        return Cut::No;
    }
    let text = match number_text(look, scope) {
        Ok(text) => text,
        Err(edge) => return edge,
    };
    let Some(length) = scan_float_hex(text).or_else(|| scan_float_dec(text)) else {
        return Cut::No;
    };
    let matched = &text[..length];
    let hex = matched.len() >= 2 && matched[0] == '0' && matches!(matched[1], 'x' | 'X');
    let has_float_mark = matched.iter().any(|character| {
        matches!(
            character,
            '.' | 'e' | 'E' | 'p' | 'P' | 'f' | 'F' | 'l' | 'L'
        )
    });
    if !has_float_mark && !hex {
        return Cut::No;
    }
    hit("LIT_FLOAT", length)
}

// ---------------------------------------------------------------------
// Character and string literals
// ---------------------------------------------------------------------

/// The character at `index` of `text`, or `'\0'` past it.
fn at(text: &[char], index: usize) -> char {
    text.get(index).copied().unwrap_or('\0')
}

/// `^(L|u8|u|U)?'`, returning the prefix length.
fn char_prefix(text: &[char]) -> Option<usize> {
    for prefix in [&['L'][..], &['u', '8'][..], &['u'][..], &['U'][..], &[][..]] {
        if text.len() > prefix.len()
            && text[..prefix.len()] == *prefix
            && text[prefix.len()] == '\''
        {
            return Some(prefix.len() + 1);
        }
    }
    None
}

fn char_literal(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    // The longest prefix and its quote: `u8'`.
    if scope.short(look, 0, 3) {
        return Cut::Edge;
    }
    let Some(mut index) = char_prefix(look.slice(0, 3)) else {
        return Cut::No;
    };
    while let Some(character) = look.get(index) {
        if character == '\n' {
            return Cut::Bad("unterminated_char", 0, index);
        }
        if character == '\\' {
            index += 2;
            continue;
        }
        if character == '\'' {
            return hit("LIT_CHAR", index + 1);
        }
        index += 1;
    }
    if !scope.last {
        return Cut::Edge;
    }
    Cut::Bad("unterminated_char", 0, look.count())
}

/// `^(u8|u|U|L)?(R)?"`, returning the prefix length and whether the
/// literal is a raw one.
fn string_prefix(text: &[char]) -> Option<(usize, bool)> {
    for encoding in [&['u', '8'][..], &['u'][..], &['U'][..], &['L'][..], &[][..]] {
        if text.len() < encoding.len() || text[..encoding.len()] != *encoding {
            continue;
        }
        let mut index = encoding.len();
        let raw = at(text, index) == 'R';
        if raw {
            index += 1;
        }
        if at(text, index) == '"' {
            return Some((index + 1, raw));
        }
    }
    None
}

fn string_literal(look: &mut Look<'_>, scope: &Scope<'_>) -> Cut {
    // The longest prefix and its quote: `u8R"`.
    if scope.short(look, 0, 4) {
        return Cut::Edge;
    }
    let Some((prefix, raw)) = string_prefix(look.slice(0, 4)) else {
        return Cut::No;
    };
    let mut index = prefix;
    if raw {
        // `R"delim( ... )delim"`
        let mut delimiter_end = index;
        while look
            .get(delimiter_end)
            .is_some_and(|character| character != '(')
        {
            delimiter_end += 1;
        }
        if look.get(delimiter_end).is_none() {
            if !scope.last {
                return Cut::Edge;
            }
            return Cut::Bad("unterminated_string", 0, look.count());
        }
        let delimiter: String = look.slice(index, delimiter_end).iter().collect();
        let closer: Vec<char> = format!("){delimiter}\"").chars().collect();
        let mut scan = delimiter_end + 1;
        loop {
            if look.get(scan + closer.len() - 1).is_none() {
                if !scope.last {
                    return Cut::Edge;
                }
                return Cut::Bad("unterminated_string", 0, look.count());
            }
            if look.slice(scan, scan + closer.len()) == &closer[..] {
                return hit("LIT_STRING", scan + closer.len());
            }
            scan += 1;
        }
    }
    while let Some(character) = look.get(index) {
        if character == '\n' {
            return Cut::Bad("unterminated_string", 0, index);
        }
        if character == '\\' {
            index += 2;
            continue;
        }
        if character == '"' {
            return hit("LIT_STRING", index + 1);
        }
        index += 1;
    }
    if !scope.last {
        return Cut::Edge;
    }
    Cut::Bad("unterminated_string", 0, look.count())
}

// ---------------------------------------------------------------------
// Punctuators
// ---------------------------------------------------------------------

/// The punctuator catalog, longest source first, so the dispatcher
/// matches the longest form.
fn sorted_punctuators() -> Vec<(&'static str, &'static str)> {
    let mut sorted: Vec<(&str, &str)> = crate::tokens::PUNCTUATORS.to_vec();
    // A stable sort by descending source length, as the canonical
    // `[...PUNCTUATORS].sort((a, b) => b[1].length - a[1].length)` is.
    sorted.sort_by_key(|entry| std::cmp::Reverse(entry.1.len()));
    sorted
}

fn punctuator(
    look: &mut Look<'_>,
    scope: &Scope<'_>,
    sorted: &[(&'static str, &'static str)],
) -> Cut {
    let longest = sorted.first().map_or(0, |entry| entry.1.chars().count());
    if scope.short(look, 0, longest) {
        return Cut::Edge;
    }
    let ahead: String = look.slice(0, longest).iter().collect();
    for (name, source) in sorted {
        if ahead.starts_with(source) {
            return hit(name, source.chars().count());
        }
    }
    Cut::No
}

// ---------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------

/// Name and order of every matcher, in the canonical declaration order.
/// Lower order runs first.
pub const MATCHER_ORDER: &[(&str, f64)] = &[
    ("c_line_cont", 100.0),
    ("c_block_comment", 110.0),
    ("c_line_comment", 120.0),
    ("c_pp_newline", 130.0),
    ("c_pp_open", 140.0),
    ("c_header_name", 150.0),
    ("c_whitespace", 160.0),
    ("c_string", 200.0),
    ("c_char", 210.0),
    ("c_float", 220.0),
    ("c_int", 230.0),
    ("c_identifier", 240.0),
    ("c_punctuator", 900.0),
];

/// Build the matcher named `name`.
pub fn make(name: &str, tins: Tins) -> ImperativeLexMatcher {
    match name {
        "c_line_cont" => wrap(tins, line_cont),
        "c_block_comment" => wrap(tins, block_comment),
        "c_line_comment" => wrap(tins, line_comment),
        "c_pp_newline" => wrap(tins, pp_newline),
        "c_pp_open" => wrap(tins, pp_directive_open),
        "c_header_name" => wrap(tins, header_name),
        "c_whitespace" => wrap(tins, whitespace),
        "c_string" => wrap(tins, string_literal),
        "c_char" => wrap(tins, char_literal),
        "c_float" => wrap(tins, float),
        "c_int" => wrap(tins, integer),
        "c_identifier" => wrap(tins, identifier),
        "c_punctuator" => {
            let sorted = sorted_punctuators();
            wrap(tins, move |look, scope| punctuator(look, scope, &sorted))
        }
        _ => wrap(tins, |_look, _scope| Cut::No),
    }
}

fn wrap(
    tins: Tins,
    scan: impl Fn(&mut Look<'_>, &Scope<'_>) -> Cut + Send + Sync + 'static,
) -> ImperativeLexMatcher {
    Arc::new(
        move |lexer: &mut Lexer<'_>, _rule: &mut Rule, _context: &mut Context| {
            cut(lexer, &tins, &scan)
        },
    )
}
