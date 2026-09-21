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

use std::collections::HashMap;
use std::sync::Arc;

use tabnas::{Context, ImperativeLexMatcher, Lexer, Rule, Tin, Token, Value};

use crate::state::with_state;
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

/// The remaining source as characters, so the scanners can index it the
/// way the canonical matchers index the source with `charCodeAt`.
///
/// The characters are the WHOLE source, built once per parse and shared
/// (see `CState::source_chars`); this is a handle onto the tail of it,
/// so taking one costs a reference count rather than a copy of
/// everything left to read.
struct Tail {
    all: std::rc::Rc<Vec<char>>,
    from: usize,
}

impl std::ops::Deref for Tail {
    type Target = [char];

    fn deref(&self) -> &[char] {
        self.all.get(self.from..).unwrap_or(&[])
    }
}

fn chars(lexer: &Lexer<'_>) -> Tail {
    let source = lexer.source();
    let key = (source.as_ptr() as usize, source.len());
    let all = with_state(|state| {
        if let Some((address, length, cached)) = &state.source_chars {
            if (*address, *length) == key {
                return std::rc::Rc::clone(cached);
            }
        }
        let built = std::rc::Rc::new(source.chars().collect::<Vec<char>>());
        state.source_chars = Some((key.0, key.1, std::rc::Rc::clone(&built)));
        built
    });
    Tail {
        all,
        // `Site::pos` is the cursor's position in Unicode scalar values,
        // which is what indexes the vector; `Site::si` is its byte
        // position, which does not.
        from: lexer.point().site.pos,
    }
}

fn at(text: &[char], index: usize) -> char {
    text.get(index).copied().unwrap_or('\0')
}

// ---------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------

/// C whitespace, minus the newline that terminates a preprocessor
/// directive.
fn whitespace(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    let first = at(&text, 0);
    if text.is_empty() || !matches!(first, ' ' | '\t' | '\u{0b}' | '\u{0c}' | '\r' | '\n') {
        return None;
    }
    let in_directive = with_state(|state| state.mode.in_directive);
    let mut index = 0;
    while index < text.len() {
        match text[index] {
            ' ' | '\t' | '\u{0b}' | '\u{0c}' | '\r' => index += 1,
            '\n' => {
                if in_directive {
                    break;
                }
                index += 1;
            }
            _ => break,
        }
    }
    if index == 0 {
        return None;
    }
    emit(lexer, tins, "#SP", index)
}

// ---------------------------------------------------------------------
// Line continuation
// ---------------------------------------------------------------------

fn line_cont(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    if at(&text, 0) != '\\' {
        return None;
    }
    let consumed = if at(&text, 1) == '\n' {
        2
    } else if at(&text, 1) == '\r' && at(&text, 2) == '\n' {
        3
    } else if at(&text, 1) == '\r' {
        2
    } else {
        return None;
    };
    emit(lexer, tins, "TRIVIA_LINE_CONT", consumed)
}

// ---------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------

fn line_comment(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    if at(&text, 0) != '/' || at(&text, 1) != '/' {
        return None;
    }
    let mut index = 2;
    while index < text.len() && !matches!(text[index], '\n' | '\r') {
        index += 1;
    }
    emit(lexer, tins, "TRIVIA_LINE_COMMENT", index)
}

fn block_comment(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    if at(&text, 0) != '/' || at(&text, 1) != '*' {
        return None;
    }
    let mut index = 2;
    while index + 1 < text.len() {
        if text[index] == '*' && text[index + 1] == '/' {
            return emit(lexer, tins, "TRIVIA_BLOCK_COMMENT", index + 2);
        }
        index += 1;
    }
    // The canonical matcher reports the span from the opener to the end
    // of the WHOLE source, so the end offset is absolute there.
    let end = lexer.source().chars().count();
    let base = lexer.point().site.pos;
    Some(lexer.bad_span("unterminated_comment", base, end))
}

// ---------------------------------------------------------------------
// Preprocessor boundaries
// ---------------------------------------------------------------------

