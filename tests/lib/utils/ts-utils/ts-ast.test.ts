/**
 * @fileoverview Tests for lib/utils/ts-utils/ts-ast.js
 *
 * The helpers only need `context.sourceCode.scopeManager` (to resolve type
 * references) and `context.sourceCode.parserServices` (to ask the type
 * checker), so the tests pass a fake rule context built from the output of
 * `@typescript-eslint/parser` instead of running ESLint.
 */
import type { TSESTree } from '@typescript-eslint/types'
import type * as TsAst from '../../../../lib/utils/ts-utils/ts-ast'
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { parseForESLint } from '@typescript-eslint/parser'

// `lib/**/*.js` files are CommonJS and the rest of the suite loads them with
// `require()`. Loading them the same way (instead of `import`) keeps their
// coverage mergeable with the coverage collected by the other tests.
const require = createRequire(import.meta.url)
const {
  extractRuntimeEmits,
  extractRuntimeProps,
  extractRuntimeSlots,
  flattenTypeNodes,
  inferRuntimeType,
  isTSInterfaceBody,
  isTSTypeLiteral,
  isTSTypeLiteralOrTSFunctionType,
  isTypeNode
}: typeof TsAst = require('../../../../lib/utils/ts-utils/ts-ast.js')

interface Parsed {
  context: RuleContext
  /** The type annotation of the type alias named `Target`. */
  target: TSESTree.TypeNode
}

/**
 * Parses the code and creates a fake rule context.
 * @param parserServices Parser services exposed through `context.sourceCode`.
 *   Without type information, only the AST-based inference is used.
 */
function parse(code: string, parserServices: object = {}): Parsed {
  const { ast, scopeManager, visitorKeys } = parseForESLint(code, {
    range: true,
    loc: true,
    sourceType: 'module'
  })
  setParents(ast, null, visitorKeys)

  const alias = ast.body.find(
    (node): node is TSESTree.TSTypeAliasDeclaration =>
      node.type === 'TSTypeAliasDeclaration' && node.id.name === 'Target'
  )
  assert.ok(alias, 'missing `type Target = ...`')

  const context = {
    sourceCode: { scopeManager, parserServices }
  } as unknown as RuleContext
  return { context, target: alias.typeAnnotation }
}

/**
 * ESLint sets `parent` while traversing the AST; the scope lookup relies on it.
 */
function setParents(
  node: TSESTree.Node,
  parent: TSESTree.Node | null,
  visitorKeys: Record<string, readonly string[] | undefined>
) {
  Object.assign(node, { parent })
  const keys = visitorKeys[node.type] ?? []
  for (const key of keys) {
    const value: unknown = node[key as keyof typeof node]
    const children: unknown[] = Array.isArray(value) ? value : [value]
    for (const child of children) {
      if (child && typeof child === 'object' && 'type' in child) {
        setParents(child as TSESTree.Node, node, visitorKeys)
      }
    }
  }
}

function infer(code: string): string[] {
  const { context, target } = parse(code)
  return inferRuntimeType(context, target)
}

function flatten(code: string) {
  const { context, target } = parse(code)
  return flattenTypeNodes(context, target)
}

function members(node: TSESTree.TypeNode) {
  assert.strictEqual(node.type, 'TSTypeLiteral')
  return node
}

describe('type node predicates', () => {
  it('isTypeNode() accepts type nodes only', () => {
    const { target } = parse('type Target = string')
    assert.strictEqual(isTypeNode(target as ASTNode), true)
    assert.strictEqual(isTypeNode({ type: 'Identifier' } as ASTNode), false)
  })

  it('distinguishes type literals, function types and interface bodies', () => {
    const literal = parse('type Target = { a: 1 }').target
    const fn = parse('type Target = () => void').target
    const keyword = parse('type Target = string').target

    assert.strictEqual(isTSTypeLiteral(literal), true)
    assert.strictEqual(isTSTypeLiteral(fn), false)
    assert.strictEqual(isTSTypeLiteralOrTSFunctionType(literal), true)
    assert.strictEqual(isTSTypeLiteralOrTSFunctionType(fn), true)
    assert.strictEqual(isTSTypeLiteralOrTSFunctionType(keyword), false)
    assert.strictEqual(isTSInterfaceBody(literal), false)
  })
})

