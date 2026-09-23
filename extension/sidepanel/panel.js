// browser-use side panel: chat uses the model saved in the sidebar.
// (no Settings). The model uses tools itself — snapshot, click, type — no Jev.

const LOCAL = 'http://127.0.0.1:8765';

const DEFAULTS = {
 baseUrl: `${LOCAL}/v1`,
 apiKey: '',
 model: '',
 modelLarge: '',
 modelSmall: '',
 modelVision: '',
 primaryModel: 'large',
 toolsEnabled: true,
 visionEnabled: false,
 maxToolSteps: 0,
 contextTokens: 32768,
 flushOnNavigate: true,
};

let settings = { ...DEFAULTS };

// A request carrying an image must go to the vision model; a text-only model
// crashes on image content. Everything else uses the chosen primary text model.
function requestHasImage(msgs) {
 return msgs.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'));
}

function primaryTextModel() {
 const large = settings.modelLarge || settings.model;
 const small = settings.modelSmall;
 if (settings.primaryModel === 'small' && small) return small;
 return large || small;
}

function pickModel(msgs) {
 if (requestHasImage(msgs) && settings.modelVision) return settings.modelVision;
 return primaryTextModel();
}

function anyModelConfigured() {
 return !!(settings.baseUrl && (settings.modelLarge || settings.modelSmall || settings.modelVision || settings.model));
}
let messages = []; // OpenAI-format conversation (system prompt injected at send time)
let transcript = []; // what's rendered on screen: {kind, text}
let busy = false;

// Chat survives panel/extension reloads for the life of the browser session.
function saveChat() {
 chrome.storage.session.set({ chat: { messages, transcript } }).catch(() => {});
}

async function restoreChat() {
 try {
 const { chat } = await chrome.storage.session.get('chat');
 if (!chat?.transcript?.length) return;
 messages = chat.messages || [];
 transcript = chat.transcript;
 document.getElementById('empty-state')?.remove();
 for (const item of transcript) {
 if (item.kind === 'toolline') renderToolLine(item.text);
 else renderBubble(item.kind, item.text);
 }
 } catch {
 /* storage unavailable — start fresh */
 }
}

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send-btn');
const stopBtn = $('stop-btn');

// ---------------------------------------------------------------------------
// Tools exposed to the local LLM
// ---------------------------------------------------------------------------

const TOOLS = [
 {
 name: 'read_page',
 description: 'Read the visible text content of the current page (title, URL, body text).',
 parameters: { type: 'object', properties: {} },
 command: 'read_page',
 },
 {
 name: 'page_snapshot',
 description:
 'Get a structured snapshot of the current page: headings plus all interactive elements with ref ids (e1, e2, ...) used by click/type tools.',
 parameters: { type: 'object', properties: {} },
 command: 'snapshot',
 },
 {
 name: 'screenshot',
 description: 'Take a screenshot of the visible part of the current tab. Only useful if vision is enabled in settings.',
 parameters: { type: 'object', properties: {} },
 command: 'screenshot',
 },
 {
 name: 'click',
 description:
 'Click an element by ref (from page_snapshot) or x/y. Do not hesitate about whether to click. After the filters are applied, click the first result immediately and move on. Do not pick a result before those filters are set.',
 parameters: {
 type: 'object',
 properties: {
 ref: { type: 'string', description: 'Element ref id like "e12"' },
 x: { type: 'number' },
 y: { type: 'number' },
 },
 },
 command: 'click',
 },
 {
 name: 'type_text',
 description: 'Type text into an input. Pass ref from page_snapshot, or omit to use the focused element. Set submit=true to press Enter after.',
 parameters: {
 type: 'object',
 properties: {
 text: { type: 'string' },
 ref: { type: 'string' },
 submit: { type: 'boolean' },
 },
 required: ['text'],
 },
 command: 'type',
 },
 {
 name: 'press_key',
 description: 'Press a keyboard key, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a".',
 parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
 command: 'press_key',
 },
 {
 name: 'scroll',
 description: 'Scroll the page up or down (default: down, ~one screen).',
 parameters: {
 type: 'object',
 properties: {
 direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
 amount: { type: 'number', description: 'Pixels' },
 },
 },
 command: 'scroll',
 },
 {
 name: 'navigate',
 description:
 'Go to a URL. Same site stays in the working tab (refresh is ok). A different site always opens a new tab — never overwrite or close the user\'s original tab. Page clicks that navigate naturally stay in the same tab.',
 parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
 command: 'navigate',
 },
 {
 name: 'list_tabs',
 description: 'List open tabs in this window.',
 parameters: { type: 'object', properties: {} },
 command: 'tabs_list',
 },
 {
 name: 'select_tab',
 description: 'Switch to a tab by its index from list_tabs.',
 parameters: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] },
 command: 'tab_select',
 },
 {
 name: 'wait',
 description:
 'Only if the page is still loading after navigate or submit (spinner, blank). Do not wait before or after a routine page_snapshot. Max 1 second.',
 parameters: {
 type: 'object',
 properties: { seconds: { type: 'number', description: 'Seconds, at most 1' } },
 },
 command: 'wait',
 },
 {
 name: 'finish',
 description:
 'You decide when this task ends. Call finish and stop using tools when the goal is done, you cannot continue, or you must ask the user something before going on. Do not call any other tool after this. The user\'s next message starts a new task.',
 parameters: {
 type: 'object',
 properties: {
 status: {
 type: 'string',
 enum: ['done', 'blocked', 'ask'],
 description:
 'done = goal complete. blocked = cannot continue (not logged in, cannot pay, missing control, captcha, or the page will not move). ask = the page has no option to click and you need the user; do not use ask to choose among results after the filters are applied.',
 },
 message: {
 type: 'string',
 description:
 'What to tell the user, in their language: the result, why you stopped, or the one question they must answer.',
 },
 },
 required: ['status', 'message'],
 },
 },
];

