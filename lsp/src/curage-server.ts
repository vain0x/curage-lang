// Curage-lang LSP server implementation.

import * as assert from "assert"
import {
  InitializeResult,
  TextDocumentSyncKind,
  DidOpenTextDocumentParams,
  DidChangeTextDocumentParams,
  PublishDiagnosticsParams,
  DiagnosticSeverity,
  Diagnostic,
  Position,
  Range,
  DidCloseTextDocumentParams,
  DocumentHighlight,
  DocumentHighlightKind,
  TextDocumentPositionParams,
  RenameParams,
  WorkspaceEdit,
  TextEdit,
  InitializeParams,
  TextDocumentEdit,
} from "vscode-languageserver-protocol"
import {
  listenToLSPClient,
  sendNotify,
  sendResponse,
} from "./communication"

interface Message {
  jsonrpc: string,
  id: number,
  method: string,
  params: any,
}

export const onMessage = (message: Message) => {
  const { id, method, params } = message

  switch (method) {
    case "initialize": {
      const { capabilities } = params as InitializeParams

      sendResponse(id, {
        capabilities: {
          textDocumentSync: {
            // Indicate the server want the client to send
            // `textDocument/didOpen` and `textDocument/didClose` notifications
            // whenever a document opened or closed.
            openClose: true,
            // Indicate the server want the client to send
            // `textDocument/didChange` notifications
            // whenever an open document modified,
            // including the full text of the modified document.
            change: TextDocumentSyncKind.Full,
          },
          // Indicate that the server can respond to
          // `textDocument/documentHighlight` requests.
          documentHighlightProvider: true,
          // Indicate that the server can respond to
          // `textDocument/rename` requests;
          // and `textDocument/prepareRename` if the client supports.
          renameProvider:
            capabilities.textDocument
              && capabilities.textDocument.rename
              && capabilities.textDocument.rename.prepareSupport
              ? { prepareProvider: true }
              : true,
        },
      } as InitializeResult)
      break
    }
    case "initialized": {
      // No need to send a response,
      // because `initialized` is a notification but not a request.
      break
    }
    case "shutdown": {
      sendResponse(id, null)
      break
    }
    case "exit": {
      process.exit(0)
      break
    }
    case "textDocument/didOpen": {
      const { textDocument: { uri, version, text } } = params as DidOpenTextDocumentParams
      documentDidOpenOrChange(uri, version, text)
      break
    }
    case "textDocument/didChange": {
      const { textDocument: { uri, version }, contentChanges: [{ text }] } = params as DidChangeTextDocumentParams
      documentDidOpenOrChange(uri, version, text)
      break
    }
    case "textDocument/didClose": {
      const { textDocument: { uri } } = params as DidCloseTextDocumentParams
      openDocuments.delete(uri)
    }
    case "textDocument/documentHighlight": {
      const { textDocument: { uri }, position } = params as TextDocumentPositionParams
      const highlights = createHighlights(uri, position)
      sendResponse(id, highlights || null)
      return
    }
    case "textDocument/prepareRename": {
      const { textDocument: { uri }, position } = params as TextDocumentPositionParams
      const result = prepareRename(uri, position)
      sendResponse(id, result || null)
      return
    }
    case "textDocument/rename": {
      const { textDocument: { uri }, position, newName } = params as RenameParams
      const workspaceEdit = createRenameEdit(uri, position, newName)
      sendResponse(id, workspaceEdit || null)
      return
    }
    default: {
      // Pass.
      break
    }
  }
}

type TokenType =
  | "int"
  | "name"
  | "operator"
  | "("
  | ")"
  | "let"
  | "set"
  | "end"
  | "if"
  | "while"
  // end-of-line
  | "eol"
  | "invalid"

interface TokenBase {
  type: TokenType,
  value: string,
}

/**
 * Minimum unit of string in the source code.
 * A word, integer, punctuation, etc.
 */
interface Token extends TokenBase {
  range: Range,
}

