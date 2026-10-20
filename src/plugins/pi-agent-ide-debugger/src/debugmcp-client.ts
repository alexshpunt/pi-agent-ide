const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface ToolCallResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

/** Minimal MCP Streamable HTTP client for the tools of one DebugMCP session. */
export class DebugMcpClient {
  readonly #url: string;
  #sessionId: string | undefined;
  #nextId = 1;

  private constructor(url: string) {
    this.#url = url;
  }

  /** Open one MCP session; DebugMCP keeps its routed VS Code window per session. */
  static async connect(port: number, signal?: AbortSignal): Promise<DebugMcpClient> {
    const client = new DebugMcpClient(`http://127.0.0.1:${port}/mcp`);
    await client.#request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pi-agent-ide", version: "1" },
      },
      signal,
    );
    await client.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
    return client;
  }

  /** Call one DebugMCP tool and return its text, rejecting tool-level errors. */
  async call(
    tool: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = (await this.#request(
      "tools/call",
      { name: tool, arguments: arguments_ },
      signal,
    )) as ToolCallResult;
    const text = (result.content ?? [])
      .flatMap((item) => (item.type === "text" && item.text !== undefined ? [item.text] : []))
      .join("\n");
    if (result.isError === true) throw new Error(text || `DebugMCP ${tool} failed`);
    return text;
  }

  /** End the MCP session; the server may already be gone. */
  async close(): Promise<void> {
    if (this.#sessionId === undefined) return;
    await fetch(this.#url, {
      method: "DELETE",
      headers: this.#headers(),
      signal: AbortSignal.timeout(1_000),
    }).catch(() => {});
    this.#sessionId = undefined;
  }

  async #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params }, signal);
    const message = await responseMessage(response, id);
    if (message.error !== undefined) {
      throw new Error(`DebugMCP ${method} failed: ${message.error.message ?? "unknown error"}`);
    }
    return message.result;
  }

  async #post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: {
        ...this.#headers(),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new Error(`DebugMCP returned HTTP ${response.status}: ${await response.text()}`);
    }
    this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
    return response;
  }

  #headers(): Record<string, string> {
    return this.#sessionId === undefined
      ? {}
      : { "mcp-session-id": this.#sessionId, "mcp-protocol-version": PROTOCOL_VERSION };
  }
}

async function responseMessage(response: Response, id: number): Promise<JsonRpcMessage> {
  const text = await response.text();
  const payloads = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [text];
  for (const payload of payloads) {
    if (payload.length === 0) continue;
    const message = JSON.parse(payload) as JsonRpcMessage;
    if (message.id === id) return message;
  }
  throw new Error("DebugMCP returned no response");
}
