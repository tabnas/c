/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The C-expression parser the legacy structuring path uses.
//!
//! Port of `ts/src/expr.ts`. The canonical file delegates the binary
//! level to `@jsonic/expr`'s `prattify`, which restructures a partly
//! built S-expression by binding power and is then walked into CST
//! nodes. Every C binary operator is left-associative with a distinct
//! ladder position, so this port climbs the precedence ladder directly
//! and builds the same node for the same input; `tests/c_test.rs` pins
//! the shapes the canonical suite pins.
//!
//! Atoms, prefix and postfix forms, casts, `sizeof`, `_Generic`,
//! statement expressions and compound literals are hand rolled in the
//! canonical file too.

use crate::cst::{self, Item, Span};
use crate::structure::TokenStream;

/// The type keywords a cast or a `sizeof` type form can start with.
const TYPE_KEYWORDS: &[&str] = &[
    "KW_VOID",
    "KW_CHAR",
    "KW_SHORT",
    "KW_INT",
    "KW_LONG",
    "KW_FLOAT",
    "KW_DOUBLE",
    "KW_SIGNED",
    "KW_UNSIGNED",
    "KW_BOOL",
    "KW__BOOL",
    "KW__COMPLEX",
    "KW__IMAGINARY",
    "KW___SIGNED__",
    "KW___SIGNED",
    "KW___INT8",
    "KW___INT16",
    "KW___INT32",
    "KW___INT64",
    "KW_CONST",
    "KW_VOLATILE",
    "KW_RESTRICT",
    "KW__ATOMIC",
    "KW___CONST__",
    "KW___CONST",
    "KW___VOLATILE__",
    "KW___VOLATILE",
    "KW___RESTRICT__",
    "KW___RESTRICT",
    "KW_STRUCT",
    "KW_UNION",
    "KW_ENUM",
    "KW_TYPEOF",
    "KW_TYPEOF_UNQUAL",
    "KW___TYPEOF__",
    "KW___TYPEOF",
    "KW__BITINT",
];

/// The binary operators, by token name, with their source text and
/// their left and right binding powers.
const INFIX: &[(&str, &str, i64, i64)] = &[
    ("PUNC_OR_OR", "||", 4_000, 4_001),
    ("PUNC_AND_AND", "&&", 5_000, 5_001),
    ("PUNC_PIPE", "|", 6_000, 6_001),
    ("PUNC_CARET", "^", 7_000, 7_001),
    ("PUNC_AMP", "&", 8_000, 8_001),
    ("PUNC_EQ", "==", 9_000, 9_001),
    ("PUNC_NE", "!=", 9_000, 9_001),
    ("PUNC_LT", "<", 10_000, 10_001),
    ("PUNC_LE", "<=", 10_000, 10_001),
    ("PUNC_GT", ">", 10_000, 10_001),
    ("PUNC_GE", ">=", 10_000, 10_001),
    ("PUNC_LSHIFT", "<<", 11_000, 11_001),
    ("PUNC_RSHIFT", ">>", 11_000, 11_001),
    ("PUNC_PLUS", "+", 12_000, 12_001),
    ("PUNC_MINUS", "-", 12_000, 12_001),
    ("PUNC_STAR", "*", 13_000, 13_001),
    ("PUNC_SLASH", "/", 13_000, 13_001),
    ("PUNC_PERCENT", "%", 13_000, 13_001),
];

/// The assignment operators, by token name, with their source text.
const ASSIGN: &[(&str, &str)] = &[
    ("PUNC_ASSIGN", "="),
    ("PUNC_PLUS_ASSIGN", "+="),
    ("PUNC_MINUS_ASSIGN", "-="),
    ("PUNC_STAR_ASSIGN", "*="),
    ("PUNC_SLASH_ASSIGN", "/="),
    ("PUNC_PERCENT_ASSIGN", "%="),
    ("PUNC_LSHIFT_ASSIGN", "<<="),
    ("PUNC_RSHIFT_ASSIGN", ">>="),
    ("PUNC_AMP_ASSIGN", "&="),
    ("PUNC_CARET_ASSIGN", "^="),
    ("PUNC_PIPE_ASSIGN", "|="),
];