type Expression =
  | {
    type: "error",
    message: string,
    range: Range,
  }
  | {
    type: "atomic",
    token: Token,
  }
  | {
    type: "call",
    callee: Token,
    arg?: Token,
  }
  | {
    type: "binary",
    operator: Token,
    left: Token,
    right: Token,
  }

type Statement =
  | {
    type: "error",
    message: string,
    range: Range,
  }
  | {
    type: "let",
    name: Token,
    init: Expression,
  }
  | {
    type: "set",
    left: Token,
    right: Expression,
  }
  | {
    type: "end",
  }
  | {
    type: "if",
    ifToken: Token,
    condition: Expression,
    thenClause: Statement[],
  }
  | {
    type: "while",
    condition: Expression,
    body: Statement[],
  }

/** Result of parsing. */
interface SyntaxModel {
  statements: Statement[],
  diagnostics: Diagnostic[],
}

/**
 * Definition of a symbol: name of some context.
 */
interface SymbolDefinition {
  type: "var",
  /** The definition-site of the symbol. */
  definitions: Token[],
  /** Tokens that refers to the symbol. */
  references: Token[],
}

/** Result of static analysis. */
interface SemanticModel {
  statements: Statement[],
  symbolDefinitions: SymbolDefinition[],
  diagnostics: Diagnostic[],
}

/**
 * The TypeScript compiler checks if
 * there is no control flow to call this function.
 */
const exhaust = (value: never) => value

const comparePositions = (l: Position, r: Position) => {
  if (l.line !== r.line) {
    return Math.sign(l.line - r.line)
  }
  return Math.sign(l.character - r.character)
}

/**
 * Converts a position to an array `[line, character]`.
 */
const positionToArray = (position: Position) => {
  return [position.line, position.character]
}

/**
 * Converts a range to a nested array
 * `[[start.line, start.character], [end.line, end.character]]`.
 */
const rangeToMatrix = (range: Range) => {
  return [positionToArray(range.start), positionToArray(range.end)]
}

const tokenToArray = (token: Token) => {
  return [token.type, token.value]
}

const expressionToArray = (expression: Expression) => {
  if (expression.type === "error") {
    return [expression.type]
  }
  if (expression.type === "atomic") {
    const { type, token } = expression
    return [type, tokenToArray(token)]
  }
  if (expression.type === "call") {
    const { type, callee, arg } = expression
    const array = [type, tokenToArray(callee)]
    if (arg) {
      array.push(tokenToArray(arg))
    }
    return array
  }
  if (expression.type === "binary") {
    const { type, operator, left, right } = expression
    return [type, tokenToArray(operator), tokenToArray(left), tokenToArray(right)]
  }
  throw exhaust(expression)
}

const statementToArray = (statement: Statement): any[] => {
  if (statement.type == "error" || statement.type === "end") {
    return [statement.type]
  }
  if (statement.type === "let") {
    const { type, name, init } = statement
    return [type, tokenToArray(name), expressionToArray(init)]
  }
  if (statement.type === "set") {
    const { type, left, right } = statement
    return [type, tokenToArray(left), expressionToArray(right)]
  }
  if (statement.type === "if") {
    const { type, condition, thenClause } = statement
    return [
      type,
      expressionToArray(condition),
      thenClause.map(statementToArray),
    ]
  }
  if (statement.type === "while") {
    const { type, condition, body } = statement
    return [
      type,
      expressionToArray(condition),
      body.map(statementToArray),
    ]
  }
  throw exhaust(statement)
}

/**
 * Split a source code into a list of tokens.
 */
