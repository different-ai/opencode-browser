const PLUGIN_URL = "ws://localhost:19222";
const KEEPALIVE_ALARM = "keepalive";

let ws = null;
let isConnected = false;
let connectionAttempts = 0;

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!isConnected) {
      console.log("[OpenCode] Alarm triggered reconnect");
      connect();
    }
  }
});

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  
  try {
    ws = new WebSocket(PLUGIN_URL);
    
    ws.onopen = () => {
      console.log("[OpenCode] Connected to MCP server");
      isConnected = true;
      connectionAttempts = 0;
      updateBadge(true);
    };
    
    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await handleMessage(message);
      } catch (e) {
        console.error("[OpenCode] Parse error:", e);
      }
    };
    
    ws.onclose = () => {
      if (isConnected) {
        console.log("[OpenCode] Disconnected from MCP server");
      }
      isConnected = false;
      ws = null;
      updateBadge(false);
    };
    
    ws.onerror = () => {
      connectionAttempts++;
      // Only log first attempt and then every 20th attempt (5 minutes)
      if (connectionAttempts === 1) {
        console.log("[OpenCode] Waiting for MCP server on port 19222...");
      } else if (connectionAttempts % 20 === 0) {
        console.log("[OpenCode] Still waiting for MCP server... (use browser tools in OpenCode to start it)");
      }
      isConnected = false;
      updateBadge(false);
    };
  } catch (e) {
    console.error("[OpenCode] Connect failed:", e);
    isConnected = false;
    updateBadge(false);
  }
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#22c55e" : "#ef4444" });
}

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

async function handleMessage(message) {
  if (message.type === "tool_request") {
    await handleToolRequest(message);
  } else if (message.type === "ping") {
    send({ type: "pong" });
  }
}

async function handleToolRequest(request) {
  const { id, tool, args } = request;
  
  try {
    const result = await executeTool(tool, args || {});
    send({ type: "tool_response", id, result: { content: result } });
  } catch (error) {
    send({ type: "tool_response", id, error: { content: error.message || String(error) } });
  }
}

async function executeTool(toolName, args) {
  const tools = {
    navigate: toolNavigate,
    click: toolClick,
    type: toolType,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    get_tabs: toolGetTabs,
    execute_script: toolExecuteScript,
    scroll: toolScroll,
    wait: toolWait
  };
  
  const fn = tools[toolName];
  if (!fn) throw new Error(`Unknown tool: ${toolName}`);
  return await fn(args);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

async function getTabById(tabId) {
  return tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required");
  const tab = await getTabById(tabId);
  await chrome.tabs.update(tab.id, { url });
  
  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
  });
  
  return `Navigated to ${url}`;
}

async function toolClick({ selector, tabId }) {
  if (!selector) throw new Error("Selector is required");
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: `Element not found: ${sel}` };
      el.click();
      return { success: true };
    },
    args: [selector]
  });
  
  if (!result[0]?.result?.success) throw new Error(result[0]?.result?.error || "Click failed");
  return `Clicked ${selector}`;
}

async function toolType({ selector, text, tabId, clear = false }) {
  if (!selector) throw new Error("Selector is required");
  if (text === undefined) throw new Error("Text is required");
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt, shouldClear) => {
      const el = document.querySelector(sel);
      if (!el) return { success: false, error: `Element not found: ${sel}` };
      el.focus();
      if (shouldClear) el.value = "";
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.value = el.value + txt;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        document.execCommand("insertText", false, txt);
      }
      return { success: true };
    },
    args: [selector, text, clear]
  });
  
  if (!result[0]?.result?.success) throw new Error(result[0]?.result?.error || "Type failed");
  return `Typed "${text}" into ${selector}`;
}

async function toolScreenshot({ tabId }) {
  const tab = await getTabById(tabId);
  return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function getName(el) {
        return el.getAttribute("aria-label") || el.getAttribute("alt") || 
               el.getAttribute("title") || el.getAttribute("placeholder") || 
               el.innerText?.slice(0, 100) || "";
      }
      
      function build(el, depth = 0, uid = 0) {
        if (depth > 10) return { nodes: [], nextUid: uid };
        const nodes = [];
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return { nodes: [], nextUid: uid };
        
        const isInteractive = ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
                              el.getAttribute("onclick") || el.getAttribute("role") === "button" || el.isContentEditable;
        const rect = el.getBoundingClientRect();
        
        if (rect.width > 0 && rect.height > 0 && (isInteractive || el.innerText?.trim())) {
          const node = { uid: `e${uid}`, role: el.getAttribute("role") || el.tagName.toLowerCase(), 
                        name: getName(el).slice(0, 200), tag: el.tagName.toLowerCase() };
          // Capture href for any element that has one (links, area, base, etc.)
          if (el.href) node.href = el.href;
          if (el.tagName === "INPUT") { node.type = el.type; node.value = el.value; }
          if (el.id) node.selector = `#${el.id}`;
          else if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".");
            if (cls) node.selector = `${el.tagName.toLowerCase()}.${cls}`;
          }
          nodes.push(node);
          uid++;
        }
        
        for (const child of el.children) {
          const r = build(child, depth + 1, uid);
          nodes.push(...r.nodes);
          uid = r.nextUid;
        }
        return { nodes, nextUid: uid };
      }
      
      // Collect all links on the page separately for easy access
      function getAllLinks() {
        const links = [];
        const seen = new Set();
        document.querySelectorAll("a[href]").forEach(a => {
          const href = a.href;
          if (href && !seen.has(href) && !href.startsWith("javascript:")) {
            seen.add(href);
            const text = a.innerText?.trim().slice(0, 100) || a.getAttribute("aria-label") || "";
            links.push({ href, text });
          }
        });
        return links.slice(0, 100); // Limit to 100 links
      }
      
      return { 
        url: location.href, 
        title: document.title, 
        nodes: build(document.body).nodes.slice(0, 500),
        links: getAllLinks()
      };
    }
  });
  
  return JSON.stringify(result[0]?.result, null, 2);
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({});
  return JSON.stringify(tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })), null, 2);
}

async function toolExecuteScript({ code, tabId }) {
  if (!code) throw new Error("Code is required");
  const tab = await getTabById(tabId);
  const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: new Function(code) });
  return JSON.stringify(result[0]?.result);
}

async function toolScroll({ x = 0, y = 0, selector, tabId }) {
  const tab = await getTabById(tabId);
  const sel = selector || null;
  
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (scrollX, scrollY, sel) => {
      if (sel) { const el = document.querySelector(sel); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); return; } }
      window.scrollBy(scrollX, scrollY);
    },
    args: [x, y, sel]
  });
  
  return `Scrolled ${sel ? `to ${sel}` : `by (${x}, ${y})`}`;
}

async function toolWait({ ms = 1000 }) {
  await new Promise(resolve => setTimeout(resolve, ms));
  return `Waited ${ms}ms`;
}

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.action.onClicked.addListener(() => {
  connect();
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "OpenCode Browser", 
    message: isConnected ? "Connected" : "Reconnecting..." });
});

connect();
