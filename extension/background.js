// Background service worker.
// 1. Maintains a WebSocket connection to the local MCP bridge server (Mode 1).
// 2. Routes commands (from the bridge OR the side panel) to the browser / content script.

const DEFAULTS = { mcpPort: 8765 };
const RESTRICTED_URL = /^(chrome|chrome-extension|edge|brave|about|devtools|view-source):/;

let ws = null;
let wsConnected = false;
let connecting = false;
// Tab the user had when they published a task. Never replace it with another site or close it.
let originTabId = null;
// Tab the agent is operating on (origin, or a tab it opened).
let workTabId = null;

// ---------------------------------------------------------------------------
// WebSocket bridge to the local MCP server
// ---------------------------------------------------------------------------

async function connectBridge() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  try {
    let socket;
    try {
      const { mcpPort } = await chrome.storage.sync.get(DEFAULTS);
      socket = new WebSocket(`ws://127.0.0.1:${mcpPort}/extension`);
    } catch {
      ws = null;
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      wsConnected = true;
      setBadge(true);
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      wsConnected = false;
      ws = null;
      setBadge(false);
      setTimeout(connectBridge, 3000);
    };

    socket.onerror = () => {
      /* onclose fires next; reconnect handled there */
    };

    socket.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
        return;
      }
      if (msg.type !== 'command') return;
      let reply;
      try {
        const data = await handleCommand(msg.name, msg.args || {});
        reply = { type: 'result', id: msg.id, ok: true, data };
      } catch (e) {
        reply = { type: 'result', id: msg.id, ok: false, error: String(e?.message || e) };
      }
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
      } catch {
        /* socket died mid-command */
      }
    };
  } finally {
    connecting = false;
  }
}

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'MCP' : '' });
  if (connected) {
    chrome.action.setBadgeBackgroundColor({ color: '#5dba6f' });
    chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
}

// Alarms revive the service worker if Chrome puts it to sleep.
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge-keepalive') connectBridge();
});
chrome.runtime.onStartup.addListener(connectBridge);
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  connectBridge();
});
connectBridge();

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function tabAlive(id) {
  if (id == null) return false;
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}

async function getForegroundTab() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

async function getActiveTab() {
  if (await tabAlive(workTabId)) return chrome.tabs.get(workTabId);
  return getForegroundTab();
}

function isEmptyOrRestrictedUrl(url) {
  return !url || RESTRICTED_URL.test(url);
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

chrome.tabs.onRemoved.addListener((id) => {
  if (workTabId === id) workTabId = originTabId;
  if (originTabId === id) originTabId = null;
});

function assertScriptable(tab) {
  if (!tab.url || RESTRICTED_URL.test(tab.url)) {
    throw new Error(`Cannot operate on restricted page: ${tab.url || '(unknown)'}. Navigate to a normal web page first.`);
  }
}

async function sendToContent(tabId, name, args, frameId = 0) {
  const message = { __agent: true, name, args };
  const options = { frameId };
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    // Content script not present (page loaded before install, etc.) — inject and retry.
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] });
    res = await chrome.tabs.sendMessage(tabId, message, options);
  }
  if (!res) throw new Error('No response from page');
  if (!res.ok) throw new Error(res.error || 'Page action failed');
  return res.data;
}

// Survey sites and many web apps render the real content inside cross-origin
// iframes — enumerate every frame we can reach so snapshots and actions see
// inside them. Refs from non-top frames are prefixed (f123_e4) and routed back
// to their frame automatically.
const MAX_FRAMES = 12;

async function listFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    });
    const frames = results
      .filter((r) => r.frameId != null)
      .map((r) => ({ frameId: r.frameId, url: r.result }));
    frames.sort((a, b) => a.frameId - b.frameId); // top frame (0) first
    return frames.length ? frames : [{ frameId: 0, url: null }];
  } catch {
    return [{ frameId: 0, url: null }];
  }
}

function frameIdForRef(ref) {
  const m = /^f(\d+)_/.exec(ref || '');
  return m ? Number(m[1]) : 0;
}

function waitForLoad(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(finish, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    }
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch(finish);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOUSE_BUTTONS = ['left', 'middle', 'right'];

// Scripted element.click() is ignored by sites like Ctrip. Debugger input is a
// real browser click (isTrusted), so the page's own handler runs.
async function trustedClick(tabId, x, y, buttonIndex = 0) {
  const target = { tabId };
  const button = MOUSE_BUTTONS[buttonIndex] || 'left';
  let attachedHere = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attachedHere = true;
  } catch (e) {
    if (!/already attached/i.test(String(e?.message || e))) throw e;
  }
  try {
    const press = { type: 'mousePressed', x, y, button, clickCount: 1 };
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', press);
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...press, type: 'mouseReleased' });
  } finally {
    if (attachedHere) {
      try { await chrome.debugger.detach(target); } catch { /* already gone */ }
    }
  }
}

