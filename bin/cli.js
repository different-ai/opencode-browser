#!/usr/bin/env node
/**
 * OpenCode Browser - CLI
 *
 * Architecture (v4):
 *   OpenCode Plugin <-> Local Broker (unix socket) <-> Native Messaging Host <-> Chrome Extension
 *
 * Commands:
 *   install   - Install extension + native host
 *   uninstall - Remove native host registration
 *   status    - Show installation status
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
  chmodSync,
} from "fs";
import { homedir, platform, userInfo } from "os";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createInterface } from "readline";
import { createConnection } from "net";
import { execSync, spawn, spawnSync } from "child_process";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, "..");

const BASE_DIR = join(homedir(), ".opencode-browser");
const EXTENSION_DIR = join(BASE_DIR, "extension");
const EXTENSION_MANIFEST_PATH = join(PACKAGE_ROOT, "extension", "manifest.json");
const BROKER_DST = join(BASE_DIR, "broker.cjs");
const NATIVE_HOST_DST = join(BASE_DIR, "native-host.cjs");
const CONFIG_DST = join(BASE_DIR, "config.json");

const NATIVE_HOST_NAME = "com.opencode.browser_automation";
const OS_NAME = platform();
const NATIVE_HOST_WRAPPER = join(
  BASE_DIR,
  OS_NAME === "win32" ? "host-wrapper.cmd" : "host-wrapper.sh"
);
const BROKER_SOCKET = getBrokerSocketPath();

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function color(c, text) {
  return `${COLORS[c]}${text}${COLORS.reset}`;
}

function isWindows() {
  return OS_NAME === "win32";
}

function getSafePipeName() {
  try {
    const username = userInfo().username || "user";
    return `opencode-browser-${username}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return "opencode-browser";
  }
}

function getBrokerSocketPath() {
  const override = process.env.OPENCODE_BROWSER_BROKER_SOCKET;
  if (override) return override;
  if (OS_NAME === "win32") return `\\\\.\\pipe\\${getSafePipeName()}`;
  return join(BASE_DIR, "broker.sock");
}

function getWindowsRegistryTargets() {
  return [
    { name: "Chrome", key: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" },
    { name: "Chromium", key: "HKCU\\Software\\Chromium\\NativeMessagingHosts" },
    { name: "Brave", key: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts" },
    { name: "Edge", key: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts" },
  ];
}

function runRegCommand(args) {
  try {
    const result = spawnSync("reg", args, { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function queryRegistryDefaultValue(key) {
  try {
    const result = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const output = String(result.stdout || "");
    const match = output.match(/REG_SZ\s+(.+)\s*$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function log(msg) {
  console.log(msg);
}

function success(msg) {
  console.log(color("green", "  " + msg));
}

function warn(msg) {
  console.log(color("yellow", "  " + msg));
}

function error(msg) {
  console.log(color("red", "  " + msg));
}

function header(msg) {
  console.log("\n" + color("cyan", color("bright", msg)));
  console.log(color("cyan", "-".repeat(msg.length)));
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function confirm(question) {
  const answer = await ask(`${question} (y/n): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

function getFlagValue(flag) {
  const index = process.argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index === -1) return null;
  const arg = process.argv[index];
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1).trim() || null;
  const next = process.argv[index + 1];
  if (!next || next.startsWith("-")) return null;
  return next.trim();
}

function getExtensionIdOverride() {
  const cliValue = getFlagValue("--extension-id") || getFlagValue("-e");
  if (cliValue) return cliValue;
  const envValue = process.env.OPENCODE_BROWSER_EXTENSION_ID;
  return envValue ? envValue.trim() : null;
}

function readExtensionManifest() {
  try {
    if (!existsSync(EXTENSION_MANIFEST_PATH)) return null;
    return JSON.parse(readFileSync(EXTENSION_MANIFEST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function computeExtensionIdFromKey(key) {
  try {
    const raw = String(key || "").trim();
    if (!raw) return null;
    const buffer = Buffer.from(raw, "base64");
    if (!buffer.length) return null;
    const hash = createHash("sha256").update(buffer).digest();
    const bytes = hash.subarray(0, 16);
    return Array.from(bytes)
      .map((b) => {
        const hi = b >> 4;
        const lo = b & 15;
        return String.fromCharCode(97 + hi) + String.fromCharCode(97 + lo);
      })
      .join("");
  } catch {
    return null;
  }
}

function getExtensionIdFromManifest() {
  const manifest = readExtensionManifest();
  if (!manifest?.key) return null;
  return computeExtensionIdFromKey(manifest.key);
}

async function resolveExtensionId({ allowPrompt = true, preferConfig = false } = {}) {
  const override = getExtensionIdOverride();
  if (override) return { id: override, source: "override" };

  const config = loadConfig();
  if (preferConfig && config?.extensionId) {
    return { id: config.extensionId, source: "config" };
  }

  const manifestId = getExtensionIdFromManifest();
  if (manifestId) {
    return { id: manifestId, source: "manifest" };
  }

  if (!preferConfig && config?.extensionId) {
    return { id: config.extensionId, source: "config" };
  }

  if (!allowPrompt) {
    return { id: null, source: "missing" };
  }

  const extensionId = await ask(color("bright", "Paste Extension ID: "));
  return { id: extensionId || null, source: extensionId ? "prompt" : "missing" };
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function resolveNodePath() {
  if (process.env.OPENCODE_BROWSER_NODE) return process.env.OPENCODE_BROWSER_NODE;
  // Prefer `which node` / `where node` — returns stable symlink paths (e.g.
  // /opt/homebrew/bin/node) rather than versioned paths (e.g.
  // /opt/homebrew/Cellar/node/25.8.1/bin/node) that break on package manager
  // upgrades (Homebrew, nvm, fnm, volta, etc.).
  try {
    const command = isWindows() ? "where node" : "which node";
    const output = execSync(command, { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
    if (output) return output;
  } catch {
      if (process.execPath && /node(\.exe)?$/.test(process.execPath)) return process.execPath;
  }
  return process.execPath;
}

function writeHostWrapper(nodePath) {
  ensureDir(BASE_DIR);
  if (isWindows()) {
    const script = `@echo off\r\n"${nodePath}" "${NATIVE_HOST_DST}"\r\n`;
    writeFileSync(NATIVE_HOST_WRAPPER, script);
    return NATIVE_HOST_WRAPPER;
  }
  const script = `#!/bin/sh\n"${nodePath}" "${NATIVE_HOST_DST}"\n`;
  writeFileSync(NATIVE_HOST_WRAPPER, script, { mode: 0o755 });
  chmodSync(NATIVE_HOST_WRAPPER, 0o755);
  return NATIVE_HOST_WRAPPER;
}

function createJsonLineParser(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  };
}

async function getBrokerStatus(timeoutMs = 2000) {
  return await new Promise((resolve) => {
    let done = false;
    const socket = createConnection(BROKER_SOCKET);

    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.end();
      } catch {}
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Timed out waiting for broker" });
    }, timeoutMs);

    socket.once("error", (err) => {
      clearTimeout(timeout);
      finish({ ok: false, error: err.message || "Broker connection failed" });
    });

    socket.once("connect", () => {
      socket.write(JSON.stringify({ type: "request", id: 1, op: "status" }) + "\n");
    });

    socket.on(
      "data",
      createJsonLineParser((msg) => {
        if (msg && msg.type === "response" && msg.id === 1) {
          clearTimeout(timeout);
          if (msg.ok) {
            finish({ ok: true, data: msg.data });
          } else {
            finish({ ok: false, error: msg.error || "Broker status error" });
          }
        }
      })
    );
  });
}

function copyDirRecursive(srcDir, destDir) {
  ensureDir(destDir);
  const entries = readdirSync(srcDir, { recursive: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);

    try {
      readdirSync(srcPath);
      ensureDir(destPath);
    } catch {
      ensureDir(dirname(destPath));
      copyFileSync(srcPath, destPath);
    }
  }
}

function getNativeHostDirs(osName) {
  if (osName === "win32") return [];
  if (osName === "darwin") {
    const base = join(homedir(), "Library", "Application Support");
    return [
      join(base, "Google", "Chrome", "NativeMessagingHosts"),
      join(base, "Chromium", "NativeMessagingHosts"),
      join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    ];
  }

  // linux
  const base = join(homedir(), ".config");
  return [
    join(base, "google-chrome", "NativeMessagingHosts"),
    join(base, "chromium", "NativeMessagingHosts"),
    join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
  ];
}

function nativeHostManifestPath(dir) {
  return join(dir, `${NATIVE_HOST_NAME}.json`);
}

function writeNativeHostManifest(dir, extensionId, hostPath) {
  ensureDir(dir);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "OpenCode Browser native messaging host",
    path: hostPath || NATIVE_HOST_DST,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  writeFileSync(nativeHostManifestPath(dir), JSON.stringify(manifest, null, 2) + "\n");
}

function writeWindowsNativeHostManifest(extensionId, hostPath) {
  const manifestPath = nativeHostManifestPath(BASE_DIR);
  writeNativeHostManifest(BASE_DIR, extensionId, hostPath);
  return manifestPath;
}

function registerWindowsNativeHost(manifestPath) {
  for (const target of getWindowsRegistryTargets()) {
    const key = `${target.key}\\${NATIVE_HOST_NAME}`;
    const ok = runRegCommand(["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
    if (ok) {
      success(`Registered native host for ${target.name}: ${key}`);
    } else {
      warn(`Could not register native host for ${target.name}: ${key}`);
    }
  }
}

function unregisterWindowsNativeHost() {
  for (const target of getWindowsRegistryTargets()) {
    const key = `${target.key}\\${NATIVE_HOST_NAME}`;
    const ok = runRegCommand(["delete", key, "/f"]);
    if (ok) {
      success(`Removed native host registry: ${key}`);
    } else {
      warn(`Could not remove native host registry: ${key}`);
    }
  }
}

function reportWindowsNativeHostStatus() {
  const manifestPath = nativeHostManifestPath(BASE_DIR);
  if (existsSync(manifestPath)) {
    success(`Native host manifest: ${manifestPath}`);
  } else {
    warn(`Native host manifest missing: ${manifestPath}`);
  }

  let foundAny = false;
  for (const target of getWindowsRegistryTargets()) {
    const key = `${target.key}\\${NATIVE_HOST_NAME}`;
    const value = queryRegistryDefaultValue(key);
    if (value) {
      foundAny = true;
      success(`Registry (${target.name}): ${key}`);
    }
  }
  if (!foundAny) {
    warn("No native host registry entries found. Run: npx @different-ai/opencode-browser install");
  }
}

function loadConfig() {
  try {
    if (!existsSync(CONFIG_DST)) return null;
    return JSON.parse(readFileSync(CONFIG_DST, "utf-8"));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  ensureDir(BASE_DIR);
  writeFileSync(CONFIG_DST, JSON.stringify(config, null, 2) + "\n");
}

async function loadPluginTools() {
  const pluginPath = join(PACKAGE_ROOT, "dist", "plugin.js");
  if (!existsSync(pluginPath)) {
    throw new Error("dist/plugin.js is missing. Run `bun run build` first.");
  }

  const mod = await import(pathToFileURL(pluginPath).href);
  const factory = mod?.default;
  if (typeof factory !== "function") {
    throw new Error("Could not load plugin factory from dist/plugin.js");
  }

  const pluginInstance = await factory({});
  const tools = pluginInstance?.tool;
  if (!tools || typeof tools !== "object") {
    throw new Error("Plugin did not expose any tools");
  }
  return tools;
}

function parseJsonArg(raw, fallback = {}) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Expected JSON args. Received: ${raw}`);
  }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!["{", "[", '"'].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function getToolArgJson() {
  const byFlag = getFlagValue("--args");
  if (byFlag != null) return byFlag;
  return process.argv[4] || null;
}

async function executeTool(toolName, args = {}) {
  const tools = await loadPluginTools();
  const tool = tools?.[toolName];
  if (!tool || typeof tool.execute !== "function") {
    const available = Object.keys(tools || {})
      .sort()
      .join(", ");
    throw new Error(`Unknown tool: ${toolName}. Available: ${available}`);
  }

  return await tool.execute(args, {});
}

async function listTools() {
  header("Browser Tools");
  const tools = await loadPluginTools();
  const names = Object.keys(tools).sort();
  if (!names.length) {
    warn("No tools found in plugin.");
    return;
  }

  log(`Found ${names.length} tools:\n`);
  for (const name of names) {
    const description = tools[name]?.description || "(no description)";
    log(`- ${name}: ${description}`);
  }
}

async function runToolCommand() {
  const toolName = process.argv[3];
  if (!toolName) {
    throw new Error("Usage: npx @different-ai/opencode-browser tool <toolName> [argsJson]");
  }

  const args = parseJsonArg(getToolArgJson(), {});
  const result = await executeTool(toolName, args);

  if (typeof result === "string") {
    log(result);
    return;
  }
  log(JSON.stringify(result, null, 2));
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readTabId(value) {
  const parsed = parseMaybeJson(value);
  if (parsed && Number.isFinite(parsed.tabId)) return parsed.tabId;
  if (parsed?.content && Number.isFinite(parsed.content.tabId)) return parsed.content.tabId;
  return null;
}

async function selfTest() {
  header("CLI Self-Test");
  log("Running extension-backed smoke test via plugin tools...");

  const statusRaw = await executeTool("browser_status", {});
  const status = parseMaybeJson(statusRaw);
  if (!status || status.broker !== true || status.hostConnected !== true) {
    throw new Error(
      "browser_status indicates the extension is not connected. Run `npx @different-ai/opencode-browser install` and click the extension icon in Chrome."
    );
  }

  const fixtureUrl = "https://www.w3.org/WAI/ARIA/apg/patterns/listbox/examples/listbox-scrollable/";
  const openRaw = await executeTool("browser_open_tab", { url: fixtureUrl, active: false });
  const tabId = readTabId(openRaw);
  if (!Number.isFinite(tabId)) {
    throw new Error("Failed to read tabId from browser_open_tab output");
  }
  await executeTool("browser_wait", { ms: 250 });

  const beforeRaw = await executeTool("browser_query", {
    selector: "[role='listbox']",
    mode: "property",
    property: "scrollTop",
    tabId,
  });
  const before = asNumber(parseMaybeJson(beforeRaw)?.value, 0);

  await executeTool("browser_click", {
    selector: "text:Neptunium",
    tabId,
    timeoutMs: 3000,
    pollMs: 150,
  });

  const selectedRaw = await executeTool("browser_query", {
    selector: "[aria-selected='true']",
    mode: "text",
    tabId,
  });
  const selectedText = String(parseMaybeJson(selectedRaw) || "");
  if (!selectedText.toLowerCase().includes("neptunium")) {
    throw new Error(`Click verification failed. Expected selected text to include Neptunium, got: ${selectedText}`);
  }

  await executeTool("browser_scroll", {
    selector: "[role='listbox']",
    y: 320,
    tabId,
    timeoutMs: 2000,
    pollMs: 100,
  });
  await executeTool("browser_wait", { ms: 250 });

  const afterRaw = await executeTool("browser_query", {
    selector: "[role='listbox']",
    mode: "property",
    property: "scrollTop",
    tabId,
  });
  const after = asNumber(parseMaybeJson(afterRaw)?.value, 0);

  if (after <= before) {
    throw new Error(`Scroll verification failed. Expected scrollTop to increase (before=${before}, after=${after}).`);
  }

  success("Self-test passed: click + selector text + container scroll are working.");
}

async function main() {
  const command = process.argv[2];

  console.log(`
${color("cyan", color("bright", "OpenCode Browser v4"))}
${color("cyan", "Browser automation plugin (native messaging + per-tab ownership)")}
`);

  if (command === "install") {
    await install();
  } else if (command === "update") {
    await update();
  } else if (command === "tools") {
    await listTools();
  } else if (command === "tool") {
    await runToolCommand();
  } else if (command === "self-test") {
    await selfTest();
  } else if (command === "uninstall") {
    await uninstall();
  } else if (command === "status") {
    await status();
  } else if (command === "agent-install") {
    await agentInstall();
  } else if (command === "agent-gateway") {
    await agentGateway();
  } else {
    log(`
${color("bright", "Usage:")}
  npx @different-ai/opencode-browser install
  npx @different-ai/opencode-browser update
  npx @different-ai/opencode-browser status
  npx @different-ai/opencode-browser uninstall
  npx @different-ai/opencode-browser tools
  npx @different-ai/opencode-browser tool <toolName> [argsJson]
  npx @different-ai/opencode-browser self-test
  npx @different-ai/opencode-browser agent-install
  npx @different-ai/opencode-browser agent-gateway

${color("bright", "Options:")}
  --extension-id <id> (or OPENCODE_BROWSER_EXTENSION_ID)
  --args '{"selector":"text:Inbox"}' (for tool command)

${color("bright", "Quick Start:")}
  1. Run: npx @different-ai/opencode-browser install
  2. Restart OpenCode
  3. Use: browser_navigate / browser_click / browser_snapshot

${color("bright", "Agent Mode:")}
  1. Run: npx @different-ai/opencode-browser agent-install
  2. Set OPENCODE_BROWSER_BACKEND=agent
  3. Optionally run: npx @different-ai/opencode-browser agent-gateway
`);
  }

  rl.close();
  process.exit(0);
}

async function install() {
  header("Step 1: Check Platform");

  const osName = OS_NAME;
  if (osName !== "darwin" && osName !== "linux" && osName !== "win32") {
    error(`Unsupported platform: ${osName}`);
    error("OpenCode Browser currently supports macOS, Linux, and Windows only.");
    process.exit(1);
  }
  success(`Platform: ${osName === "darwin" ? "macOS" : osName === "win32" ? "Windows" : "Linux"}`);

  header("Step 2: Copy Extension Files");

  ensureDir(BASE_DIR);
  const srcExtensionDir = join(PACKAGE_ROOT, "extension");
  copyDirRecursive(srcExtensionDir, EXTENSION_DIR);
  success(`Extension files copied to: ${EXTENSION_DIR}`);

  header("Step 3: Load & Pin Extension");

  log(`
To load the extension:

1. Open ${color("cyan", "chrome://extensions")}
2. Enable ${color("bright", "Developer mode")}
3. Click ${color("bright", "Load unpacked")}
4. Select:
   ${color("cyan", EXTENSION_DIR)}

After loading, ${color("bright", "pin the extension")}: open the Extensions menu (puzzle icon) and click the pin.
`);

  await ask(color("bright", "Press Enter when you've loaded and pinned the extension..."));

  header("Step 4: Extension ID");

  let resolved = await resolveExtensionId({ allowPrompt: false, preferConfig: true });
  let extensionId = resolved.id;

  if (!extensionId) {
    log(`
We need the extension ID to register the native messaging host.

Find it at ${color("cyan", "chrome://extensions")}:
- Locate ${color("bright", "OpenCode Browser Automation")}
- Click ${color("bright", "Details")}
- Copy the ${color("bright", "ID")}
`);

    resolved = await resolveExtensionId({ allowPrompt: true, preferConfig: false });
    extensionId = resolved.id;
  } else if (resolved.source === "manifest") {
    success(`Using fixed extension ID from manifest: ${extensionId}`);
    log(`If you already loaded a different ID, rerun with --extension-id to override.`);
  } else if (resolved.source === "config") {
    success(`Using extension ID from config.json: ${extensionId}`);
  } else if (resolved.source === "override") {
    success(`Using extension ID override: ${extensionId}`);
  }

  if (!extensionId) {
    error("Extension ID is required to continue.");
    process.exit(1);
  }

  if (!/^[a-p]{32}$/i.test(extensionId)) {
    warn("That doesn't look like a Chrome extension ID (expected 32 chars a-p). Continuing anyway.");
  }

  header("Step 5: Install Local Host + Broker");

  const brokerSrc = join(PACKAGE_ROOT, "bin", "broker.cjs");
  const nativeHostSrc = join(PACKAGE_ROOT, "bin", "native-host.cjs");

  copyFileSync(brokerSrc, BROKER_DST);
  copyFileSync(nativeHostSrc, NATIVE_HOST_DST);

  try {
    chmodSync(BROKER_DST, 0o755);
  } catch {}
  try {
    chmodSync(NATIVE_HOST_DST, 0o755);
  } catch {}

  success(`Installed broker: ${BROKER_DST}`);
  success(`Installed native host: ${NATIVE_HOST_DST}`);

  const nodePath = resolveNodePath();
  if (!/node(\.exe)?$/.test(nodePath)) {
    warn(`Node not detected; using ${nodePath}. Set OPENCODE_BROWSER_NODE if needed.`);
  }
  const hostPath = writeHostWrapper(nodePath);
  success(`Installed host wrapper: ${hostPath}`);

  saveConfig({ extensionId, installedAt: new Date().toISOString(), nodePath });

  header("Step 6: Register Native Messaging Host");

  if (osName === "win32") {
    const manifestPath = writeWindowsNativeHostManifest(extensionId, hostPath);
    success(`Wrote native host manifest: ${manifestPath}`);
    registerWindowsNativeHost(manifestPath);
  } else {
    const hostDirs = getNativeHostDirs(osName);
    for (const dir of hostDirs) {
      try {
        writeNativeHostManifest(dir, extensionId, hostPath);
        success(`Wrote native host manifest: ${nativeHostManifestPath(dir)}`);
      } catch (e) {
        warn(`Could not write native host manifest to: ${dir}`);
      }
    }
  }

  header("Step 7: Configure OpenCode");

  const desiredPlugin = "@different-ai/opencode-browser";

  function normalizePlugins(val) {
    if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
    if (typeof val === "string" && val.trim()) return [val.trim()];
    return [];
  }

  function stripJsoncComments(contents) {
    return contents
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  function sanitizeJson(contents) {
    return stripJsoncComments(contents).replace(/,\s*(\]|\})/g, "$1");
  }

  function findOpenCodeConfigPath(configDir) {
    const jsoncPath = join(configDir, "opencode.jsonc");
    if (existsSync(jsoncPath)) return jsoncPath;
    const jsonPath = join(configDir, "opencode.json");
    return jsonPath;
  }

  const globalConfigLabel =
    osName === "win32"
      ? "2) Global (%USERPROFILE%\\.config\\opencode\\opencode.json)"
      : "2) Global (~/.config/opencode/opencode.json)";
  const configOptions = [
    "1) Project (./opencode.json or opencode.jsonc)",
    globalConfigLabel,
    "3) Custom path",
    "4) Skip (does nothing)",
  ];

  log(`\n${configOptions.join("\n")}`);
  const selection = await ask("Choose config location [1-4]: ");

  let configPath = null;
  let configDir = null;

  if (selection === "1") {
    configDir = process.cwd();
    configPath = findOpenCodeConfigPath(configDir);
  } else if (selection === "2") {
    if (osName === "win32") {
      configDir = join(homedir(), ".config", "opencode");
    } else {
      const xdgConfig = process.env.XDG_CONFIG_HOME;
      configDir = xdgConfig ? join(xdgConfig, "opencode") : join(homedir(), ".config", "opencode");
    }
    configPath = findOpenCodeConfigPath(configDir);
  } else if (selection === "3") {
    const customPath = await ask("Enter full path to opencode.json or opencode.jsonc: ");
    if (customPath) {
      configPath = customPath;
      configDir = dirname(customPath);
    } else {
      warn("No path provided. Skipping OpenCode config.");
    }
  } else if (selection === "4") {
    warn("Skipping OpenCode config (does nothing).");
  } else {
    warn("Invalid selection. Skipping OpenCode config.");
  }

  if (configPath && configDir) {
    const hasExistingConfig = existsSync(configPath);
    const shouldUpdate = hasExistingConfig
      ? await confirm(`Found ${configPath}. Add plugin automatically?`)
      : await confirm(`No config found at ${configPath}. Create one?`);

    if (shouldUpdate) {
      try {
        let config = { $schema: "https://opencode.ai/config.json", plugin: [] };
        let canWriteConfig = true;

        if (hasExistingConfig) {
          const rawConfig = readFileSync(configPath, "utf-8");
          try {
            config = JSON.parse(sanitizeJson(rawConfig));
          } catch (e) {
            error(`Failed to parse ${configPath}: ${e.message}`);
            const shouldOverwrite = await confirm("Config is invalid JSON. Back up and recreate it?");
            if (shouldOverwrite) {
              const backupPath = `${configPath}.bak-${Date.now()}`;
              writeFileSync(backupPath, rawConfig);
              warn(`Backed up invalid config to ${backupPath}`);
              config = { $schema: "https://opencode.ai/config.json", plugin: [] };
            } else {
              canWriteConfig = false;
            }
          }
        }

        if (canWriteConfig) {
          config.plugin = normalizePlugins(config.plugin);
          if (!config.plugin.includes(desiredPlugin)) config.plugin.push(desiredPlugin);
          if (typeof config.$schema !== "string") config.$schema = "https://opencode.ai/config.json";

          ensureDir(configDir);
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
          success(`Updated ${configPath} with plugin`);
        } else {
          warn(`Skipped updating ${configPath}. Fix JSON manually and rerun install.`);
        }
      } catch (e) {
        error(`Failed to update ${configPath}: ${e.message}`);
      }
    }
  }

  header("Step 8: Optional Agent Skill");

  log(`
Agent Skills are reusable instructions discovered by OpenCode.

Format rules (summary):
- Place a skill at .opencode/skill/<name>/SKILL.md
- SKILL.md must start with YAML frontmatter with name + description
- name must match the directory and use: ^[a-z0-9]+(-[a-z0-9]+)*$
`);

  const skillName = "browser-automation";
  const skillSrc = join(PACKAGE_ROOT, ".opencode", "skill", skillName, "SKILL.md");
  const skillDstDir = join(process.cwd(), ".opencode", "skill", skillName);
  const skillDst = join(skillDstDir, "SKILL.md");

  if (existsSync(skillSrc)) {
    const shouldAddSkill = await confirm(`Add ${skillName} skill to this repo?`);
    if (shouldAddSkill) {
      ensureDir(skillDstDir);
      copyFileSync(skillSrc, skillDst);
      success(`Added skill: ${skillDst}`);
    }
  } else {
    warn("Skill template missing from package; skipping.");
  }

  header("Step 9: Verify Extension Connection (optional)");

  const shouldCheck = await confirm("Check broker + extension connection now?");
  if (shouldCheck) {
    while (true) {
      const status = await getBrokerStatus();
      if (status.ok && status.data?.hostConnected) {
        success("Broker is running and extension is connected.");
        break;
      }

      if (status.ok && !status.data?.hostConnected) {
        warn("Broker is running but extension is not connected.");
      } else {
        warn(`Could not connect to local broker (${status.error || "unknown error"}).`);
      }

      log(`
Open Chrome and:
- Verify the extension is loaded in chrome://extensions
- Click the OpenCode Browser extension icon to connect
`);

      const retry = await confirm("Retry broker check?");
      if (!retry) break;
    }
  }

  header("Installation Complete!");

  log(`
 ${color("bright", "What happens now:")}
  - The extension connects to the native host automatically.
  - OpenCode loads the plugin, which talks to the broker.
  - The broker enforces ${color("bright", "per-tab ownership")}. First touch auto-claims.

 ${color("bright", "Try it:")}
  Restart OpenCode and run: ${color("cyan", "browser_get_tabs")}
 `);
 }

async function update() {
  header("Update: Check Platform");

  const osName = OS_NAME;
  if (osName !== "darwin" && osName !== "linux" && osName !== "win32") {
    error(`Unsupported platform: ${osName}`);
    error("OpenCode Browser currently supports macOS, Linux, and Windows only.");
    process.exit(1);
  }
  success(`Platform: ${osName === "darwin" ? "macOS" : osName === "win32" ? "Windows" : "Linux"}`);

  header("Step 1: Copy Extension Files");

  ensureDir(BASE_DIR);
  const srcExtensionDir = join(PACKAGE_ROOT, "extension");
  copyDirRecursive(srcExtensionDir, EXTENSION_DIR);
  success(`Extension files copied to: ${EXTENSION_DIR}`);

  header("Step 2: Resolve Extension ID");

  let resolved = await resolveExtensionId({ allowPrompt: false, preferConfig: true });
  let extensionId = resolved.id;

  if (!extensionId) {
    log(`
We need the extension ID to register the native messaging host.

Find it at ${color("cyan", "chrome://extensions")}:
- Locate ${color("bright", "OpenCode Browser Automation")}
- Click ${color("bright", "Details")}
- Copy the ${color("bright", "ID")}
`);

    resolved = await resolveExtensionId({ allowPrompt: true, preferConfig: false });
    extensionId = resolved.id;
  } else if (resolved.source === "manifest") {
    success(`Using fixed extension ID from manifest: ${extensionId}`);
  } else if (resolved.source === "config") {
    success(`Using extension ID from config.json: ${extensionId}`);
  } else if (resolved.source === "override") {
    success(`Using extension ID override: ${extensionId}`);
  }

  if (!extensionId) {
    error("Extension ID is required to continue.");
    process.exit(1);
  }

  if (!/^[a-p]{32}$/i.test(extensionId)) {
    warn("That doesn't look like a Chrome extension ID (expected 32 chars a-p). Continuing anyway.");
  }

  const manifestId = getExtensionIdFromManifest();
  if (resolved.source === "config" && manifestId && manifestId !== extensionId) {
    warn(`Manifest key implies ${manifestId}, but config.json uses ${extensionId}. Run update with --extension-id ${manifestId} to switch.`);
  }

  header("Step 3: Install Local Host + Broker");

  const brokerSrc = join(PACKAGE_ROOT, "bin", "broker.cjs");
  const nativeHostSrc = join(PACKAGE_ROOT, "bin", "native-host.cjs");

  copyFileSync(brokerSrc, BROKER_DST);
  copyFileSync(nativeHostSrc, NATIVE_HOST_DST);

  try {
    chmodSync(BROKER_DST, 0o755);
  } catch {}
  try {
    chmodSync(NATIVE_HOST_DST, 0o755);
  } catch {}

  success(`Updated broker: ${BROKER_DST}`);
  success(`Updated native host: ${NATIVE_HOST_DST}`);

  const nodePath = resolveNodePath();
  if (!/node(\.exe)?$/.test(nodePath)) {
    warn(`Node not detected; using ${nodePath}. Set OPENCODE_BROWSER_NODE if needed.`);
  }
  const hostPath = writeHostWrapper(nodePath);
  success(`Updated host wrapper: ${hostPath}`);

  saveConfig({ extensionId, installedAt: new Date().toISOString(), nodePath });

  header("Step 4: Register Native Messaging Host");

  if (osName === "win32") {
    const manifestPath = writeWindowsNativeHostManifest(extensionId, hostPath);
    success(`Wrote native host manifest: ${manifestPath}`);
    registerWindowsNativeHost(manifestPath);
  } else {
    const hostDirs = getNativeHostDirs(osName);
    for (const dir of hostDirs) {
      try {
        writeNativeHostManifest(dir, extensionId, hostPath);
        success(`Wrote native host manifest: ${nativeHostManifestPath(dir)}`);
      } catch {
        warn(`Could not write native host manifest to: ${dir}`);
      }
    }
  }

  header("Update Complete!");

  log(`
 Reload the extension in ${color("cyan", "chrome://extensions")} and restart OpenCode.
 `);
}


async function status() {

  header("Status");

  success(`Base dir: ${BASE_DIR}`);
  success(`Extension dir present: ${existsSync(EXTENSION_DIR)}`);
  success(`Broker installed: ${existsSync(BROKER_DST)}`);
  success(`Native host installed: ${existsSync(NATIVE_HOST_DST)}`);
  success(`Host wrapper installed: ${existsSync(NATIVE_HOST_WRAPPER)}`);
  success(`Broker socket: ${BROKER_SOCKET}`);

  const cfg = loadConfig();
  if (cfg?.extensionId) {
    success(`Configured extension ID: ${cfg.extensionId}`);
  } else {
    warn("No config.json found (run install)");
  }

  const manifestId = getExtensionIdFromManifest();
  if (manifestId) {
    success(`Fixed extension ID (manifest): ${manifestId}`);
  }

  if (cfg?.nodePath) {
    success(`Node path: ${cfg.nodePath}`);
  }

  const osName = OS_NAME;
  if (osName === "win32") {
    reportWindowsNativeHostStatus();
  } else {
    const hostDirs = getNativeHostDirs(osName);
    let foundAny = false;
    for (const dir of hostDirs) {
      const p = nativeHostManifestPath(dir);
      if (existsSync(p)) {
        foundAny = true;
        success(`Native host manifest: ${p}`);
      }
    }
    if (!foundAny) {
      warn("No native host manifest found. Run: npx @different-ai/opencode-browser install");
    }
  }

  const brokerStatus = await getBrokerStatus(1000);
  if (brokerStatus.ok) {
    success(`Broker status: ok (hostConnected=${!!brokerStatus.data?.hostConnected})`);
  } else {
    warn(`Broker status: ${brokerStatus.error || "unavailable"}`);
  }
}

async function agentInstall() {
  header("Agent Browser Install");

  const extraArgs = process.argv.slice(3).join(" ");
  const command = `npx agent-browser install ${extraArgs}`.trim();
  try {
    execSync(command, { stdio: "inherit" });
    success("agent-browser install completed.");
  } catch (err) {
    error(`agent-browser install failed: ${err?.message || err}`);
  }
}

async function agentGateway() {
  header("Agent Browser Gateway");

  const gatewayPath = join(PACKAGE_ROOT, "bin", "agent-gateway.cjs");
  success(`Starting gateway: ${gatewayPath}`);

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [gatewayPath], { stdio: "inherit" });
    child.on("exit", resolve);
  });
}

async function uninstall() {
  header("Uninstall");

  const osName = OS_NAME;
  if (osName === "win32") {
    unregisterWindowsNativeHost();
    const manifestPath = nativeHostManifestPath(BASE_DIR);
    if (existsSync(manifestPath)) {
      try {
        unlinkSync(manifestPath);
        success(`Removed native host manifest: ${manifestPath}`);
      } catch {
        warn(`Could not remove: ${manifestPath}`);
      }
    }
  } else {
    const hostDirs = getNativeHostDirs(osName);
    for (const dir of hostDirs) {
      const p = nativeHostManifestPath(dir);
      if (!existsSync(p)) continue;
      try {
        unlinkSync(p);
        success(`Removed native host manifest: ${p}`);
      } catch {
        warn(`Could not remove: ${p}`);
      }
    }
  }

  const unixSocketPath = join(BASE_DIR, "broker.sock");
  for (const p of [BROKER_DST, NATIVE_HOST_DST, CONFIG_DST, unixSocketPath, BROKER_SOCKET]) {
    if (!existsSync(p)) continue;
    try {
      unlinkSync(p);
      success(`Removed: ${p}`);
    } catch {
      // ignore
    }
  }

  log(`
${color("bright", "Note:")}
- The unpacked extension folder remains at: ${EXTENSION_DIR}
- Remove it manually in ${color("cyan", "chrome://extensions")}
- Remove ${color("bright", "@different-ai/opencode-browser")} from your opencode.json/opencode.jsonc plugin list if desired.
`);
}

main().catch((e) => {
  error(e.message || String(e));
  process.exit(1);
});
