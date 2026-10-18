// The stdio bridge shares the running companion's engine, journal and human approvals.
// Never opens a second state database or exposes an approval tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const port = Number(process.env.FO_FIX_PORT ?? "4310");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid FO_FIX_PORT");
const client = new Client({ name: "fo-fix-stdio-bridge", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
);
const server = new Server(
  { name: "fo-fix-companion", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: client.getInstructions() },
);
server.setRequestHandler(ListToolsRequestSchema, async () =>
  client.listTools(),
);
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  client.callTool(request.params),
);
await server.connect(new StdioServerTransport());
process.stdin.once("end", () => {
  void client.close();
  void server.close();
});
