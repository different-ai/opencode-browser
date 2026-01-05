#!/usr/bin/env node
/**
 * OpenCode Browser - CLI Installer
 * 
 * Installs the Chrome extension and native messaging host for browser automation.
 */

import { createInterface } from "readline";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, "..");

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function color(c, text) {
  return `${COLORS[c]}${text}${COLORS.reset}`;
}

function log(msg) {
  console.log(msg);
}

function success(msg) {
  console.log(color("green", "✓ " + msg));
}

function warn(msg) {
  console.log(color("yellow", "⚠ " + msg));
}

function error(msg) {
  console.log(color("red", "✗ " + msg));
}

function header(msg) {
  console.log("\n" + color("cyan", color("bright", msg)));
  console.log(color("cyan", "─".repeat(msg.length)));
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function confirm(question) {
  const answer = await ask(`${question} (y/n): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function main() {
  console.log(`
${color("cyan", color("bright", "╔═══════════════════════════════════════════════════════════╗"))}
${color("cyan", color("bright", "║"))}        ${color("bright", "OpenCode Browser")} - Browser Automation for OpenCode       ${color("cyan", color("bright", "║"))}
${color("cyan", color("bright", "║"))}                                                           ${color("cyan", color("bright", "║"))}
${color("cyan", color("bright", "║"))}  Inspired by Claude in Chrome - browser automation that   ${color("cyan", color("bright", "║"))}
${color("cyan", color("bright", "║"))}  works with your existing logins and bookmarks.           ${color("cyan", color("bright", "║"))}
${color("cyan", color("bright", "╚═══════════════════════════════════════════════════════════╝"))}
`);

  const command = process.argv[2];

  if (command === "install") {
    await install();
  } else if (command === "uninstall") {
    await uninstall();
  } else if (command === "daemon") {
    await startDaemon();
  } else if (command === "daemon-install") {
    await installDaemon();
  } else if (command === "start") {
    rl.close();
    await import("../src/server.js");
    return;
  } else {
    log(`
${color("bright", "Usage:")}
  npx @different-ai/opencode-browser install         Install extension
  npx @different-ai/opencode-browser daemon-install  Install background daemon
  npx @different-ai/opencode-browser daemon          Run daemon (foreground)
  npx @different-ai/opencode-browser start           Run MCP server
  npx @different-ai/opencode-browser uninstall       Remove installation

${color("bright", "With bun:")}
  bunx @different-ai/opencode-browser install

${color("bright", "For scheduled jobs:")}
  Run 'daemon-install' to enable browser tools in background jobs.
`);
  }

  rl.close();
}

async function install() {
  header("Step 1: Check Platform");

  const os = platform();
  if (os !== "darwin" && os !== "linux") {
    error(`Unsupported platform: ${os}`);
    error("OpenCode Browser currently supports macOS and Linux only.");
    process.exit(1);
  }
  success(`Platform: ${os === "darwin" ? "macOS" : "Linux"}`);

  header("Step 2: Install Extension Directory");

  const extensionDir = join(homedir(), ".opencode-browser", "extension");
  const srcExtensionDir = join(PACKAGE_ROOT, "extension");

  mkdirSync(extensionDir, { recursive: true });

  const files = readdirSync(srcExtensionDir, { recursive: true });
  for (const file of files) {
    const srcPath = join(srcExtensionDir, file);
    const destPath = join(extensionDir, file);
    
    try {
      const stat = readdirSync(srcPath);
      mkdirSync(destPath, { recursive: true });
    } catch {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }

  success(`Extension files copied to: ${extensionDir}`);

  header("Step 3: Load Extension in Browser");

  log(`
Works with: ${color("cyan", "Chrome")}, ${color("cyan", "Brave")}, ${color("cyan", "Arc")}, ${color("cyan", "Edge")}, and other Chromium browsers.

To load the extension:

1. Open your browser and go to: ${color("cyan", "chrome://extensions")}
   (or ${color("cyan", "brave://extensions")}, ${color("cyan", "arc://extensions")}, etc.)

2. Enable ${color("bright", "Developer mode")} (toggle in top right)

3. Click ${color("bright", "Load unpacked")}

4. Select this folder:
   ${color("cyan", extensionDir)}
   ${os === "darwin" ? color("yellow", "Tip: Press Cmd+Shift+G and paste the path above") : ""}

5. Copy the ${color("bright", "Extension ID")} shown under the extension name
   (looks like: abcdefghijklmnopqrstuvwxyz123456)
`);

  log("");
  const extensionId = await ask(color("bright", "Enter your Extension ID: "));

  if (!extensionId) {
    error("Extension ID is required");
    process.exit(1);
  }

  if (!/^[a-z]{32}$/.test(extensionId)) {
    warn("Extension ID format looks unusual (expected 32 lowercase letters)");
    const proceed = await confirm("Continue anyway?");
    if (!proceed) process.exit(1);
  }

  header("Step 4: Register Native Messaging Host");

  const nativeHostDir = os === "darwin"
    ? join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");

  mkdirSync(nativeHostDir, { recursive: true });

  const nodePath = process.execPath;
  const hostScriptPath = join(PACKAGE_ROOT, "src", "host.js");

  const wrapperDir = join(homedir(), ".opencode-browser");
  const wrapperPath = join(wrapperDir, "host-wrapper.sh");
  
  writeFileSync(wrapperPath, `#!/bin/bash
exec "${nodePath}" "${hostScriptPath}" "$@"
`, { mode: 0o755 });

  const manifest = {
    name: "com.opencode.browser_automation",
    description: "OpenCode Browser Automation Native Messaging Host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  const manifestPath = join(nativeHostDir, "com.opencode.browser_automation.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  success(`Native host registered at: ${manifestPath}`);

  const logsDir = join(homedir(), ".opencode-browser", "logs");
  mkdirSync(logsDir, { recursive: true });

  header("Step 5: Configure OpenCode");

  const serverPath = join(PACKAGE_ROOT, "src", "server.js");
  const mcpConfig = {
    browser: {
      type: "local",
      command: ["node", serverPath],
      enabled: true,
    },
  };

  log(`
Add this to your ${color("cyan", "opencode.json")} under "mcp":

${color("bright", JSON.stringify(mcpConfig, null, 2))}
`);

  const opencodeJsonPath = join(process.cwd(), "opencode.json");
  let shouldUpdateConfig = false;

  if (existsSync(opencodeJsonPath)) {
    shouldUpdateConfig = await confirm(`Found opencode.json in current directory. Add browser config automatically?`);
    
    if (shouldUpdateConfig) {
      try {
        const config = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
        config.mcp = config.mcp || {};
        config.mcp.browser = mcpConfig.browser;
        writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + "\n");
        success("Updated opencode.json with browser MCP config");
      } catch (e) {
        error(`Failed to update opencode.json: ${e.message}`);
        log("Please add the config manually.");
      }
    }
  } else {
    const shouldCreate = await confirm(`No opencode.json found. Create one with browser config?`);
    
    if (shouldCreate) {
      try {
        const config = { "$schema": "https://opencode.ai/config.json", mcp: mcpConfig };
        writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + "\n");
        success("Created opencode.json with browser MCP config");
        shouldUpdateConfig = true;
      } catch (e) {
        error(`Failed to create opencode.json: ${e.message}`);
      }
    } else {
      log(`Add the config above to your project's opencode.json manually.`);
    }
  }

  header("Installation Complete!");

  log(`
${color("green", "✓")} Extension installed at: ${extensionDir}
${color("green", "✓")} Native host registered
${shouldUpdateConfig ? color("green", "✓") + " opencode.json updated" : color("yellow", "○") + " Remember to update opencode.json"}

${color("bright", "Next steps:")}
1. ${color("cyan", "Restart Chrome")} (close all windows and reopen)
2. Click the extension icon to verify connection
3. Restart OpenCode to load the new MCP server

${color("bright", "Available tools:")}
  browser_navigate   - Go to a URL
  browser_click      - Click an element
  browser_type       - Type into an input
  browser_screenshot - Capture the page
  browser_snapshot   - Get accessibility tree
  browser_get_tabs   - List open tabs
  browser_scroll     - Scroll the page
  browser_wait       - Wait for duration
  browser_execute    - Run JavaScript

${color("bright", "Logs:")} ~/.opencode-browser/logs/

${color("bright", "Test it out:")}
  Open OpenCode and try: ${color("cyan", '"Navigate to google.com and take a snapshot"')}
`);
}