function toolDefs() {
 return TOOLS.map((t) => ({
 type: 'function',
 function: { name: t.name, description: t.description, parameters: t.parameters },
 }));
}

function browserCommand(name, args = {}) {
 return new Promise((resolve, reject) => {
 chrome.runtime.sendMessage({ __panelCommand: name, args }, (res) => {
 if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
 if (!res) return reject(new Error('No response from extension'));
 if (!res.ok) return reject(new Error(res.error));
 resolve(res.data);
 });
 });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(s) {
 return s.replace(/&/g, '&amp;').replace(/</g, '<').replace(/>/g, '>');
}

function renderMarkdownLite(text) {
 // Minimal: code blocks, inline code, bold. Everything else stays plain text.
 let html = escapeHtml(text);
 html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => ` ${code} `);
 html = html.replace(/`([^`\n]+)`/g, ' $1 ');
 html = html.replace(/\*\*([^*\n]+)\*\*/g, ' $1 ');
 return html;
}

function renderBubble(role, text) {
 $('empty-state')?.remove();
 const div = document.createElement('div');
 div.className = `msg ${role}`;
 div.innerHTML = renderMarkdownLite(text);
 messagesEl.appendChild(div);
 messagesEl.scrollTop = messagesEl.scrollHeight;
 return div;
}

function tidyAssistantText(text) {
 let t = String(text || '').replace(/[ \t]+$/gm, '');
 t = t.replace(/(?:\n+\s*(?:\d+[\.、)）]|[-*•])\s*)+$/g, '');
 t = t.replace(/(?:\n+正在[^\n]*[：:]\s*)+$/g, '');
 t = t.replace(/[：:]\s*$/g, '。');
 return t.trim();
}

function addBubble(role, text) {
 if (role === 'assistant') {
 text = tidyAssistantText(text);
 if (!text) return null;
 }
 transcript.push({ kind: role, text });
 saveChat();
 return renderBubble(role, text);
}

function renderToolLine(text) {
 $('empty-state')?.remove();
 const div = document.createElement('div');
 div.className = 'tool-line';
 div.textContent = text;
 messagesEl.appendChild(div);
 messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addToolLine(name, args) {
 const argStr = JSON.stringify(args || {});
 const line = `⚙ ${name} ${argStr === '{}' ? '' : argStr.slice(0, 120)}`;
 transcript.push({ kind: 'toolline', text: line });
 saveChat();
 renderToolLine(line);
}

function setThinking(on) {
 document.querySelector('.thinking')?.remove();
 if (on) {
 const div = document.createElement('div');
 div.className = 'thinking';
 div.textContent = '执行中';
 messagesEl.appendChild(div);
 messagesEl.scrollTop = messagesEl.scrollHeight;
 }
}

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

async function buildSystemPrompt() {
 let pageInfo = '';
 try {
 const { url, title } = await browserCommand('get_url');
 pageInfo = `\nThe user is currently on: "${title}" (${url})`;
 } catch {
 /* no active tab info available */
 }
 const toolNote = settings.toolsEnabled
 ? 'You have tools: page_snapshot, read_page, click, type_text, press_key, scroll, navigate, wait, finish. ' +
 'Use page_snapshot to get refs (e1, e12…) before click/type. Click by ref, not x/y, unless the control is missing from the snapshot. ' +
 'Dropdowns: click to open, then click the option that matches the filter the user asked for. Forms: fill every filter field the user specified, then apply/submit. ' +
 'Prefer page_snapshot over screenshot. Click, type, key, and scroll results already include a fresh snapshot — use those refs on the next step. Do not call page_snapshot again unless that snapshot says the page is still loading or has no elements. ' +
 'Do not hesitate and do not weigh click versus skip. Until you call finish, respond with a tool call immediately. ' +
 'After the filters are filled and applied, click the first result at once, then continue. Do not compare, do not ask, and do not stop to decide. Do not click a result before the filters are done. If the snapshot says more controls were omitted, the first listed result is enough — click it and move on. Finish and reply as soon as the goal is done. ' +
 'Work on the page the user already has when it can finish the goal. If you decide to go to another site, call navigate — that opens a new tab and leaves the user\'s original tab alone. Do not close tabs. Clicks that the page itself follows stay in the same tab.'
 : 'Tool use is disabled; page text is included with the user message when available.';
 return (
 'You are an autonomous browser task agent (like a work buddy), not a Q&A chatbot. ' +
 'Think quickly. Decide the next action in one short pass and send the tool call. Do not linger, compare options at length, or write out a long analysis. ' +
 'The user publishes one goal in the side panel. You break it into steps, look at the page, and operate. ' +
 'You decide whether to keep going or stop. The program will not stop you. When you stop, call finish — do not snapshot, click, type, or wait again. ' +
 'Call finish with status "done" when the goal is already complete: the outcome is on the page, or the data the user asked for is already in a tool result. Include that result in message. ' +
 'Call finish with status "blocked" when you judge that you cannot continue. That includes: the needed control is missing, the page errored, a captcha is in the way, the same action no longer changes the page, the user is not logged in (do not invent a password or keep clicking login), or payment cannot be completed (no saved method, or the user did not authorize this payment). Say what happened and what the user needs to do. ' +
 'Call finish with status "ask" only when you cannot go on without something the page does not offer, such as permission to pay or a required personal detail with no option to click. Put one question in message. Do not use ask to pick a result after the filters are applied — click the first result instead. This ends the current task. Their next message is a new task. ' +
 'Do not keep browsing after you already have the answer. Do not end with “please wait” or a numbered list. The finish message is one short paragraph in the user\'s language. ' +
 'Be direct. ' +
 toolNote +
 pageInfo
 );
}

function throwIfAborted(signal) {
 if (signal?.aborted) {
 const e = new Error('aborted');
 e.name = 'AbortError';
 throw e;
 }
}

async function callLLM(body, signal) {
 const headers = { 'Content-Type': 'application/json' };
 let url;
 if (settings.useEnvKey) {
 url = `${LOCAL}/v1/chat/completions`;
 if (!settings.fromEnv?.baseUrl && settings.baseUrl) headers['x-llm-base-url'] = settings.baseUrl;
 } else {
 if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
 url = `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`;
 }

 let lastErr;
 for (let attempt = 0; attempt < 2; attempt++) {
 throwIfAborted(signal);
 if (attempt) await new Promise((r) => setTimeout(r, 4000));
 let res;
 try {
 res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
 } catch (e) {
 if (e.name === 'AbortError') throw e;
 lastErr = new Error(`Cannot reach the LLM server at ${url} — is it running? (${e.message})`);
 continue;
 }
 if (res.status >= 500) {
 const t = await res.text().catch(() => '');
 lastErr = new Error(
 `LLM server crashed (HTTP ${res.status}). This is a server-side fault — check your vLLM logs for the stack trace. ` +
 `Common causes: vision enabled while running a text-only model (a screenshot in context will crash the engine), ` +
 `a tool-call parser that doesn't match the model, or out-of-memory. Server said: ${t.slice(0, 200)}`
 );
 continue;
 }
 if (!res.ok) {
 const text = await res.text().catch(() => '');
 throw new Error(`LLM error ${res.status}: ${text.slice(0, 400)}`);
 }
 const data = await res.json();
 const choice = data.choices?.[0];
 const msg = choice?.message;
 if (!msg) throw new Error('LLM returned no message');
 msg.__finishReason = choice.finish_reason || 'stop';
 return msg;
 }
 throw lastErr;
}

