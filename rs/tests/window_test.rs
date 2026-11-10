// Copyright (c) 2026 Richard Rodger and other contributors, MIT License

//! The parser `make()` builds declares `lex.window` false, its own
//! setting, so that `Tabnas::parse_reader` reads a reader whole (admin
//! ADR-30): the grammar's matchers are not yet verified at the window's
//! edge. That the setting wins over a base that declares the window is
//! held in `src/lib.rs` (`window_tests`), where the constructor's steps can
//! be given such a base.

#[test]
fn make_declares_no_window() {
    assert!(!tabnas_c::make().options.lex.window);
    assert!(
        !tabnas_c::make_with(&tabnas_c::COptions::default())
            .options
            .lex
            .window
    );
}
