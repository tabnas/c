/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

//! The post-processing pass that turns the flat token list the
//! external-declaration chomp captured into a structured tree.
//!
//! Recursive descent over a token stream that hides trivia from the
//! grammar-level decisions but emits trivia tokens in source order as
//! siblings of the next real token. Each `parse_*` returns a node, or
//! `None`, and advances the stream; the caller wires it into a parent.
//!
//! Port of `ts/src/structure.ts`.

use crate::cst::{self, Item, Span};
use crate::legacy_expr::{consume_balanced, parse_expression};

const PRESERVED_TRIVIA: &[&str] = &[
    "TRIVIA_LINE_COMMENT",
    "TRIVIA_BLOCK_COMMENT",
    "TRIVIA_LINE_CONT",
];

const STORAGE_CLASS: &[&str] = &[
    "KW_TYPEDEF",
    "KW_EXTERN",
    "KW_STATIC",
    "KW_AUTO",
    "KW_REGISTER",
    "KW__THREAD_LOCAL",
    "KW_THREAD_LOCAL",
    "KW_CONSTEXPR",
    "KW___THREAD",
];

const TYPE_QUALIFIER: &[&str] = &[
    "KW_CONST",
    "KW_VOLATILE",
    "KW_RESTRICT",
    "KW__ATOMIC",
    "KW___CONST__",
    "KW___CONST",
    "KW___VOLATILE__",
    "KW___VOLATILE",
    "KW___RESTRICT__",
    "KW___RESTRICT",
];

const FUNCTION_SPECIFIER: &[&str] = &["KW_INLINE", "KW___INLINE__", "KW___INLINE", "KW__NORETURN"];

const SIMPLE_TYPE_SPEC: &[&str] = &[
    "KW_VOID",
    "KW_CHAR",
    "KW_SHORT",
    "KW_INT",
    "KW_LONG",
    "KW_FLOAT",
    "KW_DOUBLE",
    "KW_SIGNED",
    "KW_UNSIGNED",
    "KW_BOOL",
    "KW__BOOL",
    "KW__COMPLEX",
    "KW__IMAGINARY",
    "KW___SIGNED__",
    "KW___SIGNED",
    "KW___INT8",
    "KW___INT16",
    "KW___INT32",
    "KW___INT64",
];

const ATTRIBUTE_OPENERS: &[&str] = &["KW___ATTRIBUTE__", "KW___ATTRIBUTE", "KW___DECLSPEC"];

fn is_id_like(name: &str) -> bool {
    name == "ID" || name == "MACRO_NAME"
}

fn is_specifier_start(name: &str) -> bool {
    STORAGE_CLASS.contains(&name)
        || TYPE_QUALIFIER.contains(&name)
        || FUNCTION_SPECIFIER.contains(&name)
        || SIMPLE_TYPE_SPEC.contains(&name)
        || ATTRIBUTE_OPENERS.contains(&name)
        || matches!(
            name,
            "KW_STRUCT"
                | "KW_UNION"
                | "KW_ENUM"
                | "KW_TYPEOF"
                | "KW_TYPEOF_UNQUAL"
                | "KW___TYPEOF__"
                | "KW___TYPEOF"
                | "KW__BITINT"
                | "KW_ALIGNAS"
                | "KW__ALIGNAS"
                | "KW___EXTENSION__"
                | "TYPEDEF_NAME"
        )
}

fn span_of_token(token: usize) -> Span {
    cst::token_data(token)
        .map(|data| data.span)
        .unwrap_or_else(Span::zero)
}

/// One token taken from the stream, with the trivia that preceded it.
pub struct Taken {
    pub trivia: Vec<usize>,
    pub token: usize,
}

/// The token stream the structurer walks: trivia is invisible to the
/// grammar decisions but is re-emitted in source order.
pub struct TokenStream {
    tokens: Vec<usize>,
    index: usize,
}

impl TokenStream {
    pub fn new(tokens: Vec<usize>) -> Self {
        TokenStream { tokens, index: 0 }
    }

    /// The next real token at `offset`, trivia skipped.
    pub fn peek(&self, offset: usize) -> Option<usize> {
        let mut index = self.index;
        let mut seen = 0;
        while index < self.tokens.len() {
            let token = self.tokens[index];
            if PRESERVED_TRIVIA.contains(&cst::token_name(token).as_str()) {
                index += 1;
                continue;
            }
            if seen == offset {
                return Some(token);
            }
            seen += 1;
            index += 1;
        }
        None
    }

    pub fn peek_name(&self, offset: usize) -> String {
        self.peek(offset).map(cst::token_name).unwrap_or_default()
    }

    pub fn done(&self) -> bool {
        self.peek(0).is_none()
    }

    /// Consume the next real token together with the trivia ahead of
    /// it.
    pub fn take(&mut self) -> Option<Taken> {
        let mut trivia = Vec::new();
        while self.index < self.tokens.len() {
            let token = self.tokens[self.index];
            if PRESERVED_TRIVIA.contains(&cst::token_name(token).as_str()) {
                trivia.push(token);
                self.index += 1;
                continue;
            }
            self.index += 1;
            return Some(Taken { trivia, token });
        }
        None
    }

    /// Push the trivia and the token just taken onto a node.
    pub fn take_into(&mut self, node: usize) -> Option<usize> {
        let taken = self.take()?;
        for token in taken.trivia {
            cst::push_child(node, Item::Token(token));
        }
        cst::push_child(node, Item::Token(taken.token));
        Some(taken.token)
    }

    pub fn mark(&self) -> usize {
        self.index
    }

    pub fn restore(&mut self, mark: usize) {
        self.index = mark;
    }
}

// ---------------------------------------------------------------------
// Specifiers
// ---------------------------------------------------------------------

pub fn parse_declaration_specifiers(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let c23_head = is_c23_attribute_open(stream);
    if !is_specifier_start(&cst::token_name(start)) && !c23_head {
        return None;
    }
    let node = cst::new_node("declaration_specifiers", Some(span_of_token(start)));

    // The legal sequence permits ONE typedef name, after which a
    // further identifier belongs to the declarator.
    let mut saw_typedef_name = false;

    loop {
        let Some(_) = stream.peek(0) else {
            break;
        };
        let name = stream.peek_name(0);

        if name == "TYPEDEF_NAME" {
            if saw_typedef_name {
                break;
            }
            saw_typedef_name = true;
            stream.take_into(node);
            continue;
        }
        if STORAGE_CLASS.contains(&name.as_str())
            || TYPE_QUALIFIER.contains(&name.as_str())
            || FUNCTION_SPECIFIER.contains(&name.as_str())
            || SIMPLE_TYPE_SPEC.contains(&name.as_str())
            || matches!(
                name.as_str(),
                "KW___EXTENSION__"
                    | "KW_TYPEOF"
                    | "KW_TYPEOF_UNQUAL"
                    | "KW___TYPEOF__"
                    | "KW___TYPEOF"
                    | "KW__BITINT"
                    | "KW_ALIGNAS"
                    | "KW__ALIGNAS"
            )
        {
            // `typeof`, `_BitInt` and `alignas` take a parenthesised
            // argument, which folds into the specifier node.
            stream.take_into(node);
            if matches!(
                name.as_str(),
                "KW_TYPEOF"
                    | "KW_TYPEOF_UNQUAL"
                    | "KW___TYPEOF__"
                    | "KW___TYPEOF"
                    | "KW__BITINT"
                    | "KW_ALIGNAS"
                    | "KW__ALIGNAS"
            ) && stream.peek_name(0) == "PUNC_LPAREN"
            {
                consume_balanced(stream, node, "PUNC_LPAREN", "PUNC_RPAREN");
            }
            continue;
        }
        if ATTRIBUTE_OPENERS.contains(&name.as_str()) {
            match parse_attribute_spec(stream) {
                Some(attribute) => cst::push_child(node, Item::Node(attribute)),
                None => {
                    stream.take_into(node);
                }
            }
            continue;
        }
        if is_c23_attribute_open(stream) {
            match parse_c23_attribute_spec(stream) {
                Some(attribute) => cst::push_child(node, Item::Node(attribute)),
                None => {
                    stream.take_into(node);
                }
            }
            continue;
        }
        if name == "KW_STRUCT" || name == "KW_UNION" {
            if let Some(spec) = parse_struct_or_union_spec(stream) {
                cst::push_child(node, Item::Node(spec));
            }
            continue;
        }
        if name == "KW_ENUM" {
            if let Some(spec) = parse_enum_spec(stream) {
                cst::push_child(node, Item::Node(spec));
            }
            continue;
        }
        break;
    }

    if cst::child_count(node) == 0 {
        return None;
    }
    Some(node)
}

