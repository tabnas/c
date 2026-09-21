/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The `@`-named conditions, actions and lifecycle handlers the grammar
//! document binds. Port of `makeGrammarRefs` in `ts/src/c.ts`.
//!
//! The `@<rule>-bo` / `-ao` / `-bc` / `-ac` entries wire themselves onto
//! their rule when the document installs; the rest are named from an
//! alternate's `a:` or `c:` field.

use tabnas::{Context, Lexer, Rule, Tabnas, Value};

use crate::cst::{self, Item};
use crate::rt::*;
use crate::sets;
use crate::state::with_state;
use crate::COptions;

/// The registry a port module registers through. It remembers every
/// name, so `stub_remaining` can tell which references the grammar
/// document still names without a handler.
pub struct Reg<'a> {
    pub parser: &'a mut Tabnas,
    conditions: std::collections::HashSet<String>,
    actions: std::collections::HashSet<String>,
}

impl Reg<'_> {
    /// Register a condition.
    pub fn cond(
        &mut self,
        name: &str,
        body: impl Fn(&mut Rule, &mut Context) -> bool + Send + Sync + 'static,
    ) {
        self.parser.alt_condition(name, body);
        self.conditions.insert(name.to_string());
    }

    /// Register a condition that walks the lookahead through the live
    /// lexer.
    pub fn cond_lex(
        &mut self,
        name: &str,
        body: impl for<'source> Fn(&mut Rule, &mut Context, &mut Lexer<'source>) -> bool
            + Send
            + Sync
            + 'static,
    ) {
        self.parser.alt_condition_with_lexer(name, body);
        self.conditions.insert(name.to_string());
    }

    /// Register an action, or a lifecycle handler: the engine takes
    /// both from the same table.
    pub fn act(
        &mut self,
        name: &str,
        body: impl Fn(&mut Rule, &mut Context) + Send + Sync + 'static,
    ) {
        self.parser.action_with_context(name, move |rule, context| {
            body(rule, context);
            Ok(())
        });
        self.actions.insert(name.to_string());
    }
}

/// Register every reference the grammar names, and return the ones it
/// names that got a no-op stub rather than a handler.
pub fn register(parser: &mut Tabnas, options: &COptions) -> Vec<String> {
    let mut reg = Reg {
        parser,
        conditions: std::collections::HashSet::new(),
        actions: std::collections::HashSet::new(),
    };
    register_core(&mut reg, options);
    crate::refs_newpath::register(&mut reg, options);
    crate::refs_ext::register(&mut reg, options);
    crate::expr_grammar::register(&mut reg);
    stub_remaining(&mut reg)
}