// These already change the page. Attach a snapshot so the next model step can act
// instead of spending a round trip only looking.
const REFRESH_AFTER = new Set(['click', 'type_text', 'press_key', 'scroll', 'navigate', 'tab_new', 'tab_select']);

async function runTool(toolCall) {
 let args = {};
 try {
 args = JSON.parse(toolCall.function.arguments || '{}');
 } catch {
 /* some models emit malformed JSON args; run with empty args */
 }
 const tool = TOOLS.find((t) => t.name === toolCall.function.name);
 if (!tool) return { text: `Unknown tool: ${toolCall.function.name}` };
 if (!tool.command) return { text: typeof args.message === 'string' ? args.message : 'Stopped.' };
 addToolLine(tool.name, args);
 try {
 const data = await browserCommand(tool.command, args);
 if (tool.name === 'screenshot') {
 if (!settings.visionEnabled) {
 return { text: 'Screenshot taken, but vision is disabled in settings — use read_page or page_snapshot instead.' };
 }
 return { text: 'Screenshot captured; it is attached as the next message.', imageDataUrl: data.dataUrl };
 }
 if (tool.name === 'read_page') return { text: `Title: ${data.title}\nURL: ${data.url}\n\n${data.text}` };
 if (tool.name === 'page_snapshot') return { text: data.snapshot };
 let text = JSON.stringify(data);
 if (REFRESH_AFTER.has(tool.name)) {
 if (tool.name !== 'type_text' && tool.name !== 'scroll') {
 await new Promise((r) => setTimeout(r, 200));
 }
 try {
 const snap = await browserCommand('snapshot');
 if (snap?.snapshot) {
 text += '\n\nFresh snapshot (use these refs next; do not call page_snapshot unless this says the page is still loading or has no elements):\n' + snap.snapshot;
 }
 } catch (err) {
 text += `\n\n(snapshot after action failed: ${err.message})`;
 }
 }
 return { text };
 } catch (e) {
 return { text: `Error: ${e.message}` };
 }
}

