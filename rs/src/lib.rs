/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// The engine's error carries a code, position, hint and a formatted
// report, so it is large by design and `Result<_, TabnasError>` trips
// clippy's `result_large_err`. The engine allows the lint at its own
// crate root for the same reason; boxing here would make `parse` return
// a different shape from `Tabnas::parse` and from the other two ports.
#![allow(clippy::result_large_err)]

//! The C grammar plugin for the `tabnas` parsing engine.
//!
//! Parses C23 source, plus the common GCC, Clang and MSVC extensions,
//! into a CONCRETE syntax tree: every token, comment, macro definition,
//! macro use and compiler extension is kept verbatim, so the tree can
//! be walked back to the source it came from.
//!
//! ```
//! fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let value = tabnas_c::parse("int x = 1;")?;
//!     assert_eq!(value.to_json()["kind"], "translation_unit");
//!     Ok(())
//! }
//! ```
//!
//! The plugin layers on the relaxed-JSON grammar of
//! [`tabnas_jsonic`] (the DSL the grammar document is authored in) and
//! on [`tabnas_expr`] for Pratt-style expression parsing, exactly as
//! the canonical TypeScript plugin layers on `@tabnas/jsonic` and
//! `@tabnas/expr`.
//!
//! TypeScript is canonical: `ts/src/c.ts` defines behaviour, option
//! names and defaults, and `ts/c-grammar.jsonic` defines the rule
//! chain, embedded here as the same text. The shared fixtures in
//! `test/spec/*.tsv` are the parity contract across TypeScript, Go and
//! Rust.

use std::sync::OnceLock;

use indexmap::IndexMap;

use tabnas::{GrammarSpec, LexMatcher, Options, Plugin, PluginError, Tabnas, TabnasError, Value};

mod conditional_groups;
mod cst;
mod expr_grammar;
mod legacy_expr;
mod refs;
mod refs_ext;
mod refs_forms;
mod refs_newpath;
mod refs_stmt;
mod rt;
mod sets;
mod state;
mod structure;
mod tokens;
mod trivia;

pub mod matchers;

pub use cst::{realize, REALIZE_DEPTH_CAP};

/// The symbol and macro tables, re-exported so a caller can seed a
/// parse with names a header would have introduced. The canonical
/// plugin exports the same pair from `ts/src/symbols.ts`, and the Go
/// port exports them as `SymbolTable` and `MacroTable`.
pub use state::{Binding, MacroDef, MacroTable, Scope, ScopeKind, SymbolTable, TagKind};

/// This crate's version. It MUST equal `ts/package.json` "version": the
/// release orchestrator rewrites both, and `tests/version_test.rs`
/// fails the build if they drift. Mirrors `VERSION` in `ts/src/c.ts`
/// and `const VERSION` in `go/c.go`.
pub const VERSION: &str = "0.5.8";

/// The plugin's name, as `use_plugin` records it.
pub const PLUGIN_NAME: &str = "C";

/// The README's Rust examples run as doctests, so a stale one fails the
/// gate rather than misleading the reader. Its `toml` and `bash` fences
/// are skipped; rustdoc runs only the `rust` ones.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
mod readme_examples {}

/// The error a failed parse produces, re-exported so callers need not
/// depend on the engine crate directly.
pub use tabnas::TabnasError as CError;

/// The declarative grammar, the single source of truth for the rule
/// shapes. `ts/embed-grammar.js` copies `ts/c-grammar.jsonic` here, as
/// it copies it to `go/c-grammar.jsonic` for `//go:embed`.
pub const GRAMMAR_TEXT: &str = include_str!("../c-grammar.jsonic");

/// Plugin options. `extended` turns on the GCC, Clang and MSVC
/// extension constructs and the legacy fallback that covers the
/// long-tail declarator shapes; plain C23, the whole preprocessor
/// included, is the default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct COptions {
    pub extended: bool,
}

