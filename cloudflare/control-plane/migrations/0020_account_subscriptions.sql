CREATE TABLE account_subscriptions (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES public_plans (id) CHECK (plan_id IN ('pro', 'agency')),
  status TEXT NOT NULL CHECK (status IN ('active', 'canceling', 'canceled', 'past_due')),
  period_start_ms INTEGER NOT NULL CHECK (period_start_ms >= 0),
  period_end_ms INTEGER NOT NULL CHECK (period_end_ms > period_start_ms AND period_end_ms <= 8640000000000000)
) STRICT;