const MAX_TOOL_RESULT_CHARS = 30000;

// ---------------------------------------------------------------------------
// Sliding-window context management
// ---------------------------------------------------------------------------
// Long automations would otherwise fill the model's context window. Before
// every request we build a pruned view: old tool results get truncated, stale
// screenshots dropped, and if still over budget, the oldest step-groups are
// evicted — always keeping the first user message (the task itself).
// `messages` keeps full history; pruning is per-request only.

const msgSize = (m) =>
 (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length) + 40;

// Group an assistant tool_calls message with its tool replies (and any
// injected screenshot message) so eviction never orphans half a pair.
function groupMessages(msgs) {
 const groups = [];
 let i = 0;
 while (i < msgs.length) {
 if (msgs[i].role === 'assistant' && msgs[i].tool_calls?.length) {
 const g = [msgs[i++]];
 while (i < msgs.length && msgs[i].role === 'tool') g.push(msgs[i++]);
 while (i < msgs.length && msgs[i].role === 'user' && Array.isArray(msgs[i].content)) g.push(msgs[i++]);
 groups.push(g);
 } else {
 groups.push([msgs[i++]]);
 }
 }
 return groups;
}

function pruneForContext(msgs, maxChars) {
 const gsize = (g) => g.reduce((s, m) => s + msgSize(m), 0);
 let groups = groupMessages(msgs);
 let total = groups.reduce((s, g) => s + gsize(g), 0);
 if (total <= maxChars) return msgs;

 // Pass 1: shrink bulky tool results and drop screenshots outside the last 3 groups.
 for (let i = 0; i < groups.length - 3 && total > maxChars; i++) {
 groups[i] = groups[i].map((m) => {
 if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 600) {
 total -= m.content.length - 620;
 return { ...m, content: m.content.slice(0, 600) + '\n…[older tool result trimmed]' };
 }
 if (m.role === 'user' && Array.isArray(m.content)) {
 total -= msgSize(m) - 80;
 return { role: 'user', content: '(an older screenshot was removed to save context)' };
 }
 return m;
 });
 }
 if (total <= maxChars) return groups.flat();

 // Pass 2: evict oldest groups, keeping the first user message (the task).
 const firstUserIdx = groups.findIndex((g) => g[0].role === 'user');
 const head = firstUserIdx >= 0 ? groups[firstUserIdx] : [];
 let budget = maxChars - gsize(head) - 120;
 const tail = [];
 let keptFrom = groups.length;
 for (let i = groups.length - 1; i > firstUserIdx; i--) {
 const s = gsize(groups[i]);
 if (budget - s < 0 && tail.length) break;
 budget -= s;
 tail.unshift(...groups[i]);
 keptFrom = i;
 }
 const droppedGroups = keptFrom - firstUserIdx - 1;
 const notice =
 droppedGroups > 0
 ? [{ role: 'user', content: `(context note: ${droppedGroups} earlier steps were removed from view to fit the context window — the original task above still applies, continue from the latest state)` }]
 : [];
 return [...head, ...notice, ...tail];
}

