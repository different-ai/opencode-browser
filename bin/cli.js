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
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, "..");

const BASE_DIR = join(homedir(), ".opencode-browser");
const EXTENSION_DIR = join(BASE_DIR, "extension");
const BROKER_DST = join(BASE_DIR, "broker.cjs");
const NATIVE_HOST_DST = join(BASE_DIR, "native-host.cjs");
const CONFIG_DST = join(BASE_DIR, "config.json");

const NATIVE_HOST_NAME = "com.opencode.browser_automation";

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

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
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

function writeNativeHostManifest(dir, extensionId) {
  ensureDir(dir);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "OpenCode Browser native messaging host",
    path: NATIVE_HOST_DST,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  writeFileSync(nativeHostManifestPath(dir), JSON.stringify(manifest, null, 2) + "\n");
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

async function main() {
  const command = process.argv[2];

  console.log(`
${color("cyan", color("bright", "OpenCode Browser v4"))}
${color("cyan", "Browser automation plugin (native messaging + per-tab ownership)")}
`);

  if (command === "install") {
    await install();
  } else if (command === "uninstall") {
    await uninstall();
  } else if (command === "status") {
    await status();
  } else {
    log(`
${color("bright", "Usage:")}
  npx @different-ai/opencode-browser install
  npx @different-ai/opencode-browser status
  npx @different-ai/opencode-browser uninstall

${color("bright", "Quick Start:")}
  1. Run: npx @different-ai/opencode-browser install
  2. Restart OpenCode
  3. Use: browser_navigate / browser_click / browser_snapshot
`);
  }

  rl.close();
}

async function install() {
  header("Step 1: Check Platform");

  const osName = platform();
  if (osName !== "darwin" && osName !== "linux") {
    error(`Unsupported platform: ${osName}`);
    error("OpenCode Browser currently supports macOS and Linux only.");
    process.exit(1);
  }
  success(`Platform: ${osName === "darwin" ? "macOS" : "Linux"}`);

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

  header("Step 4: Get Extension ID");

  log(`
We need the extension ID to register the native messaging host.

Find it at ${color("cyan", "chrome://extensions")}:
- Locate ${color("bright", "OpenCode Browser Automation")}
- Click ${color("bright", "Details")}
- Copy the ${color("bright", "ID")}
`);

  const extensionId = await ask(color("bright", "Paste Extension ID: "));
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

  saveConfig({ extensionId, installedAt: new Date().toISOString() });

  header("Step 6: Register Native Messaging Host");

  const hostDirs = getNativeHostDirs(osName);
  for (const dir of hostDirs) {
    try {
      writeNativeHostManifest(dir, extensionId);
      success(`Wrote native host manifest: ${nativeHostManifestPath(dir)}`);
    } catch (e) {
      warn(`Could not write native host manifest to: ${dir}`);
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

  function findOpenCodeConfigPath(configDir) {
    const jsoncPath = join(configDir, "opencode.jsonc");
    if (existsSync(jsoncPath)) return jsoncPath;
    const jsonPath = join(configDir, "opencode.json");
    return jsonPath;
  }

  const configOptions = [
    "1) Project (./opencode.json or opencode.jsonc)",
    "2) Global (~/.config/opencode/opencode.json)",
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
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    configDir = xdgConfig ? join(xdgConfig, "opencode") : join(homedir(), ".config", "opencode");
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
        const config = hasExistingConfig
          ? JSON.parse(stripJsoncComments(readFileSync(configPath, "utf-8")))
          : { $schema: "https://opencode.ai/config.json", plugin: [] };

        config.plugin = normalizePlugins(config.plugin);
        if (!config.plugin.includes(desiredPlugin)) config.plugin.push(desiredPlugin);
        if (typeof config.$schema !== "string") config.$schema = "https://opencode.ai/config.json";

        ensureDir(configDir);
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        success(`Updated ${configPath} with plugin`);
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

async function status() {
  header("Status");

  success(`Base dir: ${BASE_DIR}`);
  success(`Extension dir present: ${existsSync(EXTENSION_DIR)}`);
  success(`Broker installed: ${existsSync(BROKER_DST)}`);
  success(`Native host installed: ${existsSync(NATIVE_HOST_DST)}`);

  const cfg = loadConfig();
  if (cfg?.extensionId) {
    success(`Configured extension ID: ${cfg.extensionId}`);
  } else {
    warn("No config.json found (run install)");
  }

  const osName = platform();
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

async function uninstall() {
  header("Uninstall");

  const osName = platform();
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

  for (const p of [BROKER_DST, NATIVE_HOST_DST, CONFIG_DST, join(BASE_DIR, "broker.sock")]) {
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
