"use client";

import { formatMoney } from "@/components/billing/plans";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, paymentTitle, type BillingPayment } from "./format";
import { FlagMarker, PaymentStatus } from "./status-dot";
import { NUM, SkeletonRows, Td, Th, type SkeletonCell } from "./table-parts";

const SKELETON_CELLS: SkeletonCell[] = [
  { w: "w-32" },
  { w: "w-44", twoLine: true },
  { w: "w-28" },
  { w: "w-16", right: true },
  { w: "w-24" },
  { w: "w-20" },
];

/**
 * Payments list. Clicking a row (or pressing Enter on the date button) calls `onSelect` with the payment id.
 * The date cell holds a real button so the row is reachable from the keyboard; the row click is a mouse shortcut.
 */
export function PaymentsTable({
  rows,
  onSelect,
  showMethod = true,
  skeletonRows = 8,
}: {
  rows: BillingPayment[] | undefined;
  onSelect: (id: string) => void;
  showMethod?: boolean;
  /** How many placeholder rows to show while loading (match the page size the caller asks for). */
  skeletonRows?: number;
}) {
  return (
    <Table className="min-w-[720px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <Th>Date</Th>
          <Th>Customer</Th>
          <Th>Payment</Th>
          <Th className="text-right">Amount</Th>
          <Th>Status</Th>
          {showMethod ? <Th>Method</Th> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows === undefined ? (
          <SkeletonRows rows={skeletonRows} cells={showMethod ? SKELETON_CELLS : SKELETON_CELLS.slice(0, 5)} />
        ) : (
          rows.map((p) => {
            const date = formatDateTime(p.createdAt) ?? "—";
            return (
              <TableRow key={p._id} onClick={() => onSelect(p._id)} className="cursor-pointer">
                <Td className="whitespace-nowrap">
                  <button
                    type="button"
                    aria-label={`Open payment details, ${date}`}
                    className="rounded-sm text-left tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {date}
                  </button>
                </Td>
                <Td>
                  <p className="max-w-[240px] truncate">{p.email}</p>
                  {p.name ? <p className="max-w-[240px] truncate text-xs text-muted-foreground">{p.name}</p> : null}
                </Td>
                <Td className="whitespace-nowrap">{paymentTitle(p)}</Td>
                <Td className={`${NUM} whitespace-nowrap font-medium`}>{formatMoney(p.amount, p.currency)}</Td>
                <Td>
                  <PaymentStatus payment={p} />
                  {p.flag ? <FlagMarker payment={p} className="mt-0.5 flex" /> : null}
                </Td>
                {showMethod ? <Td className="whitespace-nowrap text-muted-foreground">{p.paymentMethod ?? "—"}</Td> : null}
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
