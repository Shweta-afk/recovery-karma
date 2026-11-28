import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileSpreadsheet, ImageDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmailReportButton } from "@/components/report-email";
import { getAccessToken } from "@/lib/access-token";
import { errorText } from "@/lib/app-error";
import { downloadBlob } from "@/lib/download-capture";
import { downloadXlsx, type XlsxCell } from "@/lib/xlsx-export";
import { getCollectionMis } from "@/lib/collection-mis.server";
import {
  clientMis,
  dailyCollection,
  differences,
  diffDay,
  inr,
  longDay,
  ranking,
  scaleColor,
  shortDay,
  zeroNumbers,
  type MisInput,
} from "@/lib/collection-mis";
import { todayIstKey } from "@/lib/date-filter";

// Fixed "spreadsheet" colours on purpose: these tables are exported as images and must look the
// same as the company's Excel MIS whatever theme the viewer uses.
const C = {
  border: "#000",
  title: "#D9D9D9",
  head: "#D9D9D9",
  subtotal: "#FCE4D6",
  grand: "#D9D9D9",
  white: "#FFFFFF",
  text: "#000",
};

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  background: C.white,
  color: C.text,
  fontFamily: "Calibri, Carlito, Arial, sans-serif",
  fontSize: 13,
};
const cell = (extra: React.CSSProperties = {}): React.CSSProperties => ({
  border: `1px solid ${C.border}`,
  padding: "3px 8px",
  whiteSpace: "nowrap",
  ...extra,
});
const num = (extra: React.CSSProperties = {}) => cell({ textAlign: "right", ...extra });

const istTime = () =>
  new Date()
    .toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
    .toUpperCase();

async function savePng(node: HTMLElement, filename: string) {
  const { toBlob } = await import("html-to-image");
  const blob = await toBlob(node, { pixelRatio: 2, backgroundColor: "#ffffff" });
  if (!blob) throw new Error("Could not draw the image");
  downloadBlob(filename, blob);
}

