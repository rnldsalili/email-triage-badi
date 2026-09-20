export interface DecodedText {
  text: string;
  charset: string;
  warning?: string;
}

export const decodeBase64Url = (data: string): Uint8Array => {
  const normalized = data.replaceAll("-", "+").replaceAll("_", "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
};

export const decodeText = (
  bytes: Uint8Array,
  charset: string | undefined
): DecodedText => {
  const label = (charset ?? "utf-8").trim().toLowerCase() || "utf-8";
  try {
    return {
      charset: label,
      text: new TextDecoder(label, { fatal: false, ignoreBOM: false }).decode(bytes),
    };
  } catch {
    return {
      charset: "utf-8",
      text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes),
      warning: `unsupported_charset:${label}`,
    };
  }
};

export const decodeBodyData = (data: string, charset: string | undefined): DecodedText =>
  decodeText(decodeBase64Url(data), charset);

export const headerMap = (
  headers: { name: string; value: string }[] | undefined
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const header of headers ?? []) {
    const key = header.name.trim().toLowerCase();
    if (!map.has(key)) {
      map.set(key, header.value);
    }
  }
  return map;
};

export const parseAddressList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  const addresses: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const character of value) {
    if (character === '"') {
      inQuotes = !inQuotes;
      current += character;
      continue;
    }
    if (character === "," && !inQuotes) {
      addresses.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  addresses.push(current);

  return addresses
    .map((entry) => {
      const angleMatch = /<(?<address>[^>]+)>/u.exec(entry);
      return (angleMatch?.groups?.address ?? entry).trim().replaceAll(/^"|"$/gu, "");
    })
    .filter((entry) => entry.length > 0);
};

export const truncate = (value: string, maxCharacters: number): string => {
  if (value.length <= maxCharacters) {
    return value;
  }
  return `${value.slice(0, maxCharacters)}[truncated]`;
};