function contextBudgetChars() {
 return (Number(settings.contextTokens) || 32768) * 3;
}

// Only the newest page dump has live refs. Older ones are stale and are what
// make each later model call slow, so keep the action line and drop the page text.
function isPageDump(message) {
 return message?.role === 'tool' && typeof message.content === 'string' && (
 message.content.includes('Fresh snapshot') ||
 message.content.includes('Interactive elements') ||
 message.content.startsWith('Title:')
 );
}

function collapseStalePageDumps() {
 let latest = -1;
 for (let i = messages.length - 1; i >= 0; i--) {
 if (isPageDump(messages[i])) {
 latest = i;
 break;
 }
 }
 if (latest < 0) return;
 for (let i = 0; i < latest; i++) {
 const message = messages[i];
 if (!isPageDump(message) || message.content.length < 500) continue;
 const action = message.content.split('\n\nFresh snapshot')[0].slice(0, 200);
 message.content = `${action}\n[stale page text removed — use the latest snapshot]`;
 }
}

// Tool results from page_snapshot / read_page are stale the moment a newer
// one exists — refs regenerate on every snapshot, so old ones actively
// mislead. Collapse them immediately rather than waiting for budget pressure.
const staleSnapshotIds = new Set();

function supersedeOldSnapshots() {
 for (const m of messages) {
 if (m.role === 'tool' && staleSnapshotIds.has(m.tool_call_id) && typeof m.content === 'string' && m.content.length > 200) {
 m.content = '[superseded by a newer page_snapshot/read_page — any refs from this result are stale]';
 }
 }
}

// On real navigation, compact the whole tool history into a short action log:
// the model keeps WHAT it did (answer consistency) without dead page data.
function flushToolHistory(msgs, newUrl) {
 const kept = [];
 const log = [];
 for (const m of msgs) {
 if (m.role === 'assistant' && m.tool_calls?.length) {
 if (m.content) log.push(`note: ${String(m.content).slice(0, 200)}`);
 for (const tc of m.tool_calls) {
 log.push(`${tc.function.name} ${(tc.function.arguments || '').slice(0, 120)}`);
 }
 } else if (m.role === 'tool') {
 if (typeof m.content === 'string' && m.content.startsWith('Error:')) {
 log.push(` -> ${m.content.slice(0, 120)}`);
 }
 } else if (m.role === 'user' && Array.isArray(m.content)) {
 // drop old screenshots
 } else {
 kept.push(m); // user text, prior flush logs, assistant answers
 }
 }
 if (log.length) {
 kept.push({
 role: 'user',
 content:
      `(context flush — the page navigated to ${newUrl}. Actions completed before the flush:\n` +
 log.map((l) => `- ${l}`).join('\n') +
 '\nAll old refs and snapshots are gone. Take a fresh page_snapshot if you need to continue.)',
 });
 }
 return kept;
}

// Reasoning models (Qwen3, DeepSeek-R1, ...) return their chain of thought in
// reasoning_content / reasoning, or inline tags — sometimes with an
// empty final answer. Separate the two so we never show a blank turn, and
// never resend bulky thinking text back to the model.
function extractContent(msg) {
 let content = typeof msg.content === 'string' ? msg.content : '';
 let reasoning = msg.reasoning_content || msg.reasoning || '';
 if (content.includes(' ')) {
 const inline = content.match(/ ([\s\S]*?)(<\/think>|$)/);
 if (inline) reasoning = reasoning || inline[1].trim();
 content = content.replace(/ [\s\S]*?(<\/think>|$)/g, '');
 }
 return { content: content.trim(), reasoning: String(reasoning).trim() };
}

// When the server's tool-call parser doesn't match the model (e.g. a Qwen
// parser left set while running Nemotron/Llama), structured tool_calls never
// arrive — the model's call leaks into content as text. Recover the common
// formats so tool use works regardless of server parser config.
const toolNames = new Set(TOOLS.map((t) => t.name));
let inlineParserWarned = false;

function coerceCall(name, rawArgs) {
 if (!name || !toolNames.has(name)) return null;
 let args = rawArgs;
 if (args != null && typeof args !== 'string') args = JSON.stringify(args);
 return { id: `inline_${Math.floor(performance.now())}_${name}`, type: 'function', function: { name, arguments: args || '{}' } };
}

