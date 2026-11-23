import type { AccountSubscription } from "../../../shared/account-subscription";

type SubscriptionRow = {
  plan_id: "pro" | "agency";
  status: "active" | "canceling" | "canceled" | "past_due";
  period_start_ms: number;
  period_end_ms: number;
};

export async function readAccountSubscription(db: D1Database, userId: string, now = Date.now()): Promise<AccountSubscription> {
  const row = await db.prepare(
    "SELECT plan_id, status, period_start_ms, period_end_ms FROM account_subscriptions WHERE user_id = ?",
  ).bind(userId).first<SubscriptionRow>();
  if (!row || row.period_start_ms > now) return { plan: "free", status: "free", periodEndsAt: null };
  if (row.period_end_ms <= now) return { plan: "free", status: "expired", periodEndsAt: row.period_end_ms };
  if (row.status === "active" || row.status === "canceling") {
    return { plan: row.plan_id, status: row.status, periodEndsAt: row.period_end_ms };
  }
  return { plan: "free", status: "free", periodEndsAt: null };
}
