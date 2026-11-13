// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

//! A parse from a reader (`Tabnas::parse_reader`, admin ADR-30 and
//! ADR-33).
//!
//! `make()` and `make_with` build the parser whole and declare
//! `lex.window` on it, so that a reader is read a window at a time. C's
//! matchers read the source only through the window: a scan that reaches
//! the window's end fills it and the token is cut again (`src/matchers.rs`).
//! These tests hold it to that: every row of the shared fixtures, under its
//! `opts`, parses the same from a reader, in pieces of 1, 3 and 64 bytes,
//! under windows of a few characters and the engine's own, as from its
//! text; so do tokens of every kind longer than the window, and a directive
//! the window begins just before; every Csmith program does, in pieces of
//! 4 KiB, under the engine's window and one of 64 characters; and a long
//! document parses in time linear in its length. That the setting wins over
//! a base that declares no window is held in `src/lib.rs`
//! (`window_tests`), where the constructor's steps can be given such a
//! base.

#![allow(clippy::result_large_err)]

mod common;

use std::io::Read;
use std::time::Instant;

use tabnas::{Options, Tabnas, WindowSizes};
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

/// What a parse shows: its tree, or its error's code, position, row,
/// column and token text. An error's excerpt is left out: a parse from a
/// reader shows a long line only as far back as the window reaches
/// (tabnas/parser DIVERGENCE.md), the one difference allowed.
fn seen(result: Result<tabnas::Value, tabnas::TabnasError>) -> String {
    match result {
        Ok(value) => tabnas_c::realize(&value).to_json().to_string(),
        Err(error) => format!(
            "error {} at {} {}:{} {:?}",
            error.code, error.pos, error.row, error.col, error.src
        ),
    }
}

/// The pieces a reader hands its bytes over in, and the windows (margin
/// and block) it is read under besides the engine's own: a few
/// characters, so that every scan of a matcher meets the window's edge.
const PIECES: &[usize] = &[1, 3, 64];
const WINDOWS: &[(usize, usize)] = &[(1, 1), (3, 2), (64, 64)];

/// `text` parsed by `parser` whole, and from a reader in each of `sizes`
/// pieces, under the engine's window and each of `windows`: how many
/// reader parses were compared. A difference is pushed onto `failures`.
fn same_from_reader(
    parser: &Tabnas,
    at: &str,
    text: &str,
    failures: &mut Vec<String>,
    sizes: &[usize],
    windows: &[(usize, usize)],
) -> usize {
    let whole = seen(parser.parse(text));
    let mut compared = 0;
    for &size in sizes {
        let mut reads = vec![(
            String::new(),
            seen(parser.parse_reader(Pieces {
                text: text.as_bytes(),
                size,
            })),
        )];
        for &(margin, block) in windows {
            let sizes = WindowSizes {
                margin,
                block,
                chunk: size,
            };
            reads.push((
                format!(", margin {margin}, block {block}"),
                seen(parser.parse_reader_with_sizes(
                    Pieces {
                        text: text.as_bytes(),
                        size,
                    },
                    sizes,
                )),
            ));
        }
        for (how, read) in reads {
            compared += 1;
            if read != whole {
                let show: String = text.chars().take(80).collect();
                let clip = |s: &str| s.chars().take(400).collect::<String>();
                failures.push(format!(
                    "{at}: {show:?} from a reader in pieces of {size}{how}\n  whole:  {}\n  reader: {}",
                    clip(&whole),
                    clip(&read)
                ));
            }
        }
    }
    compared
}

/// A parser for a row's `opts`: the plugin's `extended` and the start rule.
fn parser_for(extended: bool, start: &str) -> Tabnas {
    let mut parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(extended));
    if !start.is_empty() {
        let start = start.to_string();
        parser
            .set_options(move |options: &mut Options| {
                options.rule.start = start.clone();
            })
            .expect("start rule");
    }
    parser
}

#[test]
fn make_declares_the_window() {
    assert!(tabnas_c::make().options.lex.window);
    assert!(
        tabnas_c::make_with(&tabnas_c::COptions::default())
            .options
            .lex
            .window
    );
}

