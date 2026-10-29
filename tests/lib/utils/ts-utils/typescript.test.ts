/**
 * @fileoverview Tests for lib/utils/ts-utils/typescript.js
 *
 * TypeScript `Type` objects are replaced with stubs that only carry the
 * properties the helpers read (`flags`, `objectFlags`, `symbol`,
 * `getCallSignatures`), so the tests don't need a real type checker.
 */
import type * as TS from 'typescript'
import type * as TypeScriptUtils from '../../../../lib/utils/ts-utils/typescript'
import assert from 'node:assert'
import Module, { createRequire } from 'node:module'
import ts from 'typescript'

// `lib/**/*.js` files are CommonJS and the rest of the suite loads them with
// `require()`. Loading them the same way (instead of `import`) keeps their
// coverage mergeable with the coverage collected by the other tests.
const require = createRequire(import.meta.url)
const typescriptPath =
  require.resolve('../../../../lib/utils/ts-utils/typescript.js')

const {
  extractObjectFlags,
  extractTypeFlags,
  isAny,
  isArrayLikeObject,
  isBigIntLike,
  isBooleanLike,
  isFunction,
  isNever,
  isNull,
  isNumberLike,
  isObject,
  isReferenceObject,
  isStringLike,
  isUnknown
}: typeof TypeScriptUtils = require(typescriptPath)

interface TypeStub {
  flags?: TS.TypeFlags
  objectFlags?: TS.ObjectFlags
  symbol?: { flags: TS.SymbolFlags }
  getCallSignatures?: () => unknown[]
}

function stubType(stub: TypeStub): TS.Type {
  return {
    flags: 0,
    objectFlags: 0,
    getCallSignatures: () => [],
    ...stub
  } as unknown as TS.Type
}

/**
 * Loads a new instance of the module, so that its module-level
 * `getTypeScript()` cache starts empty.
 */
function loadFresh(): typeof TypeScriptUtils {
  Reflect.deleteProperty(require.cache, typescriptPath)
  return require(typescriptPath)
}

/**
 * Stubs `require('typescript')` and passes every other request through.
 */
function stubRequireTypeScript(impl: () => unknown) {
  const originalRequire = Module.prototype.require
  return vi.spyOn(Module.prototype, 'require').mockImplementation(function (
    this: NodeJS.Module,
    id: string
  ) {
    if (id === 'typescript') {
      return impl()
    }
    return originalRequire.call(this, id)
  } as NodeJS.Require)
}

function countTypeScriptRequires(
  spy: ReturnType<typeof stubRequireTypeScript>
) {
  return spy.mock.calls.filter(([id]) => id === 'typescript').length
}

describe('getTypeScript()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the installed typescript module', () => {
    const { getTypeScript } = loadFresh()
    assert.strictEqual(getTypeScript(), ts)
  })

  it('loads typescript only once and then uses the cache', () => {
    const fakeTypeScript = { TypeFlags: {}, ObjectFlags: {} }
    const requireSpy = stubRequireTypeScript(() => fakeTypeScript)
    const { getTypeScript } = loadFresh()

    assert.strictEqual(getTypeScript(), fakeTypeScript)
    assert.strictEqual(getTypeScript(), fakeTypeScript)
    assert.strictEqual(countTypeScriptRequires(requireSpy), 1)
  })

  it('returns undefined when typescript is not installed', () => {
    const requireSpy = stubRequireTypeScript(() => {
      throw Object.assign(new Error("Cannot find module 'typescript'"), {
        code: 'MODULE_NOT_FOUND'
      })
    })
    const { getTypeScript } = loadFresh()

    assert.strictEqual(getTypeScript(), undefined)
    // A failed load is not cached, so the next call tries again.
    assert.strictEqual(getTypeScript(), undefined)
    assert.strictEqual(countTypeScriptRequires(requireSpy), 2)
  })

  it('rethrows errors other than MODULE_NOT_FOUND', () => {
    const error = new SyntaxError('Unexpected token')
    stubRequireTypeScript(() => {
      throw error
    })
    const { getTypeScript } = loadFresh()

    assert.throws(() => getTypeScript(), error)
  })
})

