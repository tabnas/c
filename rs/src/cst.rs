/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The concrete syntax tree: node and token records, the arena they
//! live in, and the conversion from arena handles to plain engine
//! values.
//!
//! Every node carries `kind`, `span`, `children` and
//! `trivia: {leading, trailing}`, plus per-kind fields, and a token
//! reference is `{kind: "token", tname, src, span}`. That is the
//! cross-runtime shape the shared fixtures pin, so the realized value
//! is byte-comparable with the TypeScript and Go ports.

use std::cell::RefCell;
use std::collections::HashMap;

use indexmap::IndexMap;
use tabnas::{Token, Value};

use crate::state::{handle_node, handle_token, node_handle, token_handle, with_state};

/// The single key a node handle carries. `$` is not a C identifier
/// character and not a key any CST node uses, so a handle cannot be
/// mistaken for a realized node.
pub const NODE_KEY: &str = "$cnode";
/// The single key a token handle carries.
pub const TOKEN_KEY: &str = "$ctoken";

/// A source span, as the CST records it: `start` and `end` are
/// character offsets, `line` is 1-based and `col` is 1-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub col: usize,
}

impl Span {
    /// The `{0,0,1,1}` fallback a node with no start token gets.
    pub fn zero() -> Self {
        Span {
            start: 0,
            end: 0,
            line: 1,
            col: 1,
        }
    }

    pub fn to_value(self) -> Value {
        let mut entries = IndexMap::new();
        entries.insert("start".to_string(), Value::Number(self.start as f64));
        entries.insert("end".to_string(), Value::Number(self.end as f64));
        entries.insert("line".to_string(), Value::Number(self.line as f64));
        entries.insert("col".to_string(), Value::Number(self.col as f64));
        Value::object(entries)
    }
}

/// One entry in a node's children, trivia or extra fields: another
/// node, a token, or a plain value.
#[derive(Debug, Clone)]
pub enum Item {
    Node(usize),
    Token(usize),
    Val(Value),
    List(Vec<Item>),
}

impl Item {
    pub fn str(text: impl Into<String>) -> Self {
        Item::Val(Value::String(text.into()))
    }

    pub fn bool(flag: bool) -> Self {
        Item::Val(Value::Bool(flag))
    }

    /// The node this item names, when it names one.
    pub fn as_node(&self) -> Option<usize> {
        match self {
            Item::Node(id) => Some(*id),
            Item::Val(value) => handle_node(value),
            _ => None,
        }
    }

    /// The token this item names, when it names one.
    pub fn as_token(&self) -> Option<usize> {
        match self {
            Item::Token(id) => Some(*id),
            Item::Val(value) => handle_token(value),
            _ => None,
        }
    }

    /// The engine value that stands for this item while a parse runs.
    pub fn to_handle(&self) -> Value {
        match self {
            Item::Node(id) => node_handle(*id),
            Item::Token(id) => token_handle(*id),
            Item::Val(value) => value.clone(),
            Item::List(items) => {
                Value::array(items.iter().map(Item::to_handle).collect::<Vec<_>>())
            }
        }
    }

    /// Read an item back out of a value that travelled through the
    /// engine.
    pub fn from_value(value: &Value) -> Self {
        if let Some(id) = handle_node(value) {
            return Item::Node(id);
        }
        if let Some(id) = handle_token(value) {
            return Item::Token(id);
        }
        Item::Val(value.clone())
    }
}

/// A CST node under construction.
#[derive(Debug, Clone)]
pub struct NodeData {
    pub kind: String,
    pub span: Span,
    pub children: Vec<Item>,
    pub leading: Vec<Item>,
    pub trailing: Vec<Item>,
    /// Per-kind fields, in the order they were first written.
    pub extras: IndexMap<String, Item>,
}

/// A token, as the parse recorded it. Tokens are immutable once
/// emitted, so this is a copy rather than a handle on the engine's.
#[derive(Debug, Clone)]
pub struct TokenData {
    pub name: String,
    pub src: String,
    pub span: Span,
    /// Trivia the lexer attached ahead of this token, as arena ids.
    pub leading: Vec<usize>,
}

/// The span of a token, in the shape the CST records.
pub fn token_span(token: &Token) -> Span {
    Span {
        start: token.site.pos,
        end: token.site.pos + token.src.as_str().chars().count(),
        line: token.site.ri,
        col: token.site.ci,
    }
}

