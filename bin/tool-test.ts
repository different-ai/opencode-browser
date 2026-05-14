import plugin from "../dist/plugin.js";

const toolName = process.argv[2] ?? "browser_list";
const rawArgs = process.argv[3];

let args: Record<string, unknown> = {
  browser_url: process.env.OPENCODE_BROWSER_URL || "http://127.0.0.1:9222",
};
if (rawArgs) {
  try {
    args = { ...args, ...JSON.parse(rawArgs) };
  } catch (error) {
    console.error("Args must be valid JSON.");
    console.error(String(error));
    process.exit(1);
  }
}

try {
  const pluginInstance = await (plugin as any)({});
  const tool = pluginInstance?.tool?.[toolName];
  if (!tool) {
    console.error(`Tool not found: ${toolName}`);
    process.exit(1);
  }

  const result = await tool.execute(args, {});
  if (typeof result === "string") {
    console.log(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exit(0);
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
