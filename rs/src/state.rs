/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! Per-parse state: the symbol and macro tables, the lexer mode flags,
//! the pending-trivia buffer, and the arena the concrete syntax tree is
//! built in.
//!
//! Port of `ts/src/symbols.ts`, plus the arena this port needs and the
//! other two do not. The canonical parser hangs all of this off
//! `ctx.meta.cmeta` as live JavaScript objects that lex matchers and
//! rule actions mutate through shared references. An engine `Value`
//! here is copied on write and cannot hold a native handle, so the
//! state lives in a thread local instead and the values that travel
//! through the parse are HANDLES into it. This is the same device the
//! `tabnas-expr` port uses for its expression nodes, for the same
//! reason.
//!
//! A parse owns the thread local for its duration: `reset` runs from
//! the engine's parse-prepare hook, and the tree is realized into plain
//! engine values at the parse boundary (see [`crate::cst::realize`]).

use std::cell::RefCell;
use std::collections::HashMap;

use indexmap::IndexMap;
use tabnas::Value;

use crate::cst::{NodeData, TokenData};

/// The kind of scope a binding was made in. Inner scopes shadow outer
/// ones, and lookups walk the stack outward.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeKind {
    File,
    FnProto,
    FnBody,
    Block,
    StructUnion,
    Enum,
    ForInit,
}

/// What a name is bound to in a scope. Ordinary bindings matter because
/// an inner non-typedef declaration of a name hides an outer typedef.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binding {
    Typedef,
    Ordinary,
}

/// A struct, union or enum tag. Tags live in their own namespace in C.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagKind {
    Struct,
    Union,
    Enum,
}

#[derive(Debug, Clone)]
pub struct Scope {
    #[allow(dead_code)]
    pub kind: ScopeKind,
    pub bind: HashMap<String, Binding>,
    pub tags: HashMap<String, TagKind>,
}

/// The classic identifier / typedef-name disambiguation table.
#[derive(Debug, Clone)]
pub struct SymbolTable {
    stack: Vec<Scope>,
}

impl Default for SymbolTable {
    fn default() -> Self {
        Self::new()
    }
}

impl SymbolTable {
    pub fn new() -> Self {
        Self {
            stack: vec![Scope {
                kind: ScopeKind::File,
                bind: HashMap::new(),
                tags: HashMap::new(),
            }],
        }
    }

    pub fn enter(&mut self, kind: ScopeKind) {
        self.stack.push(Scope {
            kind,
            bind: HashMap::new(),
            tags: HashMap::new(),
        });
    }

    pub fn exit(&mut self) {
        // The file scope is never popped.
        if self.stack.len() <= 1 {
            return;
        }
        self.stack.pop();
    }

    #[allow(dead_code)]
    pub fn depth(&self) -> usize {
        self.stack.len()
    }

    /// True when `name` resolves to a typedef-name in any visible
    /// scope, with the innermost binding winning.
    pub fn is_typedef(&self, name: &str) -> bool {
        for scope in self.stack.iter().rev() {
            if let Some(binding) = scope.bind.get(name) {
                return *binding == Binding::Typedef;
            }
        }
        false
    }

    /// True when `name` is bound at all, as a typedef or otherwise.
    pub fn is_bound(&self, name: &str) -> bool {
        self.stack
            .iter()
            .rev()
            .any(|scope| scope.bind.contains_key(name))
    }

    pub fn bind_typedef(&mut self, name: &str) {
        if let Some(scope) = self.stack.last_mut() {
            scope.bind.insert(name.to_string(), Binding::Typedef);
        }
    }

    pub fn bind_ordinary(&mut self, name: &str) {
        if let Some(scope) = self.stack.last_mut() {
            scope.bind.insert(name.to_string(), Binding::Ordinary);
        }
    }

    pub fn bind_tag(&mut self, name: &str, kind: TagKind) {
        if let Some(scope) = self.stack.last_mut() {
            scope.tags.insert(name.to_string(), kind);
        }
    }

    /// Every name bound as a typedef in any visible scope, innermost
    /// binding winning, in no particular order. This is what a
    /// [`crate::CMeta`] carries into a parse.
    pub fn typedef_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for scope in self.stack.iter().rev() {
            for (name, binding) in &scope.bind {
                if seen.insert(name.as_str()) && *binding == Binding::Typedef {
                    names.push(name.clone());
                }
            }
        }
        names.sort();
        names
    }

    #[allow(dead_code)]
    pub fn has_tag(&self, name: &str) -> bool {
        self.stack
            .iter()
            .rev()
            .any(|scope| scope.tags.contains_key(name))
    }
}

/// A macro definition captured from a `#define` directive. Macros are
/// not expanded: the table only says which names are macros, so a call
/// site can be tagged.
#[derive(Debug, Clone, Default)]
pub struct MacroDef {
    #[allow(dead_code)]
    pub name: String,
    #[allow(dead_code)]
    pub is_function_like: bool,
    #[allow(dead_code)]
    pub params: Vec<String>,
    #[allow(dead_code)]
    pub variadic: bool,
}

#[derive(Debug, Clone, Default)]
pub struct MacroTable {
    defs: IndexMap<String, MacroDef>,
}

impl MacroTable {
    pub fn define(&mut self, def: MacroDef) {
        self.defs.insert(def.name.clone(), def);
    }

    pub fn undefine(&mut self, name: &str) {
        self.defs.shift_remove(name);
    }

