/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The extension constructs: GCC inline assembly, the in-body
//! preprocessor line, the structured preprocessor directives, the
//! three attribute-specification syntaxes, and `static_assert`.
//!
//! Port of the corresponding half of `makeGrammarRefs` in
//! `ts/src/c.ts`.

use tabnas::Value;

use crate::cst::{self, Item};
use crate::refs::Reg;
use crate::rt::*;
use crate::state::with_state;
use crate::COptions;

/// The source text of the rule's second open token, which is how the
/// directive dispatcher tells one directive from another. Reading the
/// matched token rather than the lookahead avoids the gap the
/// parser's consume-and-shift leaves in the buffer.
fn open_src(rule: &tabnas::Rule, index: usize) -> String {
    rule.o
        .get(index)
        .map(|token| token.src.as_str().to_string())
        .unwrap_or_default()
}

/// Push the rule's first close token onto its node.
fn take_close(rule: &mut tabnas::Rule) {
    if let (Some(node), Some(token)) = (node_id(rule), c0(rule)) {
        push_token(node, token);
    }
}

/// Push the rule's first open token onto its node.
fn take_open(rule: &mut tabnas::Rule) {
    if let (Some(node), Some(token)) = (node_id(rule), o0(rule)) {
        push_token(node, token);
    }
}