export const tokenize = (source: string): Token[] => {
  const tokenRegexp = /( +)|([+-]?[0-9]+\b)|([a-zA-Z0-9_\b]+)|([()])|([-+*\/%=!<]+)|(.)/g

  const tokens: Token[] = []

  // Current position.
  let line = 0
  let character = 0

  /** Add a token to the list. */
  const push = (token: TokenBase) => {
    // Calculate the range of the token.
    const range = {
      start: { line, character },
      end: { line, character: character + token.value.length },
    }

    tokens.push({ ...token, range })
  }

  const lines = source.split(/\r\n|\n/)
  for (line = 0; line < lines.length; line++) {
    // Skip blank line.
    if (lines[line].trim() === "") continue

    while (true) {
      const match = tokenRegexp.exec(lines[line])
      if (!match) break

      character = match.index

      // All of elements are undefined except for the matched alternative.
      const [
        ,
        space,
        int,
        name,
        paren,
        operator,
        invalid,
      ] = match

      if (space) {
        continue
      }
      if (int) {
        push({ type: "int", value: int })
        continue
      }
      if (name === "let" || name === "set" || name === "end"
        || name === "if" || name === "while") {
        push({ type: name, value: name })
        continue
      }
      if (name) {
        push({ type: "name", value: name })
        continue
      }
      if (paren) {
        push({ type: paren as TokenType, value: paren })
        continue
      }
      if (operator) {
        push({ type: "operator", value: operator })
        continue
      }
      if (invalid) {
        push({ type: "invalid", value: invalid })
        continue
      }

      throw new Error("NEVER")
    }

    character = lines[line].length
    push({ type: "eol", value: "" })
  }

  return tokens
}

export const testTokenize = () => {
  const table = [
    {
      source: "let x =  1",
      expected: [
        ["let", "let", [[0, 0], [0, 3]]],
        ["name", "x", [[0, 4], [0, 5]]],
        ["operator", "=", [[0, 6], [0, 7]]],
        ["int", "1", [[0, 9], [0, 10]]],
        ["eol", "", [[0, 10], [0, 10]]],
      ],
    },
  ]

  for (const { source, expected } of table) {
    const tokens = tokenize(source)
    const values = tokens.map(t => (
      [t.type, t.value, rangeToMatrix(t.range)]
    ))
    assert.deepStrictEqual(values, expected)
  }
}

/**
 * Parse tokens to make diagnostics.
 */
