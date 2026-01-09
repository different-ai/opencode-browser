const NATIVE_HOST_NAME = "com.opencode.browser_automation"
const KEEPALIVE_ALARM = "keepalive"

let port = null
let isConnected = false
let connectionAttempts = 0

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!isConnected) connect()
  }
})

function connect() {
  if (port) {
    try { port.disconnect() } catch {}
    port = null
  }

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)

    port.onMessage.addListener((message) => {
      handleMessage(message).catch((e) => {
        console.error("[OpenCode] Message handler error:", e)
      })
    })

    port.onDisconnect.addListener(() => {
      isConnected = false
      port = null
      updateBadge(false)

      const err = chrome.runtime.lastError
      if (err?.message) {
        // Usually means native host not installed or crashed
        connectionAttempts++
        if (connectionAttempts === 1) {
          console.log("[OpenCode] Native host not available. Run: npx @different-ai/opencode-browser install")
        } else if (connectionAttempts % 20 === 0) {
          console.log("[OpenCode] Still waiting for native host...")
        }
      }
    })

    isConnected = true
    connectionAttempts = 0
    updateBadge(true)
  } catch (e) {
    isConnected = false
    updateBadge(false)
    console.error("[OpenCode] connectNative failed:", e)
  }
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" })
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#22c55e" : "#ef4444" })
}

function send(message) {
  if (!port) return false
  try {
    port.postMessage(message)
    return true
  } catch {
    return false
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return

  if (message.type === "tool_request") {
    await handleToolRequest(message)
  } else if (message.type === "ping") {
    send({ type: "pong" })
  }
}

async function handleToolRequest(request) {
  const { id, tool, args } = request

  try {
    const result = await executeTool(tool, args || {})
    send({ type: "tool_response", id, result })
  } catch (error) {
    send({
      type: "tool_response",
      id,
      error: { content: error?.message || String(error) },
    })
  }
}

async function executeTool(toolName, args) {
  const tools = {
    get_active_tab: toolGetActiveTab,
    get_tabs: toolGetTabs,
    navigate: toolNavigate,
    click: toolClick,
    type: toolType,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    execute_script: toolExecuteScript,
    scroll: toolScroll,
    wait: toolWait,
  }

  const fn = tools[toolName]
  if (!fn) throw new Error(`Unknown tool: ${toolName}`)
  return await fn(args)
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error("No active tab found")
  return tab
}

async function getTabById(tabId) {
  return tabId ? await chrome.tabs.get(tabId) : await getActiveTab()
}

async function toolGetActiveTab() {
  const tab = await getActiveTab()
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, title: tab.title } }
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required")
  const tab = await getTabById(tabId)
  await chrome.tabs.update(tab.id, { url })

  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, 30000)
  })

  return { tabId: tab.id, content: `Navigated to ${url}` }
}

async function toolClick({ selector, tabId }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const el = document.querySelector(sel)
      if (!el) return { success: false, error: `Element not found: ${sel}` }
      el.click()
      return { success: true }
    },
    args: [selector],
  })

  if (!result[0]?.result?.success) throw new Error(result[0]?.result?.error || "Click failed")
  return { tabId: tab.id, content: `Clicked ${selector}` }
}

async function toolType({ selector, text, tabId, clear = false }) {
  if (!selector) throw new Error("Selector is required")
  if (text === undefined) throw new Error("Text is required")
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt, shouldClear) => {
      const el = document.querySelector(sel)
      if (!el) return { success: false, error: `Element not found: ${sel}` }
      el.focus()
      if (shouldClear && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) el.value = ""

      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.value = el.value + txt
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
      } else if (el.isContentEditable) {
        document.execCommand("insertText", false, txt)
      }
      return { success: true }
    },
    args: [selector, text, clear],
  })

  if (!result[0]?.result?.success) throw new Error(result[0]?.result?.error || "Type failed")
  return { tabId: tab.id, content: `Typed "${text}" into ${selector}` }
}

async function toolScreenshot({ tabId }) {
  const tab = await getTabById(tabId)
  const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  return { tabId: tab.id, content: png }
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function getName(el) {
        return (
          el.getAttribute("aria-label") ||
          el.getAttribute("alt") ||
          el.getAttribute("title") ||
          el.getAttribute("placeholder") ||
          el.innerText?.slice(0, 100) ||
          ""
        )
      }

      function build(el, depth = 0, uid = 0) {
        if (depth > 10) return { nodes: [], nextUid: uid }
        const nodes = []
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden") return { nodes: [], nextUid: uid }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          el.getAttribute("role") === "button" ||
          el.isContentEditable
        const rect = el.getBoundingClientRect()

        if (rect.width > 0 && rect.height > 0 && (isInteractive || el.innerText?.trim())) {
          const node = {
            uid: `e${uid}`,
            role: el.getAttribute("role") || el.tagName.toLowerCase(),
            name: getName(el).slice(0, 200),
            tag: el.tagName.toLowerCase(),
          }
          if (el.href) node.href = el.href
          if (el.tagName === "INPUT") {
            node.type = el.type
            node.value = el.value
          }
          if (el.id) node.selector = `#${el.id}`
          else if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".")
            if (cls) node.selector = `${el.tagName.toLowerCase()}.${cls}`
          }
          nodes.push(node)
          uid++
        }

        for (const child of el.children) {
          const r = build(child, depth + 1, uid)
          nodes.push(...r.nodes)
          uid = r.nextUid
        }
        return { nodes, nextUid: uid }
      }

      function getAllLinks() {
        const links = []
        const seen = new Set()
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href
          if (href && !seen.has(href) && !href.startsWith("javascript:")) {
            seen.add(href)
            const text = a.innerText?.trim().slice(0, 100) || a.getAttribute("aria-label") || ""
            links.push({ href, text })
          }
        })
        return links.slice(0, 100)
      }

      return {
        url: location.href,
        title: document.title,
        nodes: build(document.body).nodes.slice(0, 500),
        links: getAllLinks(),
      }
    },
  })

  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const out = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  return { content: JSON.stringify(out, null, 2) }
}

async function toolExecuteScript({ code, tabId }) {
  if (!code) throw new Error("Code is required")
  const tab = await getTabById(tabId)
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: new Function(code),
  })
  return { tabId: tab.id, content: JSON.stringify(result[0]?.result) }
}

async function toolScroll({ x = 0, y = 0, selector, tabId }) {
  const tab = await getTabById(tabId)
  const sel = selector || null

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (scrollX, scrollY, sel) => {
      if (sel) {
        const el = document.querySelector(sel)
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" })
          return
        }
      }
      window.scrollBy(scrollX, scrollY)
    },
    args: [x, y, sel],
  })

  return { tabId: tab.id, content: `Scrolled ${sel ? `to ${sel}` : `by (${x}, ${y})`}` }
}

async function toolWait({ ms = 1000, tabId }) {
  if (typeof tabId === "number") {
    // keep tabId in response for ownership purposes
  }
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { tabId, content: `Waited ${ms}ms` }
}

chrome.runtime.onInstalled.addListener(() => connect())
chrome.runtime.onStartup.addListener(() => connect())
chrome.action.onClicked.addListener(() => {
  connect()
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "OpenCode Browser",
    message: isConnected ? "Connected" : "Reconnecting...",
  })
})

connect()