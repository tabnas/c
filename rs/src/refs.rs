/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The `@`-named conditions, actions and lifecycle handlers the grammar
//! document binds. Port of `makeGrammarRefs` in `ts/src/c.ts`.
//!
//! The `@<rule>-bo` / `-ao` / `-bc` / `-ac` entries wire themselves onto
//! their rule when the document installs; the rest are named from an
//! alternate's `a:` or `c:` field.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tabnas::{Context, Lexer, Rule, Tabnas, Value};

use crate::cst::{self, Item};
use crate::fallback::{self, Fallback};
use crate::rt::*;
use crate::sets;
use crate::state::with_state;
use crate::COptions;

type CondFn = Arc<dyn Fn(&mut Rule, &mut Context) -> bool + Send + Sync>;
type CondLexFn =
    Arc<dyn for<'source> Fn(&mut Rule, &mut Context, &mut Lexer<'source>) -> bool + Send + Sync>;

/// The registry a port module registers through. It remembers every
/// name, so `stub_remaining` can tell which references the grammar
/// document still names without a handler, and every condition, so the
/// armed fallback's fenced conditions can call the one they fence.
pub struct Reg<'a> {
    pub parser: &'a mut Tabnas,
    conditions: HashSet<String>,
    actions: HashSet<String>,
    fallback: &'a Fallback,
    cond_fns: HashMap<String, CondFn>,
    cond_lex_fns: HashMap<String, CondLexFn>,
}

impl Reg<'_> {
    /// Register a condition.
    pub fn cond(
        &mut self,
        name: &str,
        body: impl Fn(&mut Rule, &mut Context) -> bool + Send + Sync + 'static,
    ) {
        let body: CondFn = Arc::new(body);
        let call = Arc::clone(&body);
        self.parser
            .alt_condition(name, move |rule, context| call(rule, context));
        self.cond_fns.insert(name.to_string(), body);
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
        let body: CondLexFn = Arc::new(body);
        let call = Arc::clone(&body);
        self.parser
            .alt_condition_with_lexer(name, move |rule, context, lexer| call(rule, context, lexer));
        self.cond_lex_fns.insert(name.to_string(), body);
        self.conditions.insert(name.to_string());
    }

    /// Register an action, or a lifecycle handler: the engine takes
    /// both from the same table. A lifecycle handler of a rule below
    /// `external_declaration` does nothing once the declaration, or the
    /// scope it is in, has failed (`crate::fallback`).
    pub fn act(
        &mut self,
        name: &str,
        body: impl Fn(&mut Rule, &mut Context) + Send + Sync + 'static,
    ) {
        let bails = self.fallback.bails(name);
        self.parser.action_with_context(name, move |rule, context| {
            if bails && fallback::bailing() {
                return Ok(());
            }
            body(rule, context);
            Ok(())
        });
        self.actions.insert(name.to_string());
    }

    /// Bind each fenced condition to the condition it fences, and the
    /// fallback's own references.
    fn bind_fallback(&mut self) {
        for (fenced, inner) in self.fallback.fenced.clone() {
            if let Some(body) = self.cond_fns.get(&inner).cloned() {
                self.parser
                    .alt_condition(fenced.clone(), move |rule, context| {
                        !fallback::fenced(context) && body(rule, context)
                    });
            } else if let Some(body) = self.cond_lex_fns.get(&inner).cloned() {
                self.parser.alt_condition_with_lexer(
                    fenced.clone(),
                    move |rule, context, lexer| {
                        !fallback::fenced(context) && body(rule, context, lexer)
                    },
                );
            } else {
                self.parser
                    .alt_condition(fenced.clone(), |_rule, _context| false);
            }
            self.conditions.insert(fenced);
        }
        self.cond("@c-unfenced", |_rule, context| !fallback::fenced(context));
        self.cond("@c-bailing", |_rule, _context| fallback::bailing());
        self.cond("@c-armed", |_rule, _context| fallback::armed());
        self.act("@c-fail", |_rule, _context| fallback::fail());
    }
}

