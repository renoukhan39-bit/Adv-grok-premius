import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

async function call(path: string, method = "GET") {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://auth.openmausbot.test${path}`, { method }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("public plan prices", () => {
  it("serves only public prices and ordered names to signed-out visitors", async () => {
    const response = await call("/v1/plans");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ plans: [
      { id: "free", label: "Free", price: { amount: 0, currency: "USD", interval: "month" } },
      { id: "pro", label: "Pro", price: { amount: 2900, currency: "USD", interval: "month" } },
      { id: "agency", label: "Agency / Team", price: { amount: 12900, currency: "USD", interval: "month" } },
    ] });
    expect((await call("/v1/plans", "POST")).ok).toBe(false);
  });

  it("shows an operator's price change on both surfaces and escapes labels", async () => {
    const update = env.DB.prepare("UPDATE public_plans SET label = ?, monthly_usd_cents = ? WHERE id = 'pro'");
    try {
      await update.bind("<Pro & Co>", 3150).run();
      const response = await call("/pricing");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("&lt;Pro &amp; Co&gt;");
      expect(html).toContain("$31.50");
      expect(html).not.toContain("<Pro & Co>");
      expect(await (await call("/v1/plans")).json()).toMatchObject({
        plans: expect.arrayContaining([{ id: "pro", label: "<Pro & Co>", price: { amount: 3150, currency: "USD", interval: "month" } }]),
      });
      await expect(update.bind("Pro", 3999).run()).rejects.toThrow();
    } finally {
      await update.bind("Pro", 2900).run();
    }
  });
});