function recoverInlineToolCalls(content) {
 if (!content) return [];
 const found = [];
 const tryPush = (n, a) => { const c = coerceCall(n, a); if (c) found.push(c); };

 // [ {...} ] or <tool_call>{...}</tool_call> (Nemotron, Hermes, Qwen)
 for (const m of content.matchAll(/<\s*(?:tool_?call|TOOLCALL)\s*>([\s\S]*?)<\s*\/\s*(?:tool_?call|TOOLCALL)\s*>/gi)) {
 parseJsonCalls(m[1], tryPush);
 }
 // Llama 3.1 functools: <function=name>{...} or <function=name>{...}
 for (const m of content.matchAll(/<function\s*=\s*([\w-]+)\s*>([\s\S]*?)(?:<\/function>|$)/gi)) {
 tryPush(m[1], m[2].trim());
 }
 // Python-ish: name({...}) — only for our known tool names
 if (!found.length) {
 for (const m of content.matchAll(/\b([a-z_]+)\s*\(\s*(\{[\s\S]*?\})\s*\)/g)) {
 if (toolNames.has(m[1])) tryPush(m[1], m[2]);
 }
 }
 // Bare JSON object/array that is the whole message: {"name":...,"arguments":...}
 if (!found.length) {
 const trimmed = content.trim();
 if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 4000) {
 parseJsonCalls(trimmed, tryPush);
 }
 }
 return found;
}

function parseJsonCalls(text, push) {
 let obj;
 try {
 obj = JSON.parse(text.trim());
 } catch {
 return;
 }
 const arr = Array.isArray(obj) ? obj : [obj];
 for (const o of arr) {
 if (!o || typeof o !== 'object') continue;
 const name = o.name || o.tool || o.function?.name;
 const a = o.arguments ?? o.parameters ?? o.args ?? o.function?.arguments;
 push(name, a);
 }
}

const OBSERVE_TOOLS = new Set(['page_snapshot', 'read_page', 'wait', 'screenshot']);

function normalizeLabel(s) {
 return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseSnapshotLabels(text) {
 const map = new Map();
 if (!text) return map;
 for (const m of String(text).matchAll(/\[((?:f\d+_)?e\d+)\][^\n]*?"([^"]+)"/g)) {
 map.set(m[1], normalizeLabel(m[2]));
 }
 return map;
}

function repeatedLabelNote(text) {
 const counts = new Map();
 for (const label of parseSnapshotLabels(text).values()) {
 counts.set(label, (counts.get(label) || 0) + 1);
 }
 const repeats = [...counts.entries()].filter(([, n]) => n >= 3).slice(0, 6);
 if (!repeats.length) return '';
 return (
 '\n\n(note: ' +
 repeats.map(([l, n]) => `"${l}" ×${n}`).join('; ') +
 '. Filters are done. Click the first of these now and move on. Do not hesitate about whether to click.)'
 );
}

function parseToolArgs(tc) {
 try {
 return JSON.parse(tc.function.arguments || '{}');
 } catch {
 return {};
 }
}

let turnAbort = null;

function stopForFinish(toolCalls) {
 let summary = '';
 for (const tc of toolCalls) {
 if (tc.function.name !== 'finish') {
 messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Skipped: the task is stopping.' });
 continue;
 }
 const args = parseToolArgs(tc);
 summary = tidyAssistantText(args.message || args.summary || '') || summary;
 addToolLine('finish', { status: args.status || 'done' });
 messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Stopped.' });
 }
 const asking = toolCalls.some((tc) => tc.function.name === 'finish' && parseToolArgs(tc).status === 'ask');
 addBubble('assistant', summary || (asking ? '需要你确认后才能继续。' : '任务已结束。'));
}