/// True when the head of the stream is the C23 `[[` opener: two
/// bracket tokens adjacent in the source.
fn is_c23_attribute_open(stream: &TokenStream) -> bool {
    adjacent_pair(stream, "PUNC_LBRACKET")
}

/// True when the head of the stream is the C23 `]]` closer.
fn is_c23_attribute_close(stream: &TokenStream) -> bool {
    adjacent_pair(stream, "PUNC_RBRACKET")
}

fn adjacent_pair(stream: &TokenStream, name: &str) -> bool {
    let (Some(first), Some(second)) = (stream.peek(0), stream.peek(1)) else {
        return false;
    };
    if cst::token_name(first) != name || cst::token_name(second) != name {
        return false;
    }
    let (Some(left), Some(right)) = (cst::token_data(first), cst::token_data(second)) else {
        return false;
    };
    left.span.end == right.span.start
}

pub fn parse_c23_attribute_spec(stream: &mut TokenStream) -> Option<usize> {
    if !is_c23_attribute_open(stream) {
        return None;
    }
    let start = stream.peek(0)?;
    let node = cst::new_node("attribute_spec", Some(span_of_token(start)));
    cst::set_extra(node, "attributeForm", Item::str("c23"));
    let mut items: Vec<Item> = Vec::new();
    stream.take_into(node);
    stream.take_into(node);

    while !stream.done() {
        if is_c23_attribute_close(stream) {
            stream.take_into(node);
            stream.take_into(node);
            break;
        }
        if stream.peek_name(0) == "PUNC_COMMA" {
            stream.take_into(node);
            continue;
        }
        match parse_attribute_item(stream) {
            Some(item) => {
                cst::push_child(node, Item::Node(item));
                items.push(Item::Node(item));
            }
            None => {
                stream.take_into(node);
            }
        }
    }
    cst::set_extra(node, "items", Item::List(items));
    Some(node)
}

pub fn parse_any_attribute_spec(stream: &mut TokenStream) -> Option<usize> {
    let head = stream.peek(0)?;
    if ATTRIBUTE_OPENERS.contains(&cst::token_name(head).as_str()) {
        return parse_attribute_spec(stream);
    }
    if is_c23_attribute_open(stream) {
        return parse_c23_attribute_spec(stream);
    }
    None
}

pub fn parse_attribute_spec(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    if !ATTRIBUTE_OPENERS.contains(&cst::token_name(start).as_str()) {
        return None;
    }
    let node = cst::new_node("attribute_spec", Some(span_of_token(start)));
    let source = cst::token_src(start);
    let form = if source.starts_with("__attribute") {
        "gcc"
    } else if source == "__declspec" {
        "msvc"
    } else {
        "unknown"
    };
    cst::set_extra(node, "attributeForm", Item::str(form));
    stream.take_into(node);

    // GCC doubles the parentheses; MSVC uses one.
    if stream.peek_name(0) != "PUNC_LPAREN" {
        return Some(node);
    }
    stream.take_into(node);

    let mut needs_outer_close = false;
    if form == "gcc" && stream.peek_name(0) == "PUNC_LPAREN" {
        stream.take_into(node);
        needs_outer_close = true;
    }

    let mut items: Vec<Item> = Vec::new();
    while !stream.done() && stream.peek_name(0) != "PUNC_RPAREN" {
        if stream.peek_name(0) == "PUNC_COMMA" {
            stream.take_into(node);
            continue;
        }
        match parse_attribute_item(stream) {
            Some(item) => {
                cst::push_child(node, Item::Node(item));
                items.push(Item::Node(item));
            }
            None => {
                // Defensive, so an unrecognised token cannot loop.
                stream.take_into(node);
            }
        }
    }
    cst::set_extra(node, "items", Item::List(items));

    if stream.peek_name(0) == "PUNC_RPAREN" {
        stream.take_into(node);
    }
    if needs_outer_close && stream.peek_name(0) == "PUNC_RPAREN" {
        stream.take_into(node);
    }
    Some(node)
}

fn attribute_name_ok(name: &str) -> bool {
    matches!(name, "ID" | "TYPEDEF_NAME" | "MACRO_NAME") || name.starts_with("KW_")
}

fn parse_attribute_item(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    if !attribute_name_ok(&cst::token_name(start)) {
        return None;
    }
    let node = cst::new_node("attribute_item", Some(span_of_token(start)));
    let taken = stream.take()?;
    for token in taken.trivia {
        cst::push_child(node, Item::Token(token));
    }
    cst::push_child(node, Item::Token(taken.token));
    cst::set_extra(
        node,
        "attributeName",
        Item::str(cst::token_src(taken.token)),
    );

    // The C23 namespaced form, `prefix :: name`.
    if stream.peek_name(0) == "PUNC_COLON" && stream.peek_name(1) == "PUNC_COLON" {
        stream.take_into(node);
        stream.take_into(node);
        if attribute_name_ok(&stream.peek_name(0)) {
            if let Some(taken) = stream.take() {
                for token in taken.trivia {
                    cst::push_child(node, Item::Token(token));
                }
                cst::push_child(node, Item::Token(taken.token));
                if let Some(previous) = cst::extra_of(node, "attributeName") {
                    cst::set_extra(node, "attributePrefix", previous);
                }
                cst::set_extra(
                    node,
                    "attributeName",
                    Item::str(cst::token_src(taken.token)),
                );
            }
        }
    }

    // The optional argument list.
    if stream.peek_name(0) == "PUNC_LPAREN" {
        let start = stream.peek(0)?;
        let args = cst::new_node("attribute_argument_list", Some(span_of_token(start)));
        stream.take_into(args);
        while !stream.done() && stream.peek_name(0) != "PUNC_RPAREN" {
            match parse_expression(stream, &["PUNC_COMMA", "PUNC_RPAREN"]) {
                Some(argument) => cst::push_child(args, Item::Node(argument)),
                None => {
                    stream.take_into(args);
                }
            }
            if stream.peek_name(0) == "PUNC_COMMA" {
                stream.take_into(args);
            }
        }
        if stream.peek_name(0) == "PUNC_RPAREN" {
            stream.take_into(args);
        }
        cst::push_child(node, Item::Node(args));
        cst::set_extra(node, "argumentList", Item::Node(args));
    }

    Some(node)
}

pub fn parse_struct_or_union_spec(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let head = cst::token_name(start);
    if head != "KW_STRUCT" && head != "KW_UNION" {
        return None;
    }
    let kind = if head == "KW_STRUCT" {
        "struct_specifier"
    } else {
        "union_specifier"
    };
    let node = cst::new_node(kind, Some(span_of_token(start)));
    stream.take_into(node);

    while stream
        .peek(0)
        .is_some_and(|token| ATTRIBUTE_OPENERS.contains(&cst::token_name(token).as_str()))
    {
        match parse_attribute_spec(stream) {
            Some(attribute) => cst::push_child(node, Item::Node(attribute)),
            None => break,
        }
    }

    let next = stream.peek_name(0);
    if is_id_like(&next) || next == "TYPEDEF_NAME" {
        if let Some(taken) = stream.take() {
            for token in taken.trivia {
                cst::push_child(node, Item::Token(token));
            }
            cst::push_child(node, Item::Token(taken.token));
            cst::set_extra(node, "tagName", Item::str(cst::token_src(taken.token)));
        }
    }

    if stream.peek_name(0) == "PUNC_LBRACE" {
        let start = stream.peek(0)?;
        let body = cst::new_node("member_decl_list", Some(span_of_token(start)));
        stream.take_into(body);
        while !stream.done() && stream.peek_name(0) != "PUNC_RBRACE" {
            match parse_struct_declaration(stream) {
                Some(member) => cst::push_child(body, Item::Node(member)),
                None => {
                    stream.take_into(body);
                }
            }
        }
        if stream.peek_name(0) == "PUNC_RBRACE" {
            stream.take_into(body);
        }
        cst::push_child(node, Item::Node(body));
    }

    Some(node)
}

pub fn parse_struct_declaration(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let head = cst::token_name(start);

    if head == "KW_STATIC_ASSERT" || head == "KW__STATIC_ASSERT" {
        return Some(parse_static_assert_declaration(stream));
    }

    if head == "PUNC_SEMI" {
        let empty = cst::new_node("struct_declaration", Some(span_of_token(start)));
        stream.take_into(empty);
        return Some(empty);
    }

    let node = cst::new_node("struct_declaration", Some(span_of_token(start)));
    // The specifier qualifier list has the same shape as declaration
    // specifiers; a storage class inside a struct is a semantic error,
    // not a parse error.
    if let Some(specs) = parse_declaration_specifiers(stream) {
        cst::set_kind(specs, "specifier_qualifier_list");
        cst::push_child(node, Item::Node(specs));
    }

    if stream.peek_name(0) != "PUNC_SEMI" && !stream.done() {
        if let Some(list) = parse_struct_declarator_list(stream) {
            cst::push_child(node, Item::Node(list));
        }
    }

    if stream.peek_name(0) == "PUNC_SEMI" {
        stream.take_into(node);
    }
    Some(node)
}

