/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The statement family: compound statements and block items, the
//! expression and jump statements, the parenthesised condition, the
//! `if` / `while` / `do` / `switch` / `for` forms and labels.
//!
//! Port of the statement half of `makeGrammarRefs` in `ts/src/c.ts`.
//! The tree shapes mirror what the legacy structurer emits, so a
//! consumer sees the same tree whichever path produced it.

use tabnas::Value;

use crate::cst::{self, Item};
use crate::refs::Reg;
use crate::refs_newpath::clear_stmt_state;
use crate::rt::*;

/// True when this rule is a fresh instance rather than the `r:`
/// re-entry of the same rule.
fn reentered(rule: &tabnas::Rule) -> bool {
    rule.prev_rule
        .as_ref()
        .is_some_and(|prev| prev.name == rule.name)
}

/// The shared shape of every control-flow rule's before-open: keep the
/// node across an `r:` re-entry, otherwise build a fresh one and clear
/// the progress flags a parent control-flow rule may have left.
fn open_stmt(rule: &mut tabnas::Rule, kind: &str, key: &str) {
    if reentered(rule) {
        if let Some(node) = k_node(rule, key) {
            set_node_id(rule, node);
            return;
        }
    }
    let node = cst::new_node(kind, None);
    set_node_id(rule, node);
    k_set_node(rule, key, node);
    clear_stmt_state(rule);
}

/// Push the rule's first open token onto its node.
fn take_open(rule: &mut tabnas::Rule) {
    if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
        push_token(node, token);
    }
}

/// Push the rule's first close token onto its node.
fn take_close(rule: &mut tabnas::Rule) {
    if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
        push_token(node, token);
    }
}

/// Attach the closed child's node once, under a named progress flag.
fn take_child_once(rule: &mut tabnas::Rule, want: &str, flag: &str) -> bool {
    if child_name(rule) != want || k_bool(rule, flag) {
        return false;
    }
    let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
        return false;
    };
    cst::push_child(node, Item::Node(child));
    k_set_bool(rule, flag, true);
    true
}

