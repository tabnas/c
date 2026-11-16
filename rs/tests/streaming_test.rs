// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

//! The parser a host streams a C document through, `make_streaming()`,
//! against the parser for a tree, `make()`. Its rules decide as `make()`'s,
//! by the same handlers, but its translation unit, conditional groups and
//! branches keep nothing that has closed, and its arena lets the nodes,
//! token lists and tokens of the declarations it has closed go. So its rule
//! passes, which C's transducer part (`alchemy/transduce.alc`) reads, must
//! be `make()`'s: over every row of the shared fixtures and every Csmith
//! program, from the text and from a reader, every pass alike (its rule,
//! state, depth, instance, alternate, counters and tokens, and whether it
//! carries the rule's node as a value), every token the lexer gives alike,
//! and every parse ending alike, an error at the same code, place and
//! token. `ts/test/streaming.test.ts` and `go/streaming_test.go` hold the
//! TypeScript and Go ports to the same. What a streaming parse holds is
//! held in `src/lib.rs` (`streaming_tests`), where the arena can be seen.

#![allow(clippy::result_large_err)]

mod common;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tabnas::{RuleState, Tabnas, Value};
use tabnas_support::{load_spec_dir, SpecOptions};

/// A reader that hands its bytes over at most `size` at a time.
struct Pieces<'a> {
    text: &'a [u8],
    size: usize,
}

impl Read for Pieces<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.size.min(buf.len()).min(self.text.len());
        buf[..n].copy_from_slice(&self.text[..n]);
        self.text = &self.text[n..];
        Ok(n)
    }
}

/// What a parse shows: how many passes, tokens the lexer gave and endings
/// it made, a hash of them all, and, where kept, a line for each. A parse
/// that only counts hashes each one's fields, and writes no line.
#[derive(Default)]
struct Seen {
    count: usize,
    hasher: DefaultHasher,
    lines: Option<Vec<String>>,
}

impl Seen {
    fn add(&mut self, fields: impl Hash, line: impl FnOnce() -> String) {
        self.count += 1;
        fields.hash(&mut self.hasher);
        if let Some(lines) = self.lines.as_mut() {
            lines.push(line());
        }
    }

    fn hash(&self) -> u64 {
        self.hasher.finish()
    }
}

/// A parser and what its parses show.
struct Logged {
    parser: Tabnas,
    seen: Arc<Mutex<Seen>>,
}

/// Whether a pass carries the rule's node as a value, as transduce's
/// parser-event source asks it: a close pass does, where the node is
/// defined and not a container.
fn carried(close: bool, node: &Value) -> bool {
    close
        && !matches!(
            node,
            Value::Undefined
                | Value::Object(_)
                | Value::Array(_)
                | Value::MapRef(_)
                | Value::ListRef(_)
        )
}

fn logged(mut parser: Tabnas) -> Logged {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let lexed = seen.clone();
    parser.subscribe_lex(move |token, _rule, _context| {
        let fields = (
            "lex",
            token.name.as_str(),
            token.src.as_str(),
            token.site.si,
        );
        lexed.lock().expect("one parse at a time").add(fields, || {
            format!("lex {} {:?} {}", fields.1, fields.2, fields.3)
        });
    });
    let passed = seen.clone();
    parser.subscribe_rule_done(move |rule, _context, done| {
        let close = done.state == RuleState::Close;
        let tokens: Vec<(&str, &str, usize)> = if close { rule.c.iter() } else { rule.o.iter() }
            .map(|token| (token.name.as_str(), token.src.as_str(), token.site.si))
            .collect();
        let alt = done
            .alt
            .as_ref()
            .map(|alt| (alt.p.as_str(), alt.r.as_str(), alt.b, alt.g.as_slice()));
        let mut counters: Vec<(&str, i32)> =
            rule.n.iter().map(|(name, n)| (name.as_str(), *n)).collect();
        counters.sort();
        let carries = carried(close, &rule.node.borrow());
        let fields = (
            rule.name.as_str(),
            close,
            rule.d,
            rule.i,
            alt,
            (done.forced, done.probe),
            &counters,
            carries,
            &tokens,
        );
        passed
            .lock()
            .expect("one parse at a time")
            .add(&fields, || {
                let alt = match &done.alt {
                    None => "-".to_string(),
                    Some(alt) => format!("{}/{}/{}/{}", alt.p, alt.r, alt.b, alt.g.join(",")),
                };
                let counters: Vec<String> = counters
                    .iter()
                    .map(|(name, n)| format!("{name}={n}"))
                    .collect();
                let tokens: Vec<String> = tokens
                    .iter()
                    .map(|(name, src, si)| format!("{name} {src:?} {si}"))
                    .collect();
                format!(
                    "{} | {:?} | {} | {} | {} | {} | {} | {} | {} | {}",
                    rule.name.as_str(),
                    done.state,
                    rule.d,
                    rule.i,
                    alt,
                    done.forced,
                    done.probe,
                    counters.join(","),
                    carries,
                    tokens.join(", ")
                )
            });
    });
    Logged { parser, seen }
}