/// Register every reference the grammar names, and return the ones it
/// names that got a no-op stub rather than a handler.
pub fn register(parser: &mut Tabnas, options: &COptions, fallback: &Fallback) -> Vec<String> {
    let mut reg = Reg {
        parser,
        conditions: HashSet::new(),
        actions: HashSet::new(),
        fallback,
        cond_fns: HashMap::new(),
        cond_lex_fns: HashMap::new(),
    };
    register_core(&mut reg, options);
    crate::expression::register(&mut reg);
    crate::refs_newpath::register(&mut reg, options);
    crate::refs_ext::register(&mut reg, options);
    let stubbed = stub_remaining(&mut reg);
    reg.bind_fallback();
    stubbed
}

fn register_core(reg: &mut Reg<'_>, options: &COptions) {
    let extended = options.extended;

    // --- the extension gate ------------------------------------------
    reg.cond("@extended-on", move |_rule, _context| extended);
    reg.cond("@extended-off", move |_rule, _context| !extended);
    // The plain-mode C23 attribute head: two adjacent `[`.
    reg.cond("@plain-as23", move |_rule, context| {
        !extended && t_adjacent(context, 0)
    });

    // --- translation_unit --------------------------------------------
    reg.act("@translation_unit-bo", |rule, _context| {
        let node = cst::new_node("translation_unit", None);
        set_node_id(rule, node);
    });
    reg.act("@translation_unit-bc", |rule, _context| {
        if let Some(node) = node_id(rule) {
            cst::fix_spans(node);
        }
    });

    // --- extdecl_loop -------------------------------------------------
    // The node is the container's (the translation unit's, or a
    // conditional branch's); the before-close appends each completed
    // external declaration and each conditional group, but a group's
    // opener, which the group takes.
    reg.act("@extdecl_loop-bc", |rule, _context| {
        let Some(id) = child_rule_id(rule) else {
            return;
        };
        if u_num(rule, "lastChild") == Some(id as i64) {
            return;
        }
        u_set_num(rule, "lastChild", id as i64);
        let (Some(child), Some(node)) = (child_node_id(rule), node_id(rule)) else {
            return;
        };
        match cst::kind_of(child).as_str() {
            "external_declaration" => {
                if conditional_of(child, CONDITIONAL_OPENERS).is_some() {
                    u_set_node(rule, "opener", child);
                } else {
                    append_child(node, child);
                }
            }
            "conditional_group" => {
                append_child(node, child);
                // The group took its opener; a parent snapshot cannot
                // clear it here, as the canonical does from the group.
                u_del(rule, "opener");
            }
            _ => {}
        }
    });
    reg.cond("@opens-group", |rule, _context| {
        u_node(rule, "opener").is_some()
    });
    // A branch's items end at the line of the next branch or the `#endif`.
    reg.cond("@ends-branch", |rule, context| {
        k_bool(rule, "inBranch") && directive_ahead(context, CONDITIONAL_BRANCH_ENDS)
    });

    // --- conditional_group ---------------------------------------------
    // The group takes its opener from the items loop that pushed it.
    reg.act("@conditional_group-bo", |rule, _context| {
        let node = cst::new_node("conditional_group", None);
        set_node_id(rule, node);
        if let Some(opener) = parent_u_node(rule, "opener") {
            u_set_node(rule, "opener", opener);
        }
    });
    reg.cond("@next-branch", |_rule, context| {
        directive_ahead(context, CONDITIONAL_BRANCHES)
    });
    reg.cond("@group-endif", |_rule, context| {
        directive_ahead(context, CONDITIONAL_ENDIF)
    });
    reg.cond("@endif-taken", |rule, _context| u_bool(rule, "endifTaken"));
    reg.act("@conditional_group-bc", |rule, _context| {
        let Some(id) = child_rule_id(rule) else {
            return;
        };
        if u_num(rule, "lastChild") == Some(id as i64) {
            return;
        }
        u_set_num(rule, "lastChild", id as i64);
        let (Some(child), Some(node)) = (child_node_id(rule), node_id(rule)) else {
            return;
        };
        match cst::kind_of(child).as_str() {
            "conditional_branch" => {
                append_child(node, child);
                // The first branch took the opener as its head.
                u_del(rule, "opener");
            }
            "external_declaration" => {
                append_child(node, child);
                u_set_bool(rule, "endifTaken", true);
            }
            _ => {}
        }
    });
    reg.act("@cg-end", |rule, _context| {
        if let Some(node) = node_id(rule) {
            cst::fix_spans(node);
        }
    });

    // --- conditional_branch --------------------------------------------
    // The first branch's line is the group's opener; a later branch
    // parses its own.
    reg.act("@conditional_branch-bo", |rule, _context| {
        let node = cst::new_node("conditional_branch", None);
        set_node_id(rule, node);
        if let Some(opener) = parent_u_node(rule, "opener") {
            take_branch_head(rule, node, opener);
        }
    });
    reg.cond("@branch-has-head", |rule, _context| {
        u_bool(rule, "headTaken")
    });
    reg.cond("@branch-needs-items", |rule, _context| {
        u_bool(rule, "headTaken") && !u_bool(rule, "itemsTaken")
    });
    reg.act("@conditional_branch-bc", |rule, _context| {
        let Some(id) = child_rule_id(rule) else {
            return;
        };
        if u_num(rule, "lastChild") == Some(id as i64) {
            return;
        }
        u_set_num(rule, "lastChild", id as i64);
        let name = child_name(rule);
        if (name == "external_declaration" || name == "unknown_declaration")
            && !u_bool(rule, "headTaken")
        {
            if let (Some(child), Some(node)) = (child_node_id(rule), node_id(rule)) {
                take_branch_head(rule, node, child);
            }
        } else if name == "extdecl_loop" {
            u_set_bool(rule, "itemsTaken", true);
        }
    });

    // --- external_declaration ----------------------------------------
    // Each declaration starts with a fresh node and state; the fallback's
    // token record is trimmed to the tokens it has not yet taken.
    reg.act("@external_declaration-bo", |rule, context| {
        let node = cst::new_node("external_declaration", None);
        set_node_id(rule, node);
        fallback::start_declaration(context);
    });

    // An armed route (`crate::fallback`).
    reg.act("@arm", |_rule, _context| {
        fallback::with_ed(|ed| ed.armed = true);
    });
    reg.cond("@c-failed", |_rule, _context| {
        fallback::with_ed(|ed| ed.failed).unwrap_or(false)
    });
    // The rules failed on an armed declaration: it is an unknown one, its
    // children the tokens it has taken, flat; unknown_declaration takes
    // the rest of the run.
    reg.act("@to-unknown", |rule, context| {
        fallback::with_ed(|ed| ed.unknown = true);
        let Some(node) = node_id(rule) else {
            return;
        };
        cst::set_children(node, Vec::new());
        for token in fallback::taken_tokens(context) {
            cst::push_token_with_trivia(node, token);
        }
    });
    // An external declaration no rule starts: unknown from its first
    // token.
    reg.act("@unk-start", |_rule, _context| {
        fallback::with_ed(|ed| {
            ed.armed = true;
            ed.unknown = true;
        });
    });
    // The rules ended an armed declaration before the chomp's end: the
    // rest of the run follows, flat.
    reg.cond("@armed-runs-on", |_rule, context| {
        let open = fallback::with_ed(|ed| ed.armed && !ed.failed && !ed.unknown).unwrap_or(false);
        open && !fallback::chomp_ended(context)
    });
    reg.act("@extdecl-trailing", |rule, _context| {
        splice_declaration(rule);
        fallback::with_ed(|ed| ed.trailing = true);
    });
    // The declaration the rules built.
    reg.act("@extdecl-built", |rule, context| {
        splice_declaration(rule);
        if let Some(node) = node_id(rule) {
            finish_external_declaration(node, context);
        }
    });

    // --- unknown_declaration -------------------------------------------
    reg.act("@unk-take", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            cst::push_token_with_trivia(node, token);
        }
    });
    reg.cond("@unk-ended", |_rule, context| {
        fallback::chomp_ended(context)
    });
    reg.act("@unk-end", |rule, context| {
        if let Some(node) = node_id(rule) {
            finish_external_declaration(node, context);
        }
    });
}

