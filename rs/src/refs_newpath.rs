/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The structured dispatch path: the lookahead validator that routes a
//! declaration away from the legacy chomp, then declarations,
//! declarators, specifiers, parameters and initializers.
//!
//! Port of the corresponding half of `makeGrammarRefs` in
//! `ts/src/c.ts`.

use tabnas::{Context, Lexer, Rule, Value};

use crate::cst::{self, Item};
use crate::refs::Reg;
use crate::rt::*;
use crate::sets;
use crate::state::{handle_node, with_state};
use crate::COptions;

/// Walk past a tagged-type specifier (`struct`, `union`, `enum`)
/// starting at the keyword: the optional tag, the optional C23
/// `: utype` of an enum, and the optional balanced body.
fn skip_tagged_spec(
    context: &mut Context,
    rule: &mut Rule,
    lexer: &mut Lexer<'_>,
    from: usize,
) -> usize {
    let mut index = from;
    let head_name = match context.t.get(index) {
        Some(token) => token.name.as_str().to_string(),
        None => match fetch_deep(context, rule, lexer, index) {
            Some(token) => token.name.as_str().to_string(),
            None => return index,
        },
    };
    if !matches!(head_name.as_str(), "KW_STRUCT" | "KW_UNION" | "KW_ENUM") {
        return index;
    }
    index += 1;
    index = skip_leading_attributes(context, rule, lexer, index);
    let tag = deep_name(context, rule, lexer, index);
    if matches!(tag.as_str(), "ID" | "TYPEDEF_NAME" | "MACRO_NAME") {
        index += 1;
    }
    if head_name == "KW_ENUM" && deep_name(context, rule, lexer, index) == "PUNC_COLON" {
        index += 1;
        loop {
            let name = deep_name(context, rule, lexer, index);
            if name.is_empty() || !sets::SIMPLE_TYPE_HEAD.contains(&name.as_str()) {
                break;
            }
            index += 1;
        }
    }
    if deep_name(context, rule, lexer, index) == "PUNC_LBRACE" {
        let mut depth = 0i32;
        let start = index;
        while index < start + 4096 {
            let Some(token) = fetch_deep(context, rule, lexer, index) else {
                break;
            };
            match token.name.as_str() {
                "PUNC_LBRACE" => depth += 1,
                "PUNC_RBRACE" => {
                    depth -= 1;
                    if depth == 0 {
                        index += 1;
                        break;
                    }
                }
                _ => {}
            }
            index += 1;
        }
    }
    index
}

/// Walk past any number of leading attribute specifications.
///
/// The leading check reads the lookahead buffer DIRECTLY, never the
/// deep fetch, so a token that is not an attribute returns without
/// growing the buffer; the deep fetch is reached only once an
/// attribute keyword is confirmed. The body scan is bounded, so one
/// call cannot grow the buffer without limit.
fn skip_leading_attributes(
    context: &mut Context,
    rule: &mut Rule,
    lexer: &mut Lexer<'_>,
    from: usize,
) -> usize {
    let mut index = from;
    loop {
        let Some(token) = context.t.get(index) else {
            return index;
        };
        let name = token.name.as_str().to_string();
        if matches!(
            name.as_str(),
            "KW___ATTRIBUTE__" | "KW___ATTRIBUTE" | "KW___DECLSPEC"
        ) {
            let bound = index + 64;
            let opener = fetch_at(context, rule, lexer, index + 1, bound)
                .map(|token| token.name.as_str().to_string());
            if opener.as_deref() != Some("PUNC_LPAREN") {
                return index;
            }
            let mut scan = index + 1;
            let mut depth = 0i32;
            let mut saw_close = false;
            loop {
                let Some(token) = fetch_at(context, rule, lexer, scan, bound) else {
                    break;
                };
                match token.name.as_str() {
                    "PUNC_LPAREN" => depth += 1,
                    "PUNC_RPAREN" => {
                        depth -= 1;
                        if depth == 0 {
                            scan += 1;
                            saw_close = true;
                            break;
                        }
                    }
                    _ => {}
                }
                scan += 1;
            }
            if !saw_close {
                return index;
            }
            // Reach a little past the attribute body so the caller's
            // post-attribute lookups do not fall off the dispatch
            // window. Eight tokens cover the usual tail.
            for step in 0..8 {
                fetch_at(context, rule, lexer, scan + step, bound);
            }
            index = scan;
            continue;
        }
        if name == "PUNC_LBRACKET" {
            if t_name(context, index + 1) != "PUNC_LBRACKET" || !t_adjacent(context, index) {
                return index;
            }
            let bound = index + 64;
            let mut scan = index + 2;
            let mut depth = 0i32;
            let mut saw_close = false;
            loop {
                let Some(token) = fetch_at(context, rule, lexer, scan, bound) else {
                    break;
                };
                match token.name.as_str() {
                    "PUNC_LBRACKET" => depth += 1,
                    "PUNC_RBRACKET" => {
                        let next = fetch_at(context, rule, lexer, scan + 1, bound);
                        let adjacent = next.as_ref().is_some_and(|next| {
                            next.name.as_str() == "PUNC_RBRACKET"
                                && token.site.si + token.len == next.site.si
                        });
                        if depth == 0 && adjacent {
                            scan += 2;
                            saw_close = true;
                            break;
                        }
                        depth -= 1;
                    }
                    _ => {}
                }
                scan += 1;
            }
            if !saw_close {
                return index;
            }
            for step in 0..8 {
                fetch_at(context, rule, lexer, scan + step, bound);
            }
            index = scan;
            continue;
        }
        return index;
    }
}

