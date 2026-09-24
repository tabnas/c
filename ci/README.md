# ci/

Staging area for GitHub Actions workflow changes.

This directory exists because session credentials cannot write
`.github/workflows/*` — see admin `DECISIONS.md` ADR-8. To change CI:

1. Put the intended workflow file in `workflows/`.
2. A maintainer promotes it with the admin `rollout/apply-ci-folders.sh`
   script.

## Pending

Nothing.

## Promoted

Both of these were staged here and now run from `.github/workflows/`:

- **`docs.yml`** — the prose gate: Vale over the reader-facing pages at
  the levels set in `.vale.ini`, on the file list
  `ts/scripts/gated-docs.cjs` produces. See `docs/STYLE-GUIDE.md`.
  `make prose` runs the same check locally.

- **`rust.yml`** — the Rust port gate: format, build, tests,
  doctests, clippy with `-D warnings`, and a lockfile check, all of them
  inside `ci/rust/run.sh` so a contributor's local run and the hosted one
  cannot say different things.

  It clones five sibling repositories, because none of the crates it
  depends on is published and `rs/Cargo.toml` takes each by path. It
  needs no secrets. The `paths:` lists name everything the gate reads,
  the grammar and its embedder included; a change there that skipped the
  gate would be a grammar change nothing measured.