/// The arena id of the engine's no-token sentinel.
///
/// The canonical `rule.c0` getter answers with a sentinel `Token` when
/// the rule matched no close token, and the C handlers push it as if it
/// were real: `@ppi-pointer` runs in the open state, reads `c0`, and
/// the fixtures record the resulting `pointer` node carrying a token
/// with an empty `tname` and `src` at the zero span. `Rule::c0` here
/// answers `None` instead, so a handler that must reproduce that shape
/// falls back to this. One entry per parse, reused.
pub fn no_token() -> usize {
    with_state(|state| {
        if let Some(id) = state.no_token {
            return id;
        }
        state.tokens.push(TokenData {
            name: String::new(),
            src: String::new(),
            span: Span {
                start: 0,
                end: 0,
                line: 1,
                col: 1,
            },
            leading: Vec::new(),
        });
        let id = state.tokens.len() - 1;
        state.no_token = Some(id);
        id
    })
}

/// Copy a token into the arena and return its id. The leading trivia
/// the lex subscriber attached comes with it.
pub fn intern_token(token: &Token) -> usize {
    let leading = leading_ids(token);
    with_state(|state| {
        state.tokens.push(TokenData {
            name: token.name.as_str().to_string(),
            src: token.src.as_str().to_string(),
            span: token_span(token),
            leading,
        });
        state.tokens.len() - 1
    })
}

/// The arena ids of the trivia tokens the lex subscriber stashed on
/// this token under `use.leading`.
fn leading_ids(token: &Token) -> Vec<usize> {
    let Some(use_data) = token.use_data.as_ref() else {
        return Vec::new();
    };
    let Some(Value::Array(items)) = use_data.get("leading") else {
        return Vec::new();
    };
    items.iter().filter_map(handle_token).collect()
}

/// Make a node and return its arena id.
pub fn new_node(kind: &str, span: Option<Span>) -> usize {
    with_state(|state| {
        state.nodes.push(NodeData {
            kind: kind.to_string(),
            span: span.unwrap_or_else(Span::zero),
            children: Vec::new(),
            leading: Vec::new(),
            trailing: Vec::new(),
            extras: IndexMap::new(),
        });
        state.nodes.len() - 1
    })
}

/// The kind of a node, or the empty string when the id is not a node.
pub fn kind_of(node: usize) -> String {
    with_state(|state| {
        state
            .nodes
            .get(node)
            .map(|data| data.kind.clone())
            .unwrap_or_default()
    })
}

pub fn set_kind(node: usize, kind: &str) {
    with_state(|state| {
        if let Some(data) = state.nodes.get_mut(node) {
            data.kind = kind.to_string();
        }
    });
}

pub fn span_of(node: usize) -> Span {
    with_state(|state| {
        state
            .nodes
            .get(node)
            .map(|data| data.span)
            .unwrap_or_else(Span::zero)
    })
}

pub fn set_span(node: usize, span: Span) {
    with_state(|state| {
        if let Some(data) = state.nodes.get_mut(node) {
            data.span = span;
        }
    });
}

pub fn push_child(node: usize, item: Item) {
    with_state(|state| {
        if let Some(data) = state.nodes.get_mut(node) {
            data.children.push(item);
        }
    });
}

pub fn set_children(node: usize, items: Vec<Item>) {
    with_state(|state| {
        if let Some(data) = state.nodes.get_mut(node) {
            data.children = items;
        }
    });
}

pub fn children_of(node: usize) -> Vec<Item> {
    with_state(|state| {
        state
            .nodes
            .get(node)
            .map(|data| data.children.clone())
            .unwrap_or_default()
    })
}

pub fn child_count(node: usize) -> usize {
    with_state(|state| {
        state
            .nodes
            .get(node)
            .map(|data| data.children.len())
            .unwrap_or_default()
    })
}

pub fn set_extra(node: usize, key: &str, item: Item) {
    with_state(|state| {
        if let Some(data) = state.nodes.get_mut(node) {
            data.extras.insert(key.to_string(), item);
        }
    });
}

pub fn extra_of(node: usize, key: &str) -> Option<Item> {
    with_state(|state| {
        state
            .nodes
            .get(node)
            .and_then(|data| data.extras.get(key).cloned())
    })
}

pub fn has_extra(node: usize, key: &str) -> bool {
    with_state(|state| {
        state
            .nodes
            .get(node)
            .is_some_and(|data| data.extras.contains_key(key))
    })
}

/// The `src` of a token, or the empty string.
pub fn token_src(token: usize) -> String {
    with_state(|state| {
        state
            .tokens
            .get(token)
            .map(|data| data.src.clone())
            .unwrap_or_default()
    })
}

/// The `tname` of a token, or the empty string.
pub fn token_name(token: usize) -> String {
    with_state(|state| {
        state
            .tokens
            .get(token)
            .map(|data| data.name.clone())
            .unwrap_or_default()
    })
}