/// The lookahead token at `index`, reading the buffer when it is long
/// enough and lexing further only while `index` stays within `bound`.
fn fetch_at(
    context: &mut Context,
    rule: &mut Rule,
    lexer: &mut Lexer<'_>,
    index: usize,
    bound: usize,
) -> Option<tabnas::Token> {
    if index < context.t.len() {
        return context
            .t
            .get(index)
            .filter(|token| !token.name.as_str().is_empty() && token.tin >= 0)
            .cloned();
    }
    if index <= bound {
        return fetch_deep(context, rule, lexer, index);
    }
    None
}

/// Walk a function body from its `{` and answer whether every token
/// through the matching `}` is one `block_item` can structure.
fn is_function_body_supported(
    context: &mut Context,
    rule: &mut Rule,
    lexer: &mut Lexer<'_>,
    lbrace: usize,
) -> bool {
    let mut depth = 0i32;
    for index in lbrace..lbrace + 4096 {
        let Some(token) = fetch_deep(context, rule, lexer, index) else {
            return false;
        };
        let name = token.name.as_str();
        if name == "#ZZ" || sets::UNSUPPORTED_BODY_TOKENS.contains(&name) {
            return false;
        }
        if name == "PUNC_LBRACE" {
            depth += 1;
            continue;
        }
        if name == "PUNC_RBRACE" {
            depth -= 1;
            if depth == 0 {
                return true;
            }
        }
    }
    false
}