impl COptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_extended(mut self, extended: bool) -> Self {
        self.extended = extended;
        self
    }

    /// Read the options out of the JSON bag `use_plugin` merges over
    /// the declared defaults. Only `extended === true` turns the
    /// extensions on, as `resolveOptions` in `ts/src/c.ts` does.
    pub fn from_value(value: &Value) -> Self {
        let extended = match value {
            Value::Object(entries) => entries.get("extended") == Some(&Value::Bool(true)),
            Value::MapRef(map) => map.value.get("extended") == Some(&Value::Bool(true)),
            _ => false,
        };
        Self { extended }
    }
}

/// The key `meta` carries the pre-bound names under, as the canonical
/// plugin reads `ctx.meta.cmeta` and the Go port reads
/// `ctx.Meta["cmeta"]`.
pub const META_KEY: &str = "cmeta";

/// Names a parse should already know.
///
/// The parser does not follow `#include`, so a translation unit that
/// uses `uint32_t` has no way to learn that it is a typedef name, and
/// `uint32_t x;` would parse `uint32_t` as the DECLARED name. The
/// canonical plugin solves this by letting a caller build a `cmeta` and
/// bind the names into it before the parse; this is the same thing.
///
/// ```
/// fn main() -> Result<(), Box<dyn std::error::Error>> {
///     let parser = tabnas_c::make();
///     let mut meta = tabnas_c::CMeta::new();
///     meta.symbols.bind_typedef("uint32_t");
///     let value = tabnas_c::parse_with_meta(&parser, "uint32_t x;", &meta)?;
///     assert_eq!(value.to_json()["kind"], "translation_unit");
///     Ok(())
/// }
/// ```
#[derive(Debug, Clone, Default)]
pub struct CMeta {
    /// The typedef names, and anything else bound, that the parse
    /// starts with.
    pub symbols: SymbolTable,
    /// The macro names the parse starts with.
    pub macros: MacroTable,
}

impl CMeta {
    /// An empty table pair, as `makeCMeta()` returns in the canonical
    /// plugin and `MakeCMeta()` in the Go port.
    pub fn new() -> Self {
        Self::default()
    }

    /// The engine `meta` value this builds.
    ///
    /// A `Value` cannot hold a native handle, so the tables travel as
    /// the NAMES they hold rather than as themselves; the parse rebuilds
    /// its own tables from them at file scope. A binding made in an
    /// inner scope of a hand-built table therefore arrives at file
    /// scope, which is where a header's names belong anyway.
    pub fn to_value(&self) -> Value {
        let mut inner: IndexMap<String, Value> = IndexMap::new();
        inner.insert(
            "typedefs".to_string(),
            Value::array(
                self.symbols
                    .typedef_names()
                    .into_iter()
                    .map(Value::String)
                    .collect::<Vec<_>>(),
            ),
        );
        inner.insert(
            "macros".to_string(),
            Value::array(
                self.macros
                    .names()
                    .into_iter()
                    .map(Value::String)
                    .collect::<Vec<_>>(),
            ),
        );
        let mut outer: IndexMap<String, Value> = IndexMap::new();
        outer.insert(META_KEY.to_string(), Value::object(inner));
        Value::object(outer)
    }
}

/// Bind the names a caller put on `meta` into the fresh parse state.
fn seed_from_meta(meta: &Value) {
    let Some(cmeta) = entry(meta, META_KEY) else {
        return;
    };
    let typedefs = names_at(&cmeta, "typedefs");
    let macros = names_at(&cmeta, "macros");
    if typedefs.is_empty() && macros.is_empty() {
        return;
    }
    state::with_state(|inner| {
        for name in typedefs {
            inner.symbols.bind_typedef(&name);
        }
        for name in macros {
            inner.macros.define(MacroDef {
                name,
                ..MacroDef::default()
            });
        }
    });
}

/// One entry of an engine object, whichever of the two object shapes it
/// is.
fn entry(value: &Value, key: &str) -> Option<Value> {
    match value {
        Value::Object(entries) => entries.get(key).cloned(),
        Value::MapRef(map) => map.value.get(key).cloned(),
        _ => None,
    }
}

