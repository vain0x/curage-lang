// Functions to read/write LSP messages via stdio.

import * as assert from "assert"
import { onMessage } from "./curage-server"

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

export const testTryParseLSPMessage = () => {
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

/**
 * Reads stdin and call `onMessage`
 * whenever a message has come.
 * Each message should be in the format of
 * `Content-Length: <len>\r\n\r\n<content...>`.
 * Note that the buffer provided on `data` event
 * is just a chunk of messages.
 */
export const listenToLSPClient = () => {
  let buffer = ""

  const parseAsPossible = () => {
    const result = tryParseLSPMessage(buffer)
    if (result === undefined) return

    const { message, rest } = result
    buffer = rest

    onMessage(message)
  }

  process.stdin.on("data", (data: Buffer) => {
    const chunk = data.toString()
    buffer += chunk

    parseAsPossible()
  })
}

/**
 * Submit a LSP message to VSCode.
 */
export const sendLSPMessage = (obj: any) => {
  const payload = JSON.stringify({ jsonrpc: "2.0", ...obj }, undefined, 2) + "\r\n"
  const contentLength = payload.length
  const message = `Content-Length: ${contentLength}\r\n\r\n${payload}`

  // Send to VSCode.
  process.stdout.write(message)
}

export const sendRequest = (id: number, method: string, params: any) => {
  sendLSPMessage({ id, method, params })
}

export const sendResponse = (id: number, result: any) => {
  sendLSPMessage({ id, result })
}

export const sendNotify = (method: string, params: any) => {
  sendLSPMessage({ method, params })
}