async function frameOffset(tabId, frameId) {
  if (!frameId) return { x: 0, y: 0 };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const el = window.frameElement;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top };
      },
    });
    const hit = results.find((r) => r.frameId === frameId);
    if (hit?.result) return hit.result;
  } catch { /* cross-origin frame has no frameElement */ }
  return { x: 0, y: 0 };
}

// After a real click, follow a same-tab navigation or a tab the click opened
// so the next snapshot is the destination, not the list we just left.
async function trustedClickAndSettle(tabId, x, y, buttonIndex = 0) {
  const before = await chrome.tabs.get(tabId);
  let spawned = null;
  const onCreated = (tab) => {
    if (tab.windowId === before.windowId) spawned = tab;
  };
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    await trustedClick(tabId, x, y, buttonIndex);
    await sleep(300);
  } catch (e) {
    chrome.tabs.onCreated.removeListener(onCreated);
    throw e;
  }
  chrome.tabs.onCreated.removeListener(onCreated);
  if (spawned?.id) {
    workTabId = spawned.id;
    await chrome.tabs.update(spawned.id, { active: true });
    await waitForLoad(spawned.id, 4000);
    const updated = await chrome.tabs.get(spawned.id);
    return { opened: 'new_tab', url: updated.url, title: updated.title };
  }
  let mid;
  try { mid = await chrome.tabs.get(tabId); } catch { return { opened: 'none' }; }
  if (mid.status === 'loading' || mid.url !== before.url) {
    await waitForLoad(tabId, 4000);
    const updated = await chrome.tabs.get(tabId);
    return { opened: updated.url !== before.url ? 'same_tab' : 'updated', url: updated.url, title: updated.title };
  }
  return { opened: 'none', url: mid.url, title: mid.title };
}

