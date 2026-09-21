/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The expression half: the C operator catalog handed to
//! [`tabnas_expr`], the evaluator that turns its S-expressions into the
//! same CST shapes the rest of the parser emits, and the C atom
//! alternates added to the base grammar's `val` rule.
//!
//! Port of `ts/src/expr-grammar.ts`.

use std::sync::Arc;

use tabnas::{AltSpec, ContextAction, PluginError, RuleSpec, Tabnas, Tin, Value};
use tabnas_expr::{EvalSite, ExprOptions, Op, OpDef, PrevalDef};

use crate::cst::{self, Item, Span};
use crate::refs::Reg;
use crate::rt::*;

/// The C operator catalog.
///
/// The binding powers are compared only by ORDER: a higher number binds
/// tighter, and `left` below `right` is left-associative. They are
/// spaced by 1000 so a future operator slots in without renumbering.
fn op_table() -> ExprOptions {
    let mut options = ExprOptions::new()
        // The comma operator, the lowest binary, left-associative.
        .with_op("comma", OpDef::infix(",", 1_000, 1_001))
        // Assignment, right-associative, so `left` is above `right`.
        .with_op("assign", OpDef::infix("=", 2_001, 2_000))
        .with_op("plus_a", OpDef::infix("+=", 2_001, 2_000))
        .with_op("minus_a", OpDef::infix("-=", 2_001, 2_000))
        .with_op("star_a", OpDef::infix("*=", 2_001, 2_000))
        .with_op("slash_a", OpDef::infix("/=", 2_001, 2_000))
        .with_op("pct_a", OpDef::infix("%=", 2_001, 2_000))
        .with_op("lsh_a", OpDef::infix("<<=", 2_001, 2_000))
        .with_op("rsh_a", OpDef::infix(">>=", 2_001, 2_000))
        .with_op("amp_a", OpDef::infix("&=", 2_001, 2_000))
        .with_op("crt_a", OpDef::infix("^=", 2_001, 2_000))
        .with_op("pipe_a", OpDef::infix("|=", 2_001, 2_000));

    // The ternary pair.
    let mut ternary = OpDef::ternary("?", ":");
    ternary.left = Some(3_001);
    ternary.right = Some(3_000);
    options = options.with_op("tern", ternary);

    options = options
        // The binary ladder, logical-or down to multiplicative, all
        // left-associative.
        .with_op("or", OpDef::infix("||", 4_000, 4_001))
        .with_op("and", OpDef::infix("&&", 5_000, 5_001))
        .with_op("bor", OpDef::infix("|", 6_000, 6_001))
        .with_op("bxor", OpDef::infix("^", 7_000, 7_001))
        .with_op("band", OpDef::infix("&", 8_000, 8_001))
        .with_op("eq", OpDef::infix("==", 9_000, 9_001))
        .with_op("ne", OpDef::infix("!=", 9_000, 9_001))
        .with_op("lt", OpDef::infix("<", 10_000, 10_001))
        .with_op("le", OpDef::infix("<=", 10_000, 10_001))
        .with_op("gt", OpDef::infix(">", 10_000, 10_001))
        .with_op("ge", OpDef::infix(">=", 10_000, 10_001))
        .with_op("lsh", OpDef::infix("<<", 11_000, 11_001))
        .with_op("rsh", OpDef::infix(">>", 11_000, 11_001))
        .with_op("plus", OpDef::infix("+", 12_000, 12_001))
        .with_op("minus", OpDef::infix("-", 12_000, 12_001))
        .with_op("star", OpDef::infix("*", 13_000, 13_001))
        .with_op("slash", OpDef::infix("/", 13_000, 13_001))
        .with_op("pct", OpDef::infix("%", 13_000, 13_001))
        // Prefix unary.
        .with_op("pre_inc", OpDef::prefix("++", 16_000))
        .with_op("pre_dec", OpDef::prefix("--", 16_000))
        .with_op("unary_p", OpDef::prefix("+", 16_000))
        .with_op("unary_n", OpDef::prefix("-", 16_000))
        .with_op("lnot", OpDef::prefix("!", 16_000))
        .with_op("bnot", OpDef::prefix("~", 16_000))
        .with_op("deref", OpDef::prefix("*", 16_000))
        .with_op("addr", OpDef::prefix("&", 16_000))
        // `sizeof` and the alignment operators are unary prefix
        // operators. Their sources are already fixed tokens, so the
        // plugin reuses those identities rather than minting its own.
        .with_op("sizeof", OpDef::prefix("sizeof", 16_000))
        .with_op("alignof", OpDef::prefix("_Alignof", 16_000))
        .with_op("alignof_g", OpDef::prefix("alignof", 16_000))
        .with_op("gnualignof", OpDef::prefix("__alignof__", 16_000))
        .with_op("gnualignof_s", OpDef::prefix("__alignof", 16_000))
        // Postfix.
        .with_op("post_inc", OpDef::suffix("++", 17_000))
        .with_op("post_dec", OpDef::suffix("--", 17_000))
        // Member access, left-associative: `a.b.c` is `(a.b).c`.
        .with_op("dot", OpDef::infix(".", 17_000, 17_001))
        .with_op("arrow", OpDef::infix("->", 17_000, 17_001));

    // The paren forms. A call and a subscript take a preceding value;
    // a grouping does not.
    options = options
        .with_op(
            "paren",
            OpDef::paren("(", ")").with_preval(PrevalDef {
                active: false,
                required: false,
                allow: None,
            }),
        )
        .with_op(
            "call",
            OpDef::paren("(", ")").with_preval(PrevalDef {
                active: true,
                required: false,
                allow: None,
            }),
        )
        .with_op(
            "subscript",
            OpDef::paren("[", "]").with_preval(PrevalDef {
                active: true,
                required: true,
                allow: None,
            }),
        );

    options.with_evaluate(evaluate_c_expr)
}

