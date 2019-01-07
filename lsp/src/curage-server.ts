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
} from "vscode-languageserver-protocol"
import {
  listenToLSPClient,
  sendNotify,
  sendResponse,
  sendRequest,
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
      const { textDocument: { uri, text } } = params as DidOpenTextDocumentParams
      validateDocument(uri, text)
      break
    }
    case "textDocument/didChange": {
      const { textDocument: { uri }, contentChanges: [{ text }] } = params as DidChangeTextDocumentParams
      validateDocument(uri, text)
      break
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

interface Statement {
  type: "let",
  name: Token,
  init: Token,
}

/** Result of parsing. */
interface SyntaxModel {
  statements: Statement[],
  diagnostics: Diagnostic[],
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

/**
 * Split a source code into a list of tokens.
 */
export const tokenize = (source: string): Token[] => {
  const tokenRegexp = /( +)|([+-]?[0-9]+\b)|([a-zA-Z0-9_\b]+)|(.)/g

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
        _match,
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
      source: "let x be 1\nlet y be x",
      expected: [
        [
          ["let", "x", "1"],
          ["let", "y", "x"],
        ],
        []
      ],
    },
    {
      source: "let \nlet x be 1\nbe 2\nlet it be\nlet 0 be 1",
      expected: [
        [
          ["let", "x", "1"],
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
        [],
        [
          ["Expected 'be'.", [[0, 6], [0, 10]]],
        ],
      ],
    },
  ]

  for (const { source, expected } of table) {
    const { statements, diagnostics } = parseSource(source)
    const actual = [
      statements.map(s => (
        [s.type, s.name.value, s.init.value]
      )),
      diagnostics.map(d => (
        [d.message, rangeToMatrix(d.range)]
      ))
    ]
    assert.deepStrictEqual(actual, expected)
  }
}

/**
 * Validates a document to publish diagnostics (warnings).
 */
const validateDocument = (uri: string, text: string) => {
  const { diagnostics } = parseSource(text)

  // Report current diagnostics in the document identified by the `uri`.
  sendNotify("textDocument/publishDiagnostics", {
    uri,
    diagnostics,
  } as PublishDiagnosticsParams)
}

export const main = () => {
  listenToLSPClient()
}
