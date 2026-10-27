// @ts-nocheck
// @jest-environment node
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import * as http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHttpHandler, loadHttpOptions } from '../http.js';

const TOKEN = 'test-token';

function createServer() {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.registerTool(
    'echo',
    { description: 'Echo input', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] })
  );
  return server;
}

describe('loadHttpOptions', () => {
  test('uses safe defaults', () => {
    expect(loadHttpOptions({})).toEqual({ host: '127.0.0.1', port: 3000, path: '/mcp', authToken: undefined });
  });

  test('reads YTDLP_MCP_* overrides and normalizes the path', () => {
    expect(loadHttpOptions({
      YTDLP_MCP_HOST: '0.0.0.0',
      YTDLP_MCP_PORT: '8080',
      YTDLP_MCP_PATH: 'api/mcp',
      YTDLP_MCP_AUTH_TOKEN: 'abc',
    })).toEqual({ host: '0.0.0.0', port: 8080, path: '/api/mcp', authToken: 'abc' });
  });

  test('rejects an invalid port', () => {
    expect(() => loadHttpOptions({ YTDLP_MCP_PORT: 'nope' })).toThrow('Invalid YTDLP_MCP_PORT');
  });
});

describe('createHttpHandler', () => {
  let httpServer;
  let baseUrl;

  beforeAll(async () => {
    httpServer = http.createServer(createHttpHandler(createServer, { host: '127.0.0.1', port: 0, path: '/mcp', authToken: TOKEN }));
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const rpc = (body, headers = {}) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });

  // Stateless responses arrive as a single SSE "message" event
  const parseSse = async (res) => {
    const text = await res.text();
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(data.slice('data: '.length));
  };

  test('serves health probes without auth', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  test('rejects requests without a valid bearer token', async () => {
    const missing = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: '' });
    expect(missing.status).toBe(401);
    const wrong = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer wrong' });
    expect(wrong.status).toBe(401);
  });

  test('returns 405 for GET in stateless mode', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  test('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/other`);
    expect(res.status).toBe(404);
  });

  test('handles initialize, tools/list and tools/call without a session', async () => {
    const init = await parseSse(await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }));
    expect(init.result.serverInfo.name).toBe('test');

    const list = await parseSse(await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(list.result.tools.map((t) => t.name)).toEqual(['echo']);

    const call = await parseSse(await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hello' } },
    }));
    expect(call.result.content[0].text).toBe('hello');
  });
});
