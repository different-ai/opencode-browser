// OpenCode Browser Automation - Background Service Worker
// Native Messaging Host: com.opencode.browser_automation

const NATIVE_HOST_NAME = "com.opencode.browser_automation";

let nativePort = null;
let isConnected = false;

// ============================================================================
// Native Messaging Connection
// ============================================================================

async function connectToNativeHost() {
  if (nativePort) {
    return true;
  }

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    
    nativePort.onMessage.addListener(handleNativeMessage);
    
    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      console.log("[OpenCode] Native host disconnected:", error);
      nativePort = null;
      isConnected = false;
    });

    // Ping to verify connection
    const connected = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      
      const pingHandler = (msg) => {
        if (msg.type === "pong") {
          clearTimeout(timeout);
          nativePort.onMessage.removeListener(pingHandler);
          resolve(true);
        }
      };
      
      nativePort.onMessage.addListener(pingHandler);
      nativePort.postMessage({ type: "ping" });
    });

    if (connected) {
      isConnected = true;
      console.log("[OpenCode] Connected to native host");
      return true;
    } else {
      nativePort.disconnect();
      nativePort = null;
      return false;
    }
  } catch (error) {
    console.error("[OpenCode] Failed to connect:", error);
    nativePort = null;
    return false;
  }
}

function disconnectNativeHost() {
  if (nativePort) {
    nativePort.disconnect();
    nativePort = null;
    isConnected = false;
  }
}

// ============================================================================
// Message Handling from Native Host
// ============================================================================

async function handleNativeMessage(message) {
  console.log("[OpenCode] Received from native:", message.type);

  switch (message.type) {
    case "tool_request":
      await handleToolRequest(message);
      break;
    case "ping":
      sendToNative({ type: "pong" });
      break;
    case "get_status":
      sendToNative({ 
        type: "status_response", 
        connected: isConnected,
        version: chrome.runtime.getManifest().version
      });
      break;
  }
}

function sendToNative(message) {
  if (nativePort) {
    nativePort.postMessage(message);
  } else {
    console.error("[OpenCode] Cannot send - not connected");
  }
}

// ============================================================================
// Tool Execution
// ============================================================================

async function handleToolRequest(request) {
  const { id, tool, args } = request;
  
  try {
    const result = await executeTool(tool, args || {});
    sendToNative({
      type: "tool_response",
      id,
      result: { content: result }
    });
  } catch (error) {
    sendToNative({
      type: "tool_response",
      id,
      error: { content: error.message || String(error) }
    });
  }
}

async function executeTool(toolName, args) {
  switch (toolName) {
    case "navigate":
      return await toolNavigate(args);
    case "click":
      return await toolClick(args);
    case "type":
      return await toolType(args);
    case "screenshot":
      return await toolScreenshot(args);
    case "snapshot":
      return await toolSnapshot(args);
    case "get_tabs":
      return await toolGetTabs(args);
    case "execute_script":
      return await toolExecuteScript(args);
    case "scroll":
      return await toolScroll(args);
    case "wait":
      return await toolWait(args);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

async function getTabById(tabId) {
  if (tabId) {
    return await chrome.tabs.get(tabId);
  }
  return await getActiveTab();
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required");
  
  const tab = await getTabById(tabId);
  await chrome.tabs.update(tab.id, { url });
  
  // Wait for page to load
  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout after 30 seconds
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
  
  return `Navigated to ${url}`;
}

async function toolClick({ selector, tabId }) {
  if (!selector) throw new Error("Selector is required");
  
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const element = document.querySelector(sel);
      if (!element) return { success: false, error: `Element not found: ${sel}` };
      element.click();
      return { success: true };
    },
    args: [selector]
  });
  
  if (!result[0]?.result?.success) {
    throw new Error(result[0]?.result?.error || "Click failed");
  }
  
  return `Clicked ${selector}`;
}

async function toolType({ selector, text, tabId, clear = false }) {
  if (!selector) throw new Error("Selector is required");
  if (text === undefined) throw new Error("Text is required");
  
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt, shouldClear) => {
      const element = document.querySelector(sel);
      if (!element) return { success: false, error: `Element not found: ${sel}` };
      
      element.focus();
      if (shouldClear) {
        element.value = "";
      }
      
      // For input/textarea, set value directly
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        element.value = element.value + txt;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (element.isContentEditable) {
        document.execCommand("insertText", false, txt);
      }
      
      return { success: true };
    },
    args: [selector, text, clear]
  });
  
  if (!result[0]?.result?.success) {
    throw new Error(result[0]?.result?.error || "Type failed");
  }
  
  return `Typed "${text}" into ${selector}`;
}