async function chatTurn(signal) {
 const system = { role: 'system', content: await buildSystemPrompt() };
 let turnUrl = null;
 try {
 turnUrl = (await browserCommand('get_url')).url;
 } catch {
 /* no active tab */
 }

 let lastModel = null;
 for (;;) {
 throwIfAborted(signal);
 collapseStalePageDumps();
 const sent = [system, ...pruneForContext(messages, contextBudgetChars())];
 const model = pickModel(sent);
 if (model !== lastModel) {
 renderToolLine(`↗ model: ${model}${requestHasImage(sent) ? ' (vision)' : ''}`);
 lastModel = model;
 }
 const body = { model, messages: sent };
 if (settings.toolsEnabled) {
 body.tools = toolDefs();
 body.tool_choice = 'auto';
 }
 setThinking(true);
 let msg;
 try {
 msg = await callLLM(body, signal);
 } finally {
 setThinking(false);
 }
 let { content, reasoning } = extractContent(msg);

 // Server parser missed the tool calls? Recover them from the text.
 let toolCalls = msg.tool_calls;
 if (settings.toolsEnabled && !toolCalls?.length) {
 const recovered = recoverInlineToolCalls(content);
 if (recovered.length) {
 toolCalls = recovered;
 content = ''; // the "content" was just the tool-call markup
 if (!inlineParserWarned) {
 inlineParserWarned = true;
 addBubble('error', 'Heads-up: your model emitted tool calls as text and the server did not parse them — browser-use recovered them client-side. For reliability, set your server\'s tool-call parser to match this model (see console). This message shows once per session.');
 console.warn(
 '[browser-use] Recovered tool calls from text. Your OpenAI server is not parsing this model\'s tool-call format.\n' +
 'vLLM: start with --enable-auto-tool-choice and a --tool-call-parser matching the model:\n' +
 ' • Llama / Nemotron (Llama-based): llama3_json\n' +
 ' • Qwen: qwen3_coder (or hermes)\n' +
 ' • Mistral: mistral\n' +
 'You likely still have qwen3_coder set from the previous model.'
 );
 }
 }
 }

 // Store only the clean answer: strict servers reject null content, and
 // resending blocks burns context for nothing.
 messages.push({
 ...msg,
 content: toolCalls?.length ? '' : content,
 tool_calls: toolCalls,
 reasoning_content: undefined,
 reasoning: undefined,
 });

 if (toolCalls?.length) {
 if (toolCalls.some((tc) => tc.function.name === 'finish')) {
 stopForFinish(toolCalls);
 return;
 }
 if (toolCalls.some((tc) => tc.function.name === 'page_snapshot')) {
 toolCalls = toolCalls.filter((tc) => tc.function.name !== 'wait');
 }
 const onlyObserve = toolCalls.every((tc) => OBSERVE_TOOLS.has(tc.function.name));
 if (onlyObserve) {
 const spokenClick = [...String(content || '').matchAll(/\b((?:f\d+_)?e\d+)\b/gi)].map((m) => m[1]);
 if (/点击|click|选择/i.test(content || '') && spokenClick.length) {
 const extra = coerceCall('click', { ref: spokenClick[0] });
 if (extra) toolCalls = [...toolCalls, extra];
 }
 }
 if (content) addBubble('assistant', content);

 for (const tc of toolCalls) {
 throwIfAborted(signal);
 const result = await runTool(tc);
 if (tc.function.name === 'page_snapshot' || tc.function.name === 'read_page') {
 supersedeOldSnapshots();
 staleSnapshotIds.add(tc.id);
 }
 let toolText = result.text;
 if (tc.function.name === 'page_snapshot') toolText += repeatedLabelNote(result.text);
 messages.push({ role: 'tool', tool_call_id: tc.id, content: toolText.slice(0, MAX_TOOL_RESULT_CHARS) });
 if (result.imageDataUrl) {
 // Only the newest screenshot stays in history — older ones are
 // huge and describe stale page states.
 for (let j = 0; j < messages.length; j++) {
 if (messages[j].role === 'user' && Array.isArray(messages[j].content)) {
 messages[j] = { role: 'user', content: '(an older screenshot was removed to save context)' };
 }
 }
 messages.push({
 role: 'user',
 content: [
 { type: 'text', text: '(screenshot of the current page)' },
 { type: 'image_url', image_url: { url: result.imageDataUrl } },
 ],
 });
 }
 }
 // Page navigated? Compact the tool history into an action log.
 if (settings.flushOnNavigate !== false) {
 try {
 const cur = await browserCommand('get_url');
 if (turnUrl && cur.url !== turnUrl) {
 messages = flushToolHistory(messages, cur.url);
 saveChat();
 }
 turnUrl = cur.url;
 } catch {
 /* tab gone or restricted — skip flush this round */
 }
 }
 continue;
 }
 const truncated = msg.__finishReason === 'length';
 if (content) {
 addBubble('assistant', content);
 } else if (reasoning && !truncated) {
 addBubble('assistant', reasoning);
 } else if (reasoning) {
 addBubble('assistant', `*(the model was cut off mid-thought — its last reasoning below)*\n\n${reasoning.slice(-1200)}`);
 } else {
 addBubble('error', 'The model returned an empty response (no content, no reasoning).');
 }
 return;
 }
}

function setStopIdle() {
 stopBtn.classList.remove('loading');
 stopBtn.disabled = false;
 stopBtn.removeAttribute('aria-busy');
}

function setSendIdle() {
 sendBtn.classList.remove('hidden');
 stopBtn.classList.add('hidden');
 setStopIdle();
}

function setSendBusy() {
 sendBtn.classList.add('hidden');
 stopBtn.classList.remove('hidden');
 setStopIdle();
}

function setStopLoading() {
 stopBtn.classList.add('loading');
 stopBtn.disabled = true;
 stopBtn.setAttribute('aria-busy', 'true');
}

