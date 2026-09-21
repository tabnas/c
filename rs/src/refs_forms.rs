/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The expression-adjacent forms and the tagged types: type names,
//! the `sizeof` type form, casts and compound literals, initializer
//! lists and designators, adjacent string literals, `_Generic`, the
//! GCC statement expression, and the struct, union and enum families.
//!
//! Port of the corresponding half of `makeGrammarRefs` in
//! `ts/src/c.ts`.

use tabnas::Value;

use crate::cst::{self, Item};
use crate::refs::Reg;
use crate::refs_newpath::spec_owner_u_node;
use crate::rt::*;

/// The depth counter the opaque token collectors keep, so they know
/// when a bracketed run has balanced.
fn track_depth(rule: &mut tabnas::Rule, key: &str, token: usize) {
    let name = cst::token_name(token);
    if matches!(name.as_str(), "PUNC_LPAREN" | "PUNC_LBRACKET") {
        let depth = k_num(rule, key) + 1;
        k_set_num(rule, key, depth);
    } else if matches!(name.as_str(), "PUNC_RPAREN" | "PUNC_RBRACKET") {
        let depth = k_num(rule, key) - 1;
        k_set_num(rule, key, depth);
    }
}

/// Attach the closed child's node once, recording it under a named
/// field of the node as well.
fn take_child_field(rule: &mut tabnas::Rule, want: &str, flag: &str, field: &str) -> bool {
    if child_name(rule) != want || k_bool(rule, flag) {
        return false;
    }
    let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
        return false;
    };
    cst::push_child(node, Item::Node(child));
    if !field.is_empty() {
        cst::set_extra(node, field, Item::Node(child));
    }
    k_set_bool(rule, flag, true);
    true
}