impl Logged {
    fn parse(&self, text: &str, reader: bool, keep: bool) -> Seen {
        *self.seen.lock().expect("one parse at a time") = Seen {
            lines: keep.then(Vec::new),
            ..Seen::default()
        };
        let result = if reader {
            self.parser.parse_reader(Pieces {
                text: text.as_bytes(),
                size: 4096,
            })
        } else {
            self.parser.parse(text)
        };
        let mut seen = self.seen.lock().expect("one parse at a time");
        match result {
            Ok(_) => seen.add("ok", || "ok".to_string()),
            Err(error) => {
                let line = format!(
                    "err {} at {} {}:{} {:?}",
                    error.code, error.pos, error.row, error.col, error.src
                );
                seen.add(&line, || line.clone());
            }
        }
        std::mem::take(&mut *seen)
    }
}

/// A parser of each kind, for each plugin option set, built once.
struct Pair {
    tree: Logged,
    stream: Logged,
}

impl Pair {
    fn new(extended: bool) -> Self {
        let options = tabnas_c::COptions::new().with_extended(extended);
        Pair {
            tree: logged(tabnas_c::make_with(&options)),
            stream: logged(tabnas_c::make_streaming_with(&options)),
        }
    }

    /// The first difference between `make()`'s parse of `text` and the
    /// streaming parser's, or nothing: the two are compared by their count
    /// and hash, and parsed again, keeping their lines, only where those
    /// differ.
    fn difference(&self, at: &str, text: &str, reader: bool) -> Option<String> {
        let want = self.tree.parse(text, reader, false);
        let got = self.stream.parse(text, reader, false);
        if want.count == got.count && want.hash() == got.hash() {
            return None;
        }
        let a = self
            .tree
            .parse(text, reader, true)
            .lines
            .unwrap_or_default();
        let b = self
            .stream
            .parse(text, reader, true)
            .lines
            .unwrap_or_default();
        let i = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
        let none = "(none)".to_string();
        Some(format!(
            "{at}{}: line {i} of {}\n  make():           {}\n  make_streaming(): {}",
            if reader { ", from a reader" } else { "" },
            a.len(),
            a.get(i).unwrap_or(&none),
            b.get(i).unwrap_or(&none)
        ))
    }
}

#[test]
fn make_streaming_builds_no_tree() {
    let text = "typedef int T;\n#ifdef X\nT a;\n#else\nint b;\n#endif\nint f(void) { return 0; }\n";
    let stream = tabnas_c::make_streaming();
    assert!(stream.options.lex.window);
    let value = tabnas_c::realize(&stream.parse(text).expect("it parses")).to_json();
    assert_eq!(value["kind"], "translation_unit");
    assert_eq!(value["children"], serde_json::json!([]));
    let tree = tabnas_c::parse(text).expect("it parses").to_json();
    assert_eq!(tree["children"].as_array().map(Vec::len), Some(3));
}

#[test]
fn its_passes_are_make_s_over_every_fixture() {
    let files = load_spec_dir(common::spec_dir(), &SpecOptions::default()).expect("fixtures");
    let plain = Pair::new(false);
    let extended = Pair::new(true);
    let mut failures = Vec::new();
    let mut compared = 0;
    for file in &files {
        for row in &file.rows {
            let raw = row.named("opts");
            let opts: serde_json::Value = if raw.trim().is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_str(raw).expect("opts column is JSON")
            };
            // A row that reads an expression or a declaration on its own,
            // which the streaming parser is not for.
            if opts.get("start").is_some() {
                continue;
            }
            let pair = match opts
                .get("plugin")
                .and_then(|plugin| plugin.get("extended"))
                .and_then(serde_json::Value::as_bool)
            {
                Some(true) => &extended,
                _ => &plain,
            };
            let at = format!("{}:{}", row.file, row.line);
            let input = row.unesc_named("input");
            for reader in [false, true] {
                if let Some(difference) = pair.difference(&at, &input, reader) {
                    failures.push(difference);
                }
                compared += 1;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(compared > 400, "{compared} parses compared");
}

/// The names csmith.h declares as types, which a Csmith program uses
/// before declaring them: dmog reads a program after a header that
/// declares each as a typedef name.
const STDINT: &[&str] = &[
    "int8_t",
    "int16_t",
    "int32_t",
    "int64_t",
    "uint8_t",
    "uint16_t",
    "uint32_t",
    "uint64_t",
    "size_t",
    "ssize_t",
    "ptrdiff_t",
    "intptr_t",
    "uintptr_t",
    "wchar_t",
    "wint_t",
    "time_t",
    "clock_t",
    "off_t",
    "FILE",
    "va_list",
];

#[test]
fn its_passes_are_make_s_over_every_csmith_program() {
    let corpus = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ts/test/csmith-corpus");
    let mut seeds: Vec<_> = std::fs::read_dir(&corpus)
        .expect("the Csmith corpus is readable")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("seed-") && name.ends_with(".c"))
        })
        .collect();
    seeds.sort();
    assert!(seeds.len() >= 100, "{} Csmith programs", seeds.len());
    let header: String = STDINT
        .iter()
        .map(|name| format!("typedef int {name};\n"))
        .collect();
    let pair = Pair::new(false);
    let mut failures = Vec::new();
    let mut reported = Instant::now();
    for (index, path) in seeds.iter().enumerate() {
        let text = header.clone() + &std::fs::read_to_string(path).expect("a seed is readable");
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        for reader in [false, true] {
            if let Some(difference) = pair.difference(&name, &text, reader) {
                failures.push(difference);
            }
        }
        if index + 1 == seeds.len() || reported.elapsed().as_secs() >= 20 {
            reported = Instant::now();
            println!(
                "streaming csmith: {} of {} programs ({}%)",
                index + 1,
                seeds.len(),
                (index + 1) * 100 / seeds.len()
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
