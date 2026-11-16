package tabnasc

// streaming_test.go: the parser a host streams a C document through,
// MakeStreaming, against the parser for a tree, MakeC. Its rules decide as
// MakeC's, by the same handlers, but its translation unit, conditional
// groups and branches keep nothing that has closed, its items loop lets go
// of the rules it replaces, and its record of the nodes given their spans
// starts again at each declaration. So its rule passes, which C's
// transducer part (alchemy/transduce.alc) reads, must be MakeC's: over
// every row of the shared fixtures and every Csmith program, from the text
// and from a reader, every pass alike (its rule, state, depth, instance,
// alternate, counters and tokens, and whether it carries the rule's node as
// a value), every token the lexer gives alike, and every parse ending
// alike, an error at the same code, place and token.
// ts/test/streaming.test.ts and rs/tests/streaming_test.rs hold the
// TypeScript and Rust ports to the same.

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"hash/fnv"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	jsonic "github.com/tabnas/jsonic/go"
	tabnas "github.com/tabnas/parser/go"
	support "github.com/tabnas/support/go"
)

// carried says whether a pass carries the rule's node as a value, as
// transduce's parser-event source asks it: a close pass does, where the
// node is not the engine's Undefined and not a container.
func carried(close bool, node any) bool {
	if !close || tabnas.IsUndefined(node) {
		return false
	}
	switch node.(type) {
	case map[string]any, []any, *tabnas.OrderedMap:
		return false
	}
	return true
}

// passSeen is what a parse shows: how many lines its passes, the tokens the
// lexer gave and its ending make, their hash, and, where kept, the lines.
type passSeen struct {
	count  int
	hasher hash.Hash64
	lines  []string
}

// passLogger is a parser build makes, whose parses it logs.
type passLogger struct {
	j    *jsonic.Jsonic
	seen *passSeen
}

func newPassLogger(t *testing.T, build func(...map[string]any) (*jsonic.Jsonic, error), opts map[string]any) *passLogger {
	t.Helper()
	j, err := build(opts)
	if err != nil {
		t.Fatal(err)
	}
	l := &passLogger{j: j}
	j.Sub(func(tkn *tabnas.Token, _ *tabnas.Rule, _ *tabnas.Context) {
		if tkn == nil || tkn.IsNoToken() {
			return
		}
		l.add(fmt.Sprintf("lex %s %q %d", tkn.Name, tkn.Src, tkn.SI))
	}, nil)
	j.SubRuleDone(func(r *tabnas.Rule, _ *tabnas.Context, done tabnas.RuleDone) {
		tokens := r.O[:r.ON]
		if done.State == tabnas.CLOSE {
			tokens = r.C[:r.CN]
		}
		srcs := make([]string, len(tokens))
		for i, tkn := range tokens {
			srcs[i] = fmt.Sprintf("%s %q %d", tkn.Name, tkn.Src, tkn.SI)
		}
		alt := "-"
		if done.Alt != nil {
			alt = fmt.Sprintf("%s/%s/%d/%s", done.Alt.P, done.Alt.R, done.Alt.B, strings.Join(done.Alt.G, ","))
		}
		names := make([]string, 0, len(r.N))
		for name := range r.N {
			names = append(names, fmt.Sprintf("%s=%d", name, r.N[name]))
		}
		sort.Strings(names)
		l.add(fmt.Sprintf("%s | %s | %d | %d | %s | %v | %v | %s | %v | %s",
			r.Name, done.State, r.D, r.I, alt, done.Forced, done.Probe, strings.Join(names, ","),
			carried(done.State == tabnas.CLOSE, r.Node), strings.Join(srcs, ", ")))
	})
	return l
}

func (l *passLogger) add(line string) {
	if l.seen == nil {
		return
	}
	l.seen.count++
	if l.seen.lines != nil {
		l.seen.lines = append(l.seen.lines, line)
	}
	l.seen.hasher.Write([]byte(line))
	l.seen.hasher.Write([]byte{'\n'})
}

func (l *passLogger) parse(t *testing.T, text string, reader, keep bool) *passSeen {
	t.Helper()
	l.seen = &passSeen{hasher: fnv.New64a()}
	if keep {
		l.seen.lines = []string{}
	}
	var err error
	if reader {
		_, err = l.j.ParseReader(&pieces{text: []byte(text), size: 4096})
	} else {
		_, err = l.j.Parse(text)
	}
	if err != nil {
		var te *tabnas.TabnasError
		if !errors.As(err, &te) {
			t.Fatalf("not an engine error: %v", err)
		}
		l.add(fmt.Sprintf("err %s at %d %d:%d %q", te.Code, te.Pos, te.Row, te.Col, te.Src))
	} else {
		l.add("ok")
	}
	seen := l.seen
	l.seen = nil
	return seen
}

// passLoggers builds a logger for each parser and option set once.
type passLoggers struct {
	build func(...map[string]any) (*jsonic.Jsonic, error)
	built map[string]*passLogger
}

