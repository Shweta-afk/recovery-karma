// Per-user SkyCRM tokens (skycrm-provider.ts post() + loginSkycrmUser), with the fallback that keeps
// calling working when SkyCRM refuses a user.
import { afterEach, describe, expect, mock, test } from "bun:test";

process.env.SKYCRM_SECRET = "test-secret";
process.env.SKYCRM_BASE_URL = "https://sky.test";

let creds: { username: string; password: string } | null = { username: "8601", password: "pw@1" };
mock.module("../src/lib/telephony/skycrm-credentials.server", () => ({
  skycrmCredentials: async () => creds,
  forgetSkycrmCredentials: () => {},
}));
mock.module("@/lib/supabase-admin.server", () => ({ getSupabaseAdmin: () => ({}) }));

const { registerQueue, loginSkycrmUser, sendDisposition, startCallMonitor } = await import(
  // Fresh copy: another test file may have loaded the provider before SKYCRM_SECRET was set here.
  "../src/lib/telephony/skycrm-provider.ts?per-user-tokens"
);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  creds = { username: "8601", password: "pw@1" };
});

function payloadOf(init: RequestInit | undefined, url: string): Record<string, unknown> {
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
  const token = auth ? auth.replace("Bearer ", "") : decodeURIComponent(url.split("token=")[1]);
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

function fakeFetch(answers: Array<{ status?: number; body: string; headers?: Record<string, string> }>) {
  const seen: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push(payloadOf(init, String(url)));
    const a = answers.shift() ?? { body: '{"status":200}' };
    return new Response(a.body, { status: a.status ?? 200, headers: a.headers });
  }) as typeof fetch;
  return seen;
}

describe("per-user tokens", () => {
  test("API calls carry the agent's own SkyCRM user", async () => {
    const seen = fakeFetch([{ body: '{"status":200}' }]);
    await registerQueue("8601", "1081");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ username: "8601", password: "pw@1", extension: "8601" });
  });

  test("a refused user (301) is retried once without it — calling never stops", async () => {
    const seen = fakeFetch([
      { body: '{"status":301,"message":"User does not exist"}' },
      { body: '{"status":200}' },
    ]);
    await registerQueue("8601", "1081");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ username: "", password: "" });
  });

  test("no SkyCRM user yet → the old blank-user token, one request", async () => {
    creds = null;
    const seen = fakeFetch([{ body: '{"status":200}' }]);
    await registerQueue("8601", "1081");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ username: "" });
  });

  test("a real error with a valid user is still an error (not retried)", async () => {
    const seen = fakeFetch([{ body: '{"status":300,"Error":"bad queue"}' }]);
    await expect(registerQueue("8601", "1081")).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("loginSkycrmUser", () => {
  test("redirect = logged in; JSON refusal = error with SkyCRM's message", async () => {
    fakeFetch([{ status: 302, body: "", headers: { location: "/" } }]);
    expect(await loginSkycrmUser("8601")).toEqual({ ok: true, username: "8601" });
    fakeFetch([{ body: '{"status": 301, "message": "User does not exist"}' }]);
    const r = await loginSkycrmUser("8601");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("User does not exist");
    creds = null;
    expect((await loginSkycrmUser("8601")).ok).toBe(false);
  });
});

describe("disposition_api", () => {
  test("is sent as JSON (form data gets HTTP 400 Invalid JSON)", async () => {
    let seen: { type?: string; body?: string } = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      seen = { type: h["Content-Type"], body: String(init?.body) };
      return new Response('{"status": 200, "message": "disposition phone 9999999999 successfully"}');
    }) as typeof fetch;
    await sendDisposition({
      extension: "8602",
      phone_number: "9999999999",
      caller_name: "x",
      disposition: "Contacted",
      sub_disposition: "Promise to Pay",
      remark: "r",
      callback_datetime: "",
      direction: "Outbound",
    });
    expect(seen.type).toBe("application/json");
    expect(JSON.parse(seen.body ?? "{}")).toMatchObject({ phone_number: "9999999999", callback_datetime: "" });
  });

  test("an HTTP error with no status field is a failure, not a silent success", async () => {
    fakeFetch([{ status: 400, body: '{"error": "Invalid JSON"}' }]);
    await expect(registerQueue("8601", "1081")).rejects.toThrow();
  });
});

describe("call_monitor_api", () => {
  test("rings the supervisor's extension onto the agent's call, as form data", async () => {
    let body = "";
    let token: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      body = String(init?.body);
      token = payloadOf(init, String(url));
      return new Response('{"status": 200, "message": "Sucessfully are monitoring applied"}');
    }) as typeof fetch;
    creds = { username: "8611", password: "pw@1" };
    await startCallMonitor("whisper", "8611", "8602");
    const form = new URLSearchParams(body);
    expect(form.get("Mode")).toBe("whisper");
    expect(form.get("user_extention")).toBe("8611");
    expect(form.get("monitor_extention")).toBe("8602");
    expect(token).toMatchObject({ extension: "8611", username: "8611" });
  });
});
