// Superadmin: a company's share of the shared SkyCRM account — enablement, extensions, channels,
// inbound DID/queue, calling hours — plus per-user extension assignment.
import { useEffect, useState } from "react";
import { Phone, Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getAccessToken } from "@/lib/access-token";
import {
  getCompanyTelephony,
  saveCompanyTelephony,
  setAgentExtension,
  type CompanyTelephony,
} from "@/lib/telephony-actions.server";
import { GLOBAL_CHANNEL_LIMIT } from "@/lib/telephony/guard-rules";

interface Draft {
  enabled: boolean;
  seatLimit: string;
  channelLimit: string;
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
    if ((seatLimit !== null && !(seatLimit >= 0)) || !(channelLimit >= 0)) {
      toast.error("Extensions and channels must be non-negative numbers");
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

  const assigned = data?.agents.filter((a) => a.extension).length ?? 0;
  const available = data ? GLOBAL_CHANNEL_LIMIT - data.otherCompaniesChannels : GLOBAL_CHANNEL_LIMIT;

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
                label="Concurrent channels"
                hint={`Up to ${available} free of ${GLOBAL_CHANNEL_LIMIT} (other companies hold ${data.otherCompaniesChannels})`}
              >
                <Input
                  type="number"
                  min={0}
                  max={available}
                  value={draft.channelLimit}
                  onChange={(e) => up({ channelLimit: e.target.value })}
                  className="h-8 text-xs"
                />
              </Field>
              <Field label="Inbound DID" hint="Number borrowers call back on">
                <Input
                  value={draft.inboundDid}
                  onChange={(e) => up({ inboundDid: e.target.value })}
                  placeholder="None"
                  className="h-8 text-xs"
                />
              </Field>
              <Field label="Inbound queue" hint="Queue number assigned by the vendor">
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
              <p className="text-xs font-medium">Extensions</p>
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