/// True when only whitespace separates this offset from the start of a
/// logical line.
fn at_line_start(before: &str) -> bool {
    for character in before.chars().rev() {
        match character {
            '\n' | '\r' => return true,
            ' ' | '\t' => continue,
            _ => return false,
        }
    }
    true
}

fn pp_directive_open(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    let consumed = if at(&text, 0) == '#' {
        1
    } else if at(&text, 0) == '%' && at(&text, 1) == ':' {
        2
    } else {
        return None;
    };
    let position = lexer.point().site.si;
    if !at_line_start(&lexer.source()[..position]) {
        return None;
    }
    with_state(|state| {
        state.mode.in_directive = true;
        state.mode.directive_name = None;
        state.mode.expect_header_name = false;
    });
    emit(lexer, tins, "PP_HASH", consumed)
}

fn pp_newline(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    if !with_state(|state| state.mode.in_directive) {
        return None;
    }
    let text = chars(lexer);
    let first = at(&text, 0);
    if first != '\n' && first != '\r' {
        return None;
    }
    let consumed = if first == '\r' && at(&text, 1) == '\n' {
        2
    } else {
        1
    };
    with_state(|state| {
        state.mode.in_directive = false;
        state.mode.directive_name = None;
        state.mode.expect_header_name = false;
    });
    emit(lexer, tins, "PP_NEWLINE", consumed)
}

