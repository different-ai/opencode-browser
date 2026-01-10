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
    try {
      port.disconnect()
    } catch {}
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
    extract: toolExtract,
    query: toolQuery,
    wait_for: toolWaitFor,
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

function normalizeSelectorList(selector) {
  if (typeof selector !== "string") return []
  const parts = selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : [selector.trim()].filter(Boolean)
}

async function toolClick({ selector, tabId, index = 0 }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const selectorList = normalizeSelectorList(selector)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selectors, index) => {
      function safeString(v) {
        return typeof v === "string" ? v : ""
      }

      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function deepQuerySelectorAll(sel, rootDoc) {
        const out = []
        const seen = new Set()

        function addAll(nodeList) {
          for (const el of nodeList) {
            if (!el || seen.has(el)) continue
            seen.add(el)
            out.push(el)
          }
        }

        function walkRoot(root, depth) {
          if (!root || depth > 6) return

          try {
            addAll(root.querySelectorAll(sel))
          } catch {
            // Invalid selector
            return
          }

          const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
          for (const el of tree) {
            if (el.shadowRoot) {
              walkRoot(el.shadowRoot, depth + 1)
            }
          }

          // Same-origin iframes only
          const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
          for (const frame of frames) {
            try {
              const doc = frame.contentDocument
              if (doc) walkRoot(doc, depth + 1)
            } catch {
              // cross-origin
            }
          }
        }

        walkRoot(rootDoc || document, 0)
        return out
      }

      function tryClick(el) {
        try {
          el.scrollIntoView({ block: "center", inline: "center" })
        } catch {}

        const rect = el.getBoundingClientRect()
        const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
        const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)

        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }
        try {
          el.dispatchEvent(new MouseEvent("mouseover", opts))
          el.dispatchEvent(new MouseEvent("mousemove", opts))
          el.dispatchEvent(new MouseEvent("mousedown", opts))
          el.dispatchEvent(new MouseEvent("mouseup", opts))
          el.dispatchEvent(new MouseEvent("click", opts))
        } catch {}

        try {
          el.click()
        } catch {}
      }

      for (const sel of selectors) {
        const s = safeString(sel)
        if (!s) continue

        const matches = deepQuerySelectorAll(s, document)
        const visible = matches.filter(isVisible)
        const chosen = visible[index] || matches[index]
        if (chosen) {
          tryClick(chosen)
          return { success: true, selectorUsed: s }
        }
      }

      return { success: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    },
    args: [selectorList, index],
    world: "ISOLATED",
  })

  if (!result[0]?.result?.success) throw new Error(result[0]?.result?.error || "Click failed")
  const used = result[0]?.result?.selectorUsed || selector
  return { tabId: tab.id, content: `Clicked ${used}` }
}

