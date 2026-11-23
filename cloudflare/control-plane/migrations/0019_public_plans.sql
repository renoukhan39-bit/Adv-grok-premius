CREATE TABLE public_plans (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 64),
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  min_monthly_usd_cents INTEGER NOT NULL CHECK (min_monthly_usd_cents >= 0),
  max_monthly_usd_cents INTEGER NOT NULL CHECK (max_monthly_usd_cents >= min_monthly_usd_cents),
  monthly_usd_cents INTEGER NOT NULL CHECK (
    monthly_usd_cents BETWEEN min_monthly_usd_cents AND max_monthly_usd_cents
  )
) STRICT;

INSERT INTO public_plans
  (id, label, position, min_monthly_usd_cents, max_monthly_usd_cents, monthly_usd_cents)
VALUES
  ('free', 'Free', 0, 0, 0, 0),
  ('pro', 'Pro', 1, 2500, 3900, 2900),
  ('agency', 'Agency / Team', 2, 9900, 14900, 12900);