pub fn parse_struct_declarator_list(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("struct_declarator_list", Some(span_of_token(start)));
    let first = parse_struct_declarator(stream)?;
    cst::push_child(node, Item::Node(first));
    while stream.peek_name(0) == "PUNC_COMMA" {
        stream.take_into(node);
        match parse_struct_declarator(stream) {
            Some(next) => cst::push_child(node, Item::Node(next)),
            None => break,
        }
    }
    Some(node)
}

pub fn parse_struct_declarator(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("struct_declarator", Some(span_of_token(start)));

    if stream.peek_name(0) != "PUNC_COLON" {
        if let Some(declarator) = parse_declarator(stream, false) {
            cst::push_child(node, Item::Node(declarator));
            if let Some(declared) = cst::extra_of(declarator, "declaredName") {
                cst::set_extra(node, "declaredName", declared);
            }
        }
    }

    if stream.peek_name(0) == "PUNC_COLON" {
        let start = stream.peek(0)?;
        let width = cst::new_node("bitfield_width", Some(span_of_token(start)));
        stream.take_into(width);
        // The constant expression is opaque up to a top-level `,` or
        // `;`.
        let mut paren = 0i32;
        let mut bracket = 0i32;
        while !stream.done() {
            let name = stream.peek_name(0);
            if name == "PUNC_LPAREN" {
                paren += 1;
                stream.take_into(width);
                continue;
            }
            if name == "PUNC_RPAREN" {
                if paren == 0 {
                    break;
                }
                paren -= 1;
                stream.take_into(width);
                continue;
            }
            if name == "PUNC_LBRACKET" {
                bracket += 1;
                stream.take_into(width);
                continue;
            }
            if name == "PUNC_RBRACKET" {
                if bracket == 0 {
                    break;
                }
                bracket -= 1;
                stream.take_into(width);
                continue;
            }
            if paren == 0 && bracket == 0 && matches!(name.as_str(), "PUNC_COMMA" | "PUNC_SEMI") {
                break;
            }
            stream.take_into(width);
        }
        cst::push_child(node, Item::Node(width));
    }

    while stream
        .peek(0)
        .is_some_and(|token| ATTRIBUTE_OPENERS.contains(&cst::token_name(token).as_str()))
    {
        match parse_attribute_spec(stream) {
            Some(attribute) => cst::push_child(node, Item::Node(attribute)),
            None => break,
        }
    }

    if cst::child_count(node) > 0 {
        Some(node)
    } else {
        None
    }
}

pub fn parse_enum_spec(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    if cst::token_name(start) != "KW_ENUM" {
        return None;
    }
    let node = cst::new_node("enum_specifier", Some(span_of_token(start)));
    stream.take_into(node);

    while stream
        .peek(0)
        .is_some_and(|token| ATTRIBUTE_OPENERS.contains(&cst::token_name(token).as_str()))
    {
        match parse_attribute_spec(stream) {
            Some(attribute) => cst::push_child(node, Item::Node(attribute)),
            None => break,
        }
    }

    let next = stream.peek_name(0);
    if is_id_like(&next) || next == "TYPEDEF_NAME" {
        if let Some(taken) = stream.take() {
            for token in taken.trivia {
                cst::push_child(node, Item::Token(token));
            }
            cst::push_child(node, Item::Token(taken.token));
            cst::set_extra(node, "tagName", Item::str(cst::token_src(taken.token)));
        }
    }

    // C23: the optional `: type-specifier` of a fixed underlying type.
    if stream.peek_name(0) == "PUNC_COLON" {
        stream.take_into(node);
        if let Some(specs) = parse_declaration_specifiers(stream) {
            cst::push_child(node, Item::Node(specs));
        }
    }

    if stream.peek_name(0) == "PUNC_LBRACE" {
        let start = stream.peek(0)?;
        let body = cst::new_node("enumerator_list", Some(span_of_token(start)));
        stream.take_into(body);
        while !stream.done() && stream.peek_name(0) != "PUNC_RBRACE" {
            match parse_enumerator(stream) {
                Some(enumerator) => cst::push_child(body, Item::Node(enumerator)),
                None => {
                    stream.take_into(body);
                }
            }
            if stream.peek_name(0) == "PUNC_COMMA" {
                stream.take_into(body);
            }
        }
        if stream.peek_name(0) == "PUNC_RBRACE" {
            stream.take_into(body);
        }
        cst::push_child(node, Item::Node(body));
    }

    Some(node)
}

pub fn parse_enumerator(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let name = cst::token_name(start);
    if !matches!(name.as_str(), "ID" | "TYPEDEF_NAME" | "MACRO_NAME") {
        return None;
    }
    let node = cst::new_node("enumerator", Some(span_of_token(start)));
    let taken = stream.take()?;
    for token in taken.trivia {
        cst::push_child(node, Item::Token(token));
    }
    cst::push_child(node, Item::Token(taken.token));
    cst::set_extra(node, "declaredName", Item::str(cst::token_src(taken.token)));

    while let Some(attribute) = parse_any_attribute_spec(stream) {
        cst::push_child(node, Item::Node(attribute));
    }

    if stream.peek_name(0) == "PUNC_ASSIGN" {
        stream.take_into(node);
        let span = stream
            .peek(0)
            .map(span_of_token)
            .unwrap_or_else(|| span_of_token(start));
        let init = cst::new_node("initializer", Some(span));
        let mut paren = 0i32;
        let mut bracket = 0i32;
        while !stream.done() {
            let name = stream.peek_name(0);
            if name == "PUNC_LPAREN" {
                paren += 1;
                stream.take_into(init);
                continue;
            }
            if name == "PUNC_RPAREN" {
                if paren == 0 {
                    break;
                }
                paren -= 1;
                stream.take_into(init);
                continue;
            }
            if name == "PUNC_LBRACKET" {
                bracket += 1;
                stream.take_into(init);
                continue;
            }
            if name == "PUNC_RBRACKET" {
                if bracket == 0 {
                    break;
                }
                bracket -= 1;
                stream.take_into(init);
                continue;
            }
            if paren == 0 && bracket == 0 && matches!(name.as_str(), "PUNC_COMMA" | "PUNC_RBRACE") {
                break;
            }
            stream.take_into(init);
        }
        cst::push_child(node, Item::Node(init));
    }
    Some(node)
}

// ---------------------------------------------------------------------
// Declarators
// ---------------------------------------------------------------------

pub fn parse_declarator(stream: &mut TokenStream, abstract_form: bool) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node(
        if abstract_form {
            "abstract_declarator"
        } else {
            "declarator"
        },
        Some(span_of_token(start)),
    );

    // The pointer prefix: `*` followed by qualifiers, repeated.
    while stream.peek_name(0) == "PUNC_STAR" {
        let Some(star) = stream.peek(0) else {
            break;
        };
        let pointer = cst::new_node("pointer", Some(span_of_token(star)));
        stream.take_into(pointer);
        loop {
            let name = stream.peek_name(0);
            if TYPE_QUALIFIER.contains(&name.as_str())
                || matches!(
                    name.as_str(),
                    "KW___PTR32" | "KW___PTR64" | "KW___UNALIGNED"
                )
            {
                stream.take_into(pointer);
                continue;
            }
            if ATTRIBUTE_OPENERS.contains(&name.as_str()) {
                match parse_attribute_spec(stream) {
                    Some(attribute) => cst::push_child(pointer, Item::Node(attribute)),
                    None => break,
                }
                continue;
            }
            break;
        }
        cst::push_child(node, Item::Node(pointer));
    }

    let Some(direct) = parse_direct_declarator(stream, abstract_form) else {
        if cst::child_count(node) > 0 {
            return Some(node);
        }
        return None;
    };
    cst::push_child(node, Item::Node(direct));
    if let Some(declared) = cst::extra_of(direct, "declaredName") {
        cst::set_extra(node, "declaredName", declared);
    }
    Some(node)
}

