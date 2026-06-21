/* Copyright (c) 2026 Richard Rodger and contributors, MIT License */

// @tabnas/c — Tabnas plugin (built on @tabnas/jsonic) that parses C source
// into a concrete syntax
// tree, preserving macros and compiler extensions.
//
// First-slice scope:
//   - Focused lex matchers (./matchers.ts) for whitespace, line
//     continuation, comments, preprocessor directive boundaries, header
//     names, identifiers (with keyword/typedef-name reclassification),
//     integer/float/char/string literals, and punctuators.
//   - SymbolTable + MacroTable installed on ctx.meta.cmeta for shared
//     access from lex matchers and rule actions.
//   - A coarse top-level grammar that splits the translation unit into
//     external-declaration units terminated by `;` or by a brace-balanced
//     block. Each unit captures its tokens verbatim. When the unit looks
//     like `typedef <specs> <ID> ;` the trailing identifier is registered
//     as a typedef-name in the symbol table — this is exactly what the
//     identifier matcher needs to reclassify subsequent occurrences as
//     TYPEDEF_NAME.
//
// Subsequent slices will refine each unit into the full C grammar
// (declarators, statements, expressions via @jsonic/expr, full
// preprocessor handling) without disturbing this foundation.

import { Tabnas } from '@tabnas/parser'
import { jsonic } from '@tabnas/jsonic'
import type { Rule, Context, Token } from '@tabnas/parser'
import { allMatchers } from './matchers.js'
import { makeCMeta, type CMeta } from './symbols.js'
import {
  C23_KEYWORDS,
  EXT_KEYWORDS,
  PUNCTUATORS,
  keywordTokenName,
} from './tokens.js'
import { structureExternalDeclaration } from './structure.js'
import { structureConditionalGroups } from './conditional-groups.js'
import { installExpr } from './expr-grammar.js'

// --- BEGIN EMBEDDED c-grammar.jsonic ---
const grammarText = `
# C parser grammar (declarative)
#
# Parsed by a vanilla Jsonic instance and passed to jsonic.grammar(). The
# rule skeleton lives here; all conditions and actions are bound to
# @-named refs supplied by ../src/c.ts so the structural intent of the
# grammar is readable without TypeScript noise.
#
# Token sets, lex matchers, and option flags (lex pipeline disable,
# IGNORE membership for trivia, etc.) are configured in c.ts before
# this grammar is loaded — putting them here would make the grammar
# self-modifying (it depends on the same dynamic ANY_C_TOKEN set it
# would define).
#
# Conventions:
#   '@<rulename>-bo'  state action: before-open  (auto-installed)
#   '@<rulename>-ao'  state action: after-open
#   '@<rulename>-bc'  state action: before-close
#   '@<rulename>-ac'  state action: after-close
#   '@<actionname>'   alt-level action / condition

{
  rule: {

    # translation_unit
    #   bo: create the root node
    #   open: empty input → bail; else descend into extdecl_loop
    #   bc: fold #if … #endif sequences into conditional_group nodes
    #   close: end on EOF
    translation_unit: {
      open: [
        { s: '#ZZ' b: 1 g: 'tu-empty' }
        { p: 'extdecl_loop' g: 'tu-loop' }
      ]
      close: [
        { s: '#ZZ' g: 'tu-end' }
      ]
    }

    # extdecl_loop
    #   r.node is inherited from translation_unit. bc pushes the
    #   completed external_declaration child onto translation_unit
    #   before deciding to recurse.
    extdecl_loop: {
      open: [
        { p: 'external_declaration' g: 'loop-one' }
      ]
      close: [
        { s: '#ZZ' b: 1 g: 'loop-end' }
        { r: 'extdecl_loop' g: 'loop-more' }
      ]
    }

    # external_declaration
    #
    # Phase B1 dispatch: if the head token is a recognised simple type
    # specifier (currently only KW_INT, broadens later), descend into
    # int_declaration which parses through proper grammar (with val
    # for initializers via @jsonic/expr). Otherwise fall through to
    # the legacy chomp path that absorbs tokens for post-process
    # structuring.
    external_declaration: {
      open: [
        { s: '#ZZ' b: 1 g: 'extdecl-eof' }
        # [extension: preprocessor] PP_HASH dispatches to preprocessor_directive.
        { s: 'PP_HASH PP_HASH' c: '@ext-and-first-iter' b: 2
          p: 'preprocessor_directive' a: '@mark-new-path'
          g: 'extdecl-pp-2' }
        { s: 'PP_HASH #ANY_C_TOKEN' c: '@ext-and-first-iter' b: 2
          p: 'preprocessor_directive' a: '@mark-new-path'
          g: 'extdecl-pp' }
        # Phase O: top-level static_assert dispatches into the
        # static_assert_declaration grammar rule. The cond / msg
        # vals are pushed with n.no_comma_op set so @jsonic/expr's
        # expr.close bails at \`,\` rather than treating it as the
        # comma operator.
        { s: 'KW_STATIC_ASSERT' c: '@is-first-iter' b: 1
          p: 'static_assert_declaration' a: '@mark-new-path'
          g: 'extdecl-sa' }
        { s: 'KW__STATIC_ASSERT' c: '@is-first-iter' b: 1
          p: 'static_assert_declaration' a: '@mark-new-path'
          g: 'extdecl-sa-1' }
        # [extension: gcc-asm] top-level inline assembly block.
        { s: 'KW_ASM' c: '@ext-and-first-iter' b: 1
          p: 'asm_statement' a: '@mark-new-path'
          g: 'extdecl-asm' }
        { s: 'KW___ASM' c: '@ext-and-first-iter' b: 1
          p: 'asm_statement' a: '@mark-new-path'
          g: 'extdecl-asm-1' }
        { s: 'KW___ASM__' c: '@ext-and-first-iter' b: 1
          p: 'asm_statement' a: '@mark-new-path'
          g: 'extdecl-asm-2' }
        # Plain-mode direct dispatches. When the head token clearly
        # starts a declaration, push simple_declaration without a
        # lookahead validator — the rule's own alts and per-rule k
        # state disambiguate the actual shape. These run only when
        # \`extended: false\` so we don't bypass the wildcard alts'
        # @looks-simple-decl + isFunctionBodySupported gate that
        # routes asm-body / pp-line function definitions to the
        # legacy structuring path (those constructs only matter in
        # extended mode anyway).
        { s: '#SIMPLE_TYPE_HEAD' c: '@plain-and-first-iter' b: 1
          p: 'simple_declaration' a: '@mark-new-path'
          g: 'extdecl-plain-type' }
        { s: '#STORAGE_PREFIX' c: '@plain-and-first-iter' b: 1
          p: 'simple_declaration' a: '@mark-new-path'
          g: 'extdecl-plain-storage' }
        { s: 'KW__BITINT' c: '@plain-and-first-iter' b: 1
          p: 'simple_declaration' a: '@mark-new-path'
          g: 'extdecl-plain-bitint' }
        { s: 'PUNC_LBRACKET PUNC_LBRACKET' c: '@plain-as23-and-first'
          b: 2 p: 'simple_declaration' a: '@mark-new-path'
          g: 'extdecl-plain-c23-attr' }
        # Phase B2.3 dispatch: cascading wildcard-token alts. Each one
        # matches a fixed number of tokens to force lookahead, then the
        # @looks-simple-decl cond validates the actual shape — optional
        # storage prefix, 1+ simple type specifiers, an ID, and a \`;\` or
        # \`=\` terminator. b: N back-steps all matched tokens so
        # simple_declaration sees them as t0..t(N-1).
        # Longest alts first so multi-keyword forms win over shorter
        # shapes that would have stopped at the wrong ID.
        # Gate: only on the first iteration of an external_declaration
        # so the chomp's r:-recursion doesn't re-fire mid-declaration.
        { s: '#ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN'
          c: '@looks-simple-decl' b: 6
          p: 'simple_declaration' a: '@mark-new-path' g: 'extdecl-new-decl-6' }
        { s: '#ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN'
          c: '@looks-simple-decl' b: 5
          p: 'simple_declaration' a: '@mark-new-path' g: 'extdecl-new-decl-5' }
        { s: '#ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN'
          c: '@looks-simple-decl' b: 4
          p: 'simple_declaration' a: '@mark-new-path' g: 'extdecl-new-decl-4' }
        { s: '#ANY_C_TOKEN #ANY_C_TOKEN #ANY_C_TOKEN'
          c: '@looks-simple-decl' b: 3
          p: 'simple_declaration' a: '@mark-new-path' g: 'extdecl-new-decl-3' }
        { s: '#ANY_C_TOKEN' a: '@absorb-token' g: 'extdecl-tok' }
      ]
      close: [
        { c: '@new-path' a: '@finalize-new-path' g: 'extdecl-new-end' }
        { s: '#ZZ' b: 1 a: '@finalize-extdecl' g: 'extdecl-finish-eof' }
        { c: '@just-closed-and-decl-ahead' a: '@finalize-extdecl' g: 'extdecl-finish-block' }
        { c: '@terminated' a: '@finalize-extdecl' g: 'extdecl-finish' }
        { r: 'external_declaration' g: 'extdecl-more' }
      ]
    }

    # simple_declaration  (phase B2: single-keyword type + ID + optional init)
    #
    # Recognises: <simple-type-head> ID (= val)? ;
    # Initializer expressions descend into val (which @jsonic/expr's
    # plugin install has wired up for full C precedence).
    #
    # Output: a CST node of kind 'declaration' with declaredName set,
    # children laid out as
    #   [declaration_specifiers, init_declarator_list, ';']
    # simple_declaration  (phase B2: any-length specifier list +
    # comma-separated init-declarator-list)
    #
    # Recognises:
    #   <storage>? <type>+ <init_declarator> (, <init_declarator>)* ;
    # where each init_declarator is \`ID (= val)?\`. Initializer
    # expressions descend into val (which @jsonic/expr's plugin install
    # has wired up for full C precedence).
    simple_declaration: {
      open: [
        # Leading C23 attribute spec — plain C23.
        { s: 'PUNC_LBRACKET PUNC_LBRACKET' c: '@as23-adjacent-open'
          b: 2 p: 'spec_loop' g: 'simple-decl-attr-c23' }
        # [extension: gcc-attr] leading GCC __attribute__((…)) spec.
        { s: 'KW___ATTRIBUTE__' c: '@extended-on' b: 1 p: 'spec_loop'
          g: 'simple-decl-attr-gcc' }
        { s: 'KW___ATTRIBUTE' c: '@extended-on' b: 1 p: 'spec_loop'
          g: 'simple-decl-attr-gcc-1' }
        # [extension: msvc-attr] leading __declspec(…) spec.
        { s: 'KW___DECLSPEC' c: '@extended-on' b: 1 p: 'spec_loop'
          g: 'simple-decl-attr-msvc' }
        { s: '#STORAGE_PREFIX' a: '@absorb-spec-storage' p: 'spec_loop'
          g: 'simple-decl-storage' }
        # Tagged-type heads dispatch into struct_specifier /
        # enum_specifier (phase F.5). spec_loop's bc relays the
        # returned node onto u.specs.
        { s: 'KW_STRUCT' b: 1 p: 'struct_specifier'
          g: 'simple-decl-struct' }
        { s: 'KW_UNION' b: 1 p: 'struct_specifier'
          g: 'simple-decl-union' }
        { s: 'KW_ENUM' b: 1 p: 'enum_specifier'
          g: 'simple-decl-enum' }
        # C23 _BitInt(N) — leading. Absorb the keyword onto the
        # parent's specs and descend into bit_int_paren which
        # captures \`( <width> )\`. Then re-enter simple_declaration's
        # open via spec_loop on return.
        { s: 'KW__BITINT' b: 1 p: 'spec_loop'
          g: 'simple-decl-bitint' }
        { s: '#SIMPLE_TYPE_HEAD' a: '@absorb-spec-type' p: 'spec_loop'
          g: 'simple-decl-type' }
      ]
      close: [
        # Function-definition completion: compound_statement returned
        # and rule.u.fnBody is set — finalise as function_definition.
        { c: '@fn-body-done' a: '@simple-decl-finalize-fn'
          g: 'simple-decl-fn-end' }
        # Function-definition body: after init_declarator captures
        # the function declarator, \`{\` opens the body. Push
        # compound_statement to absorb it; on return @fn-body-done
        # above fires.
        { s: 'PUNC_LBRACE' b: 1 p: 'compound_statement'
          a: '@simple-decl-start-fn-body'
          g: 'simple-decl-fn-body' }
        # First declarator (after specs). Backstep the head token so
        # init_declarator's open sees it; descend into the sub-rule.
        # ID head: plain declarator. STAR head: pointer prefix.
        # LPAREN: function postfix on a (rare) parenthesised
        # subdeclarator — let the chomp handle that complex case.
        { s: 'ID' b: 1 p: 'init_declarator' g: 'simple-decl-first-decl' }
        { s: 'PUNC_STAR' b: 1 p: 'init_declarator' g: 'simple-decl-first-decl-ptr' }
        # Phase P: parenthesised sub-declarator (function pointer).
        # Shape: \`<type>+ ( * ID ) ( <params>? ) ;\` (or = init).
        # @looks-simple-decl's paren-walk has already validated the
        # shape; here we backstep \`(\` so init_declarator's open sees
        # it and dispatches into paren_inner_declarator.
        { s: 'PUNC_LPAREN' b: 1 p: 'init_declarator'
          g: 'simple-decl-first-decl-paren' }
        # Subsequent declarators after a comma.
        { s: 'PUNC_COMMA' a: '@simple-decl-take-comma' p: 'init_declarator'
          g: 'simple-decl-comma' }
        # End of declaration (variable form).
        { s: 'PUNC_SEMI' a: '@simple-decl-finalize' g: 'simple-decl-end' }
      ]
    }

    # spec_loop: absorbs zero or more specifier keywords (and tagged
    # specifiers — struct / union / enum) and ends when the next token
    # isn't another specifier. r.node is inherited from
    # simple_declaration; @absorb-spec-* push refs into the
    # declaration_specifiers scaffolding the parent rule set up in
    # @simple_declaration-bo. Tagged specifiers are dispatched into
    # their own sub-rules (struct_specifier / enum_specifier);
    # @spec_loop-bc stitches the returned specifier node onto the
    # owning declaration_specifiers list.
    spec_loop: {
      open: [
        # Attribute specs interleave freely with simple specifiers and
        # tagged-type heads. C23 [[…]] is plain; GCC __attribute__ /
        # __attribute / MSVC __declspec are extensions.
        { s: 'PUNC_LBRACKET PUNC_LBRACKET' c: '@as23-adjacent-open'
          b: 2 p: 'attribute_spec_c23' g: 'spec-loop-attr-c23' }
        # [extension: gcc-attr]
        { s: 'KW___ATTRIBUTE__' c: '@extended-on' b: 1
          p: 'attribute_spec_gcc' g: 'spec-loop-attr-gcc' }
        { s: 'KW___ATTRIBUTE' c: '@extended-on' b: 1
          p: 'attribute_spec_gcc' g: 'spec-loop-attr-gcc-1' }
        # [extension: msvc-attr]
        { s: 'KW___DECLSPEC' c: '@extended-on' b: 1
          p: 'attribute_spec_msvc' g: 'spec-loop-attr-msvc' }
        # Tagged-type heads dispatch into struct_specifier /
        # enum_specifier. These must come BEFORE #SIMPLE_TYPE_HEAD
        # because KW_STRUCT/KW_UNION/KW_ENUM are members of that set
        # too — without ordering, the generic alt would absorb them
        # as plain tokens instead of producing a struct_specifier
        # subtree.
        { s: 'KW_STRUCT' b: 1 p: 'struct_specifier' g: 'spec-loop-struct' }
        { s: 'KW_UNION' b: 1 p: 'struct_specifier' g: 'spec-loop-union' }
        { s: 'KW_ENUM' b: 1 p: 'enum_specifier' g: 'spec-loop-enum' }
        # C23 _BitInt(N) — width-parameterised integer type. Absorb
        # the keyword as a normal type spec, then descend into the
        # bit_int_paren sub-rule which captures \`( <width> )\`.
        { s: 'KW__BITINT' a: '@absorb-spec-type'
          p: 'bit_int_paren' g: 'spec-loop-bitint' }
        { s: '#SIMPLE_TYPE_HEAD' a: '@absorb-spec-type' g: 'spec-loop-type' }
        # If the next token isn't a specifier, fall through without
        # consuming so the parent can pick up the declarator.
        { s: [] g: 'spec-loop-empty' }
      ]
      close: [
        # See open above for the plain-vs-extension split.
        { s: 'PUNC_LBRACKET PUNC_LBRACKET' c: '@as23-adjacent-open'
          b: 2 p: 'attribute_spec_c23' g: 'spec-loop-more-attr-c23' }
        # [extension: gcc-attr]
        { s: 'KW___ATTRIBUTE__' c: '@extended-on' b: 1
          p: 'attribute_spec_gcc' g: 'spec-loop-more-attr-gcc' }
        { s: 'KW___ATTRIBUTE' c: '@extended-on' b: 1
          p: 'attribute_spec_gcc' g: 'spec-loop-more-attr-gcc-1' }
        # [extension: msvc-attr]
        { s: 'KW___DECLSPEC' c: '@extended-on' b: 1
          p: 'attribute_spec_msvc' g: 'spec-loop-more-attr-msvc' }
        # Tagged-type heads must come before #SIMPLE_TYPE_HEAD here
        # too (see open above for rationale).
        { s: 'KW_STRUCT' b: 1 p: 'struct_specifier' g: 'spec-loop-more-struct' }
        { s: 'KW_UNION' b: 1 p: 'struct_specifier' g: 'spec-loop-more-union' }
        { s: 'KW_ENUM' b: 1 p: 'enum_specifier' g: 'spec-loop-more-enum' }
        { s: 'KW__BITINT' a: '@absorb-spec-type'
          p: 'bit_int_paren' g: 'spec-loop-more-bitint' }
        { s: '#SIMPLE_TYPE_HEAD' b: 1 r: 'spec_loop' g: 'spec-loop-more' }
        { s: [] g: 'spec-loop-end' }
      ]
    }

    # bit_int_paren: the \`(N)\` width argument of \`_BitInt(N)\`.
    # The keyword has already been absorbed by spec_loop's KW__BITINT
    # alt; this rule just takes \`(\`, then a width expression, then \`)\`.
    bit_int_paren: {
      open: [
        { s: 'PUNC_LPAREN' a: '@bip-take-lparen' g: 'bip-lparen' }
      ]
      close: [
        { s: 'PUNC_RPAREN' a: '@bip-take-rparen' g: 'bip-rparen' }
        { p: 'val' a: '@bip-mark-val' g: 'bip-val' }
      ]
    }

    # init_declarator: pointer* ID (= val)?
    # Each invocation builds its own init_declarator node. The
    # parent simple_declaration's bc pushes it onto the
    # init_declarator_list when the sub-rule completes.
    #
    # The rule re-enters itself once via r: after capturing the ID so
    # the close state can run a second time to look for \`=\`. r.k.named
    # latches across that recursion; the gate alt at the top of open
    # accepts the re-entry without consuming any tokens.
    init_declarator: {
      open: [
        # Re-entry after the ID was captured: skip open, fall through
        # to close to handle \`=\` / array postfix / end.
        { c: '@idecl-named' s: [] g: 'idecl-reentry' }
        # Pointer prefix: back-step the \`*\`, descend into pointer_list
        # which absorbs all the leading \`*\` tokens.
        { s: 'PUNC_STAR' b: 1 p: 'pointer_list' g: 'idecl-ptrs' }
        # Phase P: parenthesised sub-declarator. Capture the LPAREN
        # onto the outer direct_declarator and descend into
        # paren_inner_declarator, which builds an inner declarator
        # node and attaches it to the outer direct_declarator before
        # returning at \`)\`.
        { s: 'PUNC_LPAREN' a: '@idecl-paren-open'
          p: 'paren_inner_declarator' g: 'idecl-paren' }
        # No pointer prefix, ID directly.
        { s: 'ID' a: '@idecl-name' r: 'init_declarator' g: 'idecl-id' }
      ]
      close: [
        # Returning from paren_inner_declarator: consume the matching
        # \`)\` and finalise the outer declarator. Then r:-recurse so
        # the rest of close() can take any trailing postfix
        # (function postfix for fn-pointers, array postfix for
        # arrays of fn-pointers).
        { s: 'PUNC_RPAREN' c: '@idecl-paren-pending'
          a: '@idecl-paren-close' r: 'init_declarator'
          g: 'idecl-paren-rparen' }
        # Returning from pointer_list, capture the ID, then re-enter
        # to check for postfix / initializer.
        { s: 'ID' a: '@idecl-name' r: 'init_declarator' g: 'idecl-id-after-ptrs' }
        # Array postfix \`[ … ]\` (one or more dimensions). Each one
        # re-enters init_declarator so additional postfixes can stack.
        { s: 'PUNC_LBRACKET' b: 1 p: 'array_postfix'
          r: 'init_declarator' g: 'idecl-arr' }
        # Function postfix \`( … )\` for function declarators. Re-enters
        # init_declarator so trailing \`[…]\` (function returning array)
        # or further postfixes can stack — though for now phase B3.1
        # only exercises \`<type> ID ( … ) ;\`.
        { s: 'PUNC_LPAREN' b: 1 p: 'function_postfix'
          r: 'init_declarator' g: 'idecl-fn' }
        { s: 'PUNC_ASSIGN' p: 'initializer' a: '@idecl-take-eq' g: 'idecl-eq' }
        { s: [] g: 'idecl-end' }
      ]
    }

    # initializer (phase Q2.1): wrapper around the RHS of \`=\` in an
    # init_declarator. Dispatches to initializer_list for brace-init
    # forms (\`= { 1, 2, 3 }\`, \`= { [0] = 1 }\`) and to val for
    # expression initializers (\`= 5\`, \`= (int)x\`, \`= f()\`). Mirrors
    # the legacy parseInitializer wrapper in structure.ts.
    initializer: {
      open: [
        { s: 'PUNC_LBRACE' b: 1 p: 'initializer_list' g: 'init-brace' }
        { p: 'val' g: 'init-expr' }
      ]
      close: [
        { s: [] g: 'init-end' }
      ]
    }

    # paren_inner_declarator (phase P): builds an inner declarator
    # node for a parenthesised sub-declarator (function-pointer
    # form). Mirrors init_declarator's pointer + ID + postfix logic
    # but without \`=\` initializer handling, and stops at (without
    # consuming) the matching \`)\` so the outer init_declarator can
    # take it. The inner declarator is attached to the outer's
    # direct_declarator by @pid-name.
    paren_inner_declarator: {
      open: [
        # Re-entry after the ID was captured: skip open.
        { c: '@pid-named' s: [] g: 'pid-reentry' }
        # Pointer prefix.
        { s: 'PUNC_STAR' b: 1 p: 'pointer_list' g: 'pid-ptrs' }
        # No pointer prefix, ID directly (rare but legal: \`int (fp)(…)\`).
        { s: 'ID' a: '@pid-name' r: 'paren_inner_declarator' g: 'pid-id' }
      ]
      close: [
        # After pointer_list returns, capture the ID then re-enter.
        { s: 'ID' a: '@pid-name' r: 'paren_inner_declarator'
          g: 'pid-id-after-ptrs' }
        # Stop before \`)\` so the outer init_declarator's close can
        # consume it.
        { s: 'PUNC_RPAREN' b: 1 g: 'pid-end-rparen' }
        { s: [] g: 'pid-end' }
      ]
    }

    # array_postfix: \`[ const-expr? ]\`
    # Inner expression is parsed via val (currently limited to forms
    # @jsonic/expr handles; complex constant expressions involving
    # casts will land cleanly once phase C lifts cast handling).
    array_postfix: {
      open: [
        { s: 'PUNC_LBRACKET' a: '@arr-open' g: 'arr-open' }
      ]
      close: [
        { s: 'PUNC_RBRACKET' a: '@arr-close' g: 'arr-end-empty' }
        { p: 'val' g: 'arr-size' }
      ]
    }

    # pointer_list: absorbs one or more \`*\` tokens. Pushes a
    # pointer node per \`*\` onto the parent init_declarator's
    # declarator children.
    # pointer_list: \`*\` qualifiers* (then another \`*\` ...).
    # Type qualifiers (\`const\`/\`volatile\`/\`restrict\`/\`_Atomic\`) after
    # \`*\` qualify the pointer (e.g. \`int * const p\` is a const pointer
    # to int). The qualifiers between successive \`*\`s are consumed by
    # the pointer_qualifier_loop sub-rule, called from open after the
    # \`*\` is absorbed.
    pointer_list: {
      open: [
        { s: 'PUNC_STAR' a: '@absorb-pointer'
          p: 'pointer_qualifier_loop' g: 'ptr' }
      ]
      close: [
        { s: 'PUNC_STAR' b: 1 r: 'pointer_list' g: 'ptr-more' }
        { s: [] g: 'ptr-end' }
      ]
    }

    # pointer_qualifier_loop: zero or more type qualifiers that bind
    # to the parent pointer_list's most recently-pushed pointer node.
    # Each qualifier r:-recurses for the next; falls through cleanly
    # when no qualifier is present.
    pointer_qualifier_loop: {
      open: [
        { s: 'KW_CONST' a: '@absorb-pq-const'
          r: 'pointer_qualifier_loop' g: 'pql-const' }
        { s: 'KW_VOLATILE' a: '@absorb-pq-const'
          r: 'pointer_qualifier_loop' g: 'pql-volatile' }
        { s: 'KW_RESTRICT' a: '@absorb-pq-const'
          r: 'pointer_qualifier_loop' g: 'pql-restrict' }
        { s: 'KW__ATOMIC' a: '@absorb-pq-const'
          r: 'pointer_qualifier_loop' g: 'pql-atomic' }
        { s: [] g: 'pql-empty' }
      ]
      close: [
        { s: [] g: 'pql-end' }
      ]
    }

    # function_postfix: \`( <param-list> )\` after the declarator name.
    # Covers empty \`()\`, explicit \`(void)\`, prototype parameters,
    # variadic, K&R-style identifier lists.
    function_postfix: {
      open: [
        { s: 'PUNC_LPAREN' a: '@fn-open' g: 'fn-open' }
      ]
      close: [
        # Empty parameter list: \`()\`.
        { s: 'PUNC_RPAREN' a: '@fn-close' g: 'fn-end-empty' }
        # K&R-style prototype: \`(ID , ID , ...)\` or \`(ID)\` where the
        # ID is NOT a registered typedef (else it would lex as
        # TYPEDEF_NAME and route through parameter_type_list). The
        # two-token lookahead disambiguates from a typed parameter.
        { s: 'ID PUNC_COMMA' b: 2 p: 'identifier_list' g: 'fn-knr-comma' }
        { s: 'ID PUNC_RPAREN' b: 2 p: 'identifier_list' g: 'fn-knr-end' }
        # Otherwise descend into the parameter list, then re-enter
        # close (where the matching \`)\` is consumed).
        { p: 'parameter_type_list' g: 'fn-params' }
      ]
    }

    # identifier_list (K&R-style function prototype parameter list).
    # \`int f(a, b);\` — the parameters are bare identifiers without
    # type specifiers; the actual types are declared between the
    # parameter list and the function body in pre-ANSI C, or are
    # left implicit. We consume the comma-separated IDs and attach
    # the identifier_list node onto function_postfix.
    identifier_list: {
      open: [
        { s: 'ID' a: '@idlist-take' g: 'idl-first' }
      ]
      close: [
        { s: 'PUNC_COMMA' a: '@idlist-comma'
          r: 'identifier_list' g: 'idl-comma' }
        { s: 'ID' a: '@idlist-take'
          r: 'identifier_list' g: 'idl-more' }
        { s: 'PUNC_RPAREN' b: 1 a: '@idlist-attach'
          g: 'idl-end' }
      ]
    }

    # parameter_type_list: 1+ comma-separated parameter_declarations,
    # optionally terminated by \`, ...\` for variadic functions.
    parameter_type_list: {
      open: [
        { p: 'parameter_declaration' g: 'ptl-first' }
      ]
      close: [
        # Variadic ellipsis: \`, ...\` ends the list.
        { s: 'PUNC_COMMA PUNC_ELLIPSIS' a: '@ptl-take-ellipsis'
          g: 'ptl-ellipsis' }
        { s: 'PUNC_COMMA' a: '@ptl-comma' p: 'parameter_declaration'
          g: 'ptl-more' }
        { s: 'PUNC_RPAREN' b: 1 a: '@ptl-attach-and-end' g: 'ptl-end' }
      ]
    }

    # parameter_declaration: <type>+ ID? — declaration_specifiers and
    # an optional declarator name. \`void\` alone is the C convention
    # for "no parameters" and is captured here as a single-spec
    # parameter.
    parameter_declaration: {
      open: [
        # Re-entry after a pointer prefix was absorbed: skip the
        # type-spec dispatch and fall through to close to handle
        # additional \`*\` or the ID.
        { c: '@param-reentered' s: [] g: 'param-reentry' }
        { s: '#SIMPLE_TYPE_HEAD' a: '@param-spec' p: 'param_spec_loop'
          g: 'param-type' }
      ]
      close: [
        # Pointer prefix on the parameter declarator. Each \`*\` becomes
        # a pointer node on the declarator; we recurse to keep
        # absorbing more \`*\` and finally the optional ID.
        { s: 'PUNC_STAR' a: '@param-pointer'
          r: 'parameter_declaration' g: 'param-ptr' }
        # Returning from param_paren_inner: take the matching \`)\` of
        # the outer paren-form. Must come BEFORE the PUNC_LPAREN
        # alts so the closing token is consumed by the right alt.
        { s: 'PUNC_RPAREN' c: '@param-paren-pending'
          a: '@param-paren-close' r: 'parameter_declaration'
          g: 'param-paren-rparen' }
        # Function postfix following a parenthesised pointer, e.g.
        # the \`(int)\` in \`int (*)(int)\`. Higher priority than the
        # paren-form alt so it fires once we've already absorbed a
        # paren-form declarator.
        { s: 'PUNC_LPAREN' c: '@param-need-fn-postfix'
          b: 1 p: 'function_postfix'
          r: 'parameter_declaration' g: 'param-fn-postfix' }
        # Parenthesised abstract / named declarator: \`int (*)(int)\`,
        # \`int (*fn)(int)\`. Open paren feeds into a sub-rule that
        # handles \`(...)\` containing pointer + optional ID; the
        # outer \`)\` is consumed by the param-paren-rparen alt above.
        # Cond gates against re-firing once a paren-form has already
        # been absorbed.
        { s: 'PUNC_LPAREN' c: '@param-can-paren-form'
          a: '@param-paren-open' p: 'param_paren_inner'
          g: 'param-paren' }
        # Array postfix, e.g. \`int arr[10]\` or \`int (*)[10]\`.
        { s: 'PUNC_LBRACKET' b: 1 p: 'array_postfix'
          r: 'parameter_declaration' g: 'param-arr' }
        { s: 'ID' a: '@param-name'
          r: 'parameter_declaration' g: 'param-id' }
        { s: [] g: 'param-end' }
      ]
    }

    # param_paren_inner: the contents of \`(\` ... \`)\` inside a
    # parameter declarator. Mirrors paren_inner_declarator's role
    # for init_declarator. Accepts pointer prefix(es) + optional ID,
    # then exits on \`)\` (which the outer parameter_declaration
    # consumes).
    param_paren_inner: {
      open: [
        # Re-entry after we absorbed the inner ID — fall through to
        # close so the outer \`)\` is left for parameter_declaration.
        { c: '@ppi-named' s: [] g: 'ppi-reentry' }
        # Pointer prefix.
        { s: 'PUNC_STAR' a: '@ppi-pointer'
          r: 'param_paren_inner' g: 'ppi-ptr' }
        # Bare ID with no pointer (rare, e.g. \`int (fp)(…)\`).
        { s: 'ID' a: '@ppi-name' g: 'ppi-id' }
        # Abstract: nothing inside \`(*)\` already-handled by re-entry
        # via the pointer alt; fallthrough to close on bare \`)\`.
        { s: [] g: 'ppi-empty' }
      ]
      close: [
        # After absorbing \`*\`, an optional ID may follow.
        { s: 'ID' a: '@ppi-name' g: 'ppi-id-after-ptr' }
        # Stop before \`)\` so the outer parameter_declaration's close
        # consumes it.
        { s: 'PUNC_RPAREN' b: 1 g: 'ppi-end' }
        { s: [] g: 'ppi-fall' }
      ]
    }

    # param_spec_loop: zero or more additional type specifiers in a
    # parameter's spec list.
    param_spec_loop: {
      open: [
        { s: '#SIMPLE_TYPE_HEAD' a: '@param-spec' g: 'param-spec-more' }
        { s: [] g: 'param-spec-empty' }
      ]
      close: [
        { s: '#SIMPLE_TYPE_HEAD' b: 1 r: 'param_spec_loop' g: 'param-spec-loop' }
        { s: [] g: 'param-spec-end' }
      ]
    }

    # compound_statement: \`{ … }\`
    # Phase B3.3+B4.2.1 wires this as a structured block: each item
    # between the opening and closing braces is dispatched into the
    # block_item sub-rule (declaration | statement). The \`-bc\` hook
    # stitches each returned item onto compound_statement.children
    # before re-entering the close loop.
    compound_statement: {
      open: [
        { s: 'PUNC_LBRACE' a: '@cs-open' g: 'cs-open' }
      ]
      close: [
        # Closing \`}\` — finalise.
        { s: 'PUNC_RBRACE' a: '@cs-close' g: 'cs-end' }
        # Any other token: dispatch to block_item. After block_item
        # returns, close re-evaluates and we either match \`}\` or
        # dispatch the next item.
        { s: '#ANY_C_TOKEN' b: 1 p: 'block_item' g: 'cs-item' }
      ]
    }

    # ---- statement-level rules (phase B4.2, unwired) ----------------
    #
    # block_item, statement, expression_statement, and jump_statement
    # are defined here in the shapes the legacy \`structure.ts\` post-
    # process produces today (see parseBlockItem / parseStatement /
    # parseJumpStatement / parseExpressionStatement). They are NOT yet
    # reachable from compound_statement — that rewiring lands together
    # with phase B3.3 (function definitions) and a gate that picks
    # function bodies the new grammar can fully cover.
    #
    # Defining the rule shapes now (without wiring) lets the next
    # phase focus on the gate logic + the cutover, rather than also
    # designing rule shapes under deadline pressure.

    # block_item: declaration | statement.
    # Dispatches on the head token: a recognised type-spec head
    # (storage class, simple type keyword, typedef-name) goes through
    # simple_declaration; anything else is a statement.
    block_item: {
      open: [
        { s: '#STORAGE_PREFIX' b: 1 p: 'simple_declaration' g: 'bi-decl-storage' }
        { s: '#SIMPLE_TYPE_HEAD' b: 1 p: 'simple_declaration' g: 'bi-decl-type' }
        { p: 'statement' g: 'bi-stmt' }
      ]
      close: [
        { s: [] g: 'bi-end' }
      ]
    }

    # statement: dispatch on head token.
    # Phase B4.2.1 covers expression_statement, jump_statement, the
    # empty \`;\` statement, and nested compound_statement.
    # Phase B4.2.2 adds if/while/do/switch (paren-condition statements).
    # Phase B4.2.3 adds for_statement and labeled_statement (case /
    #   default / ID-label).
    # Phase B4.2.4+ extends with asm/preprocessor.
    statement: {
      open: [
        # Nested block: \`{ … }\`
        { s: 'PUNC_LBRACE' b: 1 p: 'compound_statement' g: 'stmt-cs' }
        # Empty statement: \`;\`
        { s: 'PUNC_SEMI' a: '@stmt-empty' g: 'stmt-empty' }
        # Selection / iteration statements (paren-condition)
        { s: 'KW_IF' b: 1 p: 'if_statement' g: 'stmt-if' }
        { s: 'KW_WHILE' b: 1 p: 'while_statement' g: 'stmt-while' }
        { s: 'KW_DO' b: 1 p: 'do_statement' g: 'stmt-do' }
        { s: 'KW_SWITCH' b: 1 p: 'switch_statement' g: 'stmt-switch' }
        { s: 'KW_FOR' b: 1 p: 'for_statement' g: 'stmt-for' }
        # Labeled statements
        { s: 'KW_CASE' b: 1 p: 'labeled_statement' g: 'stmt-case' }
        { s: 'KW_DEFAULT' b: 1 p: 'labeled_statement' g: 'stmt-default' }
        { s: 'ID PUNC_COLON' b: 2 p: 'labeled_statement' g: 'stmt-label' }
        # Jump statements
        { s: 'KW_RETURN' b: 1 p: 'jump_statement' g: 'stmt-return' }
        { s: 'KW_BREAK' b: 1 p: 'jump_statement' g: 'stmt-break' }
        { s: 'KW_CONTINUE' b: 1 p: 'jump_statement' g: 'stmt-continue' }
        { s: 'KW_GOTO' b: 1 p: 'jump_statement' g: 'stmt-goto' }
        # [extension: gcc-asm] inline assembly inside a body
        { s: 'KW_ASM' c: '@extended-on' b: 1 p: 'asm_statement'
          g: 'stmt-asm' }
        { s: 'KW___ASM' c: '@extended-on' b: 1 p: 'asm_statement'
          g: 'stmt-asm-1' }
        { s: 'KW___ASM__' c: '@extended-on' b: 1 p: 'asm_statement'
          g: 'stmt-asm-2' }
        # [extension: preprocessor] preprocessor line inside a body
        # (rare but legal).
        { s: 'PP_HASH' c: '@extended-on' b: 1 p: 'preprocessor_line'
          g: 'stmt-pp' }
        # Expression statement (default fallthrough)
        { p: 'expression_statement' g: 'stmt-expr' }
      ]
      close: [
        { s: [] g: 'stmt-end' }
      ]
    }

    # expression_statement: <expr> \`;\`
    # Descends into val (the @jsonic/expr-driven expression rule) and
    # then takes the trailing \`;\`. Empty \`;\` is handled by statement's
    # PUNC_SEMI alt before this rule is entered.
    expression_statement: {
      open: [
        { p: 'val' a: '@es-take-expr' g: 'es-expr' }
      ]
      close: [
        { s: 'PUNC_SEMI' a: '@es-finalize' g: 'es-end' }
      ]
    }

    # jump_statement:
    #   return <expr>? ;
    #   break ;
    #   continue ;
    #   goto ID ;
    # The keyword sets jumpKind on the node; close-state alts decide
    # whether to take a label (goto), an expression (return), or just
    # the trailing \`;\`. r: re-enters so the post-label / post-expr
    # close pass can match \`;\`.
    jump_statement: {
      open: [
        { c: '@js-reentry' s: [] g: 'js-reentry' }
        { s: 'KW_RETURN' a: '@js-take-keyword' g: 'js-return' }
        { s: 'KW_BREAK' a: '@js-take-keyword' g: 'js-break' }
        { s: 'KW_CONTINUE' a: '@js-take-keyword' g: 'js-continue' }
        { s: 'KW_GOTO' a: '@js-take-keyword' g: 'js-goto' }
      ]
      close: [
        { s: 'PUNC_SEMI' a: '@js-finalize' g: 'js-end' }
        { c: '@js-needs-label' s: 'ID' a: '@js-take-label'
          r: 'jump_statement' g: 'js-take-label' }
        { c: '@js-needs-expr' p: 'val' a: '@js-take-expr' g: 'js-take-expr' }
      ]
    }

    # paren_condition: \`( <expr> )\`
    # Used inside if/while/do/switch as the controlling expression
    # wrapper. The legacy CST exposes the parens as concrete tokens
    # alongside the expression child; this rule preserves that.
    paren_condition: {
      open: [
        { s: 'PUNC_LPAREN' a: '@pc-open' g: 'pc-open' }
      ]
      close: [
        { s: 'PUNC_RPAREN' a: '@pc-close' g: 'pc-end' }
        { p: 'val' a: '@pc-take-expr' g: 'pc-expr' }
      ]
    }

    # if_statement: \`if ( cond ) then-stmt (else else-stmt)?\`
    # Multi-stage close: first take paren_condition, then the then-
    # branch (any statement), then optionally \`else\` + else-branch.
    if_statement: {
      open: [
        { s: 'KW_IF' a: '@if-take-keyword' g: 'if-kw' }
      ]
      close: [
        { c: '@if-needs-cond' s: 'PUNC_LPAREN' b: 1
          p: 'paren_condition' g: 'if-cond' }
        { c: '@if-needs-then' p: 'statement' g: 'if-then' }
        { c: '@if-needs-else-kw' s: 'KW_ELSE' a: '@if-take-else-kw'
          g: 'if-else-kw' }
        { c: '@if-needs-else-body' p: 'statement' g: 'if-else-body' }
        { s: [] g: 'if-end' }
      ]
    }

    # while_statement: \`while ( cond ) body\`
    while_statement: {
      open: [
        { s: 'KW_WHILE' a: '@while-take-keyword' g: 'while-kw' }
      ]
      close: [
        { c: '@while-needs-cond' s: 'PUNC_LPAREN' b: 1
          p: 'paren_condition' g: 'while-cond' }
        { c: '@while-needs-body' p: 'statement' g: 'while-body' }
        { s: [] g: 'while-end' }
      ]
    }

    # do_statement: \`do body while ( cond ) ;\`
    do_statement: {
      open: [
        { s: 'KW_DO' a: '@do-take-keyword' g: 'do-kw' }
      ]
      close: [
        { c: '@do-needs-body' p: 'statement' g: 'do-body' }
        { c: '@do-needs-while' s: 'KW_WHILE' a: '@do-take-while'
          g: 'do-while-kw' }
        { c: '@do-needs-cond' s: 'PUNC_LPAREN' b: 1
          p: 'paren_condition' g: 'do-cond' }
        { c: '@do-needs-semi' s: 'PUNC_SEMI' a: '@do-take-semi'
          g: 'do-end' }
        { s: [] g: 'do-fallthrough' }
      ]
    }

    # switch_statement: \`switch ( ctrl ) body\`
    switch_statement: {
      open: [
        { s: 'KW_SWITCH' a: '@switch-take-keyword' g: 'switch-kw' }
      ]
      close: [
        { c: '@switch-needs-cond' s: 'PUNC_LPAREN' b: 1
          p: 'paren_condition' g: 'switch-cond' }
        { c: '@switch-needs-body' p: 'statement' g: 'switch-body' }
        { s: [] g: 'switch-end' }
      ]
    }

    # ---- for_statement family (phase B4.2.3) ------------------------
    #
    # for_statement      \`for ( init ; cond ; iter ) body\`
    # for_controls         the \`( … )\` wrapper, with three slots
    # for_init             { value: declaration | <expr> | empty }
    # for_cond             { value: <expr> | empty }
    # for_iter             { value: <expr> | empty }
    #
    # The init slot can be a full declaration (which terminates with
    # its own \`;\`) or an expression (in which case for_init takes the
    # trailing \`;\` itself). The cond and iter slots are pure
    # expressions; cond ends with \`;\`, iter ends at the closing \`)\`
    # which for_controls then consumes.

    for_statement: {
      open: [
        { s: 'KW_FOR' a: '@for-take-keyword' g: 'for-kw' }
      ]
      close: [
        { c: '@for-needs-controls' s: 'PUNC_LPAREN' b: 1
          p: 'for_controls' g: 'for-controls' }
        { c: '@for-needs-body' p: 'statement' g: 'for-body' }
        { s: [] g: 'for-end' }
      ]
    }

    for_controls: {
      open: [
        { s: 'PUNC_LPAREN' a: '@fc-open' p: 'for_init' g: 'fc-open' }
      ]
      close: [
        { c: '@fc-needs-cond' p: 'for_cond' g: 'fc-cond' }
        { c: '@fc-needs-iter' p: 'for_iter' g: 'fc-iter' }
        { s: 'PUNC_RPAREN' a: '@fc-close' g: 'fc-end' }
      ]
    }

    for_init: {
      open: [
        # Empty init: bare \`;\`
        { s: 'PUNC_SEMI' a: '@fi-empty-take-semi' g: 'fi-empty' }
        # Declaration init (declaration eats its own trailing \`;\`)
        { s: '#STORAGE_PREFIX' b: 1 p: 'simple_declaration'
          a: '@fi-mark-decl' g: 'fi-decl-storage' }
        { s: '#SIMPLE_TYPE_HEAD' b: 1 p: 'simple_declaration'
          a: '@fi-mark-decl' g: 'fi-decl-type' }
        # Expression init: take expression then \`;\`
        { p: 'val' a: '@fi-mark-expr' g: 'fi-expr' }
      ]
      close: [
        { c: '@fi-needs-semi' s: 'PUNC_SEMI' a: '@fi-take-semi' g: 'fi-semi' }
        { s: [] g: 'fi-end' }
      ]
    }

    for_cond: {
      open: [
        # Empty cond: bare \`;\`
        { s: 'PUNC_SEMI' a: '@fcond-empty-take-semi' g: 'fcond-empty' }
        # Expression cond: take expression then \`;\`
        { p: 'val' a: '@fcond-mark-expr' g: 'fcond-expr' }
      ]
      close: [
        { c: '@fcond-needs-semi' s: 'PUNC_SEMI'
          a: '@fcond-take-semi' g: 'fcond-semi' }
        { s: [] g: 'fcond-end' }
      ]
    }

    for_iter: {
      open: [
        # Empty iter: backstep the \`)\` so for_controls can take it.
        { s: 'PUNC_RPAREN' b: 1 a: '@fiter-empty' g: 'fiter-empty' }
        # Expression iter: take expression up to \`)\`.
        { p: 'val' a: '@fiter-mark-expr' g: 'fiter-expr' }
      ]
      close: [
        { s: [] g: 'fiter-end' }
      ]
    }

    # ---- asm_statement (phase B4.2.4, opaque-token form) ------------
    #
    # GCC inline asm: \`__asm__ volatile? goto? ( template : … ) ;\`.
    # Phase B4.2.4 captures the whole statement as a flat token-list
    # under an asm_statement node — qualifiers / template / operand
    # sections are NOT yet broken out (that's a follow-up). The shape
    # is enough to unblock the body-supportedness gate.
    # asm_statement (phase C.8 — structured form):
    #   <kw> <qualifier>* ( <template>
    #     (: <operand-list>)?    -- outputs
    #     (: <operand-list>)?    -- inputs
    #     (: <clobber-list>)?    -- clobbers
    #     (: <label-list>)?      -- labels
    #   ) ;?
    #
    # State machine across r:-recursion via rule.k.phase.
    asm_statement: {
      open: [
        { c: '@asm-reentry' s: [] g: 'asm-reentry' }
        { s: 'KW_ASM' a: '@asm-take-keyword' g: 'asm-asm' }
        { s: 'KW___ASM' a: '@asm-take-keyword' g: 'asm-asm-1' }
        { s: 'KW___ASM__' a: '@asm-take-keyword' g: 'asm-asm-2' }
      ]
      close: [
        # Qualifier loop (volatile/inline/goto + GCC variants).
        { c: '@asm-need-qualifier' s: 'KW_VOLATILE'
          a: '@asm-take-qualifier' r: 'asm_statement' g: 'asm-q-v' }
        { c: '@asm-need-qualifier' s: 'KW___VOLATILE__'
          a: '@asm-take-qualifier' r: 'asm_statement' g: 'asm-q-vv' }
        { c: '@asm-need-qualifier' s: 'KW___VOLATILE'
          a: '@asm-take-qualifier' r: 'asm_statement' g: 'asm-q-v3' }
        { c: '@asm-need-qualifier' s: 'KW_INLINE'
          a: '@asm-take-qualifier' r: 'asm_statement' g: 'asm-q-i' }
        { c: '@asm-need-qualifier' s: 'KW___INLINE__'
          a: '@asm-take-qualifier' r: 'asm_statement' g: 'asm-q-ii' }
        { c: '@asm-need-qualifier' s: 'KW___INLINE'
          a: '@asm-take-qualifier' r: 'asm_statement' g: 'asm-q-i3' }
        { c: '@asm-need-qualifier' s: 'KW_GOTO'
          a: '@asm-take-qualifier' r: 'asm_statement' g: 'asm-q-g' }
        # Take \`(\` to open the operand list.
        { c: '@asm-need-lparen' s: 'PUNC_LPAREN'
          a: '@asm-take-lparen' r: 'asm_statement' g: 'asm-lparen' }
        # Take template (one string-literal val).
        { c: '@asm-need-template' p: 'asm_template' g: 'asm-tpl' }
        # Section-introducing \`:\`.
        { c: '@asm-need-section-colon' s: 'PUNC_COLON'
          a: '@asm-take-section-colon' r: 'asm_statement'
          g: 'asm-section-colon' }
        # Section content.
        { c: '@asm-need-section' p: 'asm_section' g: 'asm-section' }
        # Take \`)\`.
        { c: '@asm-need-rparen' s: 'PUNC_RPAREN'
          a: '@asm-take-rparen' r: 'asm_statement' g: 'asm-rparen' }
        # Take \`;\`.
        { c: '@asm-need-semi' s: 'PUNC_SEMI'
          a: '@asm-take-semi' g: 'asm-end' }
        { s: [] g: 'asm-fallthrough' }
      ]
    }

    # asm_template: a string-literal expression (val will produce a
    # literal_expression node; possibly via string_atom for adjacent
    # strings).
    asm_template: {
      open: [
        { p: 'val' g: 'tpl-val' }
      ]
      close: [
        { s: [] g: 'tpl-end' }
      ]
    }

    # asm_section: one operand-list / clobber-list / label-list.
    # The kind is determined by the parent's k.sectionIdx (0/1 →
    # operand, 2 → clobber, 3 → label). Each iteration takes one
    # item; the close-state \`,\` alt r:-recurses if more items follow.
    asm_section: {
      open: [
        # Take the first / post-comma item if t0 starts an item of
        # the appropriate kind (the cond peeks t0). On empty
        # section or end (t0 = \`:\` or \`)\`), all needs-* fail and
        # the s:[] fallback exits cleanly.
        { c: '@asec-needs-operand' p: 'asm_operand' g: 'asec-op' }
        { c: '@asec-needs-clobber' p: 'asm_clobber' g: 'asec-cl' }
        { c: '@asec-needs-label' p: 'asm_label_ref' g: 'asec-lbl' }
        # Empty section / past last item.
        { s: [] g: 'asec-empty-or-end' }
      ]
      close: [
        # Inter-item comma: take and r:-recurse for the next item.
        { s: 'PUNC_COMMA' a: '@asec-take-comma'
          r: 'asm_section' g: 'asec-comma' }
        # Next is \`:\` (next section) or \`)\` (end) — leave for parent.
        { s: [] g: 'asec-end' }
      ]
    }

    # asm_operand: opaque-token absorber. Phase C.8.b will sub-
    # structure it ([asm-name]? <constraint-string> ( <expr> )) once
    # the rest of the asm grammar is verified.
    asm_operand: {
      open: [
        { c: '@aop-reentered' s: [] g: 'aop-reentry' }
        { s: '#ANY_C_TOKEN' a: '@aop-take' g: 'aop-first' }
      ]
      close: [
        { c: '@aop-stop' s: 'PUNC_COMMA' b: 1 g: 'aop-end-comma' }
        { c: '@aop-stop' s: 'PUNC_COLON' b: 1 g: 'aop-end-colon' }
        { c: '@aop-stop' s: 'PUNC_RPAREN' b: 1 g: 'aop-end-rparen' }
        { s: '#ANY_C_TOKEN' a: '@aop-take'
          r: 'asm_operand' g: 'aop-more' }
      ]
    }

    # asm_clobber: a single LIT_STRING.
    asm_clobber: {
      open: [
        { s: 'LIT_STRING' a: '@acl-take' g: 'acl-take' }
      ]
      close: [
        { s: [] g: 'acl-end' }
      ]
    }

    # asm_label_ref: a single ID.
    asm_label_ref: {
      open: [
        { s: 'ID' a: '@alr-take' g: 'alr-take' }
      ]
      close: [
        { s: [] g: 'alr-end' }
      ]
    }

    # ---- preprocessor_line (phase B4.2.4, opaque to PP_NEWLINE) -----
    #
    # A \`#-line\` inside a function body. Captured as a flat token-list
    # under a preprocessor_line node up to and including the trailing
    # PP_NEWLINE. Structured directive shapes (#define, #include, etc)
    # remain on the legacy chomp+structure path until phase C+.
    preprocessor_line: {
      open: [
        { c: '@pp-reentry' s: [] g: 'pp-reentry' }
        { s: 'PP_HASH' a: '@pp-take-hash' g: 'pp-hash' }
      ]
      close: [
        { s: 'PP_NEWLINE' a: '@pp-take-newline' g: 'pp-end' }
        { s: '#ZZ' b: 1 g: 'pp-eof' }
        { s: '#ANY_C_TOKEN' a: '@pp-absorb' r: 'preprocessor_line' g: 'pp-tok' }
      ]
    }

    # ---- labeled_statement (phase B4.2.3) ---------------------------
    #
    # case <expr> :  body   → labelKind: 'case'
    # default     :  body   → labelKind: 'default'
    # ID          :  body   → labelKind: 'label', labelName: ID
    labeled_statement: {
      open: [
        { s: 'KW_CASE' a: '@lbl-take-case' g: 'lbl-case' }
        { s: 'KW_DEFAULT' a: '@lbl-take-default' g: 'lbl-default' }
        { s: 'ID' a: '@lbl-take-name' g: 'lbl-name' }
      ]
      close: [
        { c: '@lbl-needs-expr' p: 'val' a: '@lbl-mark-expr' g: 'lbl-expr' }
        { c: '@lbl-needs-colon' s: 'PUNC_COLON'
          a: '@lbl-take-colon' g: 'lbl-colon' }
        { c: '@lbl-needs-body' p: 'statement' g: 'lbl-body' }
        { s: [] g: 'lbl-end' }
      ]
    }

    # ---- type_name (phase C.2) --------------------------------------
    #
    # Absorbs the contents of a type-name (the body between \`(\` and
    # \`)\` in a cast, sizeof type-form, or compound literal). The
    # caller is expected to have already taken the opening \`(\`; this
    # rule consumes tokens up to (but NOT including) the matching
    # \`)\`. Inner parens / brackets are tracked so a function-pointer
    # type-name like \`int (*)(int)\` doesn't terminate prematurely.
    #
    # Phase C.2's shape captures the body as a flat token list under
    # a type_name node. Sub-structuring (declaration_specifiers,
    # abstract_declarator) is deferred to phase B5.
    type_name: {
      open: [
        # Re-entry on r:-recursion: skip without taking; close runs.
        { c: '@tn-reentered' s: [] g: 'tn-reentry' }
        # First entry: take the leading content token.
        { s: '#ANY_C_TOKEN' a: '@tn-take' g: 'tn-first' }
      ]
      close: [
        # \`)\` at depth 0: leave it for the parent rule.
        { c: '@tn-balanced' s: 'PUNC_RPAREN' b: 1 g: 'tn-end' }
        # Otherwise absorb the next token and recurse.
        { s: '#ANY_C_TOKEN' a: '@tn-take' r: 'type_name' g: 'tn-more' }
      ]
    }

    # ---- sizeof_type_form (phase C.2) -------------------------------
    #
    # \`sizeof ( type_name )\` and \`_Alignof ( type_name )\` (and GCC
    # __alignof__ / __alignof variants). Produces a unary_expression
    # with op set to the keyword and operand set to the type_name
    # node. The expression-form (\`sizeof <unary>\`) is handled by
    # @jsonic/expr's prefix-op machinery via C_OP_TABLE — a val.open
    # alt picks this rule only when the lookahead matches
    # \`<keyword> ( <type-head>\`.
    sizeof_type_form: {
      open: [
        { s: 'KW_SIZEOF' a: '@stf-take-kw' g: 'stf-sizeof' }
        { s: 'KW__ALIGNOF' a: '@stf-take-kw' g: 'stf-alignof' }
        { s: 'KW_ALIGNOF' a: '@stf-take-kw' g: 'stf-alignof-2' }
        { s: 'KW___ALIGNOF__' a: '@stf-take-kw' g: 'stf-alignof-3' }
        { s: 'KW___ALIGNOF' a: '@stf-take-kw' g: 'stf-alignof-4' }
      ]
      close: [
        { c: '@stf-needs-lparen' s: 'PUNC_LPAREN'
          a: '@stf-take-lparen' p: 'type_name' g: 'stf-lparen' }
        { c: '@stf-needs-rparen' s: 'PUNC_RPAREN'
          a: '@stf-take-rparen' g: 'stf-rparen' }
        { s: [] g: 'stf-end' }
      ]
    }

    # ---- cast_or_compound_literal (phase C.3) -----------------------
    #
    # \`( type_name ) <unary>\`           → cast_expression
    # \`( type_name ) { initializer }\`   → compound_literal (pending C.4
    #                                      initializer_list rule)
    #
    # The val.open alt that dispatches here matches \`( <type-head>\`
    # so we know the parens contain a type-name. After taking \`)\` we
    # peek the next token: \`{\` selects the compound-literal arm, any
    # other token is the cast-expression arm.
    cast_or_compound_literal: {
      open: [
        # Re-entry on r: (after taking \`)\`): preserve state, fall
        # through to close.
        { c: '@cocl-reentered' s: [] g: 'cocl-reentry' }
        { s: 'PUNC_LPAREN' a: '@cocl-take-lparen'
          p: 'type_name' g: 'cocl-open' }
      ]
      close: [
        # Take the closing \`)\` then r: back through open so the
        # next close pass can decide cast vs compound literal.
        { c: '@cocl-needs-rparen' s: 'PUNC_RPAREN'
          a: '@cocl-take-rparen' r: 'cast_or_compound_literal'
          g: 'cocl-rparen' }
        # Compound literal: \`(type){…}\` — body is an initializer_list.
        { c: '@cocl-needs-decision' s: 'PUNC_LBRACE'
          a: '@cocl-mark-cl' b: 1 p: 'initializer_list'
          g: 'cocl-cl' }
        # Cast: parse the operand as an expression. (Pratt-driven
        # val absorbs the full operand; precedence inside cast is
        # documented as a phase-C.x follow-up if a test case fails.)
        { c: '@cocl-needs-decision' a: '@cocl-mark-cast'
          p: 'val' g: 'cocl-cast' }
        { s: [] a: '@cocl-finalize' g: 'cocl-end' }
      ]
    }

    # ---- initializer_list family (phase C.4) ------------------------
    #
    # \`{ <item>, <item>, … }\` — used as the RHS of \`=\` in declarators
    # and as the body of compound literals. Each item is either:
    #   <expr>                    (plain value)
    #   { <list-body> }           (nested initializer list)
    #   <designation> = <value>   (designated initialiser)
    # where designation is one or more \`.<id>\` / \`[<expr>]\` segments.

    initializer_list: {
      open: [
        # Re-entry from r:-recursion preserves the in-progress node.
        { c: '@il-reentered' s: [] g: 'il-reentry' }
        { s: 'PUNC_LBRACE' a: '@il-take-lbrace' g: 'il-open' }
      ]
      close: [
        # Closing \`}\` (or empty list).
        { s: 'PUNC_RBRACE' a: '@il-take-rbrace' g: 'il-end' }
        # Inter-item comma. r:-recurse so we keep iterating.
        { s: 'PUNC_COMMA' a: '@il-take-comma'
          r: 'initializer_list' g: 'il-comma' }
        # Take next item.
        { p: 'initializer_item' g: 'il-item' }
      ]
    }

    initializer_item: {
      open: [
        # Re-entry after r: from the eq alt below.
        { c: '@ii-reentered' s: [] g: 'ii-reentry' }
        # Designation forms: leading \`.\` or \`[\` belong to a designation.
        { s: 'PUNC_DOT' b: 1 p: 'designation'
          a: '@ii-mark-has-desig' g: 'ii-desig' }
        { s: 'PUNC_LBRACKET' b: 1 p: 'designation'
          a: '@ii-mark-has-desig' g: 'ii-idx-desig' }
        # Plain nested initializer-list (no designation).
        { s: 'PUNC_LBRACE' b: 1 p: 'initializer_list'
          a: '@ii-mark-nested' g: 'ii-nested' }
        # Plain expression value (no designation).
        { p: 'val' g: 'ii-expr' }
      ]
      close: [
        # After designation, take \`=\` and r:-recurse so the next pass
        # picks up the value.
        { c: '@ii-needs-eq' s: 'PUNC_ASSIGN'
          a: '@ii-take-eq' r: 'initializer_item' g: 'ii-eq' }
        # After \`=\`, take a nested initializer list as the value.
        { c: '@ii-needs-value' s: 'PUNC_LBRACE'
          b: 1 p: 'initializer_list'
          a: '@ii-mark-nested' g: 'ii-val-list' }
        # After \`=\`, take an expression as the value.
        { c: '@ii-needs-value' p: 'val' g: 'ii-val' }
        { s: [] g: 'ii-end' }
      ]
    }

    # designation: 1+ chained designators (e.g. \`.x.y[0]\`).
    designation: {
      open: [
        { p: 'designator' g: 'desig-first' }
      ]
      close: [
        { s: 'PUNC_DOT' b: 1 p: 'designator' g: 'desig-more-dot' }
        { s: 'PUNC_LBRACKET' b: 1 p: 'designator'
          g: 'desig-more-lbracket' }
        { s: [] g: 'desig-end' }
      ]
    }

    # designator: \`.ID\`  → member_designator
    #             \`[ <expr> ]\`  → index_designator
    designator: {
      open: [
        { s: 'PUNC_DOT' a: '@dr-take-dot' g: 'dr-dot' }
        { s: 'PUNC_LBRACKET' a: '@dr-take-lbracket'
          p: 'val' g: 'dr-lbracket' }
      ]
      close: [
        { c: '@dr-needs-id' s: 'ID' a: '@dr-take-id' g: 'dr-id' }
        { c: '@dr-needs-rbracket' s: 'PUNC_RBRACKET'
          a: '@dr-take-rbracket' g: 'dr-rbracket' }
        { s: [] g: 'dr-end' }
      ]
    }

    # ---- generic_selection (phase C.5) ------------------------------
    #
    # \`_Generic ( ctrl-expr , association ( , association )* )\`
    # association :=  type-name \`:\` <expr>
    #              |  \`default\`  \`:\` <expr>
    #
    # The rule walks a small state machine via rule.k to take, in
    # order: \`_Generic\`, \`(\`, controlling expression, \`,\`,
    # association, then alternating \`,\` / association up to \`)\`.
    generic_selection: {
      open: [
        # Re-entry: any matched-open path is signalled via k.kwTaken.
        { c: '@gs-reentered' s: [] g: 'gs-reentry' }
        { s: 'KW__GENERIC' a: '@gs-take-kw' g: 'gs-kw' }
      ]
      close: [
        { c: '@gs-need-lparen' s: 'PUNC_LPAREN'
          a: '@gs-take-lparen' r: 'generic_selection' g: 'gs-lparen' }
        { c: '@gs-need-ctrl'
          p: 'generic_controlling_expression' g: 'gs-ctrl' }
        { c: '@gs-need-comma' s: 'PUNC_COMMA'
          a: '@gs-take-comma' r: 'generic_selection' g: 'gs-comma' }
        { c: '@gs-need-association'
          p: 'generic_association' g: 'gs-assoc' }
        { c: '@gs-after-association' s: 'PUNC_COMMA'
          a: '@gs-take-comma' r: 'generic_selection' g: 'gs-more-comma' }
        { c: '@gs-need-rparen' s: 'PUNC_RPAREN'
          a: '@gs-take-rparen' g: 'gs-rparen' }
        { s: [] g: 'gs-end' }
      ]
    }

    # generic_controlling_expression: wraps the controlling expression
    # in its own node so the legacy CST shape (with \`.expression\`
    # field) is preserved.
    generic_controlling_expression: {
      open: [
        { p: 'val' g: 'gce-val' }
      ]
      close: [
        { s: [] g: 'gce-end' }
      ]
    }

    # generic_association: a single \`<type-name>:<value>\` or
    # \`default:<value>\` pair.
    generic_association: {
      open: [
        # Re-entry for r:-recursion after \`:\` has been taken.
        { c: '@ga-reentered' s: [] g: 'ga-reentry' }
        { s: 'KW_DEFAULT' a: '@ga-take-default' g: 'ga-default' }
        { p: 'type_name_assoc' a: '@ga-mark-type' g: 'ga-type' }
      ]
      close: [
        { c: '@ga-need-colon' s: 'PUNC_COLON'
          a: '@ga-take-colon' r: 'generic_association' g: 'ga-colon' }
        { c: '@ga-need-value' p: 'val' g: 'ga-value' }
        { s: [] g: 'ga-end' }
      ]
    }

    # type_name_assoc: like type_name but stops at \`:\` or \`,\` or \`)\`
    # at depth 0 (rather than \`)\` only). Used inside generic_association.
    type_name_assoc: {
      open: [
        { c: '@tna-reentered' s: [] g: 'tna-reentry' }
        { s: '#ANY_C_TOKEN' a: '@tna-take' g: 'tna-first' }
      ]
      close: [
        { c: '@tna-stop' s: 'PUNC_COLON' b: 1 g: 'tna-end-colon' }
        { c: '@tna-stop' s: 'PUNC_COMMA' b: 1 g: 'tna-end-comma' }
        { c: '@tna-stop' s: 'PUNC_RPAREN' b: 1 g: 'tna-end-rparen' }
        { s: '#ANY_C_TOKEN' a: '@tna-take'
          r: 'type_name_assoc' g: 'tna-more' }
      ]
    }

    # ---- statement_expression (phase C.6) ---------------------------
    #
    # GCC extension: \`( { … } )\` evaluates the compound statement and
    # yields the value of its last expression-statement. Captured here
    # as a structured node with the inner compound_statement as a
    # child.
    statement_expression: {
      open: [
        { s: 'PUNC_LPAREN' a: '@se-take-lparen'
          p: 'compound_statement' g: 'se-open' }
      ]
      close: [
        { s: 'PUNC_RPAREN' a: '@se-take-rparen' g: 'se-end' }
        { s: [] g: 'se-fallthrough' }
      ]
    }

    # ---- string_atom (phase C.7) -----------------------------------
    #
    # Adjacent string literals concatenate into a single
    # literal_expression node (\`"foo" "bar"\` → one literal). The
    # rule takes the first LIT_STRING in open, then loops via r: to
    # absorb any further LIT_STRINGs that follow.
    string_atom: {
      open: [
        { c: '@sa-reentered' s: [] g: 'sa-reentry' }
        { s: 'LIT_STRING' a: '@sa-take' g: 'sa-first' }
      ]
      close: [
        { s: 'LIT_STRING' a: '@sa-take' r: 'string_atom' g: 'sa-more' }
        { s: [] g: 'sa-end' }
      ]
    }

    # ---- compound_literal_body (phase C.3 placeholder) --------------
    #
    # Phase C.4 superseded this placeholder with initializer_list.
    # Kept as an alias rule so any leftover dispatch sites still resolve.
    compound_literal_body: {
      open: [
        { s: 'PUNC_LBRACE' b: 1 p: 'initializer_list' g: 'clb-delegate' }
      ]
      close: [
        { s: [] g: 'clb-end' }
      ]
    }

    # ---- struct / union specifier (phase F.1) -----------------------
    #
    # \`struct\` | \`union\`  <tag>?  ( \`{\` member-list \`}\` )?
    #
    # The tag and body are independently optional (a forward
    # declaration is just \`struct S;\`; an anonymous struct
    # definition is \`struct { … } x;\`). State machine across
    # r:-recursion via rule.k.
    struct_specifier: {
      open: [
        { c: '@ss-reentered' s: [] g: 'ss-reentry' }
        { s: 'KW_STRUCT' a: '@ss-take-kw' g: 'ss-struct' }
        { s: 'KW_UNION' a: '@ss-take-kw' g: 'ss-union' }
      ]
      close: [
        # Optional tag name (ID or TYPEDEF_NAME).
        { c: '@ss-need-tag' s: 'ID' a: '@ss-take-tag'
          r: 'struct_specifier' g: 'ss-tag' }
        { c: '@ss-need-tag' s: 'TYPEDEF_NAME' a: '@ss-take-tag'
          r: 'struct_specifier' g: 'ss-tag-td' }
        # Optional body.
        { c: '@ss-need-body' s: 'PUNC_LBRACE' b: 1
          p: 'member_decl_list' g: 'ss-body' }
        { s: [] g: 'ss-end' }
      ]
    }

    # ---- member_decl_list (phase F.2) -------------------------------
    member_decl_list: {
      open: [
        { c: '@mdl-reentered' s: [] g: 'mdl-reentry' }
        { s: 'PUNC_LBRACE' a: '@mdl-take-lbrace' g: 'mdl-open' }
      ]
      close: [
        { s: 'PUNC_RBRACE' a: '@mdl-take-rbrace' g: 'mdl-end' }
        # GCC: a stray \`;\` is allowed as an empty member.
        { s: 'PUNC_SEMI' a: '@mdl-take-empty-semi'
          r: 'member_decl_list' g: 'mdl-empty' }
        { p: 'struct_declaration' r: 'member_decl_list' g: 'mdl-member' }
      ]
    }

    # struct_declaration: specifier_qualifier_list struct_declarator_list? \`;\`.
    # Re-uses simple_declaration's spec absorption via spec_loop, but
    # the spec node is renamed to \`specifier_qualifier_list\` to match
    # the legacy CST.
    struct_declaration: {
      open: [
        { c: '@sd-reentered' s: [] g: 'sd-reentry' }
        { s: '#STORAGE_PREFIX' a: '@sd-absorb-spec-storage'
          p: 'spec_loop' g: 'sd-storage' }
        { s: '#SIMPLE_TYPE_HEAD' a: '@sd-absorb-spec-type'
          p: 'spec_loop' g: 'sd-type' }
      ]
      close: [
        # First struct_declarator (after specs).
        { c: '@sd-need-decl-first' s: 'ID' b: 1
          p: 'struct_declarator' g: 'sd-decl' }
        { c: '@sd-need-decl-first' s: 'PUNC_STAR' b: 1
          p: 'struct_declarator' g: 'sd-decl-ptr' }
        { c: '@sd-need-decl-first' s: 'PUNC_COLON' b: 1
          p: 'struct_declarator' g: 'sd-decl-bf' }
        # Subsequent declarators after \`,\`.
        { s: 'PUNC_COMMA' a: '@sd-take-comma' p: 'struct_declarator'
          g: 'sd-decl-comma' }
        # Trailing \`;\`.
        { s: 'PUNC_SEMI' a: '@sd-take-semi' g: 'sd-end' }
      ]
    }

    # struct_declarator: declarator (\`:\` const-expr)?
    #                  | \`:\` const-expr           (anonymous bitfield)
    struct_declarator: {
      open: [
        { c: '@sdr-reentered' s: [] g: 'sdr-reentry' }
        # Anonymous bitfield: starts with \`:\`.
        { s: 'PUNC_COLON' b: 1 p: 'bitfield_width'
          a: '@sdr-mark-anon-bf' g: 'sdr-bf-only' }
        # Named declarator (with optional bitfield in close).
        { s: 'ID' b: 1 p: 'init_declarator' g: 'sdr-decl' }
        { s: 'PUNC_STAR' b: 1 p: 'init_declarator' g: 'sdr-decl-ptr' }
      ]
      close: [
        # Optional bitfield after the declarator name.
        { c: '@sdr-need-bf' s: 'PUNC_COLON' b: 1
          p: 'bitfield_width' g: 'sdr-bf' }
        { s: [] g: 'sdr-end' }
      ]
    }

    # bitfield_width: \`:\` <const-expr>. The const-expr is a val
    # bounded by the surrounding \`,\` or \`;\` or attribute-spec head.
    bitfield_width: {
      open: [
        { s: 'PUNC_COLON' a: '@bfw-take-colon' p: 'val' g: 'bfw-colon' }
      ]
      close: [
        { s: [] g: 'bfw-end' }
      ]
    }

    # ---- enum_specifier (phase F.3) ---------------------------------
    #
    # \`enum\` <tag>? (\`:\` <type-spec>)? ( \`{\` enumerator-list \`}\` )?
    enum_specifier: {
      open: [
        { c: '@es-tag-reentered' s: [] g: 'es-reentry' }
        { s: 'KW_ENUM' a: '@es-take-kw' g: 'es-enum' }
      ]
      close: [
        { c: '@es-need-tag' s: 'ID' a: '@es-take-tag'
          r: 'enum_specifier' g: 'es-tag' }
        { c: '@es-need-tag' s: 'TYPEDEF_NAME' a: '@es-take-tag'
          r: 'enum_specifier' g: 'es-tag-td' }
        # C23 fixed-underlying-type: \`enum E : int { … }\`.
        { c: '@es-need-utype' s: 'PUNC_COLON'
          a: '@es-take-utype-colon' p: 'enum_utype_specs'
          r: 'enum_specifier' g: 'es-utype' }
        { c: '@es-need-body' s: 'PUNC_LBRACE' b: 1
          p: 'enumerator_list' g: 'es-body' }
        { s: [] g: 'es-end' }
      ]
    }

    # enum_utype_specs: a small specifier list for the enum
    # underlying type. Reuses spec_loop to absorb keywords.
    enum_utype_specs: {
      open: [
        { s: '#SIMPLE_TYPE_HEAD' a: '@eus-absorb-spec'
          p: 'spec_loop' g: 'eus-type' }
      ]
      close: [
        { s: [] g: 'eus-end' }
      ]
    }

    # ---- enumerator_list / enumerator (phase F.4) -------------------
    enumerator_list: {
      open: [
        { c: '@el-reentered' s: [] g: 'el-reentry' }
        { s: 'PUNC_LBRACE' a: '@el-take-lbrace' g: 'el-open' }
      ]
      close: [
        { s: 'PUNC_RBRACE' a: '@el-take-rbrace' g: 'el-end' }
        { s: 'PUNC_COMMA' a: '@el-take-comma'
          r: 'enumerator_list' g: 'el-comma' }
        # Push enumerator for the next item; on return, re-fire close
        # (the parser stays in close state). No \`r:\` — that would
        # fight with \`p:\` and is effectively dead code.
        { p: 'enumerator' g: 'el-enum' }
      ]
    }

    enumerator: {
      open: [
        { c: '@enr-reentered' s: [] g: 'enr-reentry' }
        { s: 'ID' a: '@enr-take-name' g: 'enr-id' }
        { s: 'TYPEDEF_NAME' a: '@enr-take-name' g: 'enr-td' }
      ]
      close: [
        # C23 attribute spec on the enumerator: \`A [[deprecated]] = 1\`.
        { s: 'PUNC_LBRACKET PUNC_LBRACKET' c: '@as23-adjacent-open'
          b: 2 p: 'attribute_spec_c23'
          r: 'enumerator' g: 'enr-attr' }
        { c: '@enr-need-eq' s: 'PUNC_ASSIGN'
          a: '@enr-take-eq' p: 'val' g: 'enr-eq' }
        { s: [] g: 'enr-end' }
      ]
    }

    # ---- attribute_spec_gcc (phase G.2) -----------------------------
    #
    # \`__attribute__ (( <items> ))\` — the inner double-paren is part
    # of the syntax (legacy GCC convention). __attribute is also
    # accepted by some toolchains.
    attribute_spec_gcc: {
      open: [
        { c: '@asg-reentered' s: [] g: 'asg-reentry' }
        { s: 'KW___ATTRIBUTE__' a: '@asg-take-kw' g: 'asg-attr' }
        { s: 'KW___ATTRIBUTE' a: '@asg-take-kw' g: 'asg-attr-1' }
      ]
      close: [
        { c: '@asg-need-outer-lparen' s: 'PUNC_LPAREN'
          a: '@asg-take-outer-lparen' r: 'attribute_spec_gcc'
          g: 'asg-outer-lp' }
        { c: '@asg-need-inner-lparen' s: 'PUNC_LPAREN'
          a: '@asg-take-inner-lparen' r: 'attribute_spec_gcc'
          g: 'asg-inner-lp' }
        { c: '@asg-need-comma' s: 'PUNC_COMMA'
          a: '@asg-take-comma' r: 'attribute_spec_gcc' g: 'asg-comma' }
        { c: '@asg-need-item' p: 'attribute_item' g: 'asg-item' }
        { c: '@asg-need-inner-rparen' s: 'PUNC_RPAREN'
          a: '@asg-take-inner-rparen' r: 'attribute_spec_gcc'
          g: 'asg-inner-rp' }
        { c: '@asg-need-outer-rparen' s: 'PUNC_RPAREN'
          a: '@asg-take-outer-rparen' g: 'asg-outer-rp' }
        { s: [] g: 'asg-end' }
      ]
    }

    # ---- attribute_spec_msvc (phase G.3) ----------------------------
    #
    # \`__declspec ( <items> )\` — single-paren form.
    attribute_spec_msvc: {
      open: [
        { c: '@asm2-reentered' s: [] g: 'asm2-reentry' }
        { s: 'KW___DECLSPEC' a: '@asm2-take-kw' g: 'asm2-decl' }
      ]
      close: [
        { c: '@asm2-need-lparen' s: 'PUNC_LPAREN'
          a: '@asm2-take-lparen' r: 'attribute_spec_msvc'
          g: 'asm2-lp' }
        { c: '@asm2-need-comma' s: 'PUNC_COMMA'
          a: '@asm2-take-comma' r: 'attribute_spec_msvc' g: 'asm2-comma' }
        { c: '@asm2-need-item' p: 'attribute_item' g: 'asm2-item' }
        { c: '@asm2-need-rparen' s: 'PUNC_RPAREN'
          a: '@asm2-take-rparen' g: 'asm2-rp' }
        { s: [] g: 'asm2-end' }
      ]
    }

    # ---- attribute_spec_c23 (phase G.1) -----------------------------
    #
    # \`[[ <items> ]]\` — two adjacent \`[\` and two adjacent \`]\` (no
    # whitespace between). The adjacency cond protects against
    # mis-matching \`[ [ x ]]\` (legal as nested array subscript).
    attribute_spec_c23: {
      open: [
        { c: '@as23-reentered' s: [] g: 'as23-reentry' }
        { s: 'PUNC_LBRACKET PUNC_LBRACKET' c: '@as23-adjacent-open'
          a: '@as23-take-open' g: 'as23-open' }
      ]
      close: [
        { c: '@as23-need-comma' s: 'PUNC_COMMA'
          a: '@as23-take-comma' r: 'attribute_spec_c23'
          g: 'as23-comma' }
        { c: '@as23-need-item' p: 'attribute_item' g: 'as23-item' }
        { c: '@as23-need-close' s: 'PUNC_RBRACKET PUNC_RBRACKET'
          c: '@as23-adjacent-close' a: '@as23-take-close'
          g: 'as23-close' }
        { s: [] g: 'as23-end' }
      ]
    }

    # ---- attribute_item (phase G.4) ---------------------------------
    #
    # name (optional \`::\` namespace) plus optional argument list.
    attribute_item: {
      open: [
        { c: '@ai-reentered' s: [] g: 'ai-reentry' }
        { s: 'ID' a: '@ai-take-name' g: 'ai-id' }
        { s: 'TYPEDEF_NAME' a: '@ai-take-name' g: 'ai-td' }
        { s: 'MACRO_NAME' a: '@ai-take-name' g: 'ai-macro' }
        # GCC attribute names can be keywords: \`__attribute__((const))\`,
        # \`__attribute__((noreturn))\` etc. Mirror legacy parseAttributeItem
        # which accepts any KW_* token in the name slot.
        { s: '#KW_TOKEN' a: '@ai-take-name' g: 'ai-kw' }
      ]
      close: [
        # C23 namespaced form: \`<prefix> :: <name>\`. Use a 2-token
        # \`s:\` so parse_alts force-fetches both \`:\` tokens (without
        # this, only the first colon is in ctx.t and the cond's
        # ctx.t[1] check sees NOTOKEN and rejects).
        { c: '@ai-need-colon-1' s: 'PUNC_COLON PUNC_COLON' b: 1
          a: '@ai-take-colon-1' r: 'attribute_item' g: 'ai-c1' }
        { c: '@ai-need-colon-2' s: 'PUNC_COLON'
          a: '@ai-take-colon-2' r: 'attribute_item' g: 'ai-c2' }
        { c: '@ai-need-prefixed-name' s: 'ID'
          a: '@ai-take-prefixed-name' r: 'attribute_item'
          g: 'ai-pname-id' }
        { c: '@ai-need-prefixed-name' s: '#KW_TOKEN'
          a: '@ai-take-prefixed-name' r: 'attribute_item'
          g: 'ai-pname-kw' }
        # Optional argument list.
        { c: '@ai-need-args' s: 'PUNC_LPAREN' b: 1
          p: 'attribute_argument_list' g: 'ai-args' }
        { s: [] g: 'ai-end' }
      ]
    }

    # ---- attribute_argument_list (phase G.4) ------------------------
    attribute_argument_list: {
      open: [
        { c: '@aal-reentered' s: [] g: 'aal-reentry' }
        { s: 'PUNC_LPAREN' a: '@aal-take-lparen' g: 'aal-open' }
      ]
      close: [
        { s: 'PUNC_RPAREN' a: '@aal-take-rparen' g: 'aal-end' }
        { s: 'PUNC_COMMA' a: '@aal-take-comma'
          r: 'attribute_argument_list' g: 'aal-comma' }
        { p: 'val' r: 'attribute_argument_list' g: 'aal-arg' }
      ]
    }

    # ---- preprocessor_directive dispatcher (phase H.1) --------------
    #
    # Routes a \`#…\` line to the appropriate typed directive rule by
    # peeking the directive name (the second token after \`#\`). On an
    # unrecognised name, falls through to a flat-token fallback.
    preprocessor_directive: {
      open: [
        # Use a 2-token \`s:\` so parse_alts force-fetches both \`#\`
        # and the directive-name token (an ID lexed from the body
        # of the directive). The cond inspects rule.o1.src to
        # distinguish #define / #undef / #include / #if family /
        # #pragma|error|warning|line. b: 2 backsteps both so the
        # sub-rule's open re-takes them in its own parse.
        { c: '@ppd-is-define' s: 'PP_HASH #ANY_C_TOKEN' b: 2
          p: 'define_directive' g: 'ppd-define' }
        { c: '@ppd-is-undef' s: 'PP_HASH #ANY_C_TOKEN' b: 2
          p: 'undef_directive' g: 'ppd-undef' }
        { c: '@ppd-is-include' s: 'PP_HASH #ANY_C_TOKEN' b: 2
          p: 'include_directive' g: 'ppd-include' }
        { c: '@ppd-is-conditional' s: 'PP_HASH #ANY_C_TOKEN' b: 2
          p: 'conditional_directive' g: 'ppd-cond' }
        { c: '@ppd-is-simple' s: 'PP_HASH #ANY_C_TOKEN' b: 2
          p: 'simple_directive' g: 'ppd-simple' }
        # Fallback: unknown directive name.
        { s: 'PP_HASH' b: 1 p: 'simple_directive' g: 'ppd-unknown' }
      ]
      close: [{ s: [] g: 'ppd-end' }]
    }

    # ---- define_directive (phase H.2) -------------------------------
    #
    # \`# define <name> ( <params> )? <body> NEWLINE\`
    # Function-like form requires the \`(\` to be immediately adjacent
    # to the macro name (no whitespace) — the @def-paren-adjacent
    # cond enforces that.
    define_directive: {
      open: [
        { c: '@def-reentered' s: [] g: 'def-reentry' }
        { s: 'PP_HASH' a: '@def-take-hash' g: 'def-hash' }
      ]
      close: [
        { c: '@def-need-keyword' s: 'ID'
          a: '@def-take-keyword' r: 'define_directive' g: 'def-kw' }
        { c: '@def-need-name' s: 'ID'
          a: '@def-take-name' r: 'define_directive' g: 'def-name-id' }
        { c: '@def-need-name' s: 'MACRO_NAME'
          a: '@def-take-name' r: 'define_directive' g: 'def-name-mn' }
        { c: '@def-need-name' s: 'TYPEDEF_NAME'
          a: '@def-take-name' r: 'define_directive' g: 'def-name-td' }
        { c: '@def-paren-adjacent' s: 'PUNC_LPAREN' b: 1
          p: 'macro_parameter_list' g: 'def-params' }
        { c: '@def-need-body' p: 'macro_body' g: 'def-body' }
        { c: '@def-need-newline' s: 'PP_NEWLINE'
          a: '@def-take-newline' g: 'def-end' }
        { s: [] g: 'def-fall' }
      ]
    }

    # macro_parameter_list: ( <ID-or-...> (, <ID-or-...>)* )
    macro_parameter_list: {
      open: [
        { c: '@mpl-reentered' s: [] g: 'mpl-reentry' }
        { s: 'PUNC_LPAREN' a: '@mpl-take-lparen' g: 'mpl-open' }
      ]
      close: [
        { s: 'PUNC_RPAREN' a: '@mpl-take-rparen' g: 'mpl-end' }
        { s: 'PUNC_COMMA' a: '@mpl-take-comma'
          r: 'macro_parameter_list' g: 'mpl-comma' }
        { s: 'PUNC_ELLIPSIS' a: '@mpl-take-ellipsis'
          r: 'macro_parameter_list' g: 'mpl-ellipsis' }
        { s: 'ID' a: '@mpl-take-param'
          r: 'macro_parameter_list' g: 'mpl-id' }
        { s: 'TYPEDEF_NAME' a: '@mpl-take-param'
          r: 'macro_parameter_list' g: 'mpl-td' }
        { s: 'MACRO_NAME' a: '@mpl-take-param'
          r: 'macro_parameter_list' g: 'mpl-mn' }
        { s: '#ANY_C_TOKEN' a: '@mpl-absorb-other'
          r: 'macro_parameter_list' g: 'mpl-other' }
        { s: [] g: 'mpl-fall' }
      ]
    }

    # macro_body: every remaining token until PP_NEWLINE (NOT inclusive).
    macro_body: {
      open: [
        { c: '@mb-reentered' s: [] g: 'mb-reentry' }
        # Empty body — the very first thing after the name (or
        # after the param list) is PP_NEWLINE. Open with no take
        # so close immediately ends.
        { s: 'PP_NEWLINE' b: 1 g: 'mb-empty' }
        { s: '#ANY_C_TOKEN' a: '@mb-take' g: 'mb-first' }
      ]
      close: [
        { s: 'PP_NEWLINE' b: 1 g: 'mb-end' }
        { s: '#ANY_C_TOKEN' a: '@mb-take'
          r: 'macro_body' g: 'mb-tok' }
        { s: [] g: 'mb-fall' }
      ]
    }

    # ---- undef_directive (phase H.6) --------------------------------
    undef_directive: {
      open: [
        { c: '@undef-reentered' s: [] g: 'undef-reentry' }
        { s: 'PP_HASH' a: '@undef-take-hash' g: 'undef-hash' }
      ]
      close: [
        { c: '@undef-need-keyword' s: 'ID'
          a: '@undef-take-keyword' r: 'undef_directive' g: 'undef-kw' }
        { c: '@undef-need-name' s: 'ID'
          a: '@undef-take-name' r: 'undef_directive' g: 'undef-name-id' }
        { c: '@undef-need-name' s: 'MACRO_NAME'
          a: '@undef-take-name' r: 'undef_directive' g: 'undef-name-mn' }
        { c: '@undef-need-name' s: 'TYPEDEF_NAME'
          a: '@undef-take-name' r: 'undef_directive' g: 'undef-name-td' }
        { s: 'PP_NEWLINE' a: '@undef-take-newline' g: 'undef-end' }
        { s: '#ANY_C_TOKEN' a: '@undef-absorb-trailing'
          r: 'undef_directive' g: 'undef-tail' }
        { s: [] g: 'undef-fall' }
      ]
    }

    # ---- include_directive (phase H.3) ------------------------------
    #
    # \`# include <header> | "header" | <macro-expr>\`. The lexer's
    # mode tracking (cmeta.mode.expectHeaderName) emits a
    # LIT_HEADER_NAME token in the angled / quoted case before the
    # parser ever sees these tokens.
    include_directive: {
      open: [
        { c: '@inc-reentered' s: [] g: 'inc-reentry' }
        { s: 'PP_HASH' a: '@inc-take-hash' g: 'inc-hash' }
      ]
      close: [
        { c: '@inc-need-keyword' s: 'ID'
          a: '@inc-take-keyword' r: 'include_directive' g: 'inc-kw' }
        { c: '@inc-need-header' s: 'LIT_HEADER_NAME'
          a: '@inc-take-header' r: 'include_directive' g: 'inc-h' }
        { c: '@inc-need-form' p: 'header_form' g: 'inc-form' }
        { s: 'PP_NEWLINE' a: '@inc-take-newline' g: 'inc-end' }
        { s: [] g: 'inc-fall' }
      ]
    }

    # header_form: macro-form \`#include\` body — opaque tokens to PP_NEWLINE.
    header_form: {
      open: [
        { c: '@hf-reentered' s: [] g: 'hf-reentry' }
        { s: 'PP_NEWLINE' b: 1 g: 'hf-empty' }
        { s: '#ANY_C_TOKEN' a: '@hf-take' g: 'hf-first' }
      ]
      close: [
        { s: 'PP_NEWLINE' b: 1 g: 'hf-end' }
        { s: '#ANY_C_TOKEN' a: '@hf-take'
          r: 'header_form' g: 'hf-tok' }
        { s: [] g: 'hf-fall' }
      ]
    }

    # ---- conditional_directive (phase H.4) --------------------------
    #
    # \`#if\`, \`#ifdef\`, \`#ifndef\`, \`#elif\`, \`#elifdef\`, \`#elifndef\`,
    # \`#else\`, \`#endif\`. Body (where present) absorbed as opaque
    # tokens; structureConditionalGroups (the existing post-pass)
    # later folds the whole sequence into a conditional_group.
    conditional_directive: {
      open: [
        { c: '@cond-reentered' s: [] g: 'cond-reentry' }
        { s: 'PP_HASH' a: '@cond-take-hash' g: 'cond-hash' }
      ]
      close: [
        # Directive name token — can be ID (\`ifdef\`, \`endif\`, …) or
        # a keyword (\`if\`, \`else\`). Use #ANY_C_TOKEN; the dispatcher
        # already verified this is a \`#if\` family directive.
        { c: '@cond-need-keyword' s: '#ANY_C_TOKEN'
          a: '@cond-take-keyword' r: 'conditional_directive'
          g: 'cond-kw' }
        { s: 'PP_NEWLINE' a: '@cond-take-newline' g: 'cond-end' }
        { s: '#ANY_C_TOKEN' a: '@cond-absorb'
          r: 'conditional_directive' g: 'cond-tok' }
        { s: [] g: 'cond-fall' }
      ]
    }

    # ---- simple_directive (phase H.5) -------------------------------
    #
    # \`#pragma\`, \`#error\`, \`#warning\`, \`#line\` (and unknown directives).
    # The kind is set in @sd2-take-keyword based on the keyword src.
    simple_directive: {
      open: [
        { c: '@sd2-reentered' s: [] g: 'sd2-reentry' }
        { s: 'PP_HASH' a: '@sd2-take-hash' g: 'sd2-hash' }
      ]
      close: [
        { c: '@sd2-need-keyword' s: 'ID'
          a: '@sd2-take-keyword' r: 'simple_directive' g: 'sd2-kw' }
        { s: 'PP_NEWLINE' a: '@sd2-take-newline' g: 'sd2-end' }
        { s: '#ANY_C_TOKEN' a: '@sd2-absorb'
          r: 'simple_directive' g: 'sd2-tok' }
        { s: [] g: 'sd2-fall' }
      ]
    }

    # ---- static_assert_declaration (phase I.1) ----------------------
    #
    # \`static_assert ( <cond> (, <message>)? ) ;\` (and the
    # \`_Static_assert\` synonym). State machine across r:-recursion.
    static_assert_declaration: {
      open: [
        { c: '@said-reentered' s: [] g: 'said-reentry' }
        { s: 'KW_STATIC_ASSERT' a: '@said-take-kw' g: 'sa-kw' }
        { s: 'KW__STATIC_ASSERT' a: '@said-take-kw' g: 'sa-kw-1' }
      ]
      close: [
        { c: '@said-need-lparen' s: 'PUNC_LPAREN'
          a: '@said-take-lparen' r: 'static_assert_declaration'
          g: 'sa-lp' }
        { c: '@said-need-cond' p: 'val' a: '@said-mark-cond'
          g: 'sa-cond' }
        { c: '@said-need-comma' s: 'PUNC_COMMA'
          a: '@said-take-comma' r: 'static_assert_declaration'
          g: 'sa-comma' }
        { c: '@said-need-msg' p: 'val' a: '@said-mark-msg'
          g: 'sa-msg' }
        { c: '@said-need-rparen' s: 'PUNC_RPAREN'
          a: '@said-take-rparen' r: 'static_assert_declaration'
          g: 'sa-rp' }
        { c: '@said-need-semi' s: 'PUNC_SEMI'
          a: '@said-take-semi' g: 'sa-end' }
        { s: [] g: 'sa-fall' }
      ]
    }
  }
}
`
// --- END EMBEDDED c-grammar.jsonic ---

