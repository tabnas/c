/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! C's expressions, as precedence climbing in the grammar's rules
//! (`c-grammar.jsonic`, "expressions"). Port of `ts/src/expression.ts`,
//! which has the design: each level of C's expression grammar is a
//! rule, every repetition is a replace loop at one depth, and a node
//! whose existence only a later token decides (a binary operator after
//! its left operand, a postfix operator after its operand, a comma after
//! the first item) is wrapped in place when that token arrives.

use tabnas::{Context, Rule, Value};

use crate::cst::{self, Item};
use crate::refs::Reg;
use crate::rt::*;
use crate::state::handle_node;

/// The rules that build an expression, which a context reads back
/// through the child's node.
pub const EXPRESSION_RULES: &[&str] = &[
    "val",
    "expression",
    "assignment_expression",
    "conditional_expression",
    "binary",
    "binary_rhs",
    "cast_expression",
    "unary_expression",
    "postfix_expression",
    "postfix_more",
    "primary_expression",
];

/// The binary operators' precedence, by token name: a larger number
/// binds tighter. C's levels, from `||` to the multiplicative operators.
fn binary_precedence(name: &str) -> Option<i64> {
    Some(match name {
        "PUNC_OR_OR" => 4,
        "PUNC_AND_AND" => 5,
        "PUNC_PIPE" => 6,
        "PUNC_CARET" => 7,
        "PUNC_AMP" => 8,
        "PUNC_EQ" | "PUNC_NE" => 9,
        "PUNC_LT" | "PUNC_LE" | "PUNC_GT" | "PUNC_GE" => 10,
        "PUNC_LSHIFT" | "PUNC_RSHIFT" => 11,
        "PUNC_PLUS" | "PUNC_MINUS" => 12,
        "PUNC_STAR" | "PUNC_SLASH" | "PUNC_PERCENT" => 13,
        _ => return None,
    })
}

/// Is the rule that closed under this one an expression rule with a
/// node?
pub fn child_is_expr(rule: &Rule) -> bool {
    rule.child_rule
        .as_ref()
        .is_some_and(|child| EXPRESSION_RULES.contains(&child.name.as_str()))
        && child_node_id(rule).is_some()
}

/// The child a close state has not attached yet, as its node and its
/// rule's name: a rule's before-close runs each time its close state is
/// entered, after every child it pushed returns.
fn fresh_child(rule: &mut Rule) -> Option<(usize, String)> {
    let id = child_rule_id(rule)?;
    if u_num(rule, "seenChild") == Some(id as i64) {
        return None;
    }
    let node = child_node_id(rule)?;
    u_set_num(rule, "seenChild", id as i64);
    Some((node, child_name(rule)))
}

/// A replace that carries a node on: the alternate's action marks the
/// node, and the replacing rule's before-open finds it.
fn carry_on(rule: &mut Rule) {
    let node = rule.node.borrow().clone();
    k_set(rule, "cont", node);
}

