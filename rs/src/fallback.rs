/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The armed fallback: how an external declaration the rules cannot
//! parse becomes an unknown declaration, where the parser up to 0.5
//! handed it to a structurer that took any token run. Port of
//! `ts/src/fallback.ts`, which has the design.
//!
//! `external_declaration` dispatches on its head (`c-grammar.jsonic`). A
//! route the parser has always held to the rules is strict: a
//! declaration the rules cannot parse there is refused. Every other
//! route is armed. An armed declaration is the token run the 0.5
//! parser's chomp absorbed, and that run ends where the chomp ended it:
//! after a `;` at brace depth 0, after the newline that ends a `#` line,
//! after a `}` back to depth 0 when the next token starts a declaration
//! (`starts_new_declaration`), or at the end. Inside it every rule below
//! `external_declaration` has a bail (the first alternate of each state,
//! which ends the state once the declaration has failed) and a catch-all
//! (the last, which fails the declaration where no other alternate
//! matches), and every alternate that takes a token is fenced at the
//! chomp's end. The plugin records the tokens it lexes (the sub-lex hook
//! in `crate::trivia`), and the engine's count of the tokens taken
//! (`context.v_abs`) says how many of them the declaration holds.
//!
//! TypeScript catches what a ref throws in an armed declaration, and Go
//! recovers what one panics, and fails the declaration; over the 16,916
//! documents of the conformance sweep (`docs/rules.md`) no ref throws, and
//! this port leaves a panic a panic.

use std::collections::HashSet;

use tabnas::{Context, Token};

use crate::cst;
use crate::state::with_state;

/// A rule that catches a failure below it (`asm_operand`).
#[derive(Debug, Clone, Default)]
pub struct LocalScope {
    pub v_abs: usize,
    pub failed: bool,
}

/// The state of the external declaration being parsed.
#[derive(Debug, Clone, Default)]
pub struct ExtDecl {
    /// The route is armed, not strict.
    pub armed: bool,
    /// An armed declaration the rules failed on: every state bails.
    pub failed: bool,
    /// The declaration is an unknown one: its children are its tokens.
    pub unknown: bool,
    /// The rules ended an armed declaration before the chomp's end: the
    /// rest of the run follows what they built, flat.
    pub trailing: bool,
    /// The chomp's state over the tokens taken so far.
    pub scanned: usize,
    pub depth: i64,
    pub terminated: bool,
    pub just_closed: bool,
    pub first: String,
    /// Every local scope opened in the declaration, by id, and the open
    /// ones, innermost last. A failure inside an open one fails the
    /// scope, not the declaration.
    pub scopes: Vec<LocalScope>,
    pub open: Vec<usize>,
    /// The names a strict typedef declaration's rules found, bound when
    /// the declaration ends.
    pub typedef_names: Option<Vec<String>>,
}

impl ExtDecl {
    fn innermost(&self) -> Option<&LocalScope> {
        self.open.last().and_then(|id| self.scopes.get(*id))
    }

    fn innermost_mut(&mut self) -> Option<&mut LocalScope> {
        let id = *self.open.last()?;
        self.scopes.get_mut(id)
    }
}

/// Run `body` with the external declaration being parsed, when there is
/// one.
pub fn with_ed<R>(body: impl FnOnce(&mut ExtDecl) -> R) -> Option<R> {
    with_state(|state| state.ed.as_mut().map(body))
}

/// Record a token the lexer gave the parser. Called from the sub-lex hook
/// for every token that is not trivia; the engine takes them in the order
/// they are lexed.
pub fn record_token(token: &Token) {
    if token.name.as_str() == "#ZZ" {
        return;
    }
    let id = cst::intern_token(token);
    with_state(|state| {
        let start = state.tokens[id].span.start;
        // A re-announced token (the engine's relex undo) replaces the last.
        if let Some(last) = state.rec.last_mut() {
            if state.tokens[*last].span.start == start {
                *last = id;
                return;
            }
        }
        state.rec.push(id);
    });
}

/// Start an external declaration: drop the record's tokens the previous
/// ones took, and reset the state.
pub fn start_declaration(context: &Context) {
    with_state(|state| {
        let taken = context.v_abs.saturating_sub(state.rec_base);
        if taken > 0 {
            if taken >= state.rec.len() {
                state.rec.clear();
            } else {
                state.rec.drain(0..taken);
            }
        }
        state.rec_base = context.v_abs;
        state.ed = Some(ExtDecl::default());
    });
}

/// The tokens the declaration has taken, in order, as arena ids.
pub fn taken_tokens(context: &Context) -> Vec<usize> {
    with_state(|state| {
        let n = context
            .v_abs
            .saturating_sub(state.rec_base)
            .min(state.rec.len());
        state.rec[..n].to_vec()
    })
}

