import * as assert from "assert"
import { parse, tokenize } from "./curage"

const testTokenize = () => {
  const actual = tokenize("let foo = 1;")
  const expected = [
    [
      { type: "name", value: "let" },
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
        { message: "Expected ';'", y: 2, x: 8 },
      ],
    }
  ]

  for (const { actual, expected } of table) {
    const { issues } = parseStr(actual)
    assert.deepStrictEqual(issues, expected)
  }
}

testTokenize()
testParse()