const parseTokens = (tokens: Token[]): SyntaxModel => {
  const diagnostics: Diagnostic[] = []

  if (tokens.length === 0) {
    return { statements: [], diagnostics }
  }

  // Current token index.
  let i = 0

  // Whether the current line has an error.
  let hasError = false

  /**
   * Skip over the current line.
   * Return the skipped range.
   */
  const skipLine = (): { range: Range } => {
    // Start of the skipped range.
    const l = i
    if (l >= tokens.length) {
      return { range: tokens[tokens.length - 1].range }
    }
    if (tokens[i].type === "eol") {
      return { range: tokens[i].range }
    }

    // Exclusive end of the skipped range.
    let r = l + 1
    while (r < tokens.length && tokens[r].type !== "eol") {
      r++
    }
    assert.ok(l < r && (r >= tokens.length || tokens[r].type === "eol"))

    const range = {
      start: tokens[l].range.start,
      end: tokens[r - 1].range.end,
    }

    i = r
    return { range }
  }

  /**
   * Report a warning.
   * Don't report warnings more than once per line.
   */
  const warn = (message: string, range: Range) => {
    if (hasError) return
    hasError = true

    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      message,
      range,
    })
  }

  /**
   * Skip over the current line
   * and create a statement that represents an error.
   */
  const errorStatement = (message: string): Statement => {
    const { range } = skipLine()
    warn(message, range)
    return { type: "error", message, range }
  }

  const isAtomicExpression = (token: Token) => {
    return token.type === "int" || token.type === "name"
  }

  /**
   * Parse tokens as an expression.
   */
  const parseExpression = (): Expression => {
    if (
      i + 2 < tokens.length
      && isAtomicExpression(tokens[i])
      && tokens[i + 1].type === "operator"
      && isAtomicExpression(tokens[i + 2])
    ) {
      const left = tokens[i]
      const operator = tokens[i + 1]
      const right = tokens[i + 2]
      i += 3
      return { type: "binary", operator, left, right }
    }

    if (
      i + 1 < tokens.length
      && isAtomicExpression(tokens[i])
      && tokens[i + 1].type === "("
    ) {
      const callee = tokens[i]
      i += 2

      let arg = undefined
      if (isAtomicExpression(tokens[i])) {
        arg = tokens[i]
        i++
      }

      if (tokens[i].type !== ")") {
        const e: Expression = {
          type: "error",
          message: "Expected ')'.",
          range: tokens[i].range,
        }
        warn(e.message, e.range)
        return e
      }
      i++

      return { type: "call", callee, arg }
    }

    const token = tokens[i]
    if (!isAtomicExpression(token)) {
      const e: Expression = {
        type: "error",
        message: "Expected an expression.",
        range: token.range,
      }
      warn(e.message, e.range)
      return e
    }
    i++

    return { type: "atomic", token }
  }

  const parseLetStatement = (): Statement => {
    if (tokens[i].type !== "let") {
      return errorStatement("Expected 'let'.")
    }
    i++

    const nameToken = tokens[i]
    if (nameToken.type !== "name") {
      return errorStatement("Expected a name.")
    }
    i++

    if (!(tokens[i].type === "operator" && tokens[i].value === "=")) {
      return errorStatement("Expected '='.")
    }
    i++

    const initExpression = parseExpression()

    return {
      type: "let",
      name: nameToken,
      init: initExpression,
    }
  }

  const parseSetStatement = (): Statement => {
    if (tokens[i].type !== "set") {
      return errorStatement("Expected 'set'.")
    }
    i++

    const left = tokens[i]
    if (left.type !== "name") {
      return errorStatement("Expected a name.")
    }
    i++

    if (!(tokens[i].type === "operator" && tokens[i].value === "=")) {
      return errorStatement("Expected '='.")
    }
    i++

    const right = parseExpression()

    return { type: "set", left, right }
  }

  const parseEndStatement = (): Statement => {
    const endToken = tokens[i]
    if (!endToken || endToken.type !== "end") {
      return errorStatement("Expected 'end'.")
    }
    i++
    return { type: "end" }
  }

  /**
   * Check if it's at the end of line and skip over the `eol` token.
   * Otherwise, report a warning.
   */
  const parseEol = (statements: Statement[]) => {
    if (tokens[i].type !== "eol") {
      statements.push(errorStatement("Expected an end of line."))
    }
    i++
  }

  /**
   * Parse `if` statement and following statements including `end`.
   */
  const parseIfBlock = (statements: Statement[]) => {
    const ifToken = tokens[i]
    if (ifToken.type !== "if") {
      throw new Error("Never")
    }
    i++

    const condition = parseExpression()
    parseEol(statements)

    const thenClause = parseClause()

    statements.push({ type: "if", ifToken, condition, thenClause })
    statements.push(parseEndStatement())
  }

  const parseWhileBlock = (statements: Statement[]) => {
    if (tokens[i].type !== "while") {
      throw new Error("Never")
    }
    i++

    const condition = parseExpression()
    parseEol(statements)

    const body = parseClause()

    statements.push({ type: "while", condition, body })
    statements.push(parseEndStatement())
  }

  const parseBlock = (statements: Statement[]) => {
    hasError = false

    if (tokens[i].type === "let") {
      statements.push(parseLetStatement())
      parseEol(statements)
      return
    }
    if (tokens[i].type === "set") {
      statements.push(parseSetStatement())
      parseEol(statements)
      return
    }
    if (tokens[i].type === "end") {
      throw new Error("Never")
    }
    if (tokens[i].type === "if") {
      parseIfBlock(statements)
      return
    }
    if (tokens[i].type === "while") {
      parseWhileBlock(statements)
      return
    }

    statements.push(errorStatement("Expected a statement."))
    parseEol(statements)
  }

  /**
   * Parse any number of blocks
   * until an `end` token or the end of tokens.
   */
  const parseClause = (): Statement[] => {
    const statements: Statement[] = []

    while (i < tokens.length && tokens[i].type !== "end") {
      parseBlock(statements)
      if (tokens[i].type === "eol") {
        i++
        continue
      }
    }

    return statements
  }

  /**
   * Parse top-level statements.
   */
  const parseTopLevel = (): Statement[] => {
    const statements: Statement[] = []

    while (i < tokens.length) {
      if (tokens[i].type === "eol") {
        i++
        continue
      }

      if (tokens[i].type === "end") {
        statements.push(errorStatement("Unexpected 'end'."))
        parseEol(statements)
        continue
      }

      parseBlock(statements)
    }

    return statements
  }

  const topLevel = parseTopLevel()
  return { statements: topLevel, diagnostics }
}