/// The tokens taken since a count of tokens taken.
pub fn tokens_since(context: &Context, v_abs: usize) -> Vec<usize> {
    with_state(|state| {
        let from = v_abs.saturating_sub(state.rec_base);
        let to = context
            .v_abs
            .saturating_sub(state.rec_base)
            .min(state.rec.len());
        if from >= to {
            return Vec::new();
        }
        state.rec[from..to].to_vec()
    })
}

/// The depth of `(` and `[` a run of tokens leaves open.
pub fn bracket_depth(tokens: &[usize]) -> i64 {
    let mut depth = 0;
    for token in tokens {
        match cst::token_name(*token).as_str() {
            "PUNC_LPAREN" | "PUNC_LBRACKET" => depth += 1,
            "PUNC_RPAREN" | "PUNC_RBRACKET" => depth -= 1,
            _ => {}
        }
    }
    depth
}

/// The tokens lexed but not yet taken, which a reclassification of the
/// lookahead renames, as the canonical's record holds the lookahead's
/// own token objects.
pub fn reclassify_untaken(context: &Context, name: &str, from: &str, to: &str) {
    with_state(|state| {
        let taken = context.v_abs.saturating_sub(state.rec_base);
        let ids: Vec<usize> = state.rec.iter().skip(taken).copied().collect();
        for id in ids {
            if let Some(token) = state.tokens.get_mut(id) {
                if token.name == from && token.src == name {
                    token.name = to.to_string();
                }
            }
        }
    });
}

/// Open a local scope at the tokens taken so far, and answer its id.
pub fn open_local(context: &Context) -> Option<usize> {
    with_ed(|ed| {
        let id = ed.scopes.len();
        ed.scopes.push(LocalScope {
            v_abs: context.v_abs,
            failed: false,
        });
        ed.open.push(id);
        id
    })
}

/// Close a local scope (and any left open inside it).
pub fn close_local(id: usize) {
    with_ed(|ed| {
        if let Some(at) = ed.open.iter().rposition(|open| *open == id) {
            ed.open.truncate(at);
        }
    });
}

/// The scope `id`: the count of tokens taken when it opened, and whether
/// it has failed.
pub fn scope(id: usize) -> Option<LocalScope> {
    with_ed(|ed| ed.scopes.get(id).cloned()).flatten()
}

/// True when the chomp would end the declaration after the tokens taken,
/// given the next token (`context.t[0]`, which the caller has fetched).
pub fn chomp_ended(context: &Context) -> bool {
    let synced = with_state(|state| {
        let n = context.v_abs as i64 - state.rec_base as i64;
        let ed = state.ed.as_mut()?;
        let upto = (n.max(0) as usize).min(state.rec.len());
        for index in ed.scanned..upto {
            let name = state.tokens[state.rec[index]].name.as_str();
            if index == 0 {
                ed.first = name.to_string();
            }
            ed.just_closed = false;
            match name {
                "PUNC_LBRACE" => ed.depth += 1,
                "PUNC_RBRACE" => {
                    ed.depth -= 1;
                    if ed.depth <= 0 {
                        ed.just_closed = true;
                    }
                }
                "PUNC_SEMI" if ed.depth == 0 => ed.terminated = true,
                "PP_NEWLINE" if ed.depth == 0 && ed.first == "PP_HASH" => ed.terminated = true,
                _ => {}
            }
        }
        ed.scanned = ed.scanned.max(upto);
        Some((n, ed.terminated, ed.just_closed))
    });
    let Some((n, terminated, just_closed)) = synced else {
        return false;
    };
    if n <= 0 {
        return false;
    }
    if terminated {
        return true;
    }
    just_closed && starts_new_declaration(context)
}

/// The fence: an armed declaration that has reached the chomp's end takes
/// no more tokens.
pub fn fenced(context: &Context) -> bool {
    let armed = with_ed(|ed| ed.armed && !ed.failed).unwrap_or(false);
    armed && chomp_ended(context)
}