/// The prefix operators, recognized by source only.
const PREFIX_OPS: &[&str] = &[
    "PUNC_PLUS_PLUS",
    "PUNC_MINUS_MINUS",
    "PUNC_PLUS",
    "PUNC_MINUS",
    "PUNC_BANG",
    "PUNC_TILDE",
    "PUNC_STAR",
    "PUNC_AMP",
    "KW_SIZEOF",
    "KW__ALIGNOF",
    "KW_ALIGNOF",
    "KW___ALIGNOF__",
    "KW___ALIGNOF",
    "KW___REAL__",
    "KW___IMAG__",
    "KW___EXTENSION__",
];

const POSTFIX_OPS: &[&str] = &["PUNC_PLUS_PLUS", "PUNC_MINUS_MINUS"];

fn infix_of(name: &str) -> Option<(&'static str, i64, i64)> {
    INFIX
        .iter()
        .find(|(token, _, _, _)| *token == name)
        .map(|(_, src, left, right)| (*src, *left, *right))
}

fn assign_of(name: &str) -> Option<&'static str> {
    ASSIGN
        .iter()
        .find(|(token, _)| *token == name)
        .map(|(_, src)| *src)
}

fn span_of_token(token: usize) -> Span {
    cst::token_data(token)
        .map(|data| data.span)
        .unwrap_or_else(Span::zero)
}

/// The entry point: a full expression, stopping at any of `stoppers`.
pub fn parse_expression(stream: &mut TokenStream, stoppers: &[&str]) -> Option<usize> {
    parse_comma_expr(stream, stoppers)
}

fn parse_comma_expr(stream: &mut TokenStream, stoppers: &[&str]) -> Option<usize> {
    let first = parse_assignment_expression(stream, stoppers)?;
    if stoppers.contains(&"PUNC_COMMA") || stream.peek_name(0) != "PUNC_COMMA" {
        return Some(first);
    }
    let node = cst::new_node("comma_expression", Some(cst::span_of(first)));
    cst::push_child(node, Item::Node(first));
    while stream.peek_name(0) == "PUNC_COMMA" && !stoppers.contains(&"PUNC_COMMA") {
        stream.take_into(node);
        match parse_assignment_expression(stream, stoppers) {
            Some(next) => cst::push_child(node, Item::Node(next)),
            None => break,
        }
    }
    Some(node)
}

pub fn parse_assignment_expression(stream: &mut TokenStream, stoppers: &[&str]) -> Option<usize> {
    let left = parse_conditional_expression(stream, stoppers)?;
    let name = stream.peek_name(0);
    if name.is_empty() || stoppers.contains(&name.as_str()) {
        return Some(left);
    }
    let Some(source) = assign_of(&name) else {
        return Some(left);
    };
    let node = cst::new_node("assignment_expression", Some(cst::span_of(left)));
    cst::push_child(node, Item::Node(left));
    cst::set_extra(node, "left", Item::Node(left));
    stream.take_into(node);
    cst::set_extra(node, "op", Item::str(source));
    if let Some(right) = parse_assignment_expression(stream, stoppers) {
        cst::push_child(node, Item::Node(right));
        cst::set_extra(node, "right", Item::Node(right));
    }
    Some(node)
}

