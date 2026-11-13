/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! C's expressions, read by [`tabnas_expr`]. Port of
//! `ts/src/expr-grammar.ts`, which has the design.
//!
//! The grammar's contexts push `val`, the rule an expression starts from,
//! where C's grammar names an expression (an initializer, a condition, an
//! argument). expr parses the expression with C's operator table, and its
//! evaluator turns each operation of the S-expression into the node C's
//! tree holds for it, from the innermost out once the expression has ended
//! ([`evaluate_c_expr`]). The table sets the options expr has for a
//! language like C: a binding power on a call's and a subscript's
//! parenthesis, a cast accepted where its group holds a type name, the
//! comma operator beside separators, values side by side refused, a
//! required content, and the conditional as a ternary with binding powers.
//!
//! A token expr does not hand over with the operation (an opener, a
//! separator, a conditional's `:`) is reached through the links the sub-lex
//! hook makes as the tokens are lexed ([`link_token`]).

use std::collections::HashMap;
use std::sync::Arc;

use tabnas::{AltSpec, Context, PluginError, Rule, RuleSpec, Tabnas, Tin, Token, Value};
use tabnas_expr::{ContentDef, EvalSite, ExprOptions, Op, OpDef, PrevalDef};

use crate::cst::{self, Item};
use crate::rt::*;
use crate::state::{handle_node, node_handle, with_state};

// ---- C's operator table ---------------------------------------------
//
// Binding powers on a 1,000 ladder, loosest first. Left-associative
// operators have left < right, right-associative ones left > right.

const UNARY: i64 = 16_000;
const POSTFIX: i64 = 17_000;