async function normalizeScreenshot(dataUrl, viewport, format) {
  if (!viewport?.width) return dataUrl;
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = bitmap.width / viewport.width;
  if (Math.abs(scale - 1) <= 0.02) return dataUrl;
  const canvas = new OffscreenCanvas(viewport.width, viewport.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, viewport.width, viewport.height);
  const out = await canvas.convertToBlob(
    format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.8 }
  );
  const bytes = new Uint8Array(await out.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${out.type};base64,${btoa(binary)}`;
}

async function handleCommand(name, args) {
  switch (name) {
    case 'screenshot': {
      const tab = await getActiveTab();
      const format = args.format === 'png' ? 'png' : 'jpeg';
      const opts = format === 'png' ? { format } : { format, quality: args.quality ?? 80 };
      let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
      // captureVisibleTab returns physical pixels; clicks use CSS pixels.
      // Downscale so image coordinates map 1:1 to click x/y (handles display
      // scaling and page zoom).
      let viewport = null;
      try {
        viewport = await sendToContent(tab.id, 'viewport', {});
        dataUrl = await normalizeScreenshot(dataUrl, viewport, format);
      } catch {
        /* restricted page — return the raw capture */
      }
      return { dataUrl, url: tab.url, title: tab.title, width: viewport?.width, height: viewport?.height };
    }

    case 'pin_session': {
      const tab = await getForegroundTab();
      originTabId = tab.id;
      workTabId = tab.id;
      return { url: tab.url, title: tab.title, tabId: tab.id };
    }

    case 'navigate': {
      if (!args.url) throw new Error('url is required');
      const url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`;
      const tab = await getActiveTab();
      const stay = isEmptyOrRestrictedUrl(tab.url) || sameOrigin(tab.url, url);
      if (!stay) {
        const created = await chrome.tabs.create({ url, active: true });
        workTabId = created.id;
        await waitForLoad(created.id);
        const updated = await chrome.tabs.get(created.id);
        return { url: updated.url, title: updated.title, opened: 'new_tab' };
      }
      await chrome.tabs.update(tab.id, { url });
      workTabId = tab.id;
      await waitForLoad(tab.id);
      const updated = await chrome.tabs.get(tab.id);
      return { url: updated.url, title: updated.title, opened: 'same_tab' };
    }

    case 'go_back': {
      const tab = await getActiveTab();
      await chrome.tabs.goBack(tab.id);
      await waitForLoad(tab.id, 10000);
      const updated = await chrome.tabs.get(tab.id);
      return { url: updated.url, title: updated.title };
    }

    case 'go_forward': {
      const tab = await getActiveTab();
      await chrome.tabs.goForward(tab.id);
      await waitForLoad(tab.id, 10000);
      const updated = await chrome.tabs.get(tab.id);
      return { url: updated.url, title: updated.title };
    }

    case 'reload': {
      const tab = await getActiveTab();
      await chrome.tabs.reload(tab.id);
      await waitForLoad(tab.id);
      return { url: tab.url };
    }

    case 'get_url': {
      const tab = await getActiveTab();
      return { url: tab.url, title: tab.title };
    }

    case 'tabs_list': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return {
        tabs: tabs.map((t, i) => ({
          index: i,
          id: t.id,
          active: t.active,
          title: t.title,
          url: t.url,
        })),
      };
    }

    case 'tab_select': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tab = args.id != null ? tabs.find((t) => t.id === args.id) : tabs[args.index];
      if (!tab) throw new Error('Tab not found');
      await chrome.tabs.update(tab.id, { active: true });
      workTabId = tab.id;
      return { url: tab.url, title: tab.title };
    }

    case 'tab_new': {
      const url = args.url
        ? (/^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`)
        : 'about:blank';
      const tab = await chrome.tabs.create({ url, active: true });
      workTabId = tab.id;
      if (args.url) await waitForLoad(tab.id);
      const updated = await chrome.tabs.get(tab.id);
      return { url: updated.url, title: updated.title };
    }

    case 'tab_close': {
      const tab = await getActiveTab();
      if (tab.id === originTabId) {
        throw new Error('Refusing to close the tab the user started from.');
      }
      await chrome.tabs.remove(tab.id);
      workTabId = (await tabAlive(originTabId)) ? originTabId : null;
      return { closed: true };
    }

    case 'wait': {
      const seconds = Math.min(Math.max(Number(args.seconds) || 0.5, 0), 1);
      await sleep(seconds * 1000);
      return { waited: seconds };
    }

    case 'snapshot': {
      const tab = await getActiveTab();
      assertScriptable(tab);
      const frames = await listFrames(tab.id);
      const parts = [];
      let total = 0;
      for (const f of frames.slice(0, MAX_FRAMES)) {
        const prefix = f.frameId === 0 ? '' : `f${f.frameId}_`;
        try {
          const { snapshot, count } = await sendToContent(tab.id, 'snapshot', { refPrefix: prefix }, f.frameId);
          if (f.frameId === 0) {
            parts.unshift(snapshot);
            total += count;
          } else if (count > 0) {
            parts.push(`--- iframe (${f.url || 'embedded frame'}) — refs prefixed "${prefix}", use them exactly like top-frame refs ---\n${snapshot}`);
            total += count;
          }
        } catch {
          /* frame not reachable (sandboxed, navigating, etc.) */
        }
      }
      if (total === 0) {
        parts.push('No interactive elements found in any frame. The content may still be loading — try browser_wait then snapshot again.');
      }
      return { snapshot: parts.join('\n\n'), count: total };
    }

    case 'read_page': {
      const tab = await getActiveTab();
      assertScriptable(tab);
      const frames = await listFrames(tab.id);
      let main = null;
      const extras = [];
      for (const f of frames.slice(0, MAX_FRAMES)) {
        try {
          const data = await sendToContent(tab.id, 'read_page', {}, f.frameId);
          if (f.frameId === 0) main = data;
          else if (data.text && data.text.trim().length > 40) {
            extras.push(`--- iframe content (${data.url}) ---\n${data.text}`);
          }
        } catch {
          /* frame not reachable */
        }
      }
      if (!main) main = { title: tab.title, url: tab.url, text: '' };
      if (extras.length) main.text = `${main.text}\n\n${extras.join('\n\n')}`.slice(0, 60000);
      return main;
    }

    case 'click': {
      const tab = await getActiveTab();
      assertScriptable(tab);
      const frameId = frameIdForRef(args?.ref);
      const point = await sendToContent(tab.id, 'click_point', args, frameId);
      const offset = await frameOffset(tab.id, frameId);
      const x = point.x + offset.x;
      const y = point.y + offset.y;
      try {
        const settled = await trustedClickAndSettle(tab.id, x, y, args?.button || 0);
        return { ...point, x, y, trusted: true, ...settled };
      } catch {
        const data = await sendToContent(tab.id, 'click', args, frameId);
        return { ...data, trusted: false, opened: 'none' };
      }
    }

    // Page actions: refs carry their frame (f123_e4); everything else hits the top frame.
    case 'hover':
    case 'type':
    case 'press_key':
    case 'scroll': {
      const tab = await getActiveTab();
      assertScriptable(tab);
      return await sendToContent(tab.id, name, args, frameIdForRef(args?.ref));
    }

    case 'bridge_status':
      return { connected: wsConnected };

    default:
      throw new Error(`Unknown command: ${name}`);
  }
}

// Side panel (Mode 2) uses the same command set via runtime messaging.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__panelCommand) return;
  handleCommand(msg.__panelCommand, msg.args || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
