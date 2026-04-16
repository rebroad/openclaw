import type { Api, Model } from "@mariozechner/pi-ai";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { startBackendCapture } from "./backend-capture.js";
import {
  buildProviderRequestDispatcherPolicy,
  getModelProviderRequestTransport,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";

function headersToObject(headers: Headers): Record<string, string[]> {
  const entries: Record<string, string[]> = {};
  headers.forEach((value, key) => {
    if (entries[key]) {
      entries[key].push(value);
    } else {
      entries[key] = [value];
    }
  });
  return entries;
}

async function bodyInitToString(body: BodyInit | null | undefined): Promise<string> {
  if (body == null) {
    return "[empty]";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof Blob) {
    return body.text().catch(() => "[unavailable blob body]");
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return "[binary body]";
  }
  if (body instanceof FormData) {
    return "[form-data body]";
  }
  if (body instanceof ReadableStream) {
    return "[stream body]";
  }
  return String(body);
}

function buildManagedResponse(
  response: Response,
  release: () => Promise<void>,
  onChunk?: (chunk: string) => void,
): Response {
  if (!response.body) {
    void release();
    return response;
  }
  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  let released = false;
  const finalize = async () => {
    if (released) {
      return;
    }
    released = true;
    await release().catch(() => undefined);
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          const trailing = decoder.decode();
          if (trailing.length > 0) {
            onChunk?.(trailing);
          }
          controller.close();
          await finalize();
          return;
        }
        const decodedChunk = decoder.decode(chunk.value, { stream: true });
        if (decodedChunk.length > 0) {
          onChunk?.(decodedChunk);
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        await finalize();
      }
    },
  });
  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function resolveModelRequestPolicy(model: Model<Api>) {
  return resolveProviderRequestPolicyConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    request: getModelProviderRequestTransport(model),
  });
}

export function buildGuardedModelFetch(model: Model<Api>): typeof fetch {
  const requestConfig = resolveModelRequestPolicy(model);
  const dispatcherPolicy = buildProviderRequestDispatcherPolicy(requestConfig);
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const url =
      request?.url ??
      (input instanceof URL
        ? input.toString()
        : typeof input === "string"
          ? input
          : (() => {
              throw new Error("Unsupported fetch input for transport-aware model request");
            })());
    const requestInit =
      request &&
      ({
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        redirect: request.redirect,
        signal: request.signal,
        ...(request.body ? ({ duplex: "half" } as const) : {}),
      } satisfies RequestInit & { duplex?: "half" });
    const requestMethod = request?.method ?? requestInit?.method ?? init?.method ?? "GET";
    const requestHeaders = headersToObject(new Headers(requestInit?.headers ?? init?.headers));
    const requestBodyText =
      request && request.body
        ? await request
            .clone()
            .text()
            .catch(() => "[unavailable request body]")
        : await bodyInitToString((requestInit?.body as BodyInit | undefined) ?? init?.body);
    const capture = startBackendCapture({
      kind: "provider_http",
      requestPayload: requestBodyText,
      trafficRequest: {
        direction: "request",
        transport: "provider_http",
        provider: model.provider,
        api: model.api,
        url,
        method: requestMethod,
        headers: requestHeaders,
        payload: requestBodyText,
      },
    });
    const result = await fetchWithSsrFGuard({
      url,
      init: requestInit ?? init,
      dispatcherPolicy,
      // Provider transport intentionally keeps the secure default and never
      // replays unsafe request bodies across cross-origin redirects.
      allowCrossOriginUnsafeRedirectReplay: false,
      ...(requestConfig.allowPrivateNetwork ? { policy: { allowPrivateNetwork: true } } : {}),
    });
    capture?.appendTrafficEvent({
      direction: "response",
      transport: "provider_http",
      provider: model.provider,
      api: model.api,
      url,
      status: result.response.status,
      status_text: result.response.statusText,
      headers: headersToObject(result.response.headers),
    });
    return buildManagedResponse(result.response, result.release, (chunk) => {
      capture?.appendOutput("provider_http_stream", chunk);
      capture?.appendTrafficEvent({
        direction: "response_body_chunk",
        transport: "provider_http",
        provider: model.provider,
        api: model.api,
        url,
        payload: chunk,
      });
    });
  };
}
