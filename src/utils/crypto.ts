export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const safeTokenEqual = async (
  provided: string,
  expected: string
): Promise<boolean> => {
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(provided)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedDigest, expectedDigest);
};
