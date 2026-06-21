#!/usr/bin/env node

// Embed c-grammar.jsonic into the TypeScript source, and mirror it into the
// Go module for //go:embed. c-grammar.jsonic is the single source of truth.
//
//   - TS: spliced into src/c.ts between the BEGIN/END markers as a template
//     literal (backticks escaped).
//   - Go: copied verbatim to ../go/c-grammar.jsonic. The C grammar contains
//     backticks, so the Go port embeds it from the file with //go:embed
//     rather than inlining it as a raw string (as the smaller ports do).
//
// Run via: npm run embed  (or: node embed-grammar.js)

const fs = require('fs')
const path = require('path')

const GRAMMAR_FILE = path.join(__dirname, 'c-grammar.jsonic')
const TS_FILE = path.join(__dirname, 'src', 'c.ts')
const GO_GRAMMAR_FILE = path.join(__dirname, '..', 'go', 'c-grammar.jsonic')

const BEGIN = '// --- BEGIN EMBEDDED c-grammar.jsonic ---'
const END = '// --- END EMBEDDED c-grammar.jsonic ---'

const grammar = fs.readFileSync(GRAMMAR_FILE, 'utf8')

let src = fs.readFileSync(TS_FILE, 'utf8')
const startIdx = src.indexOf(BEGIN)
const endIdx = src.indexOf(END)
if (startIdx === -1 || endIdx === -1) {
  console.error('embed markers not found in', TS_FILE)
  process.exit(1)
}

// Escape backticks and template expressions for a JS template literal.
const escaped = grammar
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

const replacement =
  BEGIN +
  '\nconst grammarText = `\n' +
  escaped +
  '`\n' +
  END

src = src.substring(0, startIdx) + replacement + src.substring(endIdx + END.length)
fs.writeFileSync(TS_FILE, src)
console.log('Embedded grammar into', TS_FILE)

// Mirror the grammar into the Go module for //go:embed (only if the go/
// directory exists — the Go port is optional/scaffold).
if (fs.existsSync(path.dirname(GO_GRAMMAR_FILE))) {
  fs.writeFileSync(GO_GRAMMAR_FILE, grammar)
  console.log('Copied grammar to', GO_GRAMMAR_FILE)
}
