export const formatDateTime = (value: string | null): string => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
};

export const formatRelative = (value: string | null): string => {
  if (!value) {
    return "never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

export const truncate = (value: string | null, max: number): string => {
  if (!value) {
    return "—";
  }
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export const humanize = (value: string | null | undefined): string => {
  if (!value) {
    return "—";
  }
  return value.replaceAll("_", " ");
};

export const actionLabel = (value: boolean | null): string => {
  if (value === true) {
    return "Yes";
  }
  if (value === false) {
    return "No";
  }
  return "Uncertain";
};

export const gmailLink = (messageId: string): string =>
  `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`;

export const formatProgress = (progress: Record<string, unknown> | null): string => {
  if (!progress) {
    return "—";
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(progress)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof value === "object") {
      const count = Array.isArray(value) ? value.length : Object.keys(value).length;
      parts.push(`${key}: ${count}`);
      continue;
    }
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.length > 0 ? parts.join(", ") : "—";
};
