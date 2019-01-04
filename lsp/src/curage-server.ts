// Curage-lang LSP server implementation.

import {
  InitializeResult,
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
        capabilities: {},
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
  }
}

export const main = () => {
  listenToLSPClient()
}
