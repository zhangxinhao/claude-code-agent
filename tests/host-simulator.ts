/**
 * Drives the installed plugin exactly the way Ora's host does, against a real Claude ACP adapter.
 *
 * Run it with the same permissions Ora grants an agent plugin:
 *   deno run --allow-run --allow-read --allow-env --allow-net tests/host-simulator.ts
 */
import {
  decodeFrames,
  encodeFrame,
  type JsonValue,
} from "../vendor/plugin-sdk/protocol.ts";

const HOST_PERMISSIONS = [
  "--no-prompt",
  "--allow-run",
  "--allow-read",
  "--allow-env",
  "--allow-net",
];

/** Converts this module-relative URL into a host path, including a Windows drive prefix. */
const entrypoint = decodeURIComponent(
  new URL("../src/main.ts", import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, "$1");
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", ...HOST_PERMISSIONS, entrypoint],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
}).spawn();

const writer = child.stdin.getWriter();
const send = (message: JsonValue) => writer.write(encodeFrame(message));
const inbound = decodeFrames(child.stdout)[Symbol.asyncIterator]();

/** Reads frames until one satisfies `match`, so streamed notifications never desynchronize. */
async function waitFor(
  match: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  while (true) {
    const next = await inbound.next();
    if (next.done) {
      throw new Error(`plugin closed stdout while waiting for ${label}`);
    }
    const message = next.value as Record<string, unknown>;
    if (match(message)) {
      return message;
    }
    console.log(`[host] << ${JSON.stringify(message).slice(0, 160)}`);
  }
}

/** Fails the run loudly instead of letting a wrong answer read as a passing line. */
function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`check failed: ${label}`);
  }
}

const acpFrame = (message: Record<string, unknown>): Record<string, unknown> =>
  (message.params ?? {}) as Record<string, unknown>;

const register = await waitFor(
  (message) => message.method === "ora/register",
  "ora/register",
);
const registration = register.params as { methods: string[]; emits: string[] };
for (const method of ["agent/start", "agent/stop", "agent/listModels"]) {
  check(registration.methods.includes(method), `registers ${method}`);
}
check(registration.emits.includes("agent/acp"), "emits agent/acp");
console.log(`ok: register ${JSON.stringify(register.params)}`);

await send({
  jsonrpc: "2.0",
  id: 1,
  method: "agent/start",
  params: { cwd: Deno.cwd(), hostVersion: "0.8.0" },
});
const started = await waitFor((message) => message.id === 1, "agent/start");
check(
  JSON.stringify(started.result) === JSON.stringify({
    protocol: "acp",
    acpVersion: 1,
  }),
  "agent/start returns the ACP protocol descriptor",
);
console.log(
  `ok: agent/start ${JSON.stringify(started.result ?? started.error)}`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
  },
});
const initialized = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 1,
  "ACP initialize",
);
const initializeResult = acpFrame(initialized).result as {
  protocolVersion?: number;
  agentInfo?: { name?: string };
};
check(initializeResult?.protocolVersion === 1, "ACP protocol version is 1");
console.log(
  `ok: initialize ${initializeResult?.agentInfo?.name} protocolVersion ${initializeResult?.protocolVersion}`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: Deno.cwd(), mcpServers: [] },
  },
});
const session = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 2,
  "ACP session/new",
);
const sessionResult = acpFrame(session).result as {
  sessionId?: string;
  configOptions?: { id: string; category?: string; options?: unknown[] }[];
} | undefined;
check(
  typeof sessionResult?.sessionId === "string",
  "session/new returns an id",
);
// The model list lives here and nowhere else, which is why `agent/listModels` is empty below.
const modelOption = sessionResult?.configOptions?.find(
  (option) => option.category === "model",
);
check(modelOption !== undefined, "session/new carries a model config option");
console.log(
  `ok: session/new ${sessionResult?.sessionId} models via ACP: ${
    JSON.stringify(
      modelOption?.options?.map((o) => (o as { value: string }).value),
    )
  }`,
);

await send({ jsonrpc: "2.0", id: 2, method: "agent/listModels", params: {} });
const models = await waitFor((message) => message.id === 2, "agent/listModels");
const modelList = ((models.result ?? {}) as { models?: unknown[] }).models;
check(
  Array.isArray(modelList) && modelList.length === 0,
  "agent/listModels is empty because Claude has no pre-session model list",
);
console.log("ok: listModels [] (Claude publishes models through ACP only)");

await send({ jsonrpc: "2.0", id: 3, method: "agent/stop", params: {} });
await waitFor((message) => message.id === 3, "agent/stop");
console.log("ok: agent/stop");

await send({ jsonrpc: "2.0", method: "ora/shutdown" });
await writer.close();
const status = await child.status;
console.log(`plugin exited with code ${status.code}`);
console.log(
  status.success
    ? "ALL HOST SIMULATION CHECKS PASSED"
    : "PLUGIN EXITED NON-ZERO",
);
Deno.exit(status.success ? 0 : 1);
