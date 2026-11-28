import { randomBytes } from "crypto";
import type { Context, ContentfulStatusCode, Entity, WebhookDispatcher } from "@emulators/core";

const NUMERIC_KEYS = new Set([
  "amount",
  "unit_amount",
  "quantity",
  "amount_total",
  "amount_subtotal",
  "application_fee_amount",
  "transfer_amount",
]);

export function stripeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url").slice(0, 24)}`;
}

export function toUnixTimestamp(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

const STRIPE_WEBHOOK_RETRY_DELAYS_MS = [1000, 2000, 4000];

export function dispatchStripeEvent(
  webhooks: WebhookDispatcher,
  type: string,
  object: Record<string, unknown>,
): Promise<void> {
  return webhooks.dispatch(
    type,
    undefined,
    {
      id: `evt_${randomBytes(16).toString("hex")}`,
      object: "event",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type,
      data: { object },
    },
    "stripe",
    undefined,
    STRIPE_WEBHOOK_RETRY_DELAYS_MS,
  );
}

/**
 * Parse request body from either JSON or form-urlencoded format.
 * Stripe's SDK sends application/x-www-form-urlencoded by default,
 * but JSON is also common from direct API calls.
 */
export async function parseStripeBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const rawText = await c.req.text();

  if (!rawText) return {};

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  const params = new URLSearchParams(rawText);
  const result: Record<string, unknown> = {};

  for (const [key, value] of params) {
    const parts = key.includes("[") ? key.replace(/]/g, "").split("[") : [key];
    const lastKey = parts[parts.length - 1];
    const num = Number(value);
    setStripeFormValue(result, parts, NUMERIC_KEYS.has(lastKey) && Number.isFinite(num) ? num : value);
  }

  return result;
}

function isFormArrayIndex(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}

function setStripeFormValue(target: Record<string, unknown>, parts: string[], value: string | number): void {
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    let field = parts[i];
    if (Array.isArray(target)) {
      if (last && field === "") field = String(target.length);
      if (!isFormArrayIndex(field)) return;
    }

    if (last) {
      Object.defineProperty(target, field, { value, writable: true, enumerable: true, configurable: true });
      return;
    }

    let child = Object.hasOwn(target, field) ? target[field] : undefined;
    if (child === null || typeof child !== "object") {
      child = isFormArrayIndex(parts[i + 1]) ? [] : {};
      Object.defineProperty(target, field, { value: child, writable: true, enumerable: true, configurable: true });
    }
    target = child as Record<string, unknown>;
  }
}

/**
 * Return a Stripe-format error response.
 * Stripe errors use { error: { type, message, code?, param? } }
 */
export function stripeError(
  c: Context,
  status: number,
  type: "invalid_request_error" | "card_error" | "api_error" | "idempotency_error",
  message: string,
  code?: string,
  param?: string,
) {
  return c.json(
    {
      error: {
        type,
        message,
        ...(code && { code }),
        ...(param && { param }),
      },
    },
    status as ContentfulStatusCode,
  );
}

/**
 * Stripe-style cursor-based list pagination.
 * Supports starting_after, ending_before, limit, and created[gte]/created[lte] filtering.
 */
export function stripeList<T extends Entity & { stripe_id: string; created_at: string }>(
  c: Context,
  items: T[],
  url: string,
  formatFn: (item: T) => Record<string, unknown>,
) {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10), 100);
  const startingAfter = c.req.query("starting_after");
  const endingBefore = c.req.query("ending_before");
  const createdGte = c.req.query("created[gte]");
  const createdLte = c.req.query("created[lte]");

  let filtered = items;

  // Date range filtering
  if (createdGte) {
    const gte = parseInt(createdGte, 10);
    filtered = filtered.filter((item) => toUnixTimestamp(item.created_at) >= gte);
  }
  if (createdLte) {
    const lte = parseInt(createdLte, 10);
    filtered = filtered.filter((item) => toUnixTimestamp(item.created_at) <= lte);
  }

  // Sort newest first (Stripe default)
  filtered.sort((a, b) => b.id - a.id);

  // Cursor-based pagination
  if (startingAfter) {
    const idx = filtered.findIndex((item) => item.stripe_id === startingAfter);
    if (idx !== -1) {
      filtered = filtered.slice(idx + 1);
    }
  } else if (endingBefore) {
    const idx = filtered.findIndex((item) => item.stripe_id === endingBefore);
    if (idx !== -1) {
      filtered = filtered.slice(0, idx);
      filtered = filtered.slice(-limit);
    }
  }

  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  return c.json({
    object: "list",
    url,
    has_more: hasMore,
    data: page.map(formatFn),
  });
}

/**
 * Apply Stripe's expand[] parameter to embed related objects.
 * Replaces ID strings with full formatted objects.
 */
export function applyExpand(
  obj: Record<string, unknown>,
  expandPaths: string[],
  resolvers: Record<string, (id: string) => Record<string, unknown> | undefined>,
): Record<string, unknown> {
  if (!expandPaths || expandPaths.length === 0) return obj;

  const result = { ...obj };
  for (const path of expandPaths) {
    const resolver = resolvers[path];
    const id = result[path];
    if (resolver && typeof id === "string") {
      const expanded = resolver(id);
      if (expanded) {
        result[path] = expanded;
      }
    }
  }
  return result;
}

/**
 * Parse expand[] from query params or body.
 */
export function parseExpand(c: Context): string[] {
  const fromQuery = c.req.queries("expand[]") ?? [];
  return fromQuery;
}
