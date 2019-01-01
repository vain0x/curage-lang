import * as assert from "assert"
import { parse, tokenize, analyze, findTokenAt, findSymbolDef } from "./curage"

const analyzeSource = (source: string) => analyze(parse(tokenize(source)))

const testTokenize = () => {
  const actual = tokenize("let foo = 1;")
  const expected = [
    [
      { type: "let" },
      { y: 0, x: 0 },
    ],
    [
      { type: "name", value: "foo" },
      { y: 0, x: 4 },
    ],
    [
      { type: "=" },
      { y: 0, x: 8 },
    ],
    [
      { type: "integer", value: 1 },
      { y: 0, x: 10 },
    ],
    [
      { type: ";" },
      { y: 0, x: 11 },
    ],
  ]
  assert.deepStrictEqual(actual, expected)
}

const testParse = () => {
  const parseStr = (source: string) => parse(tokenize(source))

  const table = [
    {
      actual: "1;",
      expected: [],
    },
    {
      actual: `
        let x = 1;
        let y = 2
        print(x);
      `.trimLeft(),
      expected: [
        { message: "Expected ';'.", y: 2, x: 8 },
      ],
    }
  ]

  for (const { actual, expected } of table) {
    const { issues } = parseStr(actual)
    assert.deepStrictEqual(issues, expected)
  }
}

const testAnalyze = () => {
  const table = [
    {
      source: "let a = 1; a;",
      expected: [],
    },
    {
      source: "a; let a = 1; a;",
      expected: [
        { message: "Use of undefined variable 'a'.", y: 0, x: 0 },
      ],
    }
  ]
  for (const { source, expected } of table) {
    const { issues } = analyzeSource(source)
    assert.deepStrictEqual(issues, expected)
  }
}

const testFindReferences = () => {
  const table = [
    {
      source: "let a = 1; let b = 2; a;",
      pos: { y: 0, x: 22 },
      expected: {
        defs: [{ y: 0, x: 4 }],
        refs: [{ y: 0, x: 22 }],
      },
    },
    {
      source: "let a = 1; let a = a; a(a);",
      pos: { y: 0, x: 15 },
      expected: {
        defs: [{ y: 0, x: 15 }],
        refs: [{ y: 0, x: 22 }, { y: 0, x: 24 }],
      },
    },
  ]
  for (const { source, pos, expected } of table) {
    const sema = analyzeSource(source)
    const token = findTokenAt(sema.syn, pos)
    const { defs, refs } = findSymbolDef(sema, [token, pos])
    assert.deepStrictEqual({
      defs: defs.map(tp => tp[1]),
      refs: refs.map(tp => tp[1]),
    }, expected)
  }
}

testTokenize()
testParse()
testAnalyze()
testFindReferences()