fn parse_direct_declarator(stream: &mut TokenStream, abstract_form: bool) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node(
        if abstract_form {
            "direct_abstract_declarator"
        } else {
            "direct_declarator"
        },
        Some(span_of_token(start)),
    );

    let head = stream.peek_name(0);
    if is_id_like(&head) {
        if let Some(taken) = stream.take() {
            for token in taken.trivia {
                cst::push_child(node, Item::Token(token));
            }
            cst::push_child(node, Item::Token(taken.token));
            cst::set_extra(node, "declaredName", Item::str(cst::token_src(taken.token)));
        }
    } else if head == "PUNC_LPAREN" {
        // Either a parenthesised subdeclarator or the parameter list of
        // an abstract declarator. The first token inside decides.
        let mark = stream.mark();
        stream.take_into(node);
        let inner = stream.peek_name(0);
        if matches!(inner.as_str(), "PUNC_STAR" | "PUNC_LPAREN")
            || is_id_like(&inner)
            || ATTRIBUTE_OPENERS.contains(&inner.as_str())
        {
            if let Some(sub) = parse_declarator(stream, abstract_form) {
                cst::push_child(node, Item::Node(sub));
                if let Some(declared) = cst::extra_of(sub, "declaredName") {
                    cst::set_extra(node, "declaredName", declared);
                }
            }
            if stream.peek_name(0) == "PUNC_RPAREN" {
                stream.take_into(node);
            }
        } else {
            // A parameter list after all: rewind and let the postfix
            // loop take it. The canonical code leaves the `(` it
            // already pushed on the node, so that token appears once
            // here and again inside the function postfix; that is the
            // shape the fixtures pin.
            stream.restore(mark);
        }
    } else if !abstract_form {
        return None;
    }

    // The postfixes.
    while !stream.done() {
        let name = stream.peek_name(0);
        if name == "PUNC_LBRACKET" {
            let Some(start) = stream.peek(0) else {
                break;
            };
            let array = cst::new_node("array_postfix", Some(span_of_token(start)));
            consume_balanced(stream, array, "PUNC_LBRACKET", "PUNC_RBRACKET");
            cst::push_child(node, Item::Node(array));
            continue;
        }
        if name == "PUNC_LPAREN" {
            match parse_function_postfix(stream) {
                Some(function) => cst::push_child(node, Item::Node(function)),
                None => break,
            }
            continue;
        }
        break;
    }

    if cst::child_count(node) == 0 && !abstract_form {
        return None;
    }
    Some(node)
}

pub fn parse_function_postfix(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    if cst::token_name(start) != "PUNC_LPAREN" {
        return None;
    }
    let node = cst::new_node("function_postfix", Some(span_of_token(start)));
    stream.take_into(node);

    // The empty list of an unspecified prototype.
    if stream.peek_name(0) == "PUNC_RPAREN" {
        stream.take_into(node);
        return Some(node);
    }

    // The prototype with an explicit `void` and no parameters.
    if stream.peek_name(0) == "KW_VOID" && stream.peek_name(1) == "PUNC_RPAREN" {
        let start = stream.peek(0)?;
        let list = cst::new_node("parameter_type_list", Some(span_of_token(start)));
        let parameter = cst::new_node("parameter_declaration", Some(span_of_token(start)));
        let specs = cst::new_node("declaration_specifiers", Some(span_of_token(start)));
        cst::push_child(parameter, Item::Node(specs));
        stream.take_into(specs);
        cst::push_child(list, Item::Node(parameter));
        cst::push_child(node, Item::Node(list));
        stream.take_into(node);
        return Some(node);
    }

    // The K&R identifier list.
    if looks_like_kr_identifier_list(stream) {
        let start = stream.peek(0)?;
        let list = cst::new_node("identifier_list", Some(span_of_token(start)));
        while !stream.done() && stream.peek_name(0) != "PUNC_RPAREN" {
            stream.take_into(list);
        }
        cst::push_child(node, Item::Node(list));
        if stream.peek_name(0) == "PUNC_RPAREN" {
            stream.take_into(node);
        }
        return Some(node);
    }

    let start = stream.peek(0)?;
    let list = cst::new_node("parameter_type_list", Some(span_of_token(start)));
    while !stream.done() && stream.peek_name(0) != "PUNC_RPAREN" {
        if stream.peek_name(0) == "PUNC_ELLIPSIS" {
            let Some(start) = stream.peek(0) else {
                break;
            };
            let variadic = cst::new_node("parameter_variadic", Some(span_of_token(start)));
            stream.take_into(variadic);
            cst::push_child(list, Item::Node(variadic));
            cst::set_extra(list, "variadic", Item::bool(true));
            break;
        }
        match parse_parameter_declaration(stream) {
            Some(parameter) => cst::push_child(list, Item::Node(parameter)),
            None => {
                stream.take_into(list);
            }
        }
        if stream.peek_name(0) == "PUNC_COMMA" {
            stream.take_into(list);
        }
    }
    cst::push_child(node, Item::Node(list));
    if stream.peek_name(0) == "PUNC_RPAREN" {
        stream.take_into(node);
    }
    Some(node)
}

fn looks_like_kr_identifier_list(stream: &TokenStream) -> bool {
    let mut index = 0usize;
    let mut expect_id = true;
    loop {
        let Some(token) = stream.peek(index) else {
            return false;
        };
        let name = cst::token_name(token);
        if expect_id {
            if !is_id_like(&name) {
                return false;
            }
            expect_id = false;
        } else if name == "PUNC_RPAREN" {
            return index > 0;
        } else if name == "PUNC_COMMA" {
            expect_id = true;
        } else {
            return false;
        }
        index += 1;
        if index > 256 {
            return false;
        }
    }
}

pub fn parse_parameter_declaration(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("parameter_declaration", Some(span_of_token(start)));
    if let Some(specs) = parse_declaration_specifiers(stream) {
        cst::push_child(node, Item::Node(specs));
    }

    let next = stream.peek_name(0);
    if next.is_empty() || next == "PUNC_COMMA" || next == "PUNC_RPAREN" {
        return if cst::child_count(node) > 0 {
            Some(node)
        } else {
            None
        };
    }

    let mark = stream.mark();
    let mut declarator = parse_declarator(stream, false);
    let named = declarator.is_some_and(|declarator| {
        cst::has_extra(declarator, "declaredName") || find_declared(declarator)
    });
    if !named {
        stream.restore(mark);
        declarator = parse_declarator(stream, true);
    }
    if let Some(declarator) = declarator {
        cst::push_child(node, Item::Node(declarator));
        if let Some(declared) = cst::extra_of(declarator, "declaredName") {
            cst::set_extra(node, "declaredName", declared);
        }
    }
    if cst::child_count(node) > 0 {
        Some(node)
    } else {
        None
    }
}

/// True when a declarator, however deep, carries a concrete name.
fn find_declared(node: usize) -> bool {
    if cst::has_extra(node, "declaredName") {
        return true;
    }
    cst::children_of(node)
        .iter()
        .filter_map(Item::as_node)
        .any(find_declared)
}

// ---------------------------------------------------------------------
// Init declarators
// ---------------------------------------------------------------------

pub fn parse_init_declarator_list(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("init_declarator_list", Some(span_of_token(start)));
    let first = parse_init_declarator(stream)?;
    cst::push_child(node, Item::Node(first));
    while stream.peek_name(0) == "PUNC_COMMA" {
        stream.take_into(node);
        match parse_init_declarator(stream) {
            Some(next) => cst::push_child(node, Item::Node(next)),
            None => break,
        }
    }
    Some(node)
}

pub fn parse_init_declarator(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let declarator = parse_declarator(stream, false)?;
    let node = cst::new_node("init_declarator", Some(span_of_token(start)));
    cst::push_child(node, Item::Node(declarator));
    if let Some(declared) = cst::extra_of(declarator, "declaredName") {
        cst::set_extra(node, "declaredName", declared);
    }

    loop {
        let name = stream.peek_name(0);
        if name.is_empty() {
            break;
        }
        if matches!(name.as_str(), "KW___ASM__" | "KW___ASM" | "KW_ASM") {
            let Some(start) = stream.peek(0) else {
                break;
            };
            let label = cst::new_node("asm_label", Some(span_of_token(start)));
            stream.take_into(label);
            if stream.peek_name(0) == "PUNC_LPAREN" {
                consume_balanced(stream, label, "PUNC_LPAREN", "PUNC_RPAREN");
            }
            cst::push_child(node, Item::Node(label));
            continue;
        }
        if ATTRIBUTE_OPENERS.contains(&name.as_str()) {
            match parse_attribute_spec(stream) {
                Some(attribute) => cst::push_child(node, Item::Node(attribute)),
                None => break,
            }
            continue;
        }
        break;
    }

    if stream.peek_name(0) == "PUNC_ASSIGN" {
        stream.take_into(node);
        if let Some(init) = parse_initializer(stream) {
            cst::push_child(node, Item::Node(init));
        }
    }
    Some(node)
}