// ---------------------------------------------------------------------
// Conditional groups and the end of an external declaration
// ---------------------------------------------------------------------

/// The directive names that open a conditional group, start its later
/// branches, and end it.
const CONDITIONAL_OPENERS: &[&str] = &["if", "ifdef", "ifndef"];
const CONDITIONAL_BRANCHES: &[&str] = &["elif", "elifdef", "elifndef", "else"];
const CONDITIONAL_ENDIF: &[&str] = &["endif"];
const CONDITIONAL_BRANCH_ENDS: &[&str] = &["elif", "elifdef", "elifndef", "else", "endif"];

/// The conditional directive an external declaration is, when its name
/// is one of `names`.
fn conditional_of(node: usize, names: &[&str]) -> Option<usize> {
    let directive = cst::children_of(node)
        .iter()
        .filter_map(Item::as_node)
        .find(|child| cst::kind_of(*child) == "conditional_directive")?;
    let name = extra_string(directive, "directive")?;
    names.contains(&name.as_str()).then_some(directive)
}

/// True when the next line is a `#` line whose directive is one of
/// `names` (the alternate has fetched its first two tokens).
fn directive_ahead(context: &Context, names: &[&str]) -> bool {
    let (Some(hash), Some(name)) = (context.t.first(), context.t.get(1)) else {
        return false;
    };
    hash.name.as_str() == "PP_HASH" && names.contains(&name.src.as_str())
}