fn register_core(reg: &mut Reg<'_>, options: &COptions) {
    let extended = options.extended;

    // --- the extension gate ------------------------------------------
    reg.cond("@extended-on", move |_rule, _context| extended);
    reg.cond("@extended-off", move |_rule, _context| !extended);
    reg.cond("@ext-and-first-iter", move |rule, _context| {
        extended && first_iteration(rule)
    });

    // --- translation_unit --------------------------------------------
    reg.act("@translation_unit-bo", |rule, _context| {
        let node = cst::new_node("translation_unit", None);
        set_node_id(rule, node);
    });
    reg.act("@translation_unit-bc", |rule, _context| {
        if let Some(node) = node_id(rule) {
            crate::conditional_groups::structure_conditional_groups(node);
        }
    });

    // --- extdecl_loop -------------------------------------------------
    // The node is inherited from translation_unit; the before-close
    // pushes the completed external_declaration before deciding to
    // recurse.
    reg.act("@extdecl_loop-bc", |rule, _context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        if cst::kind_of(child) != "external_declaration" {
            return;
        }
        if let Some(node) = node_id(rule) {
            append_child(node, child);
        }
    });

    // --- external_declaration ----------------------------------------
    // The before-open runs once per fresh rule instance, the `r:`
    // recursion included, so it is guarded: the in-progress token list
    // must survive an iteration.
    reg.act("@external_declaration-bo", |rule, _context| {
        ensure_node(rule, "external_declaration");
        k_list(rule, "tokens");
        if !k_has(rule, "depth") {
            k_set_num(rule, "depth", 0);
        }
        if !k_has(rule, "terminated") {
            k_set_bool(rule, "terminated", false);
        }
    });

    reg.act("@absorb-token", |rule, _context| {
        let Some(token) = o0(rule) else {
            return;
        };
        let Some(node) = node_id(rule) else {
            return;
        };
        let list = k_list(rule, "tokens");
        for trivia in cst::leading_trivia_items(token) {
            if let Some(id) = trivia.as_token() {
                cst::push_child(node, Item::Token(id));
                list_push(list, id);
            }
        }
        list_push(list, token);
        cst::push_child(node, Item::Token(token));
        k_set_bool(rule, "justClosedBrace", false);
        let name = cst::token_name(token);
        if name == "PUNC_LBRACE" {
            let depth = k_num(rule, "depth") + 1;
            k_set_num(rule, "depth", depth);
        } else if name == "PUNC_RBRACE" {
            let depth = k_num(rule, "depth") - 1;
            k_set_num(rule, "depth", depth);
            if depth <= 0 {
                // A closing top-level brace ends a function body, but a
                // struct, union, enum or compound literal is followed
                // by more tokens. The close alternates decide, with
                // lookahead: see `@just-closed-and-decl-ahead`.
                k_set_bool(rule, "justClosedBrace", true);
            }
        } else if name == "PUNC_SEMI" && k_num(rule, "depth") == 0 {
            k_set_bool(rule, "terminated", true);
        } else if name == "PP_NEWLINE"
            && k_num(rule, "depth") == 0
            && first_non_trivia_is(&list_get(list), "PP_HASH")
        {
            // The directive line ends here: every `#` line is its own
            // external declaration.
            k_set_bool(rule, "terminated", true);
        }
    });

    reg.cond("@terminated", |rule, _context| k_bool(rule, "terminated"));
    reg.cond("@just-closed-and-decl-ahead", |rule, context| {
        k_bool(rule, "justClosedBrace") && starts_new_external_declaration(context)
    });
    reg.act("@finalize-extdecl", |rule, context| {
        finalize_external_declaration(rule, context);
    });

    // --- new-path dispatch markers ------------------------------------
    reg.act("@mark-new-path", |rule, _context| {
        u_set_bool(rule, "newPath", true);
    });
    reg.cond("@new-path", |rule, _context| u_bool(rule, "newPath"));
    reg.cond("@is-first-iter", |rule, _context| first_iteration(rule));
    reg.cond("@plain-and-first-iter", move |rule, _context| {
        !extended && first_iteration(rule)
    });
    reg.cond("@plain-as23-and-first", move |rule, context| {
        if extended {
            return false;
        }
        if !first_iteration(rule) {
            return false;
        }
        t_adjacent(context, 0)
    });
}

/// True when the chomp's token buffer is still empty, which is what
/// "first iteration of this external_declaration" means.
pub fn first_iteration(rule: &Rule) -> bool {
    match k_list_opt(rule, "tokens") {
        None => true,
        Some(list) => list_len(list) == 0,
    }
}

// ---------------------------------------------------------------------
// The chomp finaliser and its helpers
// ---------------------------------------------------------------------