/// C's operator table. Mirrors `C_OP_TABLE` in `ts/src/expr-grammar.ts`,
/// in its order: of two operators on one token of one kind, the later
/// applies.
fn op_table() -> ExprOptions {
    let infix = OpDef::infix;
    let prefix = |src: &str| OpDef::prefix(src, UNARY);
    let suffix = |src: &str| OpDef::suffix(src, POSTFIX);
    ExprOptions::new()
        // The comma operator, which gives way to a separator wherever the
        // context separates on `,` (a call's arguments, an initializer).
        .with_op("comma", infix(",", 1_000, 1_001).with_separator())
        // Assignment, right-associative.
        .with_op("assign", infix("=", 2_001, 2_000))
        .with_op("plus_a", infix("+=", 2_001, 2_000))
        .with_op("minus_a", infix("-=", 2_001, 2_000))
        .with_op("star_a", infix("*=", 2_001, 2_000))
        .with_op("slash_a", infix("/=", 2_001, 2_000))
        .with_op("pct_a", infix("%=", 2_001, 2_000))
        .with_op("lsh_a", infix("<<=", 2_001, 2_000))
        .with_op("rsh_a", infix(">>=", 2_001, 2_000))
        .with_op("amp_a", infix("&=", 2_001, 2_000))
        .with_op("crt_a", infix("^=", 2_001, 2_000))
        .with_op("pipe_a", infix("|=", 2_001, 2_000))
        // The conditional, right-associative, placed by its binding powers:
        // it binds tighter than assignment and the comma operator, and its
        // middle term is a whole expression.
        .with_op(
            "tern",
            OpDef::ternary("?", ":").with_left(3_001).with_right(3_000),
        )
        // The binary operators, from `||` to the multiplicative ones.
        .with_op("or", infix("||", 4_000, 4_001))
        .with_op("and", infix("&&", 5_000, 5_001))
        .with_op("bor", infix("|", 6_000, 6_001))
        .with_op("bxor", infix("^", 7_000, 7_001))
        .with_op("band", infix("&", 8_000, 8_001))
        .with_op("eq", infix("==", 9_000, 9_001))
        .with_op("ne", infix("!=", 9_000, 9_001))
        .with_op("lt", infix("<", 10_000, 10_001))
        .with_op("le", infix("<=", 10_000, 10_001))
        .with_op("gt", infix(">", 10_000, 10_001))
        .with_op("ge", infix(">=", 10_000, 10_001))
        .with_op("lsh", infix("<<", 11_000, 11_001))
        .with_op("rsh", infix(">>", 11_000, 11_001))
        .with_op("plus", infix("+", 12_000, 12_001))
        .with_op("minus", infix("-", 12_000, 12_001))
        .with_op("star", infix("*", 13_000, 13_001))
        .with_op("slash", infix("/", 13_000, 13_001))
        .with_op("pct", infix("%", 13_000, 13_001))
        // The prefix operators, and the cast at their level.
        .with_op("pre_inc", prefix("++"))
        .with_op("pre_dec", prefix("--"))
        .with_op("unary_p", prefix("+"))
        .with_op("unary_n", prefix("-"))
        .with_op("lnot", prefix("!"))
        .with_op("bnot", prefix("~"))
        .with_op("deref", prefix("*"))
        .with_op("addr", prefix("&"))
        .with_op("sizeof", prefix("sizeof"))
        .with_op("alignof", prefix("_Alignof"))
        .with_op("alignof_g", prefix("alignof"))
        .with_op("gnualignof", prefix("__alignof__"))
        .with_op("gnualignof_s", prefix("__alignof"))
        .with_op(
            "cast",
            OpDef::cast("(", ")", UNARY, |term: &Value| {
                handle_node(term).is_some_and(|node| cst::kind_of(node) == "type_name")
            }),
        )
        // The postfix operators, one level, left to right.
        .with_op("post_inc", suffix("++"))
        .with_op("post_dec", suffix("--"))
        .with_op("dot", infix(".", POSTFIX, POSTFIX + 1))
        .with_op("arrow", infix("->", POSTFIX, POSTFIX + 1))
        // A group, whose content is required; a call, whose content is its
        // arguments, separated; a subscript.
        .with_op(
            "paren",
            OpDef::paren("(", ")")
                .with_preval(PrevalDef {
                    active: false,
                    required: false,
                    allow: None,
                })
                .with_content(ContentDef {
                    required: true,
                    separated: false,
                }),
        )
        .with_op(
            "call",
            OpDef::paren("(", ")")
                .with_left(POSTFIX)
                .with_preval(PrevalDef {
                    active: true,
                    required: false,
                    allow: None,
                })
                .with_content(ContentDef {
                    required: false,
                    separated: true,
                }),
        )
        .with_op(
            "subscript",
            OpDef::paren("[", "]")
                .with_left(POSTFIX)
                .with_preval(PrevalDef {
                    active: true,
                    required: true,
                    allow: None,
                })
                .with_content(ContentDef {
                    required: true,
                    separated: false,
                }),
        )
        .with_juxtapose(false)
        .with_values(JUXTAPOSED.iter().copied())
        // C bounds its own trees: every operation becomes a node of the
        // arena (`crate::cst`), which nothing walks on the call stack but
        // `realize`, and that stops at `REALIZE_DEPTH_CAP`. expr's own bound
        // on an expression's size is for a host that realizes expr's
        // S-expressions, which this one never does.
        .with_node_limit(usize::MAX)
        .with_evaluate(evaluate_c_expr)
}

const ASSIGN_OPS: &[&str] = &[
    "assign-infix",
    "plus_a-infix",
    "minus_a-infix",
    "star_a-infix",
    "slash_a-infix",
    "pct_a-infix",
    "lsh_a-infix",
    "rsh_a-infix",
    "amp_a-infix",
    "crt_a-infix",
    "pipe_a-infix",
];

// ---- The links between an operation's tokens --------------------------
//
// expr hands the evaluator each operation's own token: an operator's, a
// paren's closer, a conditional's `?`. The opener of a paren, the commas
// between a call's arguments and a conditional's `:` are reached from it,
// through links made as the tokens are lexed: a closer's opener, an
// opener's commas directly inside it, and the `:` that answers a `?`.
// TypeScript and Go keep a link on the token object; a token here is a
// value the engine copies, so the links are kept by the token's place in
// the source, and name the copies the arena holds (`crate::cst`).

#[derive(Debug, Clone, Default)]
struct LinkLevel {
    /// The bracket that opened the level: its place, its arena id and its
    /// name. The base level has none.
    opener: Option<(usize, usize, String)>,
    /// The `?`s at this level still waiting for their `:`, by place and
    /// arena id.
    qs: Vec<(usize, usize)>,
}

