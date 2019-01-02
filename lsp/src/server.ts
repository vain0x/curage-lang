import * as fs from "fs"
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

type OnMessage = (message: string) => void

enum InputMode {
  Header,
  Body,
}

interface TextDocumentInfo {
  uri: string,
  syn: SyntaxModel,
  sema: SemanticModel,
}

const documents: Map<string, TextDocumentInfo> = new Map()

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
  let inputMode = InputMode.Header
  let contentLength = 0

  const headerReg = /^([a-zA-Z0-9-]+): *([^\r\n]*)\r\n/

  const handleHeaders = () => {
    if (inputs.length === 0) return
    if (inputMode !== InputMode.Header) return

    // Reached to the end of headers.
    if (inputs.startsWith("\r\n")) {
      inputs = inputs.slice(2)
      inputMode = InputMode.Body
      return
    }

    const m = headerReg.exec(inputs)
    if (!m) return

    inputs = inputs.slice(m[0].length)

    switch (m[1]) {
      case "Content-Length": {
        contentLength = +m[2]
        break
      }
      default:
        // not supported
        break
    }

    handleHeaders()
  }

  const handleBody = () => {
    if (inputMode !== InputMode.Body) return
    if (inputs.length < contentLength) return

    const contents = inputs.slice(0, contentLength)
    inputs = inputs.slice(contentLength)
    inputMode = InputMode.Header

    onMessage(contents)
  }

  process.stdin.on("data", (data: Buffer) => {
    inputs += data.toString()

    handleHeaders()
    handleBody()
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
  // For debug.
  stdinLog.write(message)

  const { id, method, params } = JSON.parse(message)

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