async function toolType({ selector, text, tabId, clear = false, index = 0 }) {
  if (!selector) throw new Error("Selector is required")
  if (text === undefined) throw new Error("Text is required")
  const tab = await getTabById(tabId)

  const selectorList = normalizeSelectorList(selector)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selectors, txt, shouldClear, index) => {
      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function deepQuerySelectorAll(sel, rootDoc) {
        const out = []
        const seen = new Set()

        function addAll(nodeList) {
          for (const el of nodeList) {
            if (!el || seen.has(el)) continue
            seen.add(el)
            out.push(el)
          }
        }

        function walkRoot(root, depth) {
          if (!root || depth > 6) return

          try {
            addAll(root.querySelectorAll(sel))
          } catch {
            return
          }

          const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
          for (const el of tree) {
            if (el.shadowRoot) {
              walkRoot(el.shadowRoot, depth + 1)
            }
          }

          const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
          for (const frame of frames) {
            try {
              const doc = frame.contentDocument
              if (doc) walkRoot(doc, depth + 1)
            } catch {}
          }
        }

        walkRoot(rootDoc || document, 0)
        return out
      }

      function setNativeValue(el, value) {
        const tag = el.tagName
        if (tag === "INPUT" || tag === "TEXTAREA") {
          const proto = tag === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
          if (setter) setter.call(el, value)
          else el.value = value
          return true
        }
        return false
      }

      for (const sel of selectors) {
        if (!sel) continue
        const matches = deepQuerySelectorAll(sel, document)
        const visible = matches.filter(isVisible)
        const el = visible[index] || matches[index]
        if (!el) continue

        try {
          el.scrollIntoView({ block: "center", inline: "center" })
        } catch {}

        try {
          el.focus()
        } catch {}

        const tag = el.tagName
        const isTextInput = tag === "INPUT" || tag === "TEXTAREA"

        if (isTextInput) {
          if (shouldClear) setNativeValue(el, "")
          setNativeValue(el, (el.value || "") + txt)
          el.dispatchEvent(new Event("input", { bubbles: true }))
          el.dispatchEvent(new Event("change", { bubbles: true }))
          return { success: true, selectorUsed: sel }
        }

        if (el.isContentEditable) {
          if (shouldClear) el.textContent = ""
          try {
            document.execCommand("insertText", false, txt)
          } catch {
            el.textContent = (el.textContent || "") + txt
          }
          el.dispatchEvent(new Event("input", { bubbles: true }))
          return { success: true, selectorUsed: sel }
        }

        return { success: false, error: `Element is not typable: ${sel} (${tag.toLowerCase()})` }
      }

      return { success: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    },
    args: [selectorList, text, !!clear, index],
    world: "ISOLATED",
  })

  if (!result[0]?.result?.success) throw new Error(result[0]?.result?.error || "Type failed")
  const used = result[0]?.result?.selectorUsed || selector
  return { tabId: tab.id, content: `Typed "${text}" into ${used}` }
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
      function safeText(s) {
        return typeof s === "string" ? s : ""
      }

      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function pseudoText(el) {
        try {
          const before = window.getComputedStyle(el, "::before").content
          const after = window.getComputedStyle(el, "::after").content
          const norm = (v) => {
            const s = safeText(v)
            if (!s || s === "none") return ""
            return s.replace(/^"|"$/g, "")
          }
          return { before: norm(before), after: norm(after) }
        } catch {
          return { before: "", after: "" }
        }
      }

      function getName(el) {
        const aria = el.getAttribute("aria-label")
        if (aria) return aria
        const alt = el.getAttribute("alt")
        if (alt) return alt
        const title = el.getAttribute("title")
        if (title) return title
        const placeholder = el.getAttribute("placeholder")
        if (placeholder) return placeholder
        const txt = safeText(el.innerText)
        if (txt.trim()) return txt.slice(0, 200)
        const pt = pseudoText(el)
        const combo = `${pt.before} ${pt.after}`.trim()
        if (combo) return combo.slice(0, 200)
        return ""
      }

      function build(el, depth = 0, uid = 0) {
        if (!el || depth > 12) return { nodes: [], nextUid: uid }
        const nodes = []

        if (!isVisible(el)) return { nodes: [], nextUid: uid }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          el.getAttribute("role") === "button" ||
          el.isContentEditable

        const name = getName(el)
        const pt = pseudoText(el)

        const shouldInclude = isInteractive || name.trim() || pt.before || pt.after

        if (shouldInclude) {
          const node = {
            uid: `e${uid}`,
            role: el.getAttribute("role") || el.tagName.toLowerCase(),
            name: name,
            tag: el.tagName.toLowerCase(),
          }

          if (pt.before) node.before = pt.before
          if (pt.after) node.after = pt.after

          if (el.href) node.href = el.href

          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            node.type = el.type
            node.value = el.value
            if (el.readOnly) node.readOnly = true
            if (el.disabled) node.disabled = true
          }

          if (el.id) node.selector = `#${el.id}`
          else if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".")
            if (cls) node.selector = `${el.tagName.toLowerCase()}.${cls}`
          }

          nodes.push(node)
          uid++
        }

        if (el.shadowRoot) {
          const r = build(el.shadowRoot.host, depth + 1, uid)
          uid = r.nextUid
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
        return links.slice(0, 200)
      }

      let pageText = ""
      try {
        pageText = safeText(document.body?.innerText || "").slice(0, 20000)
      } catch {}

      const built = build(document.body).nodes.slice(0, 800)

      return {
        url: location.href,
        title: document.title,
        text: pageText,
        nodes: built,
        links: getAllLinks(),
      }
    },
    world: "ISOLATED",
  })

  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolExtract({ tabId, mode = "combined", pattern, flags = "i", limit = 20000 }) {
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (mode, pattern, flags, limit) => {
      const cap = (s) => String(s ?? "").slice(0, Math.max(0, limit || 0))

      const getPseudoText = () => {
        const out = []
        const pushContent = (content) => {
          if (!content) return
          const c = String(content)
          if (!c || c === "none" || c === "normal") return
          const unquoted = c.replace(/^"|"$/g, "").replace(/^'|'$/g, "")
          if (unquoted && unquoted !== "none" && unquoted !== "normal") out.push(unquoted)
        }

        const elements = Array.from(document.querySelectorAll("*"))
        for (let i = 0; i < elements.length && out.length < 2000; i++) {
          const el = elements[i]
          try {
            const style = window.getComputedStyle(el)
            if (style.display === "none" || style.visibility === "hidden") continue
            const before = window.getComputedStyle(el, "::before").content
            const after = window.getComputedStyle(el, "::after").content
            pushContent(before)
            pushContent(after)
          } catch {
            // ignore
          }
        }
        return out.join("\n")
      }

      const getInputValues = () => {
        const out = []
        const nodes = document.querySelectorAll("input, textarea")
        nodes.forEach((el) => {
          try {
            const name = el.getAttribute("aria-label") || el.getAttribute("name") || el.id || el.className || el.tagName
            const value = el.value
            if (value != null && String(value).trim()) out.push(`${name}: ${value}`)
          } catch {
            // ignore
          }
        })
        return out.join("\n")
      }

      const getText = () => {
        try {
          return document.body ? document.body.innerText || "" : ""
        } catch {
          return ""
        }
      }

      const parts = []
      if (mode === "text" || mode === "combined") parts.push(getText())
      if (mode === "pseudo" || mode === "combined") parts.push(getPseudoText())
      if (mode === "inputs" || mode === "combined") parts.push(getInputValues())

      const text = cap(parts.filter(Boolean).join("\n\n"))

      let matches = []
      if (pattern) {
        try {
          const re = new RegExp(pattern, flags || "")
          const found = []
          let m
          while ((m = re.exec(text)) && found.length < 50) {
            found.push(m[0])
            if (!re.global) break
          }
          matches = found
        } catch (e) {
          matches = []
        }
      }

      return { url: location.href, title: document.title, mode, text, matches }
    },
    args: [mode, pattern, flags, limit],
  })

  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const out = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  return { content: JSON.stringify(out, null, 2) }
}

