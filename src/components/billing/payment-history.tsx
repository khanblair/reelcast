import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PLAN_NAMES, formatDate, formatMoney, type PlanKey } from "./plans";

export type PaymentRow = {
  _id: string;
  purpose: "initial" | "renewal" | "upgrade";
  plan: PlanKey;
  amount: number;
  currency: string;
  status: "paid" | "pending" | "failed" | "reversed" | "review";
  paymentMethod?: string;
  createdAt: number;
  paidAt?: number;
};

const PURPOSE: Record<PaymentRow["purpose"], string> = { initial: "Subscription", renewal: "Renewal", upgrade: "Upgrade" };

const STATUS: Record<PaymentRow["status"], { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  paid: { label: "Paid", variant: "success" },
  pending: { label: "Pending", variant: "secondary" },
  failed: { label: "Failed", variant: "destructive" },
  reversed: { label: "Reversed", variant: "destructive" },
  review: { label: "Under review", variant: "warning" },
};

/** Pesapal reports e.g. "MPESA", "AIRTELMONEY", "VISA". */
function methodLabel(m?: string): string {
  if (!m) return "-";
  const lower = m.toLowerCase();
  if (lower.includes("mpesa")) return "M-Pesa";
  if (lower.includes("airtel")) return "Airtel Money";
  return m;
}

export function PaymentHistory({ payments }: { payments: PaymentRow[] }) {
  if (payments.length === 0) return <p className="text-sm text-muted-foreground">No payments yet.</p>;
  return (
    <div className="overflow-x-auto -mx-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Method</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((p) => (
            <TableRow key={p._id}>
              <TableCell className="whitespace-nowrap">{formatDate(p.paidAt ?? p.createdAt)}</TableCell>
              <TableCell>
                {PLAN_NAMES[p.plan]} · {PURPOSE[p.purpose]}
              </TableCell>
              <TableCell>{methodLabel(p.paymentMethod)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(p.amount, p.currency)}</TableCell>
              <TableCell>
                <Badge variant={STATUS[p.status].variant}>{STATUS[p.status].label}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
