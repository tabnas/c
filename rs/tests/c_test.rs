// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// What a fixture row cannot say.
//
// `test/spec/*.tsv` pins input to tree, which is most of the contract.
// This file holds the rest: how the plugin installs, what it refuses,
// what the options do, what the crate exports, and that the embedded
// grammar is still the grammar.

mod common;

use tabnas::{Tabnas, Value};
use tabnas_c::{CMeta, COptions};

#[test]
fn version_and_name_are_what_the_package_says() {
    assert_eq!(tabnas_c::VERSION, "0.5.7");
    assert_eq!(tabnas_c::PLUGIN_NAME, "C");
}

/// The embedded grammar must be the grammar. `ts/embed-grammar.js`
/// copies one file into three places, and a focused Rust build after an
/// edit compiles the previous text and succeeds, so the drift is only
/// visible if something compares them.
#[test]
fn the_embedded_grammar_matches_the_source() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rs/ has a parent")
        .join("ts/c-grammar.jsonic");
    let canonical = std::fs::read_to_string(&source).expect("ts/c-grammar.jsonic is readable");
    assert_eq!(
        tabnas_c::GRAMMAR_TEXT,
        canonical,
        "rs/c-grammar.jsonic has drifted from ts/c-grammar.jsonic; run `make embed`"
    );
}

/// The plugin hangs its expression alternates on the base grammar's
/// `val` rule, so a bare engine has nothing to hang them on. It says so
/// rather than installing half a grammar.
#[test]
fn a_bare_engine_is_refused() {
    let mut parser = Tabnas::new();
    let error =
        tabnas_c::c(&mut parser, &COptions::default()).expect_err("a bare engine has no val rule");
    assert!(
        error.0.contains("jsonic"),
        "the refusal should name what is missing, got {:?}",
        error.0
    );
}

/// A second install returns early rather than giving the instance a
/// second copy of every alternate.
#[test]
fn installing_twice_is_a_no_op() {
    let mut parser = tabnas_jsonic::make();
    tabnas_c::c(&mut parser, &COptions::default()).expect("the first install");
    let after_one = parser.rule_names().len();
    tabnas_c::c(&mut parser, &COptions::default()).expect("the second install");
    assert_eq!(after_one, parser.rule_names().len());

    let value = tabnas_c::parse_with(&parser, "int x;").expect("it still parses");
    assert_eq!(value.to_json()["kind"], "translation_unit");
}

/// With the extensions off, the rules that parse them are gone from the
/// instance, not merely unreachable.
#[test]
fn extension_rules_are_absent_in_plain_mode() {
    let plain = tabnas_c::make();
    let extended = tabnas_c::make_with(&COptions::new().with_extended(true));

    for rule in ["asm_statement", "define_directive", "attribute_spec_gcc"] {
        assert!(
            !plain.rule_names().iter().any(|name| name == rule),
            "plain mode still carries {rule}"
        );
        assert!(
            extended.rule_names().iter().any(|name| name == rule),
            "extended mode is missing {rule}"
        );
    }
    assert!(plain
        .rule_names()
        .iter()
        .any(|name| name == "translation_unit"));
}

/// Only `extended: true` turns the extensions on, as `resolveOptions`
/// in `ts/src/c.ts` does.
#[test]
fn options_read_the_same_bag_the_plugin_is_given() {
    let bag = |flag: Value| {
        let mut entries = indexmap::IndexMap::new();
        entries.insert("extended".to_string(), flag);
        Value::object(entries)
    };
    assert!(COptions::from_value(&bag(Value::Bool(true))).extended);
    assert!(!COptions::from_value(&bag(Value::Bool(false))).extended);
    assert!(!COptions::from_value(&bag(Value::String("yes".to_string()))).extended);
    assert!(!COptions::from_value(&Value::Undefined).extended);
    assert_eq!(COptions::new(), COptions::default());
}

/// The plugin installs through `use_plugin` with the same options.
#[test]
fn use_plugin_installs_with_options() {
    let mut parser = tabnas_jsonic::make();
    let mut entries = indexmap::IndexMap::new();
    entries.insert("extended".to_string(), Value::Bool(true));
    parser
        .use_plugin(tabnas_c::plugin(), Some(Value::object(entries)))
        .expect("the plugin installs");
    let value =
        tabnas_c::parse_with(&parser, "__attribute__((packed)) int x;").expect("extended parses");
    assert_eq!(value.to_json()["kind"], "translation_unit");
}