async function startDaemon() {
  const { spawn } = await import("child_process");
  const daemonPath = join(PACKAGE_ROOT, "src", "daemon.js");
  log("Starting daemon...");
  const child = spawn(process.execPath, [daemonPath], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code || 0));
}

async function installDaemon() {
  header("Installing Background Daemon");
  
  const os = platform();
  if (os !== "darwin") {
    error("Daemon auto-install currently supports macOS only");
    log("On Linux, create a systemd service manually.");
    process.exit(1);
  }
  
  const nodePath = process.execPath;
  const daemonPath = join(PACKAGE_ROOT, "src", "daemon.js");
  const logsDir = join(homedir(), ".opencode-browser", "logs");
  
  mkdirSync(logsDir, { recursive: true });
  
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opencode.browser-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logsDir}/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/daemon.log</string>
</dict>
</plist>`;

  const plistPath = join(homedir(), "Library", "LaunchAgents", "com.opencode.browser-daemon.plist");
  writeFileSync(plistPath, plist);
  success(`Created launchd plist: ${plistPath}`);
  
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
    execSync(`launchctl load "${plistPath}"`);
    success("Daemon started");
  } catch (e) {
    error(`Failed to load daemon: ${e.message}`);
  }
  
  log(`
${color("green", "✓")} Daemon installed and running

The daemon bridges Chrome extension ↔ MCP server.
It runs automatically on login and enables browser
tools in scheduled OpenCode jobs.

${color("bright", "Logs:")} ${logsDir}/daemon.log

${color("bright", "Control:")}
  launchctl stop com.opencode.browser-daemon
  launchctl start com.opencode.browser-daemon
  launchctl unload ~/Library/LaunchAgents/com.opencode.browser-daemon.plist
`);
}

async function uninstall() {
  header("Uninstalling OpenCode Browser");

  const os = platform();
  const nativeHostDir = os === "darwin"
    ? join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");

  const manifestPath = join(nativeHostDir, "com.opencode.browser_automation.json");

  if (existsSync(manifestPath)) {
    const { unlinkSync } = await import("fs");
    unlinkSync(manifestPath);
    success("Removed native host registration");
  } else {
    warn("Native host manifest not found");
  }

  log(`
${color("bright", "Note:")} The extension files at ~/.opencode-browser/ were not removed.
Remove them manually if needed:
  rm -rf ~/.opencode-browser/

Also remove the "browser" entry from your opencode.json.
`);
}

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
