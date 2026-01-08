#!/usr/bin/env node
/**
 * OpenCode Browser - CLI
 *
 * Commands:
 *   install  - Install Chrome extension
 *   serve    - Run MCP server (used by OpenCode)
 *   status   - Check connection status
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, unlinkSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";
import { createInterface } from "readline";

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
  const command = process.argv[2];

  if (command === "serve") {
    // Run MCP server - this is called by OpenCode
    await serve();
  } else if (command === "install") {
    await showHeader();
    await install();
    rl.close();
  } else if (command === "uninstall") {
    await showHeader();
    await uninstall();
    rl.close();
  } else if (command === "status") {
    await showHeader();
    await status();
    rl.close();
  } else {
    await showHeader();
    log(`
${color("bright", "Usage:")}
  npx @different-ai/opencode-browser install     Install extension
  npx @different-ai/opencode-browser uninstall   Remove installation
  npx @different-ai/opencode-browser status      Check status
  npx @different-ai/opencode-browser serve       Run MCP server (internal)

${color("bright", "Quick Start:")}
  1. Run: npx @different-ai/opencode-browser install
  2. Add to your opencode.json:
     ${color("cyan", `"mcp": { "browser": { "type": "local", "command": ["bunx", "@different-ai/opencode-browser", "serve"] } }`)}
  3. Restart OpenCode
`);
    rl.close();
  }
}

async function showHeader() {
  console.log(`
${color("cyan", color("bright", "OpenCode Browser v2.1"))}
${color("cyan", "Browser automation MCP server for OpenCode")}
`);
}

async function serve() {
  // Launch the MCP server
  const serverPath = join(PACKAGE_ROOT, "src", "mcp-server.ts");
  
  // Use bun to run the TypeScript server
  const child = spawn("bun", ["run", serverPath], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (err) => {
    console.error("[browser-mcp] Failed to start server:", err);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code || 0);
  });

  // Forward signals to child
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
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

  header("Step 2: Copy Extension Files");

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

  header("Step 3: Load Extension in Chrome");

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
`);

  await ask(color("bright", "Press Enter when you've loaded the extension..."));

  header("Step 4: Configure OpenCode");

  const mcpConfig = {
    browser: {
      type: "local",
      command: ["bunx", "@different-ai/opencode-browser", "serve"],
    },
  };

  log(`
Add the MCP server to your ${color("cyan", "opencode.json")}:

${color("bright", JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: mcpConfig }, null, 2))}

Or if you already have an opencode.json, add to the "mcp" object:
${color("bright", JSON.stringify({ mcp: mcpConfig }, null, 2))}
`);

  const opencodeJsonPath = join(process.cwd(), "opencode.json");

  if (existsSync(opencodeJsonPath)) {
    const shouldUpdate = await confirm(`Found opencode.json. Add MCP server automatically?`);

    if (shouldUpdate) {
      try {
        const config = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
        config.mcp = config.mcp || {};
        config.mcp.browser = mcpConfig.browser;
        
        // Remove old plugin config if present
        if (config.plugin && Array.isArray(config.plugin)) {
          const idx = config.plugin.indexOf("@different-ai/opencode-browser");
          if (idx !== -1) {
            config.plugin.splice(idx, 1);
            warn("Removed old plugin entry (replaced by MCP)");
          }
          if (config.plugin.length === 0) {
            delete config.plugin;
          }
        }
        
        writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + "\n");
        success("Updated opencode.json with MCP server");
      } catch (e) {
        error(`Failed to update opencode.json: ${e.message}`);
        log("Please add the MCP config manually.");
      }
    }
  } else {
    const shouldCreate = await confirm(`No opencode.json found. Create one?`);

    if (shouldCreate) {
      try {
        const config = {
          $schema: "https://opencode.ai/config.json",
          mcp: mcpConfig,
        };
        writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + "\n");
        success("Created opencode.json with MCP server");
      } catch (e) {
        error(`Failed to create opencode.json: ${e.message}`);
      }
    }
  }

  // Clean up old daemon/plugin if present
  header("Step 5: Cleanup (migration)");

  const oldDaemonPlist = join(homedir(), "Library", "LaunchAgents", "com.opencode.browser-daemon.plist");
  if (existsSync(oldDaemonPlist)) {
    try {
      execSync(`launchctl unload "${oldDaemonPlist}" 2>/dev/null || true`, { stdio: "ignore" });
      unlinkSync(oldDaemonPlist);
      success("Removed old daemon (no longer needed)");
    } catch {
      warn("Could not remove old daemon plist. Remove manually if needed.");
    }
  }

  // Remove old lock file
  const oldLockFile = join(homedir(), ".opencode-browser", "lock.json");
  if (existsSync(oldLockFile)) {
    try {
      unlinkSync(oldLockFile);
      success("Removed old lock file (not needed with MCP)");
    } catch {}
  }

  success("Cleanup complete");

  header("Installation Complete!");

  log(`
${color("green", "")} Extension: ${extensionDir}
${color("green", "")} MCP Server: @different-ai/opencode-browser

${color("bright", "How it works:")}
  1. OpenCode spawns MCP server on demand
  2. MCP server starts WebSocket server on port 19222
  3. Chrome extension connects automatically
  4. Browser tools are available to any OpenCode session!

${color("bright", "Available tools:")}
  browser_status      - Check if browser is connected
  browser_navigate    - Go to a URL
  browser_click       - Click an element
  browser_type        - Type into an input
  browser_screenshot  - Capture the page
  browser_snapshot    - Get accessibility tree + all links
  browser_get_tabs    - List open tabs
  browser_scroll      - Scroll the page
  browser_wait        - Wait for duration
  browser_execute     - Run JavaScript

${color("bright", "Benefits of MCP architecture:")}
  - No session conflicts between OpenCode instances
  - Server runs independently of OpenCode process
  - Clean separation of concerns

${color("bright", "Test it:")}
  Restart OpenCode and try: ${color("cyan", '"Check browser status"')}
`);
}

async function status() {
  header("Browser Status");

  // Check if port 19222 is in use
  try {
    const result = execSync("lsof -i :19222 2>/dev/null || true", { encoding: "utf-8" });
    if (result.trim()) {
      success("WebSocket server is running on port 19222");
      log(result);
    } else {
      warn("WebSocket server not running (starts on demand via MCP)");
    }
  } catch {
    warn("Could not check port status");
  }

  // Check extension directory
  const extensionDir = join(homedir(), ".opencode-browser", "extension");
  if (existsSync(extensionDir)) {
    success(`Extension installed at: ${extensionDir}`);
  } else {
    warn("Extension not installed. Run: npx @different-ai/opencode-browser install");
  }
}

async function uninstall() {
  header("Uninstalling OpenCode Browser");

  // Remove old daemon
  const os = platform();
  if (os === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.opencode.browser-daemon.plist");
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { stdio: "ignore" });
        unlinkSync(plistPath);
        success("Removed daemon plist");
      } catch {}
    }
  }

  // Remove native host registration (v1.x)
  const nativeHostDir =
    os === "darwin"
      ? join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
      : join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");

  const manifestPath = join(nativeHostDir, "com.opencode.browser_automation.json");
  if (existsSync(manifestPath)) {
    unlinkSync(manifestPath);
    success("Removed native host registration");
  }

  // Remove lock file
  const lockFile = join(homedir(), ".opencode-browser", "lock.json");
  if (existsSync(lockFile)) {
    unlinkSync(lockFile);
    success("Removed lock file");
  }

  log(`
${color("bright", "Note:")} Extension files at ~/.opencode-browser/ were not removed.
Remove manually if needed:
  rm -rf ~/.opencode-browser/

Also remove the "browser" entry from your opencode.json mcp section.
`);
}

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