const parseSource = (source: string) => {
  return parseTokens(tokenize(source))
}

export const testParseTokens = () => {
  const table = [
    {
      source: "let x = 1\nlet y = x",
      expected: [
        [
          ["let", ["name", "x"], ["atomic", ["int", "1"]]],
          ["let", ["name", "y"], ["atomic", ["name", "x"]]],
        ],
        []
      ],
    },
    {
      source: "let x = 1 + 2",
      expected: [
        [
          ["let", ["name", "x"], [
            "binary",
            ["operator", "+"],
            ["int", "1"],
            ["int", "2"],
          ]],
        ],
        [],
      ],
    },
    {
      source: "let \nlet x =  1\n=  2\nlet it =\nlet 0 =  1",
      expected: [
        [
          ["error"],
          ["let", ["name", "x"], ["atomic", ["int", "1"]]],
          ["error"],
          ["let", ["name", "it"], ["error"]],
          ["error"],
        ],
        [
          ["Expected a name.", [[0, 4], [0, 4]]],
          ["Expected a statement.", [[2, 0], [2, 4]]],
          ["Expected an expression.", [[3, 8], [3, 8]]],
          ["Expected a name.", [[4, 4], [4, 10]]],
        ],
      ],
    },
    {
      source: "let x be 1;",
      expected: [
        [
          ["error"],
        ],
        [
          ["Expected '='.", [[0, 6], [0, 11]]],
        ],
      ],
    },
    {
      source: "let x = f()\nlet _ = g(x)\nlet _ = h(",
      expected: [
        [
          ["let", ["name", "x"], ["call", ["name", "f"]]],
          ["let", ["name", "_"], ["call", ["name", "g"], ["name", "x"]]],
          ["let", ["name", "_"], ["error"]],
        ],
        [
          ["Expected ')'.", [[2, 10], [2, 10]]],
        ],
      ],
    },
    {
      source: "if false\nlet x = 0\nend",
      expected: [
        [
          ["if", ["atomic", ["name", "false"]], [
            ["let", ["name", "x"], ["atomic", ["int", "0"]]],
          ]],
          ["end"],
        ],
        [],
      ],
    },
    {
      source: "if false\n",
      expected: [
        [
          ["if", ["atomic", ["name", "false"]], []],
          ["error"],
        ],
        [
          ["Expected 'end'.", [[0, 8], [0, 8]]],
        ],
      ],
    },
  ]

  for (const { source, expected } of table) {
    const { statements, diagnostics } = parseSource(source)
    const actual = [
      statements.map(statementToArray),
      diagnostics.map(d => (
        [d.message, rangeToMatrix(d.range)]
      ))
    ]
    assert.deepStrictEqual(actual, expected)
  }
}

/**
 * Performs semantic analysis statically
 * to make a mapping between tokens and symbols.
 */