describe('inferRuntimeType()', () => {
  const cases: [string, string[]][] = [
    // keywords and type literals
    ['type Target = `a${string}`', ['String']],
    ['type Target = symbol', ['Symbol']],
    ['type Target = object', ['Object']],
    ['type Target = [number, string]', ['Array']],
    ['type Target = {}', ['Object']],
    ['type Target = { a: string }', ['Object']],
    ['type Target = { (): void }', ['Function']],
    ['type Target = { new (): Foo }', ['Function']],
    ['type Target = { (): void; a: string }', ['Function', 'Object']],
    // literal types
    ['type Target = true', ['Boolean']],
    ["type Target = 'a'", ['String']],
    ['type Target = 1', ['Number']],
    ['type Target = 1n', ['Number']],
    // built-in and utility types
    ['type Target = Date', ['Date']],
    ['type Target = WeakMap<object, string>', ['WeakMap']],
    ['type Target = ReadonlyArray<string>', ['Array']],
    ['type Target = ReadonlyMap<string, number>', ['Map']],
    ['type Target = Readonly<Foo>', ['Object']],
    ['type Target = Record<string, number>', ['Object']],
    ['type Target = InstanceType<typeof Foo>', ['Object']],
    ['type Target = Capitalize<Foo>', ['String']],
    ['type Target = Lowercase<Foo>', ['String']],
    ['type Target = Parameters<Foo>', ['Array']],
    ['type Target = ConstructorParameters<Foo>', ['Array']],
    ['type Target = NonNullable<string | null>', ['String']],
    ["type Target = Extract<Foo, 'a' | 1>", ['String', 'Number']],
    ['type Target = Exclude<string | number, 1>', ['String', 'Number']],
    ['type Target = OmitThisParameter<() => void>', ['Function']],
    // union and intersection types
    ['type Target = string | number | string', ['String', 'Number']],
    ['type Target = { a: 1 } & (() => void)', ['Object', 'Function']],
    // local declarations
    ['interface Foo { a: 1 }\ntype Target = Foo', ['Object']],
    ['type Foo = string[]\ntype Target = Foo', ['Array']],
    ['type Foo = Bar\ntype Bar = boolean\ntype Target = Foo', ['Boolean']],
    ['enum Foo { A, B }\ntype Target = Foo', ['Number']],
    ["enum Foo { A = 'a', B = 'b' }\ntype Target = Foo", ['String']],
    ["enum Foo { A = 1, B = 'b' }\ntype Target = Foo", ['Number', 'String']]
  ]

  for (const [code, expected] of cases) {
    it(`infers ${JSON.stringify(expected)} from \`${code.replaceAll('\n', '; ')}\``, () => {
      assert.deepStrictEqual(infer(code), expected)
    })
  }

  it('stops on recursive type aliases', () => {
    assert.deepStrictEqual(
      infer('type Target = string | Foo\ntype Foo = number | Target'),
      ['String', 'Number', 'null']
    )
  })

  it('does not treat a declared variable as a type', () => {
    // `Foo` has two declarations (a value and an interface), so it cannot
    // be resolved from the AST alone.
    assert.deepStrictEqual(
      infer('const Foo = 1\ninterface Foo { a: 1 }\ntype Target = Foo'),
      ['null']
    )
  })

  const withoutTypeArguments = [
    'NonNullable',
    'Extract',
    'Exclude',
    'OmitThisParameter'
  ]
  for (const name of withoutTypeArguments) {
    it(`returns ['null'] for \`${name}\` without type arguments when no type checker is available`, () => {
      assert.deepStrictEqual(infer(`type Target = ${name}`), ['null'])
    })
  }

  it('ignores auto-incremented members of an enum with initializers', () => {
    // `Foo.A` is `0` at runtime, but only explicit initializers are taken into
    // account. This matches the runtime props generated by `@vue/compiler-sfc`.
    assert.deepStrictEqual(
      infer("enum Foo { A, B = 'b' }\ntype Target = Foo"),
      ['String']
    )
  })

  describe('with type information', () => {
    it('asks the type checker for types the AST cannot resolve', () => {
      const tsNode = {}
      const getTypeAtLocation = vi.fn(() => undefined)
      const getTypeChecker = vi.fn(() => ({ getTypeAtLocation }))
      const esTreeNodeToTSNodeMap = new Map()
      const { context, target } = parse('type Target = Foo', {
        esTreeNodeToTSNodeMap,
        program: { getTypeChecker }
      })
      esTreeNodeToTSNodeMap.set(target, tsNode)

      // The checker knows nothing about the type, so `null` is returned.
      assert.deepStrictEqual(inferRuntimeType(context, target), ['null'])
      expect(getTypeChecker).toHaveBeenCalledOnce()
      expect(getTypeAtLocation).toHaveBeenCalledExactlyOnceWith(tsNode)
    })

    it('does not use the type checker without full type information', () => {
      const getTypeChecker = vi.fn()
      const { context, target } = parse('type Target = Foo', {
        esTreeNodeToTSNodeMap: new Map(),
        hasFullTypeInformation: false,
        program: { getTypeChecker }
      })

      assert.deepStrictEqual(inferRuntimeType(context, target), ['null'])
      expect(getTypeChecker).not.toHaveBeenCalled()
    })
  })
})

