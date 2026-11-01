#!/usr/bin/env node
// The Project Planner as an MCP server, over stdio.
//
// Claude Code (or any MCP client) starts this with three variables:
//
//   PROJECT_SYNC_URL    the workspace, e.g. https://host/w/project
//   PROJECT_SYNC_TOKEN  a device token minted on the Portal (Devices), or a
//                       SYNC_TOKENS secret on a server you run yourself
//   PROJECT_MCP_STORE   optional: where to keep this device's copy and its
//                       cursors (a SQLite file); defaults under ~/.config.
//                       Set to "memory" to keep nothing between starts.
//
// Everything a tool does is in tools.mjs; this file speaks the protocol.
// The sync client opens on the first call, not at start-up, so a client
// that lists the tools while offline still sees them, and the first call
// that needs the server says plainly when it cannot be reached.

import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PlannerClient, TOOLS, runTool } from './tools.mjs';

const url = process.env.PROJECT_SYNC_URL || '';
const token = process.env.PROJECT_SYNC_TOKEN || '';
const storeSetting = process.env.PROJECT_MCP_STORE || path.join(os.homedir(), '.config', 'project-planner', 'mcp-store.db');

let opening = null;
function client() {
  opening ??= PlannerClient.open({
    url,
    token,
    deviceId: `mcp-${os.hostname().split('.')[0]}`,
    ...(storeSetting === 'memory' ? {} : { storePath: storeSetting }),
  }).catch((err) => {
    // Try again on the next call rather than remembering one bad moment.
    opening = null;
    throw new Error(`The Project Planner sync server could not be reached: ${err.message}`);
  });
  return opening;
}

const server = new Server({ name: 'project-planner', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const { text } = await runTool(await client(), name, args ?? {});
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(`project-planner MCP ready (${url || 'PROJECT_SYNC_URL not set'})\n`);