/// The strings in the array at `key`, ignoring anything that is not one.
fn names_at(value: &Value, key: &str) -> Vec<String> {
    let items = match entry(value, key) {
        Some(Value::Array(items)) => items.to_vec(),
        Some(Value::ListRef(list)) => list.value.to_vec(),
        _ => return Vec::new(),
    };
    items
        .into_iter()
        .filter_map(|item| match item {
            Value::String(name) => Some(name),
            _ => None,
        })
        .collect()
}

/// Extension-only grammar rule names. With `extended: false` the
/// plugin strips these from the parsed grammar document before
/// installing it. This is the physical companion to the
/// `c: '@extended-on'` dispatch gating: the gates already make the
/// rules unreachable, and deleting them outright makes plain-C mode
/// self-evidently free of extension grammar.
const EXTENSION_RULES: &[&str] = &[
    // GCC inline assembly
    "asm_statement",
    "asm_template",
    "asm_section",
    "asm_operand",
    "asm_clobber",
    "asm_label_ref",
    // Preprocessor (in-body opaque and top-level structured)
    "preprocessor_line",
    "preprocessor_directive",
    "define_directive",
    "macro_parameter_list",
    "macro_body",
    "undef_directive",
    "include_directive",
    "header_form",
    "conditional_directive",
    "simple_directive",
    // Compiler-specific attribute spec syntax
    "attribute_spec_gcc",
    "attribute_spec_msvc",
];

/// Install the C grammar on a parser that already carries the jsonic
/// base grammar.
///
/// Returns early when the instance already has the `translation_unit`
/// rule, so a second install does not give it a second copy of every
/// alternate, and refuses a bare engine outright: this plugin hangs its
/// expression alternates on the base grammar's `val` rule, and on an
/// instance without one there is nothing to hang them on.
pub fn c(parser: &mut Tabnas, options: &COptions) -> Result<(), PluginError> {
    let rules = parser.rule_names();
    if rules.iter().any(|name| name == "translation_unit") {
        return Ok(());
    }
    if !rules.iter().any(|name| name == "val") {
        return Err(PluginError(
            "c: the jsonic base grammar is required (no `val` rule on this instance); \
             install tabnas_jsonic first"
                .to_string(),
        ));
    }

    let tins = register_tokens(parser);
    apply_options(parser, &tins)?;
    let stubbed = refs::register(parser, options);
    let _ = stubbed;
    install_grammar(parser, options)?;
    expr_grammar::install(parser)?;
    Ok(())
}

/// Register every token name the parser uses, so each has a stable
/// identity before the grammar document resolves names to it.
fn register_tokens(parser: &mut Tabnas) -> matchers::Tins {
    let mut tins = matchers::Tins::default();
    // Punctuators and keywords carry their source as a fixed token.
    // The built-in fixed matcher is switched off below, so registering
    // them only mints the identity: an identifier such as `int_value`
    // is never cut at the `int` keyword.
    for (name, source) in tokens::PUNCTUATORS {
        tins.insert(name, parser.token_with_source(*name, *source));
    }
    for keyword in tokens::C23_KEYWORDS
        .iter()
        .chain(tokens::EXT_KEYWORDS.iter())
    {
        let name = tokens::keyword_token_name_unchecked(keyword);
        tins.insert(&name, parser.token_with_source(name.clone(), *keyword));
    }
    for name in tokens::SPECIAL_TOKENS {
        tins.insert(name, parser.token(name.to_string()));
    }
    for name in ["#SP", "#LN", "#CM", "#ZZ"] {
        tins.insert(name, parser.token(name.to_string()));
    }
    tins
}