/// Without the typedef name, `uint32_t` lexes as an ordinary
/// identifier and the declaration has no declared name to speak of.
/// With it, `uint32_t` is a type and `x` is what is declared. This is
/// the whole reason `CMeta` exists.
#[test]
fn cmeta_binds_the_names_a_header_would_have() {
    let parser = tabnas_c::make();

    let bare = tabnas_c::parse_with(&parser, "uint32_t x;").expect("a bare parse");
    let bare_tokens = common::tokens_of(&bare.to_json());
    assert_eq!(bare_tokens[0].tname, "ID", "no header, no typedef name");

    let mut meta = CMeta::new();
    meta.symbols.bind_typedef("uint32_t");
    let seeded = tabnas_c::parse_with_meta(&parser, "uint32_t x;", &meta).expect("a seeded parse");
    let seeded_tokens = common::tokens_of(&seeded.to_json());
    assert_eq!(seeded_tokens[0].tname, "TYPEDEF_NAME");
    assert_eq!(seeded_tokens[1].src, "x");

    let mut found = String::new();
    let mut stack = vec![seeded.to_json()];
    while let Some(node) = stack.pop() {
        if let Some(name) = node.get("declaredName").and_then(|value| value.as_str()) {
            found = name.to_string();
            break;
        }
        if let Some(children) = node.get("children").and_then(|value| value.as_array()) {
            stack.extend(children.iter().cloned());
        }
    }
    assert_eq!(found, "x", "the seeded parse declares x, not the type");

    // The seeding does not leak into the next parse on this thread.
    let after = tabnas_c::parse_with(&parser, "uint32_t y;").expect("an unseeded parse");
    assert_eq!(common::tokens_of(&after.to_json())[0].tname, "ID");
}

/// A `CMeta` flattens to the meta value the parse reads, and the tables
/// it carries answer for themselves.
#[test]
fn cmeta_carries_the_two_tables() {
    let mut meta = CMeta::new();
    meta.symbols.bind_typedef("size_t");
    meta.symbols.bind_ordinary("counter");
    meta.symbols.bind_tag("vec", tabnas_c::TagKind::Struct);
    meta.macros.define(tabnas_c::MacroDef {
        name: "MAX".to_string(),
        ..tabnas_c::MacroDef::default()
    });

    assert!(meta.symbols.is_typedef("size_t"));
    assert!(!meta.symbols.is_typedef("counter"));
    assert!(meta.symbols.is_bound("counter"));
    assert!(meta.macros.has("MAX"));
    assert_eq!(meta.symbols.typedef_names(), vec!["size_t".to_string()]);

    let value = meta.to_value();
    let json = value.to_json();
    assert_eq!(json[tabnas_c::META_KEY]["typedefs"][0], "size_t");
    assert_eq!(json[tabnas_c::META_KEY]["macros"][0], "MAX");
}

/// An inner scope shadows an outer one, and the file scope is never
/// popped.
#[test]
fn the_symbol_table_shadows_outward() {
    let mut symbols = tabnas_c::SymbolTable::new();
    symbols.bind_typedef("T");
    assert!(symbols.is_typedef("T"));

    symbols.enter(tabnas_c::ScopeKind::Block);
    symbols.bind_ordinary("T");
    assert!(
        !symbols.is_typedef("T"),
        "the inner binding hides the outer"
    );
    symbols.exit();
    assert!(symbols.is_typedef("T"), "the outer binding is back");

    symbols.exit();
    symbols.exit();
    assert!(
        symbols.is_typedef("T"),
        "the file scope survives an unbalanced exit"
    );
}

/// The parser is `Send + Sync` and parses through `&self`, so one
/// instance serves every thread. The per-parse state is a thread local,
/// which is exactly the thing this has to prove is safe.
#[test]
fn one_parser_serves_many_threads() {
    let parser = std::sync::Arc::new(tabnas_c::make());
    let mut handles = Vec::new();
    for index in 0..4 {
        let parser = std::sync::Arc::clone(&parser);
        handles.push(std::thread::spawn(move || {
            for round in 0..20 {
                let source = format!("int v{index}_{round} = {round};");
                let value = tabnas_c::parse_with(&parser, &source).expect("a threaded parse");
                assert_eq!(value.to_json()["kind"], "translation_unit");
            }
        }));
    }
    for handle in handles {
        handle.join().expect("a thread finished");
    }
}

/// `parse` reuses one shared instance, and a second call is not
/// disturbed by the first.
#[test]
fn the_shared_parser_is_reusable() {
    let first = tabnas_c::parse("int a;").expect("a parse");
    let second = tabnas_c::parse("char b;").expect("another parse");
    assert_eq!(first.to_json()["kind"], "translation_unit");
    assert_eq!(second.to_json()["kind"], "translation_unit");
    // The first tree is still intact: `parse_with` realized it out of
    // the arena the second parse then reset.
    assert_eq!(
        first.to_json()["children"][0]["children"][0]["children"][0]["src"],
        "int"
    );
}

