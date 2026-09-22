// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// Untrusted input.
//
// A C source file arrives from outside the system: a vendored
// dependency, an upload, generated output. None of it may be able to
// panic this crate, hang it, abort the process by overflowing the stack,
// or make it take super-linear time. See "Untrusted input" in
// ../AGENTS.md.
//
// Every test here asserts that the parser RETURNS: a tree or an error,
// either is fine. What is not fine is a crash, and in Rust a stack
// overflow is a crash the caller cannot catch.

mod common;

/// Parse and answer whether it returned at all. The value is dropped
/// inside, which matters: a `Value` drops recursively, so a tree the
/// walk built but the process cannot drop is still a crash.
fn survives(parser: &tabnas::Tabnas, source: &str) -> bool {
    match tabnas_c::parse_with(parser, source) {
        Ok(value) => {
            // Render it too: `to_json` recurses over the same shape.
            let _ = value.to_json().to_string();
            true
        }
        Err(_) => true,
    }
}

#[test]
fn empty_and_tiny_inputs() {
    let parser = tabnas_c::make();
    for source in [
        "", " ", "\n", "\t", ";", "i", "{", "}", "(", "/*", "//", "\"", "'",
    ] {
        assert!(survives(&parser, source), "{source:?} did not return");
    }
}

#[test]
fn unterminated_constructs() {
    let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));
    for source in [
        "/* never closed",
        "\"never closed",
        "'a",
        "int f(void) {",
        "int f(void) { if (a) {",
        "struct s {",
        "#define A(",
        "#include <stdio",
        "#if 1",
        "int x = (1 + 2",
        "int a[",
        "enum e {",
        "__attribute__((",
        "int x = \\",
    ] {
        assert!(survives(&parser, source), "{source:?} did not return");
    }
}

#[test]
fn control_characters_and_odd_unicode() {
    let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));
    for source in [
        "int\u{0}x;",
        "int x;\u{7}",
        "int \u{feff}x;",
        "int \u{a0}x;",
        "int x = \"\u{1f600}\";",
        "/* \u{1f600} */ int x;",
        "int \u{4e2d}\u{6587};",
        "// \u{202e}reversed\n int x;",
        "int x = '\u{1f600}';",
        "\u{feff}int x;",
    ] {
        assert!(survives(&parser, source), "{source:?} did not return");
    }
}

/// A multibyte character straddling a computed offset must not panic. A
/// slice taken at a byte offset that is not a character boundary is a
/// panic in Rust, and the spans this port computes are byte offsets.
#[test]
fn multibyte_tails_do_not_panic() {
    let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));
    // Every truncation of a source whose tail is multibyte, cut at a
    // CHARACTER boundary, since a `&str` cannot hold anything else.
    let source = "int x = \"caf\u{e9} \u{1f600} \u{4e2d}\u{6587}\"; /* \u{e9}\u{1f600} */";
    for (end, _) in source.char_indices() {
        let head = &source[..end];
        assert!(survives(&parser, head), "{head:?} did not return");
    }
    assert!(survives(&parser, source));
}

#[test]
fn very_long_input_returns() {
    let parser = tabnas_c::make();
    // One long flat translation unit: 20,000 declarations.
    let mut flat = String::new();
    for index in 0..20_000 {
        use std::fmt::Write;
        writeln!(flat, "int v{index};").expect("a String write cannot fail");
    }
    assert!(survives(&parser, &flat), "a long flat unit did not return");

    // One very long identifier, and one very long string literal.
    let long_name = format!("int {};", "a".repeat(200_000));
    assert!(survives(&parser, &long_name), "a long name did not return");
    let long_string = format!("const char *s = \"{}\";", "x".repeat(200_000));
    assert!(
        survives(&parser, &long_string),
        "a long literal did not return"
    );
}

/// A translation unit of N nested compound statements realizes at depth
/// `N + 3`, so the deepest one the cap admits has `REALIZE_DEPTH_CAP -
/// 4` braces. Both sides of that boundary are pinned, in both modes: a
/// cap tested only from past it never proves it admits anything.
const DEEPEST_ADMITTED: usize = tabnas_c::REALIZE_DEPTH_CAP - 4;

fn nest(depth: usize) -> String {
    format!(
        "void f(void) {{ {}{} }}",
        "{".repeat(depth),
        "}".repeat(depth)
    )
}

/// Nesting AT the cap returns a tree, which is the half of the boundary
/// a test usually forgets.
#[test]
fn nesting_at_the_cap() {
    for extended in [false, true] {
        let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(extended));
        let value = tabnas_c::parse_with(&parser, &nest(DEEPEST_ADMITTED))
            .unwrap_or_else(|error| panic!("{DEEPEST_ADMITTED} levels: {}", error.code));
        assert_eq!(value.to_json()["kind"], "translation_unit");
    }
}

/// One level past it the parse FAILS, and the process lives.
#[test]
fn nesting_past_the_cap() {
    for extended in [false, true] {
        let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(extended));
        for depth in [
            DEEPEST_ADMITTED + 1,
            tabnas_c::REALIZE_DEPTH_CAP * 4,
            20_000,
        ] {
            let error = tabnas_c::parse_with(&parser, &nest(depth))
                .err()
                .unwrap_or_else(|| panic!("{depth} levels should not have realized"));
            assert_eq!(
                error.code, "cancel",
                "{depth} levels reported the wrong code"
            );
        }
    }
}

/// The canonical builds a tree that holds itself for a ternary used as a
/// whole declaration initializer, and walks it until the stack runs out.
/// This port reports the engine's `cancel` code and returns. See
/// DIVERGENCE.md section 1.
#[test]
fn expression_cycle() {
    let parser = tabnas_c::make();
    let error =
        tabnas_c::parse_with(&parser, "int a = b ? c : d;").expect_err("the tree holds itself");
    assert_eq!(error.code, "cancel");

    // The same ternary inside parentheses is an ordinary parse in every
    // runtime, measured, so the guard has not swallowed a working input.
    let value = tabnas_c::parse_with(&parser, "int a = (b ? c : d);").expect("parentheses parse");
    assert_eq!(value.to_json()["kind"], "translation_unit");
}

/// Deeply nested expressions and other shapes that recurse elsewhere.
#[test]
fn other_deep_shapes_return() {
    let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));
    for source in [
        format!("int x = {}1{};", "(".repeat(5_000), ")".repeat(5_000)),
        format!("int x = {}1;", "-".repeat(5_000)),
        format!("int x{};", "[1]".repeat(5_000)),
        format!("int {}p;", "*".repeat(5_000)),
        format!("void f(void) {{ {} ; }}", "if (a) ".repeat(2_000)),
        format!(
            "{}int x;{}",
            "#if 1\n".repeat(2_000),
            "#endif\n".repeat(2_000)
        ),
    ] {
        assert!(
            survives(&parser, &source),
            "a deep shape did not return: {:?}",
            &source[..40.min(source.len())]
        );
    }
}
