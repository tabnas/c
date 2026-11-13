// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// What every tree holds to (docs/rules.md, "The tree"): `children` holds
// each subtree once, no node holds itself, a node's members are scalars
// (the named members that repeat a child are the API's, `member`), every
// node has a span, and every comment the source holds is in the tree but
// one after the last token. Run over every input of the shared fixtures;
// `csmith_test.rs` holds every Csmith program's tree to the same, on the
// parse it grades. Port of ts/test/tree.test.ts and go/tree_test.go.

mod common;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tabnas::Value;
use tabnas_support::{load_spec, SpecOptions};

const TRIVIA: [&str; 3] = [
    "TRIVIA_LINE_COMMENT",
    "TRIVIA_BLOCK_COMMENT",
    "TRIVIA_LINE_CONT",
];

/// A parser for one row's options, with a lexer subscriber that counts
/// the comments it reads: `[lexed, run, tail]`, where `run` is the current
/// run of comments and `tail` the run before the end.
struct Counting {
    parser: tabnas::Tabnas,
    counts: Arc<[AtomicUsize; 3]>,
}

fn counting(extended: bool, start: &str) -> Counting {
    let mut parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(extended));
    if !start.is_empty() {
        let start = start.to_string();
        parser
            .set_options(move |options| options.rule.start = start.clone())
            .expect("start rule");
    }
    let counts = Arc::new([
        AtomicUsize::new(0),
        AtomicUsize::new(0),
        AtomicUsize::new(0),
    ]);
    let seen = Arc::clone(&counts);
    parser.subscribe_lex(move |token, _rule, _context| match token.name.as_str() {
        name if TRIVIA.contains(&name) => {
            seen[0].fetch_add(1, Ordering::Relaxed);
            seen[1].fetch_add(1, Ordering::Relaxed);
        }
        "#SP" | "#LN" | "#CM" => {}
        "#ZZ" => seen[2].store(seen[1].load(Ordering::Relaxed), Ordering::Relaxed),
        _ => seen[1].store(0, Ordering::Relaxed),
    });
    Counting { parser, counts }
}

#[test]
fn tree_of_every_fixture() {
    let mut parsers: HashMap<(bool, String), Counting> = HashMap::new();
    let mut rows = 0usize;
    let mut failures: Vec<String> = Vec::new();
    let mut files: Vec<_> = std::fs::read_dir(common::spec_dir())
        .expect("test/spec is readable")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "tsv"))
        .collect();
    files.sort();
    for path in &files {
        let spec =
            load_spec(path, &SpecOptions::default()).unwrap_or_else(|error| panic!("{error}"));
        for row in &spec.rows {
            if row.named("expected").starts_with("ERROR") {
                continue;
            }
            let opts: serde_json::Value = match row.named("opts").trim() {
                "" => serde_json::Value::Null,
                raw => serde_json::from_str(raw).expect("opts column is JSON"),
            };
            let extended = opts["plugin"]["extended"].as_bool().unwrap_or(false);
            let start = opts["start"].as_str().unwrap_or_default().to_string();
            let source = row.unesc_named("input");
            let counting = parsers
                .entry((extended, start.clone()))
                .or_insert_with(|| counting(extended, &start));
            for count in counting.counts.iter() {
                count.store(0, Ordering::Relaxed);
            }
            let tree = tabnas_c::parse_with(&counting.parser, &source)
                .unwrap_or_else(|error| panic!("{}: {}", row.location(), error.code));
            let problems = common::tree_problems(&tree);
            if !problems.is_empty() {
                failures.push(format!("{}: {problems:?}", row.location()));
            }
            let kept = common::tokens_of(&tree.to_json())
                .into_iter()
                .filter(|token| TRIVIA.contains(&token.tname.as_str()))
                .count();
            let [lexed, _, tail] = &*counting.counts;
            let lost = lexed.load(Ordering::Relaxed) - tail.load(Ordering::Relaxed) - kept;
            if lost != 0 {
                failures.push(format!("{}: {lost} comments lost", row.location()));
            }
            rows += 1;
        }
    }
    assert!(rows >= 100, "{rows} rows");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A node that holds itself, or a subtree held twice, is found: the check
/// is not a walk that would pass anything.
#[test]
fn a_subtree_held_twice_is_found() {
    let leaf = |kind: &str| {
        let mut entries = indexmap::IndexMap::new();
        entries.insert("kind".to_string(), Value::String(kind.to_string()));
        let mut span = indexmap::IndexMap::new();
        span.insert("start".to_string(), Value::Number(0.0));
        entries.insert("span".to_string(), Value::object(span));
        entries.insert("children".to_string(), Value::array(Vec::new()));
        Value::object(entries)
    };
    let shared = leaf("identifier_expression");
    let mut root = indexmap::IndexMap::new();
    root.insert(
        "kind".to_string(),
        Value::String("translation_unit".to_string()),
    );
    let mut span = indexmap::IndexMap::new();
    span.insert("start".to_string(), Value::Number(0.0));
    root.insert("span".to_string(), Value::object(span));
    root.insert(
        "children".to_string(),
        Value::array(vec![shared.clone(), shared]),
    );
    let problems = common::tree_problems(&Value::object(root));
    assert!(
        problems
            .iter()
            .any(|problem| problem.contains("held twice")),
        "{problems:?}"
    );
}
