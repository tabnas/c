// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// The path-dispatch catalogue, `ts/test/spec/path-dispatch.tsv`.
//
// Each row names a C source, the route its external declaration took in
// 0.5 (`grammar`, or `legacy` and `legacy-unknown` for the chomp and its
// structurer) and the `declKind` that comes out. From 0.6 every
// declaration is built by rules (docs/rules.md), and the route survives
// as strict or armed; the tree no longer names it. A declaration that
// comes out as a different `declKind` has been read another way, which a
// fixture that pins a tree may not hold, so the rows hold the `declKind`,
// as `ts/test/c.test.ts` does.
//
// The catalogue lives under `ts/test` rather than `test/spec` because
// the parity runners would otherwise run it as a fixture. It is read from
// there rather than copied: the columns are positional (no header), a
// `#`-leading line with no tab is a comment, and a `#`-leading line WITH
// a tab is a row whose source is a preprocessor directive.

mod common;

use tabnas_support::{load_spec, SpecOptions};

#[test]
fn every_catalogued_shape_is_the_recorded_declaration() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rs/ has a parent")
        .join("ts/test/spec/path-dispatch.tsv");
    let spec = load_spec(
        &path,
        &SpecOptions {
            header: false,
            comment: true,
            min_cols: 3,
        },
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert!(
        !spec.rows.is_empty(),
        "{} has no rows, so nothing was checked",
        path.display()
    );

    // The catalogue holds extension shapes (preprocessor directives,
    // GCC attributes), so the parser carries the extensions, as the
    // canonical runner's does.
    let parser = tabnas_c::make_with(&tabnas_c::COptions::new().with_extended(true));

    let mut checked = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for row in &spec.rows {
        let at = row.location();
        let source = row.col(0);
        let want_kind = row.col(2);
        // Column 4 is an index into the translation unit's external
        // declarations when it parses as one, and free-form notes
        // otherwise; column 5, when present, is always notes.
        let index: usize = row
            .cols
            .get(3)
            .and_then(|column| column.parse().ok())
            .unwrap_or(0);

        let tree = match tabnas_c::parse_with(&parser, source) {
            Ok(value) => value.to_json(),
            Err(error) => {
                failures.push(format!("{at}: {source:?} failed to parse: {}", error.code));
                continue;
            }
        };
        let declarations: Vec<&serde_json::Value> = tree["children"]
            .as_array()
            .map(|children| {
                children
                    .iter()
                    .filter(|child| child["kind"] == "external_declaration")
                    .collect()
            })
            .unwrap_or_default();
        let Some(declaration) = declarations.get(index) else {
            failures.push(format!(
                "{at}: {source:?} produced {} external declaration(s); index {index} is out of range",
                declarations.len()
            ));
            continue;
        };
        checked += 1;

        let got_kind = declaration["declKind"].as_str().unwrap_or("<no declKind>");
        if got_kind != want_kind {
            failures.push(format!(
                "{at}: {source:?} came out as {got_kind}; the catalogue records {want_kind}"
            ));
        }
    }

    assert!(checked > 0, "no row produced a declaration to check");
    assert!(
        failures.is_empty(),
        "{} of {checked} catalogued shapes disagree with the canonical:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
