// curage-lang compiler.

import * as assert from "assert"
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

/**
 * Range of text.
 *
 * For `[first, second] : Span`, `first` points to the position where the range starts
 * and `second` indicates the number of lines and columns of the final line in the range.
 * E.g. `[{y: 0, x: 3}, {y: 2, x: 1}]` indicates the following `x`s.
 *
 * ```
 * ___xxx
 * xxxxxx
 * x_____
 * ```
 */
type TextRange = [Pos, Pos]

/**
 * Information about something bad.
 */
export interface Issue {
  message: string,
  range: TextRange,
}

type Punctuation =
  | "(" | ")" | "=" | ";"

type TokenType =
  | "integer"
  | "name"
  | "let"
  | "eof"
  | Punctuation

interface TokenCore {
  type: TokenType,
  value: string,
}

/**
 * Minimum unit of string in the source code.
 * A word, integer, punctuation, etc.
 */
interface Token extends TokenCore {
  /** How many new lines and spaces exist before this. */
  offset: Pos,
}

type MaybeToken =
  | Token
  | { type: undefined }

type NodeType =
  | "error"
  | "token"
  | "name"
  | "integer"
  | "call-expression"
  | "binary-expression"
  | "let-statement"
  | "expression-statement"
  | "program"

/**
 * Node of concrete syntax tree.
 */
interface Node {
  type: NodeType,
  children: Node[],
  token?: Token,
  span: { y: number, x: number },
}

/**
 * The result of syntactical analysis.
 */
export interface SyntaxModel {
  rootNode: Node,
  issues: Issue[],
}

/**
 * The result of semantical analysis.
 */
export interface SemanticModel {
  syn: SyntaxModel,
  symbols: Map<number, SymbolDefinition>,
  issues: Issue[],
}

/**
 * Convert a `Position` to `Pos` just by renaming keys.
 */
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

const zeroPos: Pos = { y: 0, x: 0 }

const appendPos = (l: Pos, r: Pos): Pos => {
  if (r.y >= 1) {
    return { y: l.y + r.y, x: r.x }
  } else {
    return { y: l.y, x: l.x + r.x }
  }
}

const distancePos = (l: Pos, r: Pos) => {
  const c = comparePos(l, r)
  if (c === 0) {
    return zeroPos
  }
  if (c > 0) {
    return distancePos(r, l)
  }
  if (l.y < r.y) {
    return { y: r.y - l.y, x: r.x }
  }
  return { y: 0, x: r.x - l.x }
}

const posToText = ({ y, x }: Pos) => {
  let buffer = ""
  for (let i = 0; i < y; i++) {
    buffer += "\n"
  }
  for (let i = 0; i < x; i++) {
    buffer += " "
  }
  return buffer
}

export const testPos = () => {
  assert.deepStrictEqual(comparePos({ y: 1, x: 2 }, { y: 1, x: 2 }), 0)
  assert.deepStrictEqual(comparePos({ y: 1, x: 2 }, { y: 1, x: 3 }), -1)
  assert.deepStrictEqual(comparePos({ y: 1, x: 2 }, { y: 2, x: 0 }), -1)

  assert.deepStrictEqual(appendPos({ y: 1, x: 2 }, { y: 0, x: 3 }), { y: 1, x: 5 })
  assert.deepStrictEqual(appendPos({ y: 1, x: 2 }, { y: 1, x: 3 }), { y: 2, x: 3 })

  assert.deepStrictEqual(distancePos({ y: 1, x: 2 }, { y: 1, x: 5 }), { y: 0, x: 3 })
  assert.deepStrictEqual(distancePos({ y: 1, x: 2 }, { y: 2, x: 3 }), { y: 1, x: 3 })

  assert.deepStrictEqual(posToText({ y: 0, x: 0 }), "")
  assert.deepStrictEqual(posToText({ y: 2, x: 4 }), "\n\n    ")
}

/**
 * Split a source code into a list of tokens.
 *
 * - The result ends with a token with type `eof` to hold the trailing blank.
 * - Spaces and end-of-lines don't become tokens
 *    but are counted in the `Token.leading` field.
 * - This is loss-less operation,
 *    i.e., you can create the original source code from the result.
 */
