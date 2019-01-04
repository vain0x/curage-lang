// Entry point of the test codes.

import { testTryParseLSPMessage } from "./communication"
import {
  testTokenize,
  testParseTokens,
} from "./curage-server"

testTryParseLSPMessage()
testTokenize()
testParseTokens()

console.log("Success!")
