#!/usr/bin/env bash
# Rust port gate. Kept in one script so local and hosted validation cannot
# quietly drift apart: ci/workflows/rust.yml runs this file, and so can
# you. `make test-rs` is the fast inner loop; this is the full gate.
#
# The engine, the jsonic base (and the JSON core it needs), the expr
# operator plugin and the fixture runner are PATH DEPENDENCIES on sibling
# checkouts (rs/Cargo.toml: `tabnas = { path = "../../parser/rs" }`,
# `tabnas-jsonic = { path = "../../jsonic/rs" }`, which itself takes
# `tabnas-json = { path = "../../json/rs" }`,
# `tabnas-expr = { path = "../../expr/rs" }`, and as a dev-dependency
# `tabnas-support = { path = "../../support/rs" }`). None is published, so
# there is no registry version to fall back on. Clone
# https://github.com/tabnas/parser, https://github.com/tabnas/json,
# https://github.com/tabnas/jsonic, https://github.com/tabnas/expr and
# https://github.com/tabnas/support next to this repo before running.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)

for SIBLING in parser json jsonic expr support; do
  if [[ ! -f "$ROOT/../$SIBLING/rs/Cargo.toml" ]]; then
    echo "no $SIBLING checkout at $ROOT/../$SIBLING/rs" >&2
    echo "clone https://github.com/tabnas/$SIBLING as a sibling of $(basename "$ROOT")" >&2
    exit 1
  fi
done

cd "$ROOT/rs"

# Run through the MSRV toolchain when one is available. The workflow
# installs it explicitly, but a contributor running this script gets
# whatever `cargo` is on their PATH -- and a newer toolchain accepts code
# and formatting that the MSRV rejects, so the "local and hosted cannot
# drift" claim this script exists for would hold everywhere except the
# compiler version. Loud rather than silent when the toolchain is absent,
# because a quiet fallback is the drift.
MSRV=$(awk -F'"' '/^rust-version = /{print $2; exit}' Cargo.toml)
CARGO=(cargo)
if [[ -n "$MSRV" ]]; then
  if command -v rustup >/dev/null 2>&1 && rustup toolchain list | grep -q "^$MSRV"; then
    CARGO=(cargo "+$MSRV")
  else
    echo "warning: MSRV $MSRV is not installed; running on $(rustc --version 2>/dev/null)" >&2
    echo "         install it with: rustup toolchain install $MSRV" >&2
    echo "         a newer toolchain can accept what $MSRV rejects" >&2
  fi
fi

# Assert the lock's entry for THIS crate still matches the manifest,
# BEFORE anything runs cargo. Without `--locked` (see below) a cargo
# command silently rewrites Cargo.lock in the runner, so a version bump
# that updates rs/Cargo.toml and forgets rs/Cargo.lock passes every
# check and ships a stale lock. This has to come first -- after a cargo
# command the lock has already been fixed up and the check can never fail.
#
# Only this crate's entry is asserted. The sibling crates' entries
# legitimately move whenever their checkouts do, which is the same reason
# blanket `--locked` is wrong here.
CRATE=$(awk -F'"' '/^name = /{print $2; exit}' Cargo.toml)
WANT=$(awk -F'"' '/^version = /{print $2; exit}' Cargo.toml)
HAVE=$(awk -v c="$CRATE" -F'"' '
  $0 == "name = \"" c "\"" { f = 1; next }
  f && /^version = / { print $2; exit }
' Cargo.lock)

if [[ "$WANT" != "$HAVE" ]]; then
  echo "Cargo.lock records $CRATE ${HAVE:-<missing>}, but Cargo.toml says $WANT" >&2
  echo "run a cargo command and commit the updated rs/Cargo.lock" >&2
  exit 1
fi

# That version check is the common case stated clearly; it is NOT the whole
# check. A pull request that adds, removes or re-pins a DEPENDENCY leaves
# the crate's own version alone, so it sails past the comparison above while
# leaving the committed lock stale -- cargo then regenerates it in the
# runner and everything goes green.
#
# So the whole resolution is compared, before and after cargo runs, with one
# exemption: the recorded version of each sibling path crate (the engine,
# the jsonic base, the JSON core, the expr plugin and the fixture runner). Those entries legitimately move
# whenever the sibling checkouts do, and exempting exactly them is what
# makes a full comparison usable here when blanket `--locked` is not.
lock_without_sibling_versions() {
  awk '
    /^\[\[package\]\]$/                { sib = 0 }
    /^name = "tabnas"$/                { sib = 1 }
    /^name = "tabnas-json"$/           { sib = 1 }
    /^name = "tabnas-jsonic"$/         { sib = 1 }
    /^name = "tabnas-expr"$/           { sib = 1 }
    /^name = "tabnas-support"$/        { sib = 1 }
    sib && /^version = /               { print "version = \"<sibling>\""; next }
                                       { print }
  ' "$1"
}

LOCK_BEFORE=$(mktemp)
cp Cargo.lock "$LOCK_BEFORE"
# On any exit, a red run included, put the lock back if a cargo command
# rewrote it, then drop the snapshot: the tree is left as it was found.
trap 'if [ -f "$LOCK_BEFORE" ] && ! cmp -s "$LOCK_BEFORE" Cargo.lock; then cp "$LOCK_BEFORE" Cargo.lock; fi; rm -f "$LOCK_BEFORE"' EXIT

# NOT `--locked`, deliberately, and this is the one place the plugin gate
# differs from the engine's own (parser ci/rust/run.sh does pass it).
#
# Cargo.lock records the siblings by version, and each is resolved from a
# sibling checkout of MAIN. So the day one of them bumps its crate
# version, `--locked` here fails with "cannot update the lock file" on
# every pull request in this repo, including ones that touch no Rust at
# all -- a red build caused by another repository's release.
#
# NOT `--all` on fmt either. cargo defines it as "all packages, and also
# their local path-based dependencies", so `--all` reaches into the
# sibling checkouts: an unformatted file over there fails this gate even
# when every file here is clean.
"${CARGO[@]}" fmt --check
"${CARGO[@]}" build --all-targets
"${CARGO[@]}" test --all-targets
# `--all-targets` does NOT include doctests -- cargo documents the selector
# as "Test all targets (does not include doctests)" -- so a broken example
# in the crate docs passes a gate that only runs it.
"${CARGO[@]}" test --doc
"${CARGO[@]}" clippy --all-targets --all-features -- -D warnings

# Now that cargo has had every chance to rewrite it, the lock must still
# describe the same resolution it did when committed.
if ! diff -q <(lock_without_sibling_versions "$LOCK_BEFORE") \
             <(lock_without_sibling_versions Cargo.lock) >/dev/null; then
  echo "rs/Cargo.lock does not match rs/Cargo.toml -- cargo rewrote it:" >&2
  diff <(lock_without_sibling_versions "$LOCK_BEFORE") \
       <(lock_without_sibling_versions Cargo.lock) >&2 || true
  echo >&2
  echo "run a cargo command and commit the updated rs/Cargo.lock" >&2
  cp "$LOCK_BEFORE" Cargo.lock   # leave the tree as it was found
  exit 1
fi
# The exempted sibling versions may still have moved, and cargo wrote them
# into the lock. Put the lock back so a green gate leaves the tree exactly
# as it found it, whatever the siblings did: updating the committed lock is
# a deliberate cargo run and commit, never a side effect of running the gate.
if ! cmp -s "$LOCK_BEFORE" Cargo.lock; then
  cp "$LOCK_BEFORE" Cargo.lock
fi