// ---------------------------------------------------------------------
// Initializers
// ---------------------------------------------------------------------

pub fn parse_initializer(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("initializer", Some(span_of_token(start)));
    if stream.peek_name(0) == "PUNC_LBRACE" {
        if let Some(list) = parse_initializer_list(stream) {
            cst::push_child(node, Item::Node(list));
        }
        return Some(node);
    }
    if let Some(expression) = parse_expression(stream, &["PUNC_COMMA", "PUNC_SEMI", "PUNC_RBRACE"])
    {
        cst::push_child(node, Item::Node(expression));
    }
    Some(node)
}

pub fn parse_initializer_list(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    if cst::token_name(start) != "PUNC_LBRACE" {
        return None;
    }
    let node = cst::new_node("initializer_list", Some(span_of_token(start)));
    stream.take_into(node);
    while !stream.done() && stream.peek_name(0) != "PUNC_RBRACE" {
        match parse_initializer_item(stream) {
            Some(item) => cst::push_child(node, Item::Node(item)),
            None => {
                stream.take_into(node);
            }
        }
        if stream.peek_name(0) == "PUNC_COMMA" {
            stream.take_into(node);
        }
    }
    if stream.peek_name(0) == "PUNC_RBRACE" {
        stream.take_into(node);
    }
    Some(node)
}

fn parse_initializer_item(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("initializer_item", Some(span_of_token(start)));

    if matches!(stream.peek_name(0).as_str(), "PUNC_DOT" | "PUNC_LBRACKET") {
        if let Some(designation) = parse_designation(stream) {
            cst::push_child(node, Item::Node(designation));
            cst::set_extra(node, "designation", Item::Node(designation));
        }
    }

    if stream.peek_name(0) == "PUNC_LBRACE" {
        if let Some(sub) = parse_initializer_list(stream) {
            let init = cst::new_node("initializer", Some(cst::span_of(sub)));
            cst::push_child(init, Item::Node(sub));
            cst::push_child(node, Item::Node(init));
            cst::set_extra(node, "value", Item::Node(init));
        }
    } else if let Some(expression) = parse_expression(stream, &["PUNC_COMMA", "PUNC_RBRACE"]) {
        cst::push_child(node, Item::Node(expression));
        cst::set_extra(node, "value", Item::Node(expression));
    }

    if cst::child_count(node) > 0 {
        Some(node)
    } else {
        None
    }
}

pub fn parse_static_assert_declaration(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "static_assert_declaration",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    stream.take_into(node);
    if stream.peek_name(0) != "PUNC_LPAREN" {
        if stream.peek_name(0) == "PUNC_SEMI" {
            stream.take_into(node);
        }
        return node;
    }
    stream.take_into(node);
    if let Some(condition) = parse_expression(stream, &["PUNC_COMMA", "PUNC_RPAREN"]) {
        cst::push_child(node, Item::Node(condition));
        cst::set_extra(node, "condition", Item::Node(condition));
    }
    if stream.peek_name(0) == "PUNC_COMMA" {
        stream.take_into(node);
        if let Some(message) = parse_expression(stream, &["PUNC_RPAREN"]) {
            cst::push_child(node, Item::Node(message));
            cst::set_extra(node, "message", Item::Node(message));
        }
    }
    if stream.peek_name(0) == "PUNC_RPAREN" {
        stream.take_into(node);
    }
    if stream.peek_name(0) == "PUNC_SEMI" {
        stream.take_into(node);
    }
    node
}

fn parse_designation(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("designation", Some(span_of_token(start)));
    let mut any = false;
    loop {
        let name = stream.peek_name(0);
        if name == "PUNC_DOT" {
            let Some(start) = stream.peek(0) else {
                break;
            };
            let designator = cst::new_node("member_designator", Some(span_of_token(start)));
            stream.take_into(designator);
            if matches!(
                stream.peek_name(0).as_str(),
                "ID" | "TYPEDEF_NAME" | "MACRO_NAME"
            ) {
                if let Some(taken) = stream.take() {
                    for token in taken.trivia {
                        cst::push_child(designator, Item::Token(token));
                    }
                    cst::push_child(designator, Item::Token(taken.token));
                    cst::set_extra(
                        designator,
                        "memberName",
                        Item::str(cst::token_src(taken.token)),
                    );
                }
            }
            cst::push_child(node, Item::Node(designator));
            any = true;
            continue;
        }
        if name == "PUNC_LBRACKET" {
            let Some(start) = stream.peek(0) else {
                break;
            };
            let designator = cst::new_node("index_designator", Some(span_of_token(start)));
            consume_balanced(stream, designator, "PUNC_LBRACKET", "PUNC_RBRACKET");
            cst::push_child(node, Item::Node(designator));
            any = true;
            continue;
        }
        break;
    }
    if !any {
        return None;
    }
    if stream.peek_name(0) == "PUNC_ASSIGN" {
        stream.take_into(node);
    }
    Some(node)
}

// ---------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------

thread_local! {
    /// How many compound statements the structurer is inside.
    ///
    /// The structurer is a recursive-descent parser, and a block nested
    /// N deep costs N frames. The canonical has the same shape and the
    /// same exposure; JavaScript throws when its stack runs out and Rust
    /// ABORTS THE PROCESS, so this port counts. The cap is the same one
    /// `realize` uses, because a source too deep to structure is also
    /// too deep to hand back: see `crate::REALIZE_DEPTH_CAP`.
    static BLOCK_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Run `body` one block deeper, or give up when that is past the cap.
fn one_block_deeper<T>(body: impl FnOnce() -> Option<T>) -> Option<T> {
    let depth = BLOCK_DEPTH.with(|cell| {
        let depth = cell.get() + 1;
        cell.set(depth);
        depth
    });
    let out = if depth >= crate::cst::REALIZE_DEPTH_CAP {
        crate::state::with_state(|state| state.gave_up = true);
        None
    } else {
        body()
    };
    BLOCK_DEPTH.with(|cell| cell.set(cell.get().saturating_sub(1)));
    out
}

pub fn parse_compound_statement(stream: &mut TokenStream) -> Option<usize> {
    one_block_deeper(|| parse_compound_statement_inner(stream))
}

fn parse_compound_statement_inner(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    if cst::token_name(start) != "PUNC_LBRACE" {
        return None;
    }
    let node = cst::new_node("compound_statement", Some(span_of_token(start)));
    stream.take_into(node);
    while !stream.done() && stream.peek_name(0) != "PUNC_RBRACE" {
        match parse_block_item(stream) {
            Some(item) => cst::push_child(node, Item::Node(item)),
            None => {
                stream.take_into(node);
            }
        }
    }
    if stream.peek_name(0) == "PUNC_RBRACE" {
        stream.take_into(node);
    }
    Some(node)
}

pub fn parse_block_item(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let head = cst::token_name(start);

    if head == "PP_HASH" {
        return Some(take_preprocessor_line(stream));
    }

    if is_specifier_start(&head)
        || head == "KW_STATIC_ASSERT"
        || head == "KW__STATIC_ASSERT"
        || is_c23_attribute_open(stream)
    {
        if let Some(declaration) = parse_declaration(stream) {
            return Some(declaration);
        }
    }

    parse_statement(stream)
}

pub fn parse_declaration(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let head = cst::token_name(start);

    if head == "KW_STATIC_ASSERT" || head == "KW__STATIC_ASSERT" {
        return Some(parse_static_assert_declaration(stream));
    }

    let node = cst::new_node("declaration", Some(span_of_token(start)));
    if let Some(specs) = parse_declaration_specifiers(stream) {
        cst::push_child(node, Item::Node(specs));
    }
    if stream.peek_name(0) != "PUNC_SEMI" && !stream.done() {
        if let Some(list) = parse_init_declarator_list(stream) {
            cst::push_child(node, Item::Node(list));
        }
    }
    if stream.peek_name(0) == "PUNC_SEMI" {
        stream.take_into(node);
    }
    if cst::child_count(node) > 0 {
        Some(node)
    } else {
        None
    }
}

pub fn parse_statement(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let head = cst::token_name(start);

    if head == "PUNC_LBRACE" {
        return parse_compound_statement(stream);
    }
    if head == "PUNC_SEMI" {
        let node = cst::new_node("expression_statement", Some(span_of_token(start)));
        stream.take_into(node);
        return Some(node);
    }
    if head == "KW_IF" {
        return Some(parse_if_statement(stream));
    }
    if head == "KW_SWITCH" {
        return Some(parse_paren_body_statement(stream, "switch_statement"));
    }
    if head == "KW_WHILE" {
        return Some(parse_paren_body_statement(stream, "while_statement"));
    }
    if head == "KW_DO" {
        return Some(parse_do_statement(stream));
    }
    if head == "KW_FOR" {
        return Some(parse_for_statement(stream));
    }
    if matches!(
        head.as_str(),
        "KW_GOTO" | "KW_CONTINUE" | "KW_BREAK" | "KW_RETURN"
    ) {
        return Some(parse_jump_statement(stream));
    }
    if head == "KW_CASE" || head == "KW_DEFAULT" {
        return Some(parse_labeled_statement(stream));
    }
    if is_id_like(&head) && stream.peek_name(1) == "PUNC_COLON" {
        return Some(parse_labeled_statement(stream));
    }
    if matches!(head.as_str(), "KW___ASM__" | "KW___ASM" | "KW_ASM") {
        return Some(parse_asm_statement(stream));
    }
    Some(parse_expression_statement(stream))
}

fn take_paren_condition(stream: &mut TokenStream, node: usize) {
    if stream.peek_name(0) != "PUNC_LPAREN" {
        return;
    }
    let Some(start) = stream.peek(0) else {
        return;
    };
    let condition = cst::new_node("paren_condition", Some(span_of_token(start)));
    consume_balanced(stream, condition, "PUNC_LPAREN", "PUNC_RPAREN");
    cst::push_child(node, Item::Node(condition));
}

fn parse_if_statement(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "if_statement",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    stream.take_into(node);
    take_paren_condition(stream, node);
    if let Some(then) = parse_statement(stream) {
        cst::push_child(node, Item::Node(then));
    }
    if stream.peek_name(0) == "KW_ELSE" {
        stream.take_into(node);
        if let Some(alternative) = parse_statement(stream) {
            cst::push_child(node, Item::Node(alternative));
        }
    }
    node
}

/// `switch` and `while` share a shape: keyword, parenthesised
/// condition, body.
fn parse_paren_body_statement(stream: &mut TokenStream, kind: &str) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(kind, start.map(span_of_token).or(Some(Span::zero())));
    stream.take_into(node);
    take_paren_condition(stream, node);
    if let Some(body) = parse_statement(stream) {
        cst::push_child(node, Item::Node(body));
    }
    node
}