/// A caller driving the engine directly gets arena HANDLES back and has
/// to realize them. `parse_with` does it, and `realize` is exported for
/// the caller who does not.
#[test]
fn realize_turns_handles_into_values() {
    let parser = tabnas_c::make();
    let raw = parser.parse("int x;").expect("the engine parses");
    let realized = tabnas_c::realize(&raw);
    assert_eq!(realized.to_json()["kind"], "translation_unit");
}

/// Trivia rides on the tree as tokens, which is what makes it concrete.
#[test]
fn comments_survive_as_tokens() {
    let parser = tabnas_c::make();
    let value = tabnas_c::parse_with(&parser, "/* a */ int /* b */ x; // c\nint y;")
        .expect("a commented parse");
    let json: serde_json::Value = value.to_json();
    let comments: Vec<String> = common::tokens_of(&json)
        .into_iter()
        .filter(|token| token.tname.starts_with("TRIVIA_"))
        .map(|token| token.src)
        .collect();
    assert_eq!(comments, vec!["/* a */", "/* b */", "// c"]);
}

/// A macro definition keeps its body, and a use of the name is tagged.
#[test]
fn macros_are_kept_and_uses_are_tagged() {
    let parser = tabnas_c::make_with(&COptions::new().with_extended(true));
    let value = tabnas_c::parse_with(&parser, "#define TWICE(x) ((x) + (x))\nint y = TWICE(2);\n")
        .expect("a macro parse");
    let json: serde_json::Value = value.to_json();
    let sources: Vec<String> = common::tokens_of(&json)
        .into_iter()
        .map(|token| token.src)
        .collect();
    assert!(sources.contains(&"TWICE".to_string()));
    assert!(
        sources.iter().any(|src| src == "+"),
        "the macro body is kept verbatim: {sources:?}"
    );
}

/// The recorded divergence of DIVERGENCE.md section 3, pinned.
///
/// For a few initializer shapes the expression comes back from
/// `@tabnas/expr` as its own operator array rather than as a built
/// node. The canonical leaves the array on the item; this port drops
/// it, so the item has no children at all. Measured against a run of
/// `ts/src/c.ts` under Node and of the Go port through a driver: both
/// of those keep it.
///
/// This test fails when the divergence is REPAIRED as well as when it
/// regresses, which is the point: a divergence recorded as a passing
/// test of current behaviour outlives its own repair.
#[test]
fn unevaluated_initializer_items_are_dropped() {
    let parser = tabnas_c::make();
    let value =
        tabnas_c::parse_with(&parser, "static int g[2] = {-5,1};").expect("it parses either way");
    let json = value.to_json();

    let mut items: Vec<serde_json::Value> = Vec::new();
    let mut stack = vec![json];
    while let Some(node) = stack.pop() {
        if node.get("kind").and_then(|kind| kind.as_str()) == Some("initializer_item") {
            items.push(node.clone());
        }
        if let Some(children) = node.get("children").and_then(|value| value.as_array()) {
            stack.extend(children.iter().cloned());
        }
    }
    assert!(!items.is_empty(), "the input has initializer items");
    let first = items
        .iter()
        .min_by_key(|item| {
            serde_json::to_string(item)
                .map(|text| text.len())
                .unwrap_or(0)
        })
        .expect("at least one item");
    assert_eq!(
        first["children"].as_array().map(Vec::len),
        Some(0),
        "the `-5` item is expected to be EMPTY here and to carry a raw operator \
         array in the canonical. If it now carries something, the divergence is \
         closed: delete section 3 of DIVERGENCE.md, the seed list in \
         tests/csmith_test.rs, and this test."
    );
}

/// Spans count Unicode scalar values, the `char`s of the source, and
/// that is what the README says they do. On ASCII input every runtime
/// agrees. Past it the three count differently, measured 2026-09-21 on
/// the two inputs below: the canonical counts UTF-16 code units, so
/// `int` starts at 8 after `é` and at 9 after the astral U+1F600; Go
/// counts bytes, so 9 and 11; this port counts scalar values, so 8 and
/// 8. The shared fixtures are ASCII for exactly this reason.
#[test]
fn spans_count_unicode_scalar_values() {
    let parser = tabnas_c::make();
    for comment in ["/* é */", "/* \u{1F600} */"] {
        let source = format!("{comment} int x;");
        let value = tabnas_c::parse_with(&parser, &source).expect("non-ASCII trivia parses");
        let tokens = common::tokens_of(&value.to_json());
        assert_eq!(tokens[0].src, comment);
        assert_eq!((tokens[0].start, tokens[0].end), (0, 7), "{source:?}");
        assert_eq!(tokens[1].src, "int");
        assert_eq!((tokens[1].start, tokens[1].end), (8, 11), "{source:?}");
    }
}