function stopTurn() {
 if (!busy || stopBtn.classList.contains('loading')) return;
 setStopLoading();
 turnAbort?.abort();
}

async function send() {
 if (busy) return;
 const text = inputEl.value.trim();
 if (!text) return;
 if (!anyModelConfigured()) {
 addBubble('error', '还没有可用的模型。在侧边栏齿轮里填写接口地址和模型名称。');
 return;
 }
 inputEl.value = '';
 try {
 await browserCommand('pin_session');
 } catch {
 /* no tab yet */
 }
 const ac = new AbortController();
 turnAbort = ac;
 busy = true;
 setSendBusy();
 addBubble('user', text);

 if (!settings.toolsEnabled) {
 // Tools off: include the page text directly so the model still has context.
 let pageContext = '';
 try {
 const page = await browserCommand('read_page');
 pageContext = `\n\n[Current page: ${page.title} — ${page.url}]\n${page.text.slice(0, 20000)}`;
 } catch {
 /* restricted page or no tab */
 }
 messages.push({ role: 'user', content: text + pageContext });
 } else {
 messages.push({ role: 'user', content: text });
 }

 try {
 await chatTurn(ac.signal);
 } catch (e) {
 if (e.name !== 'AbortError' && e.message !== 'aborted') addBubble('error', e.message);
 } finally {
 if (turnAbort === ac) {
 busy = false;
 turnAbort = null;
 setSendIdle();
 }
 saveChat();
 inputEl.focus();
 }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', stopTurn);
inputEl.addEventListener('keydown', (e) => {
 if (e.key === 'Enter' && !e.shiftKey) {
 e.preventDefault();
 send();
 }
});

$('config-btn').addEventListener('click', async () => {
 const panel = $('llm-config');
 const opening = panel.classList.contains('hidden');
 panel.classList.toggle('hidden');
 if (opening) await loadSettings();
});
$('cfg-save').addEventListener('click', saveLlmConfig);

$('clear-btn').addEventListener('click', () => {
 messages = [];
 transcript = [];
 chrome.storage.session.remove('chat').catch(() => {});
 messagesEl.innerHTML = '';
 addBubble('assistant', 'New conversation started.');
});

$('settings-btn')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open-settings-link')?.addEventListener('click', (e) => {
 e.preventDefault();
 chrome.runtime.openOptionsPage();
});

const LLM_CONFIG_DEFAULTS = { llmBaseUrl: '', llmApiKey: '', llmModel: '' };

async function readLlmConfig() {
 try {
 return await chrome.storage.local.get(LLM_CONFIG_DEFAULTS);
 } catch {
 return { ...LLM_CONFIG_DEFAULTS };
 }
}

function formValues() {
 return {
 baseUrl: $('cfg-base').value.trim().replace(/\/$/, ''),
 apiKey: $('cfg-key').value.trim(),
 model: $('cfg-model').value.trim(),
 };
}

function applyConfigForm() {
 $('cfg-base').value = settings.baseUrl || '';
 $('cfg-key').value = settings.apiKey || '';
 $('cfg-model').value = settings.model || '';
 const btn = $('cfg-save');
 btn.textContent = '确认';
 btn.disabled = false;
}

async function loadSettings() {
 const stored = await readLlmConfig();
 settings.baseUrl = stored.llmBaseUrl || '';
 settings.apiKey = stored.llmApiKey || '';
 settings.model = stored.llmModel || '';
 settings.modelLarge = settings.model;
 settings.useEnvKey = false;
 settings.toolsEnabled = true;
 $('model-name').textContent = settings.model || '未配置模型';
 applyConfigForm();
}

async function saveLlmConfig() {
 const cur = formValues();
 try {
 await chrome.storage.local.set({
 llmBaseUrl: cur.baseUrl,
 llmApiKey: cur.apiKey,
 llmModel: cur.model,
 });
 } catch {
 $('cfg-status').textContent = '无法保存';
 return;
 }
 settings.baseUrl = cur.baseUrl;
 settings.apiKey = cur.apiKey;
 settings.model = cur.model;
 settings.modelLarge = cur.model;
 $('model-name').textContent = settings.model || '未配置模型';
 $('llm-config').classList.add('hidden');
}

async function refreshBridgeDot() {
 try {
 const { connected } = await browserCommand('bridge_status');
 $('bridge-dot').classList.toggle('on', connected);
 $('bridge-dot').title = connected ? 'MCP bridge: connected' : 'MCP bridge: not connected (start the mcp-server)';
 } catch {
 /* background not ready yet */
 }
}

loadSettings();
restoreChat();
refreshBridgeDot();
setInterval(refreshBridgeDot, 5000);
