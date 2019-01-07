// Entry point of the test codes.

import { testTryParseLSPMessage } from "./communication"
import {
  testTokenize,
  testParseTokens,
  testAnalyzeStatements,
} from "./curage-server"

testTryParseLSPMessage()
testTokenize()
testParseTokens()
testAnalyzeStatements()

console.log("Success!")