fn parse_do_statement(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "do_statement",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    stream.take_into(node);
    if let Some(body) = parse_statement(stream) {
        cst::push_child(node, Item::Node(body));
    }
    if stream.peek_name(0) == "KW_WHILE" {
        stream.take_into(node);
    }
    take_paren_condition(stream, node);
    if stream.peek_name(0) == "PUNC_SEMI" {
        stream.take_into(node);
    }
    node
}

fn parse_for_statement(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let start_span = start.map(span_of_token).unwrap_or_else(Span::zero);
    let node = cst::new_node("for_statement", Some(start_span));
    stream.take_into(node);
    if stream.peek_name(0) == "PUNC_LPAREN" {
        let controls_span = stream.peek(0).map(span_of_token).unwrap_or_else(Span::zero);
        let controls = cst::new_node("for_controls", Some(controls_span));
        stream.take_into(controls);

        let init_span = stream.peek(0).map(span_of_token).unwrap_or(start_span);
        let init = cst::new_node("for_init", Some(init_span));
        if stream.peek_name(0) != "PUNC_SEMI" && !stream.done() {
            let head = stream.peek_name(0);
            if is_specifier_start(&head)
                || head == "KW_STATIC_ASSERT"
                || head == "KW__STATIC_ASSERT"
                || is_c23_attribute_open(stream)
            {
                if let Some(declaration) = parse_declaration(stream) {
                    cst::push_child(init, Item::Node(declaration));
                    cst::set_extra(init, "value", Item::Node(declaration));
                }
                // The declaration's own `;` is part of it, so no other
                // terminator is expected here.
            } else {
                if let Some(expression) = parse_expression(stream, &["PUNC_SEMI"]) {
                    cst::push_child(init, Item::Node(expression));
                    cst::set_extra(init, "value", Item::Node(expression));
                }
                if stream.peek_name(0) == "PUNC_SEMI" {
                    stream.take_into(init);
                }
            }
        } else if stream.peek_name(0) == "PUNC_SEMI" {
            stream.take_into(init);
        }
        cst::push_child(controls, Item::Node(init));
        cst::set_extra(controls, "init", Item::Node(init));

        let cond_span = stream.peek(0).map(span_of_token).unwrap_or(start_span);
        let condition = cst::new_node("for_cond", Some(cond_span));
        if stream.peek_name(0) != "PUNC_SEMI" && stream.peek_name(0) != "PUNC_RPAREN" {
            if let Some(expression) = parse_expression(stream, &["PUNC_SEMI", "PUNC_RPAREN"]) {
                cst::push_child(condition, Item::Node(expression));
                cst::set_extra(condition, "value", Item::Node(expression));
            }
        }
        if stream.peek_name(0) == "PUNC_SEMI" {
            stream.take_into(condition);
        }
        cst::push_child(controls, Item::Node(condition));
        cst::set_extra(controls, "cond", Item::Node(condition));

        let iter_span = stream.peek(0).map(span_of_token).unwrap_or(start_span);
        let iteration = cst::new_node("for_iter", Some(iter_span));
        if stream.peek_name(0) != "PUNC_RPAREN" {
            if let Some(expression) = parse_expression(stream, &["PUNC_RPAREN"]) {
                cst::push_child(iteration, Item::Node(expression));
                cst::set_extra(iteration, "value", Item::Node(expression));
            }
        }
        cst::push_child(controls, Item::Node(iteration));
        cst::set_extra(controls, "iter", Item::Node(iteration));

        if stream.peek_name(0) == "PUNC_RPAREN" {
            stream.take_into(controls);
        }
        cst::push_child(node, Item::Node(controls));
    }
    if let Some(body) = parse_statement(stream) {
        cst::push_child(node, Item::Node(body));
    }
    node
}

fn parse_jump_statement(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "jump_statement",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    if let Some(start) = start {
        cst::set_extra(node, "jumpKind", Item::str(cst::token_src(start)));
    }
    stream.take_into(node);
    if stream.peek_name(0) != "PUNC_SEMI" && !stream.done() {
        if let Some(expression) = parse_expression(stream, &["PUNC_SEMI"]) {
            cst::push_child(node, Item::Node(expression));
        }
    }
    if stream.peek_name(0) == "PUNC_SEMI" {
        stream.take_into(node);
    }
    node
}

fn parse_labeled_statement(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "labeled_statement",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    let head = start.map(cst::token_name).unwrap_or_default();
    if head == "KW_CASE" {
        cst::set_extra(node, "labelKind", Item::str("case"));
        stream.take_into(node);
        let mut paren = 0i32;
        while !stream.done() {
            let name = stream.peek_name(0);
            if name == "PUNC_LPAREN" {
                paren += 1;
                stream.take_into(node);
                continue;
            }
            if name == "PUNC_RPAREN" {
                if paren == 0 {
                    break;
                }
                paren -= 1;
                stream.take_into(node);
                continue;
            }
            if paren == 0 && name == "PUNC_COLON" {
                break;
            }
            stream.take_into(node);
        }
    } else if head == "KW_DEFAULT" {
        cst::set_extra(node, "labelKind", Item::str("default"));
        stream.take_into(node);
    } else {
        cst::set_extra(node, "labelKind", Item::str("label"));
        if let Some(start) = start {
            cst::set_extra(node, "labelName", Item::str(cst::token_src(start)));
        }
        stream.take_into(node);
    }
    if stream.peek_name(0) == "PUNC_COLON" {
        stream.take_into(node);
    }
    if let Some(inner) = parse_statement(stream) {
        cst::push_child(node, Item::Node(inner));
    }
    node
}

fn parse_expression_statement(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "expression_statement",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    if let Some(expression) = parse_expression(stream, &["PUNC_SEMI"]) {
        cst::push_child(node, Item::Node(expression));
    }
    if stream.peek_name(0) == "PUNC_SEMI" {
        stream.take_into(node);
    }
    node
}

// ---------------------------------------------------------------------
// Inline assembly
// ---------------------------------------------------------------------

