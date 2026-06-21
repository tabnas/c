/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// Package tabnasc is the Go port of @tabnas/c — a Tabnas parser plugin
// (layered on @tabnas/jsonic) that parses C source into a concrete syntax
// tree, preserving macros and compiler extensions.
//
// STATUS: SCAFFOLD ONLY.
//
// The canonical implementation is the TypeScript package in ../ts (see
// ../ts/src/c.ts and the embedded ../ts/c-grammar.jsonic). This Go package
// currently provides only the module wiring, the embedded grammar, and the
// plugin/helper signatures. The parsing logic — the ~10.6k lines of lex
// matchers, symbol/macro tables, the @-named ref map, the structure
// post-processor and the expression evaluation — has NOT been ported yet.
//
// The intended porting map (TS module -> Go file) is:
//
//	ts/src/tokens.ts             -> tokens.go              (token catalog)
//	ts/src/symbols.ts            -> symbols.go             (SymbolTable / MacroTable)
//	ts/src/matchers.ts           -> matchers.go            (lex matchers)
//	ts/src/conditional-groups.ts -> conditional_groups.go  (#if folding post-pass)
//	ts/src/expr.ts               -> expr.go                (C operator catalog)
//	ts/src/expr-grammar.ts       -> expr_grammar.go        (Expr wiring + evaluateCExpr,
//	                                                        incl. the val after-close
//	                                                        restore — see AGENTS.md)
//	ts/src/structure.ts          -> structure.go           (legacy-fallback post-processor)
//	ts/src/c.ts                  -> c.go                   (plugin entry + ref map)
//	ts/test/c.test.ts            -> c_test.go              (parse cases)
//	ts/test/csmith*.ts           -> csmith_test.go         (CSmith corpus replay)
package tabnasc

import (
	_ "embed"
	"errors"

	// Engine + grammar siblings. tabnas is the parsing engine; jsonic
	// supplies the relaxed-JSON grammar the C grammar is layered on;
	// tabnasexpr supplies the Pratt-style expression machinery.
	tabnasexpr "github.com/tabnas/expr/go"
	jsonic "github.com/tabnas/jsonic/go"
	tabnas "github.com/tabnas/parser/go"
)

// Version is the Go module version of this plugin. Mirrors ts/package.json.
const Version = "0.2.0"

// grammarText is the C grammar, single-sourced from c-grammar.jsonic.
//
// Unlike the smaller tabnas Go ports (e.g. zon) which inline the grammar as
// a Go raw string, the C grammar contains backticks, so it is embedded from
// the companion file at build time instead. embed-grammar.js (in ../ts)
// copies ../ts/c-grammar.jsonic to ./c-grammar.jsonic so it stays in step
// with the TypeScript build.
//
//go:embed c-grammar.jsonic
var grammarText string

// Grammar returns the embedded C grammar text (jsonic-DSL source).
func Grammar() string { return grammarText }

// ErrNotImplemented is returned by the scaffold plugin until the Go port
// is complete.
var ErrNotImplemented = errors.New(
	"tabnasc: Go port not yet implemented (scaffold only); use the @tabnas/c TypeScript package")

// COptions are the plugin options. Mirrors the TypeScript COptions.
type COptions struct {
	// Extended enables the GCC/Clang/MSVC extension constructs
	// (__attribute__, __declspec, inline asm, etc.).
	Extended bool
}

// Defaults mirrors the TypeScript C.defaults.
var Defaults = COptions{
	Extended: false,
}

// C is the Tabnas plugin entry point.
//
// SCAFFOLD: returns ErrNotImplemented. The full implementation will install
// the token catalog, lex matchers, the embedded grammar (with its @-named
// ref map), the conditional-group post-pass and the @tabnas/expr-driven
// expression rules — see the porting map in the package doc.
func C(j *tabnas.Tabnas, opts map[string]any) error {
	_ = j
	_ = opts
	_ = grammarText
	return ErrNotImplemented
}

// MakeC builds a jsonic engine with the expression plugin and the C plugin
// installed — the Go equivalent of `new Tabnas().use(jsonic).use(C)`.
//
// SCAFFOLD: the C plugin currently fails to install (ErrNotImplemented), so
// the returned engine cannot yet parse C. The wiring shape is final.
func MakeC(opts ...map[string]any) (*jsonic.Jsonic, error) {
	var pluginOpts map[string]any
	if len(opts) > 0 {
		pluginOpts = opts[0]
	}

	j := jsonic.Make()

	// C drives expression parsing through @tabnas/expr; the operator table
	// and evaluate callback will be supplied by the ported expr_grammar.go.
	if err := j.Use(tabnasexpr.Expr); err != nil {
		return j, err
	}

	if err := j.Use(C, pluginOpts); err != nil {
		return j, err
	}

	return j, nil
}

// Parse is the one-call entry point: build a C-enabled engine and parse src.
//
// SCAFFOLD: returns ErrNotImplemented until the port lands.
func Parse(src string, opts ...map[string]any) (any, error) {
	_ = src
	j, err := MakeC(opts...)
	if err != nil {
		return nil, err
	}
	return j.Parse(src)
}
