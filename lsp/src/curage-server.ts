// Curage-lang LSP server implementation.

import {
  InitializeResult,
  TextDocumentSyncKind,
  DidOpenTextDocumentParams,
  DidChangeTextDocumentParams,
  PublishDiagnosticsParams,
  DiagnosticSeverity,
  Diagnostic,
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
            // whenever a document opens or get closed.
            openClose: true,
            // Indicate the server want the client to send
            // `textDocument/didChange` notifications
            // whenever an open document is modified,
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

/**
 * Validates a document to publish diagnostics (warnings).
 */
const validateDocument = (uri: string, text: string) => {
  const expected = `print "hello, world!"`

  const diagnostics: Diagnostic[] = []

  // If the text is not a hello world program, report a warning.
  for (let i = 0; i < expected.length; i++) {
    if (text[i] !== expected[i]) {
      diagnostics.push({
        message: `Expected '${expected[i]}'.`,
        severity: DiagnosticSeverity.Warning,
        range: {
          start: { line: 0, character: i },
          end: { line: 0, character: i + 1 },
        },
      })
      break
    }
  }

  // Report current diagnostics in the document identified by the `uri`.
  sendNotify("textDocument/publishDiagnostics", {
    uri,
    diagnostics,
  } as PublishDiagnosticsParams)
}

export const main = () => {
  listenToLSPClient()
}