/// The parse's state of the links: the open brackets, each with the `?`s
/// at its level still waiting for their `:`, and the links made so far.
#[derive(Debug, Default)]
pub struct LinkState {
    levels: Vec<LinkLevel>,
    /// The place of the token linked last.
    last: Option<usize>,
    /// A closer's opener, by the closer's place.
    open: HashMap<usize, usize>,
    /// An opener's commas, by the opener's place.
    seps: HashMap<usize, Vec<usize>>,
    /// A `?`'s `:`, by the `?`'s place.
    colon: HashMap<usize, usize>,
}

fn opener_of(closer: &str) -> Option<&'static str> {
    match closer {
        "PUNC_RPAREN" => Some("PUNC_LPAREN"),
        "PUNC_RBRACKET" => Some("PUNC_LBRACKET"),
        "PUNC_RBRACE" => Some("PUNC_LBRACE"),
        _ => None,
    }
}

/// Link a token the lexer gave the parser, in the order it gave them, by
/// its arena id (`crate::fallback::record_token` made it). A token given
/// again at the same place (the engine's relex) takes the place of the
/// one before it.
pub fn link_token(token: &Token, id: usize) {
    let name = token.name.as_str();
    if name == "#ZZ" {
        return;
    }
    let at = token.site.pos;
    with_state(|state| {
        let links = &mut state.links;
        if links.levels.is_empty() {
            links.levels.push(LinkLevel::default());
        }
        if links.last == Some(at) {
            for level in links.levels.iter_mut() {
                if let Some(opener) = level.opener.as_mut() {
                    if opener.0 == at {
                        opener.1 = id;
                    }
                }
                for q in level.qs.iter_mut() {
                    if q.0 == at {
                        q.1 = id;
                    }
                }
            }
            return;
        }
        links.last = Some(at);
        if matches!(name, "PUNC_LPAREN" | "PUNC_LBRACKET" | "PUNC_LBRACE") {
            links.levels.push(LinkLevel {
                opener: Some((at, id, name.to_string())),
                qs: Vec::new(),
            });
            return;
        }
        if let Some(opens) = opener_of(name) {
            for index in (1..links.levels.len()).rev() {
                let Some((_, opener, opener_name)) = links.levels[index].opener.clone() else {
                    continue;
                };
                if opener_name == opens {
                    links.open.insert(at, opener);
                    links.levels.truncate(index);
                    break;
                }
            }
            return;
        }
        let top = links.levels.len() - 1;
        match name {
            "PUNC_COMMA" => {
                if let Some((opener_at, _, _)) = links.levels[top].opener {
                    links.seps.entry(opener_at).or_default().push(id);
                }
            }
            "PUNC_QUESTION" => links.levels[top].qs.push((at, id)),
            "PUNC_COLON" => {
                if let Some((q_at, _)) = links.levels[top].qs.pop() {
                    links.colon.insert(q_at, id);
                }
            }
            "PUNC_SEMI" => links.levels[top].qs.clear(),
            _ => {}
        }
    });
}

/// The opener of the closer at a place.
fn linked_open(closer_at: usize) -> Option<usize> {
    with_state(|state| state.links.open.get(&closer_at).copied())
}

/// The commas directly inside the opener at a place.
fn linked_seps(opener_at: usize) -> Vec<usize> {
    with_state(|state| {
        state
            .links
            .seps
            .get(&opener_at)
            .cloned()
            .unwrap_or_default()
    })
}

/// The `:` that answers the `?` at a place.
fn linked_colon(q_at: usize) -> Option<usize> {
    with_state(|state| state.links.colon.get(&q_at).copied())
}

/// The place of a token of the arena.
fn token_at(token: usize) -> Option<usize> {
    cst::token_data(token).map(|data| data.span.start)
}

// ---- The evaluator: an operation as C's node ------------------------

fn node_of(term: Option<&Value>) -> Option<usize> {
    term.and_then(handle_node)
}

fn push(node: usize, term: Option<&Value>) {
    if let Some(child) = node_of(term) {
        cst::push_child(node, Item::Node(child));
    }
}

fn push_node(node: usize, child: Option<usize>) {
    if let Some(child) = child {
        cst::push_child(node, Item::Node(child));
    }
}

fn drop(node: usize, token: Option<usize>) {
    if let Some(token) = token {
        cst::drop_token(node, token);
    }
}

fn keep(node: usize, token: Option<usize>) {
    if let Some(token) = token {
        cst::push_token_with_trivia(node, token);
    }
}