export const tokenize = (source: string): Token[] => {
  const tokenRegexp = /( +)|([+-]?[0-9]+)|([a-zA-Z0-9_]+)|([()=;])|(.)/g

  const tokens: Token[] = []

  let previousPos = zeroPos

  // Current position.
  let y = 0
  let x = 0

  /** Add a token to the list, appending computed leading space info. */
  const push = (token: TokenCore) => {
    const p = distancePos(previousPos, { y, x })

    tokens.push({ ...token, offset: p })

    previousPos = { y, x: x + token.value.length }
  }

  const lines = source.split(/\r\n|\n/)
  for (y = 0; y < lines.length; y++) {
    while (true) {
      const match = tokenRegexp.exec(lines[y])
      if (!match) break

      x = match.index

      // All of elements are undefined except for the matched arm.
      const [
        _match,
        _space,
        integer,
        name,
        punctuation,
        invalid,
      ] = match

      if (integer) {
        push({ type: "integer", value: integer })
      }
      if (name) {
        if (name === "let") {
          push({ type: "let", value: name })
        } else {
          push({ type: "name", value: name })
        }
      }
      if (punctuation) {
        push({ type: punctuation as any, value: punctuation })
      }
      if (invalid) {
        // Some invalid character appeared.
        // FIXME: publish diagnostics
        console.error({ invalid })
      }
    }
  }

  push({ type: "eof", value: "" })
  return tokens
}

/**
 * FIXME: The key of field for position where the node starts.
 *  The field is computable, however, we have not implemented the logic yet.
 */
const NODE_START_POS = Symbol("Node.startPos")

/**
 * Perform syntactical analysis to a list of tokens.
 */
export const parse = (tokens: Token[]): SyntaxModel => {
  let issues: Issue[] = []

  /** Stack of incomplete nodes. */
  let stack: {
    type: NodeType,
    children: Node[],
    startPos: Pos,
  }[] = []

  let state = {
    /** Current index of token. */
    index: 0,
    y: 0,
    x: 0,
  }

  const isEOF = () =>
    tokens[state.index].type === "eof"

  /** Start to create a node. Push to the stack. */
  const start = (type: NodeType, startPos?: Pos) => {
    stack.push({
      type,
      children: [],
      startPos: startPos || { y: state.y, x: state.x },
    })
  }

  /** Add a node as child to the currently creating node. */
  const push = (node: Node) => {
    stack[stack.length - 1].children.push(node)
  }

  /** End to create a node. Pop from the stack. */
  const end = (): Node => {
    const { type, children, startPos } = stack.pop()
    const span = distancePos(startPos, state)
    return { type, children, span, [NODE_START_POS]: startPos } as Node
  }

  /**
   * Skip over the current token.
   * Add it to the current creating node.
   */
  const skip = () => {
    if (isEOF()) return

    const token = tokens[state.index]
    const span = appendPos(token.offset, { y: 0, x: token.value.length })

    push({
      type: "token",
      token,
      children: [],
      span,
    })

    const p = appendPos(state, span)
    state.y = p.y
    state.x = p.x
    state.index++
  }

  const nextToken = (): MaybeToken => {
    if (isEOF()) {
      return { type: undefined }
    }
    return tokens[state.index]
  }

  const issue = (message: string) => {
    const t = tokens[state.index]
    const nextPos = appendPos(state, t.offset)
    const nextSpan = appendPos(nextPos, { y: 0, x: t.value.length })

    issues.push({ message, range: [nextPos, nextSpan] })
  }

  /**
   * Skips the next punctuation if it's expected.
   * Otherwise, reports an issue.
   */
  const skipPunctuation = (type: Punctuation) => {
    const t = nextToken()
    if (t.type === type) {
      skip()
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
        skip()
        return
      }
    }

    issue(`Expected ';'.`)

    while (!isEOF()) {
      const t = nextToken()
      if (t.type === ";") {
        skip()
        return
      }
      if (t.type === "let") {
        return
      }

      // Skip the token that cannot parse.
      skip()
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
    skip()
    return end()
  }

  const tryParseName = () => {
    const t = nextToken()
    if (t.type !== "name") return

    start("name")
    skip()
    return end()
  }

  /**
   * Parses an atomic expression if possible.
   * Otherwise, creates an error node.
   */
  const parseAtom = (): Node => {
    const numberNode = tryParseNumber()
    if (numberNode) return numberNode

    const nameNode = tryParseName()
    if (nameNode) return nameNode

    start("error")
    issue("Expected a number or name.")
    return end()
  }

  const parseCallExpression = () => {
    let callee = parseAtom()

    const leftParen = nextToken()
    if (leftParen.type !== "(") {
      return callee
    }

    start("call-expression")
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
    skip()
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
  defs: Node[],
  refs: Node[],
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
        const nameToken = node.children[0].token
        if (nameToken.type !== "name") throw new Error("bug")

        const symbolId = env.get(nameToken.value)
        if (!symbolId) {
          const startPos = node[NODE_START_POS]
          issues.push({
            message: `Use of undefined variable '${nameToken.value}'.`,
            range: [appendPos(startPos, nodeOffset(node)), appendPos(startPos, node.span)]
          })
          return
        }

        symbols.get(symbolId).refs.push(node)
        return
      }
      case "let-statement": {
        const [, nameNode, , initNode] = node.children!

        if (initNode) {
          go(initNode)
        }

        if (nameNode) {
          const nameToken = nameNode.children[0].token!
          if (nameToken.type !== "name") throw new Error("bug")

          const symbolId = nextSymbolId++
          symbols.set(symbolId, {
            rawName: nameToken.value,
            symbolId,
            defs: [nameNode],
            refs: [],
          })

          env.set(nameToken.value, symbolId)
        }
        return
      }
      default:
        for (const child of node.children) {
          go(child)
        }
        return
    }
  }

  go(syn.rootNode)

  return { syn, symbols, issues }
}

