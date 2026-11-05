// Superadmin: a company's share of the shared SkyCRM account — enablement, extensions, lines
// (guaranteed + most at once), inbound queue, calling hours — plus per-user extension assignment.
// Its phone numbers are handed out on Superadmin → Numbers & Lines and listed here read-only.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Phone, Save, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getAccessToken } from "@/lib/access-token";
import {
  createSkycrmUsers,
  getCompanyTelephony,
  saveCompanyTelephony,
  setAgentExtension,
  type CompanyTelephony,
} from "@/lib/telephony-actions.server";

interface Draft {
  enabled: boolean;
  seatLimit: string;
  channelLimit: string;
  channelReserved: string;
  inboundDid: string;
  inboundQueue: string;
  callWindowStart: string;
  callWindowEnd: string;
}

function draftFrom(t: CompanyTelephony): Draft {
  const s = t.settings;
  return {
    enabled: s?.enabled ?? false,
    seatLimit: s?.seat_limit == null ? "" : String(s.seat_limit),
    channelLimit: String(s?.channel_limit ?? 0),
    channelReserved: String(s?.channel_reserved ?? 0),
    inboundDid: s?.inbound_did ?? "",
    inboundQueue: s?.inbound_queue ?? "",
    callWindowStart: (s?.call_window_start ?? "08:00").slice(0, 5),
    callWindowEnd: (s?.call_window_end ?? "19:00").slice(0, 5),
  };
}

