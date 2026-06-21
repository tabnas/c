# @tabnas/c (TypeScript)

The TypeScript implementation of `@tabnas/c` — a [Tabnas](https://github.com/tabnas/parser)
parser plugin (layered on [@tabnas/jsonic](https://github.com/tabnas/jsonic))
that parses C source into a concrete syntax tree.

See the [top-level README](../README.md) for the full description, CST
shapes and architecture notes.

## Build & test

```bash
npm install   # resolves the @tabnas/parser, @tabnas/jsonic, @tabnas/expr siblings
npm run build # node embed-grammar.js && tsc --build src test
npm test      # node --enable-source-maps --test "dist-test/*.test.js"
```

The grammar lives in [`c-grammar.jsonic`](c-grammar.jsonic) and is embedded
into [`src/c.ts`](src/c.ts) at build time by
[`embed-grammar.js`](embed-grammar.js). Edit the grammar there, not in the
generated `grammarText` string literal between the `BEGIN/END EMBEDDED`
markers.