const nodeOffset = (node: Node) => {
  let offset: Pos | undefined

  const go = (node: Node) => {
    if (offset) return
    if (node.type === "token") {
      offset = node.token.offset
      return
    }

    for (const child of node.children) {
      go(child)
    }
  }

  go(node)
  return offset || zeroPos
}

export const findTokenAt = (syn: SyntaxModel, pos: Pos): Node => {
  let last = syn.rootNode

  const go = (node: Node, basePos: Pos): Node => {
    // Check if the node covers `pos`.
    const l = basePos
    const r = appendPos(basePos, node.span)
    if (!(comparePos(l, pos) <= 0 && comparePos(pos, r) < 0)) {
      return
    }

    last = node

    let p = basePos
    for (const child of node.children) {
      go(child, p)
      p = appendPos(p, child.span)
    }
  }

  go(syn.rootNode, zeroPos)
  return last
}

const descendants = function* (ancestor: Node): Iterable<Node> {
  yield ancestor
  for (const child of ancestor.children) {
    for (const d of descendants(child)) {
      yield d
    }
  }
}

const isDescendant = (ancestor: Node, descendant: Node) => {
  for (const d of descendants(ancestor)) {
    if (d === descendant) return true
  }
  return false
}

export const findSymbolDef = (sema: SemanticModel, node: Node) => {
  for (const symbolDef of sema.symbols.values()) {
    for (const defOrRefNode of [...symbolDef.defs, ...symbolDef.refs]) {
      if (isDescendant(defOrRefNode, node)) {
        return symbolDef
      }
    }
  }

  return undefined
}

const issuesToDiagnostics = ({ issues }: { issues: Issue[] }) => {
  const diagnostics: Diagnostic[] = []

  for (const issue of issues) {
    const { message, range } = issue
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      message,
      range: {
        start: posToPosition(range[0]),
        end: posToPosition(range[1]),
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

  const symbolDef = findSymbolDef(sema, token)
  if (!symbolDef) return []

  const tokens = [
    ...symbolDef.refs,
    ...(context.includeDeclaration ? symbolDef.defs : []),
  ]
  return possToLocations(uri, tokens.map(tp => tp[1]))
}
