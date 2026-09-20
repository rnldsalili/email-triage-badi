import { ApiError } from "./errors";

export interface DecodedCursor {
  id: string;
  sortKey: number;
}

export const encodeCursor = (sortKey: number, id: string): string =>
  btoa(`${sortKey}:${id}`).replaceAll("+", "-").replaceAll("/", "_");

export const decodeCursor = (cursor: string): DecodedCursor => {
  let decoded: string;
  try {
    decoded = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Invalid cursor");
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) {
    throw new ApiError("VALIDATION_ERROR", "Invalid cursor");
  }
  const sortKey = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isFinite(sortKey) || !id) {
    throw new ApiError("VALIDATION_ERROR", "Invalid cursor");
  }
  return { id, sortKey };
};
