#!/usr/bin/env node

// Embed c-grammar.jsonic into src/c.ts between the BEGIN/END markers.
// Run via: npm run embed  (or: node embed-grammar.js)

const fs = require('fs')
const path = require('path')

const GRAMMAR_FILE = path.join(__dirname, 'c-grammar.jsonic')
const TS_FILE = path.join(__dirname, 'src', 'c.ts')

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
