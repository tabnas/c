/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import _ "embed"

// TranslationPart is one optional alchemy source and the entry point a host calls.
type TranslationPart struct {
	Entry  string
	Source string
}

// TranslationParts is the package-local structural translation interface.
type TranslationParts struct {
	Manifest string
	Lift     *TranslationPart
	Embed    *TranslationPart
	Render   *TranslationPart
	// Transduce is the transducer part: the reader's tree, C's concrete
	// syntax tree, as JSON events from the grammar's rule passes.
	Transduce *TranslationPart
}

//go:embed translate/manifest.json
var translationManifest string

//go:embed translate/render.alc
var translationRender string

//go:embed translate/transduce.alc
var translationTransduce string

var translationParts = TranslationParts{
	Manifest:  translationManifest,
	Render:    &TranslationPart{Entry: "c-render", Source: translationRender},
	Transduce: &TranslationPart{Entry: "c-transduce", Source: translationTransduce},
}

// Translate returns the translation parts of C source: the manifest, the
// render that writes the reader's tree, a concrete syntax tree, back as C
// source, and the transducer part, c-transduce, that makes the reader's
// tree as JSON events from the grammar's rule passes, for a host that
// reads parser events. There is no lift and no embed: the tree is the
// reader's own shape, the schema c.
// Each call returns a copy of its own, so that what one caller changes
// is not what another reads.
func Translate() *TranslationParts {
	parts := translationParts
	parts.Lift = copyPart(parts.Lift)
	parts.Embed = copyPart(parts.Embed)
	parts.Render = copyPart(parts.Render)
	parts.Transduce = copyPart(parts.Transduce)
	return &parts
}

// copyPart is a part of its own, so that no caller reaches another's.
func copyPart(part *TranslationPart) *TranslationPart {
	if part == nil {
		return nil
	}
	copied := *part
	return &copied
}
