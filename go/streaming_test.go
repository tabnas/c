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
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
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

// passLogger is a parser build makes, whose parses it logs. A line is
// written into buf, which each line reuses, so that a parse that only
// hashes its lines allocates none.
type passLogger struct {
	j    *jsonic.Jsonic
	seen *passSeen
	buf  []byte
}

// appendToken writes a token as a line names it: its name, its text and
// its byte offset.
func appendToken(b []byte, tkn *tabnas.Token) []byte {
	b = append(b, tkn.Name...)
	b = append(b, ' ')
	b = strconv.AppendQuote(b, tkn.Src)
	b = append(b, ' ')
	return strconv.AppendInt(b, int64(tkn.SI), 10)
}

func newPassLogger(t *testing.T, build func(...map[string]any) (*jsonic.Jsonic, error), opts map[string]any) *passLogger {
	t.Helper()
	j, err := build(opts)
	if err != nil {
		t.Fatal(err)
	}
	l := &passLogger{j: j}
	j.Sub(func(tkn *tabnas.Token, _ *tabnas.Rule, _ *tabnas.Context) {
		if tkn == nil || tkn.IsNoToken() || l.seen == nil {
			return
		}
		l.add(appendToken(append(l.buf[:0], "lex "...), tkn))
	}, nil)
	j.SubRuleDone(func(r *tabnas.Rule, _ *tabnas.Context, done tabnas.RuleDone) {
		if l.seen == nil {
			return
		}
		closing := done.State == tabnas.CLOSE
		b := append(l.buf[:0], r.Name...)
		b = append(b, " | "...)
		b = append(b, done.State...)
		b = append(b, " | "...)
		b = strconv.AppendInt(b, int64(r.D), 10)
		b = append(b, " | "...)
		b = strconv.AppendInt(b, int64(r.I), 10)
		b = append(b, " | "...)
		if done.Alt == nil {
			b = append(b, '-')
		} else {
			b = append(b, done.Alt.P...)
			b = append(b, '/')
			b = append(b, done.Alt.R...)
			b = append(b, '/')
			b = strconv.AppendInt(b, int64(done.Alt.B), 10)
			b = append(b, '/')
			for i, g := range done.Alt.G {
				if i > 0 {
					b = append(b, ',')
				}
				b = append(b, g...)
			}
		}
		b = append(b, " | "...)
		b = strconv.AppendBool(b, done.Forced)
		b = append(b, " | "...)
		b = strconv.AppendBool(b, done.Probe)
		b = append(b, " | "...)
		if len(r.N) > 0 {
			names := make([]string, 0, len(r.N))
			for name := range r.N {
				names = append(names, name)
			}
			sort.Strings(names)
			for i, name := range names {
				if i > 0 {
					b = append(b, ',')
				}
				b = append(b, name...)
				b = append(b, '=')
				b = strconv.AppendInt(b, int64(r.N[name]), 10)
			}
		}
		b = append(b, " | "...)
		b = strconv.AppendBool(b, carried(closing, r.Node))
		b = append(b, " | "...)
		tokens := r.O[:r.ON]
		if closing {
			tokens = r.C[:r.CN]
		}
		for i, tkn := range tokens {
			if i > 0 {
				b = append(b, ", "...)
			}
			b = appendToken(b, tkn)
		}
		l.add(b)
	})
	return l
}

// add counts and hashes a line, and keeps it where the parse keeps its
// lines.
func (l *passLogger) add(line []byte) {
	l.buf = line[:0]
	if l.seen == nil {
		return
	}
	l.seen.count++
	if l.seen.lines != nil {
		l.seen.lines = append(l.seen.lines, string(line))
	}
	l.seen.hasher.Write(line)
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
		if errors.As(err, &te) {
			l.add([]byte(fmt.Sprintf("err %s at %d %d:%d %q", te.Code, te.Pos, te.Row, te.Col, te.Src)))
		} else {
			// Not an engine error: a line no engine error makes, so that
			// it differs from whatever the other parser's parse shows.
			l.add([]byte(fmt.Sprintf("not an engine error: %v", err)))
		}
	} else {
		l.add([]byte("ok"))
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
	// The programs are compared on as many goroutines as the machine has
	// processors, at most four, each with parsers of its own: four parses
	// of a hundred programs take minutes on one.
	workers := min(4, runtime.GOMAXPROCS(0))
	next := make(chan string)
	var mu sync.Mutex
	var failures []string
	done := 0
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tree, stream := &passLoggers{build: MakeC}, &passLoggers{build: MakeStreaming}
			for f := range next {
				var found []string
				raw, err := os.ReadFile(filepath.Join(corpusDir, f))
				if err != nil {
					found = append(found, f+": "+err.Error())
				} else {
					text := header.String() + string(raw)
					for _, reader := range []bool{false, true} {
						if d := streamDifference(t, tree, stream, f, text, map[string]any{}, reader); "" != d {
							found = append(found, d)
						}
					}
				}
				mu.Lock()
				failures = append(failures, found...)
				done++
				mu.Unlock()
			}
		}()
	}
	reported := time.Now()
	for i, f := range files {
		next <- f
		if time.Since(reported) > 20*time.Second {
			reported = time.Now()
			mu.Lock()
			fmt.Printf("streaming csmith: %d of %d programs given, %d done (%d%%)\n", i+1, len(files), done, done*100/len(files))
			mu.Unlock()
		}
	}
	close(next)
	wg.Wait()
	fmt.Printf("streaming csmith: %d of %d programs (100%%)\n", done, len(files))
	if len(failures) > 0 {
		sort.Strings(failures)
		t.Fatalf("%d parses differ:\n%s", len(failures), strings.Join(failures, "\n"))
	}
}