/// The nodes among a node's children.
fn child_nodes(node: usize) -> Vec<usize> {
    cst::children_of(node)
        .iter()
        .filter_map(Item::as_node)
        .collect()
}

fn set_op(node: usize, op: &Op) {
    cst::set_extra(node, "op", Item::str(op.src.clone()));
}

/// The operation's own token, copied into the arena, and its place.
struct OpToken {
    id: Option<usize>,
    at: Option<usize>,
}

impl OpToken {
    fn of(token: Option<&Token>) -> Self {
        OpToken {
            id: token.map(cst::intern_token),
            at: token.map(|token| token.site.pos),
        }
    }
}

/// An infix operation: the left operand, the operator's comments, the
/// right operand.
fn infix(kind: &str, token: &OpToken, terms: &[Value]) -> usize {
    let out = cst::new_node(kind, None);
    push(out, terms.first());
    drop(out, token.id);
    push(out, terms.get(1));
    out
}

/// A comma expression holds every operand of a chain of commas: expr
/// builds `a, b, c` left to right, `[, [, a b] c]`, and the inner one is
/// the outer one's first operand. A parenthesised one is a group's.
fn comma(token: &OpToken, terms: &[Value]) -> usize {
    let left = node_of(terms.first());
    let out = match left {
        Some(left) if cst::kind_of(left) == "comma_expression" => {
            cst::unfix_span(left);
            left
        }
        _ => {
            let out = cst::new_node("comma_expression", None);
            push_node(out, left);
            out
        }
    };
    drop(out, token.id);
    push(out, terms.get(1));
    out
}

fn member(op: &Op, token: &OpToken, terms: &[Value]) -> usize {
    let out = cst::new_node("member_expression", None);
    push(out, terms.first());
    drop(out, token.id);
    let name = node_of(terms.get(1));
    push_node(out, name);
    if let Some(Item::Val(Value::String(text))) = name.and_then(|name| cst::extra_of(name, "name"))
    {
        cst::set_extra(out, "memberName", Item::str(text));
    }
    set_op(out, op);
    out
}

fn conditional(token: &OpToken, terms: &[Value]) -> usize {
    let out = cst::new_node("conditional_expression", None);
    push(out, terms.first());
    drop(out, token.id);
    push(out, terms.get(1));
    drop(out, token.at.and_then(linked_colon));
    push(out, terms.get(2));
    out
}

fn unary(op: &Op, token: &OpToken, terms: &[Value]) -> usize {
    let out = cst::new_node("unary_expression", None);
    set_op(out, op);
    drop(out, token.id);
    push(out, terms.first());
    out
}

fn postfix(op: &Op, token: &OpToken, terms: &[Value]) -> usize {
    let out = cst::new_node("postfix_unary_expression", None);
    push(out, terms.first());
    drop(out, token.id);
    set_op(out, op);
    out
}

/// Whether an identifier's own token, comments before it left out, is a
/// macro's name.
fn identifier_is_macro(identifier: usize) -> bool {
    for item in cst::children_of(identifier) {
        let Some(token) = item.as_token() else {
            continue;
        };
        let name = cst::token_name(token);
        if name.starts_with("TRIVIA") {
            continue;
        }
        return name == "MACRO_NAME";
    }
    false
}

fn call(token: &OpToken, terms: &[Value]) -> usize {
    let out = cst::new_node("call_expression", None);
    let callee = node_of(terms.first());
    push_node(out, callee);
    if let Some(callee) = callee.filter(|callee| cst::kind_of(*callee) == "identifier_expression") {
        if let Some(name) = cst::extra_of(callee, "name") {
            cst::set_extra(out, "callee", name);
        }
        cst::set_extra(out, "isMacro", Item::bool(identifier_is_macro(callee)));
    }
    let opener = token.at.and_then(linked_open);
    let seps = opener
        .and_then(token_at)
        .map(linked_seps)
        .unwrap_or_default();
    let args = cst::new_node("argument_list", None);
    drop(args, opener);
    for index in 1..terms.len() {
        if index > 1 {
            drop(args, seps.get(index - 2).copied());
        }
        push(args, terms.get(index));
    }
    drop(args, token.id);
    cst::push_child(out, Item::Node(args));
    out
}

