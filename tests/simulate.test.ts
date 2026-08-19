/**
 * Drives the plugin exactly the way Ora's host does, against a real Claude ACP adapter.
 *
 * Run with `deno task simulate`; it needs `claude-agent-acp` on PATH (or `ORA_CLAUDE_ACP_BIN`)
 * and an authenticated `claude` CLI.
 */
import { HostSimulator } from "@ora-space/plugin-sdk/testing";

function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`check failed: ${label}`);
  }
}

Deno.test("Claude plugin serves the agent contract end to end", async () => {
  const host = await HostSimulator.launch({
    entrypoint: new URL("../src/main.ts", import.meta.url),
    // Lets a developer run the simulation against an unpublished SDK checkout.
    configPath: Deno.env.get("ORA_PLUGIN_DENO_CONFIG"),
  });
  for (const method of ["agent/start", "agent/stop", "agent/listModels"]) {
    check(host.registration.methods.includes(method), `registers ${method}`);
  }
  check(host.registration.emits.includes("agent/acp"), "emits agent/acp");
  check(host.registration.contracts?.agent === 1, "agent contract v1");

  const started = await host.request("agent/start", {
    cwd: Deno.cwd(),
    hostVersion: "0.9.0",
  });
  check(
    JSON.stringify(started.result) ===
      JSON.stringify({ protocol: "acp", acpVersion: 1 }),
    `agent/start succeeded: ${JSON.stringify(started.error)}`,
  );

  const initialized = await host.acpRequest(1, "initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const initResult = initialized.result as {
    protocolVersion?: number;
    agentInfo?: { name?: string };
  };
  check(initResult?.protocolVersion === 1, "ACP protocol version is 1");
  console.log(`initialize ${initResult?.agentInfo?.name}`);

  const session = await host.acpRequest(2, "session/new", {
    cwd: Deno.cwd(),
    mcpServers: [],
  });
  const sessionResult = session.result as {
    sessionId?: string;
    configOptions?: { category?: string; options?: { value: string }[] }[];
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
    `models via ACP: ${
      JSON.stringify(modelOption?.options?.map((o) => o.value))
    }`,
  );

  const models = await host.request("agent/listModels");
  const list = (models.result as { models?: unknown[] })?.models;
  check(
    Array.isArray(list) && list.length === 0,
    "agent/listModels is empty because Claude has no pre-session model list",
  );

  const stopped = await host.request("agent/stop");
  check(JSON.stringify(stopped.result) === "{}", "agent/stop succeeded");
  check((await host.shutdown()) === 0, "plugin exited cleanly");
});
