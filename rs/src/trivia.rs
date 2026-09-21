/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The sub-lex hook: every emitted token, the ignored ones included,
//! flows through here. Comments and line continuations are buffered and
//! handed to the next non-trivia token as `use.leading`, so trivia
//! survives in the tree in source order even though the parser never
//! sees it.
//!
//! The canonical plugin registers this once, as `jsonic.sub({lex})`.
//! Here it is a free function, because the lookahead walk in
//! `crate::rt::fetch_deep` drives the lexer itself and has to apply the
//! same hook to the tokens it pulls.

use tabnas::{Token, Value};

use crate::sets;
use crate::state::{self, with_state};

pub fn on_lex_token(token: &mut Token) {
    let name = token.name.as_str();
    if sets::PRESERVE_TRIVIA_NAMES.contains(&name) {
        let id = crate::cst::intern_token(token);
        with_state(|state| state.pending_trivia.push(id));
        return;
    }
    if sets::DROP_TRIVIA_NAMES.contains(&name) {
        return;
    }
    let pending = with_state(|state| std::mem::take(&mut state.pending_trivia));
    if pending.is_empty() {
        return;
    }
    let leading = Value::array(
        pending
            .into_iter()
            .map(state::token_handle)
            .collect::<Vec<_>>(),
    );
    token
        .use_data
        .get_or_insert_with(Default::default)
        .insert("leading".to_string(), leading);
}
