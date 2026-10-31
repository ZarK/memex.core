import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { errorBody, SurfaceError } from "./errors.js";
import { inputSchema } from "./openapi.js";
import { toolName, type Capability, type Registry } from "./registry.js";

export interface McpOptions {
  /** Runs a call. Defaults to the registry in this process with the origin agent. */
  invoke?: (id: string, input: unknown) => Promise<unknown>;
  /** Text for the server description, before the list of capabilities left out of MCP. */
  instructions?: string;
}

/** The MCP tool of a capability: the name with underscores, the title, the description, the input schema, and annotations. */
export function capabilityTool(cap: Capability): Tool {
  return {
    name: toolName(cap.id),
    title: cap.title,
    description: cap.description,
    inputSchema: inputSchema(cap) as Tool["inputSchema"],
    annotations: {
      title: cap.title,
      readOnlyHint: cap.kind === "read",
      ...(cap.kind === "write" ? { destructiveHint: cap.annotations?.destructive === true } : {}),
      idempotentHint: cap.kind === "read" || cap.annotations?.idempotent === true,
      openWorldHint: false,
    },
  };
}

/** The server description: the instructions, and which capabilities are left out of MCP. */
export function mcpInstructions(registry: Registry, instructions?: string): string {
  const hidden = registry.capabilities.filter((c) => c.mcp === false).map((c) => c.id);
  const parts = [instructions ?? `${registry.name}: every tool is a capability of the ${registry.app} app.`];
  if (hidden.length) parts.push(`Not served over MCP: ${hidden.join(", ")}. Use the HTTP API or memex-${registry.app} call for them.`);
  return parts.join(" ");
}

/**
 * An MCP server with one tool per capability. A call goes straight to the registry, which parses the input itself, so a
 * bad input gets the one error body as a tool result with isError true.
 */
export function createMcpServer(registry: Registry, options: McpOptions = {}): Server {
  const caps = registry.capabilities.filter((c) => c.mcp !== false);
  const tools = caps.map(capabilityTool);
  const byTool = new Map(caps.map((c) => [toolName(c.id), c.id]));
  const invoke = options.invoke ?? ((id: string, input: unknown) => registry.invoke(id, input, { origin: "agent" }));
  const server = new Server(
    { name: `memex-${registry.app}`, title: registry.name, version: registry.version },
    { capabilities: { tools: {} }, instructions: mcpInstructions(registry, options.instructions) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const id = byTool.get(request.params.name);
      if (!id) {
        throw new SurfaceError("unknown_capability", `There is no tool ${request.params.name}.`, {
          hint: `tools/list lists them; every name starts with ${registry.app}_.`,
        });
      }
      const output = await invoke(id, request.params.arguments ?? {});
      return { content: [{ type: "text" as const, text: JSON.stringify(output ?? null) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(errorBody(error).body) }] };
    }
  });
  return server;
}

/** Serves the MCP server over standard input and output (memex-<app> mcp). Resolves when the client closes it. */
export async function serveMcp(registry: Registry, options: McpOptions = {}): Promise<void> {
  const server = createMcpServer(registry, options);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport());
  process.stdin.once("end", () => void server.close());
  await closed;
}