// Names of the tokens that the chomper's wildcard alt position accepts.
// Computed once on plugin install — every keyword is generated from
// tokens.ts at runtime, so we can't enumerate them in c-grammar.jsonic.
function anyCTokenNames(): string[] {
  const names: string[] = [
    'ID', 'TYPEDEF_NAME', 'MACRO_NAME',
    'LIT_INT', 'LIT_FLOAT', 'LIT_CHAR', 'LIT_STRING', 'LIT_HEADER_NAME',
    'PP_HASH', 'PP_NEWLINE', 'PP_RAW',
    // TRIVIA_* are IGNORE'd; the sub-lex hook captures them so they
    // surface as use.leading on the next non-trivia token.
  ]
  for (const [pn] of PUNCTUATORS) names.push(pn)
  for (const kw of [...C23_KEYWORDS, ...EXT_KEYWORDS]) names.push(keywordTokenName(kw)!)
  return names
}

// Parse the embedded grammar text into a GrammarSpec object using a
// vanilla Tabnas (jsonic) instance. The parsed object holds rule shapes and
// `@func` placeholders; we attach the live `ref` map at the call site.
function parseGrammar(text: string): any {
  const parsed = new Tabnas().use(jsonic).parse(text)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('c-grammar.jsonic: expected a JSON object')
  }
  return parsed
}

export interface COptions {
  // Enable extension support: preprocessor (#include, #define, #if family,
  // #pragma, #error, #warning, #undef, #line), GCC keywords/syntax
  // (__attribute__, __asm__, __extension__, __inline__, __signed__,
  // __volatile__, __const__, __restrict__, __typeof__, __alignof__),
  // MSVC keywords (__declspec, __cdecl, __int8/16/32/64, __ptr32/64,
  // etc.), Clang nullability annotations, and the structured CST
  // shapes for inline assembly.
  //
  // When false (default), the parser only handles plain C23: keywords,
  // punctuators, literals, declarations/definitions/statements/
  // expressions, C23 attributes [[...]], typedef tracking. Source that
  // uses any extension construct will fail to parse cleanly.
  //
  // The default is `false` to keep the plain-C path the canonical
  // reference. Real-world C source typically needs `{extended: true}`.
  extended?: boolean
}

// Resolve options with defaults. The plugin uses the resolved object
// throughout to gate extension-only code paths.
function resolveOptions(o?: COptions): Required<COptions> {
  return {
    extended: o?.extended === true,
  }
}

// Extension-only grammar rule names. When `extended: false` the
// plugin strips these from the parsed grammar spec before passing it
// to jsonic.grammar(). This is the physical companion to the
// `c: '@extended-on'` dispatch-alt gating: the gates already make the
// rules unreachable; deleting them outright is housekeeping that
// makes plain-C mode self-evidently free of extension grammar.
//
// Plain C keeps:
//   - C23 attribute_spec_c23 + attribute_item + attribute_argument_list
//   - static_assert_declaration (C23 + _Static_assert)
//   - statement_expression (GCC, kept in plain by user choice)
const EXTENSION_RULES: ReadonlyArray<string> = [
  // GCC inline assembly
  'asm_statement', 'asm_template', 'asm_section',
  'asm_operand', 'asm_clobber', 'asm_label_ref',
  // Preprocessor (in-body opaque + top-level structured)
  'preprocessor_line',
  'preprocessor_directive',
  'define_directive', 'macro_parameter_list', 'macro_body',
  'undef_directive',
  'include_directive', 'header_form',
  'conditional_directive', 'simple_directive',
  // Compiler-specific attribute spec syntax
  'attribute_spec_gcc', 'attribute_spec_msvc',
]

// ---- AST types ------------------------------------------------------

export interface Span { start: number; end: number; line: number; col: number }

export interface CTokenRef {
  kind: 'token'
  tname: string
  src: string
  span: Span
}

export interface CNode {
  kind: string
  span: Span
  children: Array<CNode | CTokenRef>
  trivia: { leading: CTokenRef[]; trailing: CTokenRef[] }
  [extra: string]: any
}

