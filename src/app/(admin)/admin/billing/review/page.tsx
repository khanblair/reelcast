"use client";

import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { lastPageOffset, useKeepPrevious } from "@/components/admin/billing/hooks";
import { Pager } from "@/components/admin/billing/pager";
import { PaymentDetailSheet } from "@/components/admin/billing/payment-detail-sheet";
import { ReviewItem, ReviewItemSkeleton } from "@/components/admin/billing/review-item";
import { api, useQuery } from "@/lib/rpc/client";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

export default function AdminBillingReviewPage() {
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const result = useQuery(api.admin.billing.listNeedsReview, { includeReviewed, limit: PAGE_SIZE, offset });
  const { data, stale } = useKeepPrevious(result);
  const total = data?.total;

  // Marking the last item on a page as reviewed empties it: step back a page.
  if (total !== undefined && total > 0 && offset >= total) setOffset(lastPageOffset(total, PAGE_SIZE));

  return (
    <AdminPage
      title="Needs review"
      description="Money is refunded in the Pesapal dashboard, not here: look up the confirmation code there, then mark the payment as reviewed."
      actions={
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeReviewed}
            onChange={(e) => {
              setIncludeReviewed(e.target.checked);
              setOffset(0);
            }}
            className="size-4 cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          Show reviewed
        </label>
      }
    >
      {data === undefined || (data.rows.length === 0 && data.total > 0) ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <ReviewItemSkeleton key={i} />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            icon={CircleCheck}
            title={includeReviewed ? "No flagged payments yet" : "Nothing to review"}
            description="Payments that don't match their order, upgrades paid too late and reversals will show up here."
          />
        </div>
      ) : (
        <>
          <ul className={cn("space-y-3 transition-opacity duration-150 motion-reduce:transition-none", stale && "opacity-60")} aria-busy={stale ? true : undefined}>
            {data.rows.map((p) => (
              <li key={p._id}>
                <ReviewItem payment={p} onOpenDetails={setSelectedId} />
              </li>
            ))}
          </ul>
          <Pager total={total} offset={offset} pageSize={PAGE_SIZE} onOffsetChange={setOffset} className="px-0" />
        </>
      )}

      <PaymentDetailSheet paymentId={selectedId} onClose={() => setSelectedId(null)} />
    </AdminPage>
  );
}
