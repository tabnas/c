// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// The concreteness contract, measured rather than asserted.
//
// The tree is a CONCRETE syntax tree, and the claim only means
// something if something checks it. A shape assertion cannot: a node
// can carry the right kind and the right children and still have
// swallowed a comment or rewritten a token.
//
// So this file reassembles the source FROM THE TREE and compares the
// two. It reassembles what the tree actually carries, which is not
// quite the whole input, and the difference is MEASURED here rather
// than assumed in either direction:
//
//   - Every token is kept verbatim, at a span that names exactly the
//     text it carries, in source order, without overlaps. That is
//     `tokens_are_verbatim_and_ordered`, and it runs over every
//     fixture input in `test/spec`.
//   - An expression's OPERATOR is not a token child. The canonical
//     plugin hands expressions to `@tabnas/expr`, which records the
//     operator as an `op` field on the node, so `1 + 2` keeps the `+`
//     as `op: "+"` with no span of its own. That is
//     `operators_are_recorded_not_lost`.
//   - A few constructs keep neither: the width parentheses of
//     `_BitInt(37)`, the parentheses of a call, a parameter list inside
//     a parenthesised declarator, and a comment that no later token
//     could take as leading trivia (one at the end of the input). These
//     are the canonical's own omissions, not this port's: the same
//     inputs lose the same bytes in TypeScript, measured with a run of
//     `ts/src/c.ts` under Node, and the shared fixtures pin the whole
//     tree, so a port that kept MORE of them would go red. They are
//     listed in `rs/README.md` under "What the tree keeps".
//
// A byte-for-byte round trip is therefore NOT a property of this
// grammar in any of the three runtimes. What is a property, and what
// this file holds the port to, is that nothing the tree does carry has
// been altered, duplicated, reordered or silently moved.

mod common;

use common::{is_c_space, tokens_of, Tok};

/// What the tree left between its tokens: the text of `source` that no
/// token claimed, whitespace removed.
///
/// Also fails, loudly, when a token is not verbatim at its span, when
/// two tokens overlap, or when they arrive out of order. Those are the
/// parts of the contract that hold with no exceptions at all.
fn uncovered(source: &str, tokens: &[Tok]) -> Result<String, String> {
    let mut gap = String::new();
    let mut at = 0usize;
    for token in tokens {
        if token.tname.is_empty() && token.src.is_empty() && token.end == 0 {
            // The no-token sentinel: a rule that matched no close token
            // still pushes it, and it stands for nothing in the source.
            continue;
        }
        if token.end > source.len() || token.start > token.end {
            return Err(format!(
                "token {} {:?} claims {}..{} of a {}-byte source",
                token.tname,
                token.src,
                token.start,
                token.end,
                source.len()
            ));
        }
        if token.start < at {
            return Err(format!(
                "token {} {:?} at {}..{} runs back over the {} bytes already covered",
                token.tname, token.src, token.start, token.end, at
            ));
        }
        if !source.is_char_boundary(token.start) || !source.is_char_boundary(token.end) {
            return Err(format!(
                "token {} {:?} spans {}..{}, which is not a character boundary",
                token.tname, token.src, token.start, token.end
            ));
        }
        let text = &source[token.start..token.end];
        if text != token.src {
            return Err(format!(
                "token {} carries {:?} but its span {}..{} is {:?}",
                token.tname, token.src, token.start, token.end, text
            ));
        }
        gap.push_str(&source[at..token.start]);
        at = token.end;
    }
    gap.push_str(&source[at..]);
    Ok(gap.chars().filter(|ch| !is_c_space(*ch)).collect())
}

/// Parse with the extensions on and answer what the tree did not cover.
fn cover(parser: &tabnas::Tabnas, source: &str) -> String {
    let value = match tabnas_c::parse_with(parser, source) {
        Ok(value) => value,
        Err(error) => panic!("parse failed for {source:?}: {}", error.code),
    };
    let json: serde_json::Value = value.to_json();
    let tokens = tokens_of(&json);
    assert!(
        !tokens.is_empty(),
        "no tokens came back for {source:?}, so nothing was checked"
    );
    match uncovered(source, &tokens) {
        Ok(gap) => gap,
        Err(why) => panic!("token contract broken for {source:?}: {why}"),
    }
}

