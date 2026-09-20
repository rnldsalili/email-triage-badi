import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "./api";

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

const useLatest = <T>(value: T) => {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
};

export interface ResourceOptions {
  enabled?: boolean;
  intervalMs?: number;
  key?: string;
}

export const useResource = <T>(
  loader: () => Promise<T>,
  options: ResourceOptions = {}
): Resource<T> => {
  const loaderRef = useLatest(loader);
  const { enabled = true, intervalMs, key } = options;
  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  // Only the newest request may write state; slower earlier responses are dropped.
  const load = useCallback(async () => {
    generation.current += 1;
    const { current } = generation;
    try {
      const next = await loaderRef.current();
      if (generation.current !== current) {
        return;
      }
      setData(next);
      setFailure(null);
    } catch (error) {
      if (generation.current !== current) {
        return;
      }
      setFailure(errorMessage(error));
    } finally {
      if (generation.current === current) {
        setLoading(false);
      }
    }
  }, [loaderRef]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setLoading(true);
    load();
  }, [enabled, load, attempt, key]);

  useEffect(() => {
    if (!enabled || !intervalMs) {
      return;
    }
    const timer = setInterval(() => {
      if (!document.hidden) {
        load();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, load]);

  const refresh = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { data, error: failure, loading, refresh };
};

export interface Action<Args extends unknown[]> {
  error: string | null;
  pending: boolean;
  run: (...args: Args) => Promise<void>;
}

const useActionRunner = <Args extends unknown[]>(
  action: (idempotencyKey: string, ...args: Args) => Promise<unknown>,
  onSuccess?: () => void
): Action<Args> => {
  const actionRef = useLatest(action);
  const successRef = useLatest(onSuccess);
  const pendingKey = useRef<{ key: string; signature: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = useCallback(
    async (...args: Args) => {
      // One key per intentional operation: a retry of the same payload reuses
      // it, while a changed payload gets a fresh key.
      const signature = JSON.stringify(args);
      if (pendingKey.current?.signature !== signature) {
        pendingKey.current = { key: crypto.randomUUID(), signature };
      }
      const { key } = pendingKey.current ?? { key: "" };
      setPending(true);
      setFailure(null);
      try {
        await actionRef.current(key, ...args);
        pendingKey.current = null;
        successRef.current?.();
      } catch (error) {
        setFailure(errorMessage(error));
      } finally {
        setPending(false);
      }
    },
    [actionRef, successRef]
  );

  return { error: failure, pending, run };
};

/** Action without request-level idempotency (intrinsically repeatable requests). */
export const useAction = <Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown>,
  onSuccess?: () => void
): Action<Args> => useActionRunner<Args>((_key, ...args) => action(...args), onSuccess);

/** Action that reuses an idempotency key when the same payload is retried. */
export const useKeyedAction = <Args extends unknown[]>(
  action: (idempotencyKey: string, ...args: Args) => Promise<unknown>,
  onSuccess?: () => void
): Action<Args> => useActionRunner<Args>(action, onSuccess);