/// A branch's first child is its directive's external declaration.
fn take_branch_head(rule: &mut Rule, node: usize, head: usize) {
    append_child(node, head);
    let directive = cst::children_of(head)
        .iter()
        .filter_map(Item::as_node)
        .find(|child| cst::kind_of(*child) == "conditional_directive");
    let kind = directive
        .and_then(|directive| extra_string(directive, "directive"))
        .unwrap_or_else(|| "unknown".to_string());
    cst::set_extra(node, "branchKind", Item::str(kind));
    u_set_bool(rule, "headTaken", true);
}

/// Splice the declaration a dispatch rule built into the external
/// declaration's node. simple_declaration's children become the
/// external declaration's own; a static_assert or asm statement is its
/// one child.
fn splice_declaration(rule: &Rule) {
    let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
        return;
    };
    if child == node {
        return;
    }
    let name = child_name(rule);
    if name == "static_assert_declaration" || name == "asm_statement" {
        cst::set_children(node, vec![Item::Node(child)]);
        cst::set_extra(node, "declKind", Item::str("declaration"));
    } else {
        cst::set_children(node, cst::children_of(child));
        let kind = extra_string(child, "declKind").unwrap_or_else(|| "declaration".to_string());
        cst::set_extra(node, "declKind", Item::str(kind));
    }
    // A strict typedef declaration binds the names its rules found when
    // it ends.
    if let Some(names) = rule
        .child_rule
        .as_ref()
        .and_then(|child| crate::refs_newpath::typedef_names(child))
    {
        fallback::with_ed(|ed| ed.typedef_names = Some(names));
    }
}