async function toolQuery({ tabId, selector, mode = "text", attribute, property, limit = 50, index = 0 }) {
  if (!selector) throw new Error("selector is required")
  const tab = await getTabById(tabId)

  const selectorList = normalizeSelectorList(selector)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (selectors, mode, attribute, property, limit, index) => {
      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function deepQuerySelectorAll(sel, rootDoc) {
        const out = []
        const seen = new Set()

        function addAll(nodeList) {
          for (const el of nodeList) {
            if (!el || seen.has(el)) continue
            seen.add(el)
            out.push(el)
          }
        }

        function walkRoot(root, depth) {
          if (!root || depth > 6) return

          try {
            addAll(root.querySelectorAll(sel))
          } catch {
            return
          }

          const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
          for (const el of tree) {
            if (el.shadowRoot) {
              walkRoot(el.shadowRoot, depth + 1)
            }
          }

          const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
          for (const frame of frames) {
            try {
              const doc = frame.contentDocument
              if (doc) walkRoot(doc, depth + 1)
            } catch {}
          }
        }

        walkRoot(rootDoc || document, 0)
        return out
      }

      for (const sel of selectors) {
        const matches = deepQuerySelectorAll(sel, document)
        if (!matches.length) continue

        const visible = matches.filter(isVisible)
        const chosen = visible[index] || matches[index]

        if (mode === "exists") {
          return { ok: true, selectorUsed: sel, exists: true, count: matches.length }
        }

        if (!chosen) return { ok: false, error: `No element at index ${index} for ${sel}`, selectorUsed: sel }

        if (mode === "text") {
          const text = (chosen.innerText || chosen.textContent || "").trim()
          return { ok: true, selectorUsed: sel, value: text }
        }

        if (mode === "value") {
          const v = chosen.value
          return { ok: true, selectorUsed: sel, value: typeof v === "string" ? v : String(v ?? "") }
        }

        if (mode === "attribute") {
          const a = attribute ? chosen.getAttribute(attribute) : null
          return { ok: true, selectorUsed: sel, value: a }
        }

        if (mode === "property") {
          if (!property) return { ok: false, error: "property is required", selectorUsed: sel }
          const v = chosen[property]
          return { ok: true, selectorUsed: sel, value: v }
        }

        if (mode === "html") {
          return { ok: true, selectorUsed: sel, value: chosen.outerHTML }
        }

        if (mode === "list") {
          const items = matches
            .slice(0, Math.max(1, Math.min(200, limit)))
            .map((el) => ({
              text: (el.innerText || el.textContent || "").trim().slice(0, 200),
              tag: (el.tagName || "").toLowerCase(),
              ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : null,
            }))
          return { ok: true, selectorUsed: sel, items, count: matches.length }
        }

        return { ok: false, error: `Unknown mode: ${mode}`, selectorUsed: sel }
      }

      return { ok: false, error: `No matches for selectors: ${selectors.join(", ")}` }
    },
    args: [selectorList, mode, attribute || null, property || null, limit, index],
    world: "ISOLATED",
  })

  const r = result[0]?.result
  if (!r?.ok) throw new Error(r?.error || "Query failed")

  // Keep output predictable: JSON for list/property, string otherwise
  if (mode === "list" || mode === "property") {
    return { tabId: tab.id, content: JSON.stringify(r, null, 2) }
  }

  return { tabId: tab.id, content: typeof r.value === "string" ? r.value : JSON.stringify(r.value) }
}

