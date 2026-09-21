// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// Cross-runtime conformance, driven by the shared `test/spec/*.tsv`
// fixtures at the repository root (see ../../test/AGENTS.md).
//
// The fixture loader, the escape codec, the `ERROR:<code>` contract and
// the row loop all come from tabnas-support, whose TypeScript half
// `ts/test/parity.test.ts` and Go half `go/parity_test.go` use to run
// the SAME files, so the three implementations cannot drift without one
// of them going red.

mod common;

use tabnas_support::Runner;

#[test]
fn spec_fixtures() {
    Runner::new_with_row(common::parse_row).dir(common::spec_dir());
}
