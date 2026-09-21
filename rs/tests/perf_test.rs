// Copyright (c) 2026 Richard Rodger and contributors, MIT License
//
// Parse cost stays linear in input size.
//
// A grammar with a lookahead validator that re-scans from the start on
// every dispatch is quadratic, and the symptom is invisible on the
// fixtures and fatal on a real translation unit. The dispatch this port
// uses walks ahead with `fetch_deep`, whose cost is bounded per call,
// so doubling the input should roughly double the time.
//
// TIMING IS NOISY, especially on a shared runner, so this measures a
// RATIO with generous headroom rather than an absolute. The point is to
// catch a change of shape, not to police milliseconds.

use std::time::Instant;

/// A translation unit of `count` declarations, each one a shape the
/// dispatch validator has to look ahead through.
fn unit(count: usize) -> String {
    let mut out = String::new();
    for index in 0..count {
        out.push_str(&format!("static const int v{index} = {index};\n"));
        out.push_str(&format!("int f{index}(int a, char *b);\n"));
        out.push_str(&format!("struct s{index} {{ int x; char y; }};\n"));
    }
    out
}

fn milliseconds(parser: &tabnas::Tabnas, source: &str) -> f64 {
    let start = Instant::now();
    let value = tabnas_c::parse_with(parser, source).expect("a well-formed unit parses");
    // Realizing and rendering are part of the cost a caller pays.
    let _ = value.to_json().to_string();
    start.elapsed().as_secs_f64() * 1000.0
}

#[test]
fn parse_cost_is_linear_in_input_size() {
    let parser = tabnas_c::make();

    // Warm up: the first parse on a thread allocates the arena.
    let _ = milliseconds(&parser, &unit(50));

    let small = unit(250);
    let large = unit(1_000);
    let small_ms = milliseconds(&parser, &small);
    let large_ms = milliseconds(&parser, &large);

    // Four times the input. Linear would be about 4, and quadratic
    // about 16; the bar is 9, which fails a quadratic and survives a
    // slow, contended runner.
    let ratio = large_ms / small_ms.max(0.001);
    assert!(
        ratio < 9.0,
        "parse cost is growing faster than the input: {} bytes took {small_ms:.1} ms and \
         {} bytes took {large_ms:.1} ms, a ratio of {ratio:.1} for 4x the input",
        small.len(),
        large.len()
    );
}

/// The same for a function body, which takes the other of the two
/// declaration paths.
#[test]
fn statement_cost_is_linear_in_input_size() {
    let parser = tabnas_c::make();
    let body = |count: usize| {
        let mut out = String::from("void f(void) {\n");
        for index in 0..count {
            out.push_str(&format!("  a{index} = b{index};\n"));
            out.push_str(&format!("  if (c{index}) {{ d{index}(); }}\n"));
        }
        out.push_str("}\n");
        out
    };

    let _ = milliseconds(&parser, &body(50));
    let small_ms = milliseconds(&parser, &body(250));
    let large_ms = milliseconds(&parser, &body(1_000));

    let ratio = large_ms / small_ms.max(0.001);
    assert!(
        ratio < 9.0,
        "statement cost is growing faster than the input: {small_ms:.1} ms then \
         {large_ms:.1} ms, a ratio of {ratio:.1} for 4x the input"
    );
}
