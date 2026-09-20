export const utcDateString = (nowMs: number): string =>
  new Date(nowMs).toISOString().slice(0, 10);

export const nextUtcMidnight = (nowMs: number): number => {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
};
