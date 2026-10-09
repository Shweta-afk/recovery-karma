import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GLOSSARY, HELP_SECTIONS, PAGE_GUIDES, type PageGuideKey } from "@/lib/superadmin-glossary";

export const Route = createFileRoute("/superadmin/help")({
  head: () => ({
    meta: [
      { title: "Help · SamvadX Platform" },
      {
        name: "description",
        content: "What every page and number in the SamvadX superadmin portal means.",
      },
    ],
  }),
  component: SuperadminHelpPage,
});

const PAGES: { key: PageGuideKey; to: string }[] = [
  { key: "overview", to: "/superadmin" },
  { key: "companies", to: "/superadmin/companies" },
  { key: "company", to: "/superadmin/companies" },
  { key: "revenue", to: "/superadmin/revenue" },
  { key: "wallet", to: "/superadmin/wallet" },
  { key: "insights", to: "/superadmin/insights" },
  { key: "invoices", to: "/superadmin/invoices" },
  { key: "activity", to: "/superadmin/activity" },
];

function SuperadminHelpPage() {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Help</h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          What each page is for and what every number means. You can also hover or tap the{" "}
          <span className="font-medium text-foreground">ⓘ</span> next to any number in the portal.
        </p>
      </div>

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 text-xs leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">What this portal shows: </span>
          how much each company uses SamvadX's own features — calling and Insights — and what
          SamvadX bills them. It never shows how much money a company has collected from its
          borrowers, and never shows individual borrowers' details.
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">The pages</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {PAGES.map(({ key, to }) => {
            const g = PAGE_GUIDES[key];
            return (
              <Card key={key}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">
                    <Link to={to} className="hover:underline">
                      {g.title}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {g.points.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <BookOpen className="h-4 w-4 text-primary" /> What every number means
        </h2>
        {HELP_SECTIONS.map((group) => (
          <Card key={group.title}>
            <CardHeader className="border-b border-border pb-2">
              <CardTitle className="text-sm font-semibold">{group.title}</CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
              <dl className="divide-y divide-border">
                {group.keys.map((k) => (
                  <div key={k} className="grid gap-1 py-2 sm:grid-cols-[180px_1fr] sm:gap-4">
                    <dt className="text-xs font-medium text-foreground">{GLOSSARY[k].term}</dt>
                    <dd className="text-xs leading-relaxed text-muted-foreground">
                      {GLOSSARY[k].text}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
