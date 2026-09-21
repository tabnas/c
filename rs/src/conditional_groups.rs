/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! Conditional-group folding: the translation-unit post-pass that
//! collapses contiguous runs of `#if` / `#ifdef` / `#ifndef`, `#elif`,
//! `#else` and `#endif` directives into one `conditional_group` node.
//!
//! Best effort, as in the canonical port: an unmatched `#endif` or an
//! unterminated `#if` leaves the surrounding children unchanged so the
//! rest of the tree stays intact.
//!
//! Port of `ts/src/conditional-groups.ts`.

use crate::cst::{
    children_of, kind_of, new_node, push_child, set_children, set_extra, span_of, Item,
};

/// The directive words that open a conditional run.
fn is_opener(directive: &str) -> bool {
    matches!(directive, "if" | "ifdef" | "ifndef")
}

/// The directive words that start a new branch of an open run.
fn is_branch(directive: &str) -> bool {
    matches!(directive, "elif" | "elifdef" | "elifndef" | "else")
}

/// The `conditional_directive` node embedded as the first child of an
/// `external_declaration`, and its directive word.
fn leading_conditional_directive(item: &Item) -> Option<(usize, String)> {
    let node = item.as_node()?;
    if kind_of(node) != "external_declaration" {
        return None;
    }
    for child in children_of(node) {
        let Some(child_node) = child.as_node() else {
            continue;
        };
        if kind_of(child_node) == "conditional_directive" {
            let directive = crate::cst::extra_of(child_node, "directive")
                .and_then(|item| match item {
                    Item::Val(tabnas::Value::String(text)) => Some(text),
                    _ => None,
                })
                .unwrap_or_default();
            return Some((child_node, directive));
        }
    }
    None
}

/// Fold every conditional run among `parent`'s children, then recurse
/// into the children that survived.
pub fn structure_conditional_groups(parent: usize) {
    structure_from(parent, &mut std::collections::HashSet::new());
}

/// The walk proper, carrying the set of nodes it has already been into.
///
/// The canonical walker recurses without one, which is correct for a
/// tree and fatal for anything else. A `conditional_expression` built
/// for a ternary in a declaration initializer holds ITSELF among its
/// descendants: the canonical walker then recurses until the JavaScript
/// engine throws `RangeError: Maximum call stack size exceeded`, and a
/// straight port of it overflows the Rust stack, which aborts the
/// process rather than returning an error. Refusing to enter a node
/// twice makes the walk terminate on that input, so the parse fails the
/// way a parse fails: see `expression_cycle` in
/// `rs/tests/limits_test.rs` and the entry in `DIVERGENCE.md`.
fn structure_from(parent: usize, seen: &mut std::collections::HashSet<usize>) {
    if !seen.insert(parent) {
        return;
    }
    let children = children_of(parent);
    let mut out: Vec<Item> = Vec::new();
    let mut index = 0;
    while index < children.len() {
        let child = &children[index];
        let directive = leading_conditional_directive(child);
        if let Some((_, word)) = directive.as_ref() {
            if is_opener(word) {
                if let Some((node, next)) = try_build_conditional_group(&children, index) {
                    out.push(Item::Node(node));
                    index = next;
                    continue;
                }
            }
        }
        out.push(child.clone());
        index += 1;
    }
    set_children(parent, out.clone());
    // Recurse into preserved children (a function body, for instance).
    for child in out {
        if let Some(node) = child.as_node() {
            if !kind_of(node).is_empty() {
                structure_from(node, seen);
            }
        }
    }
}

/// Build a `conditional_group` starting at `from`, returning the new
/// node and the index after the closing `#endif`, or `None` when no
/// matching `#endif` sits at the same nesting level.
fn try_build_conditional_group(children: &[Item], from: usize) -> Option<(usize, usize)> {
    let mut depth = 0i32;
    let mut end_index: Option<usize> = None;
    for (index, child) in children.iter().enumerate().skip(from) {
        let Some((_, word)) = leading_conditional_directive(child) else {
            continue;
        };
        if is_opener(&word) {
            depth += 1;
        } else if word == "endif" {
            depth -= 1;
            if depth == 0 {
                end_index = Some(index);
                break;
            }
        }
    }
    let end_index = end_index?;

    let group = new_node(
        "conditional_group",
        Some(span_of(children[from].as_node()?)),
    );
    let mut branches: Vec<Item> = Vec::new();
    let mut branch_start = from;
    let mut inner_depth = 0i32;
    for (index, child) in children.iter().enumerate().take(end_index).skip(from + 1) {
        let Some((_, word)) = leading_conditional_directive(child) else {
            continue;
        };
        if is_opener(&word) {
            inner_depth += 1;
        } else if word == "endif" {
            inner_depth -= 1;
        } else if inner_depth == 0 && is_branch(&word) {
            branches.push(Item::Node(push_branch(children, branch_start, index)));
            branch_start = index;
        }
    }
    branches.push(Item::Node(push_branch(children, branch_start, end_index)));

    set_extra(group, "branches", Item::List(branches.clone()));
    // The `#endif` directive is kept verbatim on its own field, and
    // appended to the children too, so a depth-first walk still emits
    // the raw tokens in order.
    set_extra(group, "endif", children[end_index].clone());
    for branch in branches {
        push_child(group, branch);
    }
    push_child(group, children[end_index].clone());

    Some((group, end_index + 1))
}

/// Build one branch of a conditional group, covering `[from, to)`.
fn push_branch(children: &[Item], from: usize, to: usize) -> usize {
    let head = children[from].clone();
    let head_span = head
        .as_node()
        .map(span_of)
        .unwrap_or_else(crate::cst::Span::zero);
    let branch = new_node("conditional_branch", Some(head_span));
    let word = leading_conditional_directive(&head)
        .map(|(_, word)| word)
        .unwrap_or_else(|| "unknown".to_string());
    set_extra(branch, "branchKind", Item::str(word));
    // The directive itself is preserved on a side field; the branch's
    // children hold the body items so a consumer can iterate them
    // without filtering.
    set_extra(branch, "directive", head.clone());

    // Recurse into the body, so a nested run inside a branch is grouped
    // too.
    let inner = new_node("__branch_body__", Some(head_span));
    for child in children.iter().take(to).skip(from + 1) {
        push_child(inner, child.clone());
    }
    structure_conditional_groups(inner);
    let body = children_of(inner);

    let mut final_children = vec![head];
    final_children.extend(body.iter().cloned());
    set_children(branch, final_children);
    set_extra(branch, "body", Item::List(body));
    branch
}
