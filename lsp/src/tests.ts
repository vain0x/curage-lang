// Entry point of the test codes.

import { testTryParseLSPMessage } from "./communication"
import {
  testTokenize,
  testParseTokens,
  testAnalyzeStatements,
  testHitTestSymbol,
} from "./curage-server"

testTryParseLSPMessage()
testTokenize()
testParseTokens()
testAnalyzeStatements()
testHitTestSymbol()

console.log("Success!")