pub fn token_data(token: usize) -> Option<TokenData> {
    with_state(|state| state.tokens.get(token).cloned())
}

/// Token-reference items for the trivia attached ahead of a token, as
/// `leadingTriviaRefs` in the canonical port.
pub fn leading_trivia_items(token: usize) -> Vec<Item> {
    with_state(|state| {
        state
            .tokens
            .get(token)
            .map(|data| data.leading.iter().map(|id| Item::Token(*id)).collect())
            .unwrap_or_default()
    })
}

/// Push a token onto a node, leading trivia first, as
/// `pushTokenWithTrivia` does.
pub fn push_token_with_trivia(node: usize, token: usize) {
    for item in leading_trivia_items(token) {
        push_child(node, item);
    }
    push_child(node, Item::Token(token));
}

/// How deep [`realize`] will descend before it gives up.
///
/// The walk is recursive, as the value it builds is, and a Rust stack
/// overflow aborts the process rather than unwinding. Two inputs reach
/// that: source nested deeply enough that its tree is, and a tree that
/// is not a tree at all. `int a = b ? c : d;` builds a
/// `conditional_expression` holding ITSELF among its descendants, in
/// all three ports, so a walk over it never ends. The realized value's
/// own `to_json` and `Drop` recurse over the same shape afterwards, so
/// the bound has to hold for them too.
///
/// The number is MEASURED rather than copied. A translation unit of N
/// nested compound statements realizes at depth `N + 2`, and an
/// unoptimized build costs a little under 1 KiB of stack per level:
///
/// | thread stack | deepest that survived | first that aborted |
/// |---|---|---|
/// | 1 MiB (small) | 302 | 402 |
/// | 2 MiB (a spawned thread's default) | 402 | 802 |
/// | 8 MiB (the main thread's default) | 1202 | past the cap |
///
/// The cap sits below the smallest of those with room to spare, so the
/// bound holds wherever the parse runs rather than only on the main
/// thread. It is still far past any C anyone writes: no fixture in
/// `test/spec` and no program in the 100-program CSmith corpus reaches
/// a tenth of it.
pub const REALIZE_DEPTH_CAP: usize = 256;

thread_local! {
    // Set when a realize walk stopped at the cap, cleared when one
    // starts. `crate::parse_with` reads it and fails the parse rather
    // than handing back a tree with a hole in it.
    static REALIZE_TRUNCATED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };

    // What each node realized to, for the length of one walk.
    //
    // The tree is a DAG, not a tree: an expression node sits in its
    // parent's `children` AND under the parent's `left`, `right`,
    // `cond`, `then` or `else`, which is how the canonical hands
    // callers both views of the same object. JavaScript shares the
    // reference, so building the value costs nothing extra there. A
    // straight port re-walks the node once per path, which is
    // EXPONENTIAL in expression depth: a CSmith translation unit, whose
    // expressions nest dozens deep, never finished. Realizing each node
    // once and handing out the same value restores the sharing, and an
    // engine container is behind an `Arc`, so the copy is a refcount.
    static REALIZED: RefCell<HashMap<usize, Value>> = RefCell::new(HashMap::new());
}

/// True when the last [`realize`] walk on this thread stopped at
/// [`REALIZE_DEPTH_CAP`], so the value it returned is incomplete.
pub fn realize_truncated() -> bool {
    REALIZE_TRUNCATED.with(|cell| cell.get())
}

/// Realize an arena handle into the plain engine value the caller sees.
/// Values that are not handles pass through unchanged, so a tree that
/// mixes CST nodes with engine values realizes correctly.
///
/// A walk that runs out of depth answers with a value that stops short
/// of the whole tree. [`crate::parse_with`] and [`crate::parse_with_meta`]
/// check for that and report the engine's `cancel` code rather than hand
/// back a tree with a hole in it; a caller driving a `tabnas` instance
/// itself gets the same answer from `realize_truncated` in this module.
pub fn realize(value: &Value) -> Value {
    REALIZE_TRUNCATED.with(|cell| cell.set(false));
    REALIZED.with(|memo| memo.borrow_mut().clear());
    let out = realize_at(value, 0);
    // The memo names arena ids, and the next parse reuses them, so it
    // cannot outlive this walk.
    REALIZED.with(|memo| memo.borrow_mut().clear());
    out
}