describe('type flag helpers', () => {
  const cases: [string, (type: TS.Type) => boolean, TS.TypeFlags][] = [
    ['isObject', isObject, ts.TypeFlags.Object],
    ['isAny', isAny, ts.TypeFlags.Any],
    ['isUnknown', isUnknown, ts.TypeFlags.Unknown],
    ['isNever', isNever, ts.TypeFlags.Never],
    ['isNull', isNull, ts.TypeFlags.Null],
    ['isStringLike', isStringLike, ts.TypeFlags.StringLiteral],
    ['isNumberLike', isNumberLike, ts.TypeFlags.NumberLiteral],
    ['isBooleanLike', isBooleanLike, ts.TypeFlags.BooleanLiteral],
    ['isBigIntLike', isBigIntLike, ts.TypeFlags.BigIntLiteral]
  ]

  for (const [name, check, flag] of cases) {
    it(`${name}() checks the type flags`, () => {
      assert.strictEqual(check(stubType({ flags: flag })), true)
      // Other flags set alongside don't matter.
      assert.strictEqual(
        check(stubType({ flags: flag | ts.TypeFlags.Undefined })),
        true
      )
      assert.strictEqual(
        check(stubType({ flags: ts.TypeFlags.Undefined })),
        false
      )
    })
  }

  it('isArrayLikeObject() requires an object type with array-like object flags', () => {
    for (const objectFlags of [
      ts.ObjectFlags.ArrayLiteral,
      ts.ObjectFlags.EvolvingArray,
      ts.ObjectFlags.Tuple
    ]) {
      assert.strictEqual(
        isArrayLikeObject(
          stubType({ flags: ts.TypeFlags.Object, objectFlags })
        ),
        true
      )
    }
    assert.strictEqual(
      isArrayLikeObject(
        stubType({
          flags: ts.TypeFlags.Object,
          objectFlags: ts.ObjectFlags.Interface
        })
      ),
      false
    )
    // Object flags are ignored for non-object types.
    assert.strictEqual(
      isArrayLikeObject(
        stubType({
          flags: ts.TypeFlags.String,
          objectFlags: ts.ObjectFlags.Tuple
        })
      ),
      false
    )
  })

  it('isReferenceObject() requires an object type with the Reference flag', () => {
    assert.strictEqual(
      isReferenceObject(
        stubType({
          flags: ts.TypeFlags.Object,
          objectFlags: ts.ObjectFlags.Reference
        })
      ),
      true
    )
    assert.strictEqual(
      isReferenceObject(stubType({ flags: ts.TypeFlags.Object })),
      false
    )
    assert.strictEqual(
      isReferenceObject(
        stubType({
          flags: ts.TypeFlags.Any,
          objectFlags: ts.ObjectFlags.Reference
        })
      ),
      false
    )
  })
})

describe('isFunction()', () => {
  it('returns true for function and method symbols without asking for call signatures', () => {
    for (const symbolFlags of [
      ts.SymbolFlags.Function,
      ts.SymbolFlags.Method
    ]) {
      const getCallSignatures = vi.fn(() => [])
      const type = stubType({
        symbol: { flags: symbolFlags },
        getCallSignatures
      })

      assert.strictEqual(isFunction(type), true)
      expect(getCallSignatures).not.toHaveBeenCalled()
    }
  })

  it('falls back to call signatures for other symbols', () => {
    const getCallSignatures = vi.fn(() => [{}])
    const type = stubType({
      symbol: { flags: ts.SymbolFlags.Variable },
      getCallSignatures
    })

    assert.strictEqual(isFunction(type), true)
    expect(getCallSignatures).toHaveBeenCalledOnce()
  })

  it('falls back to call signatures for types without a symbol', () => {
    const getCallSignatures = vi.fn(() => [])

    assert.strictEqual(isFunction(stubType({ getCallSignatures })), false)
    expect(getCallSignatures).toHaveBeenCalledOnce()
  })
})

describe('extractTypeFlags()', () => {
  it('returns the names of all set type flags', () => {
    const names = extractTypeFlags(
      stubType({ flags: ts.TypeFlags.String | ts.TypeFlags.Null })
    )

    assert.ok(names.includes('String'))
    assert.ok(names.includes('Null'))
    assert.ok(!names.includes('Number'))
    // Composite flags such as `StringLike` are reported too.
    assert.ok(names.includes('StringLike'))
  })

  it('returns an empty array when no flag is set', () => {
    assert.deepStrictEqual(extractTypeFlags(stubType({})), [])
  })
})

describe('extractObjectFlags()', () => {
  it('returns the names of all set object flags of an object type', () => {
    const names = extractObjectFlags(
      stubType({
        flags: ts.TypeFlags.Object,
        objectFlags: ts.ObjectFlags.Interface | ts.ObjectFlags.Reference
      })
    )

    assert.ok(names.includes('Interface'))
    assert.ok(names.includes('Reference'))
    assert.ok(!names.includes('Tuple'))
  })

  it('returns an empty array for non-object types', () => {
    assert.deepStrictEqual(
      extractObjectFlags(
        stubType({
          flags: ts.TypeFlags.String,
          objectFlags: ts.ObjectFlags.Interface
        })
      ),
      []
    )
  })
})