/// Was the rule carried its node? Forgets the mark.
fn is_carried(rule: &mut Rule) -> bool {
    let Some(carried) = rule.k.get("cont").cloned() else {
        return false;
    };
    k_del(rule, "cont");
    match (handle_node(&carried), node_id(rule)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

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

/// A transparent rule's before-close: its node is the node of the rule it
/// pushed.
fn relay(rule: &mut Rule) {
    if let Some((child, _)) = fresh_child(rule) {
        set_node_id(rule, child);
    }
}

/// A rule starts with no node of its own (the engine hands a pushed rule
/// its parent's node, which it must not write to).
fn fresh(rule: &mut Rule) {
    if !is_carried(rule) {
        set_node(rule, Value::Undefined);
    }
}

fn push_node(rule: &Rule, child: usize) {
    if let Some(node) = node_id(rule) {
        cst::push_child(node, Item::Node(child));
    }
}

fn op_src(token: usize) -> Item {
    Item::str(cst::token_src(token))
}

pub fn register(reg: &mut Reg<'_>) {
    // ---- val: the rule an expression starts from ----------------------
    reg.act("@val-start", |rule, _context| {
        set_node(rule, Value::Undefined)
    });
    // An expression parsed on its own (the start rule `val`): its spans,
    // as an external declaration's are given when it ends.
    reg.act("@val-end", |rule, _context| {
        relay(rule);
        if rule.parent_rule.is_none() {
            if let Some(node) = node_id(rule) {
                cst::fix_spans(node);
            }
        }
    });

    // ---- expression: the comma operator --------------------------------
    reg.act("@expression-bo", |rule, _context| fresh(rule));
    reg.act("@expression-bc", |rule, _context| {
        let Some((child, _)) = fresh_child(rule) else {
            return;
        };
        match node_id(rule) {
            Some(node) if cst::kind_of(node) == "comma_expression" => {
                cst::push_child(node, Item::Node(child))
            }
            _ => set_node_id(rule, child),
        }
    });
    reg.act("@comma", |rule, _context| {
        let (Some(node), Some(comma)) = (node_id(rule), c0(rule)) else {
            return;
        };
        if cst::kind_of(node) != "comma_expression" {
            cst::wrap_in_place(node, "comma_expression");
        }
        cst::drop_token(node, comma);
        carry_on(rule);
    });

    // ---- assignment ------------------------------------------------------
    reg.act("@assignment_expression-bo", |rule, _context| fresh(rule));
    reg.act("@assignment_expression-bc", |rule, _context| {
        let Some((child, _)) = fresh_child(rule) else {
            return;
        };
        if u_bool(rule, "op") {
            push_node(rule, child);
            u_set_bool(rule, "done", true);
        } else {
            set_node_id(rule, child);
        }
    });
    reg.act("@assign", |rule, _context| {
        let (Some(node), Some(op)) = (node_id(rule), c0(rule)) else {
            return;
        };
        cst::wrap_in_place(node, "assignment_expression");
        cst::set_extra(node, "op", op_src(op));
        cst::drop_token(node, op);
        u_set_bool(rule, "op", true);
    });
    reg.cond("@asg-done", |rule, _context| u_bool(rule, "done"));

    // ---- conditional -------------------------------------------------------
    reg.act("@conditional_expression-bo", |rule, _context| fresh(rule));
    reg.act("@conditional_expression-bc", |rule, _context| {
        let Some((child, _)) = fresh_child(rule) else {
            return;
        };
        let stage = u_str(rule, "stage");
        if stage == "then" || stage == "else" {
            push_node(rule, child);
            if stage == "else" {
                u_set_str(rule, "stage", "done");
            }
        } else {
            set_node_id(rule, child);
        }
    });
    reg.act("@cond-q", |rule, _context| {
        let (Some(node), Some(q)) = (node_id(rule), c0(rule)) else {
            return;
        };
        cst::wrap_in_place(node, "conditional_expression");
        cst::drop_token(node, q);
        u_set_str(rule, "stage", "then");
    });
    reg.cond("@cond-at-then", |rule, _context| {
        u_str(rule, "stage") == "then"
    });
    reg.act("@cond-colon", |rule, _context| {
        if let (Some(node), Some(colon)) = (node_id(rule), c0(rule)) {
            cst::drop_token(node, colon);
        }
        u_set_str(rule, "stage", "else");
    });
    reg.cond("@cond-done", |rule, _context| {
        u_str(rule, "stage") == "done"
    });
    reg.cond("@cond-at-test", |rule, _context| !u_has(rule, "stage"));

    // ---- binary operators: precedence climbing ---------------------------
    reg.act("@binary-bo", |rule, _context| {
        fresh(rule);
        let min = k_num(rule, "min");
        u_set_num(rule, "min", min);
    });
    reg.act("@binary-bc", |rule, _context| relay(rule));
    // The token after the operand (the operator alternate before this one
    // fetched it) is not an identifier or a literal.
    reg.cond("@not-juxtaposed", |_rule, context: &mut Context| {
        !crate::sets::JUXTAPOSED.contains(&t_name(context, 0).as_str())
    });
    reg.act("@binary_rhs-bo", |rule, _context| {
        is_carried(rule);
        let min = k_num(rule, "binMin");
        u_set_num(rule, "min", min);
    });
    reg.act("@binary_rhs-bc", |rule, _context| {
        if let Some((child, _)) = fresh_child(rule) {
            push_node(rule, child);
        }
    });
    reg.cond("@bin-binds", |rule, _context| {
        let Some(op) = rule.c0() else {
            return false;
        };
        binary_precedence(op.name.as_str())
            .is_some_and(|prec| prec >= u_num(rule, "min").unwrap_or(0))
    });
    reg.act("@bin-op", |rule, _context| {
        let (Some(node), Some(op)) = (node_id(rule), c0(rule)) else {
            return;
        };
        cst::wrap_in_place(node, "binary_expression");
        cst::set_extra(node, "op", op_src(op));
        cst::drop_token(node, op);
        let min = u_num(rule, "min").unwrap_or(0);
        k_set_num(rule, "binMin", min);
        let prec = binary_precedence(&cst::token_name(op)).unwrap_or(0);
        k_set_num(rule, "min", prec + 1);
        carry_on(rule);
    });

    // ---- casts and compound literals ---------------------------------------
    reg.act("@cast_expression-bo", |rule, _context| fresh(rule));
    reg.act("@cast_expression-bc", |rule, _context| relay(rule));
    reg.cond("@cast-was-cl", |rule, _context| {
        let is_cl = node_id(rule).is_some_and(|node| cst::kind_of(node) == "compound_literal");
        if is_cl && !u_bool(rule, "postfixed") {
            u_set_bool(rule, "postfixed", true);
            carry_on(rule);
            return true;
        }
        false
    });

    reg.act("@cast_or_compound_literal-bo", |rule, _context| {
        let node = cst::new_node("cast_expression", None);
        set_node_id(rule, node);
    });
    reg.act("@cocl-open", |rule, _context| {
        if let (Some(node), Some(open)) = (node_id(rule), o0(rule)) {
            cst::push_token_with_trivia(node, open);
        }
    });
    reg.act("@cast_or_compound_literal-bc", |rule, _context| {
        let Some((child, name)) = fresh_child(rule) else {
            return;
        };
        push_node(rule, child);
        if name == "type_name" {
            return;
        }
        u_set_bool(rule, "done", true);
    });
    reg.act("@cocl-cl", |rule, _context| {
        if let (Some(node), Some(open)) = (node_id(rule), c0(rule)) {
            cst::set_kind(node, "compound_literal");
            cst::push_token_with_trivia(node, open);
        }
    });
    reg.act("@cocl-cast", |rule, _context| {
        if let (Some(node), Some(close)) = (node_id(rule), c0(rule)) {
            cst::push_token_with_trivia(node, close);
        }
    });
    reg.cond("@cocl-done", |rule, _context| u_bool(rule, "done"));

    // ---- unary -------------------------------------------------------------
    reg.act("@unary_expression-bo", |rule, _context| fresh(rule));
    reg.act("@unary_expression-bc", |rule, _context| {
        let Some((child, _)) = fresh_child(rule) else {
            return;
        };
        if u_bool(rule, "prefix") {
            push_node(rule, child);
            // A prefix operator's node takes its operand's span, as the
            // node an operator builds takes its first term's.
            if let Some(node) = node_id(rule) {
                cst::set_span(node, cst::span_of(child));
            }
        } else {
            set_node_id(rule, child);
        }
    });
    reg.act("@prefix", |rule, _context| {
        let Some(op) = o0(rule) else {
            return;
        };
        let node = cst::new_node("unary_expression", None);
        cst::set_extra(node, "op", op_src(op));
        cst::drop_token(node, op);
        set_node_id(rule, node);
        u_set_bool(rule, "prefix", true);
    });

    // ---- postfix -----------------------------------------------------------
    reg.act("@postfix_expression-bo", |rule, _context| fresh(rule));
    reg.act("@postfix_expression-bc", |rule, _context| relay(rule));
    reg.act("@postfix_more-bo", |rule, _context| {
        is_carried(rule);
    });
    reg.act("@postfix_more-bc", |rule, _context| {
        let Some((child, _)) = fresh_child(rule) else {
            return;
        };
        match u_str(rule, "pending").as_str() {
            "subscript" => {
                if let Some(index) = u_node(rule, "index") {
                    cst::push_child(index, Item::Node(child));
                }
            }
            "call" => {
                // The argument list takes its call's span, as it always
                // has.
                if let Some(node) = node_id(rule) {
                    cst::set_span(child, cst::span_of(node));
                }
                push_node(rule, child);
                u_set_node(rule, "args", child);
            }
            _ => {}
        }
    });
    reg.act("@subscript", |rule, _context| {
        let (Some(node), Some(open)) = (node_id(rule), c0(rule)) else {
            return;
        };
        cst::wrap_in_place(node, "subscript_expression");
        let index = cst::new_node("index_list", Some(cst::span_of(node)));
        cst::drop_token(index, open);
        cst::push_child(node, Item::Node(index));
        u_set_node(rule, "index", index);
        u_set_str(rule, "pending", "subscript");
    });
    reg.cond("@pm-in-subscript", |rule, _context| {
        u_str(rule, "pending") == "subscript"
    });
    reg.cond("@pm-free", |rule, _context| !u_has(rule, "pending"));
    reg.act("@pf-carry", |rule, _context| carry_on(rule));
    reg.act("@pm-rbracket", |rule, _context| {
        if let (Some(index), Some(close)) = (u_node(rule, "index"), c0(rule)) {
            cst::drop_token(index, close);
        }
        carry_on(rule);
    });
    reg.act("@call", |rule, _context| {
        let Some(node) = node_id(rule) else {
            return;
        };
        let callee = cst::wrap_in_place(node, "call_expression");
        if cst::kind_of(callee) == "identifier_expression" {
            if let Some(name) = cst::extra_of(callee, "name") {
                cst::set_extra(node, "callee", name);
            }
            let first = cst::children_of(callee).iter().find_map(|item| {
                let token = item.as_token()?;
                let name = cst::token_name(token);
                (!name.starts_with("TRIVIA")).then_some(name)
            });
            cst::set_extra(
                node,
                "isMacro",
                Item::bool(first.as_deref() == Some("MACRO_NAME")),
            );
        }
        u_set_str(rule, "pending", "call");
        if let Some(paren) = rule.c0().cloned() {
            let id = cst::intern_token(&paren);
            k_set_token(rule, "callParen", id);
        }
    });
    reg.cond("@pm-in-call", |rule, _context| {
        u_str(rule, "pending") == "call"
    });
    reg.act("@pm-rparen", |rule, _context| {
        if let (Some(args), Some(close)) = (u_node(rule, "args"), c0(rule)) {
            cst::drop_token(args, close);
        }
        carry_on(rule);
    });
    reg.act("@member", |rule, _context| {
        let (Some(node), Some(op), Some(name)) = (node_id(rule), c0(rule), close_token(rule, 1))
        else {
            return;
        };
        cst::wrap_in_place(node, "member_expression");
        cst::drop_token(node, op);
        cst::push_child(node, Item::Node(atom("identifier_expression", name)));
        cst::set_extra(node, "memberName", Item::str(cst::token_src(name)));
        cst::set_extra(node, "op", op_src(op));
        carry_on(rule);
    });
    reg.act("@postfix", |rule, _context| {
        let (Some(node), Some(op)) = (node_id(rule), c0(rule)) else {
            return;
        };
        cst::wrap_in_place(node, "postfix_unary_expression");
        cst::set_extra(node, "op", op_src(op));
        cst::drop_token(node, op);
        carry_on(rule);
    });

    // ---- arguments ---------------------------------------------------------
    reg.act("@argument_list-bo", |rule, _context| {
        let carried = is_carried(rule);
        u_set_bool(rule, "carried", carried);
        if !carried {
            let node = cst::new_node("argument_list", None);
            if let Some(paren) = k_token(rule, "callParen") {
                cst::drop_token(node, paren);
            }
            set_node_id(rule, node);
        }
        k_del(rule, "callParen");
    });
    reg.act("@argument_list-bc", |rule, _context| {
        if let Some((child, _)) = fresh_child(rule) {
            push_node(rule, child);
        }
    });
    reg.cond("@args-first", |rule, _context| !u_bool(rule, "carried"));
    reg.act("@args-comma", |rule, _context| {
        if let (Some(node), Some(comma)) = (node_id(rule), c0(rule)) {
            cst::drop_token(node, comma);
        }
        carry_on(rule);
    });

    // ---- primary -----------------------------------------------------------
    reg.act("@primary_expression-bo", |rule, _context| fresh(rule));
    reg.act("@primary_expression-bc", |rule, _context| {
        let Some((child, _)) = fresh_child(rule) else {
            return;
        };
        if u_bool(rule, "paren") {
            push_node(rule, child);
            if let Some(node) = node_id(rule) {
                cst::set_span(node, cst::span_of(child));
            }
        } else {
            set_node_id(rule, child);
        }
    });
    reg.act("@lit", |rule, _context| {
        if let Some(token) = o0(rule) {
            set_node_id(rule, atom("literal_expression", token));
        }
    });
    reg.act("@ident", |rule, _context| {
        if let Some(token) = o0(rule) {
            set_node_id(rule, atom("identifier_expression", token));
        }
    });
    reg.act("@paren-open", |rule, _context| {
        let node = cst::new_node("paren_expression", None);
        if let Some(open) = o0(rule) {
            cst::drop_token(node, open);
        }
        set_node_id(rule, node);
        u_set_bool(rule, "paren", true);
    });
    reg.cond("@paren-pending", |rule, _context| {
        u_bool(rule, "paren") && !u_bool(rule, "parenClosed")
    });
    reg.cond("@paren-free", |rule, _context| {
        !u_bool(rule, "paren") || u_bool(rule, "parenClosed")
    });
    reg.act("@paren-close", |rule, _context| {
        if let (Some(node), Some(close)) = (node_id(rule), c0(rule)) {
            cst::drop_token(node, close);
        }
        u_set_bool(rule, "parenClosed", true);
    });
}
