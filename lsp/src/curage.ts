// curage-lang compiler.

import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  ReferenceContext,
} from "vscode-languageserver-protocol"

interface Pos {
  /** Row number (from 0). */
  y: number,
  /** Column number (from 0). */
  x: number,
}

export interface Issue extends Pos {
  message: string,
}

interface TokenInteger {
  type: "integer",
  value: number,
}

interface TokenName {
  type: "name",
  value: string,
}

type Keyword =
  | "let"

interface TokenKeyword {
  type: Keyword,
}

type Punctuation =
  | "(" | ")" | "=" | ";"

interface TokenPunctuation {
  type: Punctuation,
}

type Token =
  | TokenInteger
  | TokenName
  | TokenKeyword
  | TokenPunctuation

type MaybeToken =
  | Token
  | { type: undefined, value: undefined }

type NodeType =
  | "error"
  | "name"
  | "integer"
  | "call-expression"
  | "binary-expression"
  | "let-statement"
  | "expression-statement"
  | "program"

interface Node {
  type: NodeType,
  tokens?: [Token, Pos][],
  children?: Node[],
}

export interface SyntaxModel {
  rootNode: Node,
  issues: Issue[],
}

export interface SemanticModel {
  syn: SyntaxModel,
  symbols: Map<number, SymbolDefinition>,
  issues: Issue[],
}

const positionToPos = (position: Position) => ({
  y: position.line,
  x: position.character,
})

const posToPosition = (pos: Pos): Position => ({
  line: pos.y,
  character: pos.x,
})

const posToRange = (pos: Pos): Range => ({
  start: posToPosition(pos),
  end: posToPosition(pos),
})

const comparePos = (l: Pos, r: Pos) => {
  if (l.y !== r.y) {
    return Math.sign(l.y - r.y)
  }

  return Math.sign(l.x - r.x)
}

export const tokenize = (source: string) => {
  const tokenRegexp = /( +)|([+-]?[0-9]+)|([a-zA-Z0-9_]+)|([()=;])|(.)/g

  const tokens: [Token, Pos][] = []

  let y = 0
  let x = 0

  const push = (token: Token) => {
    tokens.push([token, { y, x }])
  }

  const lines = source.split(/\r\n|\n/)
  for (y = 0; y < lines.length; y++) {
    while (true) {
      const match = tokenRegexp.exec(lines[y])
      if (!match) break

      x = match.index

      const [
        _match,
        _space,
        integer,
        name,
        punctuation,
        invalid,
      ] = match

      if (integer) {
        push({ type: "integer", value: +integer })
      }
      if (name) {
        if (name === "let") {
          push({ type: "let" })
        } else {
          push({ type: "name", value: name })
        }
      }
      if (punctuation) {
        push({ type: punctuation as any })
      }
      if (invalid) {
        // FIXME: publish diagnostics
        console.log({ invalid })
      }
    }
  }

  return tokens
}

export const parse = (tokens: [Token, Pos][]): SyntaxModel => {
  let issues: Issue[] = []
  let stack: {
    type: NodeType,
    children: Node[],
    first: number,
  }[] = []

  let i = 0

  const start = (type: NodeType, first = i) => {
    stack.push({
      type,
      children: [],
      first,
    })
  }

  const push = (node: Node) => {
    stack[stack.length - 1].children.push(node)
  }

  const end = () => {
    const { type, children, first } = stack.pop()
    return {
      type,
      children,
      tokens: tokens.slice(first, i),
    }
  }

  const nextToken = (): MaybeToken => {
    if (i >= tokens.length) {
      return { type: undefined }
    }
    return tokens[i][0]
  }

  const nextPos = () => {
    if (i >= tokens.length) {
      if (tokens.length === 0) {
        return { y: 0, x: 0 }
      }
      return tokens[tokens.length - 1][1]
    }
    return tokens[i][1]
  }

  const isEOF = () =>
    i >= tokens.length

  const issue = (message: string) => {
    const { y, x } = nextPos()
    issues.push({ message, y, x })
  }

  /**
   * Skips the next punctuation if it's expected.
   * Otherwise, reports an issue.
   */
  const skipPunctuation = (type: Punctuation) => {
    const t = nextToken()
    if (t.type === type) {
      i++
    } else {
      issue(`Expected '${type}'.`)
    }
  }

  /**
   * Skips until the start of next statement appears,
   * expecting an immediate `;`.
   * Doesn't report more than one issue.
   */
  const skipOverStatement = () => {
    {
      const t = nextToken()
      if (t.type === ";") {
        i++
        return
      }
    }

    issue(`Expected ';'.`)

    while (!isEOF()) {
      const t = nextToken()
      if (t.type === ";") {
        i++
        return
      }
      if (t.type === "let") {
        return
      }

      // The token cannot parse.
      i++
    }
    return
  }

  /**
   * Parses the next token if it's an integer literal.
   * Otherwise, does nothing.
   */
  const tryParseNumber = () => {
    const t = nextToken()
    if (t.type !== "integer") return

    start("integer")
    i++
    return end()
  }

  const tryParseName = () => {
    const t = nextToken()
    if (t.type !== "name") return

    start("name")
    i++
    return end()
  }

  /**
   * Parses an atomic expression if possible.
   * Otherwise, creates an error node.
   */
  const parseAtom = () => {
    const numberNode = tryParseNumber()
    if (numberNode) return numberNode

    const nameNode = tryParseName()
    if (nameNode) return nameNode

    start("error")
    issue("Expected a number or name.")
    return end()
  }

  const parseCallExpression = () => {
    const first = i

    let callee = parseAtom()

    const leftParen = nextToken()
    if (leftParen.type !== "(") {
      return callee
    }

    start("call-expression", first)
    push(callee)
    skipPunctuation("(")
    push(parseExpression())
    skipPunctuation(")")
    return end()
  }

  const parseExpression = () => {
    const callNode = parseCallExpression()
    if (callNode) return callNode

    start("error")
    issue("Expected an expression.")
    return end()
  }

  const tryParseLetStatement = () => {
    const t = nextToken()
    if (t.type !== "let") return

    start("let-statement")
    i++
    push(tryParseName())
    skipPunctuation("=")
    push(parseExpression())
    skipOverStatement()
    return end()
  }

  const parseStatement = () => {
    const letNode = tryParseLetStatement()
    if (letNode) return letNode

    start("expression-statement")
    push(parseExpression())
    skipOverStatement()
    return end()
  }

  const parseProgram = () => {
    start("program")
    while (!isEOF()) {
      const node = parseStatement()
      push(node)
    }
    return end()
  }

  const node = parseProgram()
  return { rootNode: node, issues }
}