/// The dispatch validator: optional attributes, an optional storage
/// prefix, one or more type specifiers, then a declarator shape this
/// path can structure. Port of `@looks-simple-decl`.
fn looks_simple_decl(rule: &mut Rule, context: &mut Context, lexer: &mut Lexer<'_>) -> bool {
    if !crate::refs::first_iteration(rule) {
        return false;
    }
    let mut index = 0usize;
    index = skip_leading_attributes(context, rule, lexer, index);
    if sets::STORAGE_PREFIX.contains(&t_name(context, index).as_str()) {
        index += 1;
    }
    index = skip_leading_attributes(context, rule, lexer, index);
    let type_start = index;
    while index < 256 {
        let name = deep_name(context, rule, lexer, index);
        if name.is_empty() {
            break;
        }
        if matches!(name.as_str(), "KW_STRUCT" | "KW_UNION" | "KW_ENUM") {
            let before = index;
            index = skip_tagged_spec(context, rule, lexer, index);
            if index == before {
                break;
            }
            continue;
        }
        if sets::SIMPLE_TYPE_HEAD.contains(&name.as_str()) {
            index += 1;
            continue;
        }
        // C23 `_BitInt(N)`: the keyword and its parenthesised width
        // are one specifier, so the terminator check that follows
        // looks at the right token.
        if name == "KW__BITINT" {
            index += 1;
            if deep_name(context, rule, lexer, index) != "PUNC_LPAREN" {
                return false;
            }
            let mut depth = 1i32;
            index += 1;
            while index < FETCH_DEEP_CAP && depth > 0 {
                let inner = deep_name(context, rule, lexer, index);
                if inner.is_empty() {
                    return false;
                }
                if inner == "PUNC_LPAREN" {
                    depth += 1;
                } else if inner == "PUNC_RPAREN" {
                    depth -= 1;
                }
                index += 1;
            }
            if depth != 0 {
                return false;
            }
            continue;
        }
        index = skip_leading_attributes(context, rule, lexer, index);
        if index != type_start && deep_name(context, rule, lexer, index) == name {
            break;
        }
        let before_attributes = index;
        index = skip_leading_attributes(context, rule, lexer, index);
        if index == before_attributes {
            break;
        }
    }
    if index == type_start {
        return false;
    }
    // A tag body routes to the legacy path, because the grammar's
    // struct and enum body parsing costs far more memory than the
    // legacy opaque absorption on a large translation unit. A
    // standalone tag reference still flows through the check below,
    // which reads the buffer rather than lexing further.
    if t_name(context, index) == "PUNC_SEMI" {
        return true;
    }
    if t_name(context, index) == "PUNC_LPAREN" {
        // A parenthesised compound declarator, in three shapes: a
        // function pointer, a pointer to an array, and an array of
        // function pointers.
        let mut scan = index + 1;
        if deep_name(context, rule, lexer, scan) != "PUNC_STAR" {
            return false;
        }
        while scan < index + 8 && deep_name(context, rule, lexer, scan) == "PUNC_STAR" {
            scan += 1;
        }
        let inner = deep_name(context, rule, lexer, scan);
        if !matches!(inner.as_str(), "ID" | "TYPEDEF_NAME" | "MACRO_NAME") {
            return false;
        }
        scan += 1;
        while deep_name(context, rule, lexer, scan) == "PUNC_LBRACKET" {
            let mut depth = 1i32;
            scan += 1;
            while scan < FETCH_DEEP_CAP && depth > 0 {
                let name = deep_name(context, rule, lexer, scan);
                if name.is_empty() {
                    return false;
                }
                if name == "PUNC_LBRACKET" {
                    depth += 1;
                } else if name == "PUNC_RBRACKET" {
                    depth -= 1;
                }
                scan += 1;
            }
            if depth != 0 {
                return false;
            }
        }
        if deep_name(context, rule, lexer, scan) != "PUNC_RPAREN" {
            return false;
        }
        scan += 1;
        let first_postfix = deep_name(context, rule, lexer, scan);
        if first_postfix != "PUNC_LPAREN" && first_postfix != "PUNC_LBRACKET" {
            return false;
        }
        loop {
            let start = deep_name(context, rule, lexer, scan);
            if start != "PUNC_LPAREN" && start != "PUNC_LBRACKET" {
                break;
            }
            let closer = if start == "PUNC_LPAREN" {
                "PUNC_RPAREN"
            } else {
                "PUNC_RBRACKET"
            };
            let mut depth = 0i32;
            let mut closed = false;
            while scan < FETCH_DEEP_CAP {
                let name = deep_name(context, rule, lexer, scan);
                if name.is_empty() {
                    return false;
                }
                if name == start {
                    depth += 1;
                } else if name == closer {
                    depth -= 1;
                }
                if depth == 0 && name != start {
                    closed = true;
                    break;
                }
                scan += 1;
            }
            if !closed {
                return false;
            }
            scan += 1;
        }
        // Only the plain `;` terminator for now: an initializer or a
        // body on a compound declarator stays on the legacy path.
        return deep_name(context, rule, lexer, scan) == "PUNC_SEMI";
    }
    // An optional pointer prefix on the first declarator: any number
    // of `*`, each optionally followed by the type qualifiers that
    // bind to the pointer.
    let saw_pointer = deep_name(context, rule, lexer, index) == "PUNC_STAR";
    while index < 64 {
        let name = deep_name(context, rule, lexer, index);
        if name == "PUNC_STAR" {
            index += 1;
            continue;
        }
        if matches!(
            name.as_str(),
            "KW_CONST" | "KW_VOLATILE" | "KW_RESTRICT" | "KW__ATOMIC"
        ) {
            if !saw_pointer {
                break;
            }
            index += 1;
            continue;
        }
        break;
    }
    let declared = deep_name(context, rule, lexer, index);
    if !matches!(declared.as_str(), "ID" | "TYPEDEF_NAME" | "MACRO_NAME") {
        return false;
    }
    index += 1;
    let after = deep_name(context, rule, lexer, index);
    if !matches!(
        after.as_str(),
        "PUNC_SEMI" | "PUNC_ASSIGN" | "PUNC_COMMA" | "PUNC_LBRACKET" | "PUNC_LPAREN"
    ) {
        return false;
    }
    if after == "PUNC_LBRACKET" {
        // Walk past consecutive balanced bracket pairs to find what
        // follows them.
        let mut scan = index;
        loop {
            let mut depth = 0i32;
            let mut closed = false;
            while scan < 32 {
                let name = deep_name(context, rule, lexer, scan);
                if name.is_empty() {
                    return false;
                }
                if name == "PUNC_LBRACKET" {
                    depth += 1;
                } else if name == "PUNC_RBRACKET" {
                    depth -= 1;
                }
                if depth == 0 && name != "PUNC_LBRACKET" {
                    closed = true;
                    break;
                }
                scan += 1;
            }
            if !closed {
                return false;
            }
            let next = deep_name(context, rule, lexer, scan + 1);
            if next.is_empty() {
                return false;
            }
            if next != "PUNC_LBRACKET" {
                break;
            }
            scan += 1;
        }
    }
    if after == "PUNC_LPAREN" {
        // Walk the balanced parentheses to the matching `)`, then
        // accept `;` (a declaration) or `{` (a definition), the
        // latter only when the body is one this path can structure.
        let mut depth = 0i32;
        let mut scan = index;
        let mut closed = false;
        const SAFETY: usize = 4096;
        while scan < index + SAFETY {
            let name = deep_name(context, rule, lexer, scan);
            if name.is_empty() || name == "#ZZ" {
                return false;
            }
            if name == "PUNC_LPAREN" {
                depth += 1;
            } else if name == "PUNC_RPAREN" {
                depth -= 1;
            }
            if depth == 0 && name != "PUNC_LPAREN" {
                closed = true;
                break;
            }
            scan += 1;
        }
        if !closed {
            return false;
        }
        let post = deep_name(context, rule, lexer, scan + 1);
        if post != "PUNC_SEMI" && post != "PUNC_LBRACE" {
            return false;
        }
        if post == "PUNC_LBRACE" && !is_function_body_supported(context, rule, lexer, scan + 1) {
            return false;
        }
    }
    true
}

/// The declaration rule that owns the per-declaration scaffolding,
/// whether the handler fires on the declaration itself or on its
/// specifier loop.
pub fn spec_owner_u_node(rule: &Rule, key: &str) -> Option<usize> {
    if matches!(
        rule.name.as_str(),
        "simple_declaration" | "struct_declaration"
    ) {
        u_node(rule, key)
    } else {
        parent_u_node(rule, key)
    }
}