/// The per-instance engine options, mirroring the `jsonic.options(...)`
/// calls in `ts/src/c.ts`.
fn apply_options(parser: &mut Tabnas, tins: &matchers::Tins) -> Result<(), PluginError> {
    let ignore = [
        "#SP",
        "#LN",
        "#CM",
        "TRIVIA_LINE_COMMENT",
        "TRIVIA_BLOCK_COMMENT",
        "TRIVIA_LINE_CONT",
    ];
    let token_sets: Vec<(&str, Vec<String>)> = vec![
        (
            "IGNORE",
            ignore.iter().map(|name| (*name).to_string()).collect(),
        ),
        ("ANY_C_TOKEN", tokens::any_c_token_names()),
        (
            "SIMPLE_TYPE_HEAD",
            sets::SIMPLE_TYPE_HEAD
                .iter()
                .map(|n| n.to_string())
                .collect(),
        ),
        (
            "STORAGE_PREFIX",
            sets::STORAGE_PREFIX.iter().map(|n| n.to_string()).collect(),
        ),
        (
            "C_ATOM",
            sets::C_ATOM.iter().map(|n| n.to_string()).collect(),
        ),
        (
            "C_PAREN_OPEN",
            sets::C_PAREN_OPEN.iter().map(|n| n.to_string()).collect(),
        ),
        ("KW_TOKEN", tokens::keyword_token_names()),
        (
            "SIZEOF_KW",
            sets::SIZEOF_KW.iter().map(|n| n.to_string()).collect(),
        ),
    ];

    let matcher_tins = tins.clone();
    parser
        .set_options(move |options: &mut Options| {
            options.fixed.lex = false;
            options.space.lex = false;
            options.line.lex = false;
            options.text.lex = false;
            options.number.lex = false;
            options.string.lex = false;
            options.comment.lex = false;
            options.value.lex = false;
            options.match_lex = true;

            for (name, members) in &token_sets {
                let members: Vec<i32> = members
                    .iter()
                    .map(|member| {
                        options
                            .token(member)
                            .unwrap_or_else(|| options.register_token(member.clone()))
                    })
                    .collect();
                options.token_set.insert((*name).to_string(), members);
            }

            for (name, order) in matchers::MATCHER_ORDER {
                options.lex.matchers.insert(
                    (*name).to_string(),
                    LexMatcher {
                        name: (*name).to_string(),
                        order: *order,
                        matcher: None,
                        imperative: Some(matchers::make(name, matcher_tins.clone())),
                        factory: None,
                    },
                );
            }

            // The C punctuator identities must come FIRST in the fixed
            // table. `Tabnas::fixed(source)` answers with the first
            // entry carrying that source, and the base grammar already
            // registers `,`, `:`, `[`, `]`, `{` and `}` under its own
            // names; the expr plugin resolves each operator's source
            // through that lookup, so without this it would bind the
            // comma operator to the base grammar's `#CA` and wait for a
            // token this lexer never emits. The canonical engine's
            // source-to-identity map is written last-wins and the C
            // tokens are registered last, which is the same answer.
            let mut ordered: IndexMap<String, tabnas::FixedToken> = IndexMap::new();
            for (name, token) in options.fixed.tokens.iter() {
                if name.starts_with("#PUNC_") || name.starts_with("#KW_") {
                    ordered.insert(name.clone(), token.clone());
                }
            }
            for (name, token) in options.fixed.tokens.iter() {
                if !ordered.contains_key(name) {
                    ordered.insert(name.clone(), token.clone());
                }
            }
            options.fixed.tokens = ordered;

            options.rule.start = "translation_unit".to_string();
            options.rule.finish = false;
        })
        .map_err(|error| PluginError(format!("c: options: {}", error.0)))?;

    // Every parse starts from a clean symbol table, macro table, lexer
    // mode and tree arena. The canonical plugin installs a `cmeta`
    // object on `ctx.meta` from the same hook.
    parser
        .set_options(|options: &mut Options| {
            options
                .parse
                .prepare
                .push(tabnas::ParsePrepare::Context(std::sync::Arc::new(
                    |context: &mut tabnas::Context| {
                        state::reset();
                        seed_from_meta(&context.meta);
                    },
                )));
        })
        .map_err(|error| PluginError(format!("c: prepare: {}", error.0)))?;

    // The sub-lex hook. See `crate::trivia`.
    parser.subscribe_lex(|token, _rule, _context| trivia::on_lex_token(token));

    Ok(())
}

