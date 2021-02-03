/**
 * An exception object to describe a JSON-RPC error response.
 *
 * See also: <https://www.jsonrpc.org/specification#error_object>.
 */
export class JsonRpcError extends Error {
  constructor(
    /** Specifies the kind of error. Value is written in the JSON-RPC specification. */
    public readonly code: number,

    /** Describes the error for human. */
    public readonly message: string,
  ) {
    super(message)
  }

  /**
   * Json syntax error in request.
   */
  public static newParseError = (): JsonRpcError =>
    new JsonRpcError(-32700, "Parse error.")

  /**
   * An error response to a request that the server can't process
   * due to the request itself includes any fault.
   */
  public static newInvalidRequest = (): JsonRpcError =>
    new JsonRpcError(-32600, "Invalid request.")

  /**
   * An error response to a request that the server can't process
   * due to lack of implementation.
   */
  public static newMethodNotFound = (): JsonRpcError =>
    new JsonRpcError(-32601, "Method not found.")

  /**
   * An error response to a request that the server can't process
   * for some unexpected reason.
   */
  public static newInternalError = (): JsonRpcError =>
    new JsonRpcError(-32603, "Internal error.")
}
