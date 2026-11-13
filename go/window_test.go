package tabnasc

// window_test.go: a parse from a reader (Tabnas.ParseReader, admin ADR-30
// and ADR-33).
//
// MakeC builds the parser whole, as jsonic.Make() then j.Use(C, opts)
// builds it, and declares lex.window on it, so that a reader is read a
// window at a time. C's matchers read the source only through the window:
// a scan that reaches the window's end fills it and the token is cut again
// (matchers.go). These tests hold it to that: MakeC declares the window
// whatever its base declares; every row of the shared fixtures, under its
// opts, and every Csmith program parse the same from a reader, in pieces of
// several sizes, as from their text; and tokens of every kind longer than
// the window, and a long document whose tokens straddle the window's
// blocks, parse the same too, in time linear in its length.
//
// Go's window sizes are fixed at 64 KiB (the engine's small-window hook is
// unexported), and before each token the window reaches 64 KiB past the
// cursor, so a scan meets the window's edge only where it reads further
// than that: the long tokens are each longer, and the long document holds
// them among short tokens of every kind, so that its tokens straddle the
// window's 64 KiB blocks at many offsets.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	jsonic "github.com/tabnas/jsonic/go"
	tabnas "github.com/tabnas/parser/go"
	support "github.com/tabnas/support/go"
)

// readerMargin is how far past the cursor the window reaches before each
// token is cut: a scan that reads further meets the window's edge.
const readerMargin = 64 << 10

// pieces is a reader that hands its bytes over at most size at a time.
type pieces struct {
	text []byte
	at   int
	size int
}

func (p *pieces) Read(buf []byte) (int, error) {
	if p.at == len(p.text) {
		return 0, io.EOF
	}
	n := min(p.size, len(buf), len(p.text)-p.at)
	copy(buf, p.text[p.at:p.at+n])
	p.at += n
	return n, nil
}

// outcome is what a parse shows: its value, or its error's code, position,
// row, column and token text. An error's excerpt is left out: a parse from
// a reader shows a long line only as far back as the window reaches
// (tabnas/parser DIVERGENCE.md), and that is the one difference allowed.
type outcome struct {
	value any
	err   string
}

func outcomeOf(v any, err error) outcome {
	if err == nil {
		return outcome{value: v}
	}
	var te *tabnas.TabnasError
	if errors.As(err, &te) {
		return outcome{err: fmt.Sprintf("%s at %d %d:%d %q", te.Code, te.Pos, te.Row, te.Col, te.Src)}
	}
	return outcome{err: "not a TabnasError: " + err.Error()}
}

func (o outcome) String() string {
	if o.err != "" {
		return "error " + o.err
	}
	s := fmt.Sprintf("value %v", o.value)
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	return s
}

func (o outcome) same(p outcome) bool {
	return o.err == p.err && reflect.DeepEqual(o.value, p.value)
}

// sameFromReader parses text whole and from a reader in pieces of each
// size, each parse with the metadata meta makes, and reports where the two
// differ. It returns the number of reader parses compared.
func sameFromReader(t *testing.T, j *jsonic.Jsonic, at, text string, sizes []int, meta func() map[string]any) int {
	t.Helper()
	whole := outcomeOf(j.ParseMeta(text, meta()))
	for _, size := range sizes {
		read := outcomeOf(j.ParseReaderMeta(&pieces{text: []byte(text), size: size}, meta()))
		if !read.same(whole) {
			show := text
			if len(show) > 80 {
				show = show[:80]
			}
			t.Errorf("%s: %q in pieces of %d:\n  whole:  %s\n  reader: %s", at, show, size, whole, read)
		}
	}
	return len(sizes)
}

// readerSizes are the pieces a document is handed over in: down to a byte
// for a short one, and from 64 bytes for one over 8 KiB, whose every
// one-byte read the Go window answers with a copy of itself
// (tabnas/parser#321).
func readerSizes(text string) []int {
	if len(text) > 8<<10 {
		return []int{64, 4096, readerMargin + 3}
	}
	return []int{1, 3, 64, 4096}
}

func noMeta() map[string]any { return nil }

