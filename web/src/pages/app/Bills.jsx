import { Receipt } from "@phosphor-icons/react";
import { Bezel } from "../../components/ui/Bezel";
import { Button } from "../../components/ui/Button";
import { EmptyState, ErrorState, Skeleton } from "../../components/ui/Feedback";
import { MonthlyBars } from "../../components/ui/MonthlyBars";
import { Reveal } from "../../components/ui/Reveal";
import { useBills } from "../../hooks/queries";
import { useUploads } from "../../hooks/useUploads";
import { formatDate, formatMoney } from "../../lib/format";
import { PageHeader } from "./PageHeader";

export default function Bills() {
  const bills = useBills();
  const { setPanelOpen } = useUploads();
  const d = bills.data;
  const otherCurrencies = d ? Object.keys(d.byCurrency).filter((c) => c !== (d.currency ?? "—")) : [];

  return (
    <>
      <PageHeader eyebrow="Bill Hub" title="Receipts, totalled for you">
        Upload a photo of any bill. Gemini reads the vendor, date and grand total, then it lands here automatically.
      </PageHeader>

      {bills.isPending ? (
        <div className="grid gap-4 lg:grid-cols-12">
          <Skeleton className="h-64 lg:col-span-5" />
          <Skeleton className="h-64 lg:col-span-7" />
        </div>
      ) : bills.isError ? (
        <ErrorState error={bills.error} onRetry={() => bills.refetch()} />
      ) : !d.count ? (
        <EmptyState icon={Receipt} title="No receipts yet" action={<Button variant="primary" onClick={() => setPanelOpen(true)}>Upload a receipt</Button>}>
          Snap a restaurant bill, invoice or grocery receipt. Everything else you upload is simply ignored here.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-12">
            <Reveal className="lg:col-span-5">
              <Bezel coreClassName="flex h-full flex-col justify-between gap-10 p-8">
                <p className="text-sm text-mist">Total spend</p>
                <div>
                  <p className="font-mono text-5xl font-medium tracking-tight sm:text-6xl">{formatMoney(d.byCurrency[d.currency ?? "—"] ?? d.total, d.currency)}</p>
                  <p className="mt-3 text-sm text-mist">
                    across <span className="text-fog">{d.count}</span> {d.count === 1 ? "receipt" : "receipts"}
                    {otherCurrencies.length > 0 && (
                      <> · plus {otherCurrencies.map((c) => formatMoney(d.byCurrency[c], c === "—" ? null : c)).join(", ")}</>
                    )}
                  </p>
                </div>
              </Bezel>
            </Reveal>
            <Reveal className="lg:col-span-7" delay={0.08}>
              <Bezel coreClassName="h-full p-8">
                <p className="mb-8 text-sm text-mist">Spend by month{d.currency ? ` (${d.currency})` : ""}</p>
                {d.byMonth.length ? <MonthlyBars data={d.byMonth} currency={d.currency} /> : <p className="text-sm text-haze">No dated receipts yet.</p>}
              </Bezel>
            </Reveal>
          </div>

          <Reveal delay={0.12}>
            <Bezel coreClassName="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <caption className="sr-only">All receipts</caption>
                  <thead>
                    <tr className="border-b border-white/[0.06] text-left text-[11px] uppercase tracking-[0.16em] text-haze">
                      <th scope="col" className="px-6 py-4 font-medium">Vendor</th>
                      <th scope="col" className="px-6 py-4 font-medium">Date</th>
                      <th scope="col" className="px-6 py-4 font-medium">Confidence</th>
                      <th scope="col" className="px-6 py-4 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.receipts.map((r) => (
                      <tr key={r.id} className="border-b border-white/[0.04] transition last:border-0 hover:bg-white/[0.02]">
                        <td className="px-6 py-4">{r.vendor || <span className="text-haze">Unknown vendor</span>}</td>
                        <td className="px-6 py-4 text-mist">{formatDate(r.receipt_date || r.created_at)}</td>
                        <td className="px-6 py-4">
                          <span className={`font-mono text-xs ${r.confidence >= 0.8 ? "text-ok" : r.confidence >= 0.5 ? "text-warn" : "text-bad"}`}>
                            {Math.round((r.confidence || 0) * 100)}%
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right font-mono">{formatMoney(r.total, r.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Bezel>
          </Reveal>
        </div>
      )}
    </>
  );
}