async function toolWaitFor({ tabId, selector, timeoutMs = 10000, pollMs = 200 }) {
  if (!selector) throw new Error("selector is required")
  const tab = await getTabById(tabId)

  const selectorList = normalizeSelectorList(selector)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (selectors, timeoutMs, pollMs) => {
      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function deepQuerySelector(sel, rootDoc) {
        function findInRoot(root, depth) {
          if (!root || depth > 6) return null
          try {
            const found = root.querySelector(sel)
            if (found) return found
          } catch {
            return null
          }

          const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
          for (const el of tree) {
            if (el.shadowRoot) {
              const f = findInRoot(el.shadowRoot, depth + 1)
              if (f) return f
            }
          }

          const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
          for (const frame of frames) {
            try {
              const doc = frame.contentDocument
              if (doc) {
                const f = findInRoot(doc, depth + 1)
                if (f) return f
              }
            } catch {}
          }

          return null
        }

        return findInRoot(rootDoc || document, 0)
      }

      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        for (const sel of selectors) {
          if (!sel) continue
          const el = deepQuerySelector(sel, document)
          if (el && isVisible(el)) return { ok: true, selectorUsed: sel }
        }
        await new Promise((r) => setTimeout(r, pollMs))
      }

      return { ok: false, error: `Timed out waiting for selectors: ${selectors.join(", ")}` }
    },
    args: [selectorList, timeoutMs, pollMs],
    world: "ISOLATED",
  })

  const r = result[0]?.result
  if (!r?.ok) throw new Error(r?.error || "wait_for failed")
  return { tabId: tab.id, content: `Found ${r.selectorUsed}` }
}

// Legacy tool kept for compatibility.
// We intentionally do NOT evaluate arbitrary JS strings (unpredictable + CSP/unsafe-eval issues).
// Instead, accept a JSON payload string describing a query.
async function toolExecuteScript({ code, tabId }) {
  if (!code) throw new Error("Code is required")

  let command
  try {
    command = JSON.parse(code)
  } catch {
    throw new Error(
      "browser_execute expects JSON (not raw JS) due to MV3 CSP. Try: {\"op\":\"query\",\"selector\":\"...\",\"return\":\"text\" } or use browser_extract."
    )
  }

  const tab = await getTabById(tabId)
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (cmd) => {
      const getBySelector = (selector) => {
        if (!selector) return null
        try {
          return document.querySelector(selector)
        } catch {
          return null
        }
      }

      const op = cmd?.op
      if (op === "query") {
        const el = getBySelector(cmd.selector)
        if (!el) return { ok: false, error: "not_found" }
        const ret = cmd.return || "text"
        if (ret === "text") return { ok: true, value: el.innerText ?? el.textContent ?? "" }
        if (ret === "value") return { ok: true, value: el.value }
        if (ret === "html") return { ok: true, value: el.innerHTML }
        if (ret === "attr") return { ok: true, value: el.getAttribute(cmd.name) }
        if (ret === "href") return { ok: true, value: el.href }
        return { ok: false, error: `unknown_return:${ret}` }
      }

      if (op === "location") {
        return { ok: true, value: { url: location.href, title: document.title } }
      }

      return { ok: false, error: `unknown_op:${String(op)}` }
    },
    args: [command],
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
    world: "ISOLATED",
  })

  return { tabId: tab.id, content: `Scrolled ${sel ? `to ${sel}` : `by (${x}, ${y})`}` }
}

async function toolWait({ ms = 1000, tabId }) {
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