/// The assignment operator names, as the plugin spells them once the
/// family suffix is appended.
const ASSIGN_NAMES: &[&str] = &[
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

/// The span a converted expression node carries: the first term's,
/// falling back to the operator's own token and then to zero.
fn expression_span(site: &EvalSite<'_>, terms: &[Value]) -> Span {
    if let Some(node) = terms.first().and_then(crate::state::handle_node) {
        return cst::span_of(node);
    }
    if let Some(token) = site.token() {
        return cst::token_span(token);
    }
    Span::zero()
}

/// Push a term onto a node's children, and record it under a field.
fn push_term(node: usize, term: &Value, field: &str) {
    let item = Item::from_value(term);
    cst::push_child(node, item.clone());
    if !field.is_empty() {
        cst::set_extra(node, field, item);
    }
}

/// Turn one of the plugin's S-expression nodes into the CST shape the
/// rest of the parser emits. Port of `evaluateCExpr`.
fn evaluate_c_expr(site: &mut EvalSite<'_>, op: &Op, terms: &[Value]) -> Value {
    let span = expression_span(site, terms);

    if op.name == "comma-infix" || op.name == "comma" {
        let out = cst::new_node("comma_expression", Some(span));
        for term in terms {
            match crate::state::handle_node(term) {
                Some(node) if cst::kind_of(node) == "comma_expression" => {
                    for child in cst::children_of(node) {
                        cst::push_child(out, child);
                    }
                }
                _ => {
                    if !term.is_undefined() {
                        cst::push_child(out, Item::from_value(term));
                    }
                }
            }
        }
        return crate::state::node_handle(out);
    }

    if op.ternary {
        let out = cst::new_node("conditional_expression", Some(span));
        for (index, field) in ["cond", "then", "else"].iter().enumerate() {
            if let Some(term) = terms.get(index).filter(|term| !term.is_undefined()) {
                push_term(out, term, field);
            }
        }
        return crate::state::node_handle(out);
    }

    if ASSIGN_NAMES.contains(&op.name.as_str()) {
        let out = cst::new_node("assignment_expression", Some(span));
        for (index, field) in ["left", "right"].iter().enumerate() {
            if let Some(term) = terms.get(index).filter(|term| !term.is_undefined()) {
                push_term(out, term, field);
            }
        }
        cst::set_extra(out, "op", Item::str(op.src.clone()));
        return crate::state::node_handle(out);
    }

    if op.name == "dot-infix" || op.name == "arrow-infix" {
        let out = cst::new_node("member_expression", Some(span));
        if let Some(term) = terms.first().filter(|term| !term.is_undefined()) {
            push_term(out, term, "object");
        }
        if let Some(term) = terms.get(1).filter(|term| !term.is_undefined()) {
            cst::push_child(out, Item::from_value(term));
            if let Some(name) =
                crate::state::handle_node(term).and_then(|node| cst::extra_of(node, "name"))
            {
                cst::set_extra(out, "memberName", name);
            }
        }
        cst::set_extra(out, "op", Item::str(op.src.clone()));
        return crate::state::node_handle(out);
    }

    if op.name == "call-paren" {
        let out = cst::new_node("call_expression", Some(span));
        if let Some(callee) = terms.first().filter(|term| !term.is_undefined()) {
            cst::push_child(out, Item::from_value(callee));
            if let Some(node) = crate::state::handle_node(callee) {
                if cst::kind_of(node) == "identifier_expression" {
                    if let Some(name) = cst::extra_of(node, "name") {
                        cst::set_extra(out, "callee", name);
                    }
                    let is_macro = cst::children_of(node)
                        .iter()
                        .filter_map(Item::as_token)
                        .next()
                        .map(|token| cst::token_name(token) == "MACRO_NAME")
                        .unwrap_or(false);
                    cst::set_extra(out, "isMacro", Item::bool(is_macro));
                }
            }
        }
        let args = cst::new_node("argument_list", Some(span));
        match terms.get(1) {
            Some(term) if is_plain_list(term) => {
                for entry in list_entries(term) {
                    cst::push_child(args, Item::from_value(&entry));
                }
            }
            Some(term) if !term.is_undefined() => match crate::state::handle_node(term) {
                Some(node) if cst::kind_of(node) == "comma_expression" => {
                    for child in cst::children_of(node) {
                        if child.as_token().is_none() {
                            cst::push_child(args, child);
                        }
                    }
                }
                _ => cst::push_child(args, Item::from_value(term)),
            },
            _ => {}
        }
        cst::push_child(out, Item::Node(args));
        return crate::state::node_handle(out);
    }

    if op.name == "subscript-paren" {
        let out = cst::new_node("subscript_expression", Some(span));
        if let Some(term) = terms.first().filter(|term| !term.is_undefined()) {
            push_term(out, term, "target");
        }
        let index = cst::new_node("index_list", Some(span));
        if let Some(term) = terms.get(1).filter(|term| !term.is_undefined()) {
            cst::push_child(index, Item::from_value(term));
        }
        cst::push_child(out, Item::Node(index));
        return crate::state::node_handle(out);
    }

    if op.name == "paren-paren" {
        let out = cst::new_node("paren_expression", Some(span));
        if let Some(term) = terms.first().filter(|term| !term.is_undefined()) {
            cst::push_child(out, Item::from_value(term));
        }
        return crate::state::node_handle(out);
    }

    if op.prefix {
        let out = cst::new_node("unary_expression", Some(span));
        cst::set_extra(out, "op", Item::str(op.src.clone()));
        if let Some(term) = terms.first().filter(|term| !term.is_undefined()) {
            push_term(out, term, "operand");
        }
        return crate::state::node_handle(out);
    }
    if op.suffix {
        let out = cst::new_node("postfix_unary_expression", Some(span));
        cst::set_extra(out, "op", Item::str(op.src.clone()));
        if let Some(term) = terms.first().filter(|term| !term.is_undefined()) {
            push_term(out, term, "target");
        }
        return crate::state::node_handle(out);
    }
    if op.infix {
        let out = cst::new_node("binary_expression", Some(span));
        cst::set_extra(out, "op", Item::str(op.src.clone()));
        for (index, field) in ["left", "right"].iter().enumerate() {
            if let Some(term) = terms.get(index).filter(|term| !term.is_undefined()) {
                push_term(out, term, field);
            }
        }
        return crate::state::node_handle(out);
    }

    // The defensive fallback the canonical evaluator ends with.
    let out = cst::new_node("expression", Some(span));
    for term in terms.iter().filter(|term| !term.is_undefined()) {
        cst::push_child(out, Item::from_value(term));
    }
    crate::state::node_handle(out)
}

/// True when the value is the implicit list the plugin builds for the
/// commas inside a paren form, rather than an expression node.
fn is_plain_list(value: &Value) -> bool {
    match value {
        Value::Array(_) => true,
        Value::ListRef(_) => !tabnas_expr::is_op(value),
        _ => false,
    }
}

fn list_entries(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.as_ref().clone(),
        Value::ListRef(list) => list.value.clone(),
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------
// The val rule
// ---------------------------------------------------------------------

/// A C atom node built from a matched token: a literal or an
/// identifier, with its leading trivia ahead of it.
fn atom_node(token: usize, kind: &str, literal_kind: Option<&str>) -> usize {
    let span = cst::token_data(token)
        .map(|data| data.span)
        .unwrap_or_else(Span::zero);
    let node = cst::new_node(kind, Some(span));
    for trivia in cst::leading_trivia_items(token) {
        cst::push_child(node, trivia);
    }
    cst::push_child(node, Item::Token(token));
    match literal_kind {
        Some(literal_kind) => {
            cst::set_extra(node, "literalKind", Item::str(literal_kind));
            cst::set_extra(node, "value", Item::str(cst::token_src(token)));
        }
        None => {
            cst::set_extra(node, "name", Item::str(cst::token_src(token)));
        }
    }
    node
}

/// The action the atom alternates share: build the node, put it on the
/// rule, and stash it for the after-close restore.
fn atom_action(kind: &'static str, literal_kind: Option<&'static str>) -> ContextAction {
    Arc::new(move |rule, _context| {
        let Some(token) = o0(rule) else {
            return Ok(());
        };
        let node = atom_node(token, kind, literal_kind);
        set_node_id(rule, node);
        u_set_node(rule, "cNode", node);
        Ok(())
    })
}

/// The paren-preval action: a C atom immediately followed by `(` or `[`
/// opens a call or a subscript, so the atom node is put on the rule for
/// the plugin to use as the preceding value.
fn paren_preval_action() -> ContextAction {
    Arc::new(|rule, _context| {
        let Some(token) = o0(rule) else {
            return Ok(());
        };
        let name = cst::token_name(token);
        let node = if name.starts_with("LIT_") {
            atom_node(token, "literal_expression", Some(&name))
        } else {
            atom_node(token, "identifier_expression", None)
        };
        set_node_id(rule, node);
        Ok(())
    })
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
fn alt(s: Vec<Vec<Tin>>, group: &str) -> AltSpec {
    let mut alt = AltSpec::new();
    alt.s = s;
    alt.g = group.to_string();
    alt
}

pub fn register(_reg: &mut Reg<'_>) {}

/// Install the operator plugin and the C atom alternates on `val`.
pub fn install(parser: &mut Tabnas) -> Result<(), PluginError> {
    tabnas_expr::expr(parser, &op_table())?;

    let sizeof_kw = set_tins(parser, "SIZEOF_KW");
    let simple_type_head = set_tins(parser, "SIMPLE_TYPE_HEAD");
    let c_atom = set_tins(parser, "C_ATOM");
    let c_paren_open = set_tins(parser, "C_PAREN_OPEN");
    let lparen = tins(parser, &["PUNC_LPAREN"]);
    let lbrace = tins(parser, &["PUNC_LBRACE"]);
    let generic = tins(parser, &["KW__GENERIC"]);
    let semi = tins(parser, &["PUNC_SEMI"]);
    let comma = tins(parser, &["PUNC_COMMA"]);
    let rparen = tins(parser, &["PUNC_RPAREN"]);
    let rbracket = tins(parser, &["PUNC_RBRACKET"]);
    let rbrace = tins(parser, &["PUNC_RBRACE"]);
    let colon = tins(parser, &["PUNC_COLON"]);

    // The atom alternates, with their token identities resolved here:
    // a `RuleSpec` carries no token table.
    let atoms: Vec<(Tin, &'static str, Option<&'static str>, &'static str)> = [
        (
            "LIT_INT",
            "literal_expression",
            Some("LIT_INT"),
            "c-atom,c-int",
        ),
        (
            "LIT_FLOAT",
            "literal_expression",
            Some("LIT_FLOAT"),
            "c-atom,c-float",
        ),
        (
            "LIT_CHAR",
            "literal_expression",
            Some("LIT_CHAR"),
            "c-atom,c-char",
        ),
        ("ID", "identifier_expression", None, "c-atom,c-id"),
        (
            "MACRO_NAME",
            "identifier_expression",
            None,
            "c-atom,c-macro",
        ),
        (
            "TYPEDEF_NAME",
            "identifier_expression",
            None,
            "c-atom,c-typedef",
        ),
        (
            "KW_NULLPTR",
            "literal_expression",
            Some("KW_NULLPTR"),
            "c-atom,c-nullptr",
        ),
        (
            "KW_TRUE",
            "literal_expression",
            Some("KW_TRUE"),
            "c-atom,c-true",
        ),
        (
            "KW_FALSE",
            "literal_expression",
            Some("KW_FALSE"),
            "c-atom,c-false",
        ),
    ]
    .iter()
    .filter_map(|(name, kind, literal, group)| {
        parser
            .config()
            .token(name)
            .map(|tin| (tin, *kind, *literal, *group))
    })
    .collect();

    parser.define_rule("val", move |spec: &mut RuleSpec| {
        // The multi-token discriminators run BEFORE the plugin's own
        // prefix machinery, which would otherwise read `sizeof` as a
        // prefix operator and its `( int )` as a paren expression, and
        // before the base grammar's `{`. The canonical call unshifts
        // them as a group, so they are prepended in reverse.
        let mut leading = Vec::new();

        let mut sizeof_type = alt(
            vec![sizeof_kw.clone(), lparen.clone(), simple_type_head.clone()],
            "c-sizeof-type",
        );
        sizeof_type.b = 3;
        sizeof_type.p = Some("sizeof_type_form".to_string());
        leading.push(sizeof_type);

        let mut cast = alt(
            vec![lparen.clone(), simple_type_head.clone()],
            "c-cast-or-cl",
        );
        cast.b = 2;
        cast.p = Some("cast_or_compound_literal".to_string());
        leading.push(cast);

        let mut statement_expression = alt(vec![lparen.clone(), lbrace.clone()], "c-stmt-expr");
        statement_expression.b = 2;
        statement_expression.p = Some("statement_expression".to_string());
        leading.push(statement_expression);

        let mut generic_selection = alt(vec![generic.clone()], "c-generic");
        generic_selection.b = 1;
        generic_selection.p = Some("generic_selection".to_string());
        leading.push(generic_selection);

        let mut initializer_list = alt(vec![lbrace.clone()], "c-init-list");
        initializer_list.b = 1;
        initializer_list.p = Some("initializer_list".to_string());
        leading.push(initializer_list);

        for entry in leading.into_iter().rev() {
            spec.prepend_open(entry);
        }

        // The atom recognisers, appended so they sit after the
        // operator-aware alternates the plugin added.
        let mut preval = alt(
            vec![c_atom.clone(), c_paren_open.clone()],
            "c-atom,c-call-preval",
        );
        preval.b = 1;
        preval.p = Some("expr".to_string());
        preval.action_fns.push(paren_preval_action());
        preval
            .u
            .insert("paren_preval".to_string(), Value::Bool(true));
        spec.add_open(preval);

        for (token, kind, literal, group) in atoms.clone() {
            let mut entry = alt(vec![vec![token]], group);
            entry.action_fns.push(atom_action(kind, literal));
            spec.add_open(entry);
        }
    });

    // The string atom and the terminator alternates need token
    // identities the closure above cannot resolve from a `RuleSpec`, so
    // they are added in a second pass with the parser's own table.
    let string_tin = tins(parser, &["LIT_STRING"]);
    parser.define_rule("val", move |spec: &mut RuleSpec| {
        let mut string_atom = alt(vec![string_tin.clone()], "c-atom,c-str");
        string_atom.b = 1;
        string_atom.p = Some("string_atom".to_string());
        spec.add_open(string_atom);

        // After a sub-rule returns to `val` in its close state, copy
        // its node onto `val` so the rule proceeds as if the sub-rule
        // were an atom.
        spec.add_bc_with_state(Arc::new(|rule, _context, _next, _out| {
            if matches!(
                child_name(rule).as_str(),
                "sizeof_type_form"
                    | "cast_or_compound_literal"
                    | "initializer_list"
                    | "string_atom"
                    | "generic_selection"
                    | "statement_expression"
            ) {
                if let Some(child) = child_node_id(rule) {
                    set_node_id(rule, child);
                }
            }
            Ok(None)
        }));

        // The C terminator close alternates pre-empt the base
        // grammar's implicit-list close, so reaching `;`, `)`, `]` or
        // `}` leaves `val` cleanly for the enclosing C rule. The
        // canonical call unshifts them as a group.
        let mut terminators = vec![
            {
                let mut entry = alt(vec![semi.clone()], "c-end-stmt");
                entry.b = 1;
                entry
            },
            {
                let mut entry = alt(vec![comma.clone()], "c-end-comma");
                entry.b = 1;
                entry.c_fn = Some(Arc::new(|rule, _context| !in_paren(rule)));
                entry
            },
            {
                let mut entry = alt(vec![rparen.clone()], "c-end-paren");
                entry.b = 1;
                entry
            },
            {
                let mut entry = alt(vec![rbracket.clone()], "c-end-bracket");
                entry.b = 1;
                entry
            },
            {
                let mut entry = alt(vec![rbrace.clone()], "c-end-brace");
                entry.b = 1;
                entry
            },
            {
                let mut entry = alt(vec![colon.clone()], "c-end-colon");
                entry.b = 1;
                entry.c_fn = Some(Arc::new(|rule, _context| !in_paren(rule)));
                entry
            },
        ];
        terminators.reverse();
        for entry in terminators {
            spec.prepend_close(entry);
        }

        // The base grammar's `val` close keeps only a PRIMITIVE node a
        // plugin set in an open action: an object node is read as a
        // stale parent-seeded container and overwritten with the
        // matched token. The C atom recognisers set node objects, so
        // they are restored here, after the base grammar's own
        // after-close, and only when `val` did not already settle on a
        // richer node.
        spec.add_ac_with_state(Arc::new(|rule, _context, _next, _out| {
            let Some(stashed) = u_node(rule, "cNode") else {
                return Ok(None);
            };
            let settled = node_id(rule).is_some_and(|node| !cst::kind_of(node).is_empty());
            if !settled {
                set_node_id(rule, stashed);
            }
            Ok(None)
        }));
    });

    Ok(())
}

/// True while the parse is inside one of the plugin's paren forms,
/// where a comma or a colon belongs to the operator rather than to the
/// enclosing C rule.
fn in_paren(rule: &tabnas::Rule) -> bool {
    rule.n.get("expr_paren").copied().unwrap_or(0) > 0
}
