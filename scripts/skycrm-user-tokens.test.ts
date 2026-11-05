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

const { registerQueue, loginSkycrmUser } = await import(
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
