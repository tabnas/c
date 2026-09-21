/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The small runtime layer the ported rule handlers are written
//! against: reading and writing a rule's node, its `k` and `u` bags and
//! its matched tokens, and the lookahead walk the dispatch conditions
//! need.
//!
//! The canonical handlers reach these through live JavaScript objects.
//! Here a rule's node is a shared `Rc<RefCell<Value>>` and its bags
//! hold engine values, so every read and write goes through a handle
//! into the tree arena.

use std::cell::RefCell;
use std::rc::Rc;

use tabnas::{Context, Lexer, Rule, Token, Value};

use crate::cst::{self, Item};
use crate::sets;
use crate::state::{self, handle_node, node_handle, with_state};

// ---------------------------------------------------------------------
// Rule node
// ---------------------------------------------------------------------

/// The node a rule currently carries, when it carries a CST node.
pub fn node_id(rule: &Rule) -> Option<usize> {
    handle_node(&rule.node.borrow())
}

/// Install a fresh node cell on the rule. A pushed or replaced rule
/// SHARES its parent's cell, so writing through the existing one
/// overwrites the parent's node too; this is what `r.node = v` means in
/// the canonical engine.
pub fn set_node(rule: &mut Rule, value: Value) {
    rule.node = Rc::new(RefCell::new(value));
}

pub fn set_node_id(rule: &mut Rule, node: usize) {
    set_node(rule, node_handle(node));
}

/// The rule's node, replaced by a fresh node of `kind` when it is not
/// already one of that kind.
pub fn ensure_node(rule: &mut Rule, kind: &str) -> usize {
    match node_id(rule) {
        Some(node) if cst::kind_of(node) == kind => node,
        _ => {
            let node = cst::new_node(kind, None);
            set_node_id(rule, node);
            node
        }
    }
}

/// The completed child rule's node, when it is a CST node.
pub fn child_node_id(rule: &Rule) -> Option<usize> {
    handle_node(&rule.child_node)
}

/// The name of the rule that just closed under this one.
pub fn child_name(rule: &Rule) -> String {
    rule.child_rule
        .as_ref()
        .map(|child| child.name.as_str().to_string())
        .unwrap_or_default()
}

/// Whether the rule that closed under this one is the `val` the C
/// grammar pushed to parse an expression.
///
/// The canonical TypeScript reads `rule.child.name === 'val'`, and its
/// `rule.child` is the rule that was PUSHED — a later `r:` replacement
/// never rewrites it. The Rust engine instead records the rule that
/// actually popped, so an expression with an operator in it reports the
/// `@tabnas/expr` rule (`expr`, `ternary`, ...) that `val` turned into
/// and the plain name test silently drops the expression. Walking
/// `prev_rule` back to the head of the replacement chain asks the same
/// question the canonical does: was the pushed rule `val`?
///
/// `PREV_CHAIN_CAP` bounds the walk. The chain is one link per `r:` in
/// the expression, so a pathological input cannot make this quadratic.
pub fn child_is_val(rule: &Rule) -> bool {
    const PREV_CHAIN_CAP: usize = 64;
    let mut current = rule.child_rule.clone();
    let mut hops = 0;
    while let Some(snapshot) = current {
        if snapshot.name.as_str() == "val" {
            return true;
        }
        hops += 1;
        if PREV_CHAIN_CAP <= hops {
            return false;
        }
        current = snapshot.prev_rule.clone();
    }
    false
}

/// The parent rule's node, when it carries one.
pub fn parent_node_id(rule: &Rule) -> Option<usize> {
    rule.parent_rule
        .as_ref()
        .and_then(|parent| handle_node(&parent.node.borrow()))
}

// ---------------------------------------------------------------------
// The k and u bags
// ---------------------------------------------------------------------

pub fn k_set(rule: &mut Rule, key: &str, value: Value) {
    rule.k_mut().insert(key.to_string(), value);
}

pub fn k_del(rule: &mut Rule, key: &str) {
    rule.k_mut().remove(key);
}

pub fn k_bool(rule: &Rule, key: &str) -> bool {
    matches!(rule.k.get(key), Some(Value::Bool(true)))
}

pub fn k_has(rule: &Rule, key: &str) -> bool {
    rule.k.get(key).is_some_and(|value| !value.is_undefined())
}

pub fn k_num(rule: &Rule, key: &str) -> i64 {
    match rule.k.get(key) {
        Some(Value::Number(number)) => *number as i64,
        _ => 0,
    }
}

