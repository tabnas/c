// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// The CSmith corpus grader, the widest conformance measurement this
// repository has.
//
// `ts/test/csmith-corpus` holds 100 CSmith-generated translation units,
// about 12 MB of GCC-flavoured C, and `ts/test/csmith-fixtures` holds
// the gzipped JSON the canonical parser produced for each. The corpus
// and the golden files are single-sourced there and read from here, as
// the Go port's `go/csmith_test.go` reads them, rather than copied.
//
// The gate is hard: every seed's serialized tree must equal its
// fixture. A seed that parses but structures differently is a
// regression, not a near miss.

mod common;

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value as JsonValue};
use tabnas::Value;

/// The names `csmith.h` provides. The parser does not expand
/// `#include`, so without these `static int32_t g_2 = 6L;` would parse
/// `int32_t` as the DECLARED name. Mirrors `STDINT_TYPEDEFS` in
/// `ts/test/csmith-common.ts`.
const STDINT_TYPEDEFS: &[&str] = &[
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

/// The scalar metadata a fixture keeps, copied verbatim from
/// `SCALAR_KEYS` in `ts/test/csmith-fixture.ts`.
const SCALAR_KEYS: &[&str] = &[
    // common metadata
    "declKind",
    "declaredName",
    "callee",
    "isMacro",
    "op",
    // statements
    "jumpKind",
    "labelKind",
    "labelName",
    "qualifiers",
    // literals and identifiers
    "literalKind",
    "value",
    "name",
    // members and designators
    "memberName",
    // calls and generics
    "associationKind",
    // tags
    "tagName",
    // attributes
    "attributeForm",
    "attributeName",
    "attributePrefix",
    // preprocessor
    "directive",
    "macroName",
    "macroKind",
    "macroParams",
    "macroVariadic",
    "includeForm",
    "headerKind",
    "headerName",
    "branchKind",
];

/// Comments and line continuations are dropped from a fixture: CSmith
/// puts a kilobyte of block comment in every file and none of it is
/// structural. Mirrors `TRIVIA_TOKENS` in `ts/test/csmith-fixture.ts`.
fn is_trivia(tname: &str) -> bool {
    matches!(
        tname,
        "TRIVIA_LINE_COMMENT" | "TRIVIA_BLOCK_COMMENT" | "TRIVIA_LINE_CONT"
    )
}

/// Serialize a tree the way `toFixture` in `ts/test/csmith-fixture.ts`
/// does, so the comparison is against the same shape that wrote the
/// golden files.
///
/// This walks the ENGINE value rather than its JSON rendering, and that
/// is not an optimisation. The tree is a DAG: an expression node sits
/// in its parent's `children` and again under the parent's `left`,
/// `right`, `cond`, `then` or `else`. `Value::to_json` expands every
/// path, as `JSON.stringify` does in the canonical, so rendering a
/// CSmith translation unit whose expressions nest dozens deep needs
/// more memory than the machine has. `toFixture` never follows those
/// fields, which is exactly why the canonical can serialize the corpus
/// at all, and following it here means the corpus can be graded.
fn to_fixture(node: &Value) -> Option<JsonValue> {
    let entries = match object_of(node) {
        Some(entries) => entries,
        None => {
            return match node {
                // A raw expression operator array left on a node, which
                // the canonical serializes as `{ k: undefined }`, an
                // empty object.
                Value::Array(_) | Value::ListRef(_) => Some(JsonValue::Object(Map::new())),
                // A primitive, which the canonical drops.
                _ => None,
            };
        }
    };

    if string_at(&entries, "kind").as_deref() == Some("token") {
        let tname = string_at(&entries, "tname").unwrap_or_default();
        if is_trivia(&tname) {
            return None;
        }
        let mut token = Map::new();
        token.insert("k".to_string(), JsonValue::String("tok".to_string()));
        token.insert("t".to_string(), JsonValue::String(tname));
        token.insert(
            "s".to_string(),
            JsonValue::String(string_at(&entries, "src").unwrap_or_default()),
        );
        return Some(JsonValue::Object(token));
    }

    let mut out = Map::new();
    // The canonical writes `{ k: node.kind }` and lets `JSON.stringify`
    // drop an undefined one.
    if let Some(kind) = string_at(&entries, "kind") {
        out.insert("k".to_string(), JsonValue::String(kind));
    }
    for key in SCALAR_KEYS {
        let Some(value) = entries.get(*key) else {
            continue;
        };
        match value {
            Value::Undefined | Value::Null => continue,
            // `typeof v === 'object' && !Array.isArray(v)`.
            Value::Object(_) | Value::MapRef(_) => continue,
            Value::Array(_) | Value::ListRef(_) => {
                let items = list_of(value);
                // `Array.isArray(v) && v.some(x => typeof x === 'object')`.
                if items.iter().any(|item| {
                    matches!(
                        item,
                        Value::Object(_) | Value::MapRef(_) | Value::Array(_) | Value::ListRef(_)
                    ) || matches!(item, Value::Null)
                }) {
                    continue;
                }
                out.insert(
                    (*key).to_string(),
                    JsonValue::Array(items.iter().map(json_scalar).collect()),
                );
            }
            scalar => {
                out.insert((*key).to_string(), json_scalar(scalar));
            }
        }
    }
    if let Some(children) = entries.get("children") {
        let children = list_of(children);
        if !children.is_empty() {
            let kept: Vec<JsonValue> = children.iter().filter_map(to_fixture).collect();
            if !kept.is_empty() {
                out.insert("children".to_string(), JsonValue::Array(kept));
            }
        }
    }
    Some(JsonValue::Object(out))
}

/// One scalar, rendered the way `JSON.stringify` renders it.
///
/// An engine number is an `f64`, and `Value::to_json` hands it back as
/// one, so `1` would render as `1.0` where JavaScript writes `1`. The
/// comparison here is against text JavaScript wrote, so a whole number
/// renders whole.
fn json_scalar(value: &Value) -> JsonValue {
    match value {
        Value::Number(number) if number.fract() == 0.0 && number.abs() < 9e15 => {
            JsonValue::from(*number as i64)
        }
        other => other.to_json(),
    }
}

/// The entries of an engine object, whichever of the two shapes it is.
fn object_of(value: &Value) -> Option<indexmap::IndexMap<String, Value>> {
    match value {
        Value::Object(entries) => Some((**entries).clone()),
        Value::MapRef(map) => Some(map.value.clone()),
        _ => None,
    }
}

/// The items of an engine array, whichever of the two shapes it is.
fn list_of(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.to_vec(),
        Value::ListRef(list) => list.value.to_vec(),
        _ => Vec::new(),
    }
}

