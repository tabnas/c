/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

package tabnasc

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"
	"unicode"
)

// The parts a host sees are the package's embedded copies, written by
// `npm run embed` in ts/; they must be the repository's files.
func TestTranslationParts(t *testing.T) {
	inCheckout(t)
	parts := Translate()
	if parts == nil {
		t.Fatal("Translate returned nil")
	}
	manifest, err := os.ReadFile("../tabnas.plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	if parts.Manifest != string(manifest) {
		t.Fatal("embedded manifest differs from tabnas.plugin.json: run npm run embed in ts")
	}
	if parts.Lift != nil {
		t.Fatal("c has no lift")
	}
	if parts.Render == nil || parts.Render.Entry != "c-render" {
		t.Fatalf("render entry is %#v", parts.Render)
	}
	render, err := os.ReadFile("../alchemy/render.alc")
	if err != nil {
		t.Fatal(err)
	}
	if parts.Render.Source != string(render) {
		t.Fatal("embedded render differs from alchemy/render.alc: run npm run embed in ts")
	}
}

// An embed takes a plain tree into a format's own schema. c's render
// writes the syntax tree the reader builds and nothing else, so its
// manifest names no embed and the package carries none; a manifest that
// named one would be held to its file here, as the render is above.
func TestTranslationEmbed(t *testing.T) {
	inCheckout(t)
	manifest, err := os.ReadFile("../tabnas.plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Translate struct {
			Embed *string `json:"embed"`
		} `json:"translate"`
	}
	if err := json.Unmarshal(manifest, &spec); err != nil {
		t.Fatal(err)
	}
	parts := Translate()
	if spec.Translate.Embed == nil {
		if parts.Embed != nil {
			t.Fatalf("the manifest names no embed, and Translate carries %#v", parts.Embed)
		}
		return
	}
	if parts.Embed == nil || parts.Embed.Entry != "c-embed" {
		t.Fatalf("embed entry is %#v", parts.Embed)
	}
	embed, err := os.ReadFile("../" + *spec.Translate.Embed)
	if err != nil {
		t.Fatal(err)
	}
	if parts.Embed.Source != string(embed) {
		t.Fatalf("embedded embed differs from %s", *spec.Translate.Embed)
	}
}

// The tree is the reader's own shape, so the manifest names it, and the
// host prints each loss line as it is, so each is a sentence.
func TestTranslationSchema(t *testing.T) {
	var spec struct {
		LanguageID string `json:"languageId"`
		Translate  struct {
			Reads  string   `json:"reads"`
			Writes string   `json:"writes"`
			Root   string   `json:"root"`
			Schema string   `json:"schema"`
			Render string   `json:"render"`
			Loss   []string `json:"loss"`
		} `json:"translate"`
	}
	if err := json.Unmarshal([]byte(Translate().Manifest), &spec); err != nil {
		t.Fatal(err)
	}
	tr := spec.Translate
	if spec.LanguageID != "c" || tr.Reads != "tree" || tr.Writes != "tree" || tr.Root != "object" || tr.Schema != "c" || tr.Render != "alchemy/render.alc" {
		t.Fatalf("languageId is %q, translate is %+v", spec.LanguageID, tr)
	}
	if len(tr.Loss) == 0 {
		t.Fatal("translate.loss is empty")
	}
	for _, line := range tr.Loss {
		first := []rune(line)
		if len(first) == 0 || !unicode.IsUpper(first[0]) || !strings.HasSuffix(line, ".") {
			t.Fatalf("%q is not a sentence", line)
		}
	}
}

// A host links the render with its own program and other formats' parts,
// so every definition is named for c, the entry point is `c-render`, and
// the file defines no `export` of its own.
func TestTranslationRenderIsALibrary(t *testing.T) {
	render := Translate().Render
	if render == nil {
		t.Fatal("c carries no render")
	}
	entry := false
	for _, line := range strings.Split(render.Source, "\n") {
		rest, ok := strings.CutPrefix(line, "def ")
		if !ok {
			continue
		}
		name := strings.Fields(rest)[0]
		if !strings.HasPrefix(name, "c-") {
			t.Fatalf("%s is not named for c", name)
		}
		if name == "c-render" {
			entry = true
		}
	}
	if !entry {
		t.Fatal("the render defines no c-render")
	}
}

// Every call hands back parts of its own: a caller that changes what it
// was given, the parts or a part they point to, changes nothing the next
// caller reads, and callers on several goroutines share nothing to race on.
func TestTranslateReturnsACopy(t *testing.T) {
	first := Translate()
	want := *Translate().Render
	first.Manifest = ""
	if first.Render != nil {
		first.Render.Entry = ""
		first.Render.Source = ""
	}
	first.Lift, first.Embed, first.Render = nil, nil, nil
	second := Translate()
	if second.Manifest == "" {
		t.Fatal("a change to one call's manifest reached the next call")
	}
	if second.Render == nil || *second.Render != want {
		t.Fatalf("a change to one call's render reached the next call: %#v", second.Render)
	}
}

// inCheckout skips a test that holds the embedded copies to the
// repository's own files when it runs where those files are not, as from
// the module cache, whose zip holds the go/ module alone. In a checkout,
// a missing file still fails the test that reads it.
func inCheckout(t *testing.T) {
	t.Helper()
	if _, err := os.Stat("../ts/package.json"); errors.Is(err, fs.ErrNotExist) {
		t.Skip("not in a checkout of the repository: the module cache holds the go/ module alone")
	}
}
