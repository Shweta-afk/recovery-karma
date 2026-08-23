/**
 * Regression test for assignDebtors' ordering.
 *
 * The bug (found 2026-08-23, agent akashvis812@gmail.com): the function reset
 * assigned_agent_id to NULL across the WHOLE portfolio, then looped the allocation with
 * `const agentUuid = idByEmail.get(agentEmail); if (!agentUuid) continue;`. That `continue`
 * was silent. A roster lookup that came back short wiped every assignment in the portfolio and
 * declined to write the new ones — the manager's UI reported success, the agent's Call Queue
 * went to zero, and nothing logged it.
 *
 * What matters is not just "it throws" but that it throws BEFORE the reset runs, so a failed
 * assign leaves the existing allocation untouched. This asserts the recorded write sequence,
 * because a version that threw after the reset would pass a throws-only test while still
 * destroying the data.
 *
 * Run: bun test scripts/assign-debtors.test.ts  (wired into `bun run test:logic`)
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

type Write = { table: string; op: string; payload: unknown; filter: string };
let writes: Write[] = [];
let agentRows: { id: string; email: string }[] = [];
let agentError: { message: string } | null = null;

// A chainable stand-in for the supabase client covering exactly the calls assignDebtors makes.
// Anything else resolves to an empty, error-free result so the refreshPortfolios() that runs
// afterwards is inert rather than exploding the test.
const supabase = {
  from(table: string) {
    const empty = Promise.resolve({ data: [], error: null });
    return {
      select: (_cols?: string) =>
        table === "agents"
          ? Object.assign(Promise.resolve({ data: agentRows, error: agentError }), {
              eq: () => Promise.resolve({ data: agentRows, error: agentError }),
              range: () => Promise.resolve({ data: agentRows, error: agentError }),
            })
          : Object.assign(empty, { eq: () => empty, range: () => empty, in: () => empty }),
      update: (payload: unknown) => ({
        eq: (col: string, val: string) => {
          writes.push({ table, op: "update", payload, filter: `${col}=${val}` });
          return Promise.resolve({ error: null });
        },
        in: (col: string, vals: string[]) => {
          writes.push({ table, op: "update", payload, filter: `${col} in [${vals.join(",")}]` });
          return Promise.resolve({ error: null });
        },
      }),
    };
  },
};

// Stubbed before portfolio-store is imported, so its module-level `import { supabase }` binds
// to the mock. window/localStorage exist because the store writes a cache and dispatches an
// event on refresh; neither is under test here.
// The real module also exports getSupabase/getSupabaseConfig/getMyAgentRow; a partial mock
// makes the whole module fail to link for any importer of those, so they are carried through.
const supabaseModule = {
  supabase,
  getSupabase: () => supabase,
  getSupabaseConfig: () => ({ url: "", anonKey: "" }),
  getMyAgentRow: async () => null,
};
mock.module("@/lib/supabase", () => supabaseModule);
mock.module("../src/lib/supabase", () => supabaseModule);
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const { assignDebtors } = await import("../src/lib/portfolio-store");

const resets = () =>
  writes.filter(
    (w) => w.payload && (w.payload as Record<string, unknown>).assigned_agent_id === null,
  );

beforeEach(() => {
  writes = [];
  agentError = null;
  agentRows = [{ id: "uuid-a", email: "a@x.com" }];
});

describe("assignDebtors", () => {
  test("an unresolvable agent aborts BEFORE anything is unassigned", async () => {
    await expect(
      assignDebtors("portfolio-1", { "a@x.com": ["d1"], "ghost@x.com": ["d2"] }),
    ).rejects.toThrow(/ghost@x\.com/);

    // The heart of it: the portfolio must be untouched. The old code reached this reset first
    // and left every debtor in the portfolio unassigned.
    expect(resets()).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test("the error names the agent and says nothing changed", async () => {
    await expect(assignDebtors("portfolio-1", { "ghost@x.com": ["d2"] })).rejects.toThrow(
      /Nothing was changed/,
    );
  });

  test("a failed roster read aborts too, rather than resolving nobody", async () => {
    // A swallowed error left idByEmail empty, which the old loop read as "skip everyone" —
    // the same portfolio-wide wipe by a different route.
    agentError = { message: "permission denied for table agents" };
    agentRows = [];
    await expect(assignDebtors("portfolio-1", { "a@x.com": ["d1"] })).rejects.toThrow(
      /permission denied/,
    );
    expect(writes).toHaveLength(0);
  });

  test("a fully resolvable allocation resets once, then assigns", async () => {
    agentRows = [
      { id: "uuid-a", email: "a@x.com" },
      { id: "uuid-b", email: "b@x.com" },
    ];
    await assignDebtors("portfolio-1", { "a@x.com": ["d1", "d2"], "b@x.com": ["d3"] });

    expect(resets()).toHaveLength(1);
    expect(resets()[0].filter).toBe("portfolio_id=portfolio-1");
    // Reset first, then the per-agent writes — order matters, or an assign would be undone.
    expect(writes[0]).toBe(resets()[0]);
    expect(
      writes.slice(1).map((w) => (w.payload as Record<string, string>).assigned_agent_id),
    ).toEqual(["uuid-a", "uuid-b"]);
  });

  test("an agent with an empty id list is not a reason to abort", async () => {
    // "unassign everyone" is a legitimate allocation; only a NAMED agent holding debtors that
    // cannot be resolved is an error.
    await assignDebtors("portfolio-1", { "a@x.com": ["d1"], "ghost@x.com": [] });
    expect(resets()).toHaveLength(1);
  });
});