export function CompanyTelephonyCard({ clientId }: { clientId: string }) {
  const [data, setData] = useState<CompanyTelephony | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [extDrafts, setExtDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savingAgent, setSavingAgent] = useState<string | null>(null);
  const [creatingUsers, setCreatingUsers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const t = await getCompanyTelephony({
        data: { accessToken: await getAccessToken(), clientId },
      });
      setData(t);
      setDraft(draftFrom(t));
      setExtDrafts(Object.fromEntries(t.agents.map((a) => [a.id, a.extension ?? ""])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load telephony settings");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const up = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const handleSave = async () => {
    if (!draft) return;
    const seatLimit = draft.seatLimit.trim() === "" ? null : Number(draft.seatLimit);
    const channelLimit = Number(draft.channelLimit);
    const channelReserved = Number(draft.channelReserved);
    if (
      (seatLimit !== null && !(seatLimit >= 0)) ||
      !(channelLimit >= 0) ||
      !(channelReserved >= 0)
    ) {
      toast.error("Extensions and lines must be non-negative numbers");
      return;
    }
    setSaving(true);
    try {
      await saveCompanyTelephony({
        data: {
          accessToken: await getAccessToken(),
          clientId,
          enabled: draft.enabled,
          seatLimit,
          channelLimit,
          channelReserved,
          inboundDid: draft.inboundDid.trim() || null,
          inboundQueue: draft.inboundQueue.trim() || null,
          callWindowStart: draft.callWindowStart,
          callWindowEnd: draft.callWindowEnd,
        },
      });
      toast.success("Telephony settings saved");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save telephony settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveExtension = async (agentId: string) => {
    const value = (extDrafts[agentId] ?? "").trim();
    setSavingAgent(agentId);
    try {
      await setAgentExtension({
        data: {
          accessToken: await getAccessToken(),
          clientId,
          agentId,
          extension: value || null,
        },
      });
      toast.success(value ? `Extension ${value} assigned` : "Extension removed");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the extension");
    } finally {
      setSavingAgent(null);
    }
  };

  const handleCreateSkycrmUsers = async () => {
    setCreatingUsers(true);
    try {
      const r = await createSkycrmUsers({
        data: { accessToken: await getAccessToken(), clientId },
      });
      if (r.results.length === 0) toast.success("Everyone already has a SkyCRM user");
      else if (r.failed === 0) toast.success(`Created ${r.created} SkyCRM users`);
      else
        toast.error(
          `Created ${r.created}, ${r.failed} failed — ${r.results.find((x) => !x.ok)?.detail ?? ""}`,
        );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create SkyCRM users");
    } finally {
      setCreatingUsers(false);
    }
  };

  const assigned = data?.agents.filter((a) => a.extension).length ?? 0;
  const skyCreated = data?.agents.filter((a) => a.skycrmUser?.status === "created").length ?? 0;
  const outboundLines = data ? data.trunk.totalChannels - data.trunk.inboundReserve : 0;
  const canGuarantee = data ? Math.max(0, outboundLines - data.otherCompaniesReserved) : 0;

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Phone className="h-4 w-4 text-primary" />
          Telephony
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          This company's share of the shared calling account. Active provider:{" "}
          <span className="font-medium text-foreground">{data?.provider ?? "…"}</span>
          {data?.provider === "sim" && " (simulator — no real calls)"}.
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-5">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!draft && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {draft && data && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-center gap-3 sm:col-span-2">
                <Switch checked={draft.enabled} onCheckedChange={(v) => up({ enabled: v })} />
                <span className="text-sm">Calling enabled</span>
              </label>
              <Field label="Extensions allowed" hint={`${assigned} assigned · blank = no cap`}>
                <Input
                  type="number"
                  min={0}
                  value={draft.seatLimit}
                  onChange={(e) => up({ seatLimit: e.target.value })}
                  placeholder="No cap"
                  className="h-8 text-xs"
                />
              </Field>
              <Field
                label="Guaranteed lines"
                hint={`Always theirs, however busy others are. Up to ${canGuarantee} free (others are guaranteed ${data.otherCompaniesReserved})`}
              >
                <Input
                  type="number"
                  min={0}
                  max={canGuarantee}
                  value={draft.channelReserved}
                  onChange={(e) => up({ channelReserved: e.target.value })}
                  className="h-8 text-xs"
                />
              </Field>
              <Field
                label="Most lines at once"
                hint={`Above the guarantee they borrow free lines. Max ${outboundLines} (${data.trunk.totalChannels} on the trunk, ${data.trunk.inboundReserve} kept for inbound) · ${data.activeOutbound} in use now`}
              >
                <Input
                  type="number"
                  min={0}
                  max={outboundLines}
                  value={draft.channelLimit}
                  onChange={(e) => up({ channelLimit: e.target.value })}
                  className="h-8 text-xs"
                />
              </Field>
              <div className="space-y-1 sm:col-span-2">
                <p className="text-xs text-muted-foreground">Phone numbers</p>
                {data.numbers.length === 0 ? (
                  <p className="text-xs">
                    None yet — calls go out on the vendor's default number.{" "}
                    <Link to="/superadmin/numbers" className="text-primary underline">
                      Give this company numbers
                    </Link>
                  </p>
                ) : (
                  <p className="text-xs">
                    {data.numbers.length} number{data.numbers.length === 1 ? "" : "s"}:{" "}
                    <span className="font-mono">
                      {data.numbers
                        .slice(0, 6)
                        .map((n) => n.number)
                        .join(", ")}
                      {data.numbers.length > 6 ? ` +${data.numbers.length - 6} more` : ""}
                    </span>{" "}
                    ·{" "}
                    <Link to="/superadmin/numbers" className="text-primary underline">
                      Manage
                    </Link>
                  </p>
                )}
              </div>
              <Field
                label="Inbound queue"
                hint="Vendor queue for numbers that have none of their own"
              >
                <Input
                  value={draft.inboundQueue}
                  onChange={(e) => up({ inboundQueue: e.target.value })}
                  placeholder="None"
                  className="h-8 text-xs"
                />
              </Field>
              <Field label="Calling hours (IST)" hint="Must stay within 08:00–19:00">
                <div className="flex items-center gap-2">
                  <Input
                    type="time"
                    min="08:00"
                    max="19:00"
                    value={draft.callWindowStart}
                    onChange={(e) => up({ callWindowStart: e.target.value })}
                    className="h-8 text-xs"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="time"
                    min="08:00"
                    max="19:00"
                    value={draft.callWindowEnd}
                    onChange={(e) => up({ callWindowEnd: e.target.value })}
                    className="h-8 text-xs"
                  />
                </div>
              </Field>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save telephony settings
            </Button>

            <div className="space-y-2 border-t border-border pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium">Extensions</p>
                  <p className="text-[11px] text-muted-foreground">
                    SkyCRM users: {skyCreated} of {data.agents.length} created
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 text-xs"
                  disabled={creatingUsers || skyCreated === data.agents.length}
                  onClick={handleCreateSkycrmUsers}
                  title="Creates a user in SkyCRM for everyone below who doesn't have one yet"
                >
                  {creatingUsers ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <UserPlus className="h-3 w-3" />
                  )}
                  Create SkyCRM users
                </Button>
              </div>
              {data.agents.length === 0 && (
                <p className="text-xs text-muted-foreground">No active users in this company.</p>
              )}
              {data.agents.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{a.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {a.email} · {a.role}
                    </p>
                    {a.skycrmUser && (
                      <p
                        className={`truncate text-[11px] ${a.skycrmUser.status === "created" ? "text-emerald-600" : "text-destructive"}`}
                        title={a.skycrmUser.error ?? undefined}
                      >
                        SkyCRM user {a.skycrmUser.username}:{" "}
                        {a.skycrmUser.status === "created"
                          ? "created"
                          : `failed — ${a.skycrmUser.error ?? "unknown error"}`}
                      </p>
                    )}
                    {a.skycrmUser?.status === "created" &&
                      (a.skycrmUser.lastLoginError ? (
                        <p className="truncate text-[11px] text-destructive" title={a.skycrmUser.lastLoginError}>
                          SkyCRM login refused — {a.skycrmUser.lastLoginError}
                        </p>
                      ) : (
                        <p className="truncate text-[11px] text-muted-foreground">
                          {a.skycrmUser.lastLoginAt
                            ? `Logged in to SkyCRM ${new Date(a.skycrmUser.lastLoginAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                            : "Not logged in to SkyCRM yet — happens when their phone connects"}
                        </p>
                      ))}
                  </div>
                  <Input
                    value={extDrafts[a.id] ?? ""}
                    onChange={(e) => setExtDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                    placeholder="None"
                    inputMode="numeric"
                    className="h-8 w-24 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={
                      savingAgent === a.id || (extDrafts[a.id] ?? "").trim() === (a.extension ?? "")
                    }
                    onClick={() => handleSaveExtension(a.id)}
                  >
                    {savingAgent === a.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
