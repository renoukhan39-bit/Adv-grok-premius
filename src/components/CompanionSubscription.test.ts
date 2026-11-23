// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountSubscription } from "../../shared/account-subscription";
import { setLocale } from "@/lib/i18n";
import { CompanionSubscription } from "./CompanionSubscription";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function show(email: string, read: () => Promise<AccountSubscription>) {
  await act(async () => root.render(createElement(CompanionSubscription, { key: email, email, read })));
}

it("shows loading, recovers from an unavailable service and displays the returned plan", async () => {
  const pending = Promise.withResolvers<AccountSubscription>();
  const read = vi.fn<() => Promise<AccountSubscription>>().mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ plan: "agency", status: "canceling", periodEndsAt: Date.UTC(2027, 2, 15) });
  await show("owner@example.test", read);
  expect(host.textContent).toContain("Checking");
  await act(async () => pending.reject(new Error("offline")));
  expect(host.textContent).toContain("Unavailable");
  expect(host.textContent).not.toContain("Free");
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Agency / Team");
  expect(host.textContent).toContain("2027");
});

it("drops the previous account's pending result and shows an expired plan as Free", async () => {
  const old = Promise.withResolvers<AccountSubscription>();
  await show("old@example.test", () => old.promise);
  await show("new@example.test", async () => ({ plan: "free", status: "expired", periodEndsAt: Date.UTC(2026, 2, 15) }));
  await act(async () => old.resolve({ plan: "pro", status: "active", periodEndsAt: Date.UTC(2027, 2, 15) }));
  expect(host.textContent).toContain("new@example.test");
  expect(host.textContent).toContain("Free");
  expect(host.textContent).toContain("Expired");
  expect(host.textContent).not.toContain("old@example.test");
  expect(host.textContent).not.toContain("Pro");
});