const analyzeStatements = (statements: Statement[]): SemanticModel => {
  const symbolDefinitions: SymbolDefinition[] = []

  // Map from names to defined symbols.
  const environment = new Map<string, SymbolDefinition>()

  const diagnostics: Diagnostic[] = []

  const defineName = (nameToken: Token) => {
    assert.strictEqual(nameToken.type, "name")

    const definition: SymbolDefinition = {
      type: "var",
      definitions: [nameToken],
      references: [],
    }

    symbolDefinitions.push(definition)
    environment.set(nameToken.value, definition)
  }

  const referName = (nameToken: Token) => {
    assert.strictEqual(nameToken.type, "name")

    // Find the symbol that the name refers to.
    const symbolDefinition = environment.get(nameToken.value)

    // If missing, it's not defined yet.
    if (!symbolDefinition) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        message: `'${nameToken.value}' is not defined.`,
        range: nameToken.range,
        source: "curage-lang lsp",
      })
      return
    }

    // Add to the list of reference-site tokens to find.
    symbolDefinition.references.push(nameToken)
  }

  const analyzeToken = (token: Token) => {
    if (token.type === "name") {
      referName(token)
    }
  }

  const analyzeExpression = (expression: Expression) => {
    if (expression.type === "atomic") {
      analyzeToken(expression.token)
    }
    if (expression.type === "binary") {
      const { left, right } = expression
      analyzeToken(left)
      analyzeToken(right)
    }
  }

  const analyzeStatement = (statement: Statement): void => {
    if (statement.type === "error") {
      return
    }
    if (statement.type === "let") {
      const { init, name } = statement

      analyzeExpression(init)

      if (name.type === "name") {
        defineName(name)
      }
      return
    }
    if (statement.type === "set") {
      const { left, right } = statement
      analyzeToken(left)
      analyzeExpression(right)
      return
    }
    if (statement.type === "end") {
      return
    }
    if (statement.type === "if") {
      const { condition, thenClause } = statement
      analyzeExpression(condition)
      analyzeStatements(thenClause)
      return
    }
    if (statement.type === "while") {
      const { condition, body } = statement
      analyzeExpression(condition)
      analyzeStatements(body)
      return
    }
    throw exhaust(statement)
  }

  const analyzeStatements = (statements: Statement[]): void => {
    for (const statement of statements) {
      analyzeStatement(statement)
    }
  }

  analyzeStatements(statements)
  return { statements, symbolDefinitions, diagnostics }
}

const analyzeSource = (source: string): SemanticModel => {
  const { statements, diagnostics: d1 } = parseSource(source)
  const { symbolDefinitions, diagnostics: d2 } = analyzeStatements(statements)
  return {
    statements,
    symbolDefinitions,
    diagnostics: [...d1, ...d2],
  }
}

export const testAnalyzeStatements = () => {
  const table = [
    // Shadowing case.
    {
      source: "let x =  1\nlet y =  x\nlet x =  y",
      expected: [
        [
          ["var", [[0, 4]], [[1, 9]]],
          ["var", [[1, 4]], [[2, 9]]],
          ["var", [[2, 4]], []],
        ],
        [],
      ],
    },
    // Use-of-undefined-variable case.
    {
      source: "let x =  x",
      expected: [
        [
          ["var", [[0, 4]], []],
        ],
        [
          ["'x' is not defined.", [0, 9]],
        ],
      ],
    },
  ]

  for (const { source, expected } of table) {
    const { symbolDefinitions, diagnostics } = analyzeSource(source)
    const actual = [
      symbolDefinitions.map(s => [
        s.type,
        s.definitions.map(d => positionToArray(d.range.start)),
        s.references.map(t => positionToArray(t.range.start)),
      ]),
      diagnostics.map(d => [
        d.message,
        positionToArray(d.range.start),
      ])
    ]
    assert.deepStrictEqual(actual, expected)
  }
}

/**
 * Find the symbol at the specified position.
 */
const hitTestSymbol = (semanticModel: SemanticModel, position: Position) => {
  const touch = (range: Range) =>
    comparePositions(range.start, position) <= 0
    && comparePositions(position, range.end) <= 0

  for (const symbolDefinition of semanticModel.symbolDefinitions) {
    for (const d of symbolDefinition.definitions) {
      if (touch(d.range)) {
        return { symbolDefinition, token: d }
      }
    }

    for (const r of symbolDefinition.references) {
      if (touch(r.range)) {
        return { symbolDefinition, token: r }
      }
    }
  }

  return undefined
}

