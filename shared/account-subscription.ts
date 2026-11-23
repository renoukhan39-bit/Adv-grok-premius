/** The account's effective plan at the server's read time. Period bounds use Unix milliseconds. */
export type AccountSubscription =
  | { plan: "free"; status: "free"; periodEndsAt: null }
  | { plan: "free"; status: "expired"; periodEndsAt: number }
  | { plan: "pro" | "agency"; status: "active" | "canceling"; periodEndsAt: number };