fn parse_conditional_expression(stream: &mut TokenStream, stoppers: &[&str]) -> Option<usize> {
    let cond = parse_binary_expression(stream, stoppers, i64::MIN)?;
    if stream.peek_name(0) != "PUNC_QUESTION" {
        return Some(cond);
    }
    let node = cst::new_node("conditional_expression", Some(cst::span_of(cond)));
    cst::push_child(node, Item::Node(cond));
    cst::set_extra(node, "cond", Item::Node(cond));
    stream.take_into(node);
    let mut inner: Vec<&str> = stoppers.to_vec();
    inner.push("PUNC_COLON");
    if let Some(then) = parse_expression(stream, &inner) {
        cst::push_child(node, Item::Node(then));
        cst::set_extra(node, "then", Item::Node(then));
    }
    if stream.peek_name(0) == "PUNC_COLON" {
        stream.take_into(node);
    }
    // Right-associative: the alternative is itself a conditional
    // expression, which the assignment level subsumes.
    if let Some(alternative) = parse_assignment_expression(stream, stoppers) {
        cst::push_child(node, Item::Node(alternative));
        cst::set_extra(node, "else", Item::Node(alternative));
    }
    Some(node)
}

/// The binary ladder. Every C binary operator is left-associative, so
/// climbing from `min_power` reproduces what the canonical file gets
/// from `prattify`.
fn parse_binary_expression(
    stream: &mut TokenStream,
    stoppers: &[&str],
    min_power: i64,
) -> Option<usize> {
    let mut left = parse_unary(stream, stoppers)?;
    loop {
        let name = stream.peek_name(0);
        if name.is_empty() || stoppers.contains(&name.as_str()) {
            break;
        }
        let Some((source, left_power, right_power)) = infix_of(&name) else {
            break;
        };
        if left_power < min_power {
            break;
        }
        let node = cst::new_node("binary_expression", Some(cst::span_of(left)));
        cst::push_child(node, Item::Node(left));
        cst::set_extra(node, "left", Item::Node(left));
        stream.take_into(node);
        let Some(right) = parse_binary_expression(stream, stoppers, right_power) else {
            // The canonical loop breaks without the operator when the
            // right operand is missing, which leaves the left term as
            // the whole expression.
            return Some(left);
        };
        cst::push_child(node, Item::Node(right));
        cst::set_extra(node, "right", Item::Node(right));
        cst::set_extra(node, "op", Item::str(source));
        left = node;
    }
    Some(left)
}

/// Prefix operators, including `sizeof` and the alignment operators in
/// their expression form.
fn parse_unary(stream: &mut TokenStream, stoppers: &[&str]) -> Option<usize> {
    let name = stream.peek_name(0);
    if !name.is_empty() && PREFIX_OPS.contains(&name.as_str()) {
        let start = stream.peek(0)?;
        let node = cst::new_node("unary_expression", Some(span_of_token(start)));
        let token = stream.take_into(node)?;
        cst::set_extra(node, "op", Item::str(cst::token_src(token)));
        // `sizeof` and the alignment operators can take a
        // parenthesised type name rather than an expression.
        if matches!(
            name.as_str(),
            "KW_SIZEOF" | "KW__ALIGNOF" | "KW_ALIGNOF" | "KW___ALIGNOF__" | "KW___ALIGNOF"
        ) && stream.peek_name(0) == "PUNC_LPAREN"
            && looks_like_type_name(stream, 1)
        {
            let start = stream.peek(0)?;
            let type_name = cst::new_node("type_name", Some(span_of_token(start)));
            consume_balanced(stream, type_name, "PUNC_LPAREN", "PUNC_RPAREN");
            cst::push_child(node, Item::Node(type_name));
            cst::set_extra(node, "operand", Item::Node(type_name));
            return Some(node);
        }
        if let Some(operand) = parse_unary(stream, stoppers) {
            cst::push_child(node, Item::Node(operand));
            cst::set_extra(node, "operand", Item::Node(operand));
        }
        return Some(node);
    }
    parse_postfix(stream, stoppers)
}