function tokenSpan(tkn: Token): Span {
  return { start: tkn.sI, end: tkn.sI + tkn.len, line: tkn.rI, col: tkn.cI }
}

function tokenRef(tkn: Token): CTokenRef {
  return { kind: 'token', tname: tkn.name, src: tkn.src, span: tokenSpan(tkn) }
}

function makeNode(kind: string, startTkn?: Token): CNode {
  return {
    kind,
    span: startTkn ? tokenSpan(startTkn) : { start: 0, end: 0, line: 1, col: 1 },
    children: [],
    trivia: { leading: [], trailing: [] },
  }
}

function getCMeta(ctx: Context): CMeta {
  return (ctx.meta as any).cmeta as CMeta
}

// Statement kinds the new grammar does NOT yet cover. If any of
// these tokens appears inside a function body, the body can't be
// structured by block_item dispatch, so the gate below rejects the
// new path and the legacy chomp+structure handles it.
//
// As phases B4.2.x land more statement rules, the corresponding
// tokens leave this set:
//   B4.2.2 — if/else/while/do/switch removed (paren-condition stmts)
//   B4.2.3 — for, case/default, ID-labels removed
//   B4.2.4 — asm/__asm/__asm__ and PP_HASH removed
// After phase B4.2.4 the only body shapes the new grammar can't
// structure are the C23 static_assert declarations (which need their
// own rule, deferred to phase B5). Everything else has a rule.
const UNSUPPORTED_BODY_TOKENS = new Set<string>([
  'KW_STATIC_ASSERT', 'KW__STATIC_ASSERT',
  // Function bodies that contain extension constructs (inline
  // assembly, preprocessor lines) currently go through the legacy
  // structuring path which has full asm-operand / pp-line shapes.
  // The grammar's asm_operand is opaque token-list — extending it to
  // produce the structured shape is a separate task. Until then,
  // gate any body that mentions asm/pp away from the grammar path.
  'KW_ASM', 'KW___ASM', 'KW___ASM__',
  'PP_HASH',
])

// Walk the function body starting at the token index of `{` and
// return true iff every token through the matching `}` is something
// block_item can handle. Returns false on:
//   - any forbidden keyword (control flow / asm / static_assert / pp)
//   - a labeled-statement shape (ID `:` at statement-start)
//   - unbalanced braces (defensive)
// Fetch the token at position `idx` of ctx.t, lazily loading more
// tokens from ctx.lex if needed. parse_alts only auto-loads up to
// `alt.sN` positions per alt, but the body-supportedness check
// below needs arbitrary depth to walk past the closing `}` of a
// function definition. Driving the lexer ourselves and appending to
// ctx.t works because jsonic's consume-shift code preserves the
// extra tokens (just at lower indices) for subsequent alts.
// Walk past a tagged-type specifier (struct / union / enum) starting
// at the keyword token. Consumes the optional tag ID, optional C23
// `: utype` for enums, and the optional balanced `{ … }` body.
function skipTaggedSpec(ctx: Context, i: number): number {
  const head = ctx.t[i] || fetchDeep(ctx, i)
  if (!head) return i
  if (head.name !== 'KW_STRUCT' && head.name !== 'KW_UNION' &&
      head.name !== 'KW_ENUM') return i
  i++ // keyword
  i = skipLeadingAttributes(ctx, i)
  const tagN = fetchDeep(ctx, i)?.name
  if (tagN === 'ID' || tagN === 'TYPEDEF_NAME' || tagN === 'MACRO_NAME') {
    i++
  }
  if (head.name === 'KW_ENUM' && fetchDeep(ctx, i)?.name === 'PUNC_COLON') {
    i++
    while (true) {
      const n = fetchDeep(ctx, i)?.name
      if (!n || !simpleTypeHeadSet.has(n)) break
      i++
    }
  }
  if (fetchDeep(ctx, i)?.name === 'PUNC_LBRACE') {
    let depth = 0
    const start = i
    while (i < start + 4096) {
      const t = fetchDeep(ctx, i)
      if (!t) break
      if (t.name === 'PUNC_LBRACE') depth++
      else if (t.name === 'PUNC_RBRACE') {
        depth--
        if (depth === 0) { i++; break }
      }
      i++
    }
  }
  return i
}

// Walk past any number of leading attribute specs starting at
// ctx.t[i]. Returns the new index. Recognises GCC `__attribute__`
// / `__attribute` (with their `(( … ))` body), MSVC `__declspec`
// (with `( … )`), and C23 `[[ … ]]` (two adjacent `[`s).
//
// Token access strategy: the leading-token check uses ctx.t directly
// (never fetchDeep) so a non-attribute lead returns without growing
// ctx.t — otherwise the side effect would extend the lookahead window
// for @looks-simple-decl's other ctx.t reads. fetchDeep is invoked
// only after we've confirmed an attribute keyword and need to scan
// past its body. The body scan is bounded to ~64 tokens past the
// keyword so a single call can't grow ctx.t unboundedly; bodies that
// overflow bail back to the original i, matching the original
// ctx.t-only walker's behaviour at the ctx.t boundary.
function skipLeadingAttributes(ctx: Context, i: number): number {
  while (true) {
    const t = ctx.t[i]
    if (!t) return i
    if (t.name === 'KW___ATTRIBUTE__' || t.name === 'KW___ATTRIBUTE' ||
        t.name === 'KW___DECLSPEC') {
      // Walk past the `(...)` (and inner `(...)` for GCC).
      const fetchBound = i + 64
      const fetchAt = (idx: number) =>
        idx < ctx.t.length ? ctx.t[idx] : (idx <= fetchBound ? fetchDeep(ctx, idx) : undefined)
      if (fetchAt(i + 1)?.name !== 'PUNC_LPAREN') return i
      let j = i + 1
      let depth = 0
      let sawClose = false
      while (true) {
        const tj = fetchAt(j)
        if (!tj) break
        if (tj.name === 'PUNC_LPAREN') depth++
        else if (tj.name === 'PUNC_RPAREN') {
          depth--
          if (depth === 0) { j++; sawClose = true; break }
        }
        j++
      }
      if (!sawClose) return i
      // Extend ctx.t a bit past the attribute body so the caller's
      // post-attribute lookups (e.g. @looks-simple-decl walking the
      // declarator) don't fall off the dispatch window. 8 tokens
      // covers the typical `<id> [postfix...] <terminator>` tail.
      for (let k = 0; k < 8; k++) fetchAt(j + k)
      i = j
      continue
    }
    if (t.name === 'PUNC_LBRACKET') {
      const tNext = ctx.t[i + 1]
      if (!tNext || tNext.name !== 'PUNC_LBRACKET' ||
          (t as any).sI + (t as any).len !== (tNext as any).sI) return i
      // C23 [[ ... ]] — find matching ]]
      const fetchBound = i + 64
      const fetchAt = (idx: number) =>
        idx < ctx.t.length ? ctx.t[idx] : (idx <= fetchBound ? fetchDeep(ctx, idx) : undefined)
      let j = i + 2
      let depth = 0
      let sawClose = false
      while (true) {
        const tj = fetchAt(j)
        if (!tj) break
        if (tj.name === 'PUNC_LBRACKET') depth++
        else if (tj.name === 'PUNC_RBRACKET') {
          const tj1 = fetchAt(j + 1)
          if (depth === 0 &&
              tj1?.name === 'PUNC_RBRACKET' &&
              (tj as any).sI + (tj as any).len === (tj1 as any).sI) {
            j += 2
            sawClose = true
            break
          }
          depth--
        }
        j++
      }
      if (!sawClose) return i
      for (let k = 0; k < 8; k++) fetchAt(j + k)
      i = j
      continue
    }
    return i
  }
}

// Maximum lookahead depth fetchDeep will search. The validator only
// needs to see past the current declaration; capping prevents the
// dispatch validator from lexing the entire translation unit when
// it accidentally walks into pathological input.
const FETCH_DEEP_CAP = 256

function fetchDeep(ctx: Context, idx: number): Token | undefined {
  // ctx.t is jsonic's lookahead ring buffer. Slots that haven't been
  // lexed yet sit at indices >= length; slots the parser has
  // explicitly cleared (after consume-and-shift) are filled with
  // NOTOKEN — a sentinel with name='' and tin=-1. Both cases mean
  // "no real token here yet" — but we never RETURN NOTOKEN, since
  // callers using `t?.name === 'PUNC_LBRACE'` would treat NOTOKEN
  // (name='') as a non-match and spin until the safety cap.
  if (idx >= FETCH_DEEP_CAP) return undefined
  const NOTOKEN: any = (ctx as any).NOTOKEN
  const isReal = (t: any): boolean => !!t && t !== NOTOKEN && t.name !== ''
  if (idx < ctx.t.length && isReal(ctx.t[idx])) return ctx.t[idx]
  const cfg: any = (ctx as any).cfg
  const IGNORE = cfg && cfg.tokenSetTins && cfg.tokenSetTins.IGNORE
  const lex: any = (ctx as any).lex
  if (!lex || typeof lex.next !== 'function' || !IGNORE) return undefined
  // Push at tail until ctx.t.length > idx. Filling NOTOKEN slots
  // in place breaks the parser's lookahead invariant (re-consumed
  // tokens) and inflates memory on csmith-style large inputs.
  while (ctx.t.length <= idx) {
    let tkn: any
    do {
      tkn = lex.next((ctx as any).rule, undefined, undefined, ctx.t.length)
    } while (tkn && IGNORE[tkn.tin])
    if (!tkn) return undefined
    ctx.t.push(tkn)
    if (tkn.name === '#ZZ') break
  }
  const result = idx < ctx.t.length ? ctx.t[idx] : undefined
  return isReal(result) ? result : undefined
}

function isFunctionBodySupported(ctx: Context, lbraceI: number): boolean {
  // Walk forward from `{` to its matching `}`, fetching tokens as
  // we go via fetchDeep. Reject on the first unsupported keyword we
  // see; accept once the brace depth zeroes out. The 4096-token cap
  // matches fetchDeep's safety bound.
  let braceDepth = 0
  for (let i = lbraceI; i < lbraceI + 4096; i++) {
    const t = fetchDeep(ctx, i)
    if (!t) return false
    const n = t.name
    if (n === '#ZZ') return false
    if (UNSUPPORTED_BODY_TOKENS.has(n)) return false
    if (n === 'PUNC_LBRACE') {
      braceDepth++
      continue
    }
    if (n === 'PUNC_RBRACE') {
      braceDepth--
      if (braceDepth === 0) return true
      continue
    }
  }
  return false
}

// ---- Plugin ---------------------------------------------------------

const C: any = function C(jsonic: Tabnas, options: COptions): void {
  const opts = resolveOptions(options)
  // Stash resolved options on the jsonic instance so grammar-ref
  // conditions and lex-time helpers can read them.
  ;(jsonic as any).cOptions = opts

  // 1. Register punctuator token names with their fixed sources, and
  //    keyword token names. We disable jsonic's built-in fixed-token
  //    matcher so identifier boundaries (e.g. `int_value`) aren't broken
  //    by a `int` keyword cut.
  //
  // Even when `extended` is false we register every keyword token name
  // (cheap — just integer mapping) so ANY_C_TOKEN stays consistent.
  // What changes under `!extended` is which lex matchers are installed,
  // which grammar dispatch alts fire, and which @-action refs are
  // registered.
  const fixedTokens: Record<string, string> = {}
  for (const [name, src] of PUNCTUATORS) fixedTokens[name] = src
  for (const kw of [...C23_KEYWORDS, ...EXT_KEYWORDS]) {
    fixedTokens[keywordTokenName(kw)!] = kw
  }

  jsonic.options({
    fixed: { lex: false, token: fixedTokens },
    space: { lex: false },
    line: { lex: false },
    text: { lex: false },
    number: { lex: false },
    string: { lex: false },
    comment: { lex: false },
    value: { lex: false },
    match: { lex: true },
    // Trivia tokens are skipped by the parser (so grammar alts stay
    // free of trivia clutter) but the sub-lex hook below still sees
    // them and stashes them on the next non-trivia token's use.leading
    // so source fidelity is preserved.
    //
    // ANY_C_TOKEN is the wildcard alt-position used by the
    // external_declaration chomper in c-grammar.jsonic. We compute it
    // here because the token set is dynamic (every keyword name lives
    // in tokens.ts and is generated at install time) — the grammar
    // file just references the set by name.
    tokenSet: {
      IGNORE: [
        '#SP', '#LN', '#CM',
        'TRIVIA_LINE_COMMENT', 'TRIVIA_BLOCK_COMMENT', 'TRIVIA_LINE_CONT',
      ],
      ANY_C_TOKEN: anyCTokenNames(),
      // Phase B2.3: simple-type-specifier set. `unsigned`/`signed`/
      // `long`/`short` are stackable: `unsigned long long int`,
      // `signed char`, etc. The dispatch alts allow up to 4
      // type-spec keywords before the declarator ID.
      SIMPLE_TYPE_HEAD: [
        'KW_VOID', 'KW_CHAR', 'KW_SHORT', 'KW_INT', 'KW_LONG',
        'KW_FLOAT', 'KW_DOUBLE',
        'KW_SIGNED', 'KW_UNSIGNED',
        'KW_BOOL', 'KW__BOOL',
        'KW___SIGNED__', 'KW___SIGNED',
        'KW___INT8', 'KW___INT16', 'KW___INT32', 'KW___INT64',
        'KW__COMPLEX', 'KW__IMAGINARY',
        'TYPEDEF_NAME',
        // Type qualifiers can intermix with type specifiers and may
        // appear at the head of a declaration. Including them in
        // SIMPLE_TYPE_HEAD lets `const char *p;` etc. flow through
        // the new path; spec_loop absorbs each as a specifier token.
        'KW_CONST', 'KW_VOLATILE', 'KW_RESTRICT', 'KW__ATOMIC',
        'KW___CONST__', 'KW___CONST',
        'KW___VOLATILE__', 'KW___VOLATILE',
        'KW___RESTRICT__', 'KW___RESTRICT',
        // Tagged-type specifiers (Phase F). spec_loop dispatches them
        // into struct_specifier / enum_specifier.
        'KW_STRUCT', 'KW_UNION', 'KW_ENUM',
      ],
      // Phase B2.2: leading storage-class keyword the dispatcher accepts
      // before SIMPLE_TYPE_HEAD. Includes KW_TYPEDEF so `typedef int T;`
      // takes the new path; the finaliser registers T in cmeta.symbols
      // exactly like the chomp's structureExternalDeclaration does.
      STORAGE_PREFIX: [
        'KW_STATIC', 'KW_EXTERN', 'KW_TYPEDEF',
        'KW_AUTO', 'KW_REGISTER',
        'KW__THREAD_LOCAL', 'KW_THREAD_LOCAL', 'KW_CONSTEXPR',
        'KW___THREAD',
        'KW_INLINE', 'KW___INLINE__', 'KW___INLINE',
        'KW___EXTENSION__',
      ],
      // C-atom set used by val's paren-preval alt (call / subscript
      // detection). Distinct from jsonic's standard VAL set so the
      // implicit-list-of-VALs close alts don't fire on these tokens.
      C_ATOM: [
        'LIT_INT', 'LIT_FLOAT', 'LIT_CHAR', 'LIT_STRING',
        'ID', 'MACRO_NAME', 'TYPEDEF_NAME',
      ],
      C_PAREN_OPEN: ['PUNC_LPAREN', 'PUNC_LBRACKET'],
      // All keyword tokens. Used by attribute_item so a C keyword
      // (e.g. `const` in `__attribute__((const))`) can stand in as
      // the attribute name — mirroring legacy parseAttributeItem
      // which accepts any `KW_*` token in that slot.
      KW_TOKEN: [...C23_KEYWORDS, ...EXT_KEYWORDS]
        .map((kw) => keywordTokenName(kw)!)
        .filter((n) => !!n),
      // Phase C.2: sizeof / _Alignof / __alignof__ keyword set used
      // by val's open alt that disambiguates the type-form
      // (`sizeof ( int )`) from the expression-form
      // (`sizeof <unary>`, handled by @jsonic/expr's prefix op).
      SIZEOF_KW: [
        'KW_SIZEOF',
        'KW__ALIGNOF', 'KW_ALIGNOF',
        'KW___ALIGNOF__', 'KW___ALIGNOF',
      ],
    },
    rule: {
      start: 'translation_unit',
      finish: false,
    },
  })

  const matchEntries: Record<string, { order: number; make: any }> = {}
  for (const m of allMatchers()) {
    matchEntries[m.name] = { order: m.order, make: () => m.make() }
  }
  jsonic.options({ lex: { match: matchEntries as any } })

  // Register all special token names so they have stable Tins.
  for (const name of [
    'ID', 'TYPEDEF_NAME', 'MACRO_NAME',
    'LIT_INT', 'LIT_FLOAT', 'LIT_CHAR', 'LIT_STRING', 'LIT_HEADER_NAME',
    'PP_HASH', 'PP_NEWLINE', 'PP_RAW',
    'TRIVIA_LINE_COMMENT', 'TRIVIA_BLOCK_COMMENT', 'TRIVIA_LINE_CONT',
  ]) {
    jsonic.token(name as any)
  }

  // Install CMeta on ctx.meta before parsing.
  jsonic.options({
    parse: {
      prepare: {
        cmeta: ((_jsonic: Tabnas, ctx: Context, meta?: any) => {
          const m = ctx.meta as any
          if (!m.cmeta) m.cmeta = makeCMeta()
          if (meta && meta.cmeta) m.cmeta = meta.cmeta
        }) as any,
      },
    },
  })

  // Sub-lex hook: every emitted token (including ignored ones) flows
  // through here. Trivia tokens get pushed onto cmeta.pendingTrivia;
  // the next non-trivia token receives them via use.leading. The
  // chomper (and future grammar rules) drain use.leading into the AST
  // so comments survive in source order even though IGNORE'd at
  // parse time.
  jsonic.sub({
    lex: (tkn: Token, _rule: Rule, ctx: Context) => {
      if (!tkn || !tkn.isToken) return
      const m = (ctx.meta as any).cmeta as CMeta
      if (!m) return
      // Comments and line continuations are preserved; whitespace and
      // jsonic's #LN/#CM are silently dropped.
      if (PRESERVE_TRIVIA_NAMES.has(tkn.name)) {
        m.pendingTrivia.push(tkn)
        return
      }
      if (DROP_TRIVIA_NAMES.has(tkn.name)) return
      if (m.pendingTrivia.length > 0) {
        ;(tkn as any).use = (tkn as any).use || {}
        ;(tkn as any).use.leading = m.pendingTrivia
        m.pendingTrivia = []
      }
    },
  })

  // 2. Grammar.
  //
  // The structural skeleton (translation_unit → extdecl_loop →
  // external_declaration) lives in c-grammar.jsonic and is loaded as a
  // GrammarSpec via jsonic.grammar(). All conditions and actions are
  // bound to @-named refs defined in this file, keeping the grammar
  // file free of TypeScript noise.
  // Grammar load. The full grammar text in c-grammar.jsonic defines
  // both plain-C rules and extension rules (preprocessor, GCC asm,
  // GCC/MSVC attribute specs). In plain-C mode (`extended: false`)
  // the extension rules are stripped from the parsed spec — the
  // dispatch alts that would have reached them are also gated with
  // `c: '@extended-on'` so removing the rule definitions is purely
  // belt-and-suspenders housekeeping.
  const spec = parseGrammar(grammarText)
  if (!opts.extended && spec && spec.rule) {
    for (const name of EXTENSION_RULES) delete spec.rule[name]
  }
  jsonic.grammar({
    ...spec,
    ref: makeGrammarRefs(opts),
  })

  // Phase A: install @jsonic/expr on the same jsonic instance with
  // the full C operator catalog. The plugin sets up val/expr rules
  // that recognise prefix/infix/suffix/ternary operators and paren
  // forms (call, subscript, grouping). Because c.ts already
  // registered PUNC_PLUS / PUNC_LPAREN / etc. via fixed.token, the
  // plugin reuses those tins instead of minting fresh `#E+` ones, so
  // its alts match the very tokens our lex matchers emit.
  //
  // The main grammar (c-grammar.jsonic) does NOT yet descend into
  // val — that's phase B. Until then val is unreachable from
  // translation_unit so this install is functionally a no-op for
  // existing tests, but the plumbing is in place for later phases.
  installExpr(jsonic)
}

C.defaults = {} as any

// ---- Grammar refs ---------------------------------------------------

