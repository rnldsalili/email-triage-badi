import { useEffect, useState } from "react";

export type Route =
  | { name: "overview" }
  | { name: "messages" }
  | { name: "message"; messageId: string }
  | { name: "activity" }
  | { name: "labels" };

const decodeSegment = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseHash = (hash: string): Route => {
  const path = hash.replace(/^#\/?/u, "");
  const [head, tail] = path.split("/");
  if (head === "messages" && tail) {
    return { messageId: decodeSegment(tail), name: "message" };
  }
  if (head === "messages") {
    return { name: "messages" };
  }
  if (head === "activity") {
    return { name: "activity" };
  }
  if (head === "labels") {
    return { name: "labels" };
  }
  return { name: "overview" };
};

export const navigate = (path: string): void => {
  window.location.hash = path;
};

export const useHashRoute = (): Route => {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
};
