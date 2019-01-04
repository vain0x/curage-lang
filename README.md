# CURAGE-LANG

This project is my study for language server protocol (LSP) server implementation.

Curage-lang itself is a tiny, no-interesting language.

I am implementing a LSP server for the language. It will have some features, such as "use of undefined variable" reporting, symbol renaming, etc.

## Structure

- `lsp`: The language server implementation and VSCode extension.
    - `src/extension.ts`: Entry point of the VSCode extension.
    - `src/server.ts`: Entry point of the server.

## Syntax

TBD.

## See also

- [Language Server Extension Guide | Visual Studio Code Extension API](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide)
- [lsp-sample](https://github.com/Microsoft/vscode-extension-samples/tree/515a928615aaab84ae7f66a38e4346db84464fcb/lsp-sample)
