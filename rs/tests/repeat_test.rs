// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// Every repetition is a replace loop (admin's and parser's "Repetition is
// replacement, never a push chain"): over 10,000 items of each, the
// deepest rule the parse reaches is as deep as over one item. Port of
// ts/test/repeat.test.ts and go/repeat_test.go.
//
// The depth is the rules', measured as they run, so each parse is the
// engine's own, unrealized: a chain a loop builds is a tree as deep as
// the chain is long (a binary chain nests a node per operator), and this
// port realizes no tree past REALIZE_DEPTH_CAP (DIVERGENCE.md#1).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const MANY_ITEMS: usize = 10_000;

/// A repetition: its name, the source of `n` items, and whether it needs
/// the extensions.
type Case = (&'static str, Box<dyn Fn(usize) -> String>, bool);

fn max_rule_depth(source: &str, extended: bool) -> usize {
    let mut parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(extended));
    let max = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&max);
    parser.subscribe_rules(move |rule, _context| {
        seen.fetch_max(rule.d, Ordering::Relaxed);
    });
    let value = parser
        .parse(source)
        .unwrap_or_else(|error| panic!("the parse failed with {}", error.code));
    // The tree lives in this thread's arena until it is realized; realize
    // it, as every parse's caller must, before the next parse.
    let _ = tabnas_c::realize(&value);
    max.load(Ordering::Relaxed)
}

#[test]
fn repetition_is_replacement() {
    let rep = |text: &str, count: usize| text.repeat(count);
    let cases: Vec<Case> = vec![
        (
            "external declarations",
            Box::new(move |n| rep("int a;\n", n)),
            false,
        ),
        (
            "block items",
            Box::new(move |n| format!("void f(void) {{{} }}", rep(" x;", n))),
            false,
        ),
        (
            "init declarators",
            Box::new(move |n| format!("int a{};", rep(", a", n - 1))),
            false,
        ),
        (
            "specifiers",
            Box::new(move |n| format!("{}int x;", rep("const ", n))),
            false,
        ),
        (
            "a binary chain",
            Box::new(move |n| format!("int x = a{};", rep(" + a", n))),
            false,
        ),
        (
            "a comma expression",
            Box::new(move |n| format!("void f(void) {{ a{}; }}", rep(", a", n - 1))),
            false,
        ),
        (
            "arguments",
            Box::new(move |n| format!("int x = f(a{});", rep(", a", n - 1))),
            false,
        ),
        (
            "a postfix chain",
            Box::new(move |n| format!("int x = a{};", rep("[0]", n))),
            false,
        ),
        (
            "member accesses",
            Box::new(move |n| format!("int x = a{};", rep(".b", n))),
            false,
        ),
        (
            "adjacent strings",
            Box::new(move |n| format!("char *s = {};", rep("\"a\" ", n))),
            false,
        ),
        (
            "brace-list items",
            Box::new(move |n| format!("int x[] = {{ 1{} }};", rep(", 1", n - 1))),
            false,
        ),
        (
            "struct members",
            Box::new(move |n| format!("struct S {{{} }};", rep(" int a;", n))),
            false,
        ),
        (
            "enumerators",
            Box::new(move |n| format!("enum E {{ A{} }};", rep(", A", n - 1))),
            false,
        ),
        (
            "parameters",
            Box::new(move |n| format!("void f(int{});", rep(", int", n - 1))),
            false,
        ),
        (
            "an unknown declaration's tokens",
            Box::new(move |n| format!("foo{};", rep(" a", n))),
            false,
        ),
        (
            "a macro body",
            Box::new(move |n| format!("#define X{}\n", rep(" a", n))),
            true,
        ),
        (
            "a conditional branch's declarations",
            Box::new(move |n| format!("#if A\n{}#endif\n", rep("int a;\n", n))),
            false,
        ),
        (
            "a conditional group's branches",
            Box::new(move |n| format!("#if A\n{}#endif\n", rep("#elif B\n", n))),
            false,
        ),
        (
            "conditional groups",
            Box::new(move |n| rep("#if A\n#endif\n", n)),
            false,
        ),
        (
            "asm operands",
            Box::new(move |n| {
                format!(
                    "void f(void) {{ asm(\"\" : \"r\" (a){}); }}",
                    rep(", \"r\" (a)", n - 1)
                )
            }),
            true,
        ),
        (
            "an asm operand's flat tokens",
            Box::new(move |n| format!("void f(void) {{ asm(\"\" : \"r\" (a){}); }}", rep(" b", n))),
            true,
        ),
    ];
    assert_eq!(cases.len(), 21);
    let mut failures = Vec::new();
    for (name, make, extended) in &cases {
        let one = max_rule_depth(&make(1), *extended);
        // A depth the subscriber never saw would pass any comparison.
        assert!(one > 1, "{name}: no rule depth was seen");
        let many = max_rule_depth(&make(MANY_ITEMS), *extended);
        if many != one {
            failures.push(format!(
                "{name}: depth {many} over {MANY_ITEMS} items, {one} over one"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
