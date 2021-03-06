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
import { JsonRpcError } from "./error"

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
    default:
      throw JsonRpcError.newMethodNotFound()
  }
}

type TokenType =
  | "int"
  | "name"
  | "let"
  | "be"
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

interface ErrorStatement {
  type: "error",
  message: string,
  range: Range,
}

interface LetStatement {
  type: "let",
  name: Token,
  init: Token,
}

type Statement =
  | ErrorStatement
  | LetStatement

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
  definition: Token,
  /** Tokens that refers to the symbol. */
  references: Token[],
}

/** Result of static analysis. */
interface SemanticModel {
  statements: Statement[],
  symbolDefinitions: SymbolDefinition[],
  diagnostics: Diagnostic[],
}

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

const statementToArray = (statement: Statement) => {
  if (statement.type == "error") {
    const { type, message } = statement
    return [type]
  }
  if (statement.type === "let") {
    const { type, name, init } = statement
    return [type, tokenToArray(name), tokenToArray(init)]
  }
  throw new Error("Never")
}

/**
 * Split a source code into a list of tokens.
 */
export const tokenize = (source: string): Token[] => {
  const tokenRegexp = /([ \r]+)|([+-]?[0-9]+\b)|([a-zA-Z0-9_]+\b)|(.)/g

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

  const lines = source.split("\n")
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
        invalid,
      ] = match

      if (space) {
        continue
      }
      if (int) {
        push({ type: "int", value: int })
        continue
      }
      if (name === "let" || name === "be") {
        push({ type: name, value: name })
        continue
      }
      if (name) {
        push({ type: "name", value: name })
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
      source: "let x be 1",
      expected: [
        ["let", "let", [[0, 0], [0, 3]]],
        ["name", "x", [[0, 4], [0, 5]]],
        ["be", "be", [[0, 6], [0, 8]]],
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
  const statements: Statement[] = []

  if (tokens.length === 0) {
    return { statements: [], diagnostics }
  }

  // Current token index.
  let i = 0

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

    // Exclusive end of the skipped range.
    let r = l + 1
    while (r < tokens.length && tokens[r - 1].type !== "eol") {
      r++
    }
    assert.ok(l < r && (r >= tokens.length || tokens[r - 1].type === "eol"))

    const range = {
      start: tokens[l].range.start,
      end: tokens[r - 1].range.end,
    }

    i = r
    return { range }
  }

  /**
   * Skip over the current line and report a warning on it.
   */
  const warn = (message: string) => {
    const { range } = skipLine()
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      message,
      range,
    })
    statements.push({
      type: "error",
      message,
      range,
    })
  }

  const isAtomicExpression = (token: Token) => {
    return token.type === "int" || token.type === "name"
  }

  /**
   * Try to parse tokens as an expression.
   * For now, expression is just an integer or name.
   */
  const tryParseExpression = (): Token | undefined => {
    const token = tokens[i]
    if (!isAtomicExpression(token)) {
      return undefined
    }

    i++
    return token
  }

  const parseLetStatement = (): void => {
    if (tokens[i].type !== "let") {
      return warn("Expected 'let'.")
    }
    i++

    const nameToken = tokens[i]
    if (nameToken.type !== "name") {
      return warn("Expected a name.")
    }
    i++

    if (tokens[i].type !== "be") {
      return warn("Expected 'be'.")

    }
    i++

    const initToken = tryParseExpression()
    if (!initToken) {
      return warn("Expected an expression.")
    }

    if (tokens[i].type !== "eol") {
      return warn("Expected an end of line.")
    }
    i++

    statements.push({
      type: "let",
      name: nameToken,
      init: initToken,
    })
  }

  while (i < tokens.length) {
    parseLetStatement()
  }

  return { statements, diagnostics }
}

const parseSource = (source: string) => {
  return parseTokens(tokenize(source))
}

