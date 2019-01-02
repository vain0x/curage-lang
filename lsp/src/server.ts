import * as fs from "fs"
import * as assert from "assert"
import {
  Diagnostic,
  DiagnosticSeverity,
  TextDocumentSyncKind,
  InitializeResult,
  TextDocumentRegistrationOptions,
  PublishDiagnosticsParams,
  ReferenceParams,
  Position,
  Location,
  ReferenceContext,
  RenameParams,
  WorkspaceEdit,
} from "vscode-languageserver-protocol"
import {
  findReferenceLocations,
  SemanticModel,
  SyntaxModel,
  validateSource,
  evaluateRename,
} from "./curage"

const stdinLog = fs.createWriteStream("~stdin.txt")
const stdoutLog = fs.createWriteStream("~stdout.txt")

interface AbstractMessage {
  jsonrpc: string,
  id: number,
  method: string,
  params: any,
}

type OnMessage = (message: AbstractMessage) => void

interface TextDocumentInfo {
  uri: string,
  syn: SyntaxModel,
  sema: SemanticModel,
}

const documents: Map<string, TextDocumentInfo> = new Map()

const tryParseLSPMessage = (source: string) => {
  const HEADER_LINE_LIMIT = 10

  let i = 0
  let contentLength: number | undefined
  let hasBody = false

  const lines = source.split("\r\n", HEADER_LINE_LIMIT)
  for (const line of lines) {
    i += line.length + 2

    if (line === "") {
      hasBody = true
      break
    }

    const [key, value] = line.split(":", 2)
    if (key === "Content-Length") {
      contentLength = +value.trim()
      continue
    }

    // Not supported.
  }

  if (!hasBody) return

  if (contentLength === undefined) {
    // FIXME: Send error in JSONRPC protocol.
    throw new Error("Content-Length is required.")
  }

  if (source.length < i + contentLength) {
    return
  }

  const body = source.slice(i, i + contentLength)
  const rest = source.slice(i + contentLength)

  let message: any
  try {
    message = JSON.parse(body)
  } catch (_err) {
    // FIXME: Send error in JSONRPC protocol.
    throw new Error("Invalid JSON.")
  }

  return { message, rest }
}

const testTryParseLSPMessage = () => {
  const table = [
    {
      source: `Content-Length: 56\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{"jsonrpc":2.0,"id":1,"method":"shutdown","params":null}`,
      expected: {
        message: {
          jsonrpc: 2,
          id: 1,
          method: "shutdown",
          params: null,
        },
        rest: "",
      },
    },
    {
      source: `Content-Length: 21\r\n`,
      expected: undefined,
    },
  ]
  for (const { source, expected } of table) {
    const actual = tryParseLSPMessage(source)
    assert.deepStrictEqual(actual, expected)
  }
}

testTryParseLSPMessage()

/**
 * Reads stdin and call `onMessage`
 * whenever a message has come.
 * Each message should be in the format of
 * `Content-Length: <len>\r\n\r\n<content...>`.
 * Note that the buffer provided on `data` event
 * is just a chunk of messages.
 */
const stdinHandler = (onMessage: OnMessage) => {
  let inputs = ""

  const parseAsPossible = () => {
    const result = tryParseLSPMessage(inputs)
    if (result === undefined) return

    const { message, rest } = result
    inputs = rest

    onMessage(message)
  }

  process.stdin.on("data", (data: Buffer) => {
    const chunk = data.toString()
    inputs += chunk

    // For debug.
    stdinLog.write(chunk)

    parseAsPossible()
  })
}

let methodId = 0

/**
 * Submit a LSP message to VSCode.
 */
const sendLSPMessage = (obj: any) => {
  const payload = JSON.stringify({ jsonrpc: "2.0", ...obj }, undefined, 2) + "\r\n"
  const contentLength = payload.length
  const message = `Content-Length: ${contentLength}\r\n\r\n${payload}`

  // Send to VSCode.
  process.stdout.write(message)

  // For debug.
  stdoutLog.write(message)
}

const sendRequest = (id: number, method: string, params: any) => {
  sendLSPMessage({ id, method, params })
}

const sendResponse = (id: number, result: any) => {
  sendLSPMessage({ id, result })
}

const sendNotify = (method: string, params: any) => {
  sendLSPMessage({ method, params })
}

const onMessage: OnMessage = message => {
  const { id, method, params } = message

  switch (method) {
    case "initialize": {
      sendResponse(id, {
        capabilities: {
          // Indicate the server wants textDocument/didChange notifications from the client.
          textDocumentSync: {
            change: TextDocumentSyncKind.Full,
          },
          // Indicate the server supports textDocument/references request.
          referencesProvider: true,
          renameProvider: true,
        },
      } as InitializeResult)

      sendRequest(++methodId, "client/registerCapability", {
        registrations: [
          {
            id: "79eee87c-c409-4664-8102-e03263673f6f",
            method: "textDocument/didOpen",
            registerOptions: {
              documentSelector: [
                { scheme: "file", language: "plaintext" }
              ],
            } as TextDocumentRegistrationOptions,
          }
        ]
      })
      break
    }
    case "initialized": {
      // No need to send a response,
      // because `initialized` is a notification but not a request.
      break
    }
    case "textDocument/didOpen": {
      const { textDocument: { uri, text } } = params
      validateDocument(text, uri)
      break
    }
    case "textDocument/didChange": {
      const { textDocument: { uri }, contentChanges: [{ text }] } = params
      validateDocument(text, uri)
      break
    }
    case "textDocument/references": {
      const { textDocument: { uri }, position, context } = params as ReferenceParams
      onTextDocumentReferences(id, uri, position, context)
      break
    }
    case "textDocument/rename": {
      const { textDocument: { uri }, position, newName } = params as RenameParams
      onTextDocumentRename(id, uri, position, newName)
      break
    }
    case "shutdown": {
      process.exit(0)
      break
    }
  }
}

const validateDocument = (source: string, uri: string) => {
  const { diagnostics, ...document } = validateSource(uri, source)
  documents.set(uri, document)
  sendNotify("textDocument/publishDiagnostics", { uri, diagnostics })
}

const onTextDocumentReferences = (requestId: number, uri: string, position: Position, context: ReferenceContext) => {
  const document = documents.get(uri)
  if (!document) return

  const { syn, sema } = document
  const locations = findReferenceLocations(uri, syn, sema, position, context)

  sendResponse(requestId, locations)
}

const onTextDocumentRename = (requestId: number, uri: string, position: Position, newName: string) => {
  const next = (workspaceEdit?: WorkspaceEdit) => {
    sendResponse(requestId, workspaceEdit || null)
  }

  const document = documents.get(uri)
  if (!document) return next()

  const { sema } = document
  const edits = evaluateRename(position, newName, sema)
  next({ changes: { [uri]: edits } })
}

stdinHandler(onMessage)