async function toolScreenshot({ tabId, fullPage = false }) {
  const tab = await getTabById(tabId);
  
  // Capture visible area
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png"
  });
  
  return dataUrl;
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Build accessibility tree snapshot
      function getAccessibleName(element) {
        return element.getAttribute("aria-label") ||
               element.getAttribute("alt") ||
               element.getAttribute("title") ||
               element.getAttribute("placeholder") ||
               element.innerText?.slice(0, 100) ||
               "";
      }
      
      function getRole(element) {
        return element.getAttribute("role") ||
               element.tagName.toLowerCase();
      }
      
      function buildSnapshot(element, depth = 0, uid = 0) {
        if (depth > 10) return { nodes: [], nextUid: uid };
        
        const nodes = [];
        const style = window.getComputedStyle(element);
        
        // Skip hidden elements
        if (style.display === "none" || style.visibility === "hidden") {
          return { nodes: [], nextUid: uid };
        }
        
        const isInteractive = 
          element.tagName === "A" ||
          element.tagName === "BUTTON" ||
          element.tagName === "INPUT" ||
          element.tagName === "TEXTAREA" ||
          element.tagName === "SELECT" ||
          element.getAttribute("onclick") ||
          element.getAttribute("role") === "button" ||
          element.isContentEditable;
        
        const rect = element.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        
        if (isVisible && (isInteractive || element.innerText?.trim())) {
          const node = {
            uid: `e${uid}`,
            role: getRole(element),
            name: getAccessibleName(element).slice(0, 200),
            tag: element.tagName.toLowerCase()
          };
          
          if (element.tagName === "A" && element.href) {
            node.href = element.href;
          }
          if (element.tagName === "INPUT") {
            node.type = element.type;
            node.value = element.value;
          }
          
          // Generate a selector
          if (element.id) {
            node.selector = `#${element.id}`;
          } else if (element.className && typeof element.className === "string") {
            const classes = element.className.trim().split(/\s+/).slice(0, 2).join(".");
            if (classes) node.selector = `${element.tagName.toLowerCase()}.${classes}`;
          }
          
          nodes.push(node);
          uid++;
        }
        
        for (const child of element.children) {
          const childResult = buildSnapshot(child, depth + 1, uid);
          nodes.push(...childResult.nodes);
          uid = childResult.nextUid;
        }
        
        return { nodes, nextUid: uid };
      }
      
      const { nodes } = buildSnapshot(document.body);
      
      return {
        url: window.location.href,
        title: document.title,
        nodes: nodes.slice(0, 500) // Limit to 500 nodes
      };
    }
  });
  
  return JSON.stringify(result[0]?.result, null, 2);
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({});
  return JSON.stringify(tabs.map(t => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId
  })), null, 2);
}

async function toolExecuteScript({ code, tabId }) {
  if (!code) throw new Error("Code is required");
  
  const tab = await getTabById(tabId);
  
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: new Function(code)
  });
  
  return JSON.stringify(result[0]?.result);
}

async function toolScroll({ x = 0, y = 0, selector, tabId }) {
  const tab = await getTabById(tabId);
  
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (scrollX, scrollY, sel) => {
      if (sel) {
        const element = document.querySelector(sel);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
      }
      window.scrollBy(scrollX, scrollY);
    },
    args: [x, y, selector]
  });
  
  return `Scrolled ${selector ? `to ${selector}` : `by (${x}, ${y})`}`;
}

async function toolWait({ ms = 1000 }) {
  await new Promise(resolve => setTimeout(resolve, ms));
  return `Waited ${ms}ms`;
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[OpenCode] Extension installed");
  await connectToNativeHost();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[OpenCode] Extension started");
  await connectToNativeHost();
});

// Auto-reconnect on action click
chrome.action.onClicked.addListener(async () => {
  if (!isConnected) {
    const connected = await connectToNativeHost();
    if (connected) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "OpenCode Browser",
        message: "Connected to native host"
      });
    } else {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "OpenCode Browser",
        message: "Failed to connect. Is the native host installed?"
      });
    }
  } else {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "OpenCode Browser",
      message: "Already connected"
    });
  }
});

// Try to connect on load
connectToNativeHost();