// Bound by name from c-grammar.jsonic. The @<rulename>-<phase>
// entries auto-install as state actions on their rule (see jsonic
// rules.js fnref handling); the rest are explicit alt actions /
// conditions referenced via `a:` / `c:` clauses in the grammar.
// grammarRefs is built by makeGrammarRefs(opts) so the @-action
// closures can capture the resolved plugin options. The exported
// `grammarRefs` const below is a default for reference / tests; the
// plugin builds a fresh refs map per install in C() above.
function makeGrammarRefs(opts: Required<COptions>): Record<string, Function> {
return {

  // Extension gate ----
  // True when the plugin was installed with `extended: true`. Every
  // extension dispatch alt (preprocessor, GCC/MSVC keywords, asm) is
  // gated with `c: '@extended-on'` so the alt is dead under plain-C
  // mode. The companion `@extended-off` is the negation, used by
  // alts that should ONLY fire in plain-C mode (rare).
  '@extended-on': (_rule: Rule): boolean => opts.extended === true,
  '@extended-off': (_rule: Rule): boolean => opts.extended !== true,
  // Combined: extension-on AND first iteration of the dispatching rule.
  // Used by extdecl_loop's PP_HASH / KW_ASM extension dispatch alts
  // which originally checked `@is-first-iter` alone.
  '@ext-and-first-iter': (rule: Rule): boolean =>
    opts.extended === true &&
    (!rule.k.tokens || rule.k.tokens.length === 0),

  // translation_unit ----
  '@translation_unit-bo': (rule: Rule): void => {
    rule.node = makeNode('translation_unit')
  },
  '@translation_unit-bc': (rule: Rule): void => {
    // After all external_declarations have accumulated, fold
    // #if … #endif sequences into conditional_group nodes.
    structureConditionalGroups(rule.node)
  },

  // extdecl_loop ----
  // r.node is inherited from translation_unit; bc pushes the completed
  // external_declaration child before deciding to recurse.
  '@extdecl_loop-bc': (rule: Rule): void => {
    const child = rule.child
    if (child && child.node && child.node.kind === 'external_declaration') {
      rule.node.children.push(child.node)
    }
  },

  // external_declaration ----
  // bo runs once per fresh rule instance (including each r:-recursion).
  // Guarded so the in-progress token list isn't reset on iteration.
  '@external_declaration-bo': (rule: Rule): void => {
    if (!rule.node || rule.node.kind !== 'external_declaration') {
      rule.node = makeNode('external_declaration')
    }
    if (!rule.k.tokens) rule.k.tokens = []
    if (rule.k.depth === undefined) rule.k.depth = 0
    if (rule.k.terminated === undefined) rule.k.terminated = false
  },

  // Alt-level action: the wildcard-token alt absorbs one token per
  // cycle, attaching any preserved trivia (comments, line cont) ahead
  // of the real token, and updating brace/depth/terminator state on r.k.
  '@absorb-token': (rule: Rule): void => {
    const tkn = rule.o0 as Token
    const leading = (tkn as any).use && (tkn as any).use.leading
    if (Array.isArray(leading)) {
      for (const lt of leading) {
        rule.node.children.push(tokenRef(lt))
        rule.k.tokens.push(lt)
      }
    }
    rule.k.tokens.push(tkn)
    rule.node.children.push(tokenRef(tkn))
    rule.k.justClosedBrace = false
    if (tkn.name === 'PUNC_LBRACE') rule.k.depth++
    else if (tkn.name === 'PUNC_RBRACE') {
      rule.k.depth--
      if (rule.k.depth <= 0) {
        // A closing top-level brace ends a function body, but for a
        // struct/union/enum definition or compound literal it's
        // followed by tokens (`S;`, `var,…;`, `;` alone). The close
        // alts decide based on lookahead — see @just-closed-and-decl-ahead.
        rule.k.justClosedBrace = true
      }
    }
    else if (tkn.name === 'PUNC_SEMI' && rule.k.depth === 0) {
      rule.k.terminated = true
    }
    else if (tkn.name === 'PP_NEWLINE' && rule.k.depth === 0 &&
             firstNonTriviaIs(rule.k.tokens, 'PP_HASH')) {
      // Directive line ends here — each #-line is its own
      // external_declaration.
      rule.k.terminated = true
    }
  },

  // Close conditions:
  '@terminated': (rule: Rule): boolean => rule.k.terminated === true,
  '@just-closed-and-decl-ahead': (rule: Rule, ctx: Context): boolean =>
    rule.k.justClosedBrace === true && startsNewExternalDeclaration(ctx),

  // Close action: register typedefs and structure the absorbed tokens.
  '@finalize-extdecl': (rule: Rule, ctx: Context): void => {
    finalizeExternalDeclaration(rule, ctx)
  },

  // ---- Phase B1: real-grammar dispatch & finalisation ----

  // Marks the external_declaration as having taken the new
  // (jsonic-rule-driven) path so the close-state can route to the
  // matching finaliser instead of the chomp's structureExternalDecl.
  '@mark-new-path': (rule: Rule): void => {
    rule.u.newPath = true
  },

  '@new-path': (rule: Rule): boolean => rule.u.newPath === true,

  // Dispatch gate: an external_declaration is on its first iteration
  // when the chomp's token buffer is empty. After that we're mid-
  // declaration and any specifier-shaped tokens belong to it
  // (e.g. a struct member type), not the start of a new one.
  '@is-first-iter': (rule: Rule): boolean =>
    !rule.k.tokens || rule.k.tokens.length === 0,

  // Plain-mode + first-iter combo. Used by external_declaration's
  // direct-dispatch alts that route a clearly-shaped declaration
  // straight to simple_declaration (no @looks-simple-decl lookahead
  // walk). In extended mode the validator+wildcard cascade still
  // handles dispatch so the asm/pp gate via isFunctionBodySupported
  // continues to route those bodies to legacy structuring.
  '@plain-and-first-iter': (rule: Rule): boolean =>
    opts.extended !== true &&
    (!rule.k.tokens || rule.k.tokens.length === 0),
  '@plain-as23-and-first': (rule: Rule, ctx: Context): boolean => {
    if (opts.extended === true) return false
    if (rule.k.tokens && rule.k.tokens.length > 0) return false
    const a = ctx.t[0] as any, b = ctx.t[1] as any
    return !!(a && b && a.sI + a.len === b.sI)
  },

  // Phase B2.3: lookahead-based dispatch shape check.
  // Walks ctx.t and validates: optional STORAGE_PREFIX, 1+
  // SIMPLE_TYPE_HEAD, then ID, then `;` or `=`. Combined with the
  // gate above, this distinguishes a simple declaration from
  // function definitions, multi-declarator forms, pointers/arrays,
  // and anything else that needs the chomp path.
  '@looks-simple-decl': (rule: Rule, ctx: Context): boolean => {
    if (rule.k.tokens && rule.k.tokens.length > 0) return false
    let i = 0
    // Phase G: skip leading attribute specs (GCC / MSVC / C23). They
    // can appear before storage prefix or type head; spec_loop will
    // re-encounter them via its own dispatch alts.
    i = skipLeadingAttributes(ctx, i)
    if (storagePrefixSet.has(ctx.t[i]?.name)) i++
    i = skipLeadingAttributes(ctx, i)
    const typeStart = i
    // Walk through specifiers. Each iteration takes one specifier
    // and any tagged-type body (`struct S { … }` / `enum E { … }`)
    // so the post-spec terminator check looks at the right token.
    while (i < 256) {
      const n = fetchDeep(ctx, i)?.name
      if (!n) break
      if (n === 'KW_STRUCT' || n === 'KW_UNION' || n === 'KW_ENUM') {
        const before = i
        i = skipTaggedSpec(ctx, i)
        if (i === before) break  // safety: no progress
        continue
      }
      if (simpleTypeHeadSet.has(n)) {
        i++
        continue
      }
      // C23 _BitInt(N) — width-parameterised type. Skip the keyword
      // and its `(N)` parens as a single specifier so the validator
      // sees the trailing ID/`;`. spec_loop dispatches into the
      // bit_int_paren sub-rule at parse time.
      if (n === 'KW__BITINT') {
        i++
        if (fetchDeep(ctx, i)?.name !== 'PUNC_LPAREN') return false
        let d = 1; i++
        while (i < FETCH_DEEP_CAP && d > 0) {
          const m = fetchDeep(ctx, i)?.name
          if (!m) return false
          if (m === 'PUNC_LPAREN') d++
          else if (m === 'PUNC_RPAREN') d--
          i++
        }
        if (d !== 0) return false
        continue
      }
      i = skipLeadingAttributes(ctx, i)
      if (i !== typeStart && fetchDeep(ctx, i)?.name === n) break
      const beforeAttr = i
      i = skipLeadingAttributes(ctx, i)
      if (i === beforeAttr) break
    }
    if (i === typeStart) return false
    // Tag-body declarations route to legacy because the grammar's
    // struct/enum body parsing produces much more memory than the
    // legacy opaque-token absorption — for large csmith translation
    // units (~400KB) this blows the heap. Standalone tag references
    // (`struct S;`, `enum E;`) and pre-existing simple cases still
    // flow via the SEMI check below using ctx.t (no fetchDeep).
    if (ctx.t[i]?.name === 'PUNC_SEMI') return true
    // Phase P: parenthesised sub-declarator (function pointer).
    // Shape: `<specs>+ ( * + ID ) ( <params>? ) ;`. No initializer
    // for now — initialised forms still flow through the legacy
    // chomp because val doesn't yet handle every initializer form.
    if (ctx.t[i]?.name === 'PUNC_LPAREN') {
      // Parenthesised compound declarator. Three shapes:
      //   `int (*p)(int);`    — function pointer
      //   `int (*p)[10];`     — pointer to array
      //   `int (*arr[3])(int);` — array of fn-pointers (inner has
      //                            its own array postfix)
      let p = i + 1
      // Require at least one `*` inside the parens.
      if (fetchDeep(ctx, p)?.name !== 'PUNC_STAR') return false
      while (p < i + 8 && fetchDeep(ctx, p)?.name === 'PUNC_STAR') p++
      const innerName = fetchDeep(ctx, p)?.name
      if (innerName !== 'ID' && innerName !== 'TYPEDEF_NAME' &&
          innerName !== 'MACRO_NAME') return false
      p++
      // Optional inner array postfix(es): `(*arr[3])`.
      while (fetchDeep(ctx, p)?.name === 'PUNC_LBRACKET') {
        let bd = 1; p++
        while (p < FETCH_DEEP_CAP && bd > 0) {
          const n2 = fetchDeep(ctx, p)?.name
          if (!n2) return false
          if (n2 === 'PUNC_LBRACKET') bd++
          else if (n2 === 'PUNC_RBRACKET') bd--
          p++
        }
        if (bd !== 0) return false
      }
      if (fetchDeep(ctx, p)?.name !== 'PUNC_RPAREN') return false
      p++
      // Trailing postfix: `(...)` (function postfix), `[...]` (array
      // postfix), or chain of either. Walk balanced parens / brackets.
      const post1 = fetchDeep(ctx, p)?.name
      if (post1 !== 'PUNC_LPAREN' && post1 !== 'PUNC_LBRACKET') return false
      while (true) {
        const start = fetchDeep(ctx, p)?.name
        if (start !== 'PUNC_LPAREN' && start !== 'PUNC_LBRACKET') break
        const closer = start === 'PUNC_LPAREN' ? 'PUNC_RPAREN' : 'PUNC_RBRACKET'
        let depth = 0
        let closed = false
        while (p < FETCH_DEEP_CAP) {
          const n2 = fetchDeep(ctx, p)?.name
          if (!n2) return false
          if (n2 === start) depth++
          else if (n2 === closer) depth--
          if (depth === 0 && n2 !== start) { closed = true; break }
          p++
        }
        if (!closed) return false
        p++  // past the closing token
      }
      const post = fetchDeep(ctx, p)?.name
      // Only the simple `;` terminator for now; initializers and
      // function bodies for compound declarators stay on legacy.
      return post === 'PUNC_SEMI'
    }
    // Optional pointer prefix on the first declarator: zero or more
    // `*`, each optionally followed by type qualifiers
    // (`const`/`volatile`/`restrict`/`_Atomic`) that bind to the
    // pointer (`int * const p` is a const pointer to int).
    const sawPointer = fetchDeep(ctx, i)?.name === 'PUNC_STAR'
    while (i < 64) {
      const n = fetchDeep(ctx, i)?.name
      if (n === 'PUNC_STAR') { i++; continue }
      if (n === 'KW_CONST' || n === 'KW_VOLATILE' ||
          n === 'KW_RESTRICT' || n === 'KW__ATOMIC') {
        if (!sawPointer) break
        i++
        continue
      }
      break
    }
    const idName = fetchDeep(ctx, i)?.name
    if (idName !== 'ID' && idName !== 'TYPEDEF_NAME' &&
        idName !== 'MACRO_NAME') return false
    i++
    const after = fetchDeep(ctx, i)?.name
    if (after !== 'PUNC_SEMI' &&
        after !== 'PUNC_ASSIGN' &&
        after !== 'PUNC_COMMA' &&
        after !== 'PUNC_LBRACKET' &&
        after !== 'PUNC_LPAREN') return false
    // Pointer-with-initializer flows through grammar. The
    // `initializer` rule dispatches to initializer_list for `{...}`
    // and to val for expression initializers. The chained-subscript
    // gap that previously kept these on the legacy path is fixed by
    // @jsonic/expr's postfix paren-form chaining (p: 'expr' in
    // val.close).
    void sawPointer
    if (after === 'PUNC_LBRACKET') {
      // Walk past consecutive balanced bracket pairs (e.g. `[2][2]`)
      // to find what follows. Both plain `int arr[10];` and array-
      // with-initializer `int arr[3] = {…};` / `char buf[] = "…";`
      // flow through grammar (val handles string-literal / brace
      // initializers and chained subscripts).
      let j = i
      while (true) {
        let depth = 0
        let closed = false
        while (j < 32) {
          const n2 = fetchDeep(ctx, j)?.name
          if (!n2) return false
          if (n2 === 'PUNC_LBRACKET') depth++
          else if (n2 === 'PUNC_RBRACKET') depth--
          if (depth === 0 && n2 !== 'PUNC_LBRACKET') { closed = true; break }
          j++
        }
        if (!closed) return false
        const next = fetchDeep(ctx, j + 1)?.name
        if (!next) return false
        if (next !== 'PUNC_LBRACKET') break
        j += 1
      }
    }
    if (after === 'PUNC_LPAREN') {
      // Walk past balanced parens looking for the matching `)`.
      // Accept `;` (function declaration) or `{` (function
      // definition) — for the `{` form, additionally validate that
      // the body contains only block items the grammar can
      // structure. Use fetchDeep so we can see beyond the dispatch
      // lookahead window (which is only 6 tokens for the longest
      // wildcard alt).
      let depth = 0
      let j = i
      let closed = false
      const SAFETY = 4096
      while (j < i + SAFETY) {
        const t = fetchDeep(ctx, j)
        const n2 = t?.name
        if (!n2 || n2 === '#ZZ') return false
        if (n2 === 'PUNC_LPAREN') depth++
        else if (n2 === 'PUNC_RPAREN') depth--
        if (depth === 0 && n2 !== 'PUNC_LPAREN') { closed = true; break }
        j++
      }
      if (!closed) return false
      const post = fetchDeep(ctx, j + 1)?.name
      if (post !== 'PUNC_SEMI' && post !== 'PUNC_LBRACE') return false
      if (post === 'PUNC_LBRACE') {
        if (!isFunctionBodySupported(ctx, j + 1)) return false
      }
    }
    return true
  },

  // Close action when the new path was taken: the child rule's node
  // is the structured declaration. To match the CST shape produced
  // by the chomp+post-process path, splice the declaration's
  // children directly into external_declaration.children rather
  // than wrapping them in an extra layer.
  '@finalize-new-path': (rule: Rule, ctx: Context): void => {
    if (rule.child && rule.child.node) {
      const childNode = rule.child.node
      const childName = rule.child.name
      // Standalone directive / declaration forms whose CST has the
      // structured node as a single child of external_declaration.
      // simple_declaration splices its children for the historic
      // shape; everything else wraps.
      const wrapAsSingle =
        childName === 'static_assert_declaration' ||
        childName === 'asm_statement'
      if (wrapAsSingle) {
        rule.node.children = [childNode]
        rule.node.declKind = 'declaration'
      } else {
        rule.node.children = [...(childNode.children || [])]
        rule.node.declKind = childNode.declKind || 'declaration'
      }
      // Dispatch marker: which path produced this external_declaration.
      // Tests in test/spec/path-dispatch.tsv assert against this so
      // changes to @looks-simple-decl that silently route shapes from
      // one path to the other are caught.
      ;(rule.node as any).viaPath = 'grammar'
      // Register every declared name as a typedef when the child
      // declaration's specifier list contained KW_TYPEDEF.
      const u = rule.child.u || {}
      if (u.isTypedef && Array.isArray(u.declaredNames)) {
        const cmeta = getCMeta(ctx)
        for (const name of u.declaredNames) {
          cmeta.symbols.bindTypedef(name)
          reclassifyAsTypedef(ctx, name)
        }
      }
    }
  },

  // ---- simple_declaration refs ----

  // bo: create the declaration node and the per-declaration scaffolding.
  // Each declarator gets its own init_declarator sub-rule which builds
  // its own node; this rule only owns the surrounding specs / idl
  // wrappers.
  '@simple_declaration-bo': (rule: Rule): void => {
    rule.node = makeNode('declaration')
    rule.node.declKind = 'declaration'
    rule.u.specs = makeNode('declaration_specifiers')
    rule.u.idl   = makeNode('init_declarator_list')
    // Strip stale per-rule k state that may have leaked into our k
    // via the shallow-copy-on-push that jsonic does at every rule
    // transition. Without this, e.g. enumerator_list's k.elNode
    // from a prior declaration's enum-body bleeds into the current
    // declaration's struct/enum and the re-entry guards misfire.
    delete rule.k.ssNode; delete rule.k.ssKwTaken
    delete rule.k.ssTagTaken; delete rule.k.ssBodyTaken
    delete rule.k.esNode; delete rule.k.esKwTaken
    delete rule.k.esTagTaken; delete rule.k.esUtypeTaken
    delete rule.k.esBodyTaken; delete rule.k.esUtypeAttached
    delete rule.k.elNode; delete rule.k.elOpened
    delete rule.k.takenEnums
    delete rule.k.mdlNode; delete rule.k.mdlOpened
    delete rule.k.takenSecs; delete rule.k.takenItems
    delete rule.k.ilNode; delete rule.k.ilOpened
    delete rule.k.iiNode; delete rule.k.hasDesig; delete rule.k.tookEq
    delete rule.k.declarator; delete rule.k.directDeclarator
    delete rule.k.lastPointer
    clearStmtState(rule)
  },

  // Phase B2.3+B2.4 actions. simple_declaration's open descends into
  // spec_loop after absorbing the FIRST specifier; spec_loop absorbs
  // any number of additional specifier keywords. Each declarator is
  // then handled by a separate init_declarator sub-rule.
  '@absorb-spec-storage': (rule: Rule): void => {
    const owner = specOwner(rule)
    const tkn = rule.o0 as Token
    pushTokenWithTrivia(owner.u.specs, tkn)
    if (tkn.name === 'KW_TYPEDEF') owner.u.isTypedef = true
  },
  '@absorb-spec-type': (rule: Rule): void => {
    const owner = specOwner(rule)
    const tkn = rule.o0 as Token
    pushTokenWithTrivia(owner.u.specs, tkn)
  },

  // ---- bit_int_paren refs (C23 _BitInt(N)) ----
  // The keyword has already been pushed onto the parent spec_loop's
  // u.specs by @absorb-spec-type. This rule appends the `(`, the
  // width expression, and the `)` to the same specs node so the
  // `_BitInt(8)` triple sits as adjacent children of the
  // declaration_specifiers, matching the legacy CST shape.
  '@bip-take-lparen': (rule: Rule): void => {
    const owner = specOwner(rule)
    if (owner && owner.u && owner.u.specs) {
      pushTokenWithTrivia(owner.u.specs, rule.o0 as Token)
    }
  },
  '@bip-mark-val': (_rule: Rule): void => { /* see -bc */ },
  '@bit_int_paren-bc': (rule: Rule): void => {
    if (rule.k.bipValAttached) return
    if (rule.child && rule.child.name === 'val' && rule.child.node) {
      const owner = specOwner(rule)
      if (owner && owner.u && owner.u.specs) {
        owner.u.specs.children.push(rule.child.node)
        rule.k.bipValAttached = true
      }
    }
  },
  '@bip-take-rparen': (rule: Rule): void => {
    const owner = specOwner(rule)
    if (owner && owner.u && owner.u.specs) {
      pushTokenWithTrivia(owner.u.specs, rule.c0 as Token)
    }
  },

  // Capture the comma between declarators onto the init_declarator_list.
  '@simple-decl-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.u.idl, rule.c0 as Token)
  },

  // ---- init_declarator refs ----

  '@init_declarator-bo': (rule: Rule): void => {
    // Guard against r:-recursion: the re-entry preserves the
    // already-built node from before the ID was captured. Only
    // initialise on the first entry. Scaffolding (declarator,
    // directDeclarator) lives on rule.k so it survives r: (which
    // shallow-copies k but resets u).
    if (rule.node && rule.node.kind === 'init_declarator') return
    rule.node = makeNode('init_declarator')
    rule.k.declarator = makeNode('declarator')
    rule.k.directDeclarator = makeNode('direct_declarator')
  },

  '@idecl-name': (rule: Rule): void => {
    const idTkn = (rule.state === 'c' ? rule.c0 : rule.o0) as Token
    pushTokenWithTrivia(rule.k.directDeclarator, idTkn)
    rule.k.directDeclarator.declaredName = idTkn.src
    rule.k.declarator.children.push(rule.k.directDeclarator)
    rule.k.declarator.declaredName = idTkn.src
    rule.node.children.push(rule.k.declarator)
    rule.node.declaredName = idTkn.src
    // Latch across init_declarator's r:-recursion so the re-entry
    // open-alt's cond sees we already captured the name.
    rule.k.named = true
  },

  '@idecl-named': (rule: Rule): boolean => rule.k.named === true,

  // Phase P: parenthesised sub-declarator (function pointer).
  // @idecl-paren-open captures the opening `(` onto the outer
  // direct_declarator, attaches direct_declarator to the outer
  // declarator, and marks the rule as paren-pending so the close
  // alt for `)` fires after paren_inner_declarator returns.
  '@idecl-paren-open': (rule: Rule): void => {
    const lparen = rule.o0 as Token
    pushTokenWithTrivia(rule.k.directDeclarator, lparen)
    rule.k.declarator.children.push(rule.k.directDeclarator)
    rule.node.children.push(rule.k.declarator)
    rule.k.idclParenPending = true
  },

  '@idecl-paren-pending': (rule: Rule): boolean =>
    rule.k.idclParenPending === true && rule.k.parenClosed !== true,

  // Consume the matching `)` after paren_inner_declarator returns,
  // append it to the outer direct_declarator, and latch named so
  // r:-recursion's reentry-gate accepts the next iteration.
  '@idecl-paren-close': (rule: Rule): void => {
    pushTokenWithTrivia(rule.k.directDeclarator, rule.c0 as Token)
    rule.k.parenClosed = true
    rule.k.named = true
  },

  // ---- paren_inner_declarator refs (phase P) ----

  // bo: build an inner declarator + direct_declarator. Mirrors
  // @init_declarator-bo's k.declarator / k.directDeclarator
  // scaffolding so pointer_list / array_postfix / function_postfix
  // (which all reach into rule.parent.k) work unchanged. CRITICAL:
  // r:-recursion shallow-copies k from the parent rule, so the
  // parent's k.declarator (the OUTER declarator) is visible here.
  // A naive `if (rule.k.declarator) return` guard would alias the
  // inner declarator with the outer one and produce a CST cycle
  // when @pid-name attaches `rule.k.declarator` into the outer
  // direct_declarator. Use a paren_inner-specific marker instead.
  '@paren_inner_declarator-bo': (rule: Rule): void => {
    if (rule.k.pidInit) return
    rule.k.pidInit = true
    rule.k.declarator = makeNode('declarator')
    rule.k.directDeclarator = makeNode('direct_declarator')
  },

  '@pid-named': (rule: Rule): boolean => rule.k.named === true,

  // Capture the inner declarator's name. Mirrors @idecl-name but
  // attaches the resulting inner declarator onto the outer (parent)
  // init_declarator's directDeclarator children rather than
  // pushing onto rule.node (paren_inner_declarator has no node of
  // its own — it builds straight onto k).
  '@pid-name': (rule: Rule): void => {
    const idTkn = (rule.state === 'c' ? rule.c0 : rule.o0) as Token
    pushTokenWithTrivia(rule.k.directDeclarator, idTkn)
    rule.k.directDeclarator.declaredName = idTkn.src
    rule.k.declarator.children.push(rule.k.directDeclarator)
    rule.k.declarator.declaredName = idTkn.src
    rule.k.named = true
    // Attach the completed inner declarator onto the outer
    // direct_declarator (between the `(` already pushed by
    // @idecl-paren-open and the `)` that @idecl-paren-close will
    // push next).
    if (!rule.k.attached) {
      const outer = rule.parent as Rule  // init_declarator
      outer.k.directDeclarator.children.push(rule.k.declarator)
      // Propagate the declared name up so the outer's
      // declaredName / typedef registration works.
      outer.k.directDeclarator.declaredName = idTkn.src
      outer.k.declarator.declaredName = idTkn.src
      outer.node.declaredName = idTkn.src
      rule.k.attached = true
    }
  },

  // Absorb a single `*` pointer token into the parent
  // init_declarator's declarator children. Each star becomes its own
  // pointer node so multi-level pointers (`int **pp`) read naturally.
  '@absorb-pointer': (rule: Rule): void => {
    const owner = rule.parent as Rule  // init_declarator
    const ptr = makeNode('pointer')
    pushTokenWithTrivia(ptr, rule.o0 as Token)
    owner.k.declarator.children.push(ptr)
    // Stash the just-built pointer node so the pointer_qualifier_loop
    // sub-rule (descended via p: in this same alt) can append
    // qualifier tokens to it.
    rule.k.lastPointer = ptr
  },

  // Append a type-qualifier token to the parent pointer_list's most
  // recently-pushed pointer node. C qualifiers following `*` qualify
  // the pointer itself, not the pointee — `int * const p` is a const
  // pointer to int.
  '@absorb-pq-const': (rule: Rule): void => {
    const owner = rule.parent as Rule  // pointer_list
    const ptr = owner?.k?.lastPointer
    if (ptr) pushTokenWithTrivia(ptr, rule.o0 as Token)
  },

  // ---- array_postfix refs ----

  // bo: build the array_postfix node up-front; @arr-close attaches it
  // to the parent init_declarator's direct_declarator on completion.
  '@array_postfix-bo': (rule: Rule): void => {
    rule.node = makeNode('array_postfix')
  },

  '@arr-open': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },

  '@arr-close': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    // Attach the array_postfix node onto the parent's declarator
    // shell. init_declarator uses k.directDeclarator;
    // parameter_declaration uses k.declarator. Either way, append.
    const owner = rule.parent as Rule
    if (owner.k.directDeclarator) {
      owner.k.directDeclarator.children.push(rule.node)
    } else if (owner.k.declarator) {
      owner.k.declarator.children.push(rule.node)
    }
  },

  // bc: when val just produced a size expression, splice it into the
  // array_postfix node ahead of the closing `]` (which hasn't been
  // matched yet at this point).
  '@array_postfix-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        !rule.u.size) {
      rule.node.children.push(rule.child.node)
      rule.u.size = rule.child.node
    }
  },

  // ---- function_postfix refs (phase B3.1) ----

  // bo: build the function_postfix node and the inner parameter_type_list
  // shell. Both will accumulate via the actions below as the rule
  // descends into parameter_type_list.
  '@function_postfix-bo': (rule: Rule): void => {
    rule.node = makeNode('function_postfix')
    rule.k.ptl = makeNode('parameter_type_list')
  },

  '@fn-open': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },

  '@fn-close': (rule: Rule): void => {
    // Closing `)` matched (without descending into parameters at all
    // — empty paren list).
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    attachFunctionPostfix(rule)
  },

  // After parameter_type_list returns, its children have been
  // accumulated onto rule.k.ptl; splice that node and consume `)`.
  '@ptl-attach-and-end': (rule: Rule): void => {
    // rule here is parameter_type_list (since this fires on its
    // close-alt). Walk up to function_postfix to attach.
    const fn = rule.parent as Rule
    if (fn.k.ptl && fn.k.ptl.children.length > 0) {
      fn.node.children.push(fn.k.ptl)
    }
  },

  '@ptl-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.parent.k.ptl, rule.c0 as Token)
  },

  // ---- identifier_list refs (K&R-style prototype) ----

  // bo: build the identifier_list CST scaffold. Guard against
  // r:-recursion (each comma re-enters the rule); jsonic passes
  // rule.node as the 3rd arg of makeRule so the existing children
  // carry forward — we just must avoid replacing the node.
  '@identifier_list-bo': (rule: Rule): void => {
    if (rule.node && rule.node.kind === 'identifier_list') return
    rule.node = makeNode('identifier_list')
  },

  // Take an ID token and append it as a child of identifier_list.
  // Fires for both the first ID (open alt) and subsequent IDs after
  // a comma (close alt's `r:`-recursion re-fires this on re-entry).
  '@idlist-take': (rule: Rule): void => {
    const tkn = (rule.state === 'o' ? rule.o0 : rule.c0) as Token
    pushTokenWithTrivia(rule.node, tkn)
  },

  // Append the comma between identifier_list items as a token-ref
  // child so the original source order is preserved.
  '@idlist-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // Attach the completed identifier_list onto the parent
  // function_postfix's CST. Mirrors @ptl-attach-and-end's role for
  // typed parameter lists.
  '@idlist-attach': (rule: Rule): void => {
    const fn = rule.parent as Rule
    if (fn.node && rule.node) {
      fn.node.children.push(rule.node)
    }
  },

  // Variadic terminator `, ...`. Build a parameter_variadic CST
  // node, push it onto the parameter_type_list, tag the ptl as
  // variadic, AND attach the ptl to the function_postfix —
  // because this alt completes the rule without falling through
  // to @ptl-attach-and-end, we need to do the attach here.
  '@ptl-take-ellipsis': (rule: Rule): void => {
    const fn = rule.parent as Rule
    const ptl = fn.k.ptl
    pushTokenWithTrivia(ptl, rule.c0 as Token)
    const pv = makeNode('parameter_variadic')
    pushTokenWithTrivia(pv, rule.c1 as Token)
    ptl.children.push(pv)
    ptl.variadic = true
    if (ptl.children.length > 0) {
      fn.node.children.push(ptl)
    }
  },

  // ---- parameter_declaration refs ----

  '@parameter_declaration-bo': (rule: Rule): void => {
    // Guard against r:-recursion (pointer-prefix loop): only
    // initialise on the first entry. The reentry-gate alt at the
    // top of open accepts the re-entry without consuming any tokens.
    if (rule.node && rule.node.kind === 'parameter_declaration') return
    rule.node = makeNode('parameter_declaration')
    rule.k.specs = makeNode('declaration_specifiers')
    // r.k is shallow-copied from the pushing rule (parameter_type_list,
    // which itself inherited from function_postfix → init_declarator),
    // so the OUTER init_declarator's k.declarator and k.directDeclarator
    // would be visible here. Clear them so this parameter's BC doesn't
    // splice the outer declarator into our children (which produced a
    // cycle in earlier iterations).
    rule.k.declarator = undefined
    rule.k.directDeclarator = undefined
    rule.k.assembled = false
    rule.k.named = false
  },

  '@param-reentered': (rule: Rule): boolean =>
    !!rule.k.declarator,

  '@param-spec': (rule: Rule): void => {
    // Owner: parameter_declaration if direct, else its child
    // param_spec_loop. Both should target the parameter's specs.
    const owner = rule.name === 'parameter_declaration'
      ? rule
      : (rule.parent as Rule)
    pushTokenWithTrivia(owner.k.specs, rule.o0 as Token)
  },

  '@param-name': (rule: Rule): void => {
    const idTkn = rule.c0 as Token
    rule.node.declaredName = idTkn.src
    // If pointer prefix(es) already added a declarator, append ID
    // into its direct_declarator. Otherwise build a fresh one.
    if (rule.k.declarator) {
      const decl = rule.k.declarator
      const dd = makeNode('direct_declarator')
      pushTokenWithTrivia(dd, idTkn)
      dd.declaredName = idTkn.src
      decl.children.push(dd)
      decl.declaredName = idTkn.src
    } else {
      const decl = makeNode('declarator')
      const dd = makeNode('direct_declarator')
      pushTokenWithTrivia(dd, idTkn)
      dd.declaredName = idTkn.src
      decl.children.push(dd)
      decl.declaredName = idTkn.src
      rule.k.declarator = decl
    }
  },

  // Pointer prefix on a parameter's declarator. Each `*` is a
  // separate pointer node on rule.k.declarator (built lazily).
  '@param-pointer': (rule: Rule): void => {
    if (!rule.k.declarator) {
      rule.k.declarator = makeNode('declarator')
    }
    const ptr = makeNode('pointer')
    pushTokenWithTrivia(ptr, rule.c0 as Token)
    rule.k.declarator.children.push(ptr)
  },

  // ---- parenthesised abstract / named parameter declarator ----

  // Open `(` of a parenthesised parameter declarator, e.g. the
  // outer `(` in `int (*)(int)` or `int (*name)(int)`. Capture
  // the LPAREN onto the parameter's declarator, mark the rule so
  // re-entry via `r:` knows we're inside a paren-pending state,
  // and seed the inner declarator scaffold.
  '@param-paren-open': (rule: Rule): void => {
    if (!rule.k.declarator) {
      rule.k.declarator = makeNode('declarator')
    }
    pushTokenWithTrivia(rule.k.declarator, rule.c0 as Token)
    rule.k.paramParenPending = true
    // The inner declarator is attached to rule.k.declarator by
    // param_paren_inner's actions; the outer rule's close will
    // append the closing `)` and drop the pending flag.
  },

  // True between @param-paren-open and the matching `)`. Lets the
  // PUNC_RPAREN close-alt fire only when we actually opened a
  // paren-form declarator (not the function_postfix closer).
  '@param-paren-pending': (rule: Rule): boolean =>
    rule.k.paramParenPending === true,

  // True before any paren-form declarator has been absorbed. Once
  // we've opened a paren-form, subsequent `(` should be treated as
  // a function postfix, not as a fresh paren-form.
  '@param-can-paren-form': (rule: Rule): boolean =>
    rule.k.paramParenDone !== true && rule.k.paramParenPending !== true,

  // Match the outer `)` of a paren-form parameter declarator and
  // append it onto rule.k.declarator. The rule re-enters via `r:`
  // so the next close-state can take a trailing function-postfix
  // / array-postfix / nothing.
  '@param-paren-close': (rule: Rule): void => {
    if (!rule.k.declarator) return
    pushTokenWithTrivia(rule.k.declarator, rule.c0 as Token)
    rule.k.paramParenPending = false
    rule.k.paramParenDone = true
  },

  // Cond for the function-postfix-after-paren alt: a `(` here is a
  // function postfix only when we just closed a paren-form
  // declarator AND haven't already absorbed a function postfix.
  '@param-need-fn-postfix': (rule: Rule): boolean =>
    rule.k.paramParenDone === true && rule.k.paramFnPostfixDone !== true,

  // ---- param_paren_inner refs ----

  // True when an inner ID has already been captured; gates the
  // re-entry no-op alt at the top of param_paren_inner's open.
  '@ppi-named': (rule: Rule): boolean =>
    rule.k.ppiNamed === true,

  // Pointer prefix INSIDE the parenthesised inner declarator. Each
  // `*` becomes a pointer node attached to the OUTER (parameter
  // declaration's) declarator, so the abstract `(*)` produces a
  // pointer-on-declarator without needing a separate inner node.
  '@ppi-pointer': (rule: Rule): void => {
    const owner = rule.parent as Rule  // parameter_declaration
    if (!owner.k.declarator) {
      owner.k.declarator = makeNode('declarator')
    }
    const ptr = makeNode('pointer')
    pushTokenWithTrivia(ptr, rule.c0 as Token)
    owner.k.declarator.children.push(ptr)
  },

  // Capture the optional ID inside the parenthesised inner
  // declarator (e.g. the `fn` in `int (*fn)(int)`). The ID belongs
  // to the OUTER parameter's declarator and tagged as declaredName.
  '@ppi-name': (rule: Rule): void => {
    const owner = rule.parent as Rule  // parameter_declaration
    const idTkn = (rule.state === 'o' ? rule.o0 : rule.c0) as Token
    if (!owner.k.declarator) {
      owner.k.declarator = makeNode('declarator')
    }
    const dd = makeNode('direct_declarator')
    pushTokenWithTrivia(dd, idTkn)
    dd.declaredName = idTkn.src
    owner.k.declarator.children.push(dd)
    owner.k.declarator.declaredName = idTkn.src
    owner.node.declaredName = idTkn.src
    rule.k.ppiNamed = true
  },

  '@parameter_declaration-bc': (rule: Rule): void => {
    // Attach specs once (after param_spec_loop returned). Attach
    // declarator separately, after pointer-prefix loop and ID
    // capture have populated rule.k.declarator.
    if (!rule.k.specsAttached) {
      rule.node.children.push(rule.k.specs)
      rule.k.specsAttached = true
    }
    if (!rule.k.declAttached && rule.k.declarator) {
      rule.node.children.push(rule.k.declarator)
      rule.k.declAttached = true
    }
    // Push into the parent parameter_type_list's k.ptl on completion.
    // The parameter_type_list's parent is function_postfix. Guard
    // against duplicate pushes when bc fires multiple times across
    // pointer-prefix r:-recursion.
    if (!rule.k.ptlAttached) {
      const ptl = rule.parent
      if (ptl && ptl.name === 'parameter_type_list') {
        const fn = ptl.parent as Rule
        if (fn && fn.k.ptl && rule.node) {
          fn.k.ptl.children.push(rule.node)
          rule.k.ptlAttached = true
        }
      }
    }
  },

  '@idecl-take-eq': (rule: Rule): void => {
    rule.u.eqTrivia = leadingTriviaRefs(rule.c0 as Token)
    rule.u.eqTokenRef = tokenRef(rule.c0 as Token)
    rule.u.hasInit = true
  },

  // bc on init_declarator: if the initializer rule supplied a child,
  // splice it into the node's children with the `=` token preceding it.
  // The initializer rule wraps both brace-init and val-expr forms in
  // an `initializer` node so we just push it directly.
  '@init_declarator-bc': (rule: Rule): void => {
    if (rule.u.hasInit && rule.child && rule.child.node) {
      let initNode = rule.child.node
      // Pre-Q2.1 fallthrough: if a non-initializer child still surfaces
      // here (e.g. dispatched directly to val), wrap it for the legacy
      // CST shape compatibility.
      if (initNode.kind !== 'initializer') {
        const wrapped = makeNode('initializer')
        wrapped.children.push(initNode)
        initNode = wrapped
      }
      for (const tr of rule.u.eqTrivia || []) rule.node.children.push(tr)
      rule.node.children.push(rule.u.eqTokenRef)
      rule.node.children.push(initNode)
    }
  },

  // ---- initializer wrapper rule (phase Q2.1) ----
  '@initializer-bo': (rule: Rule): void => {
    rule.node = makeNode('initializer')
  },
  '@initializer-bc': (rule: Rule): void => {
    if (rule.child && rule.child.node) {
      rule.node.children.push(rule.child.node)
    }
  },

  // bc on simple_declaration: when an init_declarator sub-rule has
  // just completed, push its node onto the declaration's idl list
  // and remember its declared name so the typedef finaliser can
  // register every name (matching the chomp's behaviour for
  // `typedef int A, B, C;`).
  '@simple_declaration-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'init_declarator' &&
        rule.child.node && rule.child.node.kind === 'init_declarator') {
      rule.u.idl.children.push(rule.child.node)
      if (rule.child.node.declaredName) {
        if (!rule.u.declaredNames) rule.u.declaredNames = []
        rule.u.declaredNames.push(rule.child.node.declaredName)
        if (!rule.u.declaredName) {
          rule.u.declaredName = rule.child.node.declaredName
        }
      }
    }
    // Tagged-type specifier dispatched directly from open: relay
    // onto declaration_specifiers (phase F.5).
    if (rule.child &&
        (rule.child.name === 'struct_specifier' ||
         rule.child.name === 'enum_specifier') &&
        rule.child.node && !rule.u.taggedSpecAttached) {
      rule.u.specs.children.push(rule.child.node)
      rule.u.taggedSpecAttached = true
    }
    // Capture the function body once the compound_statement child
    // returned (phase B3.3). The close-state's @fn-body-done alt
    // then routes to @simple-decl-finalize-fn.
    if (rule.child && rule.child.name === 'compound_statement' &&
        rule.child.node && rule.child.node.kind === 'compound_statement' &&
        !rule.u.fnBody) {
      rule.u.fnBody = rule.child.node
    }
  },

  // close action: matched `;`, finish the declaration. The
  // init_declarator children have already been pushed onto u.idl by
  // @simple_declaration-bc; we just stitch the final shape and pin
  // the trailing `;`.
  '@simple-decl-finalize': (rule: Rule, ctx: Context): void => {
    rule.node.children.push(rule.u.specs)
    // Only emit init_declarator_list if it has at least one
    // declarator. Standalone struct / union / enum definitions
    // (`struct S { … };`) have no declarators and the legacy CST
    // omits the init_declarator_list wrapper entirely.
    if (rule.u.idl && rule.u.idl.children && rule.u.idl.children.length > 0) {
      rule.node.children.push(rule.u.idl)
    }
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    void ctx
  },

  // ---- function-definition refs (phase B3.3) ----
  //
  // simple_declaration descends into compound_statement when the
  // close-state alt sees `{` after the parameter-list; on return,
  // the body lives at rule.u.fnBody (set by @simple_declaration-bc).
  // @fn-body-done then triggers @simple-decl-finalize-fn which
  // re-shapes the declaration node as a function_definition.

  '@simple-decl-start-fn-body': (rule: Rule): void => {
    rule.u.startedFnBody = true
  },

  '@fn-body-done': (rule: Rule): boolean =>
    !!rule.u.fnBody && !rule.u.fnDefDone,

  '@simple-decl-finalize-fn': (rule: Rule, ctx: Context): void => {
    rule.u.fnDefDone = true
    rule.node.declKind = 'function_definition'
    rule.node.children.push(rule.u.specs)
    // Lift the declarator out of the (single) init_declarator; the
    // legacy CST shape places it directly under external_declaration
    // alongside declaration_specifiers and compound_statement.
    const idl = rule.u.idl
    if (idl && idl.children.length > 0) {
      const firstId = idl.children[0]
      if (firstId && firstId.kind === 'init_declarator' &&
          firstId.children.length > 0 &&
          firstId.children[0].kind === 'declarator') {
        rule.node.children.push(firstId.children[0])
      }
    }
    rule.node.children.push(rule.u.fnBody)
    void ctx
  },

  // ---- compound_statement refs (phase B4.1+B3.3) ----
  //
  // compound_statement.close dispatches each block_item via p:; the
  // -bc hook stitches the returned item onto rule.node.children
  // before the next iteration recurses via r:.

  // bo: always create a fresh compound_statement node. The
  // RuleImpl ctor pre-seeds rule.node with the parent's node, so
  // a child compound_statement (inside e.g. statement → p:
  // compound_statement) would otherwise share its parent's node.
  '@compound_statement-bo': (rule: Rule): void => {
    rule.node = makeNode('compound_statement')
  },

  '@cs-open': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },

  '@cs-close': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // bc: each completed block_item has its node attached here before
  // the close-state recurses for the next item.
  '@compound_statement-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'block_item' &&
        rule.child.node && !rule.k.taken?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      if (!rule.k.taken) rule.k.taken = new Set()
      rule.k.taken.add(rule.child)
    }
  },

  // ---- statement-level refs (phase B4.2.1) ----------------
  //
  // CST shapes mirror what structure.ts emits today
  // (parseBlockItem / parseStatement / parseJumpStatement /
  // parseExpressionStatement) so downstream consumers see the same
  // tree under the new path.

  // block_item is a dispatcher that produces no node of its own.
  // Relay the sub-rule's node up so compound_statement can grab it
  // via rule.child.node.
  //
  // Note we REPLACE rule.node rather than only set when null: the
  // RuleImpl ctor seeds rule.node with the parent's node so an
  // un-replaced block_item.node would still point at the parent
  // compound_statement.node, and compound_statement-bc would then
  // push compound_statement into its own children — infinite tree.
  '@block_item-bc': (rule: Rule): void => {
    if (rule.child && rule.child.node) {
      rule.node = rule.child.node
    }
  },

  // statement is also a dispatcher; relay child node. Same node-
  // replacement rationale as block_item. The empty-`;` alt sets
  // rule.node directly to a fresh expression_statement node before
  // any child is pushed — keep that node.
  '@statement-bc': (rule: Rule): void => {
    if (rule.node && rule.node.kind === 'expression_statement' &&
        (!rule.child || !rule.child.node)) {
      return
    }
    if (rule.child && rule.child.node) {
      rule.node = rule.child.node
    }
  },

  // statement: empty `;` lands directly here so we can produce the
  // expression_statement-with-just-`;` shape that the legacy path
  // emits for `for(;;) ;`.
  '@stmt-empty': (rule: Rule): void => {
    const node = makeNode('expression_statement')
    pushTokenWithTrivia(node, rule.o0 as Token)
    rule.node = node
  },

  // expression_statement: <expr> `;`
  // Always create a fresh node — the inherited rule.node points at
  // the parent statement's node, which would otherwise leak.
  '@expression_statement-bo': (rule: Rule): void => {
    rule.node = makeNode('expression_statement')
  },
  // Alt-action @es-take-expr fires before the val child is pushed,
  // so it's effectively a no-op. The actual stitching happens in
  // @expression_statement-bc once val has returned.
  '@es-take-expr': (_rule: Rule): void => { /* see -bc */ },
  '@expression_statement-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        rule.child.node !== rule.node && !rule.k.exprAttached) {
      rule.node.children.push(rule.child.node)
      rule.k.exprAttached = true
    }
  },
  '@es-finalize': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // jump_statement: return / break / continue / goto
  '@jump_statement-bo': (rule: Rule): void => {
    if (rule.node && rule.node.kind === 'jump_statement') return
    rule.node = makeNode('jump_statement')
  },
  '@js-reentry': (rule: Rule): boolean => rule.k.started === true,
  '@js-take-keyword': (rule: Rule): void => {
    const tkn = rule.o0 as Token
    rule.node.jumpKind = tkn.src
    pushTokenWithTrivia(rule.node, tkn)
    rule.k.started = true
  },
  '@js-needs-label': (rule: Rule): boolean =>
    rule.node.jumpKind === 'goto' && !rule.k.tookLabel,
  '@js-take-label': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookLabel = true
  },
  '@js-needs-expr': (rule: Rule): boolean =>
    rule.node.jumpKind === 'return' && !rule.k.tookExpr,
  // Alt action runs before the val child is pushed; just mark
  // intent. The real attach happens in @jump_statement-bc.
  '@js-take-expr': (rule: Rule): void => {
    rule.k.tookExpr = true
  },
  '@jump_statement-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        rule.child.node !== rule.node && rule.k.tookExpr &&
        !rule.k.exprAttached) {
      rule.node.children.push(rule.child.node)
      rule.k.exprAttached = true
    }
  },
  '@js-finalize': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // ---- paren_condition (phase B4.2.2) ------------------------------
  '@paren_condition-bo': (rule: Rule): void => {
    rule.node = makeNode('paren_condition')
  },
  '@pc-open': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  // Alt action @pc-take-expr fires before val is pushed; just a hook.
  // -bc does the actual stitch.
  '@pc-take-expr': (_rule: Rule): void => { /* see -bc */ },
  '@paren_condition-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        rule.child.node !== rule.node && !rule.k.exprAttached) {
      rule.node.children.push(rule.child.node)
      rule.k.exprAttached = true
    }
  },
  '@pc-close': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // ---- if_statement (phase B4.2.2) ---------------------------------
  '@if_statement-bo': (rule: Rule): void => {
    // Check r:-recursion via prev.name (NOT rule.node.kind, which
    // is the inherited parent node and would mis-trigger for nested
    // statements). On a fresh instance, build a new node and strip
    // stale took*/elseSeen state inherited from a parent control-
    // flow rule (took* keys are shared across if/while/do/for/
    // switch and would otherwise misfire when an `if` is nested
    // inside a `for` body or vice versa).
    if (rule.prev && rule.prev.name === rule.name && rule.k.ifNode) {
      rule.node = rule.k.ifNode
      return
    }
    rule.node = makeNode('if_statement')
    rule.k.ifNode = rule.node
    clearStmtState(rule)
  },
  '@if-take-keyword': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  '@if-needs-cond': (rule: Rule): boolean => !rule.k.tookCond,
  '@if-needs-then': (rule: Rule): boolean =>
    rule.k.tookCond === true && !rule.k.tookThen,
  '@if-needs-else-kw': (rule: Rule): boolean =>
    rule.k.tookThen === true && !rule.k.elseSeen,
  '@if-take-else-kw': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.elseSeen = true
  },
  '@if-needs-else-body': (rule: Rule): boolean =>
    rule.k.elseSeen === true && !rule.k.tookElse,
  '@if_statement-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'paren_condition' && !rule.k.tookCond) {
      rule.node.children.push(rule.child.node)
      rule.k.tookCond = true
      return
    }
    if (rule.child.name === 'statement') {
      if (!rule.k.tookThen) {
        rule.node.children.push(rule.child.node)
        rule.k.tookThen = true
      } else if (rule.k.elseSeen && !rule.k.tookElse) {
        rule.node.children.push(rule.child.node)
        rule.k.tookElse = true
      }
    }
  },

  // ---- while_statement (phase B4.2.2) ------------------------------
  '@while_statement-bo': (rule: Rule): void => {
    if (rule.prev && rule.prev.name === rule.name && rule.k.whileNode) {
      rule.node = rule.k.whileNode
      return
    }
    rule.node = makeNode('while_statement')
    rule.k.whileNode = rule.node
    clearStmtState(rule)
  },
  '@while-take-keyword': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  '@while-needs-cond': (rule: Rule): boolean => !rule.k.tookCond,
  '@while-needs-body': (rule: Rule): boolean =>
    rule.k.tookCond === true && !rule.k.tookBody,
  '@while_statement-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'paren_condition' && !rule.k.tookCond) {
      rule.node.children.push(rule.child.node)
      rule.k.tookCond = true
      return
    }
    if (rule.child.name === 'statement' && !rule.k.tookBody) {
      rule.node.children.push(rule.child.node)
      rule.k.tookBody = true
    }
  },

  // ---- do_statement (phase B4.2.2) ---------------------------------
  '@do_statement-bo': (rule: Rule): void => {
    if (rule.prev && rule.prev.name === rule.name && rule.k.doNode) {
      rule.node = rule.k.doNode
      return
    }
    rule.node = makeNode('do_statement')
    rule.k.doNode = rule.node
    clearStmtState(rule)
  },
  '@do-take-keyword': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  '@do-needs-body': (rule: Rule): boolean => !rule.k.tookBody,
  '@do-needs-while': (rule: Rule): boolean =>
    rule.k.tookBody === true && !rule.k.tookWhile,
  '@do-take-while': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookWhile = true
  },
  '@do-needs-cond': (rule: Rule): boolean =>
    rule.k.tookWhile === true && !rule.k.tookCond,
  '@do-needs-semi': (rule: Rule): boolean =>
    rule.k.tookCond === true && !rule.k.tookSemi,
  '@do-take-semi': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookSemi = true
  },
  '@do_statement-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'statement' && !rule.k.tookBody) {
      rule.node.children.push(rule.child.node)
      rule.k.tookBody = true
      return
    }
    if (rule.child.name === 'paren_condition' && !rule.k.tookCond) {
      rule.node.children.push(rule.child.node)
      rule.k.tookCond = true
    }
  },

  // ---- switch_statement (phase B4.2.2) -----------------------------
  '@switch_statement-bo': (rule: Rule): void => {
    if (rule.prev && rule.prev.name === rule.name && rule.k.switchNode) {
      rule.node = rule.k.switchNode
      return
    }
    rule.node = makeNode('switch_statement')
    rule.k.switchNode = rule.node
    clearStmtState(rule)
  },
  '@switch-take-keyword': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  '@switch-needs-cond': (rule: Rule): boolean => !rule.k.tookCond,
  '@switch-needs-body': (rule: Rule): boolean =>
    rule.k.tookCond === true && !rule.k.tookBody,
  '@switch_statement-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'paren_condition' && !rule.k.tookCond) {
      rule.node.children.push(rule.child.node)
      rule.k.tookCond = true
      return
    }
    if (rule.child.name === 'statement' && !rule.k.tookBody) {
      rule.node.children.push(rule.child.node)
      rule.k.tookBody = true
    }
  },

  // ---- for_statement family (phase B4.2.3) -------------------------
  '@for_statement-bo': (rule: Rule): void => {
    if (rule.prev && rule.prev.name === rule.name && rule.k.forNode) {
      rule.node = rule.k.forNode
      return
    }
    rule.node = makeNode('for_statement')
    rule.k.forNode = rule.node
    clearStmtState(rule)
  },
  '@for-take-keyword': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  '@for-needs-controls': (rule: Rule): boolean => !rule.k.tookControls,
  '@for-needs-body': (rule: Rule): boolean =>
    rule.k.tookControls === true && !rule.k.tookBody,
  '@for_statement-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'for_controls' && !rule.k.tookControls) {
      rule.node.children.push(rule.child.node)
      rule.k.tookControls = true
      return
    }
    if (rule.child.name === 'statement' && !rule.k.tookBody) {
      rule.node.children.push(rule.child.node)
      rule.k.tookBody = true
    }
  },

  '@for_controls-bo': (rule: Rule): void => {
    if (rule.prev && rule.prev.name === rule.name && rule.k.fcNode) {
      rule.node = rule.k.fcNode
      return
    }
    rule.node = makeNode('for_controls')
    rule.k.fcNode = rule.node
    clearStmtState(rule)
  },
  '@fc-open': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  '@fc-needs-cond': (rule: Rule): boolean =>
    rule.k.tookInit === true && !rule.k.tookCond,
  '@fc-needs-iter': (rule: Rule): boolean =>
    rule.k.tookCond === true && !rule.k.tookIter,
  '@fc-close': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@for_controls-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'for_init' && !rule.k.tookInit) {
      rule.node.children.push(rule.child.node)
      rule.node.init = rule.child.node
      rule.k.tookInit = true
      return
    }
    if (rule.child.name === 'for_cond' && !rule.k.tookCond) {
      rule.node.children.push(rule.child.node)
      rule.node.cond = rule.child.node
      rule.k.tookCond = true
      return
    }
    if (rule.child.name === 'for_iter' && !rule.k.tookIter) {
      rule.node.children.push(rule.child.node)
      rule.node.iter = rule.child.node
      rule.k.tookIter = true
    }
  },

  // for_init: declaration | expression | empty.
  '@for_init-bo': (rule: Rule): void => {
    if (rule.node && rule.node.kind === 'for_init') return
    rule.node = makeNode('for_init')
  },
  '@fi-empty-take-semi': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.took = 'empty'
  },
  '@fi-mark-decl': (rule: Rule): void => { rule.k.took = 'decl' },
  '@fi-mark-expr': (rule: Rule): void => { rule.k.took = 'expr' },
  '@fi-needs-semi': (rule: Rule): boolean =>
    rule.k.took === 'expr' && !rule.k.tookSemi,
  '@fi-take-semi': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookSemi = true
  },
  '@for_init-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.k.took === 'decl' &&
        rule.child.name === 'simple_declaration' &&
        !rule.node.value) {
      rule.node.children.push(rule.child.node)
      rule.node.value = rule.child.node
    } else if (rule.k.took === 'expr' &&
               rule.child.name === 'val' &&
               rule.child.node !== rule.node &&
               !rule.node.value) {
      rule.node.children.push(rule.child.node)
      rule.node.value = rule.child.node
    }
  },

  // for_cond: expression | empty (always followed by `;`).
  '@for_cond-bo': (rule: Rule): void => {
    if (rule.node && rule.node.kind === 'for_cond') return
    rule.node = makeNode('for_cond')
  },
  '@fcond-empty-take-semi': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.took = 'empty'
  },
  '@fcond-mark-expr': (rule: Rule): void => { rule.k.took = 'expr' },
  '@fcond-needs-semi': (rule: Rule): boolean =>
    rule.k.took === 'expr' && !rule.k.tookSemi,
  '@fcond-take-semi': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookSemi = true
  },
  '@for_cond-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.k.took === 'expr' &&
        rule.child.name === 'val' &&
        rule.child.node !== rule.node &&
        !rule.node.value) {
      rule.node.children.push(rule.child.node)
      rule.node.value = rule.child.node
    }
  },

  // for_iter: expression | empty (terminates at `)`).
  '@for_iter-bo': (rule: Rule): void => {
    if (rule.node && rule.node.kind === 'for_iter') return
    rule.node = makeNode('for_iter')
  },
  '@fiter-empty': (_rule: Rule): void => { /* no-op */ },
  '@fiter-mark-expr': (rule: Rule): void => { rule.k.took = 'expr' },
  '@for_iter-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.k.took === 'expr' &&
        rule.child.name === 'val' &&
        rule.child.node !== rule.node &&
        !rule.node.value) {
      rule.node.children.push(rule.child.node)
      rule.node.value = rule.child.node
    }
  },

  // ---- labeled_statement (phase B4.2.3) ----------------------------
  '@labeled_statement-bo': (rule: Rule): void => {
    if (rule.node && rule.node.kind === 'labeled_statement') return
    rule.node = makeNode('labeled_statement')
  },
  '@lbl-take-case': (rule: Rule): void => {
    rule.node.labelKind = 'case'
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.kind = 'case'
  },
  '@lbl-take-default': (rule: Rule): void => {
    rule.node.labelKind = 'default'
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.kind = 'default'
  },
  '@lbl-take-name': (rule: Rule): void => {
    rule.node.labelKind = 'label'
    rule.node.labelName = (rule.o0 as Token).src
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.kind = 'label'
  },
  '@lbl-needs-expr': (rule: Rule): boolean =>
    rule.k.kind === 'case' && !rule.k.tookExpr,
  '@lbl-mark-expr': (rule: Rule): void => { rule.k.tookExpr = true },
  '@lbl-needs-colon': (rule: Rule): boolean => !rule.k.tookColon,
  '@lbl-take-colon': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookColon = true
  },
  '@lbl-needs-body': (rule: Rule): boolean =>
    rule.k.tookColon === true && !rule.k.tookBody,
  '@labeled_statement-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.k.kind === 'case' &&
        rule.child.name === 'val' &&
        rule.child.node !== rule.node &&
        !rule.k.exprAttached) {
      rule.node.children.push(rule.child.node)
      rule.k.exprAttached = true
      return
    }
    if (rule.child.name === 'statement' && !rule.k.tookBody) {
      rule.node.children.push(rule.child.node)
      rule.k.tookBody = true
    }
  },

  // ---- asm_statement (phase B4.2.4, opaque-token form) -------------
  //
  // Captures the whole `__asm__ … ;` line as a flat token sequence
  // under an asm_statement node. Inner structuring (qualifiers,
  // template, output / input / clobber / label sections) is deferred
  // — the legacy structure.ts:parseAsmStatement remains the source
  // of truth there.
  // ---- asm_statement (phase C.8 — structured) ----------------------
  //
  // State machine across r:-recursion via rule.k:
  //   .started       KW consumed (open-state re-entry sentinel)
  //   .lparenTaken   `(` consumed (qualifier loop done)
  //   .templateTaken asm_template returned
  //   .sectionIdx    next section to take (0..3)
  //   .lastWasColon  the previous matched alt was a section-colon
  //                  (so we expect a section next, even if empty)
  //   .rparenTaken   `)` consumed (sections done)
  //   .semiTaken     `;` consumed (rule finalised)
  '@asm_statement-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.asmNode) {
      rule.node = rule.k.asmNode
      return
    }
    const node = makeNode('asm_statement')
    node.qualifiers = []
    rule.k.asmNode = node
    rule.k.sectionIdx = 0
    rule.node = node
  },
  '@asm-reentry': (rule: Rule): boolean => rule.k.started === true,
  '@asm-take-keyword': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.started = true
  },
  '@asm-need-qualifier': (rule: Rule): boolean =>
    rule.k.started === true && !rule.k.lparenTaken,
  '@asm-take-qualifier': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    rule.node.qualifiers.push(tkn.src)
    pushTokenWithTrivia(rule.node, tkn)
  },
  '@asm-need-lparen': (rule: Rule): boolean =>
    rule.k.started === true && !rule.k.lparenTaken,
  '@asm-take-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.lparenTaken = true
  },
  '@asm-need-template': (rule: Rule): boolean =>
    rule.k.lparenTaken === true && !rule.k.templateTaken,
  '@asm-need-section-colon': (rule: Rule): boolean =>
    rule.k.templateTaken === true && !rule.k.rparenTaken &&
    !rule.k.lastWasColon &&
    (rule.k.sectionIdx || 0) < 4,
  '@asm-take-section-colon': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.lastWasColon = true
  },
  '@asm-need-section': (rule: Rule): boolean =>
    rule.k.lastWasColon === true && !rule.k.rparenTaken,
  '@asm-need-rparen': (rule: Rule): boolean =>
    rule.k.lparenTaken === true && !rule.k.rparenTaken,
  '@asm-take-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.rparenTaken = true
  },
  '@asm-need-semi': (rule: Rule): boolean => !rule.k.semiTaken,
  '@asm-take-semi': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.semiTaken = true
  },
  '@asm_statement-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'asm_template' && !rule.k.templateTaken) {
      rule.node.children.push(rule.child.node)
      rule.node.template = rule.child.node
      rule.k.templateTaken = true
      return
    }
    if (rule.child.name === 'asm_section' &&
        !rule.k.takenSecs?.has(rule.child)) {
      const idx = rule.k.sectionIdx || 0
      const kindMap = ['asm_outputs', 'asm_inputs',
                       'asm_clobbers', 'asm_labels']
      const kind = kindMap[idx]
      if (kind) {
        rule.child.node.kind = kind
      }
      rule.node.children.push(rule.child.node)
      if (kind) (rule.node as any)[kind] = rule.child.node
      rule.k.sectionIdx = idx + 1
      rule.k.lastWasColon = false
      if (!rule.k.takenSecs) rule.k.takenSecs = new Set()
      rule.k.takenSecs.add(rule.child)
    }
  },

  // ---- asm_template ------------------------------------------------
  '@asm_template-bo': (rule: Rule): void => {
    rule.node = makeNode('asm_template')
  },
  '@asm_template-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        rule.child.node !== rule.node && !rule.k.exprAttached) {
      rule.node.children.push(rule.child.node)
      rule.node.expression = rule.child.node
      rule.k.exprAttached = true
    }
  },

  // ---- asm_section -------------------------------------------------
  '@asm_section-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.asecNode) {
      rule.node = rule.k.asecNode
      return
    }
    rule.node = makeNode('asm_section')
    rule.k.asecNode = rule.node
    rule.k.asecOpened = false
    rule.k.takenItems = undefined
  },
  // The needs-* conds peek t0 to decide whether to dispatch a
  // sub-rule. They have no side effects (jsonic may re-evaluate
  // alts). The dispatch only fires when (a) the parent section
  // index matches the kind and (b) t0 is a valid head for an item
  // of that kind. On empty section / past-last-item, t0 is `:` or
  // `)` and all needs-* return false; the open's s:[] fallback
  // exits the rule cleanly.
  '@asec-needs-operand': (rule: Rule, ctx: Context): boolean => {
    const parent = (rule as any).parent
    const idx = parent && parent.k && parent.k.sectionIdx
    if (idx !== 0 && idx !== 1) return false
    const t0 = ctx.t[0]
    if (!t0) return false
    return t0.name === 'PUNC_LBRACKET' ||
           t0.name === 'LIT_STRING' ||
           t0.name === 'ID'
  },
  '@asec-needs-clobber': (rule: Rule, ctx: Context): boolean => {
    const parent = (rule as any).parent
    const idx = parent && parent.k && parent.k.sectionIdx
    if (idx !== 2) return false
    const t0 = ctx.t[0]
    return !!(t0 && t0.name === 'LIT_STRING')
  },
  '@asec-needs-label': (rule: Rule, ctx: Context): boolean => {
    const parent = (rule as any).parent
    const idx = parent && parent.k && parent.k.sectionIdx
    if (idx !== 3) return false
    const t0 = ctx.t[0]
    return !!(t0 && t0.name === 'ID')
  },
  '@asec-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@asm_section-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if ((rule.child.name === 'asm_operand' ||
         rule.child.name === 'asm_clobber' ||
         rule.child.name === 'asm_label_ref') &&
        !rule.k.takenItems?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      if (!rule.k.takenItems) rule.k.takenItems = new Set()
      rule.k.takenItems.add(rule.child)
    }
  },

  // ---- asm_operand (opaque) ----------------------------------------
  '@asm_operand-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.aopNode) {
      rule.node = rule.k.aopNode
      return
    }
    rule.node = makeNode('asm_operand')
    rule.k.aopNode = rule.node
    rule.k.aopDepth = 0
  },
  '@aop-reentered': (rule: Rule): boolean => !!rule.k.aopNode && !!rule.k.aopTaken,
  '@aop-take': (rule: Rule): void => {
    const tkn = (rule.state === 'c' ? rule.c0 : rule.o0) as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.k.aopTaken = true
    const n = tkn.name
    if (n === 'PUNC_LPAREN' || n === 'PUNC_LBRACKET') {
      rule.k.aopDepth = (rule.k.aopDepth || 0) + 1
    } else if (n === 'PUNC_RPAREN' || n === 'PUNC_RBRACKET') {
      rule.k.aopDepth = (rule.k.aopDepth || 0) - 1
    }
  },
  '@aop-stop': (rule: Rule): boolean => (rule.k.aopDepth || 0) === 0,

  // ---- asm_clobber -------------------------------------------------
  '@asm_clobber-bo': (rule: Rule): void => {
    rule.node = makeNode('asm_clobber')
  },
  '@acl-take': (rule: Rule): void => {
    const tkn = rule.o0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.value = tkn.src
  },

  // ---- asm_label_ref -----------------------------------------------
  '@asm_label_ref-bo': (rule: Rule): void => {
    rule.node = makeNode('asm_label_ref')
  },
  '@alr-take': (rule: Rule): void => {
    const tkn = rule.o0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.labelName = tkn.src
  },

  // ---- preprocessor_line (phase B4.2.4, opaque to PP_NEWLINE) ------
  '@preprocessor_line-bo': (rule: Rule): void => {
    if (rule.node && rule.node.kind === 'preprocessor_line') return
    rule.node = makeNode('preprocessor_line')
  },
  '@pp-take-hash': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.started = true
  },
  '@pp-reentry': (rule: Rule): boolean => rule.k.started === true,
  '@pp-absorb': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@pp-take-newline': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // ---- type_name (phase C.2) ---------------------------------------
  //
  // The type_name node persists across r:-recursion via rule.k.tnNode.
  // Detect "fresh push" vs "r:-recursion" via rule.prev so an
  // outer parent's k.tnNode doesn't leak into a nested type_name.
  '@type_name-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.tnNode) {
      rule.node = rule.k.tnNode
      return
    }
    const node = makeNode('type_name')
    rule.k.tnNode = node
    rule.k.tnTaken = false
    rule.k.depth = 0
    rule.node = node
  },
  '@tn-reentered': (rule: Rule): boolean => !!rule.k.tnNode && !!rule.k.tnTaken,
  '@tn-take': (rule: Rule): void => {
    const tkn = (rule.state === 'c' ? rule.c0 : rule.o0) as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.k.tnTaken = true
    const n = tkn.name
    if (n === 'PUNC_LPAREN' || n === 'PUNC_LBRACKET') {
      rule.k.depth = (rule.k.depth || 0) + 1
    } else if (n === 'PUNC_RPAREN' || n === 'PUNC_RBRACKET') {
      rule.k.depth = (rule.k.depth || 0) - 1
    }
  },
  '@tn-balanced': (rule: Rule): boolean => (rule.k.depth || 0) === 0,

  // ---- sizeof_type_form (phase C.2) --------------------------------
  '@sizeof_type_form-bo': (rule: Rule): void => {
    rule.node = makeNode('unary_expression')
  },
  '@stf-take-kw': (rule: Rule): void => {
    const tkn = rule.o0 as Token
    rule.node.op = tkn.src
    pushTokenWithTrivia(rule.node, tkn)
    rule.k.kwTaken = true
  },
  '@stf-needs-lparen': (rule: Rule): boolean =>
    rule.k.kwTaken === true && !rule.k.tookLparen,
  '@stf-take-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookLparen = true
  },
  '@stf-needs-rparen': (rule: Rule): boolean =>
    rule.k.tookLparen === true && !rule.k.tookRparen,
  '@stf-take-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookRparen = true
  },
  '@sizeof_type_form-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'type_name' &&
        rule.child.node && !rule.k.typeNameAttached) {
      rule.node.children.push(rule.child.node)
      rule.node.operand = rule.child.node
      rule.k.typeNameAttached = true
    }
  },

  // ---- cast_or_compound_literal (phase C.3) ------------------------
  //
  // Build the final cast_expression / compound_literal node in
  // @cocl-finalize from the captured pieces (typeName, surrounding
  // tokens, operand or initializer body) — we only know which kind
  // we are after we've seen what follows the closing `)`.
  '@cast_or_compound_literal-bo': (rule: Rule): void => {
    rule.k.children = []
  },
  '@cocl-take-lparen': (rule: Rule): void => {
    rule.k.lparenTkn = rule.o0 as Token
  },
  '@cocl-reentered': (rule: Rule): boolean => !!rule.k.lparenTkn,
  '@cocl-needs-rparen': (rule: Rule): boolean => !rule.k.tookRparen,
  '@cocl-take-rparen': (rule: Rule): void => {
    rule.k.rparenTkn = rule.c0 as Token
    rule.k.tookRparen = true
  },
  '@cocl-needs-decision': (rule: Rule): boolean =>
    rule.k.tookRparen === true && !rule.k.decided,
  '@cocl-mark-cl': (rule: Rule): void => {
    rule.k.decided = 'compound_literal'
  },
  '@cocl-mark-cast': (rule: Rule): void => {
    rule.k.decided = 'cast'
  },
  '@cast_or_compound_literal-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'type_name' && !rule.k.typeName) {
      rule.k.typeName = rule.child.node
      return
    }
    if ((rule.child.name === 'initializer_list' ||
         rule.child.name === 'compound_literal_body') &&
        !rule.k.compoundBody) {
      rule.k.compoundBody = rule.child.node
      return
    }
    if (rule.child.name === 'val' && !rule.k.castOperand) {
      rule.k.castOperand = rule.child.node
    }
  },
  '@cocl-finalize': (rule: Rule): void => {
    const decided = rule.k.decided || 'cast'
    const tn = rule.k.typeName
    let node: CNode
    if (decided === 'compound_literal') {
      node = makeNode('compound_literal')
      if (rule.k.lparenTkn) pushTokenWithTrivia(node, rule.k.lparenTkn)
      if (tn) { node.children.push(tn); node.typeName = tn }
      if (rule.k.rparenTkn) pushTokenWithTrivia(node, rule.k.rparenTkn)
      if (rule.k.compoundBody) node.children.push(rule.k.compoundBody)
    } else {
      node = makeNode('cast_expression')
      if (rule.k.lparenTkn) pushTokenWithTrivia(node, rule.k.lparenTkn)
      if (tn) { node.children.push(tn); node.typeName = tn }
      if (rule.k.rparenTkn) pushTokenWithTrivia(node, rule.k.rparenTkn)
      if (rule.k.castOperand) {
        node.children.push(rule.k.castOperand)
        node.operand = rule.k.castOperand
      }
    }
    rule.node = node
    // r:-recursion creates a fresh rule per pass, but the parent's
    // `.child` reference still points at the FIRST cocl instance.
    // Propagate the finalised node onto that first instance so the
    // parent (val) can pick it up via rule.child.node.
    const parent = (rule as any).parent
    if (parent && parent.child && parent.child.name === rule.name) {
      parent.child.node = node
    }
  },

  // ---- compound_literal_body (alias for initializer_list) ----------
  '@compound_literal_body-bo': (rule: Rule): void => {
    // No-op; the rule p:-delegates to initializer_list and relies on
    // the bc below to relay its node.
  },
  '@compound_literal_body-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'initializer_list' &&
        rule.child.node && !rule.k.relayed) {
      rule.node = rule.child.node
      rule.k.relayed = true
    }
  },

  // ---- initializer_list (phase C.4) --------------------------------
  '@initializer_list-bo': (rule: Rule): void => {
    // r:-recursion sets rule.prev to the previous same-name instance;
    // on that path k carries our previous ilNode/opened across. For
    // a FRESH rule (pushed via p: from val or initializer_item) the
    // inherited k might still hold an outer initializer_list's
    // state (k is shallow-copied across all rule pushes), so we
    // must reset.
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.ilNode) {
      rule.node = rule.k.ilNode
      return
    }
    const node = makeNode('initializer_list')
    rule.k.ilNode = node
    rule.k.opened = false
    rule.k.takenItems = undefined
    rule.node = node
  },
  '@il-take-lbrace': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.opened = true
  },
  '@il-reentered': (rule: Rule): boolean => rule.k.opened === true,
  '@il-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@il-take-rbrace': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@initializer_list-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'initializer_item' &&
        rule.child.node && !rule.k.takenItems?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      if (!rule.k.takenItems) rule.k.takenItems = new Set()
      rule.k.takenItems.add(rule.child)
    }
  },

  // ---- initializer_item (phase C.4) --------------------------------
  '@initializer_item-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.iiNode) {
      rule.node = rule.k.iiNode
      return
    }
    const node = makeNode('initializer_item')
    rule.k.iiNode = node
    rule.k.hasDesig = false
    rule.k.tookEq = false
    rule.k.gotValue = false
    rule.k.desigAttached = false
    rule.node = node
  },
  '@ii-reentered': (rule: Rule): boolean => rule.k.tookEq === true,
  '@ii-mark-has-desig': (rule: Rule): void => {
    rule.k.hasDesig = true
  },
  '@ii-mark-nested': (rule: Rule): void => {
    rule.k.nestedKind = 'list'
  },
  '@ii-needs-eq': (rule: Rule): boolean =>
    rule.k.hasDesig === true && !rule.k.tookEq,
  '@ii-take-eq': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookEq = true
  },
  '@ii-needs-value': (rule: Rule): boolean =>
    rule.k.hasDesig === true && rule.k.tookEq === true && !rule.k.gotValue,
  '@initializer_item-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'designation' && !rule.k.desigAttached) {
      rule.node.children.push(rule.child.node)
      rule.node.designation = rule.child.node
      rule.k.desigAttached = true
      return
    }
    if (rule.child.name === 'initializer_list' && !rule.k.gotValue) {
      // Nested initializer list — wrap in `initializer` per legacy CST.
      const init = makeNode('initializer')
      init.children.push(rule.child.node)
      rule.node.children.push(init)
      rule.node.value = init
      rule.k.gotValue = true
      return
    }
    if (rule.child.name === 'val' && !rule.k.gotValue &&
        rule.child.node !== rule.node) {
      rule.node.children.push(rule.child.node)
      rule.node.value = rule.child.node
      rule.k.gotValue = true
    }
  },

  // ---- designation + designator (phase C.4) ------------------------
  '@designation-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.dsNode) {
      rule.node = rule.k.dsNode
      return
    }
    const node = makeNode('designation')
    rule.k.dsNode = node
    rule.k.takenDrs = undefined
    rule.node = node
  },
  '@designation-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'designator' &&
        rule.child.node && !rule.k.takenDrs?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      if (!rule.k.takenDrs) rule.k.takenDrs = new Set()
      rule.k.takenDrs.add(rule.child)
    }
  },

  '@designator-bo': (_rule: Rule): void => {
    // Node is created by the open alt action (kind depends on which
    // form, member vs index).
  },
  '@dr-take-dot': (rule: Rule): void => {
    rule.node = makeNode('member_designator')
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.kind = 'member'
  },
  '@dr-take-lbracket': (rule: Rule): void => {
    rule.node = makeNode('index_designator')
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.kind = 'index'
  },
  '@dr-needs-id': (rule: Rule): boolean =>
    rule.k.kind === 'member' && !rule.k.tookId,
  '@dr-take-id': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    rule.node.memberName = tkn.src
    pushTokenWithTrivia(rule.node, tkn)
    rule.k.tookId = true
  },
  '@dr-needs-rbracket': (rule: Rule): boolean =>
    rule.k.kind === 'index' && !rule.k.tookRbracket,
  '@dr-take-rbracket': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.tookRbracket = true
  },
  '@designator-bc': (rule: Rule): void => {
    if (rule.k.kind === 'index' &&
        rule.child && rule.child.name === 'val' &&
        rule.child.node && rule.child.node !== rule.node &&
        !rule.k.idxExprAttached) {
      rule.node.children.push(rule.child.node)
      rule.k.idxExprAttached = true
    }
  },

  // ---- string_atom (phase C.7) -------------------------------------
  //
  // Adjacent LIT_STRING tokens merge into a single literal_expression
  // node. The first token creates the node; subsequent r:-recursion
  // appends additional tokens to its children.
  '@string_atom-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.saNode) {
      rule.node = rule.k.saNode
      return
    }
    const node = makeNode('literal_expression')
    node.literalKind = 'LIT_STRING'
    rule.k.saNode = node
    rule.k.taken = false
    rule.node = node
  },
  '@sa-reentered': (rule: Rule): boolean => rule.k.taken === true,
  '@sa-take': (rule: Rule): void => {
    const tkn = (rule.state === 'c' ? rule.c0 : rule.o0) as Token
    pushTokenWithTrivia(rule.node, tkn)
    if (!rule.k.taken) {
      rule.node.value = tkn.src
      rule.k.taken = true
    } else {
      rule.node.value = (rule.node.value || '') + tkn.src
    }
  },

  // ---- generic_selection (phase C.5) -------------------------------
  //
  // State machine across r:-recursion via rule.k:
  //   .kwTaken      KW__GENERIC consumed
  //   .lparenTaken  `(` consumed
  //   .ctrlTaken    controlling expression captured
  //   .commaTaken   the comma between ctrl and the first association
  //   .lastWasAssoc the last consumed component was an association
  //                 (so the next `,` opens another or `)` ends)
  //   .rparenTaken  `)` consumed → finalise
  '@generic_selection-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.gsNode) {
      rule.node = rule.k.gsNode
      return
    }
    const node = makeNode('generic_selection')
    node.associations = []
    rule.k.gsNode = node
    rule.node = node
  },
  '@gs-reentered': (rule: Rule): boolean => rule.k.kwTaken === true,
  '@gs-take-kw': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.kwTaken = true
  },
  '@gs-need-lparen': (rule: Rule): boolean =>
    rule.k.kwTaken === true && !rule.k.lparenTaken,
  '@gs-take-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.lparenTaken = true
  },
  '@gs-need-ctrl': (rule: Rule): boolean =>
    rule.k.lparenTaken === true && !rule.k.ctrlTaken,
  '@gs-need-comma': (rule: Rule): boolean =>
    rule.k.ctrlTaken === true && !rule.k.commaTaken,
  '@gs-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.commaTaken = true
    rule.k.lastWasAssoc = false
  },
  '@gs-need-association': (rule: Rule): boolean =>
    rule.k.commaTaken === true && !rule.k.lastWasAssoc,
  '@gs-after-association': (rule: Rule): boolean =>
    rule.k.lastWasAssoc === true,
  '@gs-need-rparen': (rule: Rule): boolean =>
    rule.k.lastWasAssoc === true && !rule.k.rparenTaken,
  '@gs-take-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.rparenTaken = true
  },
  '@generic_selection-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'generic_controlling_expression' &&
        !rule.k.ctrlTaken) {
      rule.node.children.push(rule.child.node)
      rule.node.controlling = rule.child.node
      rule.k.ctrlTaken = true
      return
    }
    if (rule.child.name === 'generic_association' &&
        !rule.k.takenAssocs?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      rule.node.associations.push(rule.child.node)
      if (!rule.k.takenAssocs) rule.k.takenAssocs = new Set()
      rule.k.takenAssocs.add(rule.child)
      rule.k.lastWasAssoc = true
    }
  },

  // ---- generic_controlling_expression (phase C.5) ------------------
  '@generic_controlling_expression-bo': (rule: Rule): void => {
    rule.node = makeNode('generic_controlling_expression')
  },
  '@generic_controlling_expression-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        rule.child.node !== rule.node && !rule.k.exprAttached) {
      rule.node.children.push(rule.child.node)
      rule.node.expression = rule.child.node
      rule.k.exprAttached = true
    }
  },

  // ---- generic_association (phase C.5) -----------------------------
  '@generic_association-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.gaNode) {
      rule.node = rule.k.gaNode
      return
    }
    const node = makeNode('generic_association')
    rule.k.gaNode = node
    rule.k.gaKind = undefined
    rule.k.gaColonTaken = false
    rule.k.gaValueTaken = false
    rule.k.gaTypeAttached = false
    rule.node = node
  },
  '@ga-reentered': (rule: Rule): boolean => rule.k.gaKind !== undefined,
  '@ga-take-default': (rule: Rule): void => {
    rule.node.associationKind = 'default'
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.gaKind = 'default'
  },
  '@ga-mark-type': (rule: Rule): void => {
    rule.node.associationKind = 'type'
    rule.k.gaKind = 'type'
  },
  '@ga-need-colon': (rule: Rule): boolean =>
    rule.k.gaKind !== undefined && !rule.k.gaColonTaken,
  '@ga-take-colon': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.gaColonTaken = true
  },
  '@ga-need-value': (rule: Rule): boolean =>
    rule.k.gaColonTaken === true && !rule.k.gaValueTaken,
  '@generic_association-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'type_name_assoc' && !rule.k.gaTypeAttached) {
      rule.node.children.push(rule.child.node)
      rule.node.typeName = rule.child.node
      rule.k.gaTypeAttached = true
      return
    }
    if (rule.child.name === 'val' && rule.child.node !== rule.node &&
        !rule.k.gaValueTaken) {
      rule.node.children.push(rule.child.node)
      rule.node.value = rule.child.node
      rule.k.gaValueTaken = true
    }
  },

  // ---- type_name_assoc (phase C.5) ---------------------------------
  '@type_name_assoc-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.tnaNode) {
      rule.node = rule.k.tnaNode
      return
    }
    const node = makeNode('type_name')
    rule.k.tnaNode = node
    rule.k.tnaDepth = 0
    rule.node = node
  },
  '@tna-reentered': (rule: Rule): boolean => !!rule.k.tnaNode,
  '@tna-take': (rule: Rule): void => {
    const tkn = (rule.state === 'c' ? rule.c0 : rule.o0) as Token
    pushTokenWithTrivia(rule.node, tkn)
    const n = tkn.name
    if (n === 'PUNC_LPAREN' || n === 'PUNC_LBRACKET') {
      rule.k.tnaDepth = (rule.k.tnaDepth || 0) + 1
    } else if (n === 'PUNC_RPAREN' || n === 'PUNC_RBRACKET') {
      rule.k.tnaDepth = (rule.k.tnaDepth || 0) - 1
    }
  },
  '@tna-stop': (rule: Rule): boolean => (rule.k.tnaDepth || 0) === 0,

  // ---- statement_expression (phase C.6) ----------------------------
  '@statement_expression-bo': (rule: Rule): void => {
    rule.node = makeNode('statement_expression')
  },
  '@se-take-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  '@se-take-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@statement_expression-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'compound_statement' &&
        rule.child.node && !rule.k.bodyAttached) {
      rule.node.children.push(rule.child.node)
      rule.k.bodyAttached = true
    }
  },

  // ---- spec_loop tagged-specifier relay (phase F.5) ----------------
  //
  // When spec_loop dispatches struct_specifier / enum_specifier via
  // p:, the returned node lands on rule.child. This bc pushes it
  // onto the OWNING declaration's u.specs list (the
  // declaration_specifiers / specifier_qualifier_list scaffolding
  // built by the parent's bo).
  '@spec_loop-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if ((rule.child.name === 'struct_specifier' ||
         rule.child.name === 'enum_specifier' ||
         rule.child.name === 'attribute_spec_gcc' ||
         rule.child.name === 'attribute_spec_msvc' ||
         rule.child.name === 'attribute_spec_c23') &&
        !rule.k.takenTagged?.has(rule.child)) {
      const owner = specOwner(rule)
      if (owner && owner.u.specs) {
        owner.u.specs.children.push(rule.child.node)
        if (!rule.k.takenTagged) rule.k.takenTagged = new Set()
        rule.k.takenTagged.add(rule.child)
      }
    }
  },

  // ---- struct_specifier / union_specifier (phase F.1) --------------
  '@struct_specifier-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.ssNode) {
      rule.node = rule.k.ssNode
      return
    }
    rule.node = makeNode('struct_specifier')
    rule.k.ssNode = rule.node
    rule.k.ssTagTaken = false
    rule.k.ssBodyTaken = false
  },
  '@ss-reentered': (rule: Rule): boolean => !!rule.k.ssKwTaken,
  '@ss-take-kw': (rule: Rule): void => {
    const tkn = rule.o0 as Token
    rule.node.kind = tkn.name === 'KW_UNION' ?
      'union_specifier' : 'struct_specifier'
    pushTokenWithTrivia(rule.node, tkn)
    rule.k.ssKwTaken = true
  },
  '@ss-need-tag': (rule: Rule): boolean =>
    rule.k.ssKwTaken === true && !rule.k.ssTagTaken && !rule.k.ssBodyTaken,
  '@ss-take-tag': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.tagName = tkn.src
    rule.k.ssTagTaken = true
  },
  '@ss-need-body': (rule: Rule): boolean =>
    rule.k.ssKwTaken === true && !rule.k.ssBodyTaken,
  '@struct_specifier-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'member_decl_list' &&
        rule.child.node && !rule.k.ssBodyTaken) {
      rule.node.children.push(rule.child.node)
      rule.k.ssBodyTaken = true
    }
  },

  // ---- member_decl_list (phase F.2) --------------------------------
  '@member_decl_list-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.mdlNode) {
      rule.node = rule.k.mdlNode
      return
    }
    rule.node = makeNode('member_decl_list')
    rule.k.mdlNode = rule.node
    rule.k.mdlOpened = false
  },
  '@mdl-reentered': (rule: Rule): boolean => rule.k.mdlOpened === true,
  '@mdl-take-lbrace': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.mdlOpened = true
  },
  '@mdl-take-rbrace': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@mdl-take-empty-semi': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@member_decl_list-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'struct_declaration' &&
        rule.child.node && !rule.k.takenMembers?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      if (!rule.k.takenMembers) rule.k.takenMembers = new Set()
      rule.k.takenMembers.add(rule.child)
    }
  },

  // ---- struct_declaration (phase F.2) ------------------------------
  '@struct_declaration-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.sdNode) {
      rule.node = rule.k.sdNode
      return
    }
    rule.node = makeNode('struct_declaration')
    // The legacy CST uses `specifier_qualifier_list` (not
    // `declaration_specifiers`) for the spec part of a struct
    // member. Build the scaffolding here so the spec-absorbers can
    // populate it.
    rule.u.specs = makeNode('specifier_qualifier_list')
    rule.u.sdl = makeNode('struct_declarator_list')
    rule.k.sdNode = rule.node
  },
  '@sd-reentered': (rule: Rule): boolean => !!rule.k.sdSpecsAttached,
  '@sd-absorb-spec-storage': (rule: Rule): void => {
    const owner = specOwner(rule)
    pushTokenWithTrivia(owner.u.specs, rule.o0 as Token)
  },
  '@sd-absorb-spec-type': (rule: Rule): void => {
    const owner = specOwner(rule)
    pushTokenWithTrivia(owner.u.specs, rule.o0 as Token)
  },
  '@sd-need-decl-first': (rule: Rule): boolean =>
    !rule.k.sdAnyDecl,
  '@sd-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.u.sdl, rule.c0 as Token)
  },
  '@sd-take-semi': (rule: Rule): void => {
    if (!rule.k.sdSpecsAttached) {
      rule.node.children.push(rule.u.specs)
      rule.k.sdSpecsAttached = true
    }
    if (rule.u.sdl.children.length > 0 && !rule.k.sdSdlAttached) {
      rule.node.children.push(rule.u.sdl)
      rule.k.sdSdlAttached = true
    }
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@struct_declaration-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'struct_declarator' &&
        rule.child.node && !rule.k.takenSdrs?.has(rule.child)) {
      rule.u.sdl.children.push(rule.child.node)
      rule.k.sdAnyDecl = true
      if (!rule.k.takenSdrs) rule.k.takenSdrs = new Set()
      rule.k.takenSdrs.add(rule.child)
    }
  },

  // ---- struct_declarator (phase F.2) -------------------------------
  '@struct_declarator-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.sdrNode) {
      rule.node = rule.k.sdrNode
      return
    }
    rule.node = makeNode('struct_declarator')
    rule.k.sdrNode = rule.node
  },
  '@sdr-reentered': (rule: Rule): boolean => !!rule.k.sdrDeclTaken,
  '@sdr-mark-anon-bf': (rule: Rule): void => {
    rule.k.sdrAnonBf = true
  },
  '@sdr-need-bf': (rule: Rule): boolean =>
    rule.k.sdrDeclTaken === true && !rule.k.sdrBfTaken,
  '@struct_declarator-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'init_declarator' &&
        !rule.k.sdrDeclTaken) {
      // The init_declarator nests its declarator child; lift it
      // out so the legacy CST shape (struct_declarator wraps
      // declarator + bitfield_width) is preserved.
      const idl = rule.child.node
      const decl = (idl.children || []).find(
        (c: any) => c.kind === 'declarator',
      )
      if (decl) {
        rule.node.children.push(decl)
        if (idl.declaredName) rule.node.declaredName = idl.declaredName
      }
      rule.k.sdrDeclTaken = true
      return
    }
    if (rule.child.name === 'bitfield_width' &&
        !rule.k.sdrBfTaken) {
      rule.node.children.push(rule.child.node)
      rule.k.sdrBfTaken = true
    }
  },

  // ---- bitfield_width (phase F.2) ----------------------------------
  '@bitfield_width-bo': (rule: Rule): void => {
    rule.node = makeNode('bitfield_width')
  },
  '@bfw-take-colon': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
  },
  '@bitfield_width-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        rule.child.node !== rule.node && !rule.k.bfExprAttached) {
      rule.node.children.push(rule.child.node)
      rule.k.bfExprAttached = true
    }
  },

  // ---- enum_specifier (phase F.3) ----------------------------------
  '@enum_specifier-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.esNode) {
      rule.node = rule.k.esNode
      return
    }
    rule.node = makeNode('enum_specifier')
    rule.k.esNode = rule.node
  },
  '@es-tag-reentered': (rule: Rule): boolean => !!rule.k.esKwTaken,
  '@es-take-kw': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.esKwTaken = true
  },
  '@es-need-tag': (rule: Rule): boolean =>
    rule.k.esKwTaken === true && !rule.k.esTagTaken &&
    !rule.k.esUtypeTaken && !rule.k.esBodyTaken,
  '@es-take-tag': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.tagName = tkn.src
    rule.k.esTagTaken = true
  },
  '@es-need-utype': (rule: Rule): boolean =>
    rule.k.esKwTaken === true && !rule.k.esUtypeTaken &&
    !rule.k.esBodyTaken,
  '@es-take-utype-colon': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.esUtypeTaken = true
  },
  '@es-need-body': (rule: Rule): boolean =>
    rule.k.esKwTaken === true && !rule.k.esBodyTaken,
  '@enum_specifier-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'enum_utype_specs' &&
        !rule.k.esUtypeAttached) {
      // Lift the inner declaration_specifiers up.
      const sub = rule.child.node
      if (sub.children && sub.children.length > 0) {
        for (const c of sub.children) rule.node.children.push(c)
      }
      rule.k.esUtypeAttached = true
      return
    }
    if (rule.child.name === 'enumerator_list' && !rule.k.esBodyTaken) {
      rule.node.children.push(rule.child.node)
      rule.k.esBodyTaken = true
    }
  },

  // ---- enum_utype_specs (phase F.3) --------------------------------
  '@enum_utype_specs-bo': (rule: Rule): void => {
    rule.node = makeNode('declaration_specifiers')
    rule.u.specs = rule.node
  },
  '@eus-absorb-spec': (rule: Rule): void => {
    pushTokenWithTrivia(rule.u.specs, rule.o0 as Token)
  },

  // ---- enumerator_list (phase F.4) ---------------------------------
  '@enumerator_list-bo': (rule: Rule): void => {
    if ((globalThis as any).Q22_DEBUG) {
      const keys = Object.keys(rule.k).filter(k => k !== 'tokens')
      console.error('EL-BO', { keys, parent: rule.parent?.name, prev: rule.prev?.name, hasElNode: 'elNode' in rule.k })
    }
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.elNode) {
      rule.node = rule.k.elNode
      return
    }
    rule.node = makeNode('enumerator_list')
    rule.k.elNode = rule.node
    rule.k.elOpened = false
  },
  '@el-reentered': (rule: Rule): boolean => rule.k.elOpened === true,
  '@el-take-lbrace': (rule: Rule): void => {
    if ((globalThis as any).Q22_DEBUG) console.error('EL-LBRACE')
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.elOpened = true
  },
  '@el-take-rbrace': (rule: Rule): void => {
    if ((globalThis as any).Q22_DEBUG) console.error('EL-RBRACE')
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@el-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@enumerator_list-bc': (rule: Rule, ctx: Context): void => {
    if ((globalThis as any).Q22_DEBUG) {
      const t0 = (ctx as any).t?.[0]?.name
      const t1 = (ctx as any).t?.[1]?.name
      console.error('EL-BC', { childName: rule.child?.name, hasNode: !!rule.child?.node, t0, t1 })
    }
    if (rule.child && rule.child.name === 'enumerator' &&
        rule.child.node && !rule.k.takenEnums?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      if (!rule.k.takenEnums) rule.k.takenEnums = new Set()
      rule.k.takenEnums.add(rule.child)
    }
  },

  // ---- enumerator (phase F.4) --------------------------------------
  '@enumerator-bo': (rule: Rule): void => {
    if ((globalThis as any).Q22_DEBUG) {
      const ctx = (rule as any).ctx || (rule as any)._ctx
      console.error('ENR-BO ctxT0:', ctx?.t0?.name)
    }
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.enrNode) {
      rule.node = rule.k.enrNode
      return
    }
    rule.node = makeNode('enumerator')
    rule.k.enrNode = rule.node
  },
  '@enr-reentered': (rule: Rule): boolean => !!rule.k.enrNameTaken,
  '@enr-take-name': (rule: Rule): void => {
    const tkn = rule.o0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.declaredName = tkn.src
    rule.k.enrNameTaken = true
  },
  '@enr-need-eq': (rule: Rule): boolean =>
    rule.k.enrNameTaken === true && !rule.k.enrEqTaken,
  '@enr-take-eq': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.enrEqTaken = true
  },
  '@enumerator-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        rule.child.node !== rule.node && !rule.k.enrValueAttached) {
      // Wrap the const-expr in an `initializer` node to match the
      // legacy CST.
      const init = makeNode('initializer')
      init.children.push(rule.child.node)
      rule.node.children.push(init)
      rule.k.enrValueAttached = true
    }
    // C23 attribute on enumerator (e.g. `A [[deprecated]] = 1`).
    // Append the returned attribute_spec_c23 onto the enumerator
    // node so consumers can find it via findKind. Track per-child
    // to avoid double-attaching when r:'enumerator' re-fires bc.
    if (rule.child && rule.child.name === 'attribute_spec_c23' &&
        rule.child.node) {
      if (!rule.k.enrAttrTaken) rule.k.enrAttrTaken = new Set()
      if (!rule.k.enrAttrTaken.has(rule.child)) {
        rule.node.children.push(rule.child.node)
        rule.k.enrAttrTaken.add(rule.child)
      }
    }
  },

  // ---- attribute_spec_gcc (phase G.2) ------------------------------
  //
  // State machine across r:-recursion via rule.k:
  //   .kwTaken         keyword consumed (open-state re-entry sentinel)
  //   .outerLparen     outer `(` consumed
  //   .innerLparen     inner `(` consumed (GCC double-paren form)
  //   .lastWasItem     last consumed component was an attribute_item
  //                    (controls comma-or-rparen alt)
  //   .innerRparen     inner `)` consumed
  '@attribute_spec_gcc-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.asgNode) {
      rule.node = rule.k.asgNode
      return
    }
    const node = makeNode('attribute_spec')
    node.attributeForm = 'gcc'
    node.items = []
    rule.k.asgNode = node
    rule.node = node
  },
  '@asg-reentered': (rule: Rule): boolean => rule.k.asgKwTaken === true,
  '@asg-take-kw': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.asgKwTaken = true
  },
  '@asg-need-outer-lparen': (rule: Rule): boolean =>
    rule.k.asgKwTaken === true && !rule.k.asgOuterLparen,
  '@asg-take-outer-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.asgOuterLparen = true
  },
  '@asg-need-inner-lparen': (rule: Rule): boolean =>
    rule.k.asgOuterLparen === true && !rule.k.asgInnerLparen,
  '@asg-take-inner-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.asgInnerLparen = true
  },
  '@asg-need-comma': (rule: Rule): boolean =>
    rule.k.asgInnerLparen === true && rule.k.asgLastWasItem === true &&
    !rule.k.asgInnerRparen,
  '@asg-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.asgLastWasItem = false
  },
  '@asg-need-item': (rule: Rule): boolean =>
    rule.k.asgInnerLparen === true && !rule.k.asgLastWasItem &&
    !rule.k.asgInnerRparen,
  '@asg-need-inner-rparen': (rule: Rule): boolean =>
    rule.k.asgInnerLparen === true && !rule.k.asgInnerRparen,
  '@asg-take-inner-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.asgInnerRparen = true
  },
  '@asg-need-outer-rparen': (rule: Rule): boolean =>
    rule.k.asgInnerRparen === true && !rule.k.asgOuterRparen,
  '@asg-take-outer-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.asgOuterRparen = true
  },
  '@attribute_spec_gcc-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'attribute_item' &&
        rule.child.node && !rule.k.takenItems?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      rule.node.items.push(rule.child.node)
      rule.k.asgLastWasItem = true
      if (!rule.k.takenItems) rule.k.takenItems = new Set()
      rule.k.takenItems.add(rule.child)
    }
  },

  // ---- attribute_spec_msvc (phase G.3) -----------------------------
  '@attribute_spec_msvc-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.asm2Node) {
      rule.node = rule.k.asm2Node
      return
    }
    const node = makeNode('attribute_spec')
    node.attributeForm = 'msvc'
    node.items = []
    rule.k.asm2Node = node
    rule.node = node
  },
  '@asm2-reentered': (rule: Rule): boolean => rule.k.asm2KwTaken === true,
  '@asm2-take-kw': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.asm2KwTaken = true
  },
  '@asm2-need-lparen': (rule: Rule): boolean =>
    rule.k.asm2KwTaken === true && !rule.k.asm2Lparen,
  '@asm2-take-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.asm2Lparen = true
  },
  '@asm2-need-comma': (rule: Rule): boolean =>
    rule.k.asm2Lparen === true && rule.k.asm2LastWasItem === true &&
    !rule.k.asm2Rparen,
  '@asm2-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.asm2LastWasItem = false
  },
  '@asm2-need-item': (rule: Rule): boolean =>
    rule.k.asm2Lparen === true && !rule.k.asm2LastWasItem &&
    !rule.k.asm2Rparen,
  '@asm2-need-rparen': (rule: Rule): boolean =>
    rule.k.asm2Lparen === true && !rule.k.asm2Rparen,
  '@asm2-take-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.asm2Rparen = true
  },
  '@attribute_spec_msvc-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'attribute_item' &&
        rule.child.node && !rule.k.takenItems?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      rule.node.items.push(rule.child.node)
      rule.k.asm2LastWasItem = true
      if (!rule.k.takenItems) rule.k.takenItems = new Set()
      rule.k.takenItems.add(rule.child)
    }
  },

  // ---- attribute_spec_c23 (phase G.1) ------------------------------
  //
  // Adjacency conds use the Token's sI/len fields to ensure two `[`
  // (or `]`) are physically adjacent in the source — this is what
  // distinguishes `[[…]]` from a nested array subscript `[ [x] ]`.
  '@as23-adjacent-open': (_rule: Rule, ctx: Context): boolean => {
    const a = ctx.t[0] as any, b = ctx.t[1] as any
    return !!(a && b && a.sI + a.len === b.sI)
  },
  '@as23-adjacent-close': (rule: Rule): boolean => {
    const a = rule.c0 as any, b = rule.c1 as any
    return !!(a && b && a.sI + a.len === b.sI)
  },
  '@attribute_spec_c23-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.as23Node) {
      rule.node = rule.k.as23Node
      return
    }
    const node = makeNode('attribute_spec')
    node.attributeForm = 'c23'
    node.items = []
    rule.k.as23Node = node
    rule.node = node
  },
  '@as23-reentered': (rule: Rule): boolean => rule.k.as23Open === true,
  '@as23-take-open': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    pushTokenWithTrivia(rule.node, rule.o1 as Token)
    rule.k.as23Open = true
  },
  '@as23-need-comma': (rule: Rule): boolean =>
    rule.k.as23Open === true && rule.k.as23LastWasItem === true &&
    !rule.k.as23Closed,
  '@as23-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.as23LastWasItem = false
  },
  '@as23-need-item': (rule: Rule): boolean =>
    rule.k.as23Open === true && !rule.k.as23LastWasItem &&
    !rule.k.as23Closed,
  '@as23-need-close': (rule: Rule): boolean =>
    rule.k.as23Open === true && !rule.k.as23Closed,
  '@as23-take-close': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    pushTokenWithTrivia(rule.node, rule.c1 as Token)
    rule.k.as23Closed = true
  },
  '@attribute_spec_c23-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'attribute_item' &&
        rule.child.node && !rule.k.takenItems?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      rule.node.items.push(rule.child.node)
      rule.k.as23LastWasItem = true
      if (!rule.k.takenItems) rule.k.takenItems = new Set()
      rule.k.takenItems.add(rule.child)
    }
  },

  // ---- attribute_item (phase G.4) ----------------------------------
  '@attribute_item-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.aiNode) {
      rule.node = rule.k.aiNode
      return
    }
    rule.node = makeNode('attribute_item')
    rule.k.aiNode = rule.node
  },
  '@ai-reentered': (rule: Rule): boolean => rule.k.aiNameTaken === true,
  '@ai-take-name': (rule: Rule): void => {
    const tkn = rule.o0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.attributeName = tkn.src
    rule.k.aiNameTaken = true
  },
  '@ai-need-colon-1': (rule: Rule): boolean => {
    // The alt's `s: 'PUNC_COLON PUNC_COLON'` ensures both colons
    // are physically present (parse_alts force-fetches both); the
    // cond just gates by rule state.
    return !!rule.k.aiNameTaken && !rule.k.aiPrefixed
  },
  '@ai-take-colon-1': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.aiColon1 = true
  },
  '@ai-need-colon-2': (rule: Rule): boolean =>
    rule.k.aiColon1 === true && !rule.k.aiColon2,
  '@ai-take-colon-2': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.aiColon2 = true
  },
  '@ai-need-prefixed-name': (rule: Rule): boolean =>
    rule.k.aiColon2 === true && !rule.k.aiPrefixed,
  '@ai-take-prefixed-name': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.attributePrefix = rule.node.attributeName
    rule.node.attributeName = tkn.src
    rule.k.aiPrefixed = true
  },
  '@ai-need-args': (rule: Rule): boolean =>
    rule.k.aiNameTaken === true && !rule.k.aiArgsTaken,
  '@attribute_item-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'attribute_argument_list' &&
        rule.child.node && !rule.k.aiArgsTaken) {
      rule.node.children.push(rule.child.node)
      rule.node.argumentList = rule.child.node
      rule.k.aiArgsTaken = true
    }
  },

  // ---- attribute_argument_list (phase G.4) -------------------------
  '@attribute_argument_list-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.aalNode) {
      rule.node = rule.k.aalNode
      return
    }
    rule.node = makeNode('attribute_argument_list')
    rule.k.aalNode = rule.node
  },
  '@aal-reentered': (rule: Rule): boolean => rule.k.aalLparen === true,
  '@aal-take-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.aalLparen = true
  },
  '@aal-take-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@aal-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@attribute_argument_list-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'val' && rule.child.node &&
        rule.child.node !== rule.node && !rule.k.takenArgs?.has(rule.child)) {
      rule.node.children.push(rule.child.node)
      if (!rule.k.takenArgs) rule.k.takenArgs = new Set()
      rule.k.takenArgs.add(rule.child)
    }
  },

  // ---- preprocessor_directive dispatcher (phase H.1) ---------------
  //
  // Each `@ppd-is-X` cond peeks ctx.t[1] (the directive name token,
  // since ctx.t[0] is PP_HASH) and matches by src.
  '@preprocessor_directive-bo': (rule: Rule): void => {
    // Build a wrapper whose `children` will hold the structured
    // directive node as its only entry. external_declaration's
    // @finalize-new-path splices childNode.children into the
    // external_declaration node, so the resulting tree is
    // `external_declaration { children: [<directive>], declKind:
    // 'declaration' }`, matching the legacy CST.
    const node = makeNode('preprocessor_directive_wrapper')
    node.declKind = 'declaration'
    rule.node = node
  },
  '@preprocessor_directive-bc': (rule: Rule): void => {
    if (rule.child && rule.child.node && !rule.k.directiveAttached) {
      const n = rule.child.name
      if (n === 'define_directive' || n === 'undef_directive' ||
          n === 'include_directive' || n === 'conditional_directive' ||
          n === 'simple_directive') {
        rule.node.children.push(rule.child.node)
        rule.k.directiveAttached = true
      }
    }
  },
  // The preprocessor_directive open alts use a 2-token `s:` pattern
  // (`PP_HASH #ANY_C_TOKEN`); these conds inspect rule.o1 (the
  // second matched token — the directive-name ID lexed from the
  // line body). Reading rule.o* instead of ctx.t[*] avoids the
  // NOTOKEN-in-place gap that bites callers using ctx.t for
  // lookahead past the parser's consume-and-shift.
  '@ppd-is-define': (rule: Rule): boolean =>
    rule.o1?.src === 'define',
  '@ppd-is-undef': (rule: Rule): boolean =>
    rule.o1?.src === 'undef',
  '@ppd-is-include': (rule: Rule): boolean => {
    const s = rule.o1?.src
    return s === 'include' || s === 'include_next' || s === 'embed'
  },
  '@ppd-is-conditional': (rule: Rule): boolean => {
    const s = rule.o1?.src
    return s === 'if' || s === 'ifdef' || s === 'ifndef' ||
           s === 'elif' || s === 'elifdef' || s === 'elifndef' ||
           s === 'else' || s === 'endif'
  },
  '@ppd-is-simple': (rule: Rule): boolean => {
    const s = rule.o1?.src
    return s === 'pragma' || s === 'error' || s === 'warning' ||
           s === 'line'
  },

  // ---- define_directive (phase H.2) --------------------------------
  '@define_directive-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.defNode) {
      rule.node = rule.k.defNode
      return
    }
    const node = makeNode('define_directive')
    rule.k.defNode = node
    rule.node = node
  },
  '@def-reentered': (rule: Rule): boolean => rule.k.defHashTaken === true,
  '@def-take-hash': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.defHashTaken = true
  },
  '@def-need-keyword': (rule: Rule): boolean =>
    rule.k.defHashTaken === true && !rule.k.defKwTaken,
  '@def-take-keyword': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.defKwTaken = true
  },
  '@def-need-name': (rule: Rule): boolean =>
    rule.k.defKwTaken === true && !rule.k.defNameTaken,
  '@def-take-name': (rule: Rule, ctx: Context): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.macroName = tkn.src
    rule.k.defNameTaken = true
    rule.k.defNameTokenEnd = (tkn as any).sI + (tkn as any).len
    // Register the macro as soon as the name lands so subsequent
    // identifier classifications see it. Match the legacy
    // registerMacrosFromTree behaviour.
    const cmeta = (ctx.meta as any).cmeta as CMeta
    if (cmeta && cmeta.macros && tkn.src) {
      cmeta.macros.define({ name: tkn.src, isFunctionLike: false })
      reclassifyAsMacro(ctx, tkn.src)
    }
  },
  '@def-paren-adjacent': (rule: Rule, ctx: Context): boolean => {
    if (!rule.k.defNameTaken || rule.k.defParamsTaken ||
        rule.k.defBodyTaken) return false
    const t0 = ctx.t[0] as any
    if (!t0 || t0.name !== 'PUNC_LPAREN') return false
    return t0.sI === rule.k.defNameTokenEnd
  },
  '@def-need-body': (rule: Rule): boolean =>
    rule.k.defNameTaken === true && !rule.k.defBodyTaken,
  '@def-need-newline': (rule: Rule): boolean =>
    rule.k.defBodyTaken === true && !rule.k.defNewlineTaken,
  '@def-take-newline': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.defNewlineTaken = true
  },
  '@define_directive-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'macro_parameter_list' &&
        !rule.k.defParamsTaken) {
      rule.node.children.push(rule.child.node)
      rule.node.macroKind = 'function-like'
      rule.node.macroParams = (rule.child.node as any).macroParams || []
      if ((rule.child.node as any).macroVariadic) {
        rule.node.macroVariadic = true
      }
      rule.k.defParamsTaken = true
      return
    }
    if (rule.child.name === 'macro_body' && !rule.k.defBodyTaken) {
      rule.node.children.push(rule.child.node)
      if (!rule.node.macroKind) rule.node.macroKind = 'object-like'
      rule.k.defBodyTaken = true
    }
  },

  // ---- macro_parameter_list (phase H.2) ----------------------------
  '@macro_parameter_list-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.mplNode) {
      rule.node = rule.k.mplNode
      return
    }
    const node = makeNode('macro_parameter_list')
    ;(node as any).macroParams = []
    rule.k.mplNode = node
    rule.node = node
  },
  '@mpl-reentered': (rule: Rule): boolean => rule.k.mplOpen === true,
  '@mpl-take-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.mplOpen = true
  },
  '@mpl-take-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@mpl-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@mpl-take-ellipsis': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    ;(rule.node as any).macroVariadic = true
  },
  '@mpl-take-param': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    ;(rule.node as any).macroParams.push(tkn.src)
  },
  '@mpl-absorb-other': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // ---- macro_body (phase H.2) --------------------------------------
  '@macro_body-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.mbNode) {
      rule.node = rule.k.mbNode
      return
    }
    const node = makeNode('macro_body')
    rule.k.mbNode = node
    rule.node = node
  },
  '@mb-reentered': (rule: Rule): boolean => rule.k.mbAny === true,
  '@mb-take': (rule: Rule): void => {
    const tkn = (rule.state === 'c' ? rule.c0 : rule.o0) as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.k.mbAny = true
  },

  // ---- undef_directive (phase H.6) ---------------------------------
  '@undef_directive-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.undNode) {
      rule.node = rule.k.undNode
      return
    }
    const node = makeNode('undef_directive')
    rule.k.undNode = node
    rule.node = node
  },
  '@undef-reentered': (rule: Rule): boolean => rule.k.undHashTaken === true,
  '@undef-take-hash': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.undHashTaken = true
  },
  '@undef-need-keyword': (rule: Rule): boolean =>
    rule.k.undHashTaken === true && !rule.k.undKwTaken,
  '@undef-take-keyword': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.undKwTaken = true
  },
  '@undef-need-name': (rule: Rule): boolean =>
    rule.k.undKwTaken === true && !rule.k.undNameTaken,
  '@undef-take-name': (rule: Rule, ctx: Context): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.macroName = tkn.src
    rule.k.undNameTaken = true
    const cmeta = (ctx.meta as any).cmeta as CMeta
    if (cmeta && cmeta.macros && tkn.src) {
      cmeta.macros.undefine(tkn.src)
      reclassifyAsId(ctx, tkn.src)
    }
  },
  '@undef-take-newline': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@undef-absorb-trailing': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // ---- include_directive (phase H.3) -------------------------------
  '@include_directive-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.incNode) {
      rule.node = rule.k.incNode
      return
    }
    const node = makeNode('include_directive')
    rule.k.incNode = node
    rule.node = node
  },
  '@inc-reentered': (rule: Rule): boolean => rule.k.incHashTaken === true,
  '@inc-take-hash': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.incHashTaken = true
  },
  '@inc-need-keyword': (rule: Rule): boolean =>
    rule.k.incHashTaken === true && !rule.k.incKwTaken,
  '@inc-take-keyword': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.includeForm = tkn.src
    rule.k.incKwTaken = true
  },
  '@inc-need-header': (rule: Rule): boolean =>
    rule.k.incKwTaken === true && !rule.k.incHeaderTaken,
  '@inc-take-header': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.headerName = tkn.src
    rule.node.headerKind = tkn.src.startsWith('<') ? 'angled' : 'quoted'
    rule.k.incHeaderTaken = true
  },
  '@inc-need-form': (rule: Rule, ctx: Context): boolean => {
    if (!rule.k.incKwTaken || rule.k.incHeaderTaken ||
        rule.k.incFormTaken) return false
    return ctx.t[0]?.name !== 'PP_NEWLINE' && !!ctx.t[0]
  },
  '@inc-take-newline': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@include_directive-bc': (rule: Rule): void => {
    if (rule.child && rule.child.name === 'header_form' &&
        rule.child.node && !rule.k.incFormTaken) {
      rule.node.children.push(rule.child.node)
      rule.k.incFormTaken = true
    }
  },

  // ---- header_form (phase H.3) -------------------------------------
  '@header_form-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.hfNode) {
      rule.node = rule.k.hfNode
      return
    }
    const node = makeNode('header_form')
    rule.k.hfNode = node
    rule.node = node
  },
  '@hf-reentered': (rule: Rule): boolean => rule.k.hfAny === true,
  '@hf-take': (rule: Rule): void => {
    const tkn = (rule.state === 'c' ? rule.c0 : rule.o0) as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.k.hfAny = true
  },

  // ---- conditional_directive (phase H.4) ---------------------------
  '@conditional_directive-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.condNode) {
      rule.node = rule.k.condNode
      return
    }
    const node = makeNode('conditional_directive')
    rule.k.condNode = node
    rule.node = node
  },
  '@cond-reentered': (rule: Rule): boolean => rule.k.condHashTaken === true,
  '@cond-take-hash': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.condHashTaken = true
  },
  '@cond-need-keyword': (rule: Rule): boolean =>
    rule.k.condHashTaken === true && !rule.k.condKwTaken,
  '@cond-take-keyword': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    rule.node.directive = tkn.src
    rule.k.condKwTaken = true
  },
  '@cond-take-newline': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@cond-absorb': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // ---- simple_directive (phase H.5) --------------------------------
  '@simple_directive-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.sd2Node) {
      rule.node = rule.k.sd2Node
      return
    }
    // Kind decided in @sd2-take-keyword based on the directive
    // name token. Default to 'unknown_directive' for unrecognised.
    const node = makeNode('unknown_directive')
    rule.k.sd2Node = node
    rule.node = node
  },
  '@sd2-reentered': (rule: Rule): boolean => rule.k.sd2HashTaken === true,
  '@sd2-take-hash': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.sd2HashTaken = true
  },
  '@sd2-need-keyword': (rule: Rule): boolean =>
    rule.k.sd2HashTaken === true && !rule.k.sd2KwTaken,
  '@sd2-take-keyword': (rule: Rule): void => {
    const tkn = rule.c0 as Token
    pushTokenWithTrivia(rule.node, tkn)
    const kindMap: Record<string, string> = {
      pragma: 'pragma_directive',
      error: 'error_directive',
      warning: 'warning_directive',
      line: 'line_directive',
    }
    rule.node.kind = kindMap[tkn.src] || 'unknown_directive'
    rule.k.sd2KwTaken = true
  },
  '@sd2-take-newline': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },
  '@sd2-absorb': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
  },

  // ---- static_assert_declaration (phase I.1) -----------------------
  //
  // State machine across r:-recursion via rule.k:
  //   .saKwTaken     keyword consumed
  //   .saLparen      `(` consumed
  //   .saCondTaken   condition expression captured
  //   .saComma       comma between cond and message consumed
  //   .saMsgTaken    message expression captured (optional)
  //   .saRparen      `)` consumed
  //   .saSemi        `;` consumed
  '@static_assert_declaration-bo': (rule: Rule): void => {
    const prev = (rule as any).prev
    const isRecursion = prev && prev.name === rule.name
    if (isRecursion && rule.k.saNode) {
      rule.node = rule.k.saNode
      return
    }
    const node = makeNode('static_assert_declaration')
    rule.k.saNode = node
    rule.node = node
  },
  '@said-reentered': (rule: Rule): boolean => rule.k.saKwTaken === true,
  '@said-take-kw': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.o0 as Token)
    rule.k.saKwTaken = true
  },
  '@said-need-lparen': (rule: Rule): boolean =>
    rule.k.saKwTaken === true && !rule.k.saLparen,
  '@said-take-lparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.saLparen = true
    // Phase O: suppress comma-op while parsing the cond / msg vals
    // so the `,` separator lands as a static_assert separator
    // rather than being absorbed by C_OP_TABLE['comma'] in
    // @jsonic/expr's Pratt loop.
    rule.n.no_comma_op = (rule.n.no_comma_op || 0) + 1
  },
  '@said-need-cond': (rule: Rule): boolean =>
    rule.k.saLparen === true && !rule.k.saCondTaken,
  '@said-mark-cond': (_rule: Rule): void => {
    // Cond will be picked up via -bc on val return.
  },
  '@said-need-comma': (rule: Rule): boolean =>
    rule.k.saCondTaken === true && !rule.k.saComma && !rule.k.saRparen,
  '@said-take-comma': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.saComma = true
  },
  '@said-need-msg': (rule: Rule): boolean =>
    rule.k.saComma === true && !rule.k.saMsgTaken,
  '@said-mark-msg': (_rule: Rule): void => {
    // Msg picked up via -bc.
  },
  '@said-need-rparen': (rule: Rule): boolean =>
    rule.k.saCondTaken === true && !rule.k.saRparen,
  '@said-take-rparen': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.saRparen = true
  },
  '@said-need-semi': (rule: Rule): boolean =>
    rule.k.saRparen === true && !rule.k.saSemi,
  '@said-take-semi': (rule: Rule): void => {
    pushTokenWithTrivia(rule.node, rule.c0 as Token)
    rule.k.saSemi = true
  },
  '@static_assert_declaration-bc': (rule: Rule): void => {
    if (!rule.child || !rule.child.node) return
    if (rule.child.name === 'val' && rule.child.node !== rule.node) {
      if (!rule.k.saCondTaken) {
        rule.node.children.push(rule.child.node)
        rule.node.condition = rule.child.node
        rule.k.saCondTaken = true
      } else if (rule.k.saComma && !rule.k.saMsgTaken) {
        rule.node.children.push(rule.child.node)
        rule.node.message = rule.child.node
        rule.k.saMsgTaken = true
      }
    }
  },
}
}