pub fn k_str(rule: &Rule, key: &str) -> String {
    match rule.k.get(key) {
        Some(Value::String(text)) => text.clone(),
        _ => String::new(),
    }
}

/// A node handle kept on the `k` bag.
pub fn k_node(rule: &Rule, key: &str) -> Option<usize> {
    rule.k.get(key).and_then(handle_node)
}

pub fn k_set_node(rule: &mut Rule, key: &str, node: usize) {
    k_set(rule, key, node_handle(node));
}

/// A token handle kept on the `k` bag.
pub fn k_token(rule: &Rule, key: &str) -> Option<usize> {
    rule.k.get(key).and_then(state::handle_token)
}

pub fn k_set_token(rule: &mut Rule, key: &str, token: usize) {
    k_set(rule, key, state::token_handle(token));
}

pub fn k_set_bool(rule: &mut Rule, key: &str, flag: bool) {
    k_set(rule, key, Value::Bool(flag));
}

pub fn k_set_num(rule: &mut Rule, key: &str, number: i64) {
    k_set(rule, key, Value::Number(number as f64));
}

pub fn k_set_str(rule: &mut Rule, key: &str, text: &str) {
    k_set(rule, key, Value::String(text.to_string()));
}

pub fn u_bool(rule: &Rule, key: &str) -> bool {
    matches!(rule.u.get(key), Some(Value::Bool(true)))
}

pub fn u_set_bool(rule: &mut Rule, key: &str, flag: bool) {
    rule.u_mut().insert(key.to_string(), Value::Bool(flag));
}

pub fn u_node(rule: &Rule, key: &str) -> Option<usize> {
    rule.u.get(key).and_then(handle_node)
}

pub fn u_set_node(rule: &mut Rule, key: &str, node: usize) {
    rule.u_mut().insert(key.to_string(), node_handle(node));
}

/// A node handle kept on the PARENT rule's `k` bag. A parent reaches a
/// handler only as a snapshot, so this is a read; the node it names is
/// live, and mutating that node is how the canonical handlers reach
/// across the rule boundary.
pub fn parent_k_node(rule: &Rule, key: &str) -> Option<usize> {
    rule.parent_rule
        .as_ref()
        .and_then(|parent| parent.k.get(key))
        .and_then(handle_node)
}

/// A node handle kept on the parent rule's `u` bag.
pub fn parent_u_node(rule: &Rule, key: &str) -> Option<usize> {
    rule.parent_rule
        .as_ref()
        .and_then(|parent| parent.u.get(key))
        .and_then(handle_node)
}

/// The grandparent rule's `k` node, for the one handler that reaches
/// two levels up (a parameter declaration attaching itself to the
/// function postfix above its parameter list).
pub fn grandparent_k_node(rule: &Rule, key: &str) -> Option<usize> {
    rule.parent_rule
        .as_ref()
        .and_then(|parent| parent.parent_rule.as_ref())
        .and_then(|grandparent| grandparent.k.get(key))
        .and_then(handle_node)
}

/// The parent rule's name.
pub fn parent_name(rule: &Rule) -> String {
    rule.parent_rule
        .as_ref()
        .map(|parent| parent.name.as_str().to_string())
        .unwrap_or_default()
}

/// The parent rule's node.
pub fn parent_node(rule: &Rule) -> Option<usize> {
    parent_node_id(rule)
}

/// True when the rule is in its close state, which is what
/// `rule.state === 'c'` tests.
pub fn is_close(rule: &Rule) -> bool {
    rule.state == tabnas::RuleState::Close
}

/// The token this handler should take: the first CLOSE token in the
/// close state, the first OPEN token otherwise. Several canonical
/// handlers are bound to both an open and a close alternate and pick
/// with `rule.state === 'c' ? rule.c0 : rule.o0`.
pub fn state_token(rule: &Rule) -> Option<usize> {
    if is_close(rule) {
        c0(rule)
    } else {
        o0(rule)
    }
}

/// True when this rule is the `r:` re-entry of the same rule rather
/// than a fresh push. The canonical handlers test `rule.prev.name`.
pub fn is_reentry(rule: &Rule) -> bool {
    rule.prev_rule
        .as_ref()
        .is_some_and(|prev| prev.name == rule.name)
}