/// Finish an external declaration: its kind, and the names it binds.
///
/// A strict declaration binds the typedef names its rules found. An
/// armed one (and an unknown one) is the token run the 0.5 parser handed
/// its structurer, and binds what 0.5 bound for that run, read from its
/// tokens: the typedef names of a run that starts with `typedef` and ends
/// with `;` (`register_typedef_if_applicable`), and the macro each
/// `#define` and `#undef` line in it names (`register_macros_from_tokens`),
/// unless the run is an unknown declaration that does not start with `#`,
/// which the structurer did not read. The names decide how later tokens
/// lex, so binding them as 0.5 did keeps what the parser accepts.
fn finish_external_declaration(node: usize, context: &mut Context) {
    let Some(ed) = fallback::with_ed(|ed| ed.clone()) else {
        return;
    };
    if ed.unknown
        || extra_string(node, "declKind")
            .unwrap_or_default()
            .is_empty()
    {
        cst::set_extra(node, "declKind", Item::str("unknown"));
    }
    cst::fix_spans(node);
    if ed.armed {
        let tokens = fallback::taken_tokens(context);
        register_typedef_if_applicable(&tokens, context);
        // 0.5 bound the macros of the lines its structurer read as
        // directives: a `#` line's own, and those of a declaration it
        // built. An unknown declaration that does not start with `#`
        // binds none.
        let first = tokens
            .iter()
            .map(|token| cst::token_name(*token))
            .find(|name| !sets::is_trivia(name));
        if !ed.unknown || first.as_deref() == Some("PP_HASH") {
            register_macros_from_tokens(&tokens, context);
        }
    } else if let Some(names) = ed.typedef_names {
        for name in names {
            with_state(|state| state.symbols.bind_typedef(&name));
            reclassify(context, &name, "ID", "TYPEDEF_NAME");
        }
    }
}

/// Bind and unbind, in order, the macros a run's `#define` and `#undef`
/// lines name, as 0.5's structurer read them: the token after the
/// directive name, when it is an identifier, a macro name or a typedef
/// name; a define is function-like when a `(` follows the name with no
/// space.
fn register_macros_from_tokens(tokens: &[usize], context: &mut Context) {
    let tokens: Vec<usize> = tokens
        .iter()
        .copied()
        .filter(|token| !sets::is_trivia(&cst::token_name(*token)))
        .collect();
    let is_name = |token: usize| {
        matches!(
            cst::token_name(token).as_str(),
            "ID" | "MACRO_NAME" | "TYPEDEF_NAME"
        )
    };
    for index in 0..tokens.len() {
        if cst::token_name(tokens[index]) != "PP_HASH" {
            continue;
        }
        let directive = tokens.get(index + 1).map(|token| cst::token_src(*token));
        let Some(&name) = tokens.get(index + 2) else {
            continue;
        };
        if !is_name(name) {
            continue;
        }
        let macro_name = cst::token_src(name);
        match directive.as_deref() {
            Some("define") => {
                let name_span = cst::token_data(name).map(|data| data.span);
                let function_like = tokens.get(index + 3).is_some_and(|next| {
                    cst::token_name(*next) == "PUNC_LPAREN"
                        && name_span.is_some_and(|span| {
                            cst::token_data(*next).is_some_and(|data| data.span.start == span.end)
                        })
                });
                let mut params = Vec::new();
                let mut variadic = false;
                if function_like {
                    for token in tokens.iter().skip(index + 4) {
                        let token_name = cst::token_name(*token);
                        if token_name == "PUNC_RPAREN" || token_name == "PP_NEWLINE" {
                            break;
                        }
                        if token_name == "PUNC_ELLIPSIS" {
                            variadic = true;
                        } else if is_name(*token) {
                            params.push(cst::token_src(*token));
                        }
                    }
                }
                with_state(|state| {
                    state.macros.define(crate::state::MacroDef {
                        name: macro_name.clone(),
                        is_function_like: function_like,
                        params,
                        variadic,
                    })
                });
                reclassify(context, &macro_name, "ID", "MACRO_NAME");
            }
            Some("undef") => {
                with_state(|state| state.macros.undefine(&macro_name));
                reclassify(context, &macro_name, "MACRO_NAME", "ID");
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------
// What a typedef declaration binds, read from its tokens
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

pub fn extra_string(node: usize, key: &str) -> Option<String> {
    match cst::extra_of(node, key) {
        Some(Item::Val(Value::String(text))) => Some(text),
        _ => None,
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
    crate::fallback::reclassify_untaken(context, name, from, to);
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