    pub fn has(&self, name: &str) -> bool {
        self.defs.contains_key(name)
    }

    /// Every defined macro name, in definition order.
    pub fn names(&self) -> Vec<String> {
        self.defs.keys().cloned().collect()
    }
}

/// Lex-mode flags the matchers read to know whether they are inside a
/// preprocessor directive line.
#[derive(Debug, Clone, Default)]
pub struct LexMode {
    /// True between the start-of-logical-line `#` and the terminating
    /// newline.
    pub in_directive: bool,
    /// True when the next token inside a directive should be lexed as a
    /// header name.
    pub expect_header_name: bool,
    /// The directive name currently being parsed, or `None`.
    pub directive_name: Option<String>,
}

/// Everything a C parse keeps beside the engine's own state.
#[derive(Debug, Default)]
pub struct CState {
    pub symbols: SymbolTable,
    pub macros: MacroTable,
    pub mode: LexMode,
    /// Trivia tokens emitted since the last non-trivia token, as arena
    /// ids. The lex subscriber drains this onto the next token.
    pub pending_trivia: Vec<usize>,
    /// The concrete syntax tree under construction.
    pub nodes: Vec<NodeData>,
    /// Every token the parse has handed to a rule action.
    pub tokens: Vec<TokenData>,
    /// Token lists a rule keeps on its `k` bag. A JavaScript array is
    /// shared by reference between a rule and the rules it pushes or
    /// replaces into, and an engine `Value` is copied on write, so the
    /// bag holds the id of a list kept here instead.
    pub lists: Vec<Vec<usize>>,
    /// Flags a handler sets on a node rather than on a rule. The
    /// canonical handlers write a few of these onto a PARENT rule's `u`
    /// bag; a parent reaches this port only as a snapshot, whose bags
    /// are copies, so the flag rides on a node both rules can see.
    pub flags: HashMap<(usize, String), bool>,
    /// The arena id of the no-token sentinel, once something has asked
    /// for it. See `cst::no_token`.
    pub no_token: Option<usize>,
    /// Set while a parse is running, so a nested parse (the grammar
    /// document is itself parsed by jsonic) cannot reset the arena.
    pub active: bool,
    /// Set when a walk over the tree gave up rather than recursing
    /// past what the stack holds. `crate::parse_with` reads it and
    /// fails the parse instead of handing back a tree with a hole in
    /// it. See `crate::REALIZE_DEPTH_CAP`.
    pub gave_up: bool,
    /// The whole source as characters, with the address and length it
    /// was built from.
    ///
    /// The canonical matchers index the source with `charCodeAt`, which
    /// costs nothing. A Rust `&str` cannot be indexed by character, so
    /// the matchers here work over a `[char]`, and building that per
    /// call, for every matcher, at every token, made the parse cost grow
    /// with the SQUARE of the input: 40 KB of C took a minute. It is
    /// built once per parse instead and handed out as a shared slice.
    ///
    /// The key is the source's address and length. Two live sources
    /// cannot share both, and `reset` clears this at the start of every
    /// parse, so a stale entry cannot outlive the text it came from.
    pub source_chars: Option<(usize, usize, std::rc::Rc<Vec<char>>)>,
}

impl CState {
    fn fresh() -> Self {
        Self {
            symbols: SymbolTable::new(),
            macros: MacroTable::default(),
            mode: LexMode::default(),
            pending_trivia: Vec::new(),
            nodes: Vec::new(),
            tokens: Vec::new(),
            lists: Vec::new(),
            flags: HashMap::new(),
            no_token: None,
            active: false,
            gave_up: false,
            source_chars: None,
        }
    }
}

thread_local! {
    static STATE: RefCell<CState> = RefCell::new(CState::fresh());
}

/// Run `body` with the parse state. Keep the closure short: the state
/// is a `RefCell`, so a nested borrow panics.
pub fn with_state<R>(body: impl FnOnce(&mut CState) -> R) -> R {
    STATE.with(|state| body(&mut state.borrow_mut()))
}

/// Start a parse: clear everything the previous one left behind.
pub fn reset() {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        *state = CState::fresh();
        state.active = true;
    });
    crate::rt::reset_lookahead();
}

/// The value that stands for a node in the engine's value tree.
pub fn node_handle(id: usize) -> Value {
    let mut entries = IndexMap::new();
    entries.insert(crate::cst::NODE_KEY.to_string(), Value::Number(id as f64));
    Value::object(entries)
}

/// The value that stands for a token in the engine's value tree.
pub fn token_handle(id: usize) -> Value {
    let mut entries = IndexMap::new();
    entries.insert(crate::cst::TOKEN_KEY.to_string(), Value::Number(id as f64));
    Value::object(entries)
}

/// The node id a handle names, or `None` when the value is something
/// else.
pub fn handle_node(value: &Value) -> Option<usize> {
    handle_id(value, crate::cst::NODE_KEY)
}

/// The token id a handle names, or `None`.
pub fn handle_token(value: &Value) -> Option<usize> {
    handle_id(value, crate::cst::TOKEN_KEY)
}

fn handle_id(value: &Value, key: &str) -> Option<usize> {
    let Value::Object(entries) = value else {
        return None;
    };
    if entries.len() != 1 {
        return None;
    }
    match entries.get(key) {
        Some(Value::Number(id)) if *id >= 0.0 => Some(*id as usize),
        _ => None,
    }
}