export const testParseTokens = () => {
  const table = [
    {
      source: "let x be 1\r\nlet y be x",
      expected: [
        [
          ["let", ["name", "x"], ["int", "1"]],
          ["let", ["name", "y"], ["name", "x"]],
        ],
        []
      ],
    },
    {
      source: "let \nlet x be 1\nbe 2\nlet it be\nlet 0 be 1",
      expected: [
        [
          ["error"],
          ["let", ["name", "x"], ["int", "1"]],
          ["error"],
          ["error"],
          ["error"],
        ],
        [
          ["Expected a name.", [[0, 4], [0, 4]]],
          ["Expected 'let'.", [[2, 0], [2, 4]]],
          ["Expected an expression.", [[3, 9], [3, 9]]],
          ["Expected a name.", [[4, 4], [4, 10]]],
        ],
      ],
    },
    {
      source: "let x = 1;",
      expected: [
        [
          ["error"],
        ],
        [
          ["Expected 'be'.", [[0, 6], [0, 10]]],
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
      definition: nameToken,
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

  for (const statement of statements) {
    if (statement.type === "let") {
      const { init, name } = statement

      if (init.type === "name") {
        referName(init)
      }

      if (name.type === "name") {
        defineName(name)
      }
    } else if (statement.type === "error") {
      // Error.
    } else {
      throw new Error("NEVER")
    }
  }

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
      source: "let x be 1\nlet y be x\nlet x be y",
      expected: [
        [
          ["var", "x", [0, 4], [[1, 9]]],
          ["var", "y", [1, 4], [[2, 9]]],
          ["var", "x", [2, 4], []],
        ],
        [],
      ],
    },
    // Use-of-undefined-variable case.
    {
      source: "let x be x",
      expected: [
        [
          ["var", "x", [0, 4], []],
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
        s.definition.value,
        positionToArray(s.definition.range.start),
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
    if (touch(symbolDefinition.definition.range)) {
      return { symbolDefinition, token: symbolDefinition.definition }
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
      source: "let answer be 42",
      positions: [[0, 4], [0, 5], [0, 10]],
      expected: "answer",
    },
    {
      source: "let answer be 42\nlet x be answer\nlet y be answer\n",
      positions: [[1, 9], [2, 15]],
      expected: "answer",
    },
    {
      source: "let x      be 42\n",
      positions: [[0, 0], [0, 6], [0, 14], [1, 0]],
      expected: undefined,
    }
  ]

  for (const { source, positions, expected } of table) {
    const semanticModel = analyzeSource(source)

    for (const [line, character] of positions) {
      const hit = hitTestSymbol(semanticModel, { line, character })
      const symbol = hit && hit.symbolDefinition
      assert.deepStrictEqual(symbol && symbol.definition.value, expected)
    }
  }

  // Tests for returned token.
  {
    const table = [
      {
        source: "let x be 1",
        position: [0, 5],
        expected: [0, 4],
      },
      {
        source: "let x be 1\nlet y be x",
        position: [1, 10],
        expected: [1, 9],
      },
      {
        source: "let x be 1",
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

  const fail = (message: string, range: Range): never => {
    const { line, character } = range.start
    throw new Error(`Error: ${message} at line ${1 + line} column ${1 + character}`)
  }

  const evaluateExpression = (token: Token) => {
    if (token.type === "invalid") {
      throw fail("Invalid character", token.range)
    }
    if (token.type === "int") {
      return Number.parseInt(token.value, 10)
    }
    if (token.type === "name") {
      const value = env.get(token.value)
      if (!value) {
        throw fail(`Undefined variable ${token.value}`, token.range)
      }
      return value
    }
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
    throw new Error("Never")
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
      source: "let x be 1\nlet x be 2\nlet y be x",
      name: "y",
      expected: 2,
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
  const { definition, references } = hit.symbolDefinition

  highlights.push({
    kind: DocumentHighlightKind.Write,
    range: definition.range,
  })

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
  const { definition, references } = hit.symbolDefinition

  edits.push({
    range: definition.range,
    newText: newName,
  })

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
