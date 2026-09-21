// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// The baked-in VERSION must equal the package's declared version, and
// the crate manifest's must too.
//
// This is the CI check for version drift. It exists because the constant
// HAS drifted in practice: jsonic-cli shipped 0.4.1 and 0.4.2 while its
// constant sat at 0.4.0, and the TypeScript `Version` export of
// `@tabnas/json` read 1.0.0 for several releases because nothing ever
// rewrote it. Both were invisible until someone read the file. A release
// that bumps `ts/package.json` and forgets one of the other two now
// fails here instead of shipping a lie.

use std::fs;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("rs/ has a parent")
        .to_path_buf()
}

/// The `version` of `ts/package.json`, the single source of truth.
fn package_version() -> String {
    // Deliberately fatal, never skipped: a version check that silently
    // does not run is the failure mode this test exists to prevent.
    let raw = fs::read_to_string(repo_root().join("ts/package.json"))
        .expect("ts/package.json is readable, or VERSION cannot be checked");
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).expect("ts/package.json is readable JSON");
    parsed["version"]
        .as_str()
        .expect("ts/package.json has a version field")
        .to_string()
}

#[test]
fn version_matches_package_json() {
    assert_eq!(
        tabnas_c::VERSION,
        package_version(),
        "VERSION drift: the crate says {} and ts/package.json says {}. \
         Both are rewritten at release; if you bumped one by hand, bump \
         the other.",
        tabnas_c::VERSION,
        package_version()
    );
}

#[test]
fn cargo_manifest_matches_version() {
    let manifest = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
        .expect("rs/Cargo.toml is readable");
    let declared = manifest
        .lines()
        .find_map(|line| line.strip_prefix("version = "))
        .map(|rest| rest.trim().trim_matches('"').to_string())
        .expect("rs/Cargo.toml declares a version");
    assert_eq!(
        declared,
        tabnas_c::VERSION,
        "rs/Cargo.toml says {declared} and the crate's VERSION says {}",
        tabnas_c::VERSION
    );
}

#[test]
fn go_constant_matches_version() {
    // The Go port's constant is checked here too, because the three ports
    // are released together and nothing else compares them.
    let source = fs::read_to_string(repo_root().join("go/c.go")).expect("go/c.go is readable");
    let declared = source
        .lines()
        .find_map(|line| line.trim().strip_prefix("const VERSION = "))
        .map(|rest| rest.trim().trim_matches('"').to_string())
        .expect("go/c.go declares const VERSION");
    assert_eq!(declared, tabnas_c::VERSION, "go/c.go VERSION drift");
}