interface SymbolDefinition {
  symbolId: number,
  rawName: string,
  defs: [Token, Pos][],
  refs: [Token, Pos][],
}

/**
 * Performs semantic analysis.
 */
export const analyze = (syn: SyntaxModel): SemanticModel => {
  const symbols = new Map<number, SymbolDefinition>()
  const env = new Map<string, number>()
  const issues: Issue[] = []

  let nextSymbolId = 1

  const go = (node: Node) => {
    switch (node.type) {
      case "name": {
        const [t, pos] = node.tokens![0]
        if (t.type !== "name") throw new Error("bug")

        const symbolId = env.get(t.value)
        if (!symbolId) {
          issues.push({
            message: `Use of undefined variable '${t.value}'.`,
            ...pos,
          })
          return
        }

        symbols.get(symbolId).refs.push(node.tokens![0])
        return
      }
      case "let-statement": {
        const [nameNode, initNode] = node.children!

        if (initNode) {
          go(initNode)
        }

        if (nameNode) {
          const [nameToken, namePos] = nameNode.tokens![0]
          if (nameToken.type !== "name") throw new Error("bug")

          const symbolId = nextSymbolId++
          symbols.set(symbolId, {
            rawName: nameToken.value,
            symbolId,
            defs: [[nameToken, namePos]],
            refs: [],
          })

          env.set(nameToken.value, symbolId)
        }
        return
      }
      default:
        for (const child of node.children || []) {
          go(child)
        }
        return
    }
  }

  go(syn.rootNode)

  return { syn, symbols, issues }
}

export const findTokenAt = (syn: SyntaxModel, pos: Pos) => {
  let last: Token | undefined

  for (const [t, p] of syn.rootNode.tokens!) {
    if (comparePos(p, pos) > 0) {
      break
    }
    last = t
  }

  return last
}

export const findSymbolDef = (sema: SemanticModel, tp: [Token, Pos]) => {
  const [token,] = tp

  for (const symbolDef of sema.symbols.values()) {
    for (const [t,] of [...symbolDef.defs, ...symbolDef.refs]) {
      if (t === token) {
        return symbolDef
      }
    }
  }

  return undefined
}

const issuesToDiagnostics = ({ issues }: { issues: Issue[] }) => {
  const diagnostics: Diagnostic[] = []

  for (const issue of issues) {
    const { message, y, x } = issue
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      message,
      range: {
        start: { line: y, character: x },
        end: { line: y, character: x },
      },
      source: "curage-lang",
    })
  }

  return diagnostics
}

const possToLocations = (uri: string, poss: Pos[]) => {
  return poss.map(pos => ({ uri, range: posToRange(pos) }))
}

export const validateSource = (uri: string, source: string) => {
  const tokens = tokenize(source)
  const syn = parse(tokens)
  const sema = analyze(syn)

  const diagnostics = [
    ...issuesToDiagnostics(syn),
    ...issuesToDiagnostics(sema),
  ]
  return { uri, syn, sema, diagnostics }
}

export const findReferenceLocations = (uri: string, syn: SyntaxModel, sema: SemanticModel, position: Position, context: ReferenceContext) => {
  const pos = positionToPos(position)
  const token = findTokenAt(syn, pos)
  if (!token) return []

  const symbolDef = findSymbolDef(sema, [token, pos])
  if (!symbolDef) return []

  const tokens = [
    ...symbolDef.refs,
    ...(context.includeDeclaration ? symbolDef.defs : []),
  ]
  return possToLocations(uri, tokens.map(tp => tp[1]))
}
