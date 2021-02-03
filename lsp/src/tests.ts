// Entry point of the test codes.

import { testTryParseLSPMessage, testTryParseLSPMessageError } from "./communication"
import {
  testTokenize,
  testParseTokens,
  testAnalyzeStatements,
  testHitTestSymbol,
  testEvaluate,
} from "./curage-server"

testTryParseLSPMessage()
testTryParseLSPMessageError()
testTokenize()
testParseTokens()
testAnalyzeStatements()
testHitTestSymbol()
testEvaluate()

console.log("Success!")