fn subscript(token: &OpToken, terms: &[Value]) -> usize {
    let out = cst::new_node("subscript_expression", None);
    push(out, terms.first());
    let index = cst::new_node("index_list", None);
    drop(index, token.at.and_then(linked_open));
    for term in terms.iter().skip(1) {
        push(index, Some(term));
    }
    drop(index, token.id);
    cst::push_child(out, Item::Node(index));
    out
}

/// A parenthesised expression.
fn group(token: &OpToken, terms: &[Value]) -> usize {
    let out = cst::new_node("paren_expression", None);
    drop(out, token.at.and_then(linked_open));
    for term in terms {
        push(out, Some(term));
    }
    drop(out, token.id);
    out
}

/// The nodes a postfix operator builds, each over its first child node: a
/// compound literal's postfix chain is built over its brace list.
const POSTFIX_KINDS: &[&str] = &[
    "member_expression",
    "subscript_expression",
    "call_expression",
    "postfix_unary_expression",
];

/// A cast: `( type-name )` and its operand. A brace list in the operand's
/// place is a compound literal, which binds as a postfix expression does:
/// expr builds the postfix operators after it into the cast's operand, so
/// the compound literal takes the brace list's place under them.
fn cast(token: &OpToken, terms: &[Value]) -> Option<usize> {
    let opener = token.at.and_then(linked_open);
    let type_name = node_of(terms.first());
    let operand = node_of(terms.get(1));

    let parens = |kind: &str, body: Option<usize>| -> usize {
        let out = cst::new_node(kind, None);
        keep(out, opener);
        push_node(out, type_name);
        keep(out, token.id);
        push_node(out, body);
        out
    };

    let mut chain: Vec<usize> = Vec::new();
    let mut n = operand;
    while let Some(node) = n.filter(|node| POSTFIX_KINDS.contains(&cst::kind_of(*node).as_str())) {
        chain.push(node);
        n = child_nodes(node).first().copied();
    }
    if let Some(list) = n.filter(|node| cst::kind_of(*node) == "initializer_list") {
        let literal = parens("compound_literal", Some(list));
        let Some(&parent) = chain.last() else {
            return Some(literal);
        };
        let mut children = cst::children_of(parent);
        if let Some(slot) = children
            .iter_mut()
            .find(|item| item.as_node() == Some(list))
        {
            *slot = Item::Node(literal);
        }
        cst::set_children(parent, children);
        // The chain's nodes start with the compound literal's `(` now.
        for node in &chain {
            cst::unfix_span(*node);
        }
        return operand;
    }
    Some(parens("cast_expression", operand))
}

/// expr's evaluator: an operation of the S-expression as C's node. Each
/// operation's node is given its span as it is built, from the innermost
/// out: the span of the first token it keeps, which every expression's
/// node has. An external declaration gives the rest of its tree theirs
/// when it ends, and an expression parsed on its own (the start rule
/// `val`) has no declaration to give them.
fn evaluate_c_expr(site: &mut EvalSite<'_>, op: &Op, terms: &[Value]) -> Value {
    let token = OpToken::of(site.token());
    match evaluate_op(op, &token, terms) {
        Some(node) => {
            cst::fix_spans(node);
            node_handle(node)
        }
        None => Value::Undefined,
    }
}

fn evaluate_op(op: &Op, token: &OpToken, terms: &[Value]) -> Option<usize> {
    let name = op.name.as_str();
    if op.cast {
        return cast(token, terms);
    }
    if op.paren {
        return Some(match name {
            "call-paren" => call(token, terms),
            "subscript-paren" => subscript(token, terms),
            _ => group(token, terms),
        });
    }
    if op.ternary {
        return Some(conditional(token, terms));
    }
    if op.infix {
        if name == "comma-infix" {
            return Some(comma(token, terms));
        }
        if ASSIGN_OPS.contains(&name) {
            let out = infix("assignment_expression", token, terms);
            set_op(out, op);
            return Some(out);
        }
        if name == "dot-infix" || name == "arrow-infix" {
            return Some(member(op, token, terms));
        }
        let out = infix("binary_expression", token, terms);
        set_op(out, op);
        return Some(out);
    }
    if op.prefix {
        return Some(unary(op, token, terms));
    }
    if op.suffix {
        return Some(postfix(op, token, terms));
    }
    let out = cst::new_node("expression", None);
    for term in terms {
        push(out, Some(term));
    }
    Some(out)
}