export const testHitTestSymbol = () => {
  // Tests for returned symbol definition.

  const table = [
    {
      source: "let answer =  42",
      positions: [[0, 4], [0, 5], [0, 10]],
      expected: "answer",
    },
    {
      source: "let answer =  42\nlet x =  answer\nlet y =  answer\n",
      positions: [[1, 9], [2, 15]],
      expected: "answer",
    },
    {
      source: "let x      =  42\n",
      positions: [[0, 0], [0, 6], [0, 14], [1, 0]],
      expected: undefined,
    }
  ]

  for (const { source, positions, expected } of table) {
    const semanticModel = analyzeSource(source)

    for (const [line, character] of positions) {
      const hit = hitTestSymbol(semanticModel, { line, character })
      const symbol = hit && hit.symbolDefinition
      const definition = symbol && symbol.definitions[0]
      const name = definition && definition.value
      assert.deepStrictEqual(name, expected)
    }
  }

  // Tests for returned token.
  {
    const table = [
      {
        source: "let x =  1",
        position: [0, 5],
        expected: [0, 4],
      },
      {
        source: "let x =  1\nlet y =  x",
        position: [1, 10],
        expected: [1, 9],
      },
      {
        source: "let x =  1",
        position: [0, 0],
        expected: undefined,
      },
    ]

    for (const { source, position: [line, character], expected } of table) {
      const semanticModel = analyzeSource(source)
      const hit = hitTestSymbol(semanticModel, { line, character })
      const token = hit && hit.token
      const actual = token && positionToArray(token.range.start)
      assert.deepStrictEqual(actual, expected)
    }
  }
}

/** Evaluate the program and print the last variable. */
const evaluate = (statements: Statement[]) => {
  /** Map from variable names to values. */
  const env = new Map<string, any>()

  env.set("to_string", (value: any) => `${value}`)

  const fail = (message: string, range: Range): never => {
    const { line, character } = range.start
    throw new Error(`Error: ${message} at line ${1 + line} column ${1 + character}`)
  }

  const evaluateToken = (token: Token) => {
    if (token.type === "int") {
      return Number.parseInt(token.value, 10)
    }
    if (token.type === "name") {
      const value = env.get(token.value)
      if (value === undefined) {
        throw fail(`Undefined variable ${token.value}`, token.range)
      }
      return value
    }
    throw fail("Invalid value", token.range)
  }

  const evaluateExpression = (expression: Expression) => {
    if (expression.type === "error") {
      throw fail(expression.message, expression.range)
    }
    if (expression.type === "atomic") {
      return evaluateToken(expression.token)
    }
    if (expression.type === "call") {
      const { callee, arg } = expression
      const calleeValue = evaluateToken(callee)
      const argValue = arg ? evaluateToken(arg) : undefined
      return calleeValue(argValue)
    }
    if (expression.type === "binary") {
      const { operator, left, right } = expression
      const leftValue = evaluateToken(left)
      const rightValue = evaluateToken(right)
      if (operator.value === "+") return leftValue + rightValue
      if (operator.value === "-") return leftValue - rightValue
      if (operator.value === "*") return leftValue * rightValue
      if (operator.value === "/") return leftValue / rightValue
      if (operator.value === "%") return leftValue % rightValue
      if (operator.value === "==") return leftValue === rightValue
      if (operator.value === "!=") return leftValue !== rightValue
      if (operator.value === "<=") return leftValue <= rightValue
      if (operator.value === "<") return leftValue < rightValue
      if (operator.value === ">=") return leftValue >= rightValue
      if (operator.value === ">") return leftValue > rightValue
      throw fail("Undefined operator", operator.range)
    }
    throw exhaust(expression)
  }

  const evaluateStatement = (statement: Statement) => {
    if (statement.type === "error") {
      const { message, range } = statement
      throw fail(message, range)
    }
    if (statement.type === "let") {
      const value = evaluateExpression(statement.init)
      env.set(statement.name.value, value)
      return
    }
    if (statement.type === "set") {
      const { left, right } = statement
      const value = evaluateExpression(right)
      env.set(left.value, value)
      return
    }
    if (statement.type === "end") {
      return
    }
    if (statement.type === "if") {
      const { condition, thenClause } = statement
      const conditionValue = evaluateExpression(condition)
      if (conditionValue !== false) {
        for (const statement of thenClause) {
          evaluateStatement(statement)
        }
      }
      // FIXME: Remove local variables defined in the then-clause from `env` here.
      return
    }
    if (statement.type === "while") {
      const { condition, body } = statement
      while (evaluateExpression(condition) !== false) {
        for (const statement of body) {
          evaluateStatement(statement)
        }
      }
      return
    }
    throw exhaust(statement)
  }

  for (const statement of statements) {
    evaluateStatement(statement)
  }

  return env
}