pub fn register(reg: &mut Reg<'_>, options: &COptions) {
    let _ = options;
    crate::refs_forms::register(reg);

    // --- asm_statement -------------------------------------------------
    reg.act("@asm_statement-bo", |rule, _context| {
        if let Some(node) = open_keep(rule, "asm_statement", "asmNode") {
            cst::set_extra(node, "qualifiers", Item::List(Vec::new()));
            k_set_num(rule, "sectionIdx", 0);
        }
    });
    reg.cond("@asm-reentry", |rule, _context| k_bool(rule, "started"));
    reg.act("@asm-take-keyword", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "started", true);
    });
    reg.cond("@asm-need-qualifier", |rule, _context| {
        k_bool(rule, "started") && !k_bool(rule, "lparenTaken")
    });
    reg.act("@asm-take-qualifier", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        let mut qualifiers = match cst::extra_of(node, "qualifiers") {
            Some(Item::List(items)) => items,
            _ => Vec::new(),
        };
        qualifiers.push(Item::str(cst::token_src(token)));
        cst::set_extra(node, "qualifiers", Item::List(qualifiers));
        push_token(node, token);
    });
    reg.cond("@asm-need-lparen", |rule, _context| {
        k_bool(rule, "started") && !k_bool(rule, "lparenTaken")
    });
    reg.act("@asm-take-lparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "lparenTaken", true);
    });
    reg.cond("@asm-need-template", |rule, _context| {
        k_bool(rule, "lparenTaken") && !k_bool(rule, "templateTaken")
    });
    reg.cond("@asm-need-section-colon", |rule, _context| {
        k_bool(rule, "templateTaken")
            && !k_bool(rule, "rparenTaken")
            && !k_bool(rule, "lastWasColon")
            && k_num(rule, "sectionIdx") < 4
    });
    reg.act("@asm-take-section-colon", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "lastWasColon", true);
    });
    reg.cond("@asm-need-section", |rule, _context| {
        k_bool(rule, "lastWasColon") && !k_bool(rule, "rparenTaken")
    });
    reg.cond("@asm-need-rparen", |rule, _context| {
        k_bool(rule, "lparenTaken") && !k_bool(rule, "rparenTaken")
    });
    reg.act("@asm-take-rparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "rparenTaken", true);
    });
    reg.cond("@asm-need-semi", |rule, _context| {
        !k_bool(rule, "semiTaken")
    });
    reg.act("@asm-take-semi", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "semiTaken", true);
    });
    reg.act("@asm_statement-bc", |rule, _context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let Some(node) = node_id(rule) else {
            return;
        };
        let name = child_name(rule);
        if name == "asm_template" && !k_bool(rule, "templateTaken") {
            cst::push_child(node, Item::Node(child));
            cst::set_extra(node, "template", Item::Node(child));
            k_set_bool(rule, "templateTaken", true);
            return;
        }
        if name != "asm_section" || !take_once(rule, "takenSecs") {
            return;
        }
        let index = k_num(rule, "sectionIdx");
        let kind = ["asm_outputs", "asm_inputs", "asm_clobbers", "asm_labels"]
            .get(index.max(0) as usize)
            .copied();
        if let Some(kind) = kind {
            cst::set_kind(child, kind);
        }
        cst::push_child(node, Item::Node(child));
        if let Some(kind) = kind {
            cst::set_extra(node, kind, Item::Node(child));
        }
        k_set_num(rule, "sectionIdx", index + 1);
        k_set_bool(rule, "lastWasColon", false);
    });

    // --- asm_template ----------------------------------------------------
    reg.act("@asm_template-bo", |rule, _context| {
        let node = cst::new_node("asm_template", None);
        set_node_id(rule, node);
    });
    reg.act("@asm_template-bc", |rule, _context| {
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

    // --- asm_section ------------------------------------------------------
    reg.act("@asm_section-bo", |rule, _context| {
        if open_keep(rule, "asm_section", "asecNode").is_some() {
            k_set_bool(rule, "asecOpened", false);
            k_del(rule, "takenItems");
        }
    });
    reg.cond("@asec-needs-operand", |rule, context| {
        let index = parent_k_num(rule, "sectionIdx");
        if index != 0 && index != 1 {
            return false;
        }
        matches!(
            t_name(context, 0).as_str(),
            "PUNC_LBRACKET" | "LIT_STRING" | "ID"
        )
    });
    reg.cond("@asec-needs-clobber", |rule, context| {
        parent_k_num(rule, "sectionIdx") == 2 && t_name(context, 0) == "LIT_STRING"
    });
    reg.cond("@asec-needs-label", |rule, context| {
        parent_k_num(rule, "sectionIdx") == 3 && t_name(context, 0) == "ID"
    });
    reg.act("@asec-take-comma", |rule, _context| take_close(rule));
    reg.act("@asm_section-bc", |rule, _context| {
        if !matches!(
            child_name(rule).as_str(),
            "asm_operand" | "asm_clobber" | "asm_label_ref"
        ) {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if take_once(rule, "takenItems") {
            cst::push_child(node, Item::Node(child));
        }
    });

    // --- asm_operand, clobber and label -------------------------------------
    reg.act("@asm_operand-bo", |rule, _context| {
        if open_keep(rule, "asm_operand", "aopNode").is_some() {
            k_set_num(rule, "aopDepth", 0);
        }
    });
    reg.cond("@aop-reentered", |rule, _context| {
        k_node(rule, "aopNode").is_some() && k_bool(rule, "aopTaken")
    });
    reg.act("@aop-take", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), state_token(rule)) else {
            return;
        };
        push_token(node, token);
        k_set_bool(rule, "aopTaken", true);
        let name = cst::token_name(token);
        if matches!(name.as_str(), "PUNC_LPAREN" | "PUNC_LBRACKET") {
            let depth = k_num(rule, "aopDepth") + 1;
            k_set_num(rule, "aopDepth", depth);
        } else if matches!(name.as_str(), "PUNC_RPAREN" | "PUNC_RBRACKET") {
            let depth = k_num(rule, "aopDepth") - 1;
            k_set_num(rule, "aopDepth", depth);
        }
    });
    reg.cond("@aop-stop", |rule, _context| k_num(rule, "aopDepth") == 0);

    reg.act("@asm_clobber-bo", |rule, _context| {
        let node = cst::new_node("asm_clobber", None);
        set_node_id(rule, node);
    });
    reg.act("@acl-take", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        push_token(node, token);
        cst::set_extra(node, "value", Item::str(cst::token_src(token)));
    });

    reg.act("@asm_label_ref-bo", |rule, _context| {
        let node = cst::new_node("asm_label_ref", None);
        set_node_id(rule, node);
    });
    reg.act("@alr-take", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        push_token(node, token);
        cst::set_extra(node, "labelName", Item::str(cst::token_src(token)));
    });

    // --- preprocessor_line --------------------------------------------------
    reg.act("@preprocessor_line-bo", |rule, _context| {
        if node_id(rule).is_some_and(|node| cst::kind_of(node) == "preprocessor_line") {
            return;
        }
        let node = cst::new_node("preprocessor_line", None);
        set_node_id(rule, node);
    });
    reg.act("@pp-take-hash", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "started", true);
    });
    reg.cond("@pp-reentry", |rule, _context| k_bool(rule, "started"));
    reg.act("@pp-absorb", |rule, _context| take_close(rule));
    reg.act("@pp-take-newline", |rule, _context| take_close(rule));

    // --- the directive dispatcher ---------------------------------------------
    reg.act("@preprocessor_directive-bo", |rule, _context| {
        // The wrapper's children hold the structured directive as
        // their only entry, and `@finalize-new-path` splices them
        // into the external declaration, which is the legacy shape.
        let node = cst::new_node("preprocessor_directive_wrapper", None);
        cst::set_extra(node, "declKind", Item::str("declaration"));
        set_node_id(rule, node);
    });
    reg.act("@preprocessor_directive-bc", |rule, _context| {
        if k_bool(rule, "directiveAttached") {
            return;
        }
        let Some(child) = child_node_id(rule) else {
            return;
        };
        if !matches!(
            child_name(rule).as_str(),
            "define_directive"
                | "undef_directive"
                | "include_directive"
                | "conditional_directive"
                | "simple_directive"
        ) {
            return;
        }
        if let Some(node) = node_id(rule) {
            cst::push_child(node, Item::Node(child));
            k_set_bool(rule, "directiveAttached", true);
        }
    });
    reg.cond("@ppd-is-define", |rule, _context| {
        open_src(rule, 1) == "define"
    });
    reg.cond("@ppd-is-undef", |rule, _context| {
        open_src(rule, 1) == "undef"
    });
    reg.cond("@ppd-is-include", |rule, _context| {
        matches!(
            open_src(rule, 1).as_str(),
            "include" | "include_next" | "embed"
        )
    });
    reg.cond("@ppd-is-conditional", |rule, _context| {
        matches!(
            open_src(rule, 1).as_str(),
            "if" | "ifdef" | "ifndef" | "elif" | "elifdef" | "elifndef" | "else" | "endif"
        )
    });
    reg.cond("@ppd-is-simple", |rule, _context| {
        matches!(
            open_src(rule, 1).as_str(),
            "pragma" | "error" | "warning" | "line"
        )
    });

    // --- define_directive ------------------------------------------------------
    reg.act("@define_directive-bo", |rule, _context| {
        open_keep(rule, "define_directive", "defNode");
    });
    reg.cond("@def-reentered", |rule, _context| {
        k_bool(rule, "defHashTaken")
    });
    reg.act("@def-take-hash", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "defHashTaken", true);
    });
    reg.cond("@def-need-keyword", |rule, _context| {
        k_bool(rule, "defHashTaken") && !k_bool(rule, "defKwTaken")
    });
    reg.act("@def-take-keyword", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "defKwTaken", true);
    });
    reg.cond("@def-need-name", |rule, _context| {
        k_bool(rule, "defKwTaken") && !k_bool(rule, "defNameTaken")
    });
    reg.act("@def-take-name", |rule, context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        let name = cst::token_src(token);
        cst::set_extra(node, "macroName", Item::str(name.clone()));
        k_set_bool(rule, "defNameTaken", true);
        let end = cst::token_data(token)
            .map(|data| data.span.start + data.src.chars().count())
            .unwrap_or_default();
        k_set_num(rule, "defNameTokenEnd", end as i64);
        // Register the macro as soon as the name lands, so the
        // identifier classification of what follows sees it.
        if !name.is_empty() {
            with_state(|state| {
                state.macros.define(crate::state::MacroDef {
                    name: name.clone(),
                    is_function_like: false,
                    params: Vec::new(),
                    variadic: false,
                })
            });
            crate::refs::reclassify(context, &name, "ID", "MACRO_NAME");
        }
    });
    reg.cond("@def-paren-adjacent", |rule, context| {
        if !k_bool(rule, "defNameTaken")
            || k_bool(rule, "defParamsTaken")
            || k_bool(rule, "defBodyTaken")
        {
            return false;
        }
        let Some(token) = context.t.first() else {
            return false;
        };
        token.name.as_str() == "PUNC_LPAREN"
            && token.site.pos as i64 == k_num(rule, "defNameTokenEnd")
    });
    reg.cond("@def-need-body", |rule, _context| {
        k_bool(rule, "defNameTaken") && !k_bool(rule, "defBodyTaken")
    });
    reg.cond("@def-need-newline", |rule, _context| {
        k_bool(rule, "defBodyTaken") && !k_bool(rule, "defNewlineTaken")
    });
    reg.act("@def-take-newline", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "defNewlineTaken", true);
    });
    reg.act("@define_directive-bc", |rule, _context| {
        let Some(child) = child_node_id(rule) else {
            return;
        };
        let Some(node) = node_id(rule) else {
            return;
        };
        let name = child_name(rule);
        if name == "macro_parameter_list" && !k_bool(rule, "defParamsTaken") {
            cst::push_child(node, Item::Node(child));
            cst::set_extra(node, "macroKind", Item::str("function-like"));
            let params =
                cst::extra_of(child, "macroParams").unwrap_or_else(|| Item::List(Vec::new()));
            cst::set_extra(node, "macroParams", params);
            if matches!(
                cst::extra_of(child, "macroVariadic"),
                Some(Item::Val(Value::Bool(true)))
            ) {
                cst::set_extra(node, "macroVariadic", Item::bool(true));
            }
            k_set_bool(rule, "defParamsTaken", true);
            return;
        }
        if name == "macro_body" && !k_bool(rule, "defBodyTaken") {
            cst::push_child(node, Item::Node(child));
            if !cst::has_extra(node, "macroKind") {
                cst::set_extra(node, "macroKind", Item::str("object-like"));
            }
            k_set_bool(rule, "defBodyTaken", true);
        }
    });

    // --- macro_parameter_list ------------------------------------------------
    reg.act("@macro_parameter_list-bo", |rule, _context| {
        if let Some(node) = open_keep(rule, "macro_parameter_list", "mplNode") {
            cst::set_extra(node, "macroParams", Item::List(Vec::new()));
        }
    });
    reg.cond("@mpl-reentered", |rule, _context| k_bool(rule, "mplOpen"));
    reg.act("@mpl-take-lparen", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "mplOpen", true);
    });
    reg.act("@mpl-take-rparen", |rule, _context| take_close(rule));
    reg.act("@mpl-take-comma", |rule, _context| take_close(rule));
    reg.act("@mpl-take-ellipsis", |rule, _context| {
        take_close(rule);
        if let Some(node) = node_id(rule) {
            cst::set_extra(node, "macroVariadic", Item::bool(true));
        }
    });
    reg.act("@mpl-take-param", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        let mut params = match cst::extra_of(node, "macroParams") {
            Some(Item::List(items)) => items,
            _ => Vec::new(),
        };
        params.push(Item::str(cst::token_src(token)));
        cst::set_extra(node, "macroParams", Item::List(params));
    });
    reg.act("@mpl-absorb-other", |rule, _context| take_close(rule));

    // --- macro_body -----------------------------------------------------------
    reg.act("@macro_body-bo", |rule, _context| {
        open_keep(rule, "macro_body", "mbNode");
    });
    reg.cond("@mb-reentered", |rule, _context| k_bool(rule, "mbAny"));
    reg.act("@mb-take", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), state_token(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "mbAny", true);
    });

    // --- undef_directive --------------------------------------------------------
    reg.act("@undef_directive-bo", |rule, _context| {
        open_keep(rule, "undef_directive", "undNode");
    });
    reg.cond("@undef-reentered", |rule, _context| {
        k_bool(rule, "undHashTaken")
    });
    reg.act("@undef-take-hash", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "undHashTaken", true);
    });
    reg.cond("@undef-need-keyword", |rule, _context| {
        k_bool(rule, "undHashTaken") && !k_bool(rule, "undKwTaken")
    });
    reg.act("@undef-take-keyword", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "undKwTaken", true);
    });
    reg.cond("@undef-need-name", |rule, _context| {
        k_bool(rule, "undKwTaken") && !k_bool(rule, "undNameTaken")
    });
    reg.act("@undef-take-name", |rule, context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        let name = cst::token_src(token);
        cst::set_extra(node, "macroName", Item::str(name.clone()));
        k_set_bool(rule, "undNameTaken", true);
        if !name.is_empty() {
            with_state(|state| state.macros.undefine(&name));
            crate::refs::reclassify(context, &name, "MACRO_NAME", "ID");
        }
    });
    reg.act("@undef-take-newline", |rule, _context| take_close(rule));
    reg.act("@undef-absorb-trailing", |rule, _context| take_close(rule));

    // --- include_directive -------------------------------------------------------
    reg.act("@include_directive-bo", |rule, _context| {
        open_keep(rule, "include_directive", "incNode");
    });
    reg.cond("@inc-reentered", |rule, _context| {
        k_bool(rule, "incHashTaken")
    });
    reg.act("@inc-take-hash", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "incHashTaken", true);
    });
    reg.cond("@inc-need-keyword", |rule, _context| {
        k_bool(rule, "incHashTaken") && !k_bool(rule, "incKwTaken")
    });
    reg.act("@inc-take-keyword", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        cst::set_extra(node, "includeForm", Item::str(cst::token_src(token)));
        k_set_bool(rule, "incKwTaken", true);
    });
    reg.cond("@inc-need-header", |rule, _context| {
        k_bool(rule, "incKwTaken") && !k_bool(rule, "incHeaderTaken")
    });
    reg.act("@inc-take-header", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        let source = cst::token_src(token);
        cst::set_extra(node, "headerName", Item::str(source.clone()));
        let kind = if source.starts_with('<') {
            "angled"
        } else {
            "quoted"
        };
        cst::set_extra(node, "headerKind", Item::str(kind));
        k_set_bool(rule, "incHeaderTaken", true);
    });
    reg.cond("@inc-need-form", |rule, context| {
        if !k_bool(rule, "incKwTaken")
            || k_bool(rule, "incHeaderTaken")
            || k_bool(rule, "incFormTaken")
        {
            return false;
        }
        context
            .t
            .first()
            .is_some_and(|token| token.name.as_str() != "PP_NEWLINE")
    });
    reg.act("@inc-take-newline", |rule, _context| take_close(rule));
    reg.act("@include_directive-bc", |rule, _context| {
        if child_name(rule) != "header_form" || k_bool(rule, "incFormTaken") {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        cst::push_child(node, Item::Node(child));
        k_set_bool(rule, "incFormTaken", true);
    });

    reg.act("@header_form-bo", |rule, _context| {
        open_keep(rule, "header_form", "hfNode");
    });
    reg.cond("@hf-reentered", |rule, _context| k_bool(rule, "hfAny"));
    reg.act("@hf-take", |rule, _context| {
        if let (Some(node), Some(token)) = (node_id(rule), state_token(rule)) {
            push_token(node, token);
        }
        k_set_bool(rule, "hfAny", true);
    });

    // --- conditional_directive ------------------------------------------------------
    reg.act("@conditional_directive-bo", |rule, _context| {
        open_keep(rule, "conditional_directive", "condNode");
    });
    reg.cond("@cond-reentered", |rule, _context| {
        k_bool(rule, "condHashTaken")
    });
    reg.act("@cond-take-hash", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "condHashTaken", true);
    });
    reg.cond("@cond-need-keyword", |rule, _context| {
        k_bool(rule, "condHashTaken") && !k_bool(rule, "condKwTaken")
    });
    reg.act("@cond-take-keyword", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        cst::set_extra(node, "directive", Item::str(cst::token_src(token)));
        k_set_bool(rule, "condKwTaken", true);
    });
    reg.act("@cond-take-newline", |rule, _context| take_close(rule));
    reg.act("@cond-absorb", |rule, _context| take_close(rule));

    // --- simple_directive ---------------------------------------------------------------
    reg.act("@simple_directive-bo", |rule, _context| {
        // The kind is decided by the directive name; an unrecognised
        // one stays `unknown_directive`.
        open_keep(rule, "unknown_directive", "sd2Node");
    });
    reg.cond("@sd2-reentered", |rule, _context| {
        k_bool(rule, "sd2HashTaken")
    });
    reg.act("@sd2-take-hash", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "sd2HashTaken", true);
    });
    reg.cond("@sd2-need-keyword", |rule, _context| {
        k_bool(rule, "sd2HashTaken") && !k_bool(rule, "sd2KwTaken")
    });
    reg.act("@sd2-take-keyword", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        let kind = match cst::token_src(token).as_str() {
            "pragma" => "pragma_directive",
            "error" => "error_directive",
            "warning" => "warning_directive",
            "line" => "line_directive",
            _ => "unknown_directive",
        };
        cst::set_kind(node, kind);
        k_set_bool(rule, "sd2KwTaken", true);
    });
    reg.act("@sd2-take-newline", |rule, _context| take_close(rule));
    reg.act("@sd2-absorb", |rule, _context| take_close(rule));

    // --- attribute_spec_gcc ------------------------------------------------------------------
    reg.act("@attribute_spec_gcc-bo", |rule, _context| {
        if let Some(node) = open_keep(rule, "attribute_spec", "asgNode") {
            cst::set_extra(node, "attributeForm", Item::str("gcc"));
            cst::set_extra(node, "items", Item::List(Vec::new()));
        }
    });
    reg.cond("@asg-reentered", |rule, _context| {
        k_bool(rule, "asgKwTaken")
    });
    reg.act("@asg-take-kw", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "asgKwTaken", true);
    });
    reg.cond("@asg-need-outer-lparen", |rule, _context| {
        k_bool(rule, "asgKwTaken") && !k_bool(rule, "asgOuterLparen")
    });
    reg.act("@asg-take-outer-lparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "asgOuterLparen", true);
    });
    reg.cond("@asg-need-inner-lparen", |rule, _context| {
        k_bool(rule, "asgOuterLparen") && !k_bool(rule, "asgInnerLparen")
    });
    reg.act("@asg-take-inner-lparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "asgInnerLparen", true);
    });
    reg.cond("@asg-need-comma", |rule, _context| {
        k_bool(rule, "asgInnerLparen")
            && k_bool(rule, "asgLastWasItem")
            && !k_bool(rule, "asgInnerRparen")
    });
    reg.act("@asg-take-comma", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "asgLastWasItem", false);
    });
    reg.cond("@asg-need-item", |rule, _context| {
        k_bool(rule, "asgInnerLparen")
            && !k_bool(rule, "asgLastWasItem")
            && !k_bool(rule, "asgInnerRparen")
    });
    reg.cond("@asg-need-inner-rparen", |rule, _context| {
        k_bool(rule, "asgInnerLparen") && !k_bool(rule, "asgInnerRparen")
    });
    reg.act("@asg-take-inner-rparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "asgInnerRparen", true);
    });
    reg.cond("@asg-need-outer-rparen", |rule, _context| {
        k_bool(rule, "asgInnerRparen") && !k_bool(rule, "asgOuterRparen")
    });
    reg.act("@asg-take-outer-rparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "asgOuterRparen", true);
    });
    reg.act("@attribute_spec_gcc-bc", |rule, _context| {
        if take_attribute_item(rule) {
            k_set_bool(rule, "asgLastWasItem", true);
        }
    });

    // --- attribute_spec_msvc -------------------------------------------------------------------
    reg.act("@attribute_spec_msvc-bo", |rule, _context| {
        if let Some(node) = open_keep(rule, "attribute_spec", "asm2Node") {
            cst::set_extra(node, "attributeForm", Item::str("msvc"));
            cst::set_extra(node, "items", Item::List(Vec::new()));
        }
    });
    reg.cond("@asm2-reentered", |rule, _context| {
        k_bool(rule, "asm2KwTaken")
    });
    reg.act("@asm2-take-kw", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "asm2KwTaken", true);
    });
    reg.cond("@asm2-need-lparen", |rule, _context| {
        k_bool(rule, "asm2KwTaken") && !k_bool(rule, "asm2Lparen")
    });
    reg.act("@asm2-take-lparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "asm2Lparen", true);
    });
    reg.cond("@asm2-need-comma", |rule, _context| {
        k_bool(rule, "asm2Lparen") && k_bool(rule, "asm2LastWasItem") && !k_bool(rule, "asm2Rparen")
    });
    reg.act("@asm2-take-comma", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "asm2LastWasItem", false);
    });
    reg.cond("@asm2-need-item", |rule, _context| {
        k_bool(rule, "asm2Lparen")
            && !k_bool(rule, "asm2LastWasItem")
            && !k_bool(rule, "asm2Rparen")
    });
    reg.cond("@asm2-need-rparen", |rule, _context| {
        k_bool(rule, "asm2Lparen") && !k_bool(rule, "asm2Rparen")
    });
    reg.act("@asm2-take-rparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "asm2Rparen", true);
    });
    reg.act("@attribute_spec_msvc-bc", |rule, _context| {
        if take_attribute_item(rule) {
            k_set_bool(rule, "asm2LastWasItem", true);
        }
    });

    // --- attribute_spec_c23 ----------------------------------------------------------------------
    // The adjacency conditions read the tokens' own offsets, which is
    // what tells `[[` from a nested subscript `[ [x] ]`.
    reg.cond("@as23-adjacent-open", |_rule, context| {
        t_adjacent(context, 0)
    });
    reg.cond("@as23-adjacent-close", |rule, _context| {
        let (Some(left), Some(right)) = (rule.c0(), rule.c1()) else {
            return false;
        };
        left.site.si + left.len == right.site.si
    });
    reg.act("@attribute_spec_c23-bo", |rule, _context| {
        if let Some(node) = open_keep(rule, "attribute_spec", "as23Node") {
            cst::set_extra(node, "attributeForm", Item::str("c23"));
            cst::set_extra(node, "items", Item::List(Vec::new()));
        }
    });
    reg.cond("@as23-reentered", |rule, _context| k_bool(rule, "as23Open"));
    reg.act("@as23-take-open", |rule, _context| {
        let Some(node) = node_id(rule) else {
            return;
        };
        if let Some(token) = o0(rule) {
            push_token(node, token);
        }
        if let Some(token) = open_token(rule, 1) {
            push_token(node, token);
        }
        k_set_bool(rule, "as23Open", true);
    });
    reg.cond("@as23-need-comma", |rule, _context| {
        k_bool(rule, "as23Open") && k_bool(rule, "as23LastWasItem") && !k_bool(rule, "as23Closed")
    });
    reg.act("@as23-take-comma", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "as23LastWasItem", false);
    });
    reg.cond("@as23-need-item", |rule, _context| {
        k_bool(rule, "as23Open") && !k_bool(rule, "as23LastWasItem") && !k_bool(rule, "as23Closed")
    });
    reg.cond("@as23-need-close", |rule, _context| {
        k_bool(rule, "as23Open") && !k_bool(rule, "as23Closed")
    });
    reg.act("@as23-take-close", |rule, _context| {
        let Some(node) = node_id(rule) else {
            return;
        };
        if let Some(token) = c0(rule) {
            push_token(node, token);
        }
        if let Some(token) = rule.c1().map(cst::intern_token) {
            push_token(node, token);
        }
        k_set_bool(rule, "as23Closed", true);
    });
    reg.act("@attribute_spec_c23-bc", |rule, _context| {
        if take_attribute_item(rule) {
            k_set_bool(rule, "as23LastWasItem", true);
        }
    });

    // --- attribute_item --------------------------------------------------------------------------------
    reg.act("@attribute_item-bo", |rule, _context| {
        open_keep(rule, "attribute_item", "aiNode");
    });
    reg.cond("@ai-reentered", |rule, _context| {
        k_bool(rule, "aiNameTaken")
    });
    reg.act("@ai-take-name", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), o0(rule)) else {
            return;
        };
        push_token(node, token);
        cst::set_extra(node, "attributeName", Item::str(cst::token_src(token)));
        k_set_bool(rule, "aiNameTaken", true);
    });
    reg.cond("@ai-need-colon-1", |rule, _context| {
        k_bool(rule, "aiNameTaken") && !k_bool(rule, "aiPrefixed")
    });
    reg.act("@ai-take-colon-1", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "aiColon1", true);
    });
    reg.cond("@ai-need-colon-2", |rule, _context| {
        k_bool(rule, "aiColon1") && !k_bool(rule, "aiColon2")
    });
    reg.act("@ai-take-colon-2", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "aiColon2", true);
    });
    reg.cond("@ai-need-prefixed-name", |rule, _context| {
        k_bool(rule, "aiColon2") && !k_bool(rule, "aiPrefixed")
    });
    reg.act("@ai-take-prefixed-name", |rule, _context| {
        let (Some(node), Some(token)) = (node_id(rule), c0(rule)) else {
            return;
        };
        push_token(node, token);
        if let Some(previous) = cst::extra_of(node, "attributeName") {
            cst::set_extra(node, "attributePrefix", previous);
        }
        cst::set_extra(node, "attributeName", Item::str(cst::token_src(token)));
        k_set_bool(rule, "aiPrefixed", true);
    });
    reg.cond("@ai-need-args", |rule, _context| {
        k_bool(rule, "aiNameTaken") && !k_bool(rule, "aiArgsTaken")
    });
    reg.act("@attribute_item-bc", |rule, _context| {
        if child_name(rule) != "attribute_argument_list" || k_bool(rule, "aiArgsTaken") {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        cst::push_child(node, Item::Node(child));
        cst::set_extra(node, "argumentList", Item::Node(child));
        k_set_bool(rule, "aiArgsTaken", true);
    });

    // --- attribute_argument_list ------------------------------------------------------------------------
    reg.act("@attribute_argument_list-bo", |rule, _context| {
        open_keep(rule, "attribute_argument_list", "aalNode");
    });
    reg.cond("@aal-reentered", |rule, _context| k_bool(rule, "aalLparen"));
    reg.act("@aal-take-lparen", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "aalLparen", true);
    });
    reg.act("@aal-take-rparen", |rule, _context| take_close(rule));
    reg.act("@aal-take-comma", |rule, _context| take_close(rule));
    reg.act("@attribute_argument_list-bc", |rule, _context| {
        if !child_is_val(rule) {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if child == node {
            return;
        }
        if take_once(rule, "takenArgs") {
            cst::push_child(node, Item::Node(child));
        }
    });

    // --- static_assert_declaration --------------------------------------------------------------------------
    reg.act("@static_assert_declaration-bo", |rule, _context| {
        open_keep(rule, "static_assert_declaration", "saNode");
    });
    reg.cond("@said-reentered", |rule, _context| {
        k_bool(rule, "saKwTaken")
    });
    reg.act("@said-take-kw", |rule, _context| {
        take_open(rule);
        k_set_bool(rule, "saKwTaken", true);
    });
    reg.cond("@said-need-lparen", |rule, _context| {
        k_bool(rule, "saKwTaken") && !k_bool(rule, "saLparen")
    });
    reg.act("@said-take-lparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "saLparen", true);
        // Suppress the comma operator while the condition and the
        // message are parsed, so the separator lands as a separator
        // rather than being absorbed by the Pratt loop.
        let depth = rule.n.get("no_comma_op").copied().unwrap_or(0) + 1;
        rule.n_mut().insert("no_comma_op".to_string(), depth);
    });
    reg.cond("@said-need-cond", |rule, _context| {
        k_bool(rule, "saLparen") && !k_bool(rule, "saCondTaken")
    });
    reg.act("@said-mark-cond", |_rule, _context| {});
    reg.cond("@said-need-comma", |rule, _context| {
        k_bool(rule, "saCondTaken") && !k_bool(rule, "saComma") && !k_bool(rule, "saRparen")
    });
    reg.act("@said-take-comma", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "saComma", true);
    });
    reg.cond("@said-need-msg", |rule, _context| {
        k_bool(rule, "saComma") && !k_bool(rule, "saMsgTaken")
    });
    reg.act("@said-mark-msg", |_rule, _context| {});
    reg.cond("@said-need-rparen", |rule, _context| {
        k_bool(rule, "saCondTaken") && !k_bool(rule, "saRparen")
    });
    reg.act("@said-take-rparen", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "saRparen", true);
    });
    reg.cond("@said-need-semi", |rule, _context| {
        k_bool(rule, "saRparen") && !k_bool(rule, "saSemi")
    });
    reg.act("@said-take-semi", |rule, _context| {
        take_close(rule);
        k_set_bool(rule, "saSemi", true);
    });
    reg.act("@static_assert_declaration-bc", |rule, _context| {
        if !child_is_val(rule) {
            return;
        }
        let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
            return;
        };
        if child == node {
            return;
        }
        if !k_bool(rule, "saCondTaken") {
            cst::push_child(node, Item::Node(child));
            cst::set_extra(node, "condition", Item::Node(child));
            k_set_bool(rule, "saCondTaken", true);
        } else if k_bool(rule, "saComma") && !k_bool(rule, "saMsgTaken") {
            cst::push_child(node, Item::Node(child));
            cst::set_extra(node, "message", Item::Node(child));
            k_set_bool(rule, "saMsgTaken", true);
        }
    });
}

/// The three attribute specifications share one before-close: take the
/// closed `attribute_item` once, onto the children and the `items`
/// field.
fn take_attribute_item(rule: &mut tabnas::Rule) -> bool {
    if child_name(rule) != "attribute_item" {
        return false;
    }
    let (Some(node), Some(child)) = (node_id(rule), child_node_id(rule)) else {
        return false;
    };
    if !take_once(rule, "takenItems") {
        return false;
    }
    cst::push_child(node, Item::Node(child));
    let mut items = match cst::extra_of(node, "items") {
        Some(Item::List(items)) => items,
        _ => Vec::new(),
    };
    items.push(Item::Node(child));
    cst::set_extra(node, "items", Item::List(items));
    true
}

/// A number kept on the parent rule's `k` bag.
fn parent_k_num(rule: &tabnas::Rule, key: &str) -> i64 {
    match rule
        .parent_rule
        .as_ref()
        .and_then(|parent| parent.k.get(key))
    {
        Some(Value::Number(number)) => *number as i64,
        _ => -1,
    }
}
