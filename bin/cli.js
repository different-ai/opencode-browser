#!/usr/bin/env node

import plugin from "../dist/plugin.js";

const DEFAULT_BROWSER_URL = process.env.OPENCODE_BROWSER_URL || "http://127.0.0.1:9222";

function usage() {
  console.log(`OpenCode Chrome DevTools

Usage:
  opencode-chrome-devtools tools
  opencode-chrome-devtools tool <toolName> [argsJson]
  opencode-chrome-devtools tool <toolName> --args '{"browser_url":"http://127.0.0.1:9222"}'
  opencode-chrome-devtools status [browser_url]
  opencode-chrome-devtools self-test [browser_url]

Every browser tool uses direct CDP. Start Chrome with remote debugging enabled, for example:
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222

If browser_url is omitted for CLI calls, OPENCODE_BROWSER_URL is used, then ${DEFAULT_BROWSER_URL}.
`);
}

async function loadPluginTools() {
  const instance = await plugin({});
  const tools = instance?.tool;
  if (!tools || typeof tools !== "object") {
    throw new Error("Plugin did not expose any tools");
  }
  return tools;
}

function parseToolArgs(argv) {
  const argsFlagIndex = argv.findIndex((arg) => arg === "--args");
  const raw = argsFlagIndex >= 0 ? argv[argsFlagIndex + 1] : argv[0];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Args must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function withDefaultBrowserUrl(args) {
  return {
    browser_url: DEFAULT_BROWSER_URL,
    ...args,
  };
}

async function executeTool(toolName, args = {}) {
  const tools = await loadPluginTools();
  const selected = tools[toolName];
  if (!selected || typeof selected.execute !== "function") {
    throw new Error(`Unknown tool: ${toolName}. Available: ${Object.keys(tools).sort().join(", ")}`);
  }
  return await selected.execute(withDefaultBrowserUrl(args), {});
}

async function listTools() {
  const tools = await loadPluginTools();
  for (const name of Object.keys(tools).sort()) {
    console.log(`${name}\n  ${tools[name]?.description || "(no description)"}`);
  }
}

async function runTool(argv) {
  const toolName = argv[0];
  if (!toolName) throw new Error("Usage: opencode-chrome-devtools tool <toolName> [argsJson]");
  const args = parseToolArgs(argv.slice(1));
  const result = await executeTool(toolName, args);
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

async function status(browserUrl) {
  const result = await executeTool("browser_list", { browser_url: browserUrl || DEFAULT_BROWSER_URL });
  console.log(result);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "tools") {
    await listTools();
    return;
  }

  if (command === "tool") {
    await runTool(rest);
    return;
  }

  if (command === "status" || command === "self-test") {
    await status(rest[0]);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
