// A stdio MCP server for the ensureApp tests that stops during a tool call, as a tool that crashes would.
// It answers initialize and tools/list, and exits with code 9 on tools/call.
import readline from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "crash", version: "1.0.0" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "contacts_people_list", inputSchema: { type: "object" } }] } });
  } else if (message.method === "tools/call") {
    process.exit(9);
  }
});
