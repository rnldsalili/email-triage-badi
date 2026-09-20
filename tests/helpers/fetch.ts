export interface RecordedCall {
  url: string;
  init?: RequestInit;
}

export type FetchHandler = (
  url: string,
  init?: RequestInit
) => Response | Promise<Response>;

export const scriptedFetch = (handlers: FetchHandler[]) => {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      ({ url } = input);
    }
    calls.push({ init, url });
    const handler = handlers[calls.length - 1];
    if (!handler) {
      throw new Error(`unexpected fetch call ${calls.length}: ${url}`);
    }
    return handler(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
};

export const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, {
    headers: { "content-type": "application/json" },
    status,
  });

export const tokenResponse = (accessToken: string, expiresIn = 3600): Response =>
  jsonResponse({
    access_token: accessToken,
    expires_in: expiresIn,
    scope: "https://www.googleapis.com/auth/gmail.modify",
    token_type: "Bearer",
  });
