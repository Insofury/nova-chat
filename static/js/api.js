// Talks to the Python backend.
//  - fetchConfig(): GET /api/config
//  - streamChat():  POST /api/chat and parse the Server-Sent Events stream
//    incrementally, calling onEvent(type, data) for every event as it arrives.
//    (EventSource only supports GET, so we read the fetch body stream ourselves.)

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function errorFromResponse(res) {
  let message = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (typeof body.detail === "string") {
      message = body.detail;
    } else if (Array.isArray(body.detail) && body.detail.length) {
      // FastAPI validation error list
      message = body.detail.map((d) => d.msg).join("; ");
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message);
}

export async function fetchConfig() {
  const res = await fetch("/api/config", { headers: { Accept: "application/json" } });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

function parseEvent(raw) {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

export async function streamChat(payload, { signal, accessCode, onEvent }) {
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (accessCode) headers["X-Access-Code"] = accessCode;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new ApiError(0, "Streaming is not supported by this browser.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseEvent(raw);
      if (parsed) onEvent(parsed.event, parsed.data);
    }
  }
  const tail = parseEvent(buffer.trim());
  if (tail) onEvent(tail.event, tail.data);
}
