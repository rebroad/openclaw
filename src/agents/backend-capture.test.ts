import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const CAPTURE_ENV_VARS = [
  "CODEX_BACKEND_CAPTURE",
  "CODEX_BACKEND_CAPTURE_INPUT",
  "CODEX_BACKEND_CAPTURE_OUTPUT",
  "CODEX_BACKEND_CAPTURE_REASONING",
  "CODEX_BACKEND_CAPTURE_DIR",
  "CODEX_PROMPT_DEBUG",
  "CODEX_PROMPT_DEBUG_DIR",
] as const;

function setCaptureEnv(overrides: Partial<Record<(typeof CAPTURE_ENV_VARS)[number], string>> = {}) {
  for (const name of CAPTURE_ENV_VARS) {
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      process.env[name] = value;
    }
  }
}

function readFileIfPresent(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

describe("backend capture", () => {
  afterEach(() => {
    setCaptureEnv();
    vi.restoreAllMocks();
  });

  it("captures input, output, reasoning, and traffic by default", async () => {
    const captureDir = fs.mkdtempSync("/var/tmp/openclaw-backend-capture-default-");
    setCaptureEnv({ CODEX_BACKEND_CAPTURE_DIR: captureDir });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();

    const { startBackendCapture } = await import("./backend-capture.js");
    const capture = startBackendCapture({
      kind: "provider_http",
      requestPayload: { hello: "world" },
      trafficRequest: { direction: "request" },
    });

    expect(capture).toBeDefined();
    capture?.appendOutput("provider_http_stream", "chunk-a");
    capture?.appendReasoning("provider_http_reasoning", "think-a");
    capture?.appendTrafficEvent({ direction: "response" });

    const input = readFileIfPresent(path.join(captureDir, "1_input.ndjson"));
    const output = readFileIfPresent(path.join(captureDir, "1_output.ndjson"));
    const reasoning = readFileIfPresent(path.join(captureDir, "1_reasoning.ndjson"));
    const traffic = readFileIfPresent(path.join(captureDir, "backend_traffic.ndjson"));

    expect(input).toContain('"query_id":"1"');
    expect(output).toContain('"payload":"chunk-a"');
    expect(reasoning).toContain('"payload":"think-a"');
    expect(traffic).toContain('"direction":"request"');
    expect(traffic).toContain('"direction":"response"');
  });

  it("disables capture completely when CODEX_BACKEND_CAPTURE=0", async () => {
    const captureDir = fs.mkdtempSync("/var/tmp/openclaw-backend-capture-disabled-");
    setCaptureEnv({
      CODEX_BACKEND_CAPTURE: "0",
      CODEX_BACKEND_CAPTURE_DIR: captureDir,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();

    const { startBackendCapture } = await import("./backend-capture.js");
    const capture = startBackendCapture({
      kind: "provider_http",
      requestPayload: { hello: "world" },
      trafficRequest: { direction: "request" },
    });

    expect(capture).toBeUndefined();
    expect(fs.existsSync(path.join(captureDir, "1_input.ndjson"))).toBe(false);
    expect(fs.existsSync(path.join(captureDir, "backend_traffic.ndjson"))).toBe(false);
  });

  it("supports per-lane disable toggles while capture remains on", async () => {
    const captureDir = fs.mkdtempSync("/var/tmp/openclaw-backend-capture-lane-");
    setCaptureEnv({
      CODEX_BACKEND_CAPTURE_REASONING: "false",
      CODEX_BACKEND_CAPTURE_DIR: captureDir,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.resetModules();

    const { startBackendCapture } = await import("./backend-capture.js");
    const capture = startBackendCapture({
      kind: "provider_http",
      requestPayload: { hello: "world" },
      trafficRequest: { direction: "request" },
    });

    expect(capture).toBeDefined();
    capture?.appendOutput("provider_http_stream", "chunk-a");
    capture?.appendReasoning("provider_http_reasoning", "think-a");

    expect(fs.existsSync(path.join(captureDir, "1_input.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(captureDir, "1_output.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(captureDir, "1_reasoning.ndjson"))).toBe(false);
  });
});
