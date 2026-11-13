/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The named members of a node that repeat one of its children. Port of
//! `ts/src/members.ts`.
//!
//! The tree holds each subtree once, in `children`. Some callers read a
//! node by name instead (a cast's operand, a conditional's branches, an
//! asm statement's sections), which the tree held as members up to 0.5;
//! [`member`] gives them back, from the node's children, by kind or by
//! place among its child nodes (its children that are nodes, its tokens
//! left out). A member a node does not have is `None`; a list member
//! (`associations`, `items`) is an array, empty when there is none.
//!
//! TypeScript's `member` and Go's `Member` answer the same, and
//! `test/spec/members.tsv` holds all three to it.

use tabnas::Value;

/// How a member is picked from a node's child nodes.
#[derive(Clone, Copy)]
enum Pick {
    OfKind(&'static str),
    AllOfKind(&'static str),
    Nth(usize),
    Last,
    LastBut(&'static str),
    Endif,
}

/// The members of a node of `kind`, by name.
fn picks(kind: &str) -> &'static [(&'static str, Pick)] {
    use Pick::*;
    match kind {
        "unary_expression" => &[("operand", Last)],
        "postfix_unary_expression" => &[("target", Nth(0))],
        "subscript_expression" => &[("target", Nth(0))],
        "member_expression" => &[("object", Nth(0))],
        "cast_expression" => &[
            ("typeName", OfKind("type_name")),
            ("operand", LastBut("type_name")),
        ],
        "compound_literal" => &[("typeName", OfKind("type_name"))],
        "conditional_expression" => &[("cond", Nth(0)), ("then", Nth(1)), ("else", Nth(2))],
        "initializer_item" => &[
            ("designation", OfKind("designation")),
            ("value", LastBut("designation")),
        ],
        "for_controls" => &[
            ("init", OfKind("for_init")),
            ("cond", OfKind("for_cond")),
            ("iter", OfKind("for_iter")),
        ],
        "for_init" | "for_cond" | "for_iter" => &[("value", Nth(0))],
        "static_assert_declaration" => &[("condition", Nth(0)), ("message", Nth(1))],
        "generic_selection" => &[
            ("controlling", OfKind("generic_controlling_expression")),
            ("associations", AllOfKind("generic_association")),
        ],
        "generic_association" => &[
            ("typeName", OfKind("type_name")),
            ("value", LastBut("type_name")),
        ],
        "generic_controlling_expression" | "asm_template" | "asm_value" => {
            &[("expression", Nth(0))]
        }
        "attribute_spec" => &[("items", AllOfKind("attribute_item"))],
        "attribute_item" => &[("argumentList", OfKind("attribute_argument_list"))],
        "asm_statement" => &[
            ("template", OfKind("asm_template")),
            ("asm_outputs", OfKind("asm_outputs")),
            ("asm_inputs", OfKind("asm_inputs")),
            ("asm_clobbers", OfKind("asm_clobbers")),
            ("asm_labels", OfKind("asm_labels")),
        ],
        "asm_operand" => &[
            ("asmName", OfKind("asm_name")),
            ("constraint", OfKind("asm_constraint")),
            ("value", OfKind("asm_value")),
        ],
        "conditional_group" => &[("endif", Endif)],
        "conditional_branch" => &[("directive", Nth(0))],
        _ => &[],
    }
}

fn field<'a>(node: &'a Value, key: &str) -> Option<&'a Value> {
    match node {
        Value::Object(entries) => entries.get(key),
        _ => None,
    }
}

fn kind(node: &Value) -> Option<&str> {
    match field(node, "kind") {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => None,
    }
}

/// Is `value` a node of the tree: not a token reference, not a raw value?
fn is_node(value: &Value) -> bool {
    kind(value).is_some_and(|kind| kind != "token")
        && matches!(field(value, "children"), Some(Value::Array(_)))
}

/// The node's child nodes, its tokens left out.
fn child_nodes(node: &Value) -> Vec<&Value> {
    match field(node, "children") {
        Some(Value::Array(items)) => items.iter().filter(|item| is_node(item)).collect(),
        _ => Vec::new(),
    }
}

/// The member names a node of `kind` has.
pub fn member_names(kind: &str) -> Vec<&'static str> {
    picks(kind).iter().map(|(name, _)| *name).collect()
}

/// The member `name` of `node`, from its children: a node, an array of
/// nodes for a list member, or `None`.
pub fn member(node: &Value, name: &str) -> Option<Value> {
    if !is_node(node) {
        return None;
    }
    let pick = picks(kind(node)?)
        .iter()
        .find(|(member, _)| *member == name)
        .map(|(_, pick)| *pick)?;
    let kids = child_nodes(node);
    let found = match pick {
        Pick::OfKind(want) => kids
            .into_iter()
            .find(|kid| kind(kid) == Some(want))
            .cloned(),
        Pick::AllOfKind(want) => {
            return Some(Value::array(
                kids.into_iter()
                    .filter(|kid| kind(kid) == Some(want))
                    .cloned()
                    .collect::<Vec<_>>(),
            ))
        }
        Pick::Nth(index) => kids.get(index).map(|kid| (*kid).clone()),
        Pick::Last => kids.last().map(|kid| (*kid).clone()),
        Pick::LastBut(other) => kids
            .into_iter()
            .rev()
            .find(|kid| kind(kid) != Some(other))
            .cloned(),
        Pick::Endif => kids
            .last()
            .filter(|kid| kind(kid) != Some("conditional_branch"))
            .map(|kid| (*kid).clone()),
    };
    found
}