function Sheet({
  title,
  file,
  xlsx,
  children,
}: {
  title: string;
  file: string;
  xlsx: () => { headers: string[]; rows: XlsxCell[][] };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const png = async () => {
    if (!ref.current) return;
    setBusy(true);
    try {
      await savePng(ref.current, `${file}.png`);
    } catch (e) {
      toast.error(errorText(e, "Could not make the image"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-2" disabled={busy} onClick={png}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ImageDown className="h-4 w-4" />
            )}{" "}
            Image
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => {
              const x = xlsx();
              downloadXlsx(`${file}.xlsx`, [{ name: title, ...x }]);
            }}
          >
            <FileSpreadsheet className="h-4 w-4" /> Excel
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div ref={ref} style={{ display: "inline-block", background: C.white, padding: 1 }}>
          {children}
        </div>
      </div>
    </Card>
  );
}

function Title({ text, span }: { text: string; span: number }) {
  return (
    <tr>
      <th
        colSpan={span}
        style={cell({ background: C.title, fontWeight: 700, textAlign: "center", fontSize: 14 })}
      >
        {text}
      </th>
    </tr>
  );
}

function Head({ cols }: { cols: string[] }) {
  return (
    <tr>
      {cols.map((c) => (
        <th key={c} style={cell({ background: C.head, fontWeight: 700, textAlign: "center" })}>
          {c}
        </th>
      ))}
    </tr>
  );
}

export function CollectionMisView() {
  const [asOf, setAsOf] = useState(todayIstKey());
  const [data, setData] = useState<(MisInput & { teamCount: number }) | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    (async () => {
      try {
        const d = await getCollectionMis({ data: { accessToken: await getAccessToken(), asOf } });
        if (live) setData(d);
      } catch (e) {
        if (live) toast.error(errorText(e, "Could not load the MIS"));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [asOf]);

  const stamp = `${longDay(asOf)}, ${istTime()}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-3">
          <label className="text-xs text-muted-foreground space-y-1">
            <span className="block">MIS for</span>
            <Input
              type="date"
              value={asOf}
              max={todayIstKey()}
              onChange={(e) => e.target.value && setAsOf(e.target.value)}
              className="h-8 w-40"
            />
          </label>
          {loading && <Loader2 className="h-4 w-4 animate-spin mb-2" />}
        </div>
        <EmailReportButton />
      </div>
      <p className="text-xs text-muted-foreground">
        Collections are payments recorded in SamvadX (by agents, or from a bank's paid file), by IST
        day. Client = the portfolio's team. POS and loans = accounts in open portfolios. Projection
        = open PTPs (and Partially Paid balances) still due this month.
      </p>
      {data && data.teamCount === 0 && (
        <p className="text-sm text-muted-foreground">You don't manage any team yet.</p>
      )}
      {data && data.teamCount > 0 && <Sheets data={data} stamp={stamp} />}
    </div>
  );
}

function Sheets({ data, stamp }: { data: MisInput; stamp: string }) {
  const { asOf } = data;
  const today = `Sum of ${shortDay(asOf)}`;
  const dc = dailyCollection(data);
  const rk = ranking(data);
  const zn = zeroNumbers(data);
  const cm = clientMis(data);
  const df = differences(data);
  const fileDay = asOf;
  const time = stamp.split(", ")[1];

  return (
    <div className="space-y-4">
      {/* 1. Differences */}
      <Sheet
        title="Differences (last month vs this month)"
        file={`mis-differences-${fileDay}`}
        xlsx={() => ({
          headers: ["Client Name", diffDay(data.prevAsOf), diffDay(asOf), "Differences"],
          rows: [
            ...df.clients.map((c) => [c.client, c.prev, c.cur, c.diff]),
            ["Grand Total", df.grand.prev, df.grand.cur, df.grand.diff],
          ],
        })}
      >
        <table style={tableStyle}>
          <thead>
            <Title
              text={`Differences Between (${diffDay(data.prevAsOf)} & ${diffDay(asOf)} , ${time})`}
              span={4}
            />
            <Head cols={["Client Name", diffDay(data.prevAsOf), diffDay(asOf), "Differences"]} />
          </thead>
          <tbody>
            {df.clients.map((c) => {
              const worst = Math.min(...df.clients.map((x) => x.diff), -1);
              const shade = c.diff < 0 ? Math.min(1, c.diff / worst) : 0;
              return (
                <tr key={c.client}>
                  <td style={cell()}>{c.client}</td>
                  <td style={num()}>{inr(c.prev, false)}</td>
                  <td style={num()}>{inr(c.cur, false)}</td>
                  <td
                    style={num({
                      background: shade ? `rgba(248,105,107,${0.25 + shade * 0.75})` : C.white,
                    })}
                  >
                    {inr(c.diff, false)}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td style={cell({ background: C.grand, fontWeight: 700 })}>Grand Total</td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>
                {inr(df.grand.prev, false)}
              </td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>
                {inr(df.grand.cur, false)}
              </td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>
                {inr(df.grand.diff, false)}
              </td>
            </tr>
          </tbody>
        </table>
      </Sheet>

      {/* 2. Ranking */}
      <Sheet
        title="Daily Collection Ranking MIS"
        file={`mis-ranking-${fileDay}`}
        xlsx={() => ({
          headers: ["CHAMPS", "Sum of pos", "Count of LOAN ID", today, "Sum of Total Paid", "RANK"],
          rows: rk.map((r) => [r.name, Math.round(r.pos), r.loans, r.today, r.total, r.rank]),
        })}
      >
        <table style={tableStyle}>
          <thead>
            <Title text={`DAILY COLLECTION RANKING MIS (${stamp})`} span={6} />
            <Head
              cols={[
                "CHAMPS",
                "Sum of pos",
                "Count of LOAN ID",
                today,
                "Sum of Total Paid",
                "RANK",
              ]}
            />
          </thead>
          <tbody>
            {rk.map((r, i) => (
              <tr key={r.name + i}>
                <td style={cell()}>{r.name.toUpperCase()}</td>
                <td style={num()}>{Math.round(r.pos)}</td>
                <td style={num()}>{r.loans}</td>
                <td style={num()}>{inr(r.today)}</td>
                <td style={num()}>{inr(r.total)}</td>
                <td style={cell({ textAlign: "center", background: scaleColor(i, rk.length) })}>
                  {r.rank}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Sheet>

      {/* 3. Zero numbers */}
      <Sheet
        title="Zero Numbers MIS"
        file={`mis-zero-numbers-${fileDay}`}
        xlsx={() => ({
          headers: [
            "Row Labels",
            ...zn.days.map((d) => `Sum of ${shortDay(d)}`),
            "Zero Number",
            "Average",
          ],
          rows: zn.agents.map((a) => [a.name, ...a.perDay, a.zeroDays, a.average]),
        })}
      >
        <table style={{ ...tableStyle, fontSize: 11 }}>
          <thead>
            <Title text={`ZERO NUMBERS MIS (${stamp})`} span={zn.days.length + 3} />
            <Head
              cols={[
                "Row Labels",
                ...zn.days.map((d) => `Sum of ${shortDay(d)}`),
                "Zero Number",
                "Average",
              ]}
            />
          </thead>
          <tbody>
            {zn.agents.map((a, i) => {
              const maxAvg = Math.max(1, ...zn.agents.map((x) => x.average));
              return (
                <tr key={a.name + i}>
                  <td style={cell()}>{a.name.toUpperCase()}</td>
                  {a.perDay.map((v, j) => (
                    <td key={j} style={num()}>
                      {Math.round(v)}
                    </td>
                  ))}
                  <td
                    style={cell({
                      textAlign: "center",
                      background: scaleColor(i, zn.agents.length, true),
                    })}
                  >
                    {a.zeroDays}
                  </td>
                  <td
                    style={num({
                      background: `linear-gradient(to right, #8EA9DB ${(a.average / maxAvg) * 100}%, #fff 0)`,
                    })}
                  >
                    {a.average}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Sheet>

      {/* 4. Daily collection */}
      <Sheet
        title="Daily Collection MIS"
        file={`mis-daily-collection-${fileDay}`}
        xlsx={() => ({
          headers: [
            "Client Name",
            "CHAMPS",
            "Sum of pos",
            "Count of LOAN ID",
            today,
            "Sum of Total Paid",
          ],
          rows: [
            ...dc.groups.flatMap((g) => [
              ...g.agents.map((a, i) => [
                i === 0 ? g.client : "",
                a.name,
                Math.round(a.pos),
                a.loans,
                a.today,
                a.total,
              ]),
              [`${g.client} Total`, "", Math.round(g.pos), g.loans, g.today, g.total],
            ]),
            [
              "Grand Total",
              "",
              Math.round(dc.grand.pos),
              dc.grand.loans,
              dc.grand.today,
              dc.grand.total,
            ],
          ],
        })}
      >
        <table style={tableStyle}>
          <thead>
            <Title text={`DAILY COLLECTION MIS (${stamp})`} span={6} />
            <Head
              cols={[
                "Client Name",
                "CHAMPS",
                "Sum of pos",
                "Count of LOAN ID",
                today,
                "Sum of Total Paid",
              ]}
            />
          </thead>
          <tbody>
            {dc.groups.map((g) => [
              ...g.agents.map((a, i) => (
                <tr key={g.client + a.name}>
                  <td style={cell({ fontWeight: 700 })}>{i === 0 ? g.client : ""}</td>
                  <td style={cell()}>{a.name.toUpperCase()}</td>
                  <td style={num()}>{Math.round(a.pos)}</td>
                  <td style={num()}>{a.loans}</td>
                  <td style={num()}>{inr(a.today)}</td>
                  <td style={num()}>{inr(a.total)}</td>
                </tr>
              )),
              <tr key={g.client + "-total"}>
                <td style={cell({ background: C.subtotal, fontWeight: 700 })}>{g.client} Total</td>
                <td style={cell({ background: C.subtotal })} />
                <td style={num({ background: C.subtotal, fontWeight: 700 })}>
                  {Math.round(g.pos)}
                </td>
                <td style={num({ background: C.subtotal, fontWeight: 700 })}>{g.loans}</td>
                <td style={num({ background: C.subtotal, fontWeight: 700 })}>{inr(g.today)}</td>
                <td style={num({ background: C.subtotal, fontWeight: 700 })}>{inr(g.total)}</td>
              </tr>,
            ])}
            <tr>
              <td style={cell({ background: C.grand, fontWeight: 700 })}>Grand Total</td>
              <td style={cell({ background: C.grand })} />
              <td style={num({ background: C.grand, fontWeight: 700 })}>
                {Math.round(dc.grand.pos)}
              </td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>{dc.grand.loans}</td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>{inr(dc.grand.today)}</td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>{inr(dc.grand.total)}</td>
            </tr>
          </tbody>
        </table>
      </Sheet>

      {/* 5. Client */}
      <Sheet
        title="Daily Collection Client MIS"
        file={`mis-client-${fileDay}`}
        xlsx={() => ({
          headers: [
            "Client Name",
            "Sum of pos",
            "Count of LOAN ID",
            "Projection",
            today,
            "Sum of Total Paid",
          ],
          rows: [
            ...cm.clients.map((c) => [
              c.client,
              Math.round(c.pos),
              c.loans,
              c.projection,
              c.today,
              c.total,
            ]),
            [
              "Grand Total",
              Math.round(cm.grand.pos),
              cm.grand.loans,
              cm.grand.projection,
              cm.grand.today,
              cm.grand.total,
            ],
          ],
        })}
      >
        <table style={tableStyle}>
          <thead>
            <Title text={`DAILY COLLECTION CLIENT MIS (${stamp})`} span={6} />
            <Head
              cols={[
                "Client Name",
                "Sum of pos",
                "Count of LOAN ID",
                "Projection",
                today,
                "Sum of Total Paid",
              ]}
            />
          </thead>
          <tbody>
            {cm.clients.map((c) => (
              <tr key={c.client}>
                <td style={cell()}>{c.client}</td>
                <td style={num()}>{Math.round(c.pos)}</td>
                <td style={num()}>{c.loans}</td>
                <td style={num()}>{Math.round(c.projection)}</td>
                <td style={num()}>{inr(c.today)}</td>
                <td style={num()}>{inr(c.total)}</td>
              </tr>
            ))}
            <tr>
              <td style={cell({ background: C.grand, fontWeight: 700 })}>Grand Total</td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>
                {Math.round(cm.grand.pos)}
              </td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>{cm.grand.loans}</td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>
                {Math.round(cm.grand.projection)}
              </td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>{inr(cm.grand.today)}</td>
              <td style={num({ background: C.grand, fontWeight: 700 })}>{inr(cm.grand.total)}</td>
            </tr>
          </tbody>
        </table>
      </Sheet>
    </div>
  );
}