/// The postfix loop: subscript, call, member access, increment and
/// decrement.
fn parse_postfix(stream: &mut TokenStream, stoppers: &[&str]) -> Option<usize> {
    let mut target = parse_primary(stream, stoppers)?;
    loop {
        let name = stream.peek_name(0);
        if name.is_empty() || stoppers.contains(&name.as_str()) {
            break;
        }
        if name == "PUNC_LBRACKET" {
            let node = cst::new_node("subscript_expression", Some(cst::span_of(target)));
            cst::push_child(node, Item::Node(target));
            cst::set_extra(node, "target", Item::Node(target));
            let Some(start) = stream.peek(0) else {
                break;
            };
            let index = cst::new_node("index_list", Some(span_of_token(start)));
            consume_balanced(stream, index, "PUNC_LBRACKET", "PUNC_RBRACKET");
            cst::push_child(node, Item::Node(index));
            target = node;
            continue;
        }
        if name == "PUNC_LPAREN" {
            let node = cst::new_node("call_expression", Some(cst::span_of(target)));
            cst::push_child(node, Item::Node(target));
            if let Some(callee) = unwrap_callee(target) {
                cst::set_extra(node, "callee", Item::str(cst::token_src(callee)));
                cst::set_extra(
                    node,
                    "isMacro",
                    Item::bool(cst::token_name(callee) == "MACRO_NAME"),
                );
            }
            let Some(start) = stream.peek(0) else {
                break;
            };
            let args = cst::new_node("argument_list", Some(span_of_token(start)));
            stream.take_into(args);
            while !stream.done() && stream.peek_name(0) != "PUNC_RPAREN" {
                match parse_assignment_expression(stream, &["PUNC_COMMA", "PUNC_RPAREN"]) {
                    Some(argument) => cst::push_child(args, Item::Node(argument)),
                    None => {
                        stream.take_into(args);
                    }
                }
                if stream.peek_name(0) == "PUNC_COMMA" {
                    stream.take_into(args);
                }
            }
            if stream.peek_name(0) == "PUNC_RPAREN" {
                stream.take_into(args);
            }
            cst::push_child(node, Item::Node(args));
            target = node;
            continue;
        }
        if name == "PUNC_DOT" || name == "PUNC_ARROW" {
            let node = cst::new_node("member_expression", Some(cst::span_of(target)));
            cst::push_child(node, Item::Node(target));
            cst::set_extra(node, "object", Item::Node(target));
            let Some(token) = stream.take_into(node) else {
                break;
            };
            cst::set_extra(node, "op", Item::str(cst::token_src(token)));
            let member = stream.peek_name(0);
            if matches!(member.as_str(), "ID" | "TYPEDEF_NAME" | "MACRO_NAME") {
                if let Some(token) = stream.take_into(node) {
                    cst::set_extra(node, "memberName", Item::str(cst::token_src(token)));
                }
            }
            target = node;
            continue;
        }
        if POSTFIX_OPS.contains(&name.as_str()) {
            let node = cst::new_node("postfix_unary_expression", Some(cst::span_of(target)));
            cst::push_child(node, Item::Node(target));
            cst::set_extra(node, "target", Item::Node(target));
            let Some(token) = stream.take_into(node) else {
                break;
            };
            cst::set_extra(node, "op", Item::str(cst::token_src(token)));
            target = node;
            continue;
        }
        break;
    }
    Some(target)
}

fn unwrap_callee(node: usize) -> Option<usize> {
    if cst::kind_of(node) != "identifier_expression" {
        return None;
    }
    cst::children_of(node).iter().find_map(Item::as_token)
}

