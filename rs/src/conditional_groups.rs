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
///
/// The walk keeps its own stack rather than recursing. The tree it
/// walks is as deep as the source is nested, and nothing before this
/// pass bounds that: a chain like `x = a + a + ... + a` is built by a
/// loop, not by recursion, so it arrives here thousands of levels deep
/// and is refused only later, by the realize cap. Popping the children
/// in source order visits the nodes in the order the recursion did.
fn structure_from(root: usize, seen: &mut std::collections::HashSet<usize>) {
    let mut pending = vec![root];
    while let Some(parent) = pending.pop() {
        if !seen.insert(parent) {
            continue;
        }
        let out = fold_children(parent);
        // Walk into preserved children (a function body, for instance).
        pending.extend(
            out.iter()
                .rev()
                .filter_map(Item::as_node)
                .filter(|node| !kind_of(*node).is_empty()),
        );
    }
}

/// Fold the conditional runs among `parent`'s own children, and answer
/// the children it keeps.
fn fold_children(parent: usize) -> Vec<Item> {
    let children = children_of(parent);
    let matches = index_conditional_groups(&children);
    let out = fold_range(&children, 0, children.len(), &matches);
    set_children(parent, out.clone());
    out
}

#[derive(Debug)]
struct ConditionalMatch {
    end: usize,
    branches: Vec<usize>,
}

#[derive(Debug)]
struct ConditionalFrame {
    open: usize,
    branches: Vec<usize>,
}

/// Resolve every matching delimiter and top-level branch marker in one
/// pass. Nested and unmatched openers therefore never rescan a suffix.
fn index_conditional_groups(
    children: &[Item],
) -> std::collections::HashMap<usize, ConditionalMatch> {
    let mut matches = std::collections::HashMap::new();
    let mut stack: Vec<ConditionalFrame> = Vec::new();
    for (index, child) in children.iter().enumerate() {
        let Some((_, word)) = leading_conditional_directive(child) else {
            continue;
        };
        if is_opener(&word) {
            stack.push(ConditionalFrame {
                open: index,
                branches: Vec::new(),
            });
        } else if is_branch(&word) {
            if let Some(frame) = stack.last_mut() {
                frame.branches.push(index);
            }
        } else if word == "endif" {
            if let Some(frame) = stack.pop() {
                matches.insert(
                    frame.open,
                    ConditionalMatch {
                        end: index,
                        branches: frame.branches,
                    },
                );
            }
        }
    }
    matches
}

fn fold_range(
    children: &[Item],
    from: usize,
    to: usize,
    matches: &std::collections::HashMap<usize, ConditionalMatch>,
) -> Vec<Item> {
    let mut out = Vec::with_capacity(to - from);
    let mut index = from;
    while index < to {
        if let Some(group_match) = matches
            .get(&index)
            .filter(|group_match| group_match.end < to)
        {
            out.push(Item::Node(build_conditional_group(
                children,
                index,
                group_match,
                matches,
            )));
            index = group_match.end + 1;
        } else {
            out.push(children[index].clone());
            index += 1;
        }
    }
    out
}

fn build_conditional_group(
    children: &[Item],
    from: usize,
    group_match: &ConditionalMatch,
    matches: &std::collections::HashMap<usize, ConditionalMatch>,
) -> usize {
    let group_span = children[from]
        .as_node()
        .map(span_of)
        .unwrap_or_else(crate::cst::Span::zero);
    let group = new_node("conditional_group", Some(group_span));
    let mut starts = Vec::with_capacity(group_match.branches.len() + 1);
    starts.push(from);
    starts.extend(group_match.branches.iter().copied());
    for (index, start) in starts.iter().copied().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(group_match.end);
        push_child(
            group,
            Item::Node(build_branch(children, start, end, matches)),
        );
    }
    set_extra(group, "endif", children[group_match.end].clone());
    push_child(group, children[group_match.end].clone());

    group
}

/// Build one branch of a conditional group, covering `[from, to)`.
fn build_branch(
    children: &[Item],
    from: usize,
    to: usize,
    matches: &std::collections::HashMap<usize, ConditionalMatch>,
) -> usize {
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

    let mut final_children = vec![head];
    final_children.extend(fold_range(children, from + 1, to, matches));
    set_children(branch, final_children);
    branch
}