fn string_at(entries: &indexmap::IndexMap<String, Value>, key: &str) -> Option<String> {
    match entries.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// The seeds whose only difference from the golden fixture is the
/// recorded divergence of DIVERGENCE.md section 3. MEASURED, not
/// guessed: this is the list the assertion below printed when it was
/// run with the list empty, and it is exactly the set of golden
/// fixtures that carry an `initializer_item` with a `{}` child, which
/// is how `toFixture` writes the raw operator array the canonical
/// leaves on such an item. Pinning the seeds by name means a repair
/// goes red here and says which names to delete, and a regression
/// that widens the set goes red the same way.
const KNOWN_DIVERGENT: &[&str] = &[
    "seed-002", "seed-004", "seed-006", "seed-008", "seed-010", "seed-022", "seed-026", "seed-027",
    "seed-030", "seed-035", "seed-039", "seed-044", "seed-046", "seed-047", "seed-048", "seed-049",
    "seed-051", "seed-055", "seed-056", "seed-057", "seed-060", "seed-063", "seed-069", "seed-073",
    "seed-074", "seed-077", "seed-079", "seed-082", "seed-085", "seed-086", "seed-087", "seed-090",
    "seed-091", "seed-093", "seed-094", "seed-095", "seed-098",
];

/// Remove the empty-object child the canonical writes for an
/// initializer item whose expression it left un-evaluated.
fn strip_unevaluated_items(text: &str) -> String {
    text.replace(
        r#"{"k":"initializer_item","children":[{}]}"#,
        r#"{"k":"initializer_item"}"#,
    )
}

fn corpus_dir() -> PathBuf {
    repo_root().join("ts/test/csmith-corpus")
}

fn fixtures_dir() -> PathBuf {
    repo_root().join("ts/test/csmith-fixtures")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rs/ has a parent")
        .to_path_buf()
}

/// `.gitattributes` pins the corpus to LF, but a checkout that slipped
/// past it would shift every span, so the line endings are forced here
/// as both other runtimes force them.
fn normalise_eol(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn gunzip(path: &Path) -> std::io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(file).read_to_end(&mut out)?;
    Ok(out)
}

/// Where two fixture texts first differ, with enough either side to
/// read, so a failure says where rather than printing a megabyte.
fn first_text_diff(got: &str, want: &str) -> String {
    let at = got
        .bytes()
        .zip(want.bytes())
        .position(|(left, right)| left != right)
        .unwrap_or_else(|| got.len().min(want.len()));
    let from = at.saturating_sub(60);
    let window = |text: &str| {
        let mut start = from.min(text.len());
        while start > 0 && !text.is_char_boundary(start) {
            start -= 1;
        }
        let mut end = (at + 60).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        text[start..end].to_string()
    };
    format!(
        "at byte {at} of {} (fixture has {}):\n  got:  ...{}...\n  want: ...{}...",
        got.len(),
        want.len(),
        window(got),
        window(want)
    )
}

#[test]
fn csmith_corpus_matches_the_golden_fixtures() {
    let corpus = corpus_dir();
    let mut seeds: Vec<PathBuf> = match std::fs::read_dir(&corpus) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.extension().is_some_and(|ext| ext == "c")
                    && path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("seed-"))
            })
            .collect(),
        // Deliberately fatal rather than skipped. The corpus is
        // committed; a runner that cannot see it is a broken checkout,
        // and a green run that graded nothing says less than a red one.
        Err(error) => panic!("the CSmith corpus is not readable at {corpus:?}: {error}"),
    };
    seeds.sort();
    assert!(
        !seeds.is_empty(),
        "the CSmith corpus at {corpus:?} is empty, so nothing was graded"
    );

    let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));
    let mut meta = tabnas_c::CMeta::new();
    for name in STDINT_TYPEDEFS {
        meta.symbols.bind_typedef(name);
    }

    let mut passed = 0usize;
    let mut divergent: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for path in &seeds {
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let source = normalise_eol(&std::fs::read_to_string(path).expect("a seed is readable"));
        let value = match tabnas_c::parse_with_meta(&parser, &source, &meta) {
            Ok(value) => value,
            Err(error) => {
                failures.push(format!("{name}: parse failed with {}", error.code));
                continue;
            }
        };
        if object_of(&value)
            .and_then(|entries| string_at(&entries, "kind"))
            .as_deref()
            != Some("translation_unit")
        {
            failures.push(format!("{name}: the root is not a translation_unit"));
            continue;
        }
        // As `csmith.test.ts` asserts before it reads the fixture: a
        // seed that parses but leaves an external declaration
        // unstructured has already failed, whatever the fixture says.
        let unknown = object_of(&value)
            .and_then(|entries| entries.get("children").map(list_of))
            .unwrap_or_default()
            .iter()
            .filter(|child| {
                object_of(child)
                    .and_then(|entries| string_at(&entries, "declKind"))
                    .as_deref()
                    == Some("unknown")
            })
            .count();
        if unknown > 0 {
            failures.push(format!(
                "{name}: {unknown} external declaration(s) came back with declKind unknown"
            ));
            continue;
        }
        let fixture = fixtures_dir().join(format!("{name}.json.gz"));
        let raw = match gunzip(&fixture) {
            Ok(raw) => raw,
            Err(error) => {
                failures.push(format!("{name}: fixture unreadable: {error}"));
                continue;
            }
        };
        // Compared as TEXT, which is what `ts/test/csmith.test.ts` does
        // and what wrote these files: `fixtureJson` is
        // `JSON.stringify(toFixture(cst)) + "\n"`. Comparing the text
        // also sidesteps reading a fixture back, which nests deeper
        // than serde_json's recursion limit allows by default.
        let want = String::from_utf8_lossy(&raw).to_string();
        let got =
            serde_json::to_string(&to_fixture(&value).expect("a translation unit serializes"))
                .expect("the fixture shape serializes")
                + "\n";
        if got == want {
            passed += 1;
            continue;
        }
        // The one difference this port is known to produce, recorded in
        // DIVERGENCE.md section 3: an initializer item whose expression
        // the canonical leaves as a raw `@tabnas/expr` operator array,
        // which `toFixture` writes as an empty object. This port leaves
        // the item empty instead. A seed whose ONLY difference is that
        // is counted as known-divergent; anything else is a failure.
        if strip_unevaluated_items(&want) == got {
            divergent.push(name);
            continue;
        }
        failures.push(format!("{name}: differs {}", first_text_diff(&got, &want)));
    }

    assert!(
        failures.is_empty(),
        "{passed} of {} CSmith fixtures match and {} differ only by the recorded \
         divergence; these differ some OTHER way:\n{}",
        seeds.len(),
        divergent.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(
        passed + divergent.len(),
        seeds.len(),
        "not every seed was graded"
    );
    // The recorded divergence is pinned to the seeds it actually
    // affects, so repairing it goes red here and says which rows to
    // delete, exactly as the divergence register does.
    assert_eq!(
        divergent, KNOWN_DIVERGENT,
        "the set of seeds that differ only by the recorded divergence has changed. \
         If the repair landed, delete this list, section 3 of DIVERGENCE.md and \
         `unevaluated_initializer_items_are_dropped` in tests/c_test.rs; if it \
         merely moved, re-measure and record the new set."
    );
}
