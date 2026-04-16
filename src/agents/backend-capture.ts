import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const CODEX_BACKEND_CAPTURE_ENV_VAR = "CODEX_BACKEND_CAPTURE";
const CODEX_BACKEND_CAPTURE_INPUT_ENV_VAR = "CODEX_BACKEND_CAPTURE_INPUT";
const CODEX_BACKEND_CAPTURE_OUTPUT_ENV_VAR = "CODEX_BACKEND_CAPTURE_OUTPUT";
const CODEX_BACKEND_CAPTURE_REASONING_ENV_VAR = "CODEX_BACKEND_CAPTURE_REASONING";
const CODEX_BACKEND_CAPTURE_DIR_ENV_VAR = "CODEX_BACKEND_CAPTURE_DIR";
const BACKEND_TRAFFIC_FILENAME = "backend_traffic.ndjson";

let captureCounter = 1;
let trafficEventCounter = 1;

type BackendCaptureConfig = {
  enabled: boolean;
  captureInput: boolean;
  captureOutput: boolean;
  captureReasoning: boolean;
  captureDir: string;
};

type StartBackendCaptureParams = {
  kind: string;
  requestPayload: unknown;
  trafficRequest?: Record<string, unknown>;
};

export type BackendCaptureSession = {
  id: string;
  appendOutput: (transport: string, payload: string) => void;
  appendReasoning: (transport: string, payload: string) => void;
  appendTrafficEvent: (event: Record<string, unknown>) => void;
};

function envIsSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

function activeBackendCaptureConfig(): BackendCaptureConfig {
  const enabled =
    envIsSet(CODEX_BACKEND_CAPTURE_ENV_VAR) ||
    envIsSet(CODEX_BACKEND_CAPTURE_INPUT_ENV_VAR) ||
    envIsSet(CODEX_BACKEND_CAPTURE_OUTPUT_ENV_VAR) ||
    envIsSet(CODEX_BACKEND_CAPTURE_REASONING_ENV_VAR);
  return {
    enabled,
    captureInput: enabled || envIsSet(CODEX_BACKEND_CAPTURE_INPUT_ENV_VAR),
    captureOutput: enabled || envIsSet(CODEX_BACKEND_CAPTURE_OUTPUT_ENV_VAR),
    captureReasoning: enabled || envIsSet(CODEX_BACKEND_CAPTURE_REASONING_ENV_VAR),
    captureDir:
      process.env[CODEX_BACKEND_CAPTURE_DIR_ENV_VAR]?.trim() ||
      `/var/tmp/codex-backend-capture.${process.pid}`,
  };
}

function appendJsonLine(filePath: string, value: unknown) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
  } catch {
    // Best-effort capture only.
  }
}

function nowUnixMs(): number {
  return Date.now();
}

function nextCaptureId(): string {
  const id = captureCounter;
  captureCounter += 1;
  return String(id);
}

function nextTrafficEventId(): number {
  const id = trafficEventCounter;
  trafficEventCounter += 1;
  return id;
}

export function startBackendCapture(
  params: StartBackendCaptureParams,
): BackendCaptureSession | undefined {
  const config = activeBackendCaptureConfig();
  if (!config.enabled) {
    return undefined;
  }

  const id = nextCaptureId();
  const inputPath = join(config.captureDir, `${id}_input.ndjson`);
  const outputPath = join(config.captureDir, `${id}_output.ndjson`);
  const reasoningPath = join(config.captureDir, `${id}_reasoning.ndjson`);
  const trafficPath = join(config.captureDir, BACKEND_TRAFFIC_FILENAME);

  if (config.captureInput) {
    appendJsonLine(inputPath, {
      kind: params.kind,
      query_id: id,
      transport: params.kind,
      payload: params.requestPayload,
    });
  }

  if (params.trafficRequest) {
    appendJsonLine(trafficPath, {
      ...params.trafficRequest,
      event_seq: nextTrafficEventId(),
      timestamp_unix_ms: nowUnixMs(),
    });
  }

  return {
    id,
    appendOutput: (transport: string, payload: string) => {
      if (!config.captureOutput) {
        return;
      }
      appendJsonLine(outputPath, {
        query_id: id,
        transport,
        payload,
      });
    },
    appendReasoning: (transport: string, payload: string) => {
      if (!config.captureReasoning) {
        return;
      }
      appendJsonLine(reasoningPath, {
        query_id: id,
        transport,
        payload,
      });
    },
    appendTrafficEvent: (event: Record<string, unknown>) => {
      appendJsonLine(trafficPath, {
        ...event,
        event_seq: nextTrafficEventId(),
        timestamp_unix_ms: nowUnixMs(),
      });
    },
  };
}
