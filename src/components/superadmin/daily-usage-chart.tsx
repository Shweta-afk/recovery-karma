// Calls and Insights lookups per IST day — the Overview and a company's detail page.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DailyUsage } from "@/lib/platform-usage";
import { InfoTip } from "@/components/superadmin/help";

export function DailyUsageChart({
  daily,
  subtitle = "Calls and Insights lookups per day (IST), every company combined.",
}: {
  daily: DailyUsage[];
  subtitle?: string;
}) {
  const data = daily.map((d) => ({ ...d, label: d.day.slice(5).replace("-", "/") }));
  return (
    <Card className="h-full">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
          Daily usage <InfoTip k="dailyUsage" />
        </CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="pt-4">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
            />
            <Tooltip
              contentStyle={{
                fontSize: 11,
                background: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
              }}
              labelStyle={{ color: "var(--color-foreground)" }}
              cursor={{ fill: "var(--color-accent)", opacity: 0.4 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="calls" name="Calls" fill="oklch(0.58 0.18 258)" radius={[2, 2, 0, 0]} />
            <Bar
              dataKey="lookups"
              name="Insights lookups"
              fill="oklch(0.7 0.15 162)"
              radius={[2, 2, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
