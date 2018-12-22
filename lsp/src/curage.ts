// curage-lang compiler.

// ## curage-lang syntax
//
// `print("hello, world!")` -> valid
// otherwise -> invalid

export const parse = (source: string) => {
  const expected = `print("hello, world!")`

  for (let i = 0; i < expected.length + 1; i++) {
    // If the source code is invalid, returns an error.
    if (source[i] !== expected[i]) {
      return {
        message: `Expected '${expected[i]}'`,
        line: 0,
        character: i,
      }
    }
  }

  // OK, valid input.
  return undefined
}