/// A primary expression: a literal, an identifier, a parenthesised
/// form, `_Generic`, a statement expression, a cast or a compound
/// literal.
fn parse_primary(stream: &mut TokenStream, stoppers: &[&str]) -> Option<usize> {
    let start = stream.peek(0)?;
    let name = cst::token_name(start);

    if matches!(name.as_str(), "KW_NULLPTR" | "KW_TRUE" | "KW_FALSE") {
        let node = cst::new_node("literal_expression", Some(span_of_token(start)));
        let token = stream.take_into(node)?;
        cst::set_extra(node, "literalKind", Item::str(name));
        cst::set_extra(node, "value", Item::str(cst::token_src(token)));
        return Some(node);
    }

    if matches!(
        name.as_str(),
        "LIT_INT" | "LIT_FLOAT" | "LIT_CHAR" | "LIT_STRING"
    ) {
        let node = cst::new_node("literal_expression", Some(span_of_token(start)));
        let token = stream.take_into(node)?;
        cst::set_extra(node, "literalKind", Item::str(name.clone()));
        cst::set_extra(node, "value", Item::str(cst::token_src(token)));
        // Adjacent string literals concatenate, and stay in one node.
        if name == "LIT_STRING" {
            while stream.peek_name(0) == "LIT_STRING" {
                stream.take_into(node);
            }
        }
        return Some(node);
    }

    if matches!(name.as_str(), "ID" | "MACRO_NAME" | "TYPEDEF_NAME") {
        let node = cst::new_node("identifier_expression", Some(span_of_token(start)));
        let token = stream.take_into(node)?;
        cst::set_extra(node, "name", Item::str(cst::token_src(token)));
        return Some(node);
    }

    if name == "KW__GENERIC" {
        return Some(parse_generic_selection(stream));
    }

    if name == "PUNC_LPAREN" {
        // The GCC statement expression `({ ... })`.
        if stream.peek_name(1) == "PUNC_LBRACE" {
            let node = cst::new_node("statement_expression", Some(span_of_token(start)));
            consume_balanced(stream, node, "PUNC_LPAREN", "PUNC_RPAREN");
            return Some(node);
        }
        // A cast, a parenthesised expression or a compound literal.
        if looks_like_type_name(stream, 1) {
            let mark = stream.mark();
            let opener = stream.take()?;
            let type_name = cst::new_node("type_name", Some(span_of_token(opener.token)));
            cst::push_child(type_name, Item::Token(opener.token));
            let mut depth = 1i32;
            while !stream.done() && depth > 0 {
                let name = stream.peek_name(0);
                if name == "PUNC_LPAREN" {
                    depth += 1;
                } else if name == "PUNC_RPAREN" {
                    depth -= 1;
                    if depth == 0 {
                        stream.take_into(type_name);
                        break;
                    }
                }
                stream.take_into(type_name);
            }
            // A compound literal is followed by `{`.
            if stream.peek_name(0) == "PUNC_LBRACE" {
                let node = cst::new_node("compound_literal", Some(cst::span_of(type_name)));
                cst::push_child(node, Item::Node(type_name));
                cst::set_extra(node, "typeName", Item::Node(type_name));
                let Some(brace) = stream.peek(0) else {
                    return Some(node);
                };
                let list = cst::new_node("initializer_list", Some(span_of_token(brace)));
                consume_balanced(stream, list, "PUNC_LBRACE", "PUNC_RBRACE");
                cst::push_child(node, Item::Node(list));
                return Some(node);
            }
            // A cast is followed by an expression.
            if let Some(operand) = parse_unary(stream, stoppers) {
                let node = cst::new_node("cast_expression", Some(cst::span_of(type_name)));
                cst::push_child(node, Item::Node(type_name));
                cst::push_child(node, Item::Node(operand));
                cst::set_extra(node, "typeName", Item::Node(type_name));
                cst::set_extra(node, "operand", Item::Node(operand));
                return Some(node);
            }
            // Neither: rewind and read a parenthesised expression.
            stream.restore(mark);
        }
        let node = cst::new_node("paren_expression", Some(span_of_token(start)));
        stream.take_into(node);
        if let Some(inner) = parse_expression(stream, &["PUNC_RPAREN"]) {
            cst::push_child(node, Item::Node(inner));
        }
        if stream.peek_name(0) == "PUNC_RPAREN" {
            stream.take_into(node);
        }
        return Some(node);
    }

    None
}

