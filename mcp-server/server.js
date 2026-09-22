#!/usr/bin/env node
// One process, one port:
//   WS  /extension              — Chrome extension
//   GET /health /llm            — plugin + env chat model
//   POST /command               — snapshot / click / type
//   POST /v1/chat/completions   — proxy to VITE_LLM_*
// Optional stdio MCP for Claude Code / Gemini.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(rootEnv)) {
  for (const raw of readFileSync(rootEnv, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const PORT = Number(process.env.EMBER_MCP_PORT || process.env.BROWSER_MCP_PORT || 8765);
const COMMAND_TIMEOUT_MS = 45000;

const log = (...args) => console.error('[server]', ...args);

let extensionSocket = null;
const pending = new Map();

function callBrowser(name, args = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      return reject(
        new Error('插件未连接。请加载扩展并等徽章变成 MCP。')
      );
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser command "${name}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extensionSocket.send(JSON.stringify({ type: 'command', id, name, args }));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-llm-base-url');
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function envChat() {
  const baseUrl = (process.env.VITE_LLM_BASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.VITE_LLM_API_KEY || '').trim();
  const model = (process.env.VITE_LLM_MODEL || '').trim();
  return { baseUrl, key, model };
}

function chatCompletionsUrl(base) {
  const trimmed = String(base || '').trim().replace(/\/$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

async function proxyChat(payload, req) {
  const env = envChat();
  if (!env.key) {
    const err = new Error('缺少 VITE_LLM_API_KEY。写在仓库根目录 .env，或在侧边栏填写。');
    err.status = 500;
    throw err;
  }
  const headerBase = String(req.headers['x-llm-base-url'] || '').trim();
  const base = env.baseUrl || headerBase;
  const url = chatCompletionsUrl(base);
  if (!url || !/^https?:\/\//i.test(url)) {
    const err = new Error('缺少 VITE_LLM_BASE_URL。写在 .env，或在侧边栏填写。');
    err.status = 500;
    throw err;
  }
  const model = env.model || payload.model;
  if (!model) {
    const err = new Error('缺少 VITE_LLM_MODEL。写在 .env，或在侧边栏填写。');
    err.status = 500;
    throw err;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...payload, model }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Chat upstream HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/llm') {
      const env = envChat();
      return json(res, 200, {
        ok: true,
        baseUrl: env.baseUrl,
        model: env.model,
        apiKey: env.key,
        hasKey: Boolean(env.key),
        fromEnv: {
          baseUrl: Boolean(env.baseUrl),
          apiKey: Boolean(env.key),
          model: Boolean(env.model),
        },
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const raw = await readBody(req);
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { error: '请求不是合法 JSON' });
      }
      const data = await proxyChat(payload, req);
      return json(res, 200, data);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        extensionConnected: extensionSocket?.readyState === 1,
      });
    }
    if (req.method === 'POST' && url.pathname === '/command') {
      const raw = await readBody(req);
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { error: '请求不是合法 JSON' });
      }
      const name = payload.name;
      if (!name || typeof name !== 'string') {
        return json(res, 400, { error: '缺少 command name' });
      }
      const data = await callBrowser(name, payload.args || {});
      return json(res, 200, { ok: true, data });
    }
    json(res, 404, { error: '接口不存在' });
  } catch (e) {
    json(res, e.status || 500, { error: e.message || String(e) });
  }
});

const wss = new WebSocketServer({ server: httpServer, path: '/extension' });

httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用。停掉旧的 npm start 后再启动。`);
    process.exit(1);
  }
  log('HTTP server error:', e.message);
});

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`WS   ws://127.0.0.1:${PORT}/extension`);
  log(`HTTP POST http://127.0.0.1:${PORT}/command`);
  log(`HTTP POST http://127.0.0.1:${PORT}/v1/chat/completions  (chat = ${envChat().model || 'sidebar'})`);
});

wss.on('connection', (ws) => {
  if (extensionSocket) {
    log('New extension connection; replacing the old one');
    try {
      extensionSocket.close();
    } catch {
      /* already dead */
    }
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Extension reconnected; in-flight command dropped'));
    }
    pending.clear();
  }
  extensionSocket = ws;
  log('Extension connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'result') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error || 'Browser command failed'));
  });

  ws.on('close', () => {
    if (extensionSocket === ws) extensionSocket = null;
    log('Extension disconnected');
  });
});

wss.on('error', (e) => {
  log('WebSocket server error:', e.message);
});

setInterval(() => {
  if (extensionSocket?.readyState === 1) {
    extensionSocket.send(JSON.stringify({ type: 'ping' }));
  }
}, 20000).unref();

