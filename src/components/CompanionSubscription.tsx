import { useEffect, useState } from "react";
import type { AccountSubscription } from "../../shared/account-subscription";
import { activeLocale, t } from "@/lib/i18n";
import { SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

export function CompanionSubscription({ email, read }: { email: string; read: () => Promise<AccountSubscription> }) {
  const [result, setResult] = useState<AccountSubscription | "loading" | "unavailable">("loading");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let mounted = true;
    void read().then(
      value => { if (mounted) setResult(value); },
      () => { if (mounted) setResult("unavailable"); },
    );
    return () => { mounted = false; };
  }, [read, version]);

  let value: string;
  if (result === "loading") value = t("common.checking");
  else if (result === "unavailable") value = t("model.simple.unavailable");
  else {
    const plan = result.plan === "free" ? t("settings.account.free") : result.plan === "pro" ? "Pro" : "Agency / Team";
    const date = result.periodEndsAt === null ? null : new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium" }).format(result.periodEndsAt);
    if (result.status === "expired") value = `${plan} · ${t("handoff.end.expired")} · ${date}`;
    else if (result.status === "canceling") value = t("settings.plan.ends", { plan, date: date ?? "" });
    else if (result.status === "active") value = `${plan} · ${t("cloudCancel.runsPlan", { date: date ?? "" })}`;
    else value = plan;
  }
  return <SettingsGroup block="companion-subscription" label={t("settings.simple.billing.plan")}>
    <SettingsRows>
      <SettingRow title={email} subtitle={<span role="status">{value}</span>}>
        <button type="button" className="settings-quiet cursor-pointer" disabled={result === "loading"}
          onClick={() => { setResult("loading"); setVersion(v => v + 1); }}>
          {t(result === "unavailable" ? "common.tryAgain" : "planUsage.refresh")}
        </button>
      </SettingRow>
    </SettingsRows>
  </SettingsGroup>;
}