/// Keep the node a re-entry already built, or build a fresh one. The
/// returned flag says whether the node is a fresh one, so the caller
/// can clear the progress flags a pushed child inherits from its
/// parent's `k`.
pub fn open_keep(rule: &mut Rule, kind: &str, key: &str) -> Option<usize> {
    if is_reentry(rule) {
        if let Some(node) = k_node(rule, key) {
            set_node_id(rule, node);
            return None;
        }
    }
    let node = cst::new_node(kind, None);
    set_node_id(rule, node);
    k_set_node(rule, key, node);
    Some(node)
}

/// Take the closed child's node once, keyed by the child rule's
/// identity. The canonical handlers keep a `Set` of the child RULES
/// they have already taken.
pub fn take_once(rule: &mut Rule, key: &str) -> bool {
    let Some(index) = rule.child_rule.as_ref().map(|child| child.i) else {
        return false;
    };
    let list = k_list(rule, key);
    if list_get(list).contains(&index) {
        return false;
    }
    list_push(list, index);
    true
}

/// A flag a handler keeps on a node.
pub fn node_flag(node: usize, key: &str) -> bool {
    with_state(|state| {
        state
            .flags
            .get(&(node, key.to_string()))
            .copied()
            .unwrap_or(false)
    })
}

pub fn set_node_flag(node: usize, key: &str, value: bool) {
    with_state(|state| {
        state.flags.insert((node, key.to_string()), value);
    });
}

// ---------------------------------------------------------------------
// Token lists on the k bag
// ---------------------------------------------------------------------

/// The id of a fresh token list.
pub fn new_list() -> usize {
    with_state(|state| {
        state.lists.push(Vec::new());
        state.lists.len() - 1
    })
}

pub fn list_push(list: usize, token: usize) {
    with_state(|state| {
        if let Some(entries) = state.lists.get_mut(list) {
            entries.push(token);
        }
    });
}

pub fn list_get(list: usize) -> Vec<usize> {
    with_state(|state| state.lists.get(list).cloned().unwrap_or_default())
}

pub fn list_len(list: usize) -> usize {
    with_state(|state| state.lists.get(list).map(Vec::len).unwrap_or_default())
}

/// The token list a rule keeps under `key`, creating it when absent.
pub fn k_list(rule: &mut Rule, key: &str) -> usize {
    match rule.k.get(key) {
        Some(Value::Number(id)) => *id as usize,
        _ => {
            let list = new_list();
            k_set(rule, key, Value::Number(list as f64));
            list
        }
    }
}

/// The token list a rule keeps under `key`, without creating one.
pub fn k_list_opt(rule: &Rule, key: &str) -> Option<usize> {
    match rule.k.get(key) {
        Some(Value::Number(id)) => Some(*id as usize),
        _ => None,
    }
}

/// The tokens of the list a rule keeps under `key`, or an empty vector.
pub fn k_list_tokens(rule: &Rule, key: &str) -> Vec<usize> {
    k_list_opt(rule, key).map(list_get).unwrap_or_default()
}

// ---------------------------------------------------------------------
// Matched tokens
// ---------------------------------------------------------------------

/// Copy the rule's first open token into the arena.
pub fn o0(rule: &Rule) -> Option<usize> {
    rule.o0().map(cst::intern_token)
}

/// Copy the rule's Nth open token into the arena.
pub fn open_token(rule: &Rule, index: usize) -> Option<usize> {
    rule.o.get(index).map(cst::intern_token)
}

/// Copy the rule's first close token into the arena.
pub fn c0(rule: &Rule) -> Option<usize> {
    rule.c0().map(cst::intern_token)
}

// ---------------------------------------------------------------------
// Lookahead
// ---------------------------------------------------------------------