const mcp = new McpServer({ name: 'valet', version: '0.1.0' });

const text = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

function tool(name, description, schema, handler) {
  mcp.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
}

tool(
  'browser_screenshot',
  'Take a screenshot of the visible part of the active browser tab. Returns an image.',
  { format: z.enum(['jpeg', 'png']).optional().describe('Image format, default jpeg') },
  async (args) => {
    const { dataUrl, url, title, width, height } = await callBrowser('screenshot', args);
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error('Unexpected screenshot format');
    const dims = width ? ` — ${width}x${height}px; image pixels map 1:1 to browser_click x/y coordinates` : '';
    return {
      content: [
        { type: 'text', text: `Screenshot of "${title}" (${url})${dims}` },
        { type: 'image', data: match[2], mimeType: match[1] },
      ],
    };
  }
);

tool(
  'browser_snapshot',
  'Get a structured text snapshot of the active page: title, URL, headings, and all interactive elements with ref ids (e1, e2, ...). Use these refs with browser_click / browser_type. Prefer this over screenshots for finding things to interact with.',
  {},
  async () => text((await callBrowser('snapshot')).snapshot)
);

tool(
  'browser_read_page',
  'Read the visible text content of the active page (title, URL, body text).',
  {},
  async () => {
    const { title, url, text: body } = await callBrowser('read_page');
    return text(`Title: ${title}\nURL: ${url}\n\n${body}`);
  }
);

tool(
  'browser_navigate',
  'Navigate the active tab to a URL and wait for it to load.',
  { url: z.string().describe('URL to open') },
  async (args) => text(await callBrowser('navigate', args))
);

tool('browser_go_back', 'Go back in the active tab history.', {}, async () => text(await callBrowser('go_back')));
tool('browser_go_forward', 'Go forward in the active tab history.', {}, async () => text(await callBrowser('go_forward')));
tool('browser_reload', 'Reload the active tab.', {}, async () => text(await callBrowser('reload')));
tool('browser_get_url', 'Get the URL and title of the active tab.', {}, async () => text(await callBrowser('get_url')));

tool(
  'browser_click',
  'Click an element. Pass a ref id from browser_snapshot (preferred), or viewport x/y coordinates. A visible cursor animates to the target in the browser.',
  {
    ref: z.string().optional().describe('Element ref id from browser_snapshot, e.g. "e12"'),
    x: z.number().optional().describe('Viewport x coordinate'),
    y: z.number().optional().describe('Viewport y coordinate'),
  },
  async (args) => text(await callBrowser('click', args))
);

tool(
  'browser_hover',
  'Hover over an element by ref id or x/y coordinates (triggers menus, tooltips).',
  {
    ref: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  async (args) => text(await callBrowser('hover', args))
);

tool(
  'browser_type',
  'Type text into an input or textarea. Pass a ref from browser_snapshot, or omit ref to type into the focused element. Replaces existing content unless clear=false.',
  {
    text: z.string().describe('Text to type'),
    ref: z.string().optional().describe('Element ref id from browser_snapshot'),
    submit: z.boolean().optional().describe('Press Enter / submit the form after typing'),
    clear: z.boolean().optional().describe('Set false to append instead of replace'),
  },
  async (args) => text(await callBrowser('type', args))
);

tool(
  'browser_press_key',
  'Press a keyboard key in the page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a".',
  { key: z.string() },
  async (args) => text(await callBrowser('press_key', args))
);

tool(
  'browser_scroll',
  'Scroll the page. Default: down by ~one screen. Returns scroll position and page height.',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.number().optional().describe('Pixels to scroll'),
  },
  async (args) => text(await callBrowser('scroll', args))
);

tool('browser_tabs', 'List open tabs in the current browser window.', {}, async () => text(await callBrowser('tabs_list')));

tool(
  'browser_select_tab',
  'Switch to a tab by its index from browser_tabs.',
  { index: z.number() },
  async (args) => text(await callBrowser('tab_select', args))
);

tool(
  'browser_new_tab',
  'Open a new tab, optionally at a URL.',
  { url: z.string().optional() },
  async (args) => text(await callBrowser('tab_new', args))
);

tool('browser_close_tab', 'Close the active tab.', {}, async () => text(await callBrowser('tab_close')));

tool(
  'browser_wait',
  'Wait a number of seconds (max 30) for the page to settle.',
  { seconds: z.number().min(0).max(30) },
  async (args) => text(await callBrowser('wait', args))
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
log('MCP stdio ready');
