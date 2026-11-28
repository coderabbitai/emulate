import type { RouteContext } from "@emulators/core";
import { renderCardPage, renderCheckoutPage, escapeHtml } from "@emulators/core";
import type { CheckoutLineItem } from "@emulators/core";
import { getStripeStore } from "../store.js";
import {
  dispatchStripeEvent,
  stripeId,
  toUnixTimestamp,
  parseStripeBody,
  stripeError,
  stripeList,
} from "../helpers.js";
import type { StripeCheckoutSession } from "../entities.js";

const SERVICE_LABEL = "Stripe";
const APPROVED_TEST_CARD = "4242424242424242";
const DECLINED_TEST_CARD = "4000000000000002";
const CHECKOUT_TEST_CARDS = [
  { value: APPROVED_TEST_CARD, label: "Visa ending in 4242 (succeeds)" },
  { value: DECLINED_TEST_CARD, label: "Visa ending in 0002 (declines)" },
];
const CHECKOUT_IDEMPOTENCY_STORE_KEY = "stripe.checkout_session_create_results";

interface CheckoutCreationResult {
  parameters: string;
  status: 200 | 500;
  body: string;
}

function ownParameters(value: object): Record<string, unknown> {
  return Object.assign(Object.create(null), value);
}

function canonicalParameters(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return ["number", String(value)];
  if (value === null || typeof value !== "object") return value;

  // Keep array positions without expanding gaps in indexed form data.
  const fields = Object.keys(value);
  const isArray = Array.isArray(value);
  if (!isArray) fields.sort();
  const object = value as Record<string, unknown>;
  return [isArray ? "array" : "object", fields.map((key) => [key, canonicalParameters(object[key])])];
}