// The canonical lookahead buffer's LENGTH, which is not the same as
// the number of tokens in it.
//
// `ctx.t` in the canonical engine (and in the Go one) is an array that
// never shrinks: consuming a token blanks the slot it vacates with the
// `NOTOKEN` sentinel and leaves the array as long as it ever was. The
// Rust engine's `context.t` is a `Vec` holding only real tokens, so it
// shortens as the parse consumes. The difference is invisible to a walk
// over the real tokens, and decisive for `fetch_deep`: the canonical
// walk cannot lex past a blanked slot, so a dispatch validator that has
// already looked far ahead once is BLIND until the parse consumes back
// up to the high-water mark.
//
// The high-water mark of `context.t.len()` is exactly that array
// length, so this cell stands in for it. `crate::state::reset` clears it
// at the start of every parse.
thread_local! {
    static LOOKAHEAD_LEN: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Note the engine's current lookahead length and answer the canonical
/// array length (the running maximum).
fn note_lookahead(len: usize) -> usize {
    LOOKAHEAD_LEN.with(|cell| {
        let high = cell.get().max(len);
        cell.set(high);
        high
    })
}

/// Forget the lookahead high-water mark. Called once per parse.
pub fn reset_lookahead() {
    LOOKAHEAD_LEN.with(|cell| cell.set(0));
}

/// The name of the lookahead token at `index`, or the empty string.
pub fn t_name(context: &Context, index: usize) -> String {
    note_lookahead(context.t.len());
    context
        .t
        .get(index)
        .map(|token| token.name.as_str().to_string())
        .unwrap_or_default()
}

/// True when the lookahead tokens at `index` and `index + 1` are
/// adjacent in the source, with nothing between them.
pub fn t_adjacent(context: &Context, index: usize) -> bool {
    note_lookahead(context.t.len());
    let Some(left) = context.t.get(index) else {
        return false;
    };
    let Some(right) = context.t.get(index + 1) else {
        return false;
    };
    left.site.si + left.len == right.site.si
}

/// The furthest the lookahead walk will search. The dispatch validator
/// only needs to see past the current declaration; the cap stops it
/// lexing a whole translation unit on pathological input.
pub const FETCH_DEEP_CAP: usize = 256;

/// The lookahead token at `index`, lexing further tokens when the
/// buffer is short. Port of `fetchDeep` in `ts/src/c.ts`.
///
/// Tokens are appended at the tail, which is where the engine's own
/// fill loop puts them and where its consume-and-shift takes them from,
/// so a deeper walk leaves the parse exactly as it found it apart from
/// having read further ahead.
pub fn fetch_deep(
    context: &mut Context,
    rule: &mut Rule,
    lexer: &mut Lexer<'_>,
    index: usize,
) -> Option<Token> {
    if index >= FETCH_DEEP_CAP {
        return None;
    }
    let high = note_lookahead(context.t.len());
    if index < context.t.len() {
        return real(context.t.get(index));
    }
    // Inside the canonical array but past the real tokens: a blanked
    // slot, which the canonical `fetchDeep` reports as no token at all
    // rather than lexing to fill it. See [`note_lookahead`].
    if index < high {
        return None;
    }
    let ignore: Vec<i32> = context
        .options
        .token_set
        .get("IGNORE")
        .cloned()
        .unwrap_or_default();
    while context.t.len() <= index {
        if context
            .t
            .last()
            .is_some_and(|token| token.name.as_str() == "#ZZ")
        {
            break;
        }
        let token = loop {
            let Ok(mut token) = lexer.next_raw_for_rule(rule, context) else {
                return None;
            };
            crate::trivia::on_lex_token(&mut token);
            if !ignore.contains(&token.tin) {
                break token;
            }
        };
        let end = token.name.as_str() == "#ZZ";
        context.t.push(token);
        if end {
            break;
        }
    }
    note_lookahead(context.t.len());
    real(context.t.get(index))
}

/// The name of the lookahead token at `index`, lexing further tokens
/// when needed.
pub fn deep_name(
    context: &mut Context,
    rule: &mut Rule,
    lexer: &mut Lexer<'_>,
    index: usize,
) -> String {
    fetch_deep(context, rule, lexer, index)
        .map(|token| token.name.as_str().to_string())
        .unwrap_or_default()
}

fn real(token: Option<&Token>) -> Option<Token> {
    token
        .filter(|token| !token.name.as_str().is_empty() && token.tin >= 0)
        .cloned()
}

// ---------------------------------------------------------------------
// Node helpers the handlers use constantly
// ---------------------------------------------------------------------

/// Push a token and the trivia that precedes it onto a node, as
/// `pushTokenWithTrivia` does.
pub fn push_token(node: usize, token: usize) {
    cst::push_token_with_trivia(node, token);
}

/// Make a node and push the token onto it. The canonical handlers
/// build these with `makeNode(kind)` and no start token, so the node
/// keeps the zero span even though its first child has a real one.
pub fn node_from_token(kind: &str, token: usize) -> usize {
    let node = cst::new_node(kind, None);
    push_token(node, token);
    node
}

/// True when the first non-trivia token of the list has this name.
pub fn first_non_trivia_is(tokens: &[usize], name: &str) -> bool {
    for token in tokens {
        let token_name = cst::token_name(*token);
        if sets::is_trivia(&token_name) {
            continue;
        }
        return token_name == name;
    }
    false
}

/// Append a child node to a node.
pub fn append_child(parent: usize, child: usize) {
    cst::push_child(parent, Item::Node(child));
}