/// Index of the matching closing punctuator for the opener at `from`,
/// or `None` when the run is unbalanced.
pub fn match_close(tokens: &[usize], from: usize, open: &str, close: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (index, token) in tokens.iter().enumerate().skip(from) {
        let name = cst::token_name(*token);
        if name == open {
            depth += 1;
        } else if name == close {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

/// The declared name inside a declarator slice, or `None`.
///
/// A declarator is `pointer* direct_declarator postfix*`; the first
/// identifier after the pointers and qualifiers is the declared name,
/// and a parenthesised subdeclarator recurses.
pub fn find_declared_name(tokens: &[usize]) -> Option<String> {
    let mut index = 0;
    while index < tokens.len() {
        let name = cst::token_name(tokens[index]);
        if sets::is_trivia(&name) || name == "PUNC_STAR" {
            index += 1;
            continue;
        }
        if sets::PTR_QUALIFIER_TOKEN_NAMES.contains(&name.as_str()) {
            index += 1;
            continue;
        }
        // A compiler attribute or an asm label inside a declarator:
        // walk past the balanced parenthesis group.
        if matches!(
            name.as_str(),
            "KW___ATTRIBUTE__"
                | "KW___ATTRIBUTE"
                | "KW___ASM__"
                | "KW___ASM"
                | "KW_ASM"
                | "KW___DECLSPEC"
        ) {
            let mut next = index + 1;
            while next < tokens.len() && sets::is_trivia(&cst::token_name(tokens[next])) {
                next += 1;
            }
            if next < tokens.len() && cst::token_name(tokens[next]) == "PUNC_LPAREN" {
                let close = match_close(tokens, next, "PUNC_LPAREN", "PUNC_RPAREN")?;
                index = close + 1;
                continue;
            }
            index += 1;
            continue;
        }
        if name == "PUNC_LPAREN" {
            let close = match_close(tokens, index, "PUNC_LPAREN", "PUNC_RPAREN")?;
            // Tell a parenthesised subdeclarator from a function
            // parameter list. A parameter list starts with a type
            // specifier, `void` or `)`; a subdeclarator starts with
            // `*`, `(`, an attribute spec, or an ordinary identifier.
            let inner = &tokens[index + 1..close];
            let first = inner
                .iter()
                .map(|token| cst::token_name(*token))
                .find(|name| !sets::is_trivia(name));
            let looks_like_subdeclarator = first.as_deref().is_some_and(|first| {
                matches!(
                    first,
                    "PUNC_STAR" | "PUNC_LPAREN" | "KW___ATTRIBUTE__" | "KW___ATTRIBUTE" | "ID"
                )
            });
            if looks_like_subdeclarator {
                if let Some(inner_name) = find_declared_name(inner) {
                    return Some(inner_name);
                }
            }
            index = close + 1;
            continue;
        }
        if name == "PUNC_LBRACKET" {
            let close = match_close(tokens, index, "PUNC_LBRACKET", "PUNC_RBRACKET")?;
            index = close + 1;
            continue;
        }
        if name == "ID" || name == "TYPEDEF_NAME" {
            return Some(cst::token_src(tokens[index]));
        }
        return None;
    }
    None
}

/// Split an init-declarator list at its top-level commas.
pub fn split_declarators(tokens: &[usize]) -> Vec<Vec<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut paren = 0i32;
    let mut bracket = 0i32;
    let mut brace = 0i32;
    for (index, token) in tokens.iter().enumerate() {
        match cst::token_name(*token).as_str() {
            "PUNC_LPAREN" => paren += 1,
            "PUNC_RPAREN" => paren -= 1,
            "PUNC_LBRACKET" => bracket += 1,
            "PUNC_RBRACKET" => bracket -= 1,
            "PUNC_LBRACE" => brace += 1,
            "PUNC_RBRACE" => brace -= 1,
            "PUNC_COMMA" if paren == 0 && bracket == 0 && brace == 0 => {
                out.push(tokens[start..index].to_vec());
                start = index + 1;
            }
            _ => {}
        }
    }
    out.push(tokens[start..].to_vec());
    out
}

/// The declarator part of an init-declarator: everything before the
/// first top-level `=`.
pub fn declarator_part(tokens: &[usize]) -> Vec<usize> {
    let mut paren = 0i32;
    let mut bracket = 0i32;
    for (index, token) in tokens.iter().enumerate() {
        match cst::token_name(*token).as_str() {
            "PUNC_LPAREN" => paren += 1,
            "PUNC_RPAREN" => paren -= 1,
            "PUNC_LBRACKET" => bracket += 1,
            "PUNC_RBRACKET" => bracket -= 1,
            "PUNC_ASSIGN" if paren == 0 && bracket == 0 => {
                return tokens[..index].to_vec();
            }
            _ => {}
        }
    }
    tokens.to_vec()
}

/// The boundary between the declaration specifiers and the first
/// declarator: the index of the first token that is not a specifier.
pub fn find_spec_boundary(tokens: &[usize]) -> usize {
    let mut index = 0;
    let mut saw_typedef_name = false;
    while index < tokens.len() {
        let name = cst::token_name(tokens[index]);
        if sets::is_trivia(&name) {
            index += 1;
            continue;
        }
        // After a typedef name, a following identifier belongs to the
        // declarator.
        if name == "TYPEDEF_NAME" {
            if saw_typedef_name {
                return index;
            }
            saw_typedef_name = true;
            index += 1;
            continue;
        }
        if matches!(name.as_str(), "KW_STRUCT" | "KW_UNION" | "KW_ENUM") {
            index += 1;
            while index < tokens.len() && sets::is_trivia(&cst::token_name(tokens[index])) {
                index += 1;
            }
            if index < tokens.len()
                && matches!(
                    cst::token_name(tokens[index]).as_str(),
                    "ID" | "TYPEDEF_NAME"
                )
            {
                index += 1;
            }
            while index < tokens.len() && sets::is_trivia(&cst::token_name(tokens[index])) {
                index += 1;
            }
            if index < tokens.len() && cst::token_name(tokens[index]) == "PUNC_LBRACE" {
                let Some(close) = match_close(tokens, index, "PUNC_LBRACE", "PUNC_RBRACE") else {
                    return tokens.len();
                };
                index = close + 1;
            }
            continue;
        }
        if sets::is_specifier_kw(&name) && name != "TYPEDEF_NAME" {
            index += 1;
            continue;
        }
        // `__attribute__((...))` or `__declspec(...)` attached to the
        // declaration is part of the specifiers.
        if matches!(
            name.as_str(),
            "KW___ATTRIBUTE__" | "KW___ATTRIBUTE" | "KW___DECLSPEC"
        ) {
            index += 1;
            while index < tokens.len() && sets::is_trivia(&cst::token_name(tokens[index])) {
                index += 1;
            }
            if index < tokens.len() && cst::token_name(tokens[index]) == "PUNC_LPAREN" {
                let Some(close) = match_close(tokens, index, "PUNC_LPAREN", "PUNC_RPAREN") else {
                    return tokens.len();
                };
                index = close + 1;
            }
            continue;
        }
        return index;
    }
    index
}

/// Bind every name a `typedef` declaration declares.
pub fn register_typedef_if_applicable(tokens: &[usize], context: &mut Context) {
    let filtered: Vec<usize> = tokens
        .iter()
        .copied()
        .filter(|token| !sets::is_trivia(&cst::token_name(*token)))
        .collect();
    if filtered.len() < 3 {
        return;
    }
    if cst::token_name(filtered[0]) != "KW_TYPEDEF" {
        return;
    }
    if cst::token_name(filtered[filtered.len() - 1]) != "PUNC_SEMI" {
        return;
    }
    let body = &filtered[..filtered.len() - 1];
    let spec_end = find_spec_boundary(body);
    let declarators = &body[spec_end..];
    if declarators.is_empty() {
        return;
    }
    for declarator in split_declarators(declarators) {
        let just_declarator = declarator_part(&declarator);
        if let Some(name) = find_declared_name(&just_declarator) {
            with_state(|state| state.symbols.bind_typedef(&name));
            reclassify(context, &name, "ID", "TYPEDEF_NAME");
        }
    }
}

/// Run after the chomp terminates an external declaration: register
/// typedef names and try to upgrade the flat token list to a structured
/// tree.
pub fn finalize_external_declaration(rule: &mut Rule, context: &mut Context) {
    let tokens = k_list_tokens(rule, "tokens");
    register_typedef_if_applicable(&tokens, context);
    let Some(node) = node_id(rule) else {
        return;
    };
    match crate::structure::structure_external_declaration(&tokens) {
        Some(structured) => {
            cst::set_children(node, cst::children_of(structured));
            let decl_kind =
                cst::extra_of(structured, "declKind").unwrap_or_else(|| Item::str("unknown"));
            cst::set_extra(node, "declKind", decl_kind);
            cst::set_extra(node, "viaPath", Item::str("legacy"));
            register_macros_from_tree(node, context);
        }
        None => {
            cst::set_extra(node, "declKind", Item::str("unknown"));
            cst::set_extra(node, "viaPath", Item::str("legacy-unknown"));
        }
    }
}

/// Walk a freshly structured node and register every `#define` macro,
/// removing the ones a `#undef` names.
pub fn register_macros_from_tree(node: usize, context: &mut Context) {
    let kind = cst::kind_of(node);
    if kind == "define_directive" {
        if let Some(name) = extra_string(node, "macroName") {
            let function_like = extra_string(node, "macroKind").as_deref() == Some("function-like");
            let params = extra_strings(node, "macroParams");
            let variadic = matches!(
                cst::extra_of(node, "macroVariadic"),
                Some(Item::Val(Value::Bool(true)))
            );
            with_state(|state| {
                state.macros.define(crate::state::MacroDef {
                    name: name.clone(),
                    is_function_like: function_like,
                    params,
                    variadic,
                })
            });
            // Lookahead tokens fetched before this define ran still
            // carry ID; flip them.
            reclassify(context, &name, "ID", "MACRO_NAME");
        }
    } else if kind == "undef_directive" {
        if let Some(name) = extra_string(node, "macroName") {
            with_state(|state| state.macros.undefine(&name));
            reclassify(context, &name, "MACRO_NAME", "ID");
        }
    }
    for child in cst::children_of(node) {
        if let Some(child_node) = child.as_node() {
            register_macros_from_tree(child_node, context);
        }
    }
}

pub fn extra_string(node: usize, key: &str) -> Option<String> {
    match cst::extra_of(node, key) {
        Some(Item::Val(Value::String(text))) => Some(text),
        _ => None,
    }
}

fn extra_strings(node: usize, key: &str) -> Vec<String> {
    match cst::extra_of(node, key) {
        Some(Item::List(items)) => items
            .iter()
            .filter_map(|item| match item {
                Item::Val(Value::String(text)) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Flip already-lexed lookahead tokens whose source is `name` from one
/// token identity to another. The canonical port does the same to
/// `ctx.t` and to the lexer's own pending tokens; this engine keeps
/// only the one lookahead buffer.
pub fn reclassify(context: &mut Context, name: &str, from: &str, to: &str) {
    let Some(to_tin) = context.options.token(to) else {
        return;
    };
    for token in context.t.iter_mut() {
        if token.name.as_str() == from && token.src.as_str() == name {
            token.name = to.into();
            token.tin = to_tin;
        }
    }
}

/// True when the next token to be consumed is one that unambiguously
/// begins a new external declaration. The chomp uses it to decide that
/// a top-level `}` ended a function body.
pub fn starts_new_external_declaration(context: &Context) -> bool {
    for token in context.t.iter() {
        let name = token.name.as_str();
        if sets::is_trivia(name) {
            continue;
        }
        if matches!(name, "#ZZ" | "PP_HASH" | "PUNC_HASH") {
            return true;
        }
        if sets::STORAGE_CLASS_NAMES.contains(&name)
            || sets::TYPE_SPEC_KEYWORD_NAMES.contains(&name)
            || sets::TYPE_QUALIFIER_NAMES.contains(&name)
            || sets::FUNCTION_SPECIFIER_NAMES.contains(&name)
        {
            return true;
        }
        if matches!(
            name,
            "KW___ATTRIBUTE__"
                | "KW___ATTRIBUTE"
                | "KW___DECLSPEC"
                | "KW___EXTENSION__"
                | "TYPEDEF_NAME"
        ) {
            return true;
        }
        // An identifier could be a macro that expands to a declaration,
        // or the declared name of `typedef struct { } S;`. Assume the
        // declaration continues.
        return false;
    }
    false
}

// ---------------------------------------------------------------------
// The stub net
// ---------------------------------------------------------------------

/// Give a typed no-op to every reference the grammar names that has no
/// handler, so the document always installs. Mirrors the Go port's
/// `scanAndStubRefs`. The names are returned so a test can assert the
/// list is empty.
fn stub_remaining(reg: &mut Reg<'_>) -> Vec<String> {
    let mut stubbed = Vec::new();
    let Ok(parsed) = tabnas_jsonic::parse(crate::GRAMMAR_TEXT) else {
        return stubbed;
    };
    let document = parsed.to_json();
    let mut conditions = Vec::new();
    let mut actions = Vec::new();
    collect(&document, &mut conditions, &mut actions);
    conditions.sort();
    conditions.dedup();
    actions.sort();
    actions.dedup();
    for name in conditions {
        if !reg.conditions.contains(&name) {
            reg.parser
                .alt_condition(name.clone(), |_rule, _context| false);
            stubbed.push(name);
        }
    }
    for name in actions {
        if !reg.actions.contains(&name) {
            reg.parser
                .action_with_context(name.clone(), |_rule, _context| Ok(()));
            stubbed.push(name);
        }
    }
    stubbed.sort();
    stubbed
}

fn collect(value: &serde_json::Value, conditions: &mut Vec<String>, actions: &mut Vec<String>) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                collect(item, conditions, actions);
            }
        }
        serde_json::Value::Object(entries) => {
            for (key, entry) in entries {
                match (key.as_str(), entry) {
                    ("c", serde_json::Value::String(name)) if name.starts_with('@') => {
                        conditions.push(name.clone());
                    }
                    ("a", serde_json::Value::String(name)) if name.starts_with('@') => {
                        actions.push(name.clone());
                    }
                    ("a", serde_json::Value::Array(names)) => {
                        for name in names.iter().filter_map(serde_json::Value::as_str) {
                            if name.starts_with('@') {
                                actions.push(name.to_string());
                            }
                        }
                    }
                    _ => {}
                }
                collect(entry, conditions, actions);
            }
        }
        _ => {}
    }
}