describe('flattenTypeNodes()', () => {
  it('flattens unions and intersections and resolves local types', () => {
    const nodes = flatten(
      'interface Foo { a: 1 }\ntype Bar = { b: 1 } | string\ntype Target = Foo & (Bar | Baz)'
    )

    assert.deepStrictEqual(
      nodes.map((node) => node.type),
      ['TSInterfaceBody', 'TSTypeLiteral', 'TSStringKeyword', 'TSTypeReference']
    )
  })

  it('yields an alias reached twice only from the cache', () => {
    const nodes = flatten('type Foo = { a: 1 }\ntype Target = Foo | Foo')

    assert.strictEqual(nodes.length, 2)
    assert.strictEqual(nodes[0], nodes[1])
  })

  it('stops on recursive type aliases', () => {
    const nodes = flatten(
      'type Foo = { a: 1 } | Bar\ntype Bar = { b: 1 } | Foo\ntype Target = Foo'
    )

    assert.deepStrictEqual(
      nodes.map((node) => node.type),
      ['TSTypeLiteral', 'TSTypeLiteral', 'TSUnionType']
    )
  })
})

describe('extractRuntimeProps()', () => {
  it('extracts props and reports computed keys as unknown', () => {
    const { context, target } = parse(
      "type Target = { a: string; 'b-c'?: number; d(): void; e; [a.b]: string; [k: string]: unknown; (): void }"
    )
    const props = [...extractRuntimeProps(context, members(target))]

    assert.deepStrictEqual(
      props.map((p) =>
        p.type === 'type'
          ? [p.propName, p.required, p.types]
          : [p.type, p.propName]
      ),
      [
        ['a', true, ['String']],
        ['b-c', false, ['Number']],
        ['d', true, ['Function']],
        ['e', true, ['null']],
        ['unknown', null]
      ]
    )
  })

  // `@vue/compiler-sfc` rejects computed keys ("Unsupported computed key in
  // type referenced by a macro"), but an identifier in brackets is taken as
  // the literal prop name, e.g. `vue/no-unused-properties` then reports
  // "'key' of property found, but never used".
  it.fails('reports a computed identifier key as unknown', () => {
    const { context, target } = parse('type Target = { [key]: string }')
    const props = [...extractRuntimeProps(context, members(target))]

    assert.deepStrictEqual(
      props.map((p) => [p.type, p.propName]),
      [['unknown', null]]
    )
  })
})

describe('extractRuntimeEmits()', () => {
  it('extracts emits from property syntax and call signatures', () => {
    const { target } = parse(
      "type Target = { a: [x: string]; 'b-c': []; [a.b]: []; (e: 'd' | 'e' | 1 | string): void; (e: 'f'): void; (e): void; (): void; [k: string]: unknown }"
    )
    const emits = [...extractRuntimeEmits(members(target))]

    assert.deepStrictEqual(
      emits.map((e) => [e.type, e.emitName]),
      [
        ['type', 'a'],
        ['type', 'b-c'],
        ['unknown', null],
        ['type', 'd'],
        ['type', 'e'],
        ['type', '1'],
        ['type', 'f']
      ]
    )
  })
})

describe('extractRuntimeSlots()', () => {
  it('extracts slots and reports computed keys as unknown', () => {
    const { target } = parse(
      "type Target = { default(): any; 'item-a': (p: { a: 1 }) => any; [a.b]: () => any; [k: string]: unknown }"
    )
    const slots = [...extractRuntimeSlots(members(target))]

    assert.deepStrictEqual(
      slots.map((s) => [s.type, s.slotName]),
      [
        ['type', 'default'],
        ['type', 'item-a'],
        ['unknown', null]
      ]
    )
  })
})