#[test]
fn every_row_parses_the_same_from_a_reader() {
    let files = load_spec_dir(common::spec_dir(), &SpecOptions::default()).expect("fixtures");
    let mut parsers: std::collections::HashMap<(bool, String), Tabnas> = Default::default();
    let mut failures = Vec::new();
    let (mut rows, mut compared) = (0, 0);
    for file in &files {
        for row in &file.rows {
            let raw = row.named("opts");
            let opts: serde_json::Value = if raw.trim().is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_str(raw).expect("opts column is JSON")
            };
            let extended = opts
                .get("plugin")
                .and_then(|plugin| plugin.get("extended"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let start = opts
                .get("start")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            let parser = parsers
                .entry((extended, start.clone()))
                .or_insert_with(|| parser_for(extended, &start));
            let at = format!("{}:{}", row.file, row.line);
            compared += same_from_reader(
                parser,
                &at,
                &row.unesc_named("input"),
                &mut failures,
                PIECES,
                WINDOWS,
            );
            rows += 1;
            if rows % 50 == 0 {
                println!("window fixtures: {rows} rows, {compared} reader parses");
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(rows > 200, "{rows} fixture rows");
    assert_eq!(compared, PIECES.len() * (1 + WINDOWS.len()) * rows);
}

#[test]
fn tokens_longer_than_the_window_parse_the_same_from_a_reader() {
    // Each kind of token a matcher scans, long enough to straddle every
    // window here, and the directives a window may begin just before.
    let long = "x".repeat(300);
    let digits = "1".repeat(300);
    let docs: Vec<(String, bool)> = vec![
        (format!("int {long} = 1;"), false),
        (format!("int x = {digits};"), false),
        (format!("double d = {digits}.{digits}e+{digits};"), false),
        (format!("int x = 0x{}ull;", "f".repeat(300)), false),
        (format!("char *s = \"{long}\\n{long}\";"), false),
        (format!("char *s = u8\"{long}\";"), false),
        ("int c = L'aaaaa';".to_string(), false),
        (format!("/* {long} */ int x;"), false),
        (format!("// {long}\nint x;"), false),
        (
            format!("int x; {}\n{} int y;", " ".repeat(300), "\t".repeat(300)),
            false,
        ),
        (format!("#include <{long}.h>\nint x;"), false),
        (format!("#define A {long}\nint x = A;"), false),
        (
            format!("int x;\n{}#define B 2\nint y = B;", " ".repeat(300)),
            false,
        ),
        (
            "#define A 1\r#define B 2\rint x = A + B;".to_string(),
            false,
        ),
        (
            "#define A 1\r\n#define B 2\r\nint x = A + B;".to_string(),
            false,
        ),
        ("#if 1\rint x;\r#endif\r".to_string(), false),
        ("int x; #define C 3\n".to_string(), false),
        ("int x = 1; \\\n#define D 4\nint y = D;".to_string(), false),
        ("%:define E 5\nint x = E;".to_string(), false),
        ("int a = b <<= c >>= d;".to_string(), false),
        ("void f(int, ...);".to_string(), false),
        (format!("char *s = R\"delim({long})delim\";"), true),
        (format!("char *s = \"{long}"), false),
        (format!("/* {long}"), false),
    ];
    let mut failures = Vec::new();
    let mut compared = 0;
    for (index, (text, extended)) in docs.iter().enumerate() {
        let parser = parser_for(*extended, "");
        compared += same_from_reader(
            &parser,
            &format!("token #{index}"),
            text,
            &mut failures,
            PIECES,
            WINDOWS,
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(compared, PIECES.len() * (1 + WINDOWS.len()) * docs.len());
}

/// csmith.h's stdint names, declared as typedef names ahead of a program,
/// so that its text parses alike from a reader and whole: the Csmith
/// suite (`tests/csmith_test.rs`) binds them through metadata, which a
/// parse from a reader in this engine does not take.
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
fn every_csmith_program_parses_the_same_from_a_reader() {
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
    let mut header = String::new();
    for name in STDINT {
        header.push_str("typedef int ");
        header.push_str(name);
        header.push_str(";\n");
    }
    let parser = parser_for(true, "");
    let mut failures = Vec::new();
    let mut compared = 0;
    for (index, path) in seeds.iter().enumerate() {
        let text = header.clone() + &std::fs::read_to_string(path).expect("a seed is readable");
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        compared += same_from_reader(&parser, &name, &text, &mut failures, &[4096], &[(64, 64)]);
        println!(
            "window csmith: {} of {} programs ({}%)",
            index + 1,
            seeds.len(),
            (index + 1) * 100 / seeds.len()
        );
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(compared, 2 * seeds.len());
}

#[test]
fn a_long_document_parses_in_time_linear_in_its_length() {
    // Ten times the declarations take about ten times the time, from a
    // reader as from the text: well under the square of it.
    let doc = |n: usize| -> String {
        let mut text = String::new();
        for i in 0..n {
            text.push_str(&format!("/* c {i} */\nint x{i} = {i};\n"));
        }
        text
    };
    let parser = tabnas_c::make();
    let time = |text: &str| -> f64 {
        let start = Instant::now();
        let value = parser
            .parse_reader(Pieces {
                text: text.as_bytes(),
                size: 4096,
            })
            .expect("the document parses");
        let _ = tabnas_c::realize(&value);
        start.elapsed().as_secs_f64()
    };
    time(&doc(200));
    let small = time(&doc(1000)).min(time(&doc(1000)));
    let large = time(&doc(10000)).min(time(&doc(10000)));
    println!(
        "window time: 1000 declarations {:.0} ms, 10000 {:.0} ms ({:.1} times)",
        small * 1e3,
        large * 1e3,
        large / small
    );
    assert!(large < 25.0 * small, "{small} s, then {large} s");
}