// Push a token-ref onto `node`, prefixed with any preserved trivia
// (comments, line continuations) the sub-lex hook stashed on
// Strip stale took*/elseSeen control-flow tracking keys from a
// rule's k. Each control-flow rule (if/while/do/for/switch/
// for_controls) uses the SAME generic key names (tookCond,
// tookBody, tookThen, etc.), so the shallow-copy-on-push that
// jsonic does at every rule transition leaks state between nested
// statements — `if (1) for (;;) ;` would inherit if's tookCond
// into for_controls and bypass the cond-fetching alts.
function clearStmtState(rule: Rule): void {
  delete rule.k.tookCond; delete rule.k.tookBody
  delete rule.k.tookThen; delete rule.k.elseSeen
  delete rule.k.tookElse
  delete rule.k.tookWhile; delete rule.k.tookSemi
  delete rule.k.tookInit; delete rule.k.tookIter
  delete rule.k.tookControls
}

// tkn.use.leading. Mirrors the chomp's @absorb-token logic so the
// new-path CST carries the same source-order trivia siblings.
function pushTokenWithTrivia(node: CNode, tkn: Token): void {
  for (const tr of leadingTriviaRefs(tkn)) node.children.push(tr)
  node.children.push(tokenRef(tkn))
}

// Attach a completed function_postfix node onto its parent
// init_declarator's direct_declarator. Mirrors what @arr-close does
// for array_postfix.
function attachFunctionPostfix(rule: Rule): void {
  const owner = rule.parent as Rule
  if (owner && owner.k && owner.k.directDeclarator) {
    owner.k.directDeclarator.children.push(rule.node)
  }
}

