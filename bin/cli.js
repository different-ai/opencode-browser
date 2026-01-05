#!/usr/bin/env node
/**
 * OpenCode Browser - CLI Installer
 *
 * Installs the Chrome extension for browser automation.
 * v2.0: Plugin-based architecture (no daemon, no MCP server)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, unlinkSync } from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
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
  console.log(`
${color("cyan", color("bright", "OpenCode Browser v2.0"))}
${color("cyan", "Browser automation for OpenCode")}
`);

  const command = process.argv[2];

  if (command === "install") {
    await install();
  } else if (command === "uninstall") {
    await uninstall();
  } else if (command === "status") {
    await status();
  } else {
    log(`
${color("bright", "Usage:")}
  npx @different-ai/opencode-browser install     Install extension
  npx @different-ai/opencode-browser uninstall   Remove installation
  npx @different-ai/opencode-browser status      Check lock status

${color("bright", "v2.0 Changes:")}
  - Plugin-based architecture (no daemon needed)
  - Add plugin to opencode.json, load extension in Chrome, done
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

  const pluginConfig = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@different-ai/opencode-browser"]
}`;

  log(`
Add the plugin to your ${color("cyan", "opencode.json")}:

${color("bright", pluginConfig)}

Or if you already have an opencode.json, just add to the "plugin" array:
${color("bright", '"plugin": ["@different-ai/opencode-browser"]')}
`);

  const opencodeJsonPath = join(process.cwd(), "opencode.json");

  if (existsSync(opencodeJsonPath)) {
    const shouldUpdate = await confirm(`Found opencode.json. Add plugin automatically?`);

    if (shouldUpdate) {
      try {
        const config = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
        config.plugin = config.plugin || [];
        if (!config.plugin.includes("@different-ai/opencode-browser")) {
          config.plugin.push("@different-ai/opencode-browser");
        }
        // Remove old MCP config if present
        if (config.mcp?.browser) {
          delete config.mcp.browser;
          if (Object.keys(config.mcp).length === 0) {
            delete config.mcp;
          }
          warn("Removed old MCP browser config (replaced by plugin)");
        }
        writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + "\n");
        success("Updated opencode.json with plugin");
      } catch (e) {
        error(`Failed to update opencode.json: ${e.message}`);
        log("Please add the plugin manually.");
      }
    }
  } else {
    const shouldCreate = await confirm(`No opencode.json found. Create one?`);

    if (shouldCreate) {
      try {
        const config = {
          $schema: "https://opencode.ai/config.json",
          plugin: ["@different-ai/opencode-browser"],
        };
        writeFileSync(opencodeJsonPath, JSON.stringify(config, null, 2) + "\n");
        success("Created opencode.json with plugin");
      } catch (e) {
        error(`Failed to create opencode.json: ${e.message}`);
      }
    }
  }

  // Clean up old daemon if present
  header("Step 5: Cleanup (v1.x migration)");

  const oldDaemonPlist = join(homedir(), "Library", "LaunchAgents", "com.opencode.browser-daemon.plist");
  if (existsSync(oldDaemonPlist)) {
    try {
      execSync(`launchctl unload "${oldDaemonPlist}" 2>/dev/null || true`, { stdio: "ignore" });
      unlinkSync(oldDaemonPlist);
      success("Removed old daemon (no longer needed in v2.0)");
    } catch {
      warn("Could not remove old daemon plist. Remove manually if needed.");
    }
  } else {
    success("No old daemon to clean up");
  }

  header("Installation Complete!");

  log(`
${color("green", "")} Extension: ${extensionDir}
${color("green", "")} Plugin: @different-ai/opencode-browser

${color("bright", "How it works:")}
  1. OpenCode loads the plugin on startup
  2. Plugin starts WebSocket server on port 19222
  3. Chrome extension connects automatically
  4. Browser tools are available!

${color("bright", "Available tools:")}
  browser_status      - Check if browser is available
  browser_kill_session - Take over from another session
  browser_navigate    - Go to a URL
  browser_click       - Click an element
  browser_type        - Type into an input
  browser_screenshot  - Capture the page
  browser_snapshot    - Get accessibility tree
  browser_get_tabs    - List open tabs
  browser_scroll      - Scroll the page
  browser_wait        - Wait for duration
  browser_execute     - Run JavaScript

${color("bright", "Multi-session:")}
  Only one OpenCode session can use browser at a time.
  Use browser_status to check, browser_kill_session to take over.

${color("bright", "Test it:")}
  Restart OpenCode and try: ${color("cyan", '"Check browser status"')}
`);
}

async function status() {
  header("Browser Lock Status");

  const lockFile = join(homedir(), ".opencode-browser", "lock.json");

  if (!existsSync(lockFile)) {
    success("Browser available (no lock file)");
    return;
  }

  try {
    const lock = JSON.parse(readFileSync(lockFile, "utf-8"));
    log(`
Lock file: ${lockFile}

PID: ${lock.pid}
Session: ${lock.sessionId}
Started: ${lock.startedAt}
Working directory: ${lock.cwd}
`);

    // Check if process is alive
    try {
      process.kill(lock.pid, 0);
      warn(`Process ${lock.pid} is running. Browser is locked.`);
    } catch {
      success(`Process ${lock.pid} is dead. Lock is stale and will be auto-cleaned.`);
    }
  } catch (e) {
    error(`Could not read lock file: ${e.message}`);
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

Also remove "@different-ai/opencode-browser" from your opencode.json plugin array.
`);
}

main().catch((e) => {
  error(e.message);
  process.exit(1);
});
