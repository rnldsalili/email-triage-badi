import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const DEV_VARS_PATH = ".dev.vars";

export const loadDevVars = (): Record<string, string> => {
  if (!existsSync(DEV_VARS_PATH)) {
    return {};
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(DEV_VARS_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
};

export const saveDevVars = (updates: Record<string, string>): void => {
  const existing = loadDevVars();
  const merged = { ...existing, ...updates };
  const body = Object.entries(merged)
    .map(([key, value]) => `${key}="${value}"`)
    .join("\n");
  writeFileSync(DEV_VARS_PATH, `${body}\n`, { mode: 0o600 });
};
