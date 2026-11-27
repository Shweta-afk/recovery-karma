import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Loader2,
  Mail,
  Phone,
  Plus,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import {
  addContact,
  addLeadActivity,
  addTask,
  assignLead,
  completeTask,
  getLead,
  removeContact,
  sendLeadEmail,
  updateLead,
  type SalesActivityRow,
  type SalesContactRow,
  type SalesLeadRow,
  type SalesPerson,
  type SalesTaskRow,
} from "@/lib/sales.server";
import {
  AGENT_BANDS,
  SALES_STAGES,
  sourceLabel,
  stageLabel,
  type SalesStage,
} from "@/lib/sales/sales-rules";
import { fmtDate, fmtDateTime, fmtMoney, personName } from "@/lib/sales/sales-store";
import { todayIstKey } from "@/lib/date-filter";

export const Route = createFileRoute("/sales/leads/$id")({
  head: () => ({ meta: [{ title: "Lead · SamvadX Sales" }] }),
  component: SalesLeadPage,
});

interface LoadedLead {
  lead: SalesLeadRow;
  contacts: SalesContactRow[];
  activities: SalesActivityRow[];
  tasks: SalesTaskRow[];
  people: SalesPerson[];
  canEdit: boolean;
  me: { kind: "sales" | "superadmin"; salesUserId: string | null; name: string };
}

function SalesLeadPage() {
  const { id } = useParams({ from: "/sales/leads/$id" });
  const [state, setState] = useState<LoadedLead | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const token = await getAccessToken();
      const r = await getLead({ data: { accessToken: token, id } });
      setState(r as LoadedLead);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (error) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
        <Link to="/sales/leads" className="mt-3 inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to leads
        </Link>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const { lead, contacts, activities, tasks, people, canEdit, me } = state;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <Link to="/sales/leads" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> All leads
        </Link>
      </div>

      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{lead.company_name}</h1>
          <Badge variant="outline">{stageLabel(lead.stage)}</Badge>
          <Badge variant="outline" className="text-[11px]">{sourceLabel(lead.source)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {lead.contact_name ?? "No contact name"}
          {lead.city ? ` · ${lead.city}` : ""} · owner: {personName(people, lead.owner_id)} · added {fmtDate(lead.created_at)}
          {lead.created_by_name ? ` by ${lead.created_by_name}` : ""}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <LeadDetailsCard lead={lead} people={people} canEdit={canEdit} me={me} reload={reload} />
          <ContactsCard lead={lead} contacts={contacts} canEdit={canEdit} reload={reload} />
          <TimelineCard lead={lead} activities={activities} canEdit={canEdit} reload={reload} />
        </div>
        <div className="space-y-4">
          <StageCard lead={lead} canEdit={canEdit} reload={reload} />
          <EmailCard lead={lead} contacts={contacts} canEdit={canEdit} reload={reload} />
          <TasksCard lead={lead} tasks={tasks} canEdit={canEdit} reload={reload} />
        </div>
      </div>
    </div>
  );
}