fn parse_asm_statement(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let start_span = start.map(span_of_token).unwrap_or_else(Span::zero);
    let node = cst::new_node("asm_statement", Some(start_span));
    let mut qualifiers: Vec<Item> = Vec::new();
    stream.take_into(node);
    loop {
        let name = stream.peek_name(0);
        if matches!(
            name.as_str(),
            "KW_VOLATILE"
                | "KW___VOLATILE__"
                | "KW___VOLATILE"
                | "KW_INLINE"
                | "KW___INLINE__"
                | "KW___INLINE"
                | "KW_GOTO"
        ) {
            if let Some(token) = stream.peek(0) {
                qualifiers.push(Item::str(cst::token_src(token)));
            }
            stream.take_into(node);
            continue;
        }
        break;
    }
    cst::set_extra(node, "qualifiers", Item::List(qualifiers));
    if stream.peek_name(0) != "PUNC_LPAREN" {
        if stream.peek_name(0) == "PUNC_SEMI" {
            stream.take_into(node);
        }
        return node;
    }
    stream.take_into(node);

    let template_span = stream.peek(0).map(span_of_token).unwrap_or(start_span);
    let template = cst::new_node("asm_template", Some(template_span));
    if let Some(expression) = parse_expression(stream, &["PUNC_COLON", "PUNC_RPAREN"]) {
        cst::push_child(template, Item::Node(expression));
        cst::set_extra(template, "expression", Item::Node(expression));
    }
    cst::push_child(node, Item::Node(template));
    cst::set_extra(node, "template", Item::Node(template));

    let sections = ["asm_outputs", "asm_inputs", "asm_clobbers", "asm_labels"];
    let mut section_index = 0usize;
    while stream.peek_name(0) == "PUNC_COLON" && section_index < sections.len() {
        stream.take_into(node);
        let section_span = stream.peek(0).map(span_of_token).unwrap_or(start_span);
        let section = cst::new_node(sections[section_index], Some(section_span));
        while !stream.done()
            && stream.peek_name(0) != "PUNC_COLON"
            && stream.peek_name(0) != "PUNC_RPAREN"
        {
            let item = if section_index <= 1 {
                parse_asm_operand(stream)
            } else if section_index == 2 {
                parse_asm_clobber(stream)
            } else {
                parse_asm_label(stream)
            };
            match item {
                Some(item) => cst::push_child(section, Item::Node(item)),
                None => {
                    stream.take_into(section);
                }
            }
            if stream.peek_name(0) == "PUNC_COMMA" {
                stream.take_into(section);
            }
        }
        cst::push_child(node, Item::Node(section));
        cst::set_extra(node, sections[section_index], Item::Node(section));
        section_index += 1;
    }

    if stream.peek_name(0) == "PUNC_RPAREN" {
        stream.take_into(node);
    }
    if stream.peek_name(0) == "PUNC_SEMI" {
        stream.take_into(node);
    }
    node
}

fn parse_asm_operand(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let node = cst::new_node("asm_operand", Some(span_of_token(start)));

    if cst::token_name(start) == "PUNC_LBRACKET" {
        let name_node = cst::new_node("asm_name", Some(span_of_token(start)));
        consume_balanced(stream, name_node, "PUNC_LBRACKET", "PUNC_RBRACKET");
        cst::push_child(node, Item::Node(name_node));
        cst::set_extra(node, "asmName", Item::Node(name_node));
    }

    if stream.peek_name(0) == "LIT_STRING" {
        if let Some(taken) = stream.take() {
            for token in taken.trivia {
                cst::push_child(node, Item::Token(token));
            }
            let constraint = cst::new_node("asm_constraint", Some(span_of_token(taken.token)));
            cst::push_child(constraint, Item::Token(taken.token));
            cst::set_extra(constraint, "value", Item::str(cst::token_src(taken.token)));
            cst::push_child(node, Item::Node(constraint));
            cst::set_extra(node, "constraint", Item::Node(constraint));
        }
    }

    if stream.peek_name(0) == "PUNC_LPAREN" {
        let start = stream.peek(0)?;
        let value = cst::new_node("asm_value", Some(span_of_token(start)));
        stream.take_into(value);
        if let Some(inner) = parse_expression(stream, &["PUNC_RPAREN"]) {
            cst::push_child(value, Item::Node(inner));
            cst::set_extra(value, "expression", Item::Node(inner));
        }
        if stream.peek_name(0) == "PUNC_RPAREN" {
            stream.take_into(value);
        }
        cst::push_child(node, Item::Node(value));
        cst::set_extra(node, "value", Item::Node(value));
    }

    if cst::child_count(node) > 0 {
        Some(node)
    } else {
        None
    }
}

fn parse_asm_clobber(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    if cst::token_name(start) != "LIT_STRING" {
        return None;
    }
    let node = cst::new_node("asm_clobber", Some(span_of_token(start)));
    let taken = stream.take()?;
    for token in taken.trivia {
        cst::push_child(node, Item::Token(token));
    }
    cst::push_child(node, Item::Token(taken.token));
    cst::set_extra(node, "value", Item::str(cst::token_src(taken.token)));
    Some(node)
}

fn parse_asm_label(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    let name = cst::token_name(start);
    if !is_id_like(&name) && name != "TYPEDEF_NAME" {
        return None;
    }
    let node = cst::new_node("asm_label_ref", Some(span_of_token(start)));
    let taken = stream.take()?;
    for token in taken.trivia {
        cst::push_child(node, Item::Token(token));
    }
    cst::push_child(node, Item::Token(taken.token));
    cst::set_extra(node, "labelName", Item::str(cst::token_src(taken.token)));
    Some(node)
}

fn take_preprocessor_line(stream: &mut TokenStream) -> usize {
    if let Some(directive) = parse_directive(stream) {
        return directive;
    }
    // Defensive: the canonical fallback, which is not normally reached.
    let start = stream.peek(0);
    let node = cst::new_node(
        "preprocessor_line",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    while !stream.done() {
        let name = stream.peek_name(0);
        stream.take_into(node);
        if name == "PP_NEWLINE" {
            break;
        }
    }
    node
}

// ---------------------------------------------------------------------
// Preprocessor directives
// ---------------------------------------------------------------------

/// The directive word: the first real token after the opening `#`.
fn directive_name(stream: &TokenStream) -> String {
    stream.peek(1).map(cst::token_src).unwrap_or_default()
}

pub fn parse_directive(stream: &mut TokenStream) -> Option<usize> {
    let start = stream.peek(0)?;
    if cst::token_name(start) != "PP_HASH" {
        return None;
    }
    let name = directive_name(stream);
    Some(match name.as_str() {
        "define" => parse_define_directive(stream),
        "undef" => parse_undef_directive(stream),
        "include" | "include_next" | "embed" => parse_include_directive(stream, &name),
        "if" | "ifdef" | "ifndef" | "elif" | "elifdef" | "elifndef" | "else" | "endif" => {
            parse_conditional_directive(stream, &name)
        }
        "pragma" => parse_simple_directive(stream, "pragma_directive"),
        "error" => parse_simple_directive(stream, "error_directive"),
        "warning" => parse_simple_directive(stream, "warning_directive"),
        "line" => parse_simple_directive(stream, "line_directive"),
        _ => parse_simple_directive(stream, "unknown_directive"),
    })
}

fn parse_simple_directive(stream: &mut TokenStream, kind: &str) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(kind, start.map(span_of_token).or(Some(Span::zero())));
    stream.take_into(node);
    while !stream.done() {
        let name = stream.peek_name(0);
        stream.take_into(node);
        if name == "PP_NEWLINE" {
            break;
        }
    }
    node
}

