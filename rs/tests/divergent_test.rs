// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// The divergence register, executed.
//
// `test/divergent.tsv` records every input where this port answers
// differently from the canonical TypeScript. DIVERGENCE.md explains the
// shape of each disagreement; this file is what RUNS.
//
// WHY THIS IS NOT A FIXTURE. A fixture fails when behaviour REGRESSES.
// This fails BOTH ways: when a port is repaired to agree with the
// others, the row still claims they differ, so the suite goes red and
// names the row to delete. A divergence recorded as a passing test of
// current behaviour survives its own repair, and the record then
// describes something that no longer happens, with nothing red.
//
// The register also sits OUTSIDE `test/spec`, because all three parity
// runners discover fixtures by listing that directory and would run it
// as one.
//
// The runner is local rather than `tabnas_support::Register` for one
// reason: two of the three runtimes here do not RETURN on the recorded
// input, they exhaust their stack and the process dies. No error code
// can stand for that, so the file defines the literal `ABORT` and this
// runner knows it means "no outcome any suite can produce".

mod common;

use tabnas_support::{load_spec, SpecOptions};

/// This runtime's column, and the others.
const RUNTIME: &str = "rust";
const OTHERS: [&str; 2] = ["ts", "go"];

/// The cell that means the runtime did not return at all.
const ABORT: &str = "ABORT";

/// Do two cells mean the same thing? `ABORT` means the same as nothing
/// else, itself included: it is not an outcome, so it cannot match one.
fn same_outcome(mine: &str, theirs: &str) -> bool {
    if theirs == ABORT || mine == ABORT {
        return false;
    }
    mine == theirs
}

#[test]
fn divergence_register() {
    let path = common::spec_dir()
        .parent()
        .expect("test/spec has a parent")
        .join("divergent.tsv");
    let spec = load_spec(&path, &SpecOptions::default()).unwrap_or_else(|error| panic!("{error}"));

    // An empty register would be legitimate for a port with no
    // divergences, but an empty FILE is not: it cannot be told apart
    // from a loader that read nothing. This port has divergences, so the
    // file has rows.
    assert!(
        !spec.rows.is_empty(),
        "{} has no rows, and this port has divergences to record",
        path.display()
    );

    let parser = tabnas_c::make();
    let mut failures: Vec<String> = Vec::new();
    for row in &spec.rows {
        let at = row.location();
        for column in [RUNTIME, "ts", "go", "why", "input"] {
            assert!(
                row.index_of(column).is_some(),
                "{at}: no column named {column:?}"
            );
        }
        let input = row.unesc_named("input");
        let mine = row.named(RUNTIME).to_string();
        assert_ne!(
            mine, ABORT,
            "{at}: this port's own column cannot be {ABORT}: a crash is what the \
             register exists to record the ABSENCE of here"
        );
        assert!(
            !row.named("why").trim().is_empty(),
            "{at}: a row with no `why` records nothing anyone can act on"
        );

        // 1. Does the row record a divergence at all? Columns that all
        //    say the same thing assert nothing and would pass forever.
        let others: Vec<(&str, &str)> =
            OTHERS.iter().map(|name| (*name, row.named(name))).collect();
        if others.iter().all(|(_, theirs)| same_outcome(&mine, theirs)) {
            failures.push(format!(
                "{at}: every runtime column means {mine:?}, so this row records no \
                 divergence and can never fail meaningfully. Delete it, or correct the \
                 cells to what the runtimes actually do."
            ));
            continue;
        }

        // 2. Does this port still do what the row says?
        let got = common::outcome(&parser, &input);
        if got == mine {
            continue;
        }
        let converged: Vec<&str> = others
            .iter()
            .filter(|(_, theirs)| same_outcome(&got, theirs))
            .map(|(name, _)| *name)
            .collect();
        if converged.len() == others.len() {
            failures.push(format!(
                "{at}: this divergence is CLOSED. {RUNTIME} now produces what the other \
                 columns record, not its own ({mine}).\n  A repaired divergence fails as \
                 loudly as a regressed one, so the row cannot outlive it. DELETE the row \
                 and the section it cites: {}",
                row.named("why").trim()
            ));
        } else if !converged.is_empty() {
            failures.push(format!(
                "{at}: this divergence is PARTIALLY closed. {RUNTIME} now agrees with {} \
                 but not with every other column. Do NOT delete the row; UPDATE the \
                 {RUNTIME} column to {got}.",
                converged.join(", ")
            ));
        } else {
            failures.push(format!(
                "{at}: {RUNTIME} changed, and not into another runtime's answer either, \
                 so this is a regression rather than a closed divergence.\n  got:      \
                 {got}\n  recorded: {mine}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The cell vocabulary this register depends on.
#[test]
fn abort_matches_nothing() {
    assert!(!same_outcome("ERROR:cancel", ABORT));
    assert!(!same_outcome(ABORT, ABORT));
    assert!(same_outcome("ERROR:cancel", "ERROR:cancel"));
    assert!(!same_outcome("ERROR:cancel", "ERROR:unexpected"));
}
