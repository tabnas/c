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
}

//go:embed translate/manifest.json
var translationManifest string

//go:embed translate/render.alc
var translationRender string

var translationParts = TranslationParts{
	Manifest: translationManifest,
	Render:   &TranslationPart{Entry: "c-render", Source: translationRender},
}

// Translate returns the translation parts of C source: the manifest, and
// the render that writes the reader's tree, a concrete syntax tree, back as
// C source. There is no lift and no embed: the tree is the reader's own
// shape, the schema c.
// Each call returns a copy of its own, so that what one caller changes
// is not what another reads.
func Translate() *TranslationParts {
	parts := translationParts
	parts.Lift = copyPart(parts.Lift)
	parts.Embed = copyPart(parts.Embed)
	parts.Render = copyPart(parts.Render)
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