/// The per-statement `k` keys a fresh control-flow rule clears, so a
/// nested statement does not read the enclosing one's progress.
pub fn clear_stmt_state(rule: &mut Rule) {
    for key in [
        "tookCond",
        "tookBody",
        "tookThen",
        "elseSeen",
        "tookElse",
        "tookWhile",
        "tookSemi",
        "tookInit",
        "tookIter",
        "tookControls",
    ] {
        k_del(rule, key);
    }
}

pub fn register(reg: &mut Reg<'_>, options: &COptions) {
    let _ = options;

    reg.cond_lex("@looks-simple-decl", looks_simple_decl);

    // --- the close action when the structured path was taken ---------
    reg.act("@finalize-new-path", |rule, context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let Some(node) = node_id(rule) else {
            return;
        };
        let name = child_name(rule);
        // A standalone directive or declaration form keeps the
        // structured node as the single child of the external
        // declaration; a simple declaration splices its children for
        // the historic shape.
        let wrap_as_single = name == "static_assert_declaration" || name == "asm_statement";
        if wrap_as_single {
            cst::set_children(node, vec![Item::Node(child)]);
            cst::set_extra(node, "declKind", Item::str("declaration"));
        } else {
            cst::set_children(node, cst::children_of(child));
            let decl_kind =
                cst::extra_of(child, "declKind").unwrap_or_else(|| Item::str("declaration"));
            cst::set_extra(node, "declKind", decl_kind);
        }
        cst::set_extra(node, "viaPath", Item::str("grammar"));
        // Register every declared name as a typedef when the child's
        // specifier list carried `typedef`.
        let Some(child_rule) = rule.child_rule.clone() else {
            return;
        };
        let specs = child_rule.u.get("specs").and_then(handle_node);
        if !specs.is_some_and(|specs| node_flag(specs, "isTypedef")) {
            return;
        }
        let names: Vec<String> = match child_rule.u.get("declaredNames") {
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => Some(text.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        for name in names {
            with_state(|state| state.symbols.bind_typedef(&name));
            crate::refs::reclassify(context, &name, "ID", "TYPEDEF_NAME");
        }
    });

    // --- simple_declaration ------------------------------------------
    reg.act("@simple_declaration-bo", |rule, _context| {
        let node = cst::new_node("declaration", None);
        cst::set_extra(node, "declKind", Item::str("declaration"));
        set_node_id(rule, node);
        let specs = cst::new_node("declaration_specifiers", None);
        let idl = cst::new_node("init_declarator_list", None);
        u_set_node(rule, "specs", specs);
        u_set_node(rule, "idl", idl);
        // Strip stale per-rule state the shallow copy at every rule
        // transition can leak in: an enumerator list's node from an
        // earlier declaration would otherwise make a re-entry guard
        // misfire.
        for key in [
            "ssNode",
            "ssKwTaken",
            "ssTagTaken",
            "ssBodyTaken",
            "esNode",
            "esKwTaken",
            "esTagTaken",
            "esUtypeTaken",
            "esBodyTaken",
            "esUtypeAttached",
            "elNode",
            "elOpened",
            "takenEnums",
            "mdlNode",
            "mdlOpened",
            "takenSecs",
            "takenItems",
            "ilNode",
            "ilOpened",
            "iiNode",
            "hasDesig",
            "tookEq",
            "declarator",
            "directDeclarator",
            "lastPointer",
        ] {
            k_del(rule, key);
        }
        clear_stmt_state(rule);
    });

    reg.act("@absorb-spec-storage", |rule, _context| {
        let (Some(specs), Some(token)) = (spec_owner_u_node(rule, "specs"), o0(rule)) else {
            return;
        };
        push_token(specs, token);
        if cst::token_name(token) == "KW_TYPEDEF" {
            set_node_flag(specs, "isTypedef", true);
        }
    });
    reg.act("@absorb-spec-type", |rule, _context| {
        if let (Some(specs), Some(token)) = (spec_owner_u_node(rule, "specs"), o0(rule)) {
            push_token(specs, token);
        }
    });

    // --- bit_int_paren (C23 `_BitInt(N)`) ----------------------------
    reg.act("@bip-take-lparen", |rule, _context| {
        if let (Some(specs), Some(token)) = (spec_owner_u_node(rule, "specs"), o0(rule)) {
            push_token(specs, token);
        }
    });
    reg.act("@bip-mark-val", |_rule, _context| {});
    reg.act("@bit_int_paren-bc", |rule, _context| {
        if k_bool(rule, "bipValAttached") || !child_is_val(rule) {
            return;
        }
        let (Some(child), Some(specs)) = (child_node_id(rule), spec_owner_u_node(rule, "specs"))
        else {
            return;
        };
        cst::push_child(specs, Item::Node(child));
        k_set_bool(rule, "bipValAttached", true);
    });
    reg.act("@bip-take-rparen", |rule, _context| {
        if let (Some(specs), Some(token)) = (spec_owner_u_node(rule, "specs"), c0(rule)) {
            push_token(specs, token);
        }
    });

    reg.act("@simple-decl-take-comma", |rule, _context| {
        if let (Some(idl), Some(token)) = (u_node(rule, "idl"), c0(rule)) {
            push_token(idl, token);
        }
    });

    // --- init_declarator ---------------------------------------------
    reg.act("@init_declarator-bo", |rule, _context| {
        // The `r:` re-entry keeps the node built before the name was
        // captured, so only a first entry initialises. The
        // scaffolding lives on `k`, which survives the re-entry.
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "init_declarator") {
            return;
        }
        let node = cst::new_node("init_declarator", None);
        set_node_id(rule, node);
        let declarator = cst::new_node("declarator", None);
        let direct = cst::new_node("direct_declarator", None);
        k_set_node(rule, "declarator", declarator);
        k_set_node(rule, "directDeclarator", direct);
    });

    reg.act("@idecl-name", |rule, _context| {
        let Some(token) = state_token(rule) else {
            return;
        };
        let (Some(declarator), Some(direct), Some(node)) = (
            k_node(rule, "declarator"),
            k_node(rule, "directDeclarator"),
            node_id(rule),
        ) else {
            return;
        };
        let name = cst::token_src(token);
        push_token(direct, token);
        cst::set_extra(direct, "declaredName", Item::str(name.clone()));
        cst::push_child(declarator, Item::Node(direct));
        cst::set_extra(declarator, "declaredName", Item::str(name.clone()));
        cst::push_child(node, Item::Node(declarator));
        cst::set_extra(node, "declaredName", Item::str(name));
        k_set_bool(rule, "named", true);
    });
    reg.cond("@idecl-named", |rule, _context| k_bool(rule, "named"));

    reg.act("@idecl-paren-open", |rule, _context| {
        let (Some(token), Some(declarator), Some(direct), Some(node)) = (
            o0(rule),
            k_node(rule, "declarator"),
            k_node(rule, "directDeclarator"),
            node_id(rule),
        ) else {
            return;
        };
        push_token(direct, token);
        cst::push_child(declarator, Item::Node(direct));
        cst::push_child(node, Item::Node(declarator));
        k_set_bool(rule, "idclParenPending", true);
    });
    reg.cond("@idecl-paren-pending", |rule, _context| {
        k_bool(rule, "idclParenPending") && !k_bool(rule, "parenClosed")
    });
    reg.act("@idecl-paren-close", |rule, _context| {
        if let (Some(token), Some(direct)) = (c0(rule), k_node(rule, "directDeclarator")) {
            push_token(direct, token);
        }
        k_set_bool(rule, "parenClosed", true);
        k_set_bool(rule, "named", true);
    });

    // --- paren_inner_declarator --------------------------------------
    reg.act("@paren_inner_declarator-bo", |rule, _context| {
        // The `r:` re-entry copies the PARENT's `k`, so the outer
        // declarator is visible here. A guard on `k.declarator` would
        // alias the inner declarator with the outer one and build a
        // cycle; the marker is specific to this rule instead.
        if k_bool(rule, "pidInit") {
            return;
        }
        k_set_bool(rule, "pidInit", true);
        let declarator = cst::new_node("declarator", None);
        let direct = cst::new_node("direct_declarator", None);
        k_set_node(rule, "declarator", declarator);
        k_set_node(rule, "directDeclarator", direct);
    });
    reg.cond("@pid-named", |rule, _context| k_bool(rule, "named"));
    reg.act("@pid-name", |rule, _context| {
        let Some(token) = state_token(rule) else {
            return;
        };
        let (Some(declarator), Some(direct)) =
            (k_node(rule, "declarator"), k_node(rule, "directDeclarator"))
        else {
            return;
        };
        let name = cst::token_src(token);
        push_token(direct, token);
        cst::set_extra(direct, "declaredName", Item::str(name.clone()));
        cst::push_child(declarator, Item::Node(direct));
        cst::set_extra(declarator, "declaredName", Item::str(name.clone()));
        k_set_bool(rule, "named", true);
        // Attach the finished inner declarator onto the outer direct
        // declarator, between the `(` and the `)`.
        if k_bool(rule, "attached") {
            return;
        }
        if let Some(outer_direct) = parent_k_node(rule, "directDeclarator") {
            cst::push_child(outer_direct, Item::Node(declarator));
            cst::set_extra(outer_direct, "declaredName", Item::str(name.clone()));
        }
        if let Some(outer_declarator) = parent_k_node(rule, "declarator") {
            cst::set_extra(outer_declarator, "declaredName", Item::str(name.clone()));
        }
        if let Some(outer_node) = parent_node(rule) {
            cst::set_extra(outer_node, "declaredName", Item::str(name));
        }
        k_set_bool(rule, "attached", true);
    });

    // --- pointers -----------------------------------------------------
    reg.act("@absorb-pointer", |rule, _context| {
        let Some(token) = o0(rule) else {
            return;
        };
        let pointer = node_from_token("pointer", token);
        if let Some(declarator) = parent_k_node(rule, "declarator") {
            cst::push_child(declarator, Item::Node(pointer));
        }
        k_set_node(rule, "lastPointer", pointer);
    });
    reg.act("@absorb-pq-const", |rule, _context| {
        if let (Some(pointer), Some(token)) = (parent_k_node(rule, "lastPointer"), o0(rule)) {
            push_token(pointer, token);
        }
    });

    // --- array_postfix -------------------------------------------------
    reg.act("@array_postfix-bo", |rule, _context| {
        let node = cst::new_node("array_postfix", None);
        set_node_id(rule, node);
    });
    reg.act("@arr-open", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@arr-close", |rule, _context| {
        let Some(node) = node_id(rule) else {
            return;
        };
        if let Some(token) = c0(rule) {
            push_token(node, token);
        }
        // Attach the array postfix to the owning declarator shell: an
        // init declarator keeps `directDeclarator`, a parameter
        // declaration keeps `declarator`.
        if let Some(direct) = parent_k_node(rule, "directDeclarator") {
            cst::push_child(direct, Item::Node(node));
        } else if let Some(declarator) = parent_k_node(rule, "declarator") {
            cst::push_child(declarator, Item::Node(node));
        }
    });
    reg.act("@arrq-take", |rule, _context| {
        if let (Some(owner), Some(token)) = (parent_node(rule), o0(rule)) {
            push_token(owner, token);
        }
    });
    reg.act("@array_postfix-bc", |rule, _context| {
        if !child_is_val(rule) || u_node(rule, "size").is_some() {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        cst::push_child(node, Item::Node(child));
        u_set_node(rule, "size", child);
    });

    // --- function_postfix ----------------------------------------------
    reg.act("@function_postfix-bo", |rule, _context| {
        let node = cst::new_node("function_postfix", None);
        set_node_id(rule, node);
        let ptl = cst::new_node("parameter_type_list", None);
        k_set_node(rule, "ptl", ptl);
    });
    reg.act("@fn-open", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@fn-close", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        if let (Some(direct), Some(node)) = (parent_k_node(rule, "directDeclarator"), node_id(rule))
        {
            cst::push_child(direct, Item::Node(node));
        }
    });
    reg.act("@ptl-attach-and-end", |rule, _context| {
        let (Some(ptl), Some(function)) = (parent_k_node(rule, "ptl"), parent_node(rule)) else {
            return;
        };
        if cst::child_count(ptl) > 0 {
            cst::push_child(function, Item::Node(ptl));
        }
    });
    reg.act("@ptl-comma", |rule, _context| {
        if let (Some(ptl), Some(token)) = (parent_k_node(rule, "ptl"), c0(rule)) {
            push_token(ptl, token);
        }
    });

    // --- identifier_list (the K&R prototype) ----------------------------
    reg.act("@identifier_list-bo", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "identifier_list") {
            return;
        }
        let node = cst::new_node("identifier_list", None);
        set_node_id(rule, node);
    });
    reg.act("@idlist-take", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), state_token(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@idlist-comma", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@idlist-attach", |rule, _context| {
        if let (Some(function), Some(node)) = (parent_node(rule), node_id(rule)) {
            cst::push_child(function, Item::Node(node));
        }
    });

    reg.act("@ptl-take-ellipsis", |rule, _context| {
        let (Some(ptl), Some(function)) = (parent_k_node(rule, "ptl"), parent_node(rule)) else {
            return;
        };
        if let Some(token) = c0(rule) {
            push_token(ptl, token);
        }
        if let Some(token) = rule.c1().map(cst::intern_token) {
            let variadic = node_from_token("parameter_variadic", token);
            cst::push_child(ptl, Item::Node(variadic));
        }
        cst::set_extra(ptl, "variadic", Item::bool(true));
        if cst::child_count(ptl) > 0 {
            cst::push_child(function, Item::Node(ptl));
        }
    });

    // --- parameter_declaration --------------------------------------------
    reg.act("@parameter_declaration-bo", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "parameter_declaration") {
            return;
        }
        let node = cst::new_node("parameter_declaration", None);
        set_node_id(rule, node);
        let specs = cst::new_node("declaration_specifiers", None);
        k_set_node(rule, "specs", specs);
        // The shallow copy from the pushing rule makes the OUTER
        // declarator visible here; clear it so this parameter's close
        // does not splice the outer declarator into its own children.
        k_del(rule, "declarator");
        k_del(rule, "directDeclarator");
        k_set_bool(rule, "assembled", false);
        k_set_bool(rule, "named", false);
    });
    reg.cond("@param-reentered", |rule, _context| {
        k_node(rule, "declarator").is_some()
    });
    reg.act("@param-spec", |rule, _context| {
        let specs = if rule.name.as_str() == "parameter_declaration" {
            k_node(rule, "specs")
        } else {
            parent_k_node(rule, "specs")
        };
        if let (Some(specs), Some(token)) = (specs, o0(rule)) {
            push_token(specs, token);
        }
    });
    reg.act("@param-name", |rule, _context| {
        let (Some(token), Some(node)) = (c0(rule), node_id(rule)) else {
            return;
        };
        let name = cst::token_src(token);
        cst::set_extra(node, "declaredName", Item::str(name.clone()));
        let direct = node_from_token("direct_declarator", token);
        cst::set_extra(direct, "declaredName", Item::str(name.clone()));
        match k_node(rule, "declarator") {
            Some(declarator) => {
                cst::push_child(declarator, Item::Node(direct));
                cst::set_extra(declarator, "declaredName", Item::str(name));
            }
            None => {
                let declarator = cst::new_node("declarator", None);
                cst::push_child(declarator, Item::Node(direct));
                cst::set_extra(declarator, "declaredName", Item::str(name));
                k_set_node(rule, "declarator", declarator);
            }
        }
    });
    reg.act("@param-pointer", |rule, _context| {
        let declarator = match k_node(rule, "declarator") {
            Some(declarator) => declarator,
            None => {
                let declarator = cst::new_node("declarator", None);
                k_set_node(rule, "declarator", declarator);
                declarator
            }
        };
        let Some(token) = c0(rule) else {
            return;
        };
        let pointer = node_from_token("pointer", token);
        cst::push_child(declarator, Item::Node(pointer));
        k_set_node(rule, "lastPointer", pointer);
    });
    reg.cond("@param-has-pointer", |rule, _context| {
        k_node(rule, "lastPointer").is_some()
    });
    reg.act("@param-pointer-qual", |rule, _context| {
        if let (Some(pointer), Some(token)) = (k_node(rule, "lastPointer"), c0(rule)) {
            push_token(pointer, token);
        }
    });

    reg.act("@param-paren-open", |rule, _context| {
        let declarator = match k_node(rule, "declarator") {
            Some(declarator) => declarator,
            None => {
                let declarator = cst::new_node("declarator", None);
                k_set_node(rule, "declarator", declarator);
                declarator
            }
        };
        if let Some(token) = c0(rule) {
            push_token(declarator, token);
        }
        k_set_bool(rule, "paramParenPending", true);
    });
    reg.cond("@param-paren-pending", |rule, _context| {
        k_bool(rule, "paramParenPending")
    });
    reg.cond("@param-can-paren-form", |rule, _context| {
        !k_bool(rule, "paramParenDone") && !k_bool(rule, "paramParenPending")
    });
    reg.act("@param-paren-close", |rule, _context| {
        let Some(declarator) = k_node(rule, "declarator") else {
            return;
        };
        if let Some(token) = c0(rule) {
            push_token(declarator, token);
        }
        k_set_bool(rule, "paramParenPending", false);
        k_set_bool(rule, "paramParenDone", true);
    });
    reg.cond("@param-need-fn-postfix", |rule, _context| {
        k_bool(rule, "paramParenDone") && !k_bool(rule, "paramFnPostfixDone")
    });

    // --- param_paren_inner --------------------------------------------
    reg.cond("@ppi-named", |rule, _context| k_bool(rule, "ppiNamed"));
    reg.act("@ppi-pointer", |rule, _context| {
        // `c0` on an open-state alt: the canonical getter answers with
        // the engine's no-token sentinel rather than nothing, and the
        // fixtures pin the empty token it pushes onto the pointer.
        let token = c0(rule).unwrap_or_else(cst::no_token);
        let pointer = node_from_token("pointer", token);
        if let Some(declarator) = parent_k_node(rule, "declarator") {
            cst::push_child(declarator, Item::Node(pointer));
        }
        k_set_node(rule, "lastPointer", pointer);
    });
    reg.cond("@ppi-has-pointer", |rule, _context| {
        k_node(rule, "lastPointer").is_some()
    });
    reg.act("@ppi-pointer-qual", |rule, _context| {
        if let (Some(pointer), Some(token)) = (k_node(rule, "lastPointer"), state_token(rule)) {
            push_token(pointer, token);
        }
    });
    reg.act("@ppi-name", |rule, _context| {
        let Some(token) = state_token(rule) else {
            return;
        };
        let name = cst::token_src(token);
        let direct = node_from_token("direct_declarator", token);
        cst::set_extra(direct, "declaredName", Item::str(name.clone()));
        if let Some(declarator) = parent_k_node(rule, "declarator") {
            cst::push_child(declarator, Item::Node(direct));
            cst::set_extra(declarator, "declaredName", Item::str(name.clone()));
        }
        if let Some(owner) = parent_node(rule) {
            cst::set_extra(owner, "declaredName", Item::str(name));
        }
        k_set_bool(rule, "ppiNamed", true);
    });

    reg.act("@parameter_declaration-bc", |rule, _context| {
        let Some(node) = node_id(rule) else {
            return;
        };
        if !k_bool(rule, "specsAttached") {
            if let Some(specs) = k_node(rule, "specs") {
                cst::push_child(node, Item::Node(specs));
            }
            k_set_bool(rule, "specsAttached", true);
        }
        if !k_bool(rule, "declAttached") {
            if let Some(declarator) = k_node(rule, "declarator") {
                cst::push_child(node, Item::Node(declarator));
                k_set_bool(rule, "declAttached", true);
            }
        }
        // Push into the enclosing parameter type list on completion,
        // guarding against the repeated closes of the pointer-prefix
        // recursion.
        if k_bool(rule, "ptlAttached") || parent_name(rule) != "parameter_type_list" {
            return;
        }
        if let Some(ptl) = grandparent_k_node(rule, "ptl") {
            cst::push_child(ptl, Item::Node(node));
            k_set_bool(rule, "ptlAttached", true);
        }
    });

    // --- initializers ----------------------------------------------------
    reg.act("@idecl-take-eq", |rule, _context| {
        let Some(token) = c0(rule) else {
            return;
        };
        let trivia = cst::leading_trivia_items(token);
        rule.u_mut().insert(
            "eqTrivia".to_string(),
            Value::array(trivia.iter().map(Item::to_handle).collect::<Vec<_>>()),
        );
        rule.u_mut()
            .insert("eqTokenRef".to_string(), crate::state::token_handle(token));
        u_set_bool(rule, "hasInit", true);
    });
    reg.act("@init_declarator-bc", |rule, _context| {
        if !u_bool(rule, "hasInit") {
            return;
        }
        let (Some(child), Some(node)) = (child_node_id(rule), node_id(rule)) else {
            return;
        };
        let init = if cst::kind_of(child) == "initializer" {
            child
        } else {
            let wrapped = cst::new_node("initializer", None);
            cst::push_child(wrapped, Item::Node(child));
            wrapped
        };
        if let Some(Value::Array(items)) = rule.u.get("eqTrivia") {
            for item in items.iter() {
                cst::push_child(node, Item::from_value(item));
            }
        }
        if let Some(token) = rule
            .u
            .get("eqTokenRef")
            .and_then(crate::state::handle_token)
        {
            cst::push_child(node, Item::Token(token));
        }
        cst::push_child(node, Item::Node(init));
    });
    reg.act("@initializer-bo", |rule, _context| {
        let node = cst::new_node("initializer", None);
        set_node_id(rule, node);
    });
    reg.act("@initializer-bc", |rule, _context| {
        if let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) {
            cst::push_child(node, Item::Node(child));
        }
    });

    reg.act("@simple_declaration-bc", |rule, _context| {
        let name = child_name(rule);
        let child = child_node_id(rule);
        if name == "init_declarator" {
            if let Some(child) = child.filter(|child| cst::kind_of(*child) == "init_declarator") {
                if let Some(idl) = u_node(rule, "idl") {
                    cst::push_child(idl, Item::Node(child));
                }
                if let Some(Item::Val(Value::String(declared))) =
                    cst::extra_of(child, "declaredName")
                {
                    let mut names: Vec<Value> = match rule.u.get("declaredNames") {
                        Some(Value::Array(items)) => items.as_ref().clone(),
                        _ => Vec::new(),
                    };
                    names.push(Value::String(declared.clone()));
                    rule.u_mut()
                        .insert("declaredNames".to_string(), Value::array(names));
                    if rule.u.get("declaredName").is_none() {
                        rule.u_mut()
                            .insert("declaredName".to_string(), Value::String(declared));
                    }
                }
            }
        }
        if matches!(name.as_str(), "struct_specifier" | "enum_specifier")
            && !u_bool(rule, "taggedSpecAttached")
        {
            if let (Some(child), Some(specs)) = (child, u_node(rule, "specs")) {
                cst::push_child(specs, Item::Node(child));
                u_set_bool(rule, "taggedSpecAttached", true);
            }
        }
        if name == "compound_statement" && u_node(rule, "fnBody").is_none() {
            if let Some(child) = child.filter(|child| cst::kind_of(*child) == "compound_statement")
            {
                u_set_node(rule, "fnBody", child);
            }
        }
    });

    reg.act("@simple-decl-finalize", |rule, _context| {
        let Some(node) = node_id(rule) else {
            return;
        };
        if let Some(specs) = u_node(rule, "specs") {
            cst::push_child(node, Item::Node(specs));
        }
        // The init declarator list is emitted only when it holds a
        // declarator: a standalone tag definition has none, and the
        // legacy tree omits the wrapper entirely.
        if let Some(idl) = u_node(rule, "idl") {
            if cst::child_count(idl) > 0 {
                cst::push_child(node, Item::Node(idl));
            }
        }
        if let Some(token) = c0(rule) {
            push_token(node, token);
        }
    });

    // --- function definitions ------------------------------------------
    reg.act("@simple-decl-start-fn-body", |rule, _context| {
        u_set_bool(rule, "startedFnBody", true);
    });
    reg.cond("@fn-body-done", |rule, _context| {
        u_node(rule, "fnBody").is_some() && !u_bool(rule, "fnDefDone")
    });
    reg.act("@simple-decl-finalize-fn", |rule, _context| {
        u_set_bool(rule, "fnDefDone", true);
        let Some(node) = node_id(rule) else {
            return;
        };
        cst::set_extra(node, "declKind", Item::str("function_definition"));
        if let Some(specs) = u_node(rule, "specs") {
            cst::push_child(node, Item::Node(specs));
        }
        // Lift the declarator out of the single init declarator: the
        // legacy tree places it directly under the external
        // declaration, beside the specifiers and the body.
        if let Some(idl) = u_node(rule, "idl") {
            let children = cst::children_of(idl);
            if let Some(first) = children.first().and_then(Item::as_node) {
                if cst::kind_of(first) == "init_declarator" {
                    if let Some(declarator) = cst::children_of(first)
                        .first()
                        .and_then(Item::as_node)
                        .filter(|child| cst::kind_of(*child) == "declarator")
                    {
                        cst::push_child(node, Item::Node(declarator));
                    }
                }
            }
        }
        if let Some(body) = u_node(rule, "fnBody") {
            cst::push_child(node, Item::Node(body));
        }
    });

    crate::refs_stmt::register(reg);
}