// Locate the simple_declaration rule that owns the per-declaration
// scaffolding, regardless of whether the action is firing on
// simple_declaration itself or on its spec_loop child.
function specOwner(rule: Rule): Rule {
  if (rule.name === 'simple_declaration' ||
      rule.name === 'struct_declaration') return rule
  return rule.parent as Rule
}

// Token-name sets used by @looks-simple-decl. Mirror the SIMPLE_TYPE_HEAD
// and STORAGE_PREFIX option-level token sets but kept here for fast
// lookup inside the cond function (which is called per-dispatch).
const simpleTypeHeadSet = new Set<string>([
  'KW_VOID', 'KW_CHAR', 'KW_SHORT', 'KW_INT', 'KW_LONG',
  'KW_FLOAT', 'KW_DOUBLE',
  'KW_SIGNED', 'KW_UNSIGNED',
  'KW_BOOL', 'KW__BOOL',
  'KW___SIGNED__', 'KW___SIGNED',
  'KW___INT8', 'KW___INT16', 'KW___INT32', 'KW___INT64',
  'KW__COMPLEX', 'KW__IMAGINARY',
  'TYPEDEF_NAME',
  'KW_CONST', 'KW_VOLATILE', 'KW_RESTRICT', 'KW__ATOMIC',
  'KW___CONST__', 'KW___CONST',
  'KW___VOLATILE__', 'KW___VOLATILE',
  'KW___RESTRICT__', 'KW___RESTRICT',
  'KW_STRUCT', 'KW_UNION', 'KW_ENUM',
])
const storagePrefixSet = new Set<string>([
  'KW_STATIC', 'KW_EXTERN', 'KW_TYPEDEF',
  'KW_AUTO', 'KW_REGISTER',
  'KW__THREAD_LOCAL', 'KW_THREAD_LOCAL', 'KW_CONSTEXPR',
  'KW___THREAD',
  'KW_INLINE', 'KW___INLINE__', 'KW___INLINE',
  'KW___EXTENSION__',
])