pub fn register(reg: &mut Reg<'_>) {
    // --- type_name -----------------------------------------------------
    reg.act("@type_name-bo", |rule, _context| {
        if open_keep(rule, "type_name", "tnNode").is_some() {
            k_set_bool(rule, "tnTaken", false);
            k_set_num(rule, "depth", 0);
        }
    });
    reg.cond("@tn-reentered", |rule, _context| {
        k_node(rule, "tnNode").is_some() && k_bool(rule, "tnTaken")
    });
    reg.act("@tn-take", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), state_token(rule)) else {
            return;
        };
        push_token(node, token);
        k_set_bool(rule, "tnTaken", true);
        track_depth(rule, "depth", token);
    });
    reg.cond("@tn-balanced", |rule, _context| k_num(rule, "depth") == 0);

    // --- sizeof_type_form ----------------------------------------------
    reg.act("@sizeof_type_form-bo", |rule, _context| {
        let node = cst::new_node("unary_expression", None);
        set_node_id(rule, node);
    });
    reg.act("@stf-take-kw", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        cst::set_extra(node, "op", Item::str(cst::token_src(token)));
        push_token(node, token);
        k_set_bool(rule, "kwTaken", true);
    });
    reg.cond("@stf-needs-lparen", |rule, _context| {
        k_bool(rule, "kwTaken") && !k_bool(rule, "tookLparen")
    });
    reg.act("@stf-take-lparen", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "tookLparen", true);
    });
    reg.cond("@stf-needs-rparen", |rule, _context| {
        k_bool(rule, "tookLparen") && !k_bool(rule, "tookRparen")
    });
    reg.act("@stf-take-rparen", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "tookRparen", true);
    });
    reg.act("@sizeof_type_form-bc", |rule, _context| {
        take_child_field(rule, "type_name", "typeNameAttached", "operand");
    });

    // --- cast_or_compound_literal ---------------------------------------
    reg.act("@cast_or_compound_literal-bo", |_rule, _context| {});
    reg.act("@cocl-take-lparen", |rule, _context| {
        if let Some(token) = o0(rule) {
            k_set_token(rule, "lparenTkn", token);
        }
    });
    reg.cond("@cocl-reentered", |rule, _context| {
        k_token(rule, "lparenTkn").is_some()
    });
    reg.cond("@cocl-needs-rparen", |rule, _context| {
        !k_bool(rule, "tookRparen")
    });
    reg.act("@cocl-take-rparen", |rule, _context| {
        if let Some(token) = c0(rule) {
            k_set_token(rule, "rparenTkn", token);
        }
        k_set_bool(rule, "tookRparen", true);
    });
    reg.cond("@cocl-needs-decision", |rule, _context| {
        k_bool(rule, "tookRparen") && k_str(rule, "decided").is_empty()
    });
    reg.act("@cocl-mark-cl", |rule, _context| {
        k_set_str(rule, "decided", "compound_literal")
    });
    reg.act("@cocl-mark-cast", |rule, _context| {
        k_set_str(rule, "decided", "cast")
    });
    reg.act("@cast_or_compound_literal-bc", |rule, _context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let name = child_name(rule);
        if name == "type_name" && k_node(rule, "typeName").is_none() {
            k_set_node(rule, "typeName", child);
            return;
        }
        if matches!(name.as_str(), "initializer_list" | "compound_literal_body")
            && k_node(rule, "compoundBody").is_none()
        {
            k_set_node(rule, "compoundBody", child);
            return;
        }
        if child_is_val(rule) && k_node(rule, "castOperand").is_none() {
            k_set_node(rule, "castOperand", child);
        }
    });
    reg.act("@cocl-finalize", |rule, _context| {
        let decided = k_str(rule, "decided");
        let decided = if decided.is_empty() {
            "cast".to_string()
        } else {
            decided
        };
        let type_name = k_node(rule, "typeName");
        let node = if decided == "compound_literal" {
            let node = cst::new_node("compound_literal", None);
            if let Some(token) = k_token(rule, "lparenTkn") {
                push_token(node, token);
            }
            if let Some(type_name) = type_name {
                cst::push_child(node, Item::Node(type_name));
                cst::set_extra(node, "typeName", Item::Node(type_name));
            }
            if let Some(token) = k_token(rule, "rparenTkn") {
                push_token(node, token);
            }
            if let Some(body) = k_node(rule, "compoundBody") {
                cst::push_child(node, Item::Node(body));
            }
            node
        } else {
            let node = cst::new_node("cast_expression", None);
            if let Some(token) = k_token(rule, "lparenTkn") {
                push_token(node, token);
            }
            if let Some(type_name) = type_name {
                cst::push_child(node, Item::Node(type_name));
                cst::set_extra(node, "typeName", Item::Node(type_name));
            }
            if let Some(token) = k_token(rule, "rparenTkn") {
                push_token(node, token);
            }
            if let Some(operand) = k_node(rule, "castOperand") {
                cst::push_child(node, Item::Node(operand));
                cst::set_extra(node, "operand", Item::Node(operand));
            }
            node
        };
        set_node_id(rule, node);
        // The canonical handler ALSO writes the finished node onto the
        // parent's `child` rule, because an `r:` re-entry builds a fresh
        // rule there while the parent still points at the first one.
        // This engine hands the parent the node of the LAST rule of a
        // replacement chain, which is this one, so there is nothing to
        // propagate; and a snapshot's node cell is shared with its
        // parent, so writing through it would overwrite an ancestor's
        // node instead.
    });

    // --- compound_literal_body ------------------------------------------
    reg.act("@compound_literal_body-bo", |_rule, _context| {});
    reg.act("@compound_literal_body-bc", |rule, _context| {
        if child_name(rule) != "initializer_list" || k_bool(rule, "relayed") {
            return;
        }
        if let Some(child) = child_node_id(rule) {
            set_node_id(rule, child);
            k_set_bool(rule, "relayed", true);
        }
    });

    // --- initializer_list -------------------------------------------------
    reg.act("@initializer_list-bo", |rule, _context| {
        // A fresh push inherits the enclosing list's `k`, so the
        // flags are cleared; an `r:` re-entry keeps its own node.
        if open_keep(rule, "initializer_list", "ilNode").is_some() {
            k_set_bool(rule, "opened", false);
            k_del(rule, "takenItems");
        }
    });
    reg.act("@il-take-lbrace", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "opened", true);
    });
    reg.cond("@il-reentered", |rule, _context| k_bool(rule, "opened"));
    reg.act("@il-take-comma", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@il-take-rbrace", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@initializer_list-bc", |rule, _context| {
        if child_name(rule) != "initializer_item" {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if take_once(rule, "takenItems") {
            cst::push_child(node, Item::Node(child));
        }
    });

    // --- initializer_item --------------------------------------------------
    reg.act("@initializer_item-bo", |rule, _context| {
        if open_keep(rule, "initializer_item", "iiNode").is_some() {
            k_set_bool(rule, "hasDesig", false);
            k_set_bool(rule, "tookEq", false);
            k_set_bool(rule, "gotValue", false);
            k_set_bool(rule, "desigAttached", false);
        }
    });
    reg.cond("@ii-reentered", |rule, _context| k_bool(rule, "tookEq"));
    reg.act("@ii-mark-has-desig", |rule, _context| {
        k_set_bool(rule, "hasDesig", true)
    });
    reg.act("@ii-mark-nested", |rule, _context| {
        k_set_str(rule, "nestedKind", "list")
    });
    reg.cond("@ii-needs-eq", |rule, _context| {
        k_bool(rule, "hasDesig") && !k_bool(rule, "tookEq")
    });
    reg.act("@ii-take-eq", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "tookEq", true);
    });
    reg.cond("@ii-needs-value", |rule, _context| {
        k_bool(rule, "hasDesig") && k_bool(rule, "tookEq") && !k_bool(rule, "gotValue")
    });
    reg.act("@initializer_item-bc", |rule, _context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let name = child_name(rule);
        let Some(node) = node_id(rule) else {
            return;
        };
        if name == "designation" && !k_bool(rule, "desigAttached") {
            cst::push_child(node, Item::Node(child));
            cst::set_extra(node, "designation", Item::Node(child));
            k_set_bool(rule, "desigAttached", true);
            return;
        }
        if name == "initializer_list" && !k_bool(rule, "gotValue") {
            // A nested list is wrapped in an `initializer`, as the
            // legacy tree has it.
            let init = cst::new_node("initializer", None);
            cst::push_child(init, Item::Node(child));
            cst::push_child(node, Item::Node(init));
            cst::set_extra(node, "value", Item::Node(init));
            k_set_bool(rule, "gotValue", true);
            return;
        }
        if child_is_val(rule) && !k_bool(rule, "gotValue") && child != node {
            cst::push_child(node, Item::Node(child));
            cst::set_extra(node, "value", Item::Node(child));
            k_set_bool(rule, "gotValue", true);
        }
    });

    // --- designation and designator ------------------------------------------
    reg.act("@designation-bo", |rule, _context| {
        if open_keep(rule, "designation", "dsNode").is_some() {
            k_del(rule, "takenDrs");
        }
    });
    reg.act("@designation-bc", |rule, _context| {
        if child_name(rule) != "designator" {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if take_once(rule, "takenDrs") {
            cst::push_child(node, Item::Node(child));
        }
    });
    reg.act("@designator-bo", |_rule, _context| {});
    reg.act("@dr-take-dot", |rule, _context| {
        let Some(token) = o0(rule) else {
            return;
        };
        let node = node_from_token("member_designator", token);
        cst::set_span(node, crate::cst::Span::zero());
        set_node_id(rule, node);
        k_set_str(rule, "kind", "member");
    });
    reg.act("@dr-take-lbracket", |rule, _context| {
        let Some(token) = o0(rule) else {
            return;
        };
        let node = node_from_token("index_designator", token);
        cst::set_span(node, crate::cst::Span::zero());
        set_node_id(rule, node);
        k_set_str(rule, "kind", "index");
    });
    reg.cond("@dr-needs-id", |rule, _context| {
        k_str(rule, "kind") == "member" && !k_bool(rule, "tookId")
    });
    reg.act("@dr-take-id", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        cst::set_extra(node, "memberName", Item::str(cst::token_src(token)));
        push_token(node, token);
        k_set_bool(rule, "tookId", true);
    });
    reg.cond("@dr-needs-rbracket", |rule, _context| {
        k_str(rule, "kind") == "index" && !k_bool(rule, "tookRbracket")
    });
    reg.act("@dr-take-rbracket", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "tookRbracket", true);
    });
    reg.act("@designator-bc", |rule, _context| {
        if k_str(rule, "kind") != "index" || !child_is_val(rule) || k_bool(rule, "idxExprAttached")
        {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if child == node {
            return;
        }
        cst::push_child(node, Item::Node(child));
        k_set_bool(rule, "idxExprAttached", true);
    });

    // --- string_atom ----------------------------------------------------------
    reg.act("@string_atom-bo", |rule, _context| {
        if let Some(node) = open_keep(rule, "literal_expression", "saNode") {
            cst::set_extra(node, "literalKind", Item::str("LIT_STRING"));
            k_set_bool(rule, "taken", false);
        }
    });
    reg.cond("@sa-reentered", |rule, _context| k_bool(rule, "taken"));
    reg.act("@sa-take", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), state_token(rule)) else {
            return;
        };
        push_token(node, token);
        let source = cst::token_src(token);
        if !k_bool(rule, "taken") {
            cst::set_extra(node, "value", Item::str(source));
            k_set_bool(rule, "taken", true);
        } else {
            let existing = match cst::extra_of(node, "value") {
                Some(Item::Val(Value::String(text))) => text,
                _ => String::new(),
            };
            cst::set_extra(node, "value", Item::str(format!("{existing}{source}")));
        }
    });

    // --- generic_selection ------------------------------------------------------
    reg.act("@generic_selection-bo", |rule, _context| {
        if let Some(node) = open_keep(rule, "generic_selection", "gsNode") {
            cst::set_extra(node, "associations", Item::List(Vec::new()));
        }
    });
    reg.cond("@gs-reentered", |rule, _context| k_bool(rule, "kwTaken"));
    reg.act("@gs-take-kw", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "kwTaken", true);
    });
    reg.cond("@gs-need-lparen", |rule, _context| {
        k_bool(rule, "kwTaken") && !k_bool(rule, "lparenTaken")
    });
    reg.act("@gs-take-lparen", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "lparenTaken", true);
    });
    reg.cond("@gs-need-ctrl", |rule, _context| {
        k_bool(rule, "lparenTaken") && !k_bool(rule, "ctrlTaken")
    });
    reg.cond("@gs-need-comma", |rule, _context| {
        k_bool(rule, "ctrlTaken") && !k_bool(rule, "commaTaken")
    });
    reg.act("@gs-take-comma", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "commaTaken", true);
        k_set_bool(rule, "lastWasAssoc", false);
    });
    reg.cond("@gs-need-association", |rule, _context| {
        k_bool(rule, "commaTaken") && !k_bool(rule, "lastWasAssoc")
    });
    reg.cond("@gs-after-association", |rule, _context| {
        k_bool(rule, "lastWasAssoc")
    });
    reg.cond("@gs-need-rparen", |rule, _context| {
        k_bool(rule, "lastWasAssoc") && !k_bool(rule, "rparenTaken")
    });
    reg.act("@gs-take-rparen", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "rparenTaken", true);
    });
    reg.act("@generic_selection-bc", |rule, _context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let name = child_name(rule);
        if name == "generic_controlling_expression" {
            take_child_field(rule, name.as_str(), "ctrlTaken", "controlling");
            return;
        }
        if name != "generic_association" {
            return;
        }
        let Some(node) = node_id(rule) else {
            return;
        };
        if !take_once(rule, "takenAssocs") {
            return;
        }
        cst::push_child(node, Item::Node(child));
        let mut associations = match cst::extra_of(node, "associations") {
            Some(Item::List(items)) => items,
            _ => Vec::new(),
        };
        associations.push(Item::Node(child));
        cst::set_extra(node, "associations", Item::List(associations));
        k_set_bool(rule, "lastWasAssoc", true);
    });

    reg.act("@generic_controlling_expression-bo", |rule, _context| {
        let node = cst::new_node("generic_controlling_expression", None);
        set_node_id(rule, node);
    });
    reg.act("@generic_controlling_expression-bc", |rule, _context| {
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
        cst::set_extra(node, "expression", Item::Node(child));
        k_set_bool(rule, "exprAttached", true);
    });

    reg.act("@generic_association-bo", |rule, _context| {
        if open_keep(rule, "generic_association", "gaNode").is_some() {
            k_del(rule, "gaKind");
            k_set_bool(rule, "gaColonTaken", false);
            k_set_bool(rule, "gaValueTaken", false);
            k_set_bool(rule, "gaTypeAttached", false);
        }
    });
    reg.cond("@ga-reentered", |rule, _context| {
        !k_str(rule, "gaKind").is_empty()
    });
    reg.act("@ga-take-default", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        cst::set_extra(node, "associationKind", Item::str("default"));
        push_token(node, token);
        k_set_str(rule, "gaKind", "default");
    });
    reg.act("@ga-mark-type", |rule, _context| {
        if let Some(node) = node_id(rule) {
            cst::set_extra(node, "associationKind", Item::str("type"));
        }
        k_set_str(rule, "gaKind", "type");
    });
    reg.cond("@ga-need-colon", |rule, _context| {
        !k_str(rule, "gaKind").is_empty() && !k_bool(rule, "gaColonTaken")
    });
    reg.act("@ga-take-colon", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "gaColonTaken", true);
    });
    reg.cond("@ga-need-value", |rule, _context| {
        k_bool(rule, "gaColonTaken") && !k_bool(rule, "gaValueTaken")
    });
    reg.act("@generic_association-bc", |rule, _context| {
        let name = child_name(rule);
        if name == "type_name_assoc" {
            take_child_field(rule, "type_name_assoc", "gaTypeAttached", "typeName");
            return;
        }
        if !child_is_val(rule) || k_bool(rule, "gaValueTaken") {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if child == node {
            return;
        }
        cst::push_child(node, Item::Node(child));
        cst::set_extra(node, "value", Item::Node(child));
        k_set_bool(rule, "gaValueTaken", true);
    });

    reg.act("@type_name_assoc-bo", |rule, _context| {
        if open_keep(rule, "type_name", "tnaNode").is_some() {
            k_set_num(rule, "tnaDepth", 0);
        }
    });
    reg.cond("@tna-reentered", |rule, _context| {
        k_node(rule, "tnaNode").is_some()
    });
    reg.act("@tna-take", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), state_token(rule)) else {
            return;
        };
        push_token(node, token);
        track_depth(rule, "tnaDepth", token);
    });
    reg.cond("@tna-stop", |rule, _context| k_num(rule, "tnaDepth") == 0);

    // --- statement_expression -------------------------------------------------
    reg.act("@statement_expression-bo", |rule, _context| {
        let node = cst::new_node("statement_expression", None);
        set_node_id(rule, node);
    });
    reg.act("@se-take-lparen", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@se-take-rparen", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@statement_expression-bc", |rule, _context| {
        take_child_field(rule, "compound_statement", "bodyAttached", "");
    });

    // --- spec_loop relay ---------------------------------------------------------
    reg.act("@spec_loop-bc", |rule, _context| {
        let name = child_name(rule);
        if !matches!(
            name.as_str(),
            "struct_specifier"
                | "enum_specifier"
                | "attribute_spec_gcc"
                | "attribute_spec_msvc"
                | "attribute_spec_c23"
        ) {
            return;
        }
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let Some(specs) = spec_owner_u_node(rule, "specs") else {
            return;
        };
        if take_once(rule, "takenTagged") {
            cst::push_child(specs, Item::Node(child));
        }
    });

    // --- struct_specifier -----------------------------------------------------------
    reg.act("@struct_specifier-bo", |rule, _context| {
        // A fresh entry clears every flag this rule owns: the engine
        // copies the parent's `k` into a pushed child, so a struct
        // nested in another struct's member list would otherwise
        // inherit the outer specifier's progress.
        if open_keep(rule, "struct_specifier", "ssNode").is_some() {
            k_set_bool(rule, "ssKwTaken", false);
            k_set_bool(rule, "ssTagTaken", false);
            k_set_bool(rule, "ssBodyTaken", false);
        }
    });
    reg.cond("@ss-reentered", |rule, _context| k_bool(rule, "ssKwTaken"));
    reg.act("@ss-take-kw", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        let kind = if cst::token_name(token) == "KW_UNION" {
            "union_specifier"
        } else {
            "struct_specifier"
        };
        cst::set_kind(node, kind);
        push_token(node, token);
        k_set_bool(rule, "ssKwTaken", true);
    });
    reg.cond("@ss-need-tag", |rule, _context| {
        k_bool(rule, "ssKwTaken") && !k_bool(rule, "ssTagTaken") && !k_bool(rule, "ssBodyTaken")
    });
    reg.act("@ss-take-tag", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        cst::set_extra(node, "tagName", Item::str(cst::token_src(token)));
        k_set_bool(rule, "ssTagTaken", true);
    });
    reg.cond("@ss-need-body", |rule, _context| {
        k_bool(rule, "ssKwTaken") && !k_bool(rule, "ssBodyTaken")
    });
    reg.act("@struct_specifier-bc", |rule, _context| {
        take_child_field(rule, "member_decl_list", "ssBodyTaken", "");
    });

    // --- member_decl_list ------------------------------------------------------------
    reg.act("@member_decl_list-bo", |rule, _context| {
        if open_keep(rule, "member_decl_list", "mdlNode").is_some() {
            k_set_bool(rule, "mdlOpened", false);
            k_del(rule, "takenMembers");
        }
    });
    reg.cond("@mdl-reentered", |rule, _context| k_bool(rule, "mdlOpened"));
    reg.act("@mdl-take-lbrace", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "mdlOpened", true);
    });
    reg.act("@mdl-take-rbrace", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@mdl-take-empty-semi", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@member_decl_list-bc", |rule, _context| {
        if child_name(rule) != "struct_declaration" {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if take_once(rule, "takenMembers") {
            cst::push_child(node, Item::Node(child));
        }
    });

    // --- struct_declaration -------------------------------------------------------------
    reg.act("@struct_declaration-bo", |rule, _context| {
        if open_keep(rule, "struct_declaration", "sdNode").is_none() {
            return;
        }
        // The legacy tree uses `specifier_qualifier_list` rather than
        // `declaration_specifiers` for a member's specifiers.
        let specs = cst::new_node("specifier_qualifier_list", None);
        let sdl = cst::new_node("struct_declarator_list", None);
        u_set_node(rule, "specs", specs);
        u_set_node(rule, "sdl", sdl);
        k_set_bool(rule, "sdSpecsAttached", false);
        k_set_bool(rule, "sdSdlAttached", false);
        k_set_bool(rule, "sdAnyDecl", false);
        k_del(rule, "takenSdrs");
        k_del(rule, "takenTagged");
    });
    reg.cond("@sd-reentered", |rule, _context| {
        k_bool(rule, "sdSpecsAttached")
    });
    reg.act("@sd-absorb-spec-storage", |rule, _context| {
        if let (Some(specs), Some(token)) = (spec_owner_u_node(rule, "specs"), o0(rule)) {
            push_token(specs, token);
        }
    });
    reg.act("@sd-absorb-spec-type", |rule, _context| {
        if let (Some(specs), Some(token)) = (spec_owner_u_node(rule, "specs"), o0(rule)) {
            push_token(specs, token);
        }
    });
    reg.cond("@sd-need-decl-first", |rule, _context| {
        !k_bool(rule, "sdAnyDecl")
    });
    reg.act("@sd-take-comma", |rule, _context| {
        if let (Some(sdl), Some(token)) = (u_node(rule, "sdl"), c0(rule)) {
            push_token(sdl, token);
        }
    });
    reg.act("@sd-take-semi", |rule, _context| {
        let Some(node) = node_id(rule) else {
            return;
        };
        if !k_bool(rule, "sdSpecsAttached") {
            if let Some(specs) = u_node(rule, "specs") {
                cst::push_child(node, Item::Node(specs));
            }
            k_set_bool(rule, "sdSpecsAttached", true);
        }
        if let Some(sdl) = u_node(rule, "sdl") {
            if cst::child_count(sdl) > 0 && !k_bool(rule, "sdSdlAttached") {
                cst::push_child(node, Item::Node(sdl));
                k_set_bool(rule, "sdSdlAttached", true);
            }
        }
        if let Some(token) = c0(rule) {
            push_token(node, token);
        }
    });
    reg.act("@struct_declaration-bc", |rule, _context| {
        let name = child_name(rule);
        let Some(child) = child_node_id(rule) else {
            return;
        };
        if name == "struct_declarator" && take_once(rule, "takenSdrs") {
            if let Some(sdl) = u_node(rule, "sdl") {
                cst::push_child(sdl, Item::Node(child));
            }
            k_set_bool(rule, "sdAnyDecl", true);
        }
        // A tagged-type member head dispatches straight into the
        // specifier rules from open; relay the node onto the
        // specifier qualifier list, as `@spec_loop-bc` does for the
        // specifier loop.
        if matches!(name.as_str(), "struct_specifier" | "enum_specifier")
            && take_once(rule, "takenTagged")
        {
            if let Some(specs) = u_node(rule, "specs") {
                cst::push_child(specs, Item::Node(child));
            }
        }
    });

    // --- struct_declarator -----------------------------------------------------------------
    reg.act("@struct_declarator-bo", |rule, _context| {
        if open_keep(rule, "struct_declarator", "sdrNode").is_some() {
            k_set_bool(rule, "sdrDeclTaken", false);
            k_set_bool(rule, "sdrBfTaken", false);
            k_set_bool(rule, "sdrAnonBf", false);
        }
    });
    reg.cond("@sdr-reentered", |rule, _context| {
        k_bool(rule, "sdrDeclTaken")
    });
    reg.act("@sdr-mark-anon-bf", |rule, _context| {
        k_set_bool(rule, "sdrAnonBf", true)
    });
    reg.cond("@sdr-need-bf", |rule, _context| {
        k_bool(rule, "sdrDeclTaken") && !k_bool(rule, "sdrBfTaken")
    });
    reg.act("@struct_declarator-bc", |rule, _context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let Some(node) = node_id(rule) else {
            return;
        };
        let name = child_name(rule);
        if name == "init_declarator" && !k_bool(rule, "sdrDeclTaken") {
            // Lift the declarator out of the init declarator so the
            // legacy shape holds: a struct declarator wraps the
            // declarator and the bitfield width.
            if let Some(declarator) = cst::children_of(child)
                .into_iter()
                .filter_map(|item| item.as_node())
                .find(|child| cst::kind_of(*child) == "declarator")
            {
                cst::push_child(node, Item::Node(declarator));
                if let Some(declared) = cst::extra_of(child, "declaredName") {
                    cst::set_extra(node, "declaredName", declared);
                }
            }
            k_set_bool(rule, "sdrDeclTaken", true);
            return;
        }
        if name == "bitfield_width" && !k_bool(rule, "sdrBfTaken") {
            cst::push_child(node, Item::Node(child));
            k_set_bool(rule, "sdrBfTaken", true);
        }
    });

    // --- bitfield_width ------------------------------------------------------------------------
    reg.act("@bitfield_width-bo", |rule, _context| {
        let node = cst::new_node("bitfield_width", None);
        set_node_id(rule, node);
    });
    reg.act("@bfw-take-colon", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@bitfield_width-bc", |rule, _context| {
        if !child_is_val(rule) || k_bool(rule, "bfExprAttached") {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if child == node {
            return;
        }
        cst::push_child(node, Item::Node(child));
        k_set_bool(rule, "bfExprAttached", true);
    });

    // --- enum_specifier -------------------------------------------------------------------------
    reg.act("@enum_specifier-bo", |rule, _context| {
        if open_keep(rule, "enum_specifier", "esNode").is_some() {
            k_set_bool(rule, "esKwTaken", false);
            k_set_bool(rule, "esTagTaken", false);
            k_set_bool(rule, "esUtypeTaken", false);
            k_set_bool(rule, "esUtypeAttached", false);
            k_set_bool(rule, "esBodyTaken", false);
        }
    });
    reg.cond("@es-tag-reentered", |rule, _context| {
        k_bool(rule, "esKwTaken")
    });
    reg.act("@es-take-kw", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "esKwTaken", true);
    });
    reg.cond("@es-need-tag", |rule, _context| {
        k_bool(rule, "esKwTaken")
            && !k_bool(rule, "esTagTaken")
            && !k_bool(rule, "esUtypeTaken")
            && !k_bool(rule, "esBodyTaken")
    });
    reg.act("@es-take-tag", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        cst::set_extra(node, "tagName", Item::str(cst::token_src(token)));
        k_set_bool(rule, "esTagTaken", true);
    });
    reg.cond("@es-need-utype", |rule, _context| {
        k_bool(rule, "esKwTaken") && !k_bool(rule, "esUtypeTaken") && !k_bool(rule, "esBodyTaken")
    });
    reg.act("@es-take-utype-colon", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "esUtypeTaken", true);
    });
    reg.cond("@es-need-body", |rule, _context| {
        k_bool(rule, "esKwTaken") && !k_bool(rule, "esBodyTaken")
    });
    reg.act("@enum_specifier-bc", |rule, _context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let name = child_name(rule);
        let Some(node) = node_id(rule) else {
            return;
        };
        if name == "enum_utype_specs" && !k_bool(rule, "esUtypeAttached") {
            // Lift the inner declaration specifiers up.
            for item in cst::children_of(child) {
                cst::push_child(node, item);
            }
            k_set_bool(rule, "esUtypeAttached", true);
            return;
        }
        if name == "enumerator_list" && !k_bool(rule, "esBodyTaken") {
            cst::push_child(node, Item::Node(child));
            k_set_bool(rule, "esBodyTaken", true);
        }
    });

    reg.act("@enum_utype_specs-bo", |rule, _context| {
        let node = cst::new_node("declaration_specifiers", None);
        set_node_id(rule, node);
        u_set_node(rule, "specs", node);
    });
    reg.act("@eus-absorb-spec", |rule, _context| {
        if let (Some(specs), Some(token)) = (u_node(rule, "specs"), o0(rule)) {
            push_token(specs, token);
        }
    });

    // --- enumerator_list ------------------------------------------------------------------------
    reg.act("@enumerator_list-bo", |rule, _context| {
        if open_keep(rule, "enumerator_list", "elNode").is_some() {
            k_set_bool(rule, "elOpened", false);
            k_del(rule, "takenEnums");
        }
    });
    reg.cond("@el-reentered", |rule, _context| k_bool(rule, "elOpened"));
    reg.act("@el-take-lbrace", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "elOpened", true);
    });
    reg.act("@el-take-rbrace", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@el-take-comma", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
    });
    reg.act("@enumerator_list-bc", |rule, _context| {
        if child_name(rule) != "enumerator" {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if take_once(rule, "takenEnums") {
            cst::push_child(node, Item::Node(child));
        }
    });

    // --- enumerator ---------------------------------------------------------------------------------
    reg.act("@enumerator-bo", |rule, _context| {
        open_keep(rule, "enumerator", "enrNode");
    });
    reg.cond("@enr-reentered", |rule, _context| {
        k_bool(rule, "enrNameTaken")
    });
    reg.act("@enr-take-name", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        push_token(node, token);
        cst::set_extra(node, "declaredName", Item::str(cst::token_src(token)));
        k_set_bool(rule, "enrNameTaken", true);
    });
    reg.cond("@enr-need-eq", |rule, _context| {
        k_bool(rule, "enrNameTaken") && !k_bool(rule, "enrEqTaken")
    });
    reg.act("@enr-take-eq", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "enrEqTaken", true);
    });
    reg.act("@enumerator-bc", |rule, _context| {
        let name = child_name(rule);
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let Some(node) = node_id(rule) else {
            return;
        };
        if child_is_val(rule) && child != node && !k_bool(rule, "enrValueAttached") {
            // The constant expression is wrapped in an `initializer`,
            // as the legacy tree has it.
            let init = cst::new_node("initializer", None);
            cst::push_child(init, Item::Node(child));
            cst::push_child(node, Item::Node(init));
            k_set_bool(rule, "enrValueAttached", true);
        }
        if name == "attribute_spec_c23" && take_once(rule, "enrAttrTaken") {
            cst::push_child(node, Item::Node(child));
        }
    });
}