const evaluateSource = (source: string) => {
  const { statements } = parseSource(source)
  return evaluate(statements)
}

export const testEvaluate = () => {
  const table = [
    {
      source: "let x =  1\nlet x =  2\nlet y =  x",
      name: "y",
      expected: 2,
    },
    {
      source: "let x =  2\nlet y =  x + 3",
      name: "y",
      expected: 5,
    },
    {
      source: "let x = 1\nset x = 2",
      name: "x",
      expected: 2,
    },
    {
      source: `
        let i = 0
        while i < 10
          set i = i + 1
        end
      `,
      name: "i",
      expected: 10,
    },
    {
      source: "let x = to_string(42)",
      name: "x",
      expected: "42",
    },
  ]
  for (const { source, name, expected } of table) {
    const env = evaluateSource(source)
    assert.deepStrictEqual(env.get(name), expected)
  }
}

interface OpenDocument {
  version: number | null,
  semanticModel: SemanticModel,
}

/**
 * Map from URI of open documents to analysis results.
 */
const openDocuments = new Map<string, OpenDocument>()

/**
 * Called when a document opens or changed.
 */
const documentDidOpenOrChange = (uri: string, version: number | null, text: string) => {
  // Prevent overwriting by old version.
  const current = openDocuments.get(uri)
  if (current && (current.version || 0) > (version || 0)) return

  // Perform static analysis.
  const semanticModel = analyzeSource(text)
  openDocuments.set(uri, { version, semanticModel })

  // Report current diagnostics in the document identified by the `uri`.
  const { diagnostics } = semanticModel
  sendNotify("textDocument/publishDiagnostics", {
    uri, diagnostics,
  } as PublishDiagnosticsParams)
}

/**
 * Create highlights to emphasis tokens
 * same as the symbol at the specified position.
 */
const createHighlights = (uri: string, position: Position) => {
  const openDocument = openDocuments.get(uri)
  if (!openDocument) {
    return
  }

  const hit = hitTestSymbol(openDocument.semanticModel, position)
  if (!hit) {
    return
  }

  const highlights: DocumentHighlight[] = []
  const { definitions, references } = hit.symbolDefinition

  for (const d of definitions) {
    highlights.push({
      kind: DocumentHighlightKind.Write,
      range: d.range,
    })
  }

  for (const r of references) {
    highlights.push({
      kind: DocumentHighlightKind.Read,
      range: r.range,
    })
  }

  return highlights
}

/**
 * Prepare for symbol renaming.
 *
 * Return the range of pointed symbol and current name as placeholder.
 */
const prepareRename = (uri: string, position: Position) => {
  const openDocument = openDocuments.get(uri)
  if (!openDocument) {
    return
  }

  const hit = hitTestSymbol(openDocument.semanticModel, position)
  if (!hit) {
    return
  }

  const { token } = hit
  return token.range
}

/**
 * Calculate edits for symbol renaming.
 */
const createRenameEdit = (uri: string, position: Position, newName: string): WorkspaceEdit | undefined => {
  const openDocument = openDocuments.get(uri)
  if (!openDocument) {
    return
  }

  const hit = hitTestSymbol(openDocument.semanticModel, position)
  if (!hit) {
    return
  }

  const edits: TextEdit[] = []
  const { definitions, references } = hit.symbolDefinition

  for (const d of definitions) {
    edits.push({
      range: d.range,
      newText: newName,
    })
  }

  for (const r of references) {
    edits.push({
      range: r.range,
      newText: newName,
    })
  }

  const documentChanges: TextDocumentEdit[] = [
    { textDocument: { uri, version: openDocument.version }, edits }
  ]
  return { documentChanges }
}

export const main = () => {
  listenToLSPClient()
}