fn realize_at(value: &Value, depth: usize) -> Value {
    if depth >= REALIZE_DEPTH_CAP {
        REALIZE_TRUNCATED.with(|cell| cell.set(true));
        return Value::Null;
    }
    if let Some(node) = handle_node(value) {
        return realize_node(node, depth);
    }
    if let Some(token) = handle_token(value) {
        return realize_token(token);
    }
    match value {
        Value::Array(items) => Value::array(
            items
                .iter()
                .map(|item| realize_at(item, depth + 1))
                .collect::<Vec<_>>(),
        ),
        Value::ListRef(list) => Value::array(
            list.value
                .iter()
                .map(|item| realize_at(item, depth + 1))
                .collect::<Vec<_>>(),
        ),
        Value::Object(entries) => Value::object(
            entries
                .iter()
                .map(|(key, entry)| (key.clone(), realize_at(entry, depth + 1)))
                .collect::<IndexMap<_, _>>(),
        ),
        Value::MapRef(map) => Value::object(
            map.value
                .iter()
                .map(|(key, entry)| (key.clone(), realize_at(entry, depth + 1)))
                .collect::<IndexMap<_, _>>(),
        ),
        other => other.clone(),
    }
}

fn realize_item(item: &Item, depth: usize) -> Value {
    if depth >= REALIZE_DEPTH_CAP {
        REALIZE_TRUNCATED.with(|cell| cell.set(true));
        return Value::Null;
    }
    match item {
        Item::Node(id) => realize_node(*id, depth),
        Item::Token(id) => realize_token(*id),
        Item::Val(value) => realize_at(value, depth),
        Item::List(items) => Value::array(
            items
                .iter()
                .map(|item| realize_item(item, depth + 1))
                .collect::<Vec<_>>(),
        ),
    }
}

fn realize_token(token: usize) -> Value {
    let Some(data) = token_data(token) else {
        return Value::Null;
    };
    let mut entries = IndexMap::new();
    entries.insert("kind".to_string(), Value::String("token".to_string()));
    entries.insert("tname".to_string(), Value::String(data.name));
    entries.insert("src".to_string(), Value::String(data.src));
    entries.insert("span".to_string(), data.span.to_value());
    Value::object(entries)
}

fn realize_node(node: usize, depth: usize) -> Value {
    if depth >= REALIZE_DEPTH_CAP {
        REALIZE_TRUNCATED.with(|cell| cell.set(true));
        return Value::Null;
    }
    if let Some(done) = REALIZED.with(|memo| memo.borrow().get(&node).cloned()) {
        return done;
    }
    let Some(data) = with_state(|state| state.nodes.get(node).cloned()) else {
        return Value::Null;
    };
    // Whether the walk truncated is asked of THIS subtree, not of the
    // walk so far: the flag is saved and cleared here, and restored
    // below with this subtree's answer folded in. A sticky flag would
    // read at the memo line as "this value has a hole in it" for every
    // node realized after the first truncation ANYWHERE, so nothing
    // would be memoized from that point on -- and an un-memoized walk
    // over a DAG re-walks each node once per path that reaches it,
    // which on a CSmith translation unit is the difference between a
    // fraction of a second and exhausting the machine.
    let outer_truncated = REALIZE_TRUNCATED.with(|cell| cell.replace(false));
    let mut entries = IndexMap::new();
    entries.insert("kind".to_string(), Value::String(data.kind));
    entries.insert("span".to_string(), data.span.to_value());
    entries.insert(
        "children".to_string(),
        Value::array(
            data.children
                .iter()
                .map(|item| realize_item(item, depth + 1))
                .collect::<Vec<_>>(),
        ),
    );
    let mut trivia = IndexMap::new();
    trivia.insert(
        "leading".to_string(),
        Value::array(
            data.leading
                .iter()
                .map(|item| realize_item(item, depth + 1))
                .collect::<Vec<_>>(),
        ),
    );
    trivia.insert(
        "trailing".to_string(),
        Value::array(
            data.trailing
                .iter()
                .map(|item| realize_item(item, depth + 1))
                .collect::<Vec<_>>(),
        ),
    );
    entries.insert("trivia".to_string(), Value::object(trivia));
    for (key, item) in data.extras.iter() {
        entries.insert(key.clone(), realize_item(item, depth + 1));
    }
    let out = Value::object(entries);
    // Only a subtree that finished is worth keeping: one that stopped
    // at the cap built a value with a hole in it, and a shallower path
    // to the same node must be free to build the whole thing.
    let truncated_here = REALIZE_TRUNCATED.with(|cell| cell.get());
    REALIZE_TRUNCATED.with(|cell| cell.set(outer_truncated || truncated_here));
    if !truncated_here {
        REALIZED.with(|memo| memo.borrow_mut().insert(node, out.clone()));
    }
    out
}