fn header_name(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let armed = with_state(|state| state.mode.in_directive && state.mode.expect_header_name);
    if !armed {
        return None;
    }
    let text = chars(lexer);
    let close = match at(&text, 0) {
        '<' => '>',
        '"' => '"',
        _ => return None,
    };
    let mut index = 1;
    while index < text.len() {
        let character = text[index];
        if character == '\n' {
            return bad(lexer, "unterminated_header_name", 0, index);
        }
        if character == close {
            index += 1;
            with_state(|state| state.mode.expect_header_name = false);
            return emit(lexer, tins, "LIT_HEADER_NAME", index);
        }
        index += 1;
    }
    bad(lexer, "unterminated_header_name", 0, text.len())
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

fn identifier(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    if text.is_empty() || !is_id_start(text[0]) {
        return None;
    }
    let mut index = 1;
    while index < text.len() && is_id_part(text[index]) {
        index += 1;
    }
    let word: String = text[..index].iter().collect();

    if is_reserved(&word) {
        let name = keyword_token_name_unchecked(&word);
        with_state(|state| {
            if state.mode.in_directive && state.mode.directive_name.is_none() {
                state.mode.directive_name = Some(word.clone());
            }
        });
        return emit(lexer, tins, &name, index);
    }

    let names_directive = with_state(|state| {
        if state.mode.in_directive && state.mode.directive_name.is_none() {
            state.mode.directive_name = Some(word.clone());
            if word == "include" || word == "embed" || word == "include_next" {
                state.mode.expect_header_name = true;
            }
            true
        } else {
            false
        }
    });
    if names_directive {
        return emit(lexer, tins, "ID", index);
    }

    let name = with_state(|state| {
        if !state.mode.in_directive && state.symbols.is_typedef(&word) {
            "TYPEDEF_NAME"
        } else if !state.mode.in_directive && state.macros.has(&word) {
            "MACRO_NAME"
        } else {
            "ID"
        }
    });
    emit(lexer, tins, name, index)
}

// ---------------------------------------------------------------------
// Numeric literals
// ---------------------------------------------------------------------

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

fn integer(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    if !at(&text, 0).is_ascii_digit() {
        return None;
    }
    let (number, whole) = scan_integer(&text)?;
    let hex = at(&text, 0) == '0' && matches!(at(&text, 1), 'x' | 'X');
    let after = at(&text, whole);
    if after == '.' || after == 'e' || after == 'E' {
        // For a hex literal only `p`/`P` introduces an exponent, so a
        // trailing `e` stays part of the integer.
        if !hex {
            return None;
        }
    }
    if hex && (after == '.' || after == 'p' || after == 'P') {
        return None;
    }
    let _ = number;
    emit(lexer, tins, "LIT_INT", whole)
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

fn float(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    let first = at(&text, 0);
    let starts_digit = first.is_ascii_digit();
    let starts_dot = first == '.' && at(&text, 1).is_ascii_digit();
    if !starts_digit && !starts_dot {
        return None;
    }
    let length = scan_float_hex(&text).or_else(|| scan_float_dec(&text))?;
    let matched = &text[..length];
    let hex = matched.len() >= 2 && matched[0] == '0' && matches!(matched[1], 'x' | 'X');
    let has_float_mark = matched.iter().any(|character| {
        matches!(
            character,
            '.' | 'e' | 'E' | 'p' | 'P' | 'f' | 'F' | 'l' | 'L'
        )
    });
    if !has_float_mark && !hex {
        return None;
    }
    emit(lexer, tins, "LIT_FLOAT", length)
}

// ---------------------------------------------------------------------
// Character and string literals
// ---------------------------------------------------------------------

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

fn char_literal(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    let mut index = char_prefix(&text)?;
    while index < text.len() {
        let character = text[index];
        if character == '\n' {
            return bad(lexer, "unterminated_char", 0, index);
        }
        if character == '\\' {
            index += 2;
            continue;
        }
        if character == '\'' {
            return emit(lexer, tins, "LIT_CHAR", index + 1);
        }
        index += 1;
    }
    bad(lexer, "unterminated_char", 0, text.len())
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

fn string_literal(lexer: &mut Lexer<'_>, tins: &Tins) -> Option<Token> {
    let text = chars(lexer);
    let (prefix, raw) = string_prefix(&text)?;
    let mut index = prefix;
    if raw {
        // `R"delim( ... )delim"`
        let mut delimiter_end = index;
        while delimiter_end < text.len() && text[delimiter_end] != '(' {
            delimiter_end += 1;
        }
        if delimiter_end >= text.len() {
            return bad(lexer, "unterminated_string", 0, text.len());
        }
        let delimiter: String = text[index..delimiter_end].iter().collect();
        let closer: Vec<char> = format!("){delimiter}\"").chars().collect();
        let mut scan = delimiter_end + 1;
        let close = loop {
            if scan + closer.len() > text.len() {
                break None;
            }
            if text[scan..scan + closer.len()] == closer[..] {
                break Some(scan);
            }
            scan += 1;
        };
        let Some(close) = close else {
            return bad(lexer, "unterminated_string", 0, text.len());
        };
        return emit(lexer, tins, "LIT_STRING", close + closer.len());
    }
    while index < text.len() {
        let character = text[index];
        if character == '\n' {
            return bad(lexer, "unterminated_string", 0, index);
        }
        if character == '\\' {
            index += 2;
            continue;
        }
        if character == '"' {
            return emit(lexer, tins, "LIT_STRING", index + 1);
        }
        index += 1;
    }
    bad(lexer, "unterminated_string", 0, text.len())
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
    sorted.sort_by(|left, right| right.1.len().cmp(&left.1.len()));
    sorted
}

fn punctuator(
    lexer: &mut Lexer<'_>,
    tins: &Tins,
    sorted: &[(&'static str, &'static str)],
) -> Option<Token> {
    let remaining = lexer.remaining();
    for (name, source) in sorted {
        if remaining.starts_with(source) {
            let name = *name;
            let consumed = source.chars().count();
            return emit(lexer, tins, name, consumed);
        }
    }
    None
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
            Arc::new(
                move |lexer: &mut Lexer<'_>, _rule: &mut Rule, _context: &mut Context| {
                    punctuator(lexer, &tins, &sorted)
                },
            )
        }
        _ => wrap(tins, |_lexer, _tins| None),
    }
}

fn wrap(
    tins: Tins,
    body: impl Fn(&mut Lexer<'_>, &Tins) -> Option<Token> + Send + Sync + 'static,
) -> ImperativeLexMatcher {
    Arc::new(
        move |lexer: &mut Lexer<'_>, _rule: &mut Rule, _context: &mut Context| body(lexer, &tins),
    )
}