pub fn register(reg: &mut Reg<'_>) {
    // --- compound_statement ------------------------------------------
    reg.act("@compound_statement-bo", |rule, _context| {
        // Always a fresh node: the rule is seeded with its parent's,
        // so a nested compound statement would otherwise share it.
        let node = cst::new_node("compound_statement", None);
        set_node_id(rule, node);
    });
    reg.act("@cs-open", |rule, _context| take_open(rule));
    reg.act("@cs-close", |rule, _context| take_close(rule));
    reg.act("@compound_statement-bc", |rule, _context| {
        if child_name(rule) != "block_item" {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        // The canonical guard is a set of the child RULES already
        // taken; a rule's index is its identity here.
        let taken = k_list(rule, "taken");
        let Some(index) = rule.child_rule.as_ref().map(|child| child.i) else {
            return;
        };
        if list_get(taken).contains(&index) {
            return;
        }
        cst::push_child(node, Item::Node(child));
        list_push(taken, index);
    });

    // --- the two dispatchers -------------------------------------------
    // Both REPLACE the node rather than only setting it when absent:
    // the rule is seeded with its parent's node, so an unreplaced
    // dispatcher would hand the parent its own node back and the tree
    // would contain itself.
    reg.act("@block_item-bc", |rule, _context| {
        if let Some(child) = child_node_id(rule) {
            set_node_id(rule, child);
        }
    });
    reg.act("@statement-bc", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "expression_statement")
            && child_node_id(rule).is_none()
        {
            return;
        }
        if let Some(child) = child_node_id(rule) {
            set_node_id(rule, child);
        }
    });
    reg.act("@stmt-empty", |rule, _context| {
        let Some(token) = o0(rule) else {
            return;
        };
        let node = cst::new_node("expression_statement", None);
        push_token(node, token);
        set_node_id(rule, node);
    });

    // --- expression_statement -------------------------------------------
    reg.act("@expression_statement-bo", |rule, _context| {
        let node = cst::new_node("expression_statement", None);
        set_node_id(rule, node);
    });
    reg.act("@es-take-expr", |_rule, _context| {});
    reg.act("@expression_statement-bc", |rule, _context| {
        if !child_is_val(rule) || k_bool(rule, "exprAttached") {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if child == node {
            return;
        }
        cst::push_child(node, Item::Node(child));
        k_set_bool(rule, "exprAttached", true);
    });
    reg.act("@es-finalize", |rule, _context| take_close(rule));

    // --- jump_statement ---------------------------------------------------
    reg.act("@jump_statement-bo", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "jump_statement") {
            return;
        }
        let node = cst::new_node("jump_statement", None);
        set_node_id(rule, node);
    });
    reg.cond("@js-reentry", |rule, _context| k_bool(rule, "started"));
    reg.act("@js-take-keyword", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        cst::set_extra(node, "jumpKind", Item::str(cst::token_src(token)));
        push_token(node, token);
        k_set_bool(rule, "started", true);
    });
    reg.cond("@js-needs-label", |rule, _context| {
        jump_kind(rule) == "goto" && !k_bool(rule, "tookLabel")
    });
    reg.act("@js-take-label", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "tookLabel", true);
    });
    reg.cond("@js-needs-expr", |rule, _context| {
        jump_kind(rule) == "return" && !k_bool(rule, "tookExpr")
    });
    reg.act("@js-take-expr", |rule, _context| {
        k_set_bool(rule, "tookExpr", true);
    });
    reg.act("@jump_statement-bc", |rule, _context| {
        if !child_is_val(rule) || !k_bool(rule, "tookExpr") || k_bool(rule, "exprAttached") {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if child == node {
            return;
        }
        cst::push_child(node, Item::Node(child));
        k_set_bool(rule, "exprAttached", true);
    });
    reg.act("@js-finalize", |rule, _context| take_close(rule));

    // --- paren_condition ---------------------------------------------------
    reg.act("@paren_condition-bo", |rule, _context| {
        let node = cst::new_node("paren_condition", None);
        set_node_id(rule, node);
    });
    reg.act("@pc-open", |rule, _context| take_open(rule));
    reg.act("@pc-take-expr", |_rule, _context| {});
    reg.act("@paren_condition-bc", |rule, _context| {
        if !child_is_val(rule) || k_bool(rule, "exprAttached") {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if child == node {
            return;
        }
        cst::push_child(node, Item::Node(child));
        k_set_bool(rule, "exprAttached", true);
    });
    reg.act("@pc-close", |rule, _context| take_close(rule));

    // --- if_statement -------------------------------------------------------
    reg.act("@if_statement-bo", |rule, _context| {
        open_stmt(rule, "if_statement", "ifNode")
    });
    reg.act("@if-take-keyword", |rule, _context| take_open(rule));
    reg.cond("@if-needs-cond", |rule, _context| !k_bool(rule, "tookCond"));
    reg.cond("@if-needs-then", |rule, _context| {
        k_bool(rule, "tookCond") && !k_bool(rule, "tookThen")
    });
    reg.cond("@if-needs-else-kw", |rule, _context| {
        k_bool(rule, "tookThen") && !k_bool(rule, "elseSeen")
    });
    reg.act("@if-take-else-kw", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "elseSeen", true);
    });
    reg.cond("@if-needs-else-body", |rule, _context| {
        k_bool(rule, "elseSeen") && !k_bool(rule, "tookElse")
    });
    reg.act("@if_statement-bc", |rule, _context| {
        if take_child_once(rule, "paren_condition", "tookCond") {
            return;
        }
        if child_name(rule) != "statement" {
            return;
        }
        if !k_bool(rule, "tookThen") {
            take_child_once(rule, "statement", "tookThen");
        } else if k_bool(rule, "elseSeen") && !k_bool(rule, "tookElse") {
            take_child_once(rule, "statement", "tookElse");
        }
    });

    // --- while_statement ------------------------------------------------------
    reg.act("@while_statement-bo", |rule, _context| {
        open_stmt(rule, "while_statement", "whileNode")
    });
    reg.act("@while-take-keyword", |rule, _context| take_open(rule));
    reg.cond("@while-needs-cond", |rule, _context| {
        !k_bool(rule, "tookCond")
    });
    reg.cond("@while-needs-body", |rule, _context| {
        k_bool(rule, "tookCond") && !k_bool(rule, "tookBody")
    });
    reg.act("@while_statement-bc", |rule, _context| {
        if take_child_once(rule, "paren_condition", "tookCond") {
            return;
        }
        take_child_once(rule, "statement", "tookBody");
    });

    // --- do_statement ---------------------------------------------------------
    reg.act("@do_statement-bo", |rule, _context| {
        open_stmt(rule, "do_statement", "doNode")
    });
    reg.act("@do-take-keyword", |rule, _context| take_open(rule));
    reg.cond("@do-needs-body", |rule, _context| !k_bool(rule, "tookBody"));
    reg.cond("@do-needs-while", |rule, _context| {
        k_bool(rule, "tookBody") && !k_bool(rule, "tookWhile")
    });
    reg.act("@do-take-while", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "tookWhile", true);
    });
    reg.cond("@do-needs-cond", |rule, _context| {
        k_bool(rule, "tookWhile") && !k_bool(rule, "tookCond")
    });
    reg.cond("@do-needs-semi", |rule, _context| {
        k_bool(rule, "tookCond") && !k_bool(rule, "tookSemi")
    });
    reg.act("@do-take-semi", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "tookSemi", true);
    });
    reg.act("@do_statement-bc", |rule, _context| {
        if take_child_once(rule, "statement", "tookBody") {
            return;
        }
        take_child_once(rule, "paren_condition", "tookCond");
    });

    // --- switch_statement -------------------------------------------------------
    reg.act("@switch_statement-bo", |rule, _context| {
        open_stmt(rule, "switch_statement", "switchNode")
    });
    reg.act("@switch-take-keyword", |rule, _context| take_open(rule));
    reg.cond("@switch-needs-cond", |rule, _context| {
        !k_bool(rule, "tookCond")
    });
    reg.cond("@switch-needs-body", |rule, _context| {
        k_bool(rule, "tookCond") && !k_bool(rule, "tookBody")
    });
    reg.act("@switch_statement-bc", |rule, _context| {
        if take_child_once(rule, "paren_condition", "tookCond") {
            return;
        }
        take_child_once(rule, "statement", "tookBody");
    });

    // --- for_statement -----------------------------------------------------------
    reg.act("@for_statement-bo", |rule, _context| {
        open_stmt(rule, "for_statement", "forNode")
    });
    reg.act("@for-take-keyword", |rule, _context| take_open(rule));
    reg.cond("@for-needs-controls", |rule, _context| {
        !k_bool(rule, "tookControls")
    });
    reg.cond("@for-needs-body", |rule, _context| {
        k_bool(rule, "tookControls") && !k_bool(rule, "tookBody")
    });
    reg.act("@for_statement-bc", |rule, _context| {
        if take_child_once(rule, "for_controls", "tookControls") {
            return;
        }
        take_child_once(rule, "statement", "tookBody");
    });

    reg.act("@for_controls-bo", |rule, _context| {
        open_stmt(rule, "for_controls", "fcNode")
    });
    reg.act("@fc-open", |rule, _context| take_open(rule));
    reg.cond("@fc-needs-cond", |rule, _context| {
        k_bool(rule, "tookInit") && !k_bool(rule, "tookCond")
    });
    reg.cond("@fc-needs-iter", |rule, _context| {
        k_bool(rule, "tookCond") && !k_bool(rule, "tookIter")
    });
    reg.act("@fc-close", |rule, _context| take_close(rule));
    reg.act("@for_controls-bc", |rule, _context| {
        for (want, flag, field) in [
            ("for_init", "tookInit", "init"),
            ("for_cond", "tookCond", "cond"),
            ("for_iter", "tookIter", "iter"),
        ] {
            if child_name(rule) != want || k_bool(rule, flag) {
                continue;
            }
            let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
                return;
            };
            cst::push_child(node, Item::Node(child));
            cst::set_extra(node, field, Item::Node(child));
            k_set_bool(rule, flag, true);
            return;
        }
    });

    // --- the three for-control clauses ------------------------------------------
    reg.act("@for_init-bo", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "for_init") {
            return;
        }
        let node = cst::new_node("for_init", None);
        set_node_id(rule, node);
    });
    reg.act("@fi-empty-take-semi", |rule, _context| {
        take_open(rule);
        k_set_str(rule, "took", "empty");
    });
    reg.act("@fi-mark-decl", |rule, _context| {
        k_set_str(rule, "took", "decl")
    });
    reg.act("@fi-mark-expr", |rule, _context| {
        k_set_str(rule, "took", "expr")
    });
    reg.cond("@fi-needs-semi", |rule, _context| {
        k_str(rule, "took") == "expr" && !k_bool(rule, "tookSemi")
    });
    reg.act("@fi-take-semi", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "tookSemi", true);
    });
    reg.act("@for_init-bc", |rule, _context| {
        let took = k_str(rule, "took");
        let name = child_name(rule);
        // Both arms of the canonical `if` take the clause value: a
        // declaration returned by simple_declaration, or an expression
        // returned by val. They are kept as one test here because the
        // bodies are the same statement.
        if (took == "decl" && name == "simple_declaration")
            || (took == "expr" && child_is_val(rule))
        {
            take_clause_value(rule);
        }
    });

    reg.act("@for_cond-bo", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "for_cond") {
            return;
        }
        let node = cst::new_node("for_cond", None);
        set_node_id(rule, node);
    });
    reg.act("@fcond-empty-take-semi", |rule, _context| {
        take_open(rule);
        k_set_str(rule, "took", "empty");
    });
    reg.act("@fcond-mark-expr", |rule, _context| {
        k_set_str(rule, "took", "expr")
    });
    reg.cond("@fcond-needs-semi", |rule, _context| {
        k_str(rule, "took") == "expr" && !k_bool(rule, "tookSemi")
    });
    reg.act("@fcond-take-semi", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "tookSemi", true);
    });
    reg.act("@for_cond-bc", |rule, _context| {
        if k_str(rule, "took") == "expr" && child_is_val(rule) {
            take_clause_value(rule);
        }
    });

    reg.act("@for_iter-bo", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "for_iter") {
            return;
        }
        let node = cst::new_node("for_iter", None);
        set_node_id(rule, node);
    });
    reg.act("@fiter-empty", |_rule, _context| {});
    reg.act("@fiter-mark-expr", |rule, _context| {
        k_set_str(rule, "took", "expr")
    });
    reg.act("@for_iter-bc", |rule, _context| {
        if k_str(rule, "took") == "expr" && child_is_val(rule) {
            take_clause_value(rule);
        }
    });

    // --- labeled_statement ---------------------------------------------------------
    reg.act("@labeled_statement-bo", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "labeled_statement") {
            return;
        }
        let node = cst::new_node("labeled_statement", None);
        set_node_id(rule, node);
    });
    reg.act("@lbl-take-case", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        cst::set_extra(node, "labelKind", Item::str("case"));
        push_token(node, token);
        k_set_str(rule, "kind", "case");
    });
    reg.act("@lbl-take-default", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        cst::set_extra(node, "labelKind", Item::str("default"));
        push_token(node, token);
        k_set_str(rule, "kind", "default");
    });
    reg.act("@lbl-take-name", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        cst::set_extra(node, "labelKind", Item::str("label"));
        cst::set_extra(node, "labelName", Item::str(cst::token_src(token)));
        push_token(node, token);
        k_set_str(rule, "kind", "label");
    });
    reg.cond("@lbl-needs-expr", |rule, _context| {
        k_str(rule, "kind") == "case" && !k_bool(rule, "tookExpr")
    });
    reg.act("@lbl-mark-expr", |rule, _context| {
        k_set_bool(rule, "tookExpr", true)
    });
    reg.cond("@lbl-needs-colon", |rule, _context| {
        !k_bool(rule, "tookColon")
    });
    reg.act("@lbl-take-colon", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "tookColon", true);
    });
    reg.cond("@lbl-needs-body", |rule, _context| {
        k_bool(rule, "tookColon") && !k_bool(rule, "tookBody")
    });
    reg.act("@labeled_statement-bc", |rule, _context| {
        if k_str(rule, "kind") == "case" && child_is_val(rule) && !k_bool(rule, "exprAttached") {
            let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
                return;
            };
            if child != node {
                cst::push_child(node, Item::Node(child));
                k_set_bool(rule, "exprAttached", true);
                return;
            }
        }
        take_child_once(rule, "statement", "tookBody");
    });
}

/// The `jumpKind` field the jump statement's keyword handler wrote.
fn jump_kind(rule: &tabnas::Rule) -> String {
    let Some(node) = node_id(rule) else {
        return String::new();
    };
    match cst::extra_of(node, "jumpKind") {
        Some(Item::Val(Value::String(text))) => text,
        _ => String::new(),
    }
}

/// Attach a for-control clause's value once, as both a child and the
/// node's `value` field.
fn take_clause_value(rule: &mut tabnas::Rule) {
    let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
        return;
    };
    if child == node || cst::has_extra(node, "value") {
        return;
    }
    cst::push_child(node, Item::Node(child));
    cst::set_extra(node, "value", Item::Node(child));
}