/// Does the token at `offset` begin a type name? Enough for the common
/// cast, `sizeof` and compound-literal cases.
fn looks_like_type_name(stream: &TokenStream, offset: usize) -> bool {
    let name = stream.peek_name(offset);
    name == "TYPEDEF_NAME" || TYPE_KEYWORDS.contains(&name.as_str())
}

fn parse_generic_selection(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "generic_selection",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    stream.take_into(node);
    if stream.peek_name(0) != "PUNC_LPAREN" {
        return node;
    }
    stream.take_into(node);

    if let Some(control) = parse_expression(stream, &["PUNC_COMMA", "PUNC_RPAREN"]) {
        let wrap = cst::new_node(
            "generic_controlling_expression",
            Some(cst::span_of(control)),
        );
        cst::push_child(wrap, Item::Node(control));
        cst::set_extra(wrap, "expression", Item::Node(control));
        cst::push_child(node, Item::Node(wrap));
        cst::set_extra(node, "controlling", Item::Node(wrap));
    }

    let mut associations: Vec<Item> = Vec::new();
    while stream.peek_name(0) == "PUNC_COMMA" {
        stream.take_into(node);
        match parse_generic_association(stream) {
            Some(association) => {
                cst::push_child(node, Item::Node(association));
                associations.push(Item::Node(association));
            }
            None => break,
        }
    }
    cst::set_extra(node, "associations", Item::List(associations));
    if stream.peek_name(0) == "PUNC_RPAREN" {
        stream.take_into(node);
    }
    node
}

fn parse_generic_association(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("generic_association", Some(span_of_token(start)));

    if cst::token_name(start) == "KW_DEFAULT" {
        stream.take_into(node);
        cst::set_extra(node, "associationKind", Item::str("default"));
    } else {
        let type_name = cst::new_node("type_name", Some(span_of_token(start)));
        let mut paren = 0i32;
        let mut bracket = 0i32;
        while !stream.done() {
            let name = stream.peek_name(0);
            if name == "PUNC_LPAREN" {
                paren += 1;
                stream.take_into(type_name);
                continue;
            }
            if name == "PUNC_RPAREN" {
                if paren == 0 {
                    break;
                }
                paren -= 1;
                stream.take_into(type_name);
                continue;
            }
            if name == "PUNC_LBRACKET" {
                bracket += 1;
                stream.take_into(type_name);
                continue;
            }
            if name == "PUNC_RBRACKET" {
                if bracket == 0 {
                    break;
                }
                bracket -= 1;
                stream.take_into(type_name);
                continue;
            }
            if paren == 0
                && bracket == 0
                && matches!(name.as_str(), "PUNC_COLON" | "PUNC_COMMA" | "PUNC_RPAREN")
            {
                break;
            }
            stream.take_into(type_name);
        }
        cst::push_child(node, Item::Node(type_name));
        cst::set_extra(node, "typeName", Item::Node(type_name));
        cst::set_extra(node, "associationKind", Item::str("type"));
    }
    if stream.peek_name(0) == "PUNC_COLON" {
        stream.take_into(node);
    }
    if let Some(value) = parse_expression(stream, &["PUNC_COMMA", "PUNC_RPAREN"]) {
        cst::push_child(node, Item::Node(value));
        cst::set_extra(node, "value", Item::Node(value));
    }
    Some(node)
}

/// Take a balanced run of tokens onto `node`, opener and closer
/// included.
pub fn consume_balanced(stream: &mut TokenStream, node: usize, open: &str, close: &str) -> bool {
    if stream.peek_name(0) != open {
        return false;
    }
    stream.take_into(node);
    let mut depth = 1i32;
    while depth > 0 && !stream.done() {
        let name = stream.peek_name(0);
        if name == open {
            depth += 1;
        } else if name == close {
            depth -= 1;
        }
        stream.take_into(node);
    }
    depth == 0
}