/// Parse the embedded grammar text into a serialized document, as the
/// canonical `parseGrammar` does with a vanilla jsonic instance, and
/// install it.
fn install_grammar(parser: &mut Tabnas, options: &COptions) -> Result<(), PluginError> {
    let parsed = tabnas_jsonic::parse(GRAMMAR_TEXT)
        .map_err(|error| PluginError(format!("c-grammar.jsonic: {error}")))?;
    let mut document = parsed.to_json();
    if !document.is_object() || document.get("rule").is_none() {
        return Err(PluginError(
            "c-grammar.jsonic: expected a JSON object with a `rule` table".to_string(),
        ));
    }
    integral(&mut document);
    if !options.extended {
        if let Some(rules) = document
            .get_mut("rule")
            .and_then(serde_json::Value::as_object_mut)
        {
            for name in EXTENSION_RULES {
                rules.remove(*name);
            }
        }
    }
    let spec = GrammarSpec::from_value(document).map_err(|error| PluginError(error.0))?;
    parser
        .grammar(&spec)
        .map_err(|error| PluginError(error.0))?;
    Ok(())
}

/// jsonic yields every number as a float; the grammar loader reads `b`
/// and `n` with `as_u64`, so a whole number has to arrive as an
/// integer.
fn integral(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(float) = number.as_f64() {
                if float >= 0.0 && float.fract() == 0.0 && float <= u64::MAX as f64 {
                    *value = serde_json::Value::from(float as u64);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(integral),
        serde_json::Value::Object(entries) => entries.values_mut().for_each(integral),
        _ => {}
    }
}

/// The plugin, for `use_plugin`.
pub fn plugin() -> Plugin {
    Plugin::new(PLUGIN_NAME, |parser: &mut Tabnas, options: &Value| {
        c(parser, &COptions::from_value(options))
    })
    .with_defaults(Value::object(indexmap::IndexMap::new()))
}

/// A parser carrying the jsonic base grammar and the C grammar.
pub fn make() -> Tabnas {
    make_with(&COptions::default())
}

/// A parser built with the given plugin options.
pub fn make_with(options: &COptions) -> Tabnas {
    let mut parser = tabnas_jsonic::make();
    c(&mut parser, options).expect("c: the grammar installs on a jsonic instance");
    parser
}

/// Parse C source with a shared default parser.
///
/// Building a parser costs far more than a small parse, so the
/// instance is built once and reused. For anything but a one-off call,
/// build one with [`make`] and keep it.
pub fn parse(source: &str) -> Result<Value, TabnasError> {
    static DEFAULT: OnceLock<Tabnas> = OnceLock::new();
    let parser = DEFAULT.get_or_init(make);
    parse_with(parser, source)
}

/// Parse with a parser the caller built, realizing the tree into plain
/// engine values.
///
/// A parse builds its tree in a per-thread arena and the value the
/// engine returns is a handle into it, so a caller driving a `tabnas`
/// instance directly must call [`realize`] on the result before the
/// next parse on that thread. This function does it for you.
pub fn parse_with(parser: &Tabnas, source: &str) -> Result<Value, TabnasError> {
    let value = parser.parse(source)?;
    realized(source, &value)
}

/// Realize a parsed tree, failing the parse when the walk ran out of
/// depth.
///
/// A tree deeper than [`cst::REALIZE_DEPTH_CAP`], or one that is not a
/// tree at all, would otherwise come back with a hole in it where the
/// walk stopped. The engine's own budget exhaustion reports `cancel`,
/// so a limit reached here reports the same code rather than inventing
/// one: this package declares no error codes of its own.
fn realized(source: &str, value: &Value) -> Result<Value, TabnasError> {
    let realized = realize(value);
    if cst::realize_truncated() || state::with_state(|inner| inner.gave_up) {
        return Err(TabnasError::new("cancel", "", source, 0, 1, 1));
    }
    Ok(realized)
}

/// Parse with names the source never declares itself: the typedef and
/// macro names a header would have introduced.
///
/// This is the Rust spelling of the canonical `jsonic.parse(src,
/// { cmeta })` and of the Go port's `ParseMeta(src, map[string]any{
/// "cmeta": cm})`. Without it a corpus of `#include <stdint.h>`
/// programs parses `uint32_t` as a declared name rather than a type.
pub fn parse_with_meta(parser: &Tabnas, source: &str, meta: &CMeta) -> Result<Value, TabnasError> {
    let value = parser.parse_with_meta(source, meta.to_value())?;
    realized(source, &value)
}