func (p *passLoggers) of(t *testing.T, opts map[string]any) *passLogger {
	key := fmt.Sprintf("%v", opts)
	if p.built == nil {
		p.built = map[string]*passLogger{}
	}
	if l := p.built[key]; l != nil {
		return l
	}
	l := newPassLogger(t, p.build, opts)
	p.built[key] = l
	return l
}

// streamDifference is the first difference between MakeC's parse of text
// and the streaming parser's, or "": the two are compared by their count
// and hash, and parsed again, keeping their lines, only where those differ.
func streamDifference(t *testing.T, tree, stream *passLoggers, at, text string, opts map[string]any, reader bool) string {
	t.Helper()
	want := tree.of(t, opts).parse(t, text, reader, false)
	got := stream.of(t, opts).parse(t, text, reader, false)
	if want.count == got.count && want.hasher.Sum64() == got.hasher.Sum64() {
		return ""
	}
	a := tree.of(t, opts).parse(t, text, reader, true).lines
	b := stream.of(t, opts).parse(t, text, reader, true).lines
	i := 0
	for i < len(a) && i < len(b) && a[i] == b[i] {
		i++
	}
	line := func(ls []string) string {
		if i < len(ls) {
			return ls[i]
		}
		return "(none)"
	}
	how := ""
	if reader {
		how = ", from a reader"
	}
	return fmt.Sprintf("%s%s: line %d of %d\n  MakeC:         %s\n  MakeStreaming: %s", at, how, i, len(a), line(a), line(b))
}

func TestMakeStreamingBuildsNoTree(t *testing.T) {
	text := "typedef int T;\n#ifdef X\nT a;\n#else\nint b;\n#endif\nint f(void) { return 0; }\n"
	stream, err := MakeStreaming()
	if err != nil {
		t.Fatal(err)
	}
	v, err := stream.Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	n, ok := v.(CNode)
	if !ok || n["kind"] != "translation_unit" {
		t.Fatalf("MakeStreaming's value: %#v", v)
	}
	if kids, _ := n["children"].([]any); len(kids) != 0 {
		t.Fatalf("MakeStreaming's translation unit holds %d children", len(kids))
	}
	tree, err := MakeC()
	if err != nil {
		t.Fatal(err)
	}
	w, err := tree.Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	if kids, _ := w.(CNode)["children"].([]any); len(kids) != 3 {
		t.Fatalf("MakeC's translation unit holds %d children, not 3", len(kids))
	}
	if !stream.Config().Window {
		t.Fatal("MakeStreaming declares no lex.window")
	}
}

func TestMakeStreamingsPassesAreMakeCsOverEveryFixture(t *testing.T) {
	dir, err := support.FindSpecDir("")
	if err != nil {
		t.Fatal(err)
	}
	files, err := support.LoadSpecDir(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	tree, stream := &passLoggers{build: MakeC}, &passLoggers{build: MakeStreaming}
	var failures []string
	compared := 0
	for _, file := range files {
		for _, row := range file.Rows {
			opts := map[string]any{}
			if raw := row.Named("opts"); "" != raw {
				if err := json.Unmarshal([]byte(raw), &opts); err != nil {
					t.Fatalf("%s: opts: %v", row.Where(), err)
				}
			}
			if start, _ := opts["start"].(string); "" != start {
				// A row that reads an expression or a declaration on its
				// own, which the streaming parser is not for.
				continue
			}
			pluginOpts := map[string]any{}
			if p, ok := opts["plugin"].(map[string]any); ok {
				pluginOpts = p
			}
			input := row.UnescNamed("input")
			for _, reader := range []bool{false, true} {
				if d := streamDifference(t, tree, stream, row.Where(), input, pluginOpts, reader); "" != d {
					failures = append(failures, d)
				}
				compared++
			}
		}
	}
	if compared < 400 {
		t.Errorf("%d parses compared, fewer than the 400 there are", compared)
	}
	if len(failures) > 0 {
		t.Fatalf("%d of %d parses differ:\n%s", len(failures), compared, strings.Join(failures, "\n"))
	}
}

func TestMakeStreamingsPassesAreMakeCsOverEveryCsmithProgram(t *testing.T) {
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
	// A program as dmog reads it: plain C, after a header that declares
	// csmith.h's stdint names as typedef names.
	var header strings.Builder
	for _, n := range csmithStdintTypedefs {
		header.WriteString("typedef int " + n + ";\n")
	}
	tree, stream := &passLoggers{build: MakeC}, &passLoggers{build: MakeStreaming}
	var failures []string
	reported := time.Now()
	for i, f := range files {
		raw, err := os.ReadFile(filepath.Join(corpusDir, f))
		if err != nil {
			t.Fatal(err)
		}
		text := header.String() + string(raw)
		for _, reader := range []bool{false, true} {
			if d := streamDifference(t, tree, stream, f, text, map[string]any{}, reader); "" != d {
				failures = append(failures, d)
			}
		}
		if i+1 == len(files) || time.Since(reported) > 20*time.Second {
			reported = time.Now()
			fmt.Printf("streaming csmith: %d of %d programs (%d%%)\n", i+1, len(files), (i+1)*100/len(files))
		}
	}
	if len(failures) > 0 {
		t.Fatalf("%d parses differ:\n%s", len(failures), strings.Join(failures, "\n"))
	}
}