// TestMakeCDeclaresTheWindow: the parser MakeC builds declares lex.window,
// so that ParseReader reads a reader a window at a time; the plugin alone
// declares nothing, since a host may install it beneath matchers of its own:
// on a base that declares no window, it leaves none.
func TestMakeCDeclaresTheWindow(t *testing.T) {
	j, err := MakeC()
	if err != nil {
		t.Fatal(err)
	}
	if !j.Config().Window {
		t.Error("MakeC does not declare lex.window")
	}
	no := false
	composed := jsonic.Make()
	composed.SetOptions(tabnas.Options{Lex: &tabnas.LexOptions{Window: &no}})
	if err := composed.Use(C, nil); err != nil {
		t.Fatal(err)
	}
	if composed.Config().Window {
		t.Error("the plugin alone declares lex.window")
	}
}

// TestMakeCOnABaseWithoutTheWindow: the parser's own setting wins over its
// base's. A base that declares lex.window false comes out with the window.
func TestMakeCOnABaseWithoutTheWindow(t *testing.T) {
	no := false
	base := jsonic.Make()
	base.SetOptions(tabnas.Options{Lex: &tabnas.LexOptions{Window: &no}})
	if base.Config().Window {
		t.Fatal("the base declares lex.window")
	}
	j, err := makeCOn(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !j.Config().Window {
		t.Error("the C parser does not declare lex.window")
	}
	if _, err := j.Parse("int main(void) { return 0; }"); err != nil {
		t.Errorf("parse: %v", err)
	}
}

// TestEveryRowParsesTheSameFromAReader: every row of the shared fixtures,
// under its opts, parses the same from a reader as from its text.
func TestEveryRowParsesTheSameFromAReader(t *testing.T) {
	dir, err := support.FindSpecDir("")
	if err != nil {
		t.Fatal(err)
	}
	files, err := support.LoadSpecDir(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	parsers := map[string]*jsonic.Jsonic{}
	rows, compared := 0, 0
	for _, file := range files {
		for _, row := range file.Rows {
			opts := map[string]any{}
			if raw := row.Named("opts"); "" != raw {
				if err := json.Unmarshal([]byte(raw), &opts); err != nil {
					t.Fatalf("%s: opts: %v", row.Where(), err)
				}
			}
			pluginOpts := map[string]any{}
			if p, ok := opts["plugin"].(map[string]any); ok {
				pluginOpts = p
			}
			start, _ := opts["start"].(string)
			key := fmt.Sprintf("%v %s", pluginOpts, start)
			j := parsers[key]
			if j == nil {
				if j, err = MakeC(pluginOpts); err != nil {
					t.Fatal(err)
				}
				if "" != start {
					j.SetOptions(tabnas.Options{Rule: &tabnas.RuleOptions{Start: start}})
				}
				parsers[key] = j
			}
			input := row.UnescNamed("input")
			compared += sameFromReader(t, j, row.Where(), input, readerSizes(input), noMeta)
			rows++
		}
	}
	if rows < 200 {
		t.Errorf("%d fixture rows, fewer than the 200 there are", rows)
	}
	t.Logf("window fixtures: %d rows, %d reader parses", rows, compared)
}

// TestEveryCsmithProgramParsesTheSameFromAReader: every program of the
// Csmith corpus, read as the Csmith suite reads it (extended, with
// csmith.h's stdint names declared as typedef names), parses the same from
// a reader in pieces of 4 KiB as from its text.
func TestEveryCsmithProgramParsesTheSameFromAReader(t *testing.T) {
	if testing.Short() {
		t.Skip("the Csmith corpus is long")
	}
	corpusDir := filepath.Join("..", "ts", "test", "csmith-corpus")
	files, err := csmithCorpusFiles(corpusDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < 100 {
		t.Fatalf("%d Csmith programs, fewer than the 100 there are", len(files))
	}
	j, err := MakeC(map[string]any{"extended": true})
	if err != nil {
		t.Fatal(err)
	}
	meta := func() map[string]any {
		cm := MakeCMeta()
		for _, n := range csmithStdintTypedefs {
			cm.Symbols.BindTypedef(n)
		}
		return map[string]any{"cmeta": cm}
	}
	for i, f := range files {
		raw, err := os.ReadFile(filepath.Join(corpusDir, f))
		if err != nil {
			t.Fatal(err)
		}
		sameFromReader(t, j, f, string(raw), []int{4096}, meta)
		fmt.Printf("window csmith: %d of %d programs (%d%%)\n", i+1, len(files), (i+1)*100/len(files))
	}
}

// longDocument is a document of n items, each a few lines of C with tokens
// of every kind the matchers cut, of lengths that vary with the item, so
// that the window's 64 KiB blocks fall inside tokens of every kind.
func longDocument(n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		pad := strings.Repeat(" ", i%7)
		word := "name" + strings.Repeat("x", i%13)
		fmt.Fprintf(&b, "/* item %d%s */\n", i, strings.Repeat("-", i%11))
		fmt.Fprintf(&b, "#define M%d %d\n", i, i)
		fmt.Fprintf(&b, "%s#if %d\n", pad, i%2)
		fmt.Fprintf(&b, "static int %s_%d = 0x%x + %d.%de+%d; // %s\n", word, i, i, i, i%10, i%3, word)
		fmt.Fprintf(&b, "#endif\n")
		fmt.Fprintf(&b, "char *s%d = u8\"%s\\n\" \"%d\"; char c%d = '\\%d';\r\n", i, word, i, i, i%8)
		fmt.Fprintf(&b, "int f%d(int a, ...) { return a <<= %d, a >>= 1, M%d; } \\\n\n", i, i%5, i)
	}
	return b.String()
}

// TestLongTokensParseTheSameFromAReader: each kind of token a matcher
// scans, longer than the window holds past the cursor, among short tokens,
// and the directives a window may begin just before.
func TestLongTokensParseTheSameFromAReader(t *testing.T) {
	long := strings.Repeat("x", readerMargin+100)
	digits := strings.Repeat("1", readerMargin+100)
	space := strings.Repeat(" ", readerMargin+100)
	docs := []struct {
		text string
		opts map[string]any
	}{
		{"int " + long + " = 1;", nil},
		{"int x = " + digits + ";", nil},
		{"double d = " + digits + "." + digits + "e+1;", nil},
		{"int x = 0x" + strings.Repeat("f", readerMargin+100) + "ull;", nil},
		{"char *s = \"" + long + "\\n" + long + "\";", nil},
		{"/* " + long + " */ int x;", nil},
		{"// " + long + "\nint x;", nil},
		{"int x;" + space + "\n" + space + "int y;", nil},
		{"#include <" + long + ".h>\nint x;", nil},
		{"#define A " + long + "\nint x = A;", nil},
		{"int x;\n" + space + "#define B 2\nint y = B;", nil},
		{"#define A 1\r" + space + "#define B 2\rint x = A + B;", nil},
		{"char *s = R\"delim(" + long + ")delim\";", map[string]any{"extended": true}},
		{"char *s = \"" + long, nil},
		{"/* " + long, nil},
	}
	for i, d := range docs {
		j, err := MakeC(d.opts)
		if err != nil {
			t.Fatal(err)
		}
		sameFromReader(t, j, fmt.Sprintf("token #%d", i), d.text, []int{4096, readerMargin + 3}, noMeta)
	}
}

// TestALongDocumentParsesTheSameFromAReader: a document of many items,
// well over the window's blocks, parses the same from a reader in pieces of
// several sizes, and ten times the items take about ten times the time.
func TestALongDocumentParsesTheSameFromAReader(t *testing.T) {
	j, err := MakeC()
	if err != nil {
		t.Fatal(err)
	}
	doc := longDocument(2000)
	if len(doc) < 2*readerMargin {
		t.Fatalf("the long document is %d bytes, under two blocks", len(doc))
	}
	sameFromReader(t, j, "long document", doc, []int{64, 4096, readerMargin + 3}, noMeta)
	timeOf := func(text string) time.Duration {
		best := time.Duration(0)
		for k := 0; k < 2; k++ {
			start := time.Now()
			if _, err := j.ParseReader(&pieces{text: []byte(text), size: 4096}); err != nil {
				t.Fatal(err)
			}
			if d := time.Since(start); 0 == k || d < best {
				best = d
			}
		}
		return best
	}
	// Ten times the items: about ten times the time, and a hundred times
	// were it quadratic. The bound leaves room for a busy machine, whose
	// collector made the ratio 16 and, once, 32 over 500 and 5,000 items.
	small := timeOf(longDocument(1000))
	large := timeOf(longDocument(10000))
	t.Logf("window time: 1000 items %v, 10000 items %v (%.1f times)", small, large, float64(large)/float64(small))
	if large > 40*small {
		t.Errorf("1000 items took %v, 10000 took %v: not linear", small, large)
	}
}
