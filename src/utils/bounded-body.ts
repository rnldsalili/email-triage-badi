export class InputLimitError extends Error {
  readonly code: string;

  constructor(code = "input_too_large") {
    super(code);
    this.name = "InputLimitError";
    this.code = code;
  }
}

export const readBoundedText = async (
  response: Response | Request,
  maxBytes: number
): Promise<string> => {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new InputLimitError();
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  const readNext = async (): Promise<string> => {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new InputLimitError();
    }
    text += decoder.decode(value, { stream: true });
    return await readNext();
  };

  try {
    return await readNext();
  } finally {
    reader.releaseLock();
  }
};
