// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// Shared helpers for the fixture runners: where the spec directory is,
// how a row's `opts` column builds the parser, and how a parse result
// or a failure becomes the runner's value model.

// The engine's error carries a code, a position, a hint and a formatted
// report, so `Result<_, TabnasError>` is large by design. The crate root
// allows this for the same reason, and the allow has to be repeated here
// because a test binary is its own crate.
#![allow(clippy::result_large_err)]
// Each test binary compiles this module separately and uses a different
// part of it.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

use tabnas::{Options, Tabnas};
use tabnas_support::{find_spec_dir, Failure, Row, Value};

/// The shared `test/spec` directory. The search starts ABOVE `rs/`,
/// which is where the TypeScript runner starts it too.
pub fn spec_dir() -> PathBuf {
    find_spec_dir(Some(&PathBuf::from(env!("CARGO_MANIFEST_DIR")))).expect("test/spec directory")
}

/// The `opts` column is `{plugin?, start?}`: `plugin` is the C plugin's
/// own options, and `start` overrides the engine's start rule so an
/// expression can be parsed on its own.
fn row_options(row: &Row) -> (bool, String) {
    let raw = row.named("opts");
    if raw.trim().is_empty() {
        return (false, String::new());
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).expect("opts column is JSON");
    let extended = parsed
        .get("plugin")
        .and_then(|plugin| plugin.get("extended"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let start = parsed
        .get("start")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    (extended, start)
}

thread_local! {
    static PARSERS: RefCell<HashMap<(bool, String), Tabnas>> = RefCell::new(HashMap::new());
}

/// Parse one fixture row, building (and reusing) the parser its `opts`
/// column asks for.
pub fn parse_row(input: &str, row: &Row) -> Result<Value, Failure> {
    let key = row_options(row);
    let result = PARSERS.with(|parsers| {
        let mut parsers = parsers.borrow_mut();
        let parser = parsers.entry(key.clone()).or_insert_with(|| {
            let mut parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(key.0));
            if !key.1.is_empty() {
                let start = key.1.clone();
                parser
                    .set_options(move |options: &mut Options| {
                        options.rule.start = start.clone();
                    })
                    .expect("start rule");
            }
            parser
        });
        tabnas_c::parse_with(parser, input)
    });
    match result {
        Ok(value) => Ok(Value::from(value.to_json())),
        Err(error) => Err(Failure::new(error.code.clone())
            .with_message(error.to_string())
            .at(error.row, error.col)),
    }
}

/// One token of a parse, as the concrete tree carries it.
#[derive(Debug, Clone)]
pub struct Tok {
    pub tname: String,
    pub src: String,
    pub start: usize,
    pub end: usize,
}

/// Every token of a realized tree, in source order as the tree holds
/// them: children first, then the `trivia.leading` and `trivia.trailing`
/// lists, which is where a comment that no rule claimed ends up.
///
/// The walk is iterative. A C translation unit nests as deeply as its
/// expressions do, and a recursive walk in a test would abort the test
/// binary on the same input the parser survives.
pub fn tokens_of(value: &serde_json::Value) -> Vec<Tok> {
    let mut out: Vec<Tok> = Vec::new();
    let mut stack: Vec<&serde_json::Value> = vec![value];
    while let Some(node) = stack.pop() {
        match node {
            serde_json::Value::Array(items) => {
                for item in items.iter().rev() {
                    stack.push(item);
                }
            }
            serde_json::Value::Object(entries) => {
                if entries.get("kind").and_then(serde_json::Value::as_str) == Some("token") {
                    out.push(Tok {
                        tname: entries
                            .get("tname")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        src: entries
                            .get("src")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        start: number_at(entries.get("span"), "start"),
                        end: number_at(entries.get("span"), "end"),
                    });
                    continue;
                }
                // Source order: the leading trivia, then the children,
                // then the trailing trivia. Pushed in reverse because the
                // stack pops from the end.
                for key in ["trivia.trailing", "children", "trivia.leading"] {
                    let item = match key {
                        "children" => entries.get("children"),
                        "trivia.leading" => entries.get("trivia").and_then(|t| t.get("leading")),
                        _ => entries.get("trivia").and_then(|t| t.get("trailing")),
                    };
                    if let Some(item) = item {
                        stack.push(item);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn number_at(value: Option<&serde_json::Value>, key: &str) -> usize {
    value
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_f64)
        .map(|number| number.max(0.0) as usize)
        .unwrap_or_default()
}

/// The whitespace a C lexer skips between tokens. Spelled out rather
/// than taken from `char::is_whitespace`, which is Unicode-aware where
/// the canonical lexer is not.
pub fn is_c_space(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}')
}

/// A parse result in the divergence register's cell vocabulary:
/// `ERROR:<code>` for a failure, compact JSON for a tree.
pub fn outcome(parser: &Tabnas, source: &str) -> String {
    match tabnas_c::parse_with(parser, source) {
        Ok(value) => value.to_json().to_string(),
        Err(error) => format!("ERROR:{}", error.code),
    }
}