/// Declarations, statements, trivia, the preprocessor and the compiler
/// extensions all reassemble with nothing but whitespace between the
/// tokens.
#[test]
fn whole_constructs_reassemble() {
    let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));
    for source in [
        "int x;",
        "int x = 1;",
        "static const char *s = \"a\\tb\";",
        "unsigned long long big = 18446744073709551615ULL;",
        "int a, b = 2, *c;",
        "typedef struct vec { int x; int y; } vec_t;",
        "enum status : int { OK = 0, BAD = 1, };",
        "struct s { unsigned f : 3; };",
        "void f(void);",
        "union u { int i; float f; };",
        "const volatile int * restrict p;",
        "void f(void) { while (1) { break; } }",
        "void f(void) { goto done; done: return; }",
        "/* leading */ int x;",
        "int /* between */ x;",
        "/* multi\n   line */\nint x;",
        "int \\\n x;",
        "\n\n\tint x;\n",
        "#define A 1\n",
        "#define MAX(a, b) ((a) > (b) ? (a) : (b))\n",
        "#include <stdio.h>\n",
        "#include \"local.h\"\n",
        "#undef A\n",
        "#ifndef H\n#define H\nint x;\n#endif\n",
        "#if 0\nint dead;\n#else\nint live;\n#endif\n",
        "#pragma once\n",
        "#line 42 \"other.c\"\n",
        "int x;\n#error nope\n",
        "__attribute__((packed)) struct s { int x; };",
        "__declspec(dllexport) int f(void);",
        "[[nodiscard]] int f(void);",
        "int f(void) { __asm__ __volatile__ (\"nop\"); return 0; }",
        "__extension__ int x;",
        "int __restrict__ *p;",
        "asm(\"nop\");",
    ] {
        let gap = cover(&parser, source);
        assert!(
            gap.is_empty(),
            "{source:?} lost {gap:?}: everything here is kept as a token"
        );
    }
}

/// An expression's operator is kept, as a field rather than a token.
/// The text missing from the token stream is exactly the operators the
/// tree recorded, in the order the tree records them.
#[test]
fn operators_are_recorded_not_lost() {
    let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));
    for (source, ops) in [
        ("int r = 1 + 2 * 3;", "+*"),
        ("void f(void) { a = b; }", "="),
        ("void f(void) { a = -b; }", "=-"),
        ("void f(void) { a = b + c - d; }", "=+-"),
        ("void f(void) { a = b == c; }", "==="),
        ("void f(void) { a = !b; }", "=!"),
        ("void f(void) { a = b.c; }", "=."),
        ("void f(void) { a = sizeof b; }", "=sizeof"),
    ] {
        let value = tabnas_c::parse_with(&parser, source).expect("parse");
        let json: serde_json::Value = value.to_json();
        let gap = uncovered(source, &tokens_of(&json)).expect("the token contract holds");
        assert_eq!(
            gap, ops,
            "{source:?}: the text no token covered is not the operator set"
        );
        // As a multiset. A left-associative chain nests to the LEFT,
        // so a pre-order walk meets `a = b + c - d` as `=`, `-`, `+`
        // while the source reads `=`, `+`, `-`. The claim under test is
        // that the operators are all still there, not that a pre-order
        // walk happens to meet them in source order.
        let mut recorded: Vec<char> = recorded_ops(&json).join("").chars().collect();
        let mut wanted: Vec<char> = ops.chars().collect();
        recorded.sort_unstable();
        wanted.sort_unstable();
        assert_eq!(
            recorded, wanted,
            "{source:?}: the tree does not record the operators it left out"
        );
    }
}

/// Every `op` field of the tree, in the order a pre-order walk meets
/// them.
fn recorded_ops(value: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut stack = vec![value];
    while let Some(node) = stack.pop() {
        match node {
            serde_json::Value::Array(items) => {
                for item in items.iter().rev() {
                    stack.push(item);
                }
            }
            serde_json::Value::Object(entries) => {
                if entries.get("kind").and_then(serde_json::Value::as_str) == Some("token") {
                    continue;
                }
                if let Some(op) = entries.get("op").and_then(serde_json::Value::as_str) {
                    out.push(op.to_string());
                }
                if let Some(children) = entries.get("children") {
                    stack.push(children);
                }
            }
            _ => {}
        }
    }
    out
}

/// The widest sweep in the crate: every token of every fixture input is
/// verbatim, in order, and spans exactly the bytes it claims.
#[test]
fn tokens_are_verbatim_and_ordered() {
    let dir = common::spec_dir();
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("the spec directory is readable")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "tsv"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no fixtures found in {}", dir.display());

    let plain = tabnas_c::make();
    let extended = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));

    let mut checked = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for path in &files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let text = std::fs::read_to_string(path).expect("a fixture is readable");
        for (index, line) in text.lines().enumerate().skip(1) {
            if !line.contains('\t') {
                continue;
            }
            let columns: Vec<&str> = line.split('\t').collect();
            let source = columns[0]
                .replace("\\n", "\n")
                .replace("\\t", "\t")
                .replace("\\r", "\r")
                .replace("\\\\", "\\");
            let options = columns.get(2).copied().unwrap_or_default();
            // A row that overrides the start rule parses an expression
            // on its own, and its tree is not meant to cover the input.
            if options.contains("\"start\"") {
                continue;
            }
            let parser = if options.contains("\"extended\":true") {
                &extended
            } else {
                &plain
            };
            let Ok(value) = tabnas_c::parse_with(parser, &source) else {
                continue; // an ERROR row: nothing to reassemble.
            };
            let json: serde_json::Value = value.to_json();
            checked += 1;
            if let Err(why) = uncovered(&source, &tokens_of(&json)) {
                failures.push(format!("{name}:{}: {why}", index + 1));
            }
        }
    }
    assert!(
        checked > 0,
        "no fixture row parsed, so nothing was reassembled"
    );
    assert!(
        failures.is_empty(),
        "{} of {checked} fixture inputs broke the token contract:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