function LeadDetailsCard({
  lead,
  people,
  canEdit,
  me,
  reload,
}: {
  lead: SalesLeadRow;
  people: SalesPerson[];
  canEdit: boolean;
  me: LoadedLead["me"];
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    company_name: lead.company_name,
    contact_name: lead.contact_name ?? "",
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    city: lead.city ?? "",
    agents_band: lead.agents_band ?? "",
    agents_count: lead.agents_count?.toString() ?? "",
    deal_seats: lead.deal_seats?.toString() ?? "",
    deal_monthly: lead.deal_monthly?.toString() ?? "",
    lenders: lead.lenders ?? "",
    notes: lead.notes ?? "",
  });

  async function save() {
    try {
      const token = await getAccessToken();
      await updateLead({
        data: {
          accessToken: token,
          id: lead.id,
          patch: {
            company_name: draft.company_name.trim(),
            contact_name: draft.contact_name.trim() || null,
            phone: draft.phone.trim() || null,
            email: draft.email.trim() || null,
            city: draft.city.trim() || null,
            agents_band: draft.agents_band || null,
            agents_count: draft.agents_count ? Number(draft.agents_count) : null,
            deal_seats: draft.deal_seats ? Number(draft.deal_seats) : null,
            deal_monthly: draft.deal_monthly ? Number(draft.deal_monthly) : null,
            lenders: draft.lenders.trim() || null,
            notes: draft.notes.trim() || null,
          },
        },
      });
      toast.success("Saved");
      setEditing(false);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function changeOwner(v: string) {
    try {
      const token = await getAccessToken();
      await assignLead({ data: { accessToken: token, id: lead.id, ownerId: v === "none" ? null : v } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const showClaim = me.kind === "sales" && lead.owner_id === null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">Lead details</CardTitle>
        <div className="flex items-center gap-2">
          {showClaim && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => changeOwner(me.salesUserId!)}>
              <UserCheck className="h-3.5 w-3.5" /> Take
            </Button>
          )}
          {canEdit && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {editing ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Row label="Company" value={draft.company_name} onChange={(v) => setDraft({ ...draft, company_name: v })} />
              <Row label="Contact" value={draft.contact_name} onChange={(v) => setDraft({ ...draft, contact_name: v })} />
              <Row label="Phone" value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
              <Row label="Email" value={draft.email} onChange={(v) => setDraft({ ...draft, email: v })} />
              <Row label="City" value={draft.city} onChange={(v) => setDraft({ ...draft, city: v })} />
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">Team size (band)</span>
                <Select value={draft.agents_band} onValueChange={(v) => setDraft({ ...draft, agents_band: v })}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {AGENT_BANDS.map((b) => (
                      <SelectItem key={b} value={b} className="text-xs">
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <Row label="Agents (exact)" value={draft.agents_count} onChange={(v) => setDraft({ ...draft, agents_count: v.replace(/[^0-9]/g, "") })} />
              <Row label="Seats on offer" value={draft.deal_seats} onChange={(v) => setDraft({ ...draft, deal_seats: v.replace(/[^0-9]/g, "") })} />
              <Row label="Deal value / month (₹)" value={draft.deal_monthly} onChange={(v) => setDraft({ ...draft, deal_monthly: v.replace(/[^0-9]/g, "") })} />
              <Row label="Lenders / products" value={draft.lenders} onChange={(v) => setDraft({ ...draft, lenders: v })} />
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">Notes</span>
              <textarea
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={save}>
                Save
              </Button>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <Info label="Contact" value={lead.contact_name} />
            <Info label="Phone" value={lead.phone} icon={lead.phone ? <Phone className="h-3 w-3" /> : null} />
            <Info label="Email" value={lead.email} icon={lead.email ? <Mail className="h-3 w-3" /> : null} />
            <Info label="City" value={lead.city} />
            <Info label="Team size" value={lead.agents_band} />
            <Info label="Agents (exact)" value={lead.agents_count?.toString() ?? null} />
            <Info label="Deal value / month" value={fmtMoney(lead.deal_monthly)} />
            <Info label="Lenders / products" value={lead.lenders} />
            <Info label="Website page" value={lead.website_page} />
            <Info label="Next follow-up" value={fmtDate(lead.next_follow_up)} />
            {lead.notes && (
              <div className="col-span-2 rounded-md border border-border bg-muted/30 p-2 text-xs text-foreground/90 whitespace-pre-wrap">
                {lead.notes}
              </div>
            )}
          </div>
        )}
        {me.kind === "superadmin" && (
          <div className="flex items-center gap-2 border-t border-border pt-2 text-xs">
            <span className="text-muted-foreground">Owner</span>
            <Select value={lead.owner_id ?? "none"} onValueChange={changeOwner}>
              <SelectTrigger className="h-8 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">
                  Unassigned
                </SelectItem>
                {people.filter((p) => p.is_active).map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-xs" />
    </label>
  );
}

function Info({ label, value, icon }: { label: string; value: string | null; icon?: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="flex items-center gap-1.5 text-foreground">
        {icon} {value || "—"}
      </div>
    </div>
  );
}

function StageCard({
  lead,
  canEdit,
  reload,
}: {
  lead: SalesLeadRow;
  canEdit: boolean;
  reload: () => Promise<void>;
}) {
  const [moving, setMoving] = useState<SalesStage | null>(null);
  const [reason, setReason] = useState("");

  async function go(to: SalesStage) {
    if (to === "lost") {
      setMoving(to);
      return;
    }
    try {
      const token = await getAccessToken();
      await updateLead({ data: { accessToken: token, id: lead.id, patch: { stage: to } } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirmLost() {
    if (!reason.trim()) {
      toast.error("Say why it was lost.");
      return;
    }
    try {
      const token = await getAccessToken();
      await updateLead({
        data: { accessToken: token, id: lead.id, patch: { stage: "lost", lost_reason: reason.trim() } },
      });
      setMoving(null);
      setReason("");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Stage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="space-y-1">
          {SALES_STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              disabled={!canEdit || s.key === lead.stage}
              onClick={() => go(s.key)}
              className={`flex w-full items-center justify-between rounded-md border border-border px-2 py-1.5 text-left transition ${
                s.key === lead.stage ? "bg-primary/10 font-medium text-foreground" : "hover:bg-accent/40"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              <span>{s.label}</span>
              {s.key === lead.stage ? <Badge variant="outline" className="text-[10px]">current</Badge> : <ChevronRight className="h-3.5 w-3.5 opacity-60" />}
            </button>
          ))}
        </div>
        {lead.stage === "lost" && lead.lost_reason && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
            Lost: {lead.lost_reason}
          </div>
        )}
        {moving === "lost" && (
          <div className="space-y-2 border-t border-border pt-2">
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Why was it lost?</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-input bg-background px-2 py-1"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setMoving(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={confirmLost}>
                Mark lost
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TimelineCard({
  lead,
  activities,
  canEdit,
  reload,
}: {
  lead: SalesLeadRow;
  activities: SalesActivityRow[];
  canEdit: boolean;
  reload: () => Promise<void>;
}) {
  const [kind, setKind] = useState<"note" | "call" | "email" | "meeting">("note");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!body.trim()) return;
    setSaving(true);
    try {
      const token = await getAccessToken();
      await addLeadActivity({ data: { accessToken: token, leadId: lead.id, kind, body: body.trim() } });
      setBody("");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const KIND_LABEL: Record<string, string> = {
    created: "Created",
    note: "Note",
    call: "Call",
    email: "Email",
    meeting: "Meeting",
    stage: "Stage",
    assigned: "Assigned",
    task_done: "Task",
    website: "Website form",
    import: "Import",
    updated: "Change",
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Timeline</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {canEdit && (
          <div className="flex items-start gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="note" className="text-xs">Note</SelectItem>
                <SelectItem value="call" className="text-xs">Call</SelectItem>
                <SelectItem value="email" className="text-xs">Email</SelectItem>
                <SelectItem value="meeting" className="text-xs">Meeting</SelectItem>
              </SelectContent>
            </Select>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder="Spoke to them about…"
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
            <Button size="sm" onClick={add} disabled={saving || !body.trim()}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Log"}
            </Button>
          </div>
        )}
        <div className="space-y-2">
          {activities.length === 0 && (
            <p className="text-xs text-muted-foreground">Nothing logged yet.</p>
          )}
          {activities.map((a) => (
            <div key={a.id} className="rounded-md border border-border bg-muted/20 p-2 text-xs">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  <Badge variant="outline" className="mr-2 text-[10px]">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                  {a.actor_name ?? "Someone"}
                </span>
                <span>{fmtDateTime(a.occurred_at)}</span>
              </div>
              {a.body && <div className="mt-1 whitespace-pre-wrap text-foreground">{a.body}</div>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ContactsCard({
  lead,
  contacts,
  canEdit,
  reload,
}: {
  lead: SalesLeadRow;
  contacts: SalesContactRow[];
  canEdit: boolean;
  reload: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", designation: "", phone: "", email: "" });

  async function save() {
    if (!form.name.trim()) {
      toast.error("Name is required.");
      return;
    }
    try {
      const token = await getAccessToken();
      await addContact({
        data: {
          accessToken: token,
          leadId: lead.id,
          name: form.name.trim(),
          designation: form.designation.trim() || null,
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
        },
      });
      setForm({ name: "", designation: "", phone: "", email: "" });
      setAdding(false);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(contactId: string) {
    try {
      const token = await getAccessToken();
      await removeContact({ data: { accessToken: token, leadId: lead.id, contactId } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">People at the company</CardTitle>
        {canEdit && !adding && (
          <Button size="sm" variant="outline" className="gap-1" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {contacts.length === 0 && !adding && (
          <p className="text-muted-foreground">No contacts added yet.</p>
        )}
        {contacts.map((c) => (
          <div key={c.id} className="flex items-start justify-between rounded-md border border-border bg-muted/20 p-2">
            <div>
              <div className="font-medium text-foreground">{c.name}</div>
              <div className="text-muted-foreground">
                {[c.designation, c.phone, c.email].filter(Boolean).join(" · ") || "—"}
              </div>
            </div>
            {canEdit && (
              <button className="text-muted-foreground hover:text-destructive" onClick={() => remove(c.id)}>
                Remove
              </button>
            )}
          </div>
        ))}
        {adding && (
          <div className="rounded-md border border-border p-2">
            <div className="grid grid-cols-2 gap-2">
              <Row label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
              <Row label="Designation" value={form.designation} onChange={(v) => setForm({ ...form, designation: v })} />
              <Row label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
              <Row label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={save}>Save</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmailCard({
  lead,
  contacts,
  canEdit,
  reload,
}: {
  lead: SalesLeadRow;
  contacts: SalesContactRow[];
  canEdit: boolean;
  reload: () => Promise<void>;
}) {
  const emailChoices = Array.from(
    new Set(
      [lead.email, ...contacts.map((c) => c.email)].filter((e): e is string => !!(e && e.includes("@"))),
    ),
  );
  const [to, setTo] = useState(emailChoices[0] ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!to && emailChoices[0]) setTo(emailChoices[0]);
  }, [emailChoices, to]);

  async function send() {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error("Fill in who, what and the message.");
      return;
    }
    setSending(true);
    try {
      const token = await getAccessToken();
      const r = await sendLeadEmail({
        data: {
          accessToken: token,
          leadId: lead.id,
          to: to.trim(),
          subject: subject.trim(),
          body: body.trim(),
        },
      });
      if (!r.ok) {
        toast.error(r.error ?? "Email could not be sent yet.");
      } else {
        toast.success("Sent");
        setSubject("");
        setBody("");
        await reload();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const TEMPLATES: { label: string; subject: string; body: string }[] = [
    {
      label: "Follow up",
      subject: `Following up — ${lead.company_name}`,
      body: `Hello,\n\nFollowing up on our conversation about SamvadX. Could you share a convenient time this week for a quick call?\n\nBest,`,
    },
    {
      label: "Demo invite",
      subject: `SamvadX demo for ${lead.company_name}`,
      body: `Hello,\n\nHappy to walk your team through SamvadX. Please pick a slot that suits you:\n\n• Option 1: …\n• Option 2: …\n\nThe demo takes about 30 minutes.`,
    },
    {
      label: "Thanks after demo",
      subject: `Thank you — ${lead.company_name}`,
      body: `Hello,\n\nThank you for your time today. I'll follow up with the proposal and next steps shortly. Please tell me if any new question came up.`,
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Mail className="h-4 w-4" /> Email
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {!canEdit ? (
          <p className="text-muted-foreground">Take this lead first to send email.</p>
        ) : emailChoices.length === 0 ? (
          <p className="text-muted-foreground">Add an email address to this lead or a contact first.</p>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-muted-foreground">To</span>
              <Select value={to} onValueChange={setTo}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {emailChoices.map((e) => (
                    <SelectItem key={e} value={e} className="text-xs">
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="flex flex-wrap gap-1 text-[11px]">
              <span className="text-muted-foreground">Template:</span>
              {TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => {
                    setSubject(t.subject);
                    setBody(t.body);
                  }}
                  className="rounded-md border border-border px-2 py-0.5 hover:bg-accent"
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="h-8 text-xs"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Message…"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                Sent through SamvadX; signed off from you as SamvadX Sales.
              </span>
              <Button size="sm" onClick={send} disabled={sending}>
                {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Send"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TasksCard({
  lead,
  tasks,
  canEdit,
  reload,
}: {
  lead: SalesLeadRow;
  tasks: SalesTaskRow[];
  canEdit: boolean;
  reload: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(todayIstKey());
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const token = await getAccessToken();
      await addTask({ data: { accessToken: token, leadId: lead.id, title: title.trim(), dueDate: due } });
      setTitle("");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(taskId: string, done: boolean) {
    try {
      const token = await getAccessToken();
      await completeTask({ data: { accessToken: token, leadId: lead.id, taskId, done } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Tasks</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {tasks.length === 0 && <p className="text-muted-foreground">Nothing to do.</p>}
        {tasks.map((t) => (
          <label key={t.id} className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-2">
            <input
              type="checkbox"
              checked={!!t.done_at}
              disabled={!canEdit}
              onChange={(e) => toggle(t.id, e.target.checked)}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className={t.done_at ? "line-through text-muted-foreground" : "text-foreground"}>{t.title}</div>
              <div className="text-[11px] text-muted-foreground">Due {fmtDate(t.due_date)}</div>
            </div>
          </label>
        ))}
        {canEdit && (
          <div className="space-y-1 border-t border-border pt-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Call back / send proposal / confirm demo…"
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
            />
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={due}
                min={todayIstKey()}
                onChange={(e) => setDue(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
              <Button size="sm" onClick={add} disabled={saving || !title.trim()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add task"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