export function checkoutSessionRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const ss = getStripeStore(store);

  function priceCheckout(session: StripeCheckoutSession) {
    const items = session.line_items.map(({ price: priceId, quantity }) => {
      const price = ss.prices.findOneBy("stripe_id", priceId);
      const unitPrice = price?.unit_amount ?? 0;
      return {
        priceId,
        productId: price?.product_id,
        quantity,
        unitPrice,
        totalPrice: unitPrice * quantity,
        currency: price?.currency ?? "usd",
      };
    });
    return {
      items,
      total: items.reduce((sum, item) => sum + item.totalPrice, 0),
      currency: items[0]?.currency ?? null,
    };
  }

  function formatSession(session: StripeCheckoutSession) {
    const { total, currency } = priceCheckout(session);
    return {
      id: session.stripe_id,
      object: "checkout.session",
      mode: session.mode,
      status: session.status,
      payment_status: session.payment_status,
      customer: session.customer_id,
      amount_total: currency === null ? null : total,
      currency,
      success_url: session.success_url,
      cancel_url: session.cancel_url,
      metadata: session.metadata,
      created: toUnixTimestamp(session.created_at),
      livemode: false,
      url: session.status === "open" ? `${baseUrl}/checkout/${session.stripe_id}` : null,
    };
  }

  app.post("/v1/checkout/sessions", async (c) => {
    const body = ownParameters(await parseStripeBody(c));
    const key = c.req.header("Idempotency-Key");
    if (key !== undefined && (key.length === 0 || key.length > 255)) {
      return stripeError(c, 400, "invalid_request_error", "Idempotency-Key must contain 1 to 255 characters.");
    }

    // Keep lookup, validation, execution and caching synchronous after parsing the request.
    const cache =
      key === undefined
        ? undefined
        : store.getData<Map<string, CheckoutCreationResult>>(CHECKOUT_IDEMPOTENCY_STORE_KEY);
    const parameters = key === undefined ? "" : JSON.stringify(canonicalParameters(body));
    const cached = key === undefined ? undefined : cache?.get(key);
    if (cached) {
      if (cached.parameters !== parameters) {
        return stripeError(
          c,
          400,
          "idempotency_error",
          "Keys for idempotent requests can only be used with the same parameters they were first used with.",
        );
      }
      return c.body(cached.body, cached.status, { "Content-Type": "application/json" });
    }

    if (!body.mode)
      return stripeError(c, 400, "invalid_request_error", "Missing required param: mode.", undefined, "mode");

    const customer = body.customer;
    if (customer != null && typeof customer !== "string") {
      return stripeError(c, 400, "invalid_request_error", "Invalid customer.", undefined, "customer");
    }
    if (customer && !ss.customers.findOneBy("stripe_id", customer)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such customer: '${customer}'`,
        "resource_missing",
        "customer",
      );
    }

    const lineItems: Array<{ price: string; quantity: number }> = [];
    if (body.line_items != null) {
      if (!Array.isArray(body.line_items)) {
        return stripeError(c, 400, "invalid_request_error", "line_items must be an array.", undefined, "line_items");
      }
      for (let i = 0; i < body.line_items.length; i++) {
        const item: unknown = Object.hasOwn(body.line_items, i) ? body.line_items[i] : undefined;
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Invalid line_items[${i}]: must be an object.`,
            undefined,
            `line_items[${i}]`,
          );
        }
        const li = ownParameters(item);
        if (!li.price || typeof li.price !== "string") {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Missing required param: line_items[${i}][price].`,
            undefined,
            `line_items[${i}][price]`,
          );
        }
        if (!ss.prices.findOneBy("stripe_id", li.price)) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `No such price: '${li.price}'`,
            "resource_missing",
            `line_items[${i}][price]`,
          );
        }
        const qty = typeof li.quantity === "string" ? Number(li.quantity) : li.quantity;
        if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Invalid line_items[${i}][quantity]: must be a positive integer.`,
            undefined,
            `line_items[${i}][quantity]`,
          );
        }
        lineItems.push({ price: li.price, quantity: qty });
      }
    }

    let result: CheckoutCreationResult;
    try {
      const session = ss.checkoutSessions.insert({
        stripe_id: stripeId("cs"),
        mode: body.mode as StripeCheckoutSession["mode"],
        status: "open",
        payment_status: "unpaid",
        customer_id: customer ?? null,
        success_url: (body.success_url as string) ?? null,
        cancel_url: (body.cancel_url as string) ?? null,
        line_items: lineItems,
        metadata: (body.metadata as Record<string, string>) ?? {},
      });
      result = { parameters, status: 200, body: JSON.stringify(formatSession(session)) };
    } catch (error) {
      if (key === undefined) throw error;
      result = {
        parameters,
        status: 500,
        body: JSON.stringify({ error: { type: "api_error", message: "Could not create the Checkout Session." } }),
      };
    }

    if (key !== undefined) {
      const results = cache ?? new Map<string, CheckoutCreationResult>();
      results.set(key, result);
      if (!cache) store.setData(CHECKOUT_IDEMPOTENCY_STORE_KEY, results);
    }
    return c.body(result.body, result.status, { "Content-Type": "application/json" });
  });

  app.get("/v1/checkout/sessions/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such checkout session: '${c.req.param("id")}'`,
        "resource_missing",
      );
    return c.json(formatSession(session));
  });

  app.post("/v1/checkout/sessions/:id/expire", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such checkout session: '${c.req.param("id")}'`,
        "resource_missing",
      );
    if (session.status !== "open") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Only open sessions can be expired.",
        "checkout_session_not_open",
      );
    }
    const updated = ss.checkoutSessions.update(session.id, { status: "expired" })!;

    const snapshot = formatSession(updated);
    await dispatchStripeEvent(webhooks, "checkout.session.expired", snapshot);

    return c.json(snapshot);
  });

  app.get("/v1/checkout/sessions", (c) => {
    let items = ss.checkoutSessions.all();
    const customerId = c.req.query("customer");
    const status = c.req.query("status");
    const paymentStatus = c.req.query("payment_status");
    if (customerId) items = items.filter((s) => s.customer_id === customerId);
    if (status) items = items.filter((s) => s.status === status);
    if (paymentStatus) items = items.filter((s) => s.payment_status === paymentStatus);
    return stripeList(c, items, "/v1/checkout/sessions", formatSession);
  });

  app.get("/checkout/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) {
      return c.html(
        renderCardPage(
          "Session Not Found",
          "This checkout session does not exist.",
          '<p class="empty">The session ID is invalid or has been removed.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    if (session.status !== "open") {
      return c.html(
        renderCardPage(
          "Session Expired",
          "This checkout session is no longer available.",
          `<p class="empty">Status: ${escapeHtml(session.status)}</p>`,
          SERVICE_LABEL,
        ),
      );
    }

    const { items, total, currency } = priceCheckout(session);
    const lineItems: CheckoutLineItem[] = items.map(({ priceId, productId, ...item }) => {
      const product = productId ? ss.products.findOneBy("stripe_id", productId) : null;
      return { ...item, name: product?.name ?? priceId };
    });
    const cardDeclined = c.req.query("payment_error") === "card_declined";

    return c.html(
      renderCheckoutPage(
        {
          lineItems,
          subtotal: total,
          total,
          currency: currency ?? "usd",
          sessionId: session.stripe_id,
          cancelUrl: session.cancel_url,
          testCards: CHECKOUT_TEST_CARDS,
          selectedTestCard: cardDeclined ? DECLINED_TEST_CARD : undefined,
          paymentError: cardDeclined
            ? "Your test card was declined. Choose a different test card and try again."
            : undefined,
        },
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/checkout/:id/complete", async (c) => {
    const { test_card: testCard } = await c.req.parseBody();
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session || session.status !== "open") {
      return c.redirect("/checkout/" + c.req.param("id"));
    }

    if (testCard !== undefined && testCard !== APPROVED_TEST_CARD && testCard !== DECLINED_TEST_CARD) {
      return c.text("Select a supported test card.", 400);
    }
    if (testCard === DECLINED_TEST_CARD) {
      return c.redirect(`/checkout/${session.stripe_id}?payment_error=card_declined`, 303);
    }

    const updated = ss.checkoutSessions.update(session.id, { status: "complete", payment_status: "paid" })!;

    await dispatchStripeEvent(webhooks, "checkout.session.completed", formatSession(updated));

    if (session.success_url) {
      const url = session.success_url.replace("{CHECKOUT_SESSION_ID}", updated.stripe_id);
      return c.redirect(url);
    }

    return c.html(
      renderCardPage(
        "Payment Complete",
        "Your payment was successful.",
        '<p class="empty check">Payment received</p>',
        SERVICE_LABEL,
      ),
    );
  });
}