/// Token-name sets of the chomp's own test, unchanged from 0.5.
const STORAGE_CLASS: &[&str] = &[
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
const TYPE_SPEC_KEYWORD: &[&str] = &[
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
const TYPE_QUALIFIER: &[&str] = &[
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
const FUNCTION_SPECIFIER: &[&str] = &["KW_INLINE", "KW___INLINE__", "KW___INLINE", "KW__NORETURN"];

/// True when the next token is one that starts an external declaration.
/// The chomp asked this after a `}` back to depth 0, to tell a function
/// body's end from a struct body's.
pub fn starts_new_declaration(context: &Context) -> bool {
    for token in context.t.iter() {
        let name = token.name.as_str();
        match name {
            "#SP"
            | "#LN"
            | "#CM"
            | "TRIVIA_LINE_COMMENT"
            | "TRIVIA_BLOCK_COMMENT"
            | "TRIVIA_LINE_CONT" => continue,
            "#ZZ" | "PP_HASH" | "PUNC_HASH" => return true,
            _ => {}
        }
        if STORAGE_CLASS.contains(&name)
            || TYPE_SPEC_KEYWORD.contains(&name)
            || TYPE_QUALIFIER.contains(&name)
            || FUNCTION_SPECIFIER.contains(&name)
        {
            return true;
        }
        return matches!(
            name,
            "KW___ATTRIBUTE__"
                | "KW___ATTRIBUTE"
                | "KW___DECLSPEC"
                | "KW___EXTENSION__"
                | "TYPEDEF_NAME"
        );
    }
    false
}

/// Is the declaration being parsed, or its innermost scope, failed? A
/// lifecycle action does nothing then.
pub fn bailing() -> bool {
    with_ed(|ed| ed.failed || ed.innermost().is_some_and(|scope| scope.failed)).unwrap_or(false)
}

/// The catch-all's condition: the declaration is armed, or a scope is
/// open, and neither has failed.
pub fn armed() -> bool {
    with_ed(|ed| {
        if ed.failed {
            return false;
        }
        match ed.innermost() {
            Some(scope) => !scope.failed,
            None => ed.armed,
        }
    })
    .unwrap_or(false)
}

/// The catch-all's action: fail the innermost scope, or the declaration.
pub fn fail() {
    with_ed(|ed| match ed.innermost_mut() {
        Some(scope) => scope.failed = true,
        None => ed.failed = true,
    });
}

/// What the fallback did to the grammar document: the refs whose
/// lifecycle actions bail once a declaration has failed, and each fenced
/// condition with the condition it fences.
#[derive(Debug, Default, Clone)]
pub struct Fallback {
    pub used: HashSet<String>,
    pub fenced: Vec<(String, String)>,
}

impl Fallback {
    /// Does a lifecycle action of this name bail?
    pub fn bails(&self, name: &str) -> bool {
        self.used.contains(name)
            && ["-bo", "-ao", "-bc", "-ac"]
                .iter()
                .any(|phase| name.ends_with(phase))
    }
}

/// The rules above the fallback: they are not given the bail and the
/// catch-all, and their refs are not wrapped.
const ABOVE: &[&str] = &[
    "translation_unit",
    "extdecl_loop",
    "conditional_group",
    "conditional_branch",
    "external_declaration",
    "unknown_declaration",
];

fn token_count(s: Option<&serde_json::Value>) -> i64 {
    match s {
        Some(serde_json::Value::Array(items)) => items.len() as i64,
        Some(serde_json::Value::String(text)) => text.split_whitespace().count() as i64,
        _ => 0,
    }
}

/// An alternate takes a token when it matches more tokens than it gives
/// back.
fn takes_token(alt: &serde_json::Map<String, serde_json::Value>) -> bool {
    let back = alt
        .get("b")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    token_count(alt.get("s")) - back > 0
}

/// Give every rule below `external_declaration` the bail and the
/// catch-all, and put the fence on every alternate that takes a token, in
/// the grammar document; answer the refs it uses and the fenced
/// conditions, which `crate::refs` binds.
pub fn with_fallback(document: &mut serde_json::Value) -> Fallback {
    let mut out = Fallback::default();
    let Some(rules) = document
        .get_mut("rule")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return out;
    };
    for (name, spec) in rules.iter_mut() {
        if ABOVE.contains(&name.as_str()) {
            continue;
        }
        let Some(spec) = spec.as_object_mut() else {
            continue;
        };
        for state in ["open", "close"] {
            let Some(alts) = spec
                .get_mut(state)
                .and_then(serde_json::Value::as_array_mut)
            else {
                continue;
            };
            if alts.is_empty() {
                continue;
            }
            for alt in alts.iter_mut() {
                let Some(alt) = alt.as_object_mut() else {
                    continue;
                };
                for key in ["a", "c"] {
                    if let Some(serde_json::Value::String(text)) = alt.get(key) {
                        out.used.insert(text.clone());
                    }
                }
                if takes_token(alt) {
                    match alt.get("c") {
                        Some(serde_json::Value::String(cond)) => {
                            let fenced = format!("{cond}~fenced");
                            out.fenced.push((fenced.clone(), cond.clone()));
                            alt.insert("c".to_string(), serde_json::Value::String(fenced));
                        }
                        None | Some(serde_json::Value::Null) => {
                            alt.insert(
                                "c".to_string(),
                                serde_json::Value::String("@c-unfenced".to_string()),
                            );
                        }
                        _ => {}
                    }
                }
            }
            // A rule that catches a failure below it has its catch first,
            // and the bail after it.
            let at = alts
                .first()
                .and_then(|alt| alt.get("g"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|group| group.starts_with("catch-")) as usize;
            alts.insert(at, serde_json::json!({ "c": "@c-bailing", "g": "c-bail" }));
            alts.push(serde_json::json!({ "c": "@c-armed", "a": "@c-fail", "g": "c-fail" }));
        }
        for phase in ["bo", "ao", "bc", "ac"] {
            out.used.insert(format!("@{name}-{phase}"));
        }
    }
    out.fenced.sort();
    out.fenced.dedup();
    out
}