function leadingTriviaRefs(tkn: Token): CTokenRef[] {
  const leading = (tkn as any).use && (tkn as any).use.leading
  if (!Array.isArray(leading)) return []
  return leading.map((lt: Token) => tokenRef(lt))
}

// ---- Helpers --------------------------------------------------------

// Trivia whose source we want to keep in the AST (comments, line
// continuations) — captured by the sub-lex hook and re-emitted as token
// refs ahead of the next non-trivia token.
const PRESERVE_TRIVIA_NAMES = new Set<string>([
  'TRIVIA_LINE_COMMENT', 'TRIVIA_BLOCK_COMMENT', 'TRIVIA_LINE_CONT',
])

// Trivia we drop entirely from the AST (whitespace, raw newlines).
// Spans on real tokens still carry positional info.
const DROP_TRIVIA_NAMES = new Set<string>([
  '#SP', '#LN', '#CM',
])

// Union, used by helpers that need to recognise any trivia regardless of
// whether it survives in the tree.
const TRIVIA_TOKEN_NAMES = new Set<string>([
  ...PRESERVE_TRIVIA_NAMES,
  ...DROP_TRIVIA_NAMES,
])

// Type qualifiers in declarator pointer position. Used to skip past
// `* const`, `* volatile`, etc. when locating a declared name.
const PTR_QUALIFIER_TOKEN_NAMES = new Set<string>([
  'KW_CONST', 'KW_VOLATILE', 'KW_RESTRICT', 'KW__ATOMIC',
  'KW___CONST__', 'KW___CONST',
  'KW___VOLATILE__', 'KW___VOLATILE',
  'KW___RESTRICT__', 'KW___RESTRICT',
])

// Tokens that begin a type-specifier in declaration_specifiers. We use
// this to find the boundary between specifiers and declarators, by
// stopping at a non-specifier token (i.e. *, ID, ( as start-of-decl,
// etc).
const TYPE_SPEC_KEYWORD_NAMES = new Set<string>([
  'KW_VOID', 'KW_CHAR', 'KW_SHORT', 'KW_INT', 'KW_LONG', 'KW_FLOAT',
  'KW_DOUBLE', 'KW_SIGNED', 'KW_UNSIGNED', 'KW_BOOL', 'KW__BOOL',
  'KW__COMPLEX', 'KW__IMAGINARY',
  'KW___SIGNED__', 'KW___SIGNED',
  'KW___INT8', 'KW___INT16', 'KW___INT32', 'KW___INT64',
  'KW_STRUCT', 'KW_UNION', 'KW_ENUM',
  'KW_TYPEOF', 'KW_TYPEOF_UNQUAL',
  'KW___TYPEOF__', 'KW___TYPEOF',
  'KW__BITINT',
])
const STORAGE_CLASS_NAMES = new Set<string>([
  'KW_TYPEDEF', 'KW_EXTERN', 'KW_STATIC', 'KW_AUTO', 'KW_REGISTER',
  'KW__THREAD_LOCAL', 'KW_THREAD_LOCAL', 'KW_CONSTEXPR',
  'KW___THREAD',
])
const TYPE_QUALIFIER_NAMES = new Set<string>(PTR_QUALIFIER_TOKEN_NAMES)
const FUNCTION_SPECIFIER_NAMES = new Set<string>([
  'KW_INLINE', 'KW___INLINE__', 'KW___INLINE',
  'KW__NORETURN',
])

function isSpecifierKw(name: string): boolean {
  return STORAGE_CLASS_NAMES.has(name) ||
         TYPE_SPEC_KEYWORD_NAMES.has(name) ||
         TYPE_QUALIFIER_NAMES.has(name) ||
         FUNCTION_SPECIFIER_NAMES.has(name) ||
         name === 'TYPEDEF_NAME'
}

// Find index of the matching closing punctuator for the opener at `from`.
// `open`/`close` are token names (e.g. 'PUNC_LPAREN', 'PUNC_RPAREN').
// Returns -1 if unbalanced.
function matchClose(
  tokens: Token[], from: number, open: string, close: string,
): number {
  let depth = 0
  for (let i = from; i < tokens.length; i++) {
    const n = tokens[i].name
    if (n === open) depth++
    else if (n === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// Locate the declared name within a declarator token slice.
// A declarator is: pointer* direct_declarator postfix*
//   pointer        := '*' qualifier*
//   direct_decl    := ID | '(' declarator ')'
//   postfix        := '[' ... ']' | '(' params ')'
// The first ID encountered after stripping pointers/qualifiers is the
// declared name; if a parenthesised subdeclarator opens first, recurse.
// Returns the name's source string, or null if no name is found.
function findDeclaredName(tokens: Token[]): string | null {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (TRIVIA_TOKEN_NAMES.has(t.name)) { i++; continue }
    if (t.name === 'PUNC_STAR') { i++; continue }
    if (PTR_QUALIFIER_TOKEN_NAMES.has(t.name)) { i++; continue }
    // Compiler attribute or asm label inside declarators — skip
    // balanced-paren attribute groups.
    if (t.name === 'KW___ATTRIBUTE__' || t.name === 'KW___ATTRIBUTE' ||
        t.name === 'KW___ASM__' || t.name === 'KW___ASM' || t.name === 'KW_ASM' ||
        t.name === 'KW___DECLSPEC') {
      // Expect '(' next; skip the balanced group.
      let j = i + 1
      while (j < tokens.length && TRIVIA_TOKEN_NAMES.has(tokens[j].name)) j++
      if (j < tokens.length && tokens[j].name === 'PUNC_LPAREN') {
        const close = matchClose(tokens, j, 'PUNC_LPAREN', 'PUNC_RPAREN')
        if (close < 0) return null
        i = close + 1
        continue
      }
      i++
      continue
    }
    if (t.name === 'PUNC_LPAREN') {
      const close = matchClose(tokens, i, 'PUNC_LPAREN', 'PUNC_RPAREN')
      if (close < 0) return null
      // Distinguish a parenthesised subdeclarator from a function
      // parameter list. A function parameter list starts with a type
      // specifier or `void` or `)` (empty); a subdeclarator starts with
      // `*`, `(`, an attribute spec, or an ordinary ID that ISN'T a
      // typedef-name.
      const inner = tokens.slice(i + 1, close)
      const firstNonTrivia = inner.find((x) => !TRIVIA_TOKEN_NAMES.has(x.name))
      const looksLikeSubdeclarator =
        !!firstNonTrivia && (
          firstNonTrivia.name === 'PUNC_STAR' ||
          firstNonTrivia.name === 'PUNC_LPAREN' ||
          firstNonTrivia.name === 'KW___ATTRIBUTE__' ||
          firstNonTrivia.name === 'KW___ATTRIBUTE' ||
          firstNonTrivia.name === 'ID' // ordinary ID is the declared name
        )
      if (looksLikeSubdeclarator) {
        const innerName = findDeclaredName(inner)
        if (innerName) return innerName
      }
      // Otherwise treat as function postfix — skip past it.
      i = close + 1
      continue
    }
    if (t.name === 'PUNC_LBRACKET') {
      const close = matchClose(tokens, i, 'PUNC_LBRACKET', 'PUNC_RBRACKET')
      if (close < 0) return null
      i = close + 1
      continue
    }
    if (t.name === 'ID' || t.name === 'TYPEDEF_NAME') {
      return t.src
    }
    return null
  }
  return null
}

// Split the init-declarator-list portion of the token stream by top-level
// commas. Returns one token slice per declarator (initializer included).
function splitDeclarators(tokens: Token[]): Token[][] {
  const out: Token[][] = []
  let start = 0
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  for (let i = 0; i < tokens.length; i++) {
    const n = tokens[i].name
    if (n === 'PUNC_LPAREN') parenDepth++
    else if (n === 'PUNC_RPAREN') parenDepth--
    else if (n === 'PUNC_LBRACKET') bracketDepth++
    else if (n === 'PUNC_RBRACKET') bracketDepth--
    else if (n === 'PUNC_LBRACE') braceDepth++
    else if (n === 'PUNC_RBRACE') braceDepth--
    else if (n === 'PUNC_COMMA' &&
             parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      out.push(tokens.slice(start, i))
      start = i + 1
    }
  }
  out.push(tokens.slice(start))
  return out
}

// Slice an init-declarator at the first top-level `=`, returning just the
// declarator part (initializer is dropped from name-search).
function declaratorPart(tokens: Token[]): Token[] {
  let parenDepth = 0
  let bracketDepth = 0
  for (let i = 0; i < tokens.length; i++) {
    const n = tokens[i].name
    if (n === 'PUNC_LPAREN') parenDepth++
    else if (n === 'PUNC_RPAREN') parenDepth--
    else if (n === 'PUNC_LBRACKET') bracketDepth++
    else if (n === 'PUNC_RBRACKET') bracketDepth--
    else if (n === 'PUNC_ASSIGN' && parenDepth === 0 && bracketDepth === 0) {
      return tokens.slice(0, i)
    }
  }
  return tokens
}

// Identify the boundary between declaration-specifiers and the first
// declarator. Returns the index of the first non-specifier token.
//
// Specifiers are storage-classes, type-specifiers, type-qualifiers,
// function-specifiers, and a single TYPEDEF_NAME (after which any further
// ID is a declarator). struct/union/enum specifiers may also include a
// brace-balanced body — those are absorbed wholesale.
function findSpecBoundary(tokens: Token[]): number {
  let i = 0
  let sawTypedefName = false
  let sawTagSpec = false
  while (i < tokens.length) {
    const t = tokens[i]
    if (TRIVIA_TOKEN_NAMES.has(t.name)) { i++; continue }
    // After a TYPEDEF_NAME, a following ID belongs to the declarator.
    if (t.name === 'TYPEDEF_NAME') {
      if (sawTypedefName) return i
      sawTypedefName = true
      i++
      continue
    }
    if (t.name === 'KW_STRUCT' || t.name === 'KW_UNION' || t.name === 'KW_ENUM') {
      sawTagSpec = true
      i++
      // Optional tag name (ID).
      while (i < tokens.length && TRIVIA_TOKEN_NAMES.has(tokens[i].name)) i++
      if (i < tokens.length && (tokens[i].name === 'ID' || tokens[i].name === 'TYPEDEF_NAME')) {
        i++
      }
      // Optional body.
      while (i < tokens.length && TRIVIA_TOKEN_NAMES.has(tokens[i].name)) i++
      if (i < tokens.length && tokens[i].name === 'PUNC_LBRACE') {
        const close = matchClose(tokens, i, 'PUNC_LBRACE', 'PUNC_RBRACE')
        if (close < 0) return tokens.length
        i = close + 1
      }
      continue
    }
    if (isSpecifierKw(t.name) && t.name !== 'TYPEDEF_NAME') {
      i++
      continue
    }
    // `__attribute__((...))` / `__declspec(...)` attached to the
    // declaration: absorb as part of specifiers.
    if (t.name === 'KW___ATTRIBUTE__' || t.name === 'KW___ATTRIBUTE' ||
        t.name === 'KW___DECLSPEC') {
      i++
      while (i < tokens.length && TRIVIA_TOKEN_NAMES.has(tokens[i].name)) i++
      if (i < tokens.length && tokens[i].name === 'PUNC_LPAREN') {
        const close = matchClose(tokens, i, 'PUNC_LPAREN', 'PUNC_RPAREN')
        if (close < 0) return tokens.length
        i = close + 1
      }
      continue
    }
    return i
  }
  return i
}

function registerTypedefIfApplicable(tokens: Token[], ctx: Context): void {
  // Strip trivia for analysis (the original tokens still live on the AST).
  const filtered = tokens.filter((t) => !TRIVIA_TOKEN_NAMES.has(t.name))
  if (filtered.length < 3) return
  if (filtered[0].name !== 'KW_TYPEDEF') return
  const last = filtered[filtered.length - 1]
  if (last.name !== 'PUNC_SEMI') return
  // Drop the trailing `;` from the body we examine.
  const body = filtered.slice(0, filtered.length - 1)
  const specEnd = findSpecBoundary(body)
  const declList = body.slice(specEnd)
  if (declList.length === 0) return
  const cmeta = getCMeta(ctx)
  for (const decl of splitDeclarators(declList)) {
    const justDecl = declaratorPart(decl)
    const name = findDeclaredName(justDecl)
    if (name) {
      cmeta.symbols.bindTypedef(name)
      reclassifyAsTypedef(ctx, name)
    }
  }
}

// Run after the chomper terminates an external declaration: register
// typedef-names and try to upgrade the flat token-ref list to a
// structured tree (declaration / function_definition / preprocessor).
function finalizeExternalDeclaration(rule: Rule, ctx: Context): void {
  const tokens = rule.k.tokens as Token[]
  registerTypedefIfApplicable(tokens, ctx)
  const structured = structureExternalDeclaration(tokens)
  if (structured) {
    rule.node.children = structured.children
    rule.node.declKind = structured.declKind
    ;(rule.node as any).viaPath = 'legacy'
    registerMacrosFromTree(rule.node, ctx)
  } else {
    rule.node.declKind = 'unknown'
    ;(rule.node as any).viaPath = 'legacy-unknown'
  }
}

// Walk a freshly-structured node and register any define_directive
// macros into cmeta.macros (and #undef removes them). The walk only
// touches the top-level external_declaration's tree — surrounding
// translation_unit accumulation visits each child in order, so macro
// state evolves as the parse progresses.
function registerMacrosFromTree(node: any, ctx: Context): void {
  const cmeta = (ctx.meta as any).cmeta as CMeta
  if (!cmeta) return
  const visit = (n: any) => {
    if (!n) return
    if (n.kind === 'define_directive' && n.macroName) {
      cmeta.macros.define({
        name: n.macroName,
        isFunctionLike: n.macroKind === 'function-like',
        params: n.macroParams,
        variadic: !!n.macroVariadic,
      })
      // Reclassify any already-lexed lookahead tokens with this name
      // from ID to MACRO_NAME. Subsequent macros are first picked up by
      // the identifier matcher itself, but tokens fetched into ctx.t /
      // pnt.token *before* this define ran need a manual fix-up.
      reclassifyAsMacro(ctx, n.macroName)
    } else if (n.kind === 'undef_directive' && n.macroName) {
      cmeta.macros.undefine(n.macroName)
      // Reclassify any already-lexed lookahead tokens with this name
      // from MACRO_NAME back to ID, mirroring the define path.
      reclassifyAsId(ctx, n.macroName)
    }
    if (Array.isArray(n.children)) for (const c of n.children) visit(c)
  }
  visit(node)
}

// Inverse of reclassifyAsMacro — flips already-lexed lookahead tokens
// whose src equals `name` from MACRO_NAME back to ID. Called from the
// #undef directive finaliser so a token that was prefetched while the
// macro was still defined doesn't keep its stale MACRO_NAME tag.
function reclassifyAsId(ctx: Context, name: string): void {
  const lex = (ctx as any).lex
  if (!lex) return
  const idTin = (ctx.cfg as any).t['ID']
  const mnTin = (ctx.cfg as any).t['MACRO_NAME']
  const fix = (tkn: any) => {
    if (!tkn || !tkn.isToken) return
    if (tkn.tin === mnTin && tkn.src === name) {
      tkn.tin = idTin
      tkn.name = 'ID'
    }
  }
  if (Array.isArray(ctx.t)) for (const tkn of ctx.t) fix(tkn)
  if (lex.pnt && Array.isArray(lex.pnt.token)) for (const tkn of lex.pnt.token) fix(tkn)
}

function reclassifyAsMacro(ctx: Context, name: string): void {
  const lex = (ctx as any).lex
  if (!lex) return
  const idTin = (ctx.cfg as any).t['ID']
  const mnTin = (ctx.cfg as any).t['MACRO_NAME']
  const fix = (tkn: any) => {
    if (!tkn || !tkn.isToken) return
    if (tkn.tin === idTin && tkn.src === name) {
      tkn.tin = mnTin
      tkn.name = 'MACRO_NAME'
    }
  }
  if (Array.isArray(ctx.t)) for (const tkn of ctx.t) fix(tkn)
  if (lex.pnt && Array.isArray(lex.pnt.token)) for (const tkn of lex.pnt.token) fix(tkn)
}

// True iff the first non-trivia entry in `tokens` has the given name.
function firstNonTriviaIs(tokens: Token[], name: string): boolean {
  for (const t of tokens) {
    if (TRIVIA_TOKEN_NAMES.has(t.name)) continue
    return t.name === name
  }
  return false
}

// True when ctx.t0 (the next token to be consumed) is one of the tokens
// that unambiguously begin a new external declaration. Used by the
// chomper to decide that a top-level `}` was the end of a function body.
function startsNewExternalDeclaration(ctx: Context): boolean {
  // Skip trivia in the lookahead.
  let i = 0
  while (i < ctx.t.length) {
    const tkn = ctx.t[i]
    if (!tkn) break
    if (TRIVIA_TOKEN_NAMES.has(tkn.name)) { i++; continue }
    const n = tkn.name
    if (n === '#ZZ') return true
    if (n === 'PP_HASH') return true
    if (n === 'PUNC_HASH') return true
    if (STORAGE_CLASS_NAMES.has(n)) return true
    if (TYPE_SPEC_KEYWORD_NAMES.has(n)) return true
    if (TYPE_QUALIFIER_NAMES.has(n)) return true
    if (FUNCTION_SPECIFIER_NAMES.has(n)) return true
    if (n === 'KW___ATTRIBUTE__' || n === 'KW___ATTRIBUTE') return true
    if (n === 'KW___DECLSPEC') return true
    if (n === 'KW___EXTENSION__') return true
    if (n === 'TYPEDEF_NAME') return true
    // ID (could be a macro that expands to a declaration, or the
    // declared name from `typedef struct { } S;`). Assume continuation.
    return false
  }
  return false
}

function reclassifyAsTypedef(ctx: Context, name: string): void {
  const lex = (ctx as any).lex
  if (!lex) return
  const idTin = (ctx.cfg as any).t['ID']
  const tdTin = (ctx.cfg as any).t['TYPEDEF_NAME']
  const fix = (tkn: any) => {
    if (!tkn || !tkn.isToken) return
    if (tkn.tin === idTin && tkn.src === name) {
      tkn.tin = tdTin
      tkn.name = 'TYPEDEF_NAME'
    }
  }
  if (Array.isArray(ctx.t)) for (const tkn of ctx.t) fix(tkn)
  if (lex.pnt && Array.isArray(lex.pnt.token)) for (const tkn of lex.pnt.token) fix(tkn)
}

export { C }
export default C