// ---- val: where an expression starts --------------------------------

/// The rules of expr's own: a `val` they push is a term of the expression
/// being read, not a new one.
const EXPR_OWN: &[&str] = &[
    "val", "expr", "paren", "ternary", "list", "map", "elem", "pair",
];

/// The contexts whose expression is a full one, where a comma is the comma
/// operator; in every other a comma ends the expression, for the context to
/// take (an assignment or a conditional expression, in C's grammar).
const FULL_EXPRESSION: &[&str] = &[
    "expression_statement",
    "jump_statement",
    "paren_condition",
    "for_init",
    "for_cond",
    "for_iter",
    "asm_value",
];

/// The C rules a `val` pushes for a term, whose node is the term's.
const TERM_RULES: &[&str] = &[
    "type_name",
    "sizeof_type_form",
    "initializer_list",
    "string_atom",
    "generic_selection",
    "statement_expression",
];

/// C's values: an identifier or a literal, which never directly follows an
/// operand.
const JUXTAPOSED: &[&str] = &[
    "ID",
    "TYPEDEF_NAME",
    "MACRO_NAME",
    "LIT_INT",
    "LIT_FLOAT",
    "LIT_CHAR",
    "LIT_STRING",
];

/// The rules expr reads an expression with, its own and the jsonic ones it
/// pushes (an implicit list inside a paren): they are below every external
/// declaration too (`crate::fallback::with_rule_fallback`).
pub const EXPR_RULES: &[&str] = &[
    "val", "expr", "paren", "ternary", "list", "elem", "map", "pair",
];

/// A literal or an identifier, from its one token.
fn atom(kind: &str, token: usize) -> usize {
    let span = cst::token_data(token).map(|data| data.span);
    let node = cst::new_node(kind, span);
    cst::push_token_with_trivia(node, token);
    if kind == "literal_expression" {
        cst::set_extra(node, "literalKind", Item::str(cst::token_name(token)));
        cst::set_extra(node, "value", Item::str(cst::token_src(token)));
    } else {
        cst::set_extra(node, "name", Item::str(cst::token_src(token)));
    }
    node
}

/// Whether the val is the first term of a group's content, where a type
/// name is the group's own (a cast's or a compound literal's).
fn group_content(rule: &mut Rule, _context: &mut Context) -> bool {
    let Some(paren) = rule.parent_rule.as_ref() else {
        return false;
    };
    paren.name.as_str() == "paren"
        && matches!(paren.u.get("expr_paren_group"), Some(Value::Bool(true)))
        && paren.u.get("expr_items").is_none_or(Value::is_undefined)
}

fn tins(parser: &Tabnas, names: &[&str]) -> Vec<Tin> {
    names
        .iter()
        .filter_map(|name| parser.config().token(name))
        .collect()
}

fn set_tins(parser: &Tabnas, name: &str) -> Vec<Tin> {
    parser.token_set(name).unwrap_or_default()
}

/// One alternate over a token sequence.
fn alt(s: Vec<Vec<Tin>>, back: usize, group: &str) -> AltSpec {
    let mut alt = AltSpec::new();
    alt.s = s;
    alt.b = back;
    alt.g = group.to_string();
    alt
}

