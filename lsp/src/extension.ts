/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from "path"
import { ExtensionContext, workspace } from "vscode"
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient"

let client: LanguageClient

export function activate(context: ExtensionContext) {
  // To start language server.,
  // execute `node ./out/server.js`.
  let serverPath = context.asAbsolutePath(
    path.join("out", "server.js")
  )
  let serverOptions: ServerOptions = {
    command: "node",
    args: [serverPath],
  }

  let clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "plaintext" },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/.clientrc"),
    },
  }

  // Start language server and client.
  client = new LanguageClient(
    "curage-lang",
    "Curage Language Server",
    serverOptions,
    clientOptions
  )
  client.start()
}

export function deactivate(): Thenable<void> | undefined {
  if (client) {
    return client.stop()
  }
}
