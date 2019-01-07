# CURAGE-LANG

This project is my study for language server protocol (LSP) server implementation.

Curage-lang itself is a tiny, no-interesting language.

I am implementing a LSP server for the language. It will have some features, such as "use of undefined variable" reporting, symbol renaming, etc.

## Structure

- `lsp`: The language server implementation and VSCode extension.
    - `src/extension.ts`: Entry point of the VSCode extension.
    - `src/server.ts`: Entry point of the server.

## Syntax

Curage-lang's syntax is very simple. The following describes the syntax in PEG-like notation.

```fsharp
eol = "\r\n" / "\n"

expression = int / name

statement = "let" name "be" expression eol

program = statement*
```

Legends:

- `A*` means a sequence of A or empty,
- `A+` means a sequence of A at least one,
- `A / B` means A or B.

Example:

```curage
let x be 1
let y be x
```

## Tags and Features

- v0.1.0: Minimum implementation of LSP server
- v0.2.0: Sample of error reporting
- v0.3.0: Syntactical analysis and syntax error reporting
- v0.4.0: Semantical analysis, hit-testing and symbol highlighting

## See also

- [Official page for Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
- [Language Server Extension Guide | Visual Studio Code Extension API](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide)
- [lsp-sample](https://github.com/Microsoft/vscode-extension-samples/tree/515a928615aaab84ae7f66a38e4346db84464fcb/lsp-sample)