/// Install expr with C's operator table, and give `val` C's own
/// alternates: the forms that start an expression (a type name after
/// `sizeof (`, a statement expression, `_Generic`, a brace list, a cast's
/// type name) and C's atoms.
pub fn install(parser: &mut Tabnas) -> Result<(), PluginError> {
    tabnas_expr::expr(parser, &op_table())?;

    let sizeof_kw = set_tins(parser, "SIZEOF_KW");
    let simple_type_head = set_tins(parser, "SIMPLE_TYPE_HEAD");
    let lparen = tins(parser, &["PUNC_LPAREN"]);
    let lbrace = tins(parser, &["PUNC_LBRACE"]);
    let generic = tins(parser, &["KW__GENERIC"]);
    let atoms: Vec<(Vec<Tin>, &'static str, &'static str)> = [
        ("LIT_INT", "literal_expression", "c-atom,c-int"),
        ("LIT_FLOAT", "literal_expression", "c-atom,c-float"),
        ("LIT_CHAR", "literal_expression", "c-atom,c-char"),
        ("KW_NULLPTR", "literal_expression", "c-atom,c-nullptr"),
        ("KW_TRUE", "literal_expression", "c-atom,c-true"),
        ("KW_FALSE", "literal_expression", "c-atom,c-false"),
        ("ID", "identifier_expression", "c-atom,c-id"),
        ("MACRO_NAME", "identifier_expression", "c-atom,c-macro"),
        ("TYPEDEF_NAME", "identifier_expression", "c-atom,c-typedef"),
    ]
    .iter()
    .map(|(name, kind, group)| (tins(parser, &[name]), *kind, *group))
    .collect();
    let string = tins(parser, &["LIT_STRING"]);

    parser.define_rule("val", move |spec: &mut RuleSpec| {
        // A new expression, from one of C's contexts: expr's counters start
        // again (the expression around a statement expression or a brace
        // list is not this one's), and the context says whether a comma
        // separates.
        spec.prepend_bo(|rule: &mut Rule, _context: &mut Context| {
            let fresh = rule
                .parent_rule
                .as_ref()
                .is_some_and(|parent| !EXPR_OWN.contains(&parent.name.as_str()));
            if fresh {
                let sep = rule
                    .parent_rule
                    .as_ref()
                    .is_some_and(|parent| FULL_EXPRESSION.contains(&parent.name.as_str()));
                let n = rule.n_mut();
                for counter in [
                    "expr",
                    "expr_prefix",
                    "expr_suffix",
                    "expr_paren",
                    "expr_ternary",
                    "dlist",
                    "dmap",
                    "pk",
                ] {
                    n.insert(counter.to_string(), 0);
                }
                n.insert("expr_sep".to_string(), if sep { 0 } else { 1 });
            }
            set_node(rule, Value::Undefined);
        });

        // The forms that expr's own alternates would take otherwise: a type
        // name after `sizeof (`, a statement expression `( {`, `_Generic`, a
        // brace list, and a type name as a group's content (a cast's). They
        // come first, in this order.
        let mut sizeof_type = alt(
            vec![sizeof_kw.clone(), lparen.clone(), simple_type_head.clone()],
            3,
            "c-sizeof-type",
        );
        sizeof_type.p = Some("sizeof_type_form".to_string());
        let mut statement_expression = alt(vec![lparen.clone(), lbrace.clone()], 2, "c-stmt-expr");
        statement_expression.p = Some("statement_expression".to_string());
        let mut generic_selection = alt(vec![generic.clone()], 1, "c-generic");
        generic_selection.p = Some("generic_selection".to_string());
        let mut brace_list = alt(vec![lbrace.clone()], 1, "c-brace-list");
        brace_list.p = Some("initializer_list".to_string());
        let mut type_name = alt(vec![simple_type_head.clone()], 1, "c-type-name");
        type_name.c_fn = Some(Arc::new(group_content));
        type_name.p = Some("type_name".to_string());
        for entry in [
            sizeof_type,
            statement_expression,
            generic_selection,
            brace_list,
            type_name,
        ]
        .into_iter()
        .rev()
        {
            spec.prepend_open(entry);
        }

        // C's atoms, after expr's own alternates. A string is a rule of its
        // own: adjacent strings are one.
        for (s, kind, group) in atoms.iter().take(6) {
            spec.add_open(atom_alt(s.clone(), kind, group));
        }
        let mut string_atom = alt(vec![string.clone()], 1, "c-atom,c-str");
        string_atom.p = Some("string_atom".to_string());
        spec.add_open(string_atom);
        for (s, kind, group) in atoms.iter().skip(6) {
            spec.add_open(atom_alt(s.clone(), kind, group));
        }

        // The expression ends where no operator follows. An identifier or a
        // literal, which never directly follows an operand in C, expr
        // refuses before this (its `values`).
        spec.add_close(alt(Vec::new(), 0, "c-val-end"));

        // A C rule a term pushed: its node is the term's.
        spec.add_bc(|rule: &mut Rule, _context: &mut Context| {
            let Some(child) = rule.child_rule.as_ref() else {
                return;
            };
            if !TERM_RULES.contains(&child.name.as_str()) {
                return;
            }
            let id = child.i as i64;
            let Some(node) = child_node_id(rule) else {
                return;
            };
            if u_num(rule, "seenTerm") == Some(id) {
                return;
            }
            u_set_num(rule, "seenTerm", id);
            set_node_id(rule, node);
        });

        // An expression parsed on its own (the start rule `val`): its spans,
        // as an external declaration's are given when it ends.
        spec.add_ac(|rule: &mut Rule, _context: &mut Context| {
            if rule.parent_rule.is_some() {
                return;
            }
            if let Some(node) = node_id(rule) {
                cst::fix_spans(node);
            }
        });
    });
    Ok(())
}

