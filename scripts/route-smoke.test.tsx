/**
 * Route composition smoke test.
 *
 * Both production regressions on 2026-08-22 were invisible to build, typecheck and lint,
 * because both were runtime composition failures rather than type or syntax errors:
 *
 *   1. CallQueueContent called Route.useSearch(), bound to /dashboard/call-queue. Rendered
 *      from /manager/queue that route is registered but NOT matched, so TanStack Router threw
 *      "Invariant failed".
 *   2. It called useCallSession(), whose provider was mounted only above the dashboard's
 *      <Outlet/>, so the same page threw "useCallSession must be used within
 *      CallSessionProvider".
 *
 * This drives the REAL generated route tree at /manager/queue and asserts the page renders.
 * That matters: an earlier version of this test built a small stand-in route tree instead,
 * and it did NOT catch #1 — Route.useSearch() only throws when the route exists in the
 * router but is not the active match, which a stand-in tree can never reproduce. Verified by
 * reintroducing each bug and watching this fail.
 *
 * renderToString runs the render phase only, not effects — which is exactly where both threw,
 * and is why no network or DOM is needed.
 *
 * Run: bun test scripts/route-smoke.test.tsx  (wired into `bun run test:logic`)
 */
import { describe, expect, test, mock, beforeAll } from "bun:test";

const MANAGER = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Smoke Manager",
  email: "smoke.manager@example.com",
  role: "manager" as const,
  agentPhone: null,
};

const TEAM = { id: "team-smoke", name: "Smoke Team", managerId: MANAGER.email, agentIds: [] };

const AGENT = {
  id: "smoke.agent@example.com",
  name: "Smoke Agent",
  email: "smoke.agent@example.com",
  role: "agent" as const,
};

// Registered before any route module is imported. These stand in for signed-in state and
// team membership only — every provider, layout and page under test is the real one, because
// substituting those is what would make this test stop reflecting production.
beforeAll(async () => {
  // Spread the real module and override only the signed-in state, the same way the team-store
  // mock below does. Listing exports by hand meant every NEW export from auth.tsx broke all
  // five route tests with "Export named 'x' not found" — a failure about the mock, not the
  // code under test.
  const authModule = await import("../src/lib/auth");
  mock.module("@/lib/auth", () => ({
    ...authModule,
    useAuth: () => ({
      user: MANAGER,
      loading: false,
      signIn: async () => {},
      signOut: async () => {},
    }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  }));

  // Without a team and an agent, AgentLiveViewTab early-returns "you don't have a team yet"
  // and never mounts the queue — the test would pass while exercising nothing.
  const teamStore = await import("../src/lib/team-store");
  mock.module("@/lib/team-store", () => ({
    ...teamStore,
    getTeamAgents: () => [AGENT],
    useTeamAgents: () => [AGENT],
  }));

  mock.module("@/lib/active-team-store", () => ({
    useActiveTeam: () => ({ teams: [TEAM], activeTeam: TEAM, setActiveTeam: () => {} }),
    getActiveTeamId: () => TEAM.id,
    setActiveTeamId: () => {},
    clearActiveTeam: () => {},
  }));
});

async function renderRoute(path: string) {
  const { renderToString } = await import("react-dom/server");
  const { createRouter, createMemoryHistory, RouterProvider } =
    await import("@tanstack/react-router");
  const { routeTree } = await import("../src/routeTree.gen");

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const html = renderToString(<RouterProvider router={router as any} />);

  // renderToString does NOT throw on a render error. React catches it, emits a
  // <template data-msg="Switched to client rendering because the server rendering errored: …">
  // and carries on returning a perfectly valid-looking string. Asserting "it did not throw"
  // is therefore worthless here — both regressions this file exists for return cleanly. The
  // error marker has to be read out of the markup explicitly.
  const failure = html.match(
    /data-msg="Switched to client rendering because the server rendering errored:([\s\S]*?)"/,
  );
  if (failure) {
    const reason = failure[1]
      .replace(/&quot;/g, '"')
      .replace(/\\n/g, " ")
      .trim();
    throw new Error(`${path} failed to render: ${reason.slice(0, 300)}`);
  }
  return html;
}

describe("routes render without composition errors", () => {
  test("/manager/queue mounts the real agent Call Queue", async () => {
    const html = await renderRoute("/manager/queue");
    // Guard against the test going vacuous: if Agent Live View ever stops mounting the queue
    // (an early return, a renamed tab, an empty agent list), renderRoute would still pass
    // while proving nothing. "Productive" is the dial-mode bar, which only the real queue
    // renders.
    expect(html).toContain("Productive");
  });

  test("/dashboard/call-queue still renders on its own route", async () => {
    // renderRoute throws on any SSR render error; reaching the assertion is the pass.
    const html = await renderRoute("/dashboard/call-queue");
    expect(html.length).toBeGreaterThan(0);
  });

  test("/manager renders", async () => {
    // renderRoute throws on any SSR render error; reaching the assertion is the pass.
    const html = await renderRoute("/manager");
    expect(html.length).toBeGreaterThan(0);
  });

  test("/dashboard mounts the agent home with its month-over-month tile", async () => {
    const html = await renderRoute("/dashboard");
    // Guard against going vacuous: the tile sits beside "My Activity Today" and is the only
    // thing on this page that renders either string. Losing it to a layout edit should fail
    // here rather than quietly leave a half-empty row on the agent's home screen.
    expect(html).toContain("My Activity Today");
    expect(html).toContain("This Month vs Last");
  });

  test("/dashboard/payments renders", async () => {
    // renderRoute throws on any SSR render error; reaching the assertion is the pass.
    const html = await renderRoute("/dashboard/payments");
    expect(html.length).toBeGreaterThan(0);
  });
});
