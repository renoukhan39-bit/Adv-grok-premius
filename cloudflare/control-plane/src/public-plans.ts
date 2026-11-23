export type PublicPlan = {
  id: string;
  label: string;
  price: { amount: number; currency: "USD"; interval: "month" };
};

export async function readPublicPlans(db: D1Database): Promise<PublicPlan[]> {
  const { results } = await db.prepare(
    "SELECT id, label, monthly_usd_cents FROM public_plans ORDER BY position",
  ).all<{ id: string; label: string; monthly_usd_cents: number }>();
  return results.map(({ id, label, monthly_usd_cents }) => ({
    id,
    label,
    price: { amount: monthly_usd_cents, currency: "USD", interval: "month" },
  }));
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD",
});

function htmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function pricingPage(plans: readonly PublicPlan[] | null): Response {
  const rows = plans?.map(({ label, price }) =>
    `<tr><th scope="row">${htmlText(label)}</th><td>${usd.format(price.amount / 100)}</td></tr>`,
  ).join("");
  const content = rows
    ? `<table><caption>Monthly prices in USD</caption><thead><tr><th scope="col">Plan</th><th scope="col">Monthly price</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p>${plans ? "There are no published plans." : "Prices are temporarily unavailable. Please try again later."}</p>`;
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pricing · Adv-Grok-Premius</title>
<style>
  :root { color-scheme: light dark; font: 100%/1.5 system-ui, sans-serif; }
  main { max-width: 38rem; margin: 8vh auto; padding: 0 1rem; }
  h1 { margin: 0 0 1.5rem; }
  table { width: 100%; border-collapse: collapse; }
  caption, th { text-align: start; }
  caption { padding-bottom: .75rem; }
  th, td { padding: .75rem .25rem; border-bottom: 1px solid GrayText; }
  td, th:last-child { text-align: end; font-variant-numeric: tabular-nums; }
</style></head><body><main><h1>Adv-Grok-Premius pricing</h1>${content}
<p>The Free plan runs locally without an account. Paid sign-up is currently unavailable here.</p>
</main></body></html>`, {
    status: plans === null ? 503 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  });
}
