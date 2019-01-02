import * as assert from "assert"
import {
  analyze,
  findSymbolDef,
  findTokenAt,
  parse,
  testPos,
  tokenize,
  evaluateRename,
} from "./curage"

const parseStr = (source: string) => parse(tokenize(source))
const analyzeSource = (source: string) => analyze(parse(tokenize(source)))

const testTokenize = () => {
  const actual = tokenize("let foo = 1;").map(x => x.value)
  const expected = ["let", "foo", "=", "1", ";", ""]
  assert.deepStrictEqual(actual, expected)
}

const testParse = () => {
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
        {
          message: "Expected ';'.",
          range: [{ y: 2, x: 8 }, { y: 2, x: 13 }],
        },
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
        {
          message: "Use of undefined variable 'a'.",
          range: [{ y: 0, x: 0 }, { y: 0, x: 1 }],
        },
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
      expected: 1,
    },
    {
      source: "let a = 1; let a = a; a(a);",
      pos: { y: 0, x: 15 },
      expected: 2,
    },
  ]
  for (const { source, pos, expected } of table) {
    const sema = analyzeSource(source)
    const token = findTokenAt(sema.syn, pos)
    const { refs } = findSymbolDef(sema, token)
    assert.deepStrictEqual(refs.length, expected)
  }
}

const testEvaluateRename = () => {
  const sema = analyzeSource("let a = 1;\nlet a = a;\na(a);")
  const edits = evaluateRename({ line: 2, character: 0 }, "b", sema)
  const expected = [
    {
      range:
      {
        start: { line: 1, character: 4 },
        end: { line: 1, character: 5 }
      },
      newText: 'b'
    },
    {
      range:
      {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 1 }
      },
      newText: 'b'
    },
    {
      range:
      {
        start: { line: 2, character: 2 },
        end: { line: 2, character: 3 }
      },
      newText: 'b'
    }
  ]

  assert.deepStrictEqual(edits, expected)
}

testPos()
testTokenize()
testParse()
testAnalyze()
testFindReferences()
testEvaluateRename()
