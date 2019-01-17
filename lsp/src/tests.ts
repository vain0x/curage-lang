// Entry point of the test codes.

import { testTryParseLSPMessage } from "./communication"
import {
  testTokenize,
  testParseTokens,
  testAnalyzeStatements,
  testHitTestSymbol,
  testEvaluate,
} from "./curage-server"

testTryParseLSPMessage()
testTokenize()
testParseTokens()
testAnalyzeStatements()
testHitTestSymbol()
testEvaluate()

console.log("Success!")