pub fn parse_define_directive(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let start_span = start.map(span_of_token).unwrap_or_else(Span::zero);
    let node = cst::new_node("define_directive", Some(start_span));
    stream.take_into(node);
    stream.take_into(node);

    let name = stream.peek_name(0);
    if is_id_like(&name) || name == "TYPEDEF_NAME" || name == "MACRO_NAME" {
        let taken = stream.take();
        if let Some(taken) = taken {
            for token in taken.trivia {
                cst::push_child(node, Item::Token(token));
            }
            cst::push_child(node, Item::Token(taken.token));
            cst::set_extra(node, "macroName", Item::str(cst::token_src(taken.token)));

            // Function-like when the `(` follows the name with nothing
            // between them.
            let name_end = cst::token_data(taken.token)
                .map(|data| data.span.end)
                .unwrap_or_default();
            let adjacent = stream.peek(0).is_some_and(|token| {
                cst::token_name(token) == "PUNC_LPAREN"
                    && cst::token_data(token)
                        .map(|data| data.span.start)
                        .unwrap_or_default()
                        == name_end
            });
            if adjacent {
                cst::set_extra(node, "macroKind", Item::str("function-like"));
                let opener_span = stream.peek(0).map(span_of_token).unwrap_or_else(Span::zero);
                let params = cst::new_node("macro_parameter_list", Some(opener_span));
                stream.take_into(params);
                let mut names: Vec<Item> = Vec::new();
                while !stream.done() && stream.peek_name(0) != "PUNC_RPAREN" {
                    let name = stream.peek_name(0);
                    if name == "PUNC_ELLIPSIS" {
                        cst::set_extra(node, "macroVariadic", Item::bool(true));
                        stream.take_into(params);
                    } else if name == "PUNC_COMMA" {
                        stream.take_into(params);
                    } else if is_id_like(&name) || name == "TYPEDEF_NAME" {
                        if let Some(token) = stream.take_into(params) {
                            names.push(Item::str(cst::token_src(token)));
                        }
                    } else {
                        stream.take_into(params);
                    }
                }
                cst::set_extra(node, "macroParams", Item::List(names));
                if stream.peek_name(0) == "PUNC_RPAREN" {
                    stream.take_into(params);
                }
                cst::push_child(node, Item::Node(params));
            } else {
                cst::set_extra(node, "macroKind", Item::str("object-like"));
            }
        }
    } else {
        cst::set_extra(node, "macroKind", Item::str("object-like"));
    }

    let body_span = stream.peek(0).map(span_of_token).unwrap_or(start_span);
    let body = cst::new_node("macro_body", Some(body_span));
    while !stream.done() {
        if stream.peek_name(0) == "PP_NEWLINE" {
            break;
        }
        stream.take_into(body);
    }
    cst::push_child(node, Item::Node(body));
    if stream.peek_name(0) == "PP_NEWLINE" {
        stream.take_into(node);
    }
    node
}

pub fn parse_undef_directive(stream: &mut TokenStream) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "undef_directive",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    stream.take_into(node);
    stream.take_into(node);
    let name = stream.peek_name(0);
    if is_id_like(&name) || name == "TYPEDEF_NAME" || name == "MACRO_NAME" {
        if let Some(taken) = stream.take() {
            for token in taken.trivia {
                cst::push_child(node, Item::Token(token));
            }
            cst::push_child(node, Item::Token(taken.token));
            cst::set_extra(node, "macroName", Item::str(cst::token_src(taken.token)));
        }
    }
    while !stream.done() {
        let name = stream.peek_name(0);
        stream.take_into(node);
        if name == "PP_NEWLINE" {
            break;
        }
    }
    node
}

pub fn parse_include_directive(stream: &mut TokenStream, form: &str) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "include_directive",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    cst::set_extra(node, "includeForm", Item::str(form));
    stream.take_into(node);
    stream.take_into(node);

    if let Some(next) = stream.peek(0) {
        if cst::token_name(next) == "LIT_HEADER_NAME" {
            if let Some(taken) = stream.take() {
                for token in taken.trivia {
                    cst::push_child(node, Item::Token(token));
                }
                cst::push_child(node, Item::Token(taken.token));
                let source = cst::token_src(taken.token);
                cst::set_extra(node, "headerName", Item::str(source.clone()));
                cst::set_extra(
                    node,
                    "headerKind",
                    Item::str(if source.starts_with('<') {
                        "angled"
                    } else {
                        "quoted"
                    }),
                );
            }
        } else {
            let header = cst::new_node("header_form", Some(span_of_token(next)));
            while !stream.done() {
                if stream.peek_name(0) == "PP_NEWLINE" {
                    break;
                }
                stream.take_into(header);
            }
            cst::push_child(node, Item::Node(header));
        }
    }

    if stream.peek_name(0) == "PP_NEWLINE" {
        stream.take_into(node);
    }
    node
}

pub fn parse_conditional_directive(stream: &mut TokenStream, name: &str) -> usize {
    let start = stream.peek(0);
    let node = cst::new_node(
        "conditional_directive",
        start.map(span_of_token).or(Some(Span::zero())),
    );
    cst::set_extra(node, "directive", Item::str(name));
    stream.take_into(node);
    stream.take_into(node);
    while !stream.done() {
        let name = stream.peek_name(0);
        stream.take_into(node);
        if name == "PP_NEWLINE" {
            break;
        }
    }
    node
}

// ---------------------------------------------------------------------
// The top-level dispatch
// ---------------------------------------------------------------------

/// Structure one external declaration from the chomped token list.
/// Returns a node whose children and `declKind` the caller installs, or
/// `None` when the shape is not one this pass recognises.
pub fn structure_external_declaration(tokens: &[usize]) -> Option<usize> {
    let mut stream = TokenStream::new(tokens.to_vec());
    if stream.done() {
        return None;
    }

    let head = stream.peek_name(0);
    if head == "KW_STATIC_ASSERT" || head == "KW__STATIC_ASSERT" {
        let assertion = parse_static_assert_declaration(&mut stream);
        return Some(result("declaration", vec![Item::Node(assertion)]));
    }

    if head == "PP_HASH" {
        let directive = parse_directive(&mut stream)?;
        let mut out = vec![Item::Node(directive)];
        while let Some(taken) = stream.take() {
            for token in taken.trivia {
                out.push(Item::Token(token));
            }
            out.push(Item::Token(taken.token));
        }
        return Some(result("declaration", out));
    }

    let specs = parse_declaration_specifiers(&mut stream);
    if specs.is_none()
        && !is_id_like(&stream.peek_name(0))
        && stream.peek_name(0) != "PUNC_STAR"
        && stream.peek_name(0) != "PUNC_LPAREN"
    {
        return None;
    }

    let declarators = parse_init_declarator_list(&mut stream);
    let tail = stream.peek_name(0);

    let mut out: Vec<Item> = Vec::new();
    if let Some(specs) = specs {
        out.push(Item::Node(specs));
    }

    if tail == "PUNC_SEMI" {
        if let Some(declarators) = declarators {
            out.push(Item::Node(declarators));
        }
        while let Some(taken) = stream.take() {
            for token in taken.trivia {
                out.push(Item::Token(token));
            }
            out.push(Item::Token(taken.token));
        }
        return Some(result("declaration", out));
    }

    if tail == "PUNC_LBRACE" {
        // A function definition. The declarator list holds one
        // declarator with no initializer, which is the function's.
        if let Some(declarators) = declarators {
            let children = cst::children_of(declarators);
            let single = if children.len() == 1 {
                children[0].as_node()
            } else {
                None
            };
            let lifted = single.filter(|single| {
                cst::kind_of(*single) == "init_declarator" && {
                    let inner = cst::children_of(*single);
                    inner.len() == 1
                        && inner[0]
                            .as_node()
                            .is_some_and(|child| cst::kind_of(child) == "declarator")
                }
            });
            match lifted {
                Some(single) => {
                    if let Some(declarator) = cst::children_of(single)[0].as_node() {
                        out.push(Item::Node(declarator));
                    }
                }
                None => out.push(Item::Node(declarators)),
            }
        }
        if let Some(body) = parse_compound_statement(&mut stream) {
            out.push(Item::Node(body));
        }
        while let Some(taken) = stream.take() {
            for token in taken.trivia {
                out.push(Item::Token(token));
            }
            out.push(Item::Token(taken.token));
        }
        return Some(result("function_definition", out));
    }

    // A K&R function definition: declarator identifiers followed by a
    // declaration list before the `{`.
    if !tail.is_empty() && tail != "PUNC_SEMI" {
        let mark = stream.mark();
        let mut saw_brace = false;
        while !stream.done() {
            if stream.peek_name(0) == "PUNC_LBRACE" {
                saw_brace = true;
                break;
            }
            if stream.take().is_none() {
                break;
            }
        }
        if saw_brace {
            stream.restore(mark);
            let list_span = stream.peek(0).map(span_of_token).unwrap_or_else(Span::zero);
            let list = cst::new_node("kr_declaration_list", Some(list_span));
            while !stream.done() && stream.peek_name(0) != "PUNC_LBRACE" {
                stream.take_into(list);
            }
            if let Some(declarators) = declarators {
                out.push(Item::Node(declarators));
            }
            out.push(Item::Node(list));
            if let Some(body) = parse_compound_statement(&mut stream) {
                out.push(Item::Node(body));
            }
            while let Some(taken) = stream.take() {
                for token in taken.trivia {
                    out.push(Item::Token(token));
                }
                out.push(Item::Token(taken.token));
            }
            return Some(result("function_definition", out));
        }
        stream.restore(mark);
    }

    // Nothing recognised: the caller keeps the flat token list.
    None
}

/// The carrier the caller reads `children` and `declKind` off.
fn result(decl_kind: &str, children: Vec<Item>) -> usize {
    let node = cst::new_node("__structured__", None);
    cst::set_children(node, children);
    cst::set_extra(node, "declKind", Item::str(decl_kind));
    node
}