fn atom_alt(s: Vec<Tin>, kind: &'static str, group: &str) -> AltSpec {
    let mut entry = alt(vec![s], 0, group);
    entry.add_action(move |rule: &mut Rule, _context: &mut Context| {
        if let Some(token) = o0(rule) {
            set_node_id(rule, atom(kind, token));
        }
    });
    entry
}

/// Whether a rule is the one an expression is built in, whose node a
/// context reads back.
pub fn is_expression_rule(name: &str) -> bool {
    name == "val"
}

/// Is the rule that closed under this one an expression rule with a node?
pub fn child_is_expr(rule: &Rule) -> bool {
    rule.child_rule
        .as_ref()
        .is_some_and(|child| is_expression_rule(child.name.as_str()))
        && child_node_id(rule).is_some()
}

// The part's copy of C's operator table holds to the reader's.
//
// C's transducer part (alchemy/transduce.alc) places each operator of an
// expression itself, over expr's passes, by a copy of C's operator table
// in alchemy text: the maintainer ruled so on 2026-11-13. The copy is a
// second statement of C's precedence, so this test holds it to the table
// the reader gives expr, `op_table`, entry for entry, and a drift between
// the two fails here. Each entry of the copy is `[name kind src left
// right]`: the kind (infix, prefix, suffix, ternary, paren, cast), the
// operator's token (an opener for a paren or a cast, the first token of a
// ternary), and its binding powers, -1 where the table gives none.
#[cfg(test)]
mod part_operator_table {
    use std::collections::BTreeMap;

    use super::op_table;

    fn entry(op: &tabnas_expr::OpDef) -> String {
        let kind = if op.cast {
            "cast"
        } else if op.paren {
            "paren"
        } else if op.ternary {
            "ternary"
        } else if op.infix {
            "infix"
        } else if op.prefix {
            "prefix"
        } else if op.suffix {
            "suffix"
        } else {
            "?"
        };
        let src = match kind {
            "cast" | "paren" => op.osrc.clone(),
            _ => op.src.first().cloned().unwrap_or_default(),
        };
        format!(
            "{kind} {src} {} {}",
            op.left.unwrap_or(-1),
            op.right.unwrap_or(-1)
        )
    }

    fn part_table() -> BTreeMap<String, String> {
        let source = crate::translate()
            .and_then(|parts| parts.transduce)
            .and_then(|part| part.source)
            .expect("c carries a transducer");
        let begin = source
            .find("; BEGIN C_OP_TABLE")
            .expect("a C_OP_TABLE block");
        let end = source.find("; END C_OP_TABLE").expect("its end");
        let mut out = BTreeMap::new();
        for line in source[begin..end].lines() {
            let line = line.trim();
            let Some(inner) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) else {
                continue;
            };
            let mut quoted = inner.split('"').skip(1).step_by(2);
            let (Some(name), Some(kind), Some(src)) = (quoted.next(), quoted.next(), quoted.next())
            else {
                continue;
            };
            let powers: Vec<i64> = inner
                .rsplit('"')
                .next()
                .unwrap_or_default()
                .split_whitespace()
                .map(|n| n.parse().expect("a binding power"))
                .collect();
            assert_eq!(powers.len(), 2, "{line} gives two binding powers");
            out.insert(
                name.to_string(),
                format!("{kind} {src} {} {}", powers[0], powers[1]),
            );
        }
        assert!(!out.is_empty(), "the C_OP_TABLE block holds no entry");
        out
    }

    #[test]
    fn the_parts_copy_is_the_readers_table() {
        let got = part_table();
        let mut want = BTreeMap::new();
        for (name, op) in &op_table().op {
            if let Some(op) = op {
                want.insert(name.clone(), entry(op));
            }
        }
        assert_eq!(
            got, want,
            "the part's C_OP_TABLE is not the reader's op_table"
        );
    }
}
