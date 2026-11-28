import { createHmac } from "crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "@emulators/core";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { getStripeStore, seedFromConfig, stripePlugin } from "../index.js";

const base = "http://localhost:14000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("sk_test_abc123", {
    login: "test-account",
    id: 1,
    scopes: [],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  stripePlugin.register(app as any, store, webhooks, base, tokenMap);
  stripePlugin.seed?.(store, base);

  return { app, store, webhooks, tokenMap };
}

function auth(): Record<string, string> {
  return {
    Authorization: "Bearer sk_test_abc123",
    "Content-Type": "application/json",
  };
}

function createCheckout(app: Hono, params: Record<string, unknown>, key?: string) {
  return app.request(`${base}/v1/checkout/sessions`, {
    method: "POST",
    headers: { ...auth(), ...(key === undefined ? {} : { "Idempotency-Key": key }) },
    body: JSON.stringify(params),
  });
}

describe("Stripe plugin", () => {
  let app: Hono;

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("webhooks", () => {
    it("sends Stripe signatures without GitHub headers from standalone seed config", async () => {
      const secret = "whsec_test";
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);
      const standaloneWebhooks = new WebhookDispatcher();

      seedFromConfig(
        new Store(),
        base,
        {
          webhooks: [{ url: "https://hooks.example/stripe", events: ["customer.created"], secret }],
        },
        standaloneWebhooks,
      );

      const payload = { type: "customer.created", data: { object: { id: "cus_test" } } };
      await standaloneWebhooks.dispatch("customer.created", undefined, payload, "stripe");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0]!;
      const body = (init as RequestInit).body as string;
      const headers = (init as RequestInit).headers as Record<string, string>;
      const signature = headers["Stripe-Signature"];
      expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      const match = signature.match(/^t=(\d+),v1=([a-f0-9]{64})$/);

      const timestamp = match![1];
      const expectedSignature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      expect(match![2]).toBe(expectedSignature);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-GitHub-Event"]).toBeUndefined();
      expect(headers["X-GitHub-Delivery"]).toBeUndefined();
      expect(headers["X-Hub-Signature-256"]).toBeUndefined();
    });

    it("retries failed destinations with identical event bytes and a new signature per attempt", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-28T00:00:00Z"));
      const { app, store, webhooks } = createTestApp();
      const event = "checkout.session.completed";
      const failingUrl = "http://127.0.0.1:14001/webhook";
      const acceptingUrl = "http://127.0.0.1:14002/webhook";
      const secret = "whsec_retry";
      seedFromConfig(
        store,
        base,
        {
          webhooks: [failingUrl, acceptingUrl].map((url) => ({ url, events: [event], secret })),
        },
        webhooks,
      );
      let failures = 0;
      const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (url === failingUrl && failures++ === 0) {
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal("fetch", mockFetch);
      const { id } = (await (await createCheckout(app, { mode: "payment" })).json()) as { id: string };
      await app.request(`${base}/checkout/${id}/complete`, { method: "POST" });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const [[, first], [, accepted], [retriedUrl, retry]] = mockFetch.mock.calls;
      expect(retriedUrl).toBe(failingUrl);
      expect(retry?.body).toBe(first?.body);
      expect(accepted?.body).toBe(first?.body);
      const firstSignature = new Headers(first?.headers).get("Stripe-Signature");
      const retrySignature = new Headers(retry?.headers).get("Stripe-Signature");
      const retryTimestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", secret).update(`${retryTimestamp}.${retry?.body}`).digest("hex");
      expect(retrySignature).toBe(`t=${retryTimestamp},v1=${signature}`);
      expect(retrySignature).not.toBe(firstSignature);
      expect(webhooks.getDeliveries().map(({ status_code }) => status_code)).toEqual([503, 204, 204]);
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it.each(["exhausts retries", "cancels retries on reset"])("%s after a network failure", async (behavior) => {
      vi.useFakeTimers();
      const { app, store, webhooks } = createTestApp();
      const event = "checkout.session.completed";
      const url = "http://127.0.0.1:14001/webhook";
      const seed = { webhooks: [{ url, events: [event] }] };
      seedFromConfig(store, base, seed, webhooks);
      const mockFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused"));
      vi.stubGlobal("fetch", mockFetch);
      const { id } = (await (await createCheckout(app, { mode: "payment" })).json()) as { id: string };
      await app.request(`${base}/checkout/${id}/complete`, { method: "POST" });

      if (behavior === "cancels retries on reset") {
        webhooks.clear();
        seedFromConfig(store, base, seed, webhooks);
      }
      await vi.advanceTimersByTimeAsync(20000);
      expect(mockFetch).toHaveBeenCalledTimes(behavior === "exhausts retries" ? 4 : 1);
    });

    it("abandons an in-flight delivery and skips remaining destinations on reset", async () => {
      vi.useFakeTimers();
      const { app, store, webhooks } = createTestApp();
      const event = "checkout.session.completed";
      const seed = {
        webhooks: [14001, 14002].map((port) => ({ url: `http://127.0.0.1:${port}/webhook`, events: [event] })),
      };
      seedFromConfig(store, base, seed, webhooks);
      const mockFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
        webhooks.clear();
        seedFromConfig(store, base, seed, webhooks);
        return new Response(null, { status: 503 });
      });
      vi.stubGlobal("fetch", mockFetch);
      const { id } = (await (await createCheckout(app, { mode: "payment" })).json()) as { id: string };
      await app.request(`${base}/checkout/${id}/complete`, { method: "POST" });

      await vi.advanceTimersByTimeAsync(20000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(webhooks.getDeliveries()).toEqual([]);
    });

    it("shares one event and replay payload across subscribers, with a fresh ID for another payment", async () => {
      const { app, store, webhooks } = createTestApp();
      const eventType = "checkout.session.completed";
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", mockFetch);
      const destinations = [
        { url: "http://127.0.0.1:14001/webhook", events: [eventType], secret: "whsec_first" },
        { url: "http://127.0.0.1:14002/webhook", events: [eventType], secret: "whsec_second" },
      ];
      seedFromConfig(store, base, { webhooks: destinations }, webhooks);

      async function completeSession() {
        const response = await createCheckout(app, { mode: "payment" });
        const { id } = (await response.json()) as { id: string };
        const completed = await app.request(`${base}/checkout/${id}/complete`, { method: "POST" });
        expect(completed.status).toBe(200);
        return id;
      }

      const firstSessionId = await completeSession();
      const secondSessionId = await completeSession();
      expect(mockFetch).toHaveBeenCalledTimes(4);

      const bodies = mockFetch.mock.calls.map(([url, init], index) => {
        const destination = destinations[index % destinations.length];
        expect(url).toBe(destination.url);
        const body = init!.body as string;
        const signature = (init!.headers as Record<string, string>)["Stripe-Signature"];
        const timestamp = signature.match(/^t=(\d+),v1=/)![1];
        const hmac = createHmac("sha256", destination.secret).update(`${timestamp}.${body}`).digest("hex");
        expect(signature).toBe(`t=${timestamp},v1=${hmac}`);
        return body;
      });
      expect(bodies[0]).toBe(bodies[1]);
      expect(bodies[2]).toBe(bodies[3]);
      const first = JSON.parse(bodies[0]);
      const second = JSON.parse(bodies[2]);
      expect(first).toMatchObject({
        id: expect.stringMatching(/^evt_[A-Za-z0-9]+$/),
        object: "event",
        created: expect.any(Number),
        livemode: false,
        type: eventType,
        data: { object: { id: firstSessionId, payment_status: "paid" } },
      });
      expect(second.id).toMatch(/^evt_[A-Za-z0-9]+$/);
      expect(second.id).not.toBe(first.id);
      expect(second.data.object.id).toBe(secondSessionId);
      expect(webhooks.getDeliveries().map(({ payload }) => JSON.stringify(payload))).toEqual(bodies);
    });
  });

  describe("customers", () => {
    it("creates and retrieves a customer", async () => {
      const createRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "user@test.com", name: "Jane Doe" }),
      });
      expect(createRes.status).toBe(200);
      const customer = (await createRes.json()) as { id: string; object: string; email: string; name: string };
      expect(customer.id).toMatch(/^cus_/);
      expect(customer.object).toBe("customer");
      expect(customer.email).toBe("user@test.com");

      const getRes = await app.request(`${base}/v1/customers/${customer.id}`, { headers: auth() });
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as { id: string; email: string };
      expect(fetched.id).toBe(customer.id);
    });

    it("creates a customer from form-urlencoded body", async () => {
      const createRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: {
          Authorization: "Bearer sk_test_abc123",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "email=form%40test.com&name=Form+User",
      });
      expect(createRes.status).toBe(200);
      const customer = (await createRes.json()) as { id: string; email: string; name: string };
      expect(customer.email).toBe("form@test.com");
      expect(customer.name).toBe("Form User");
    });

    it("returns Stripe-format error for missing customer", async () => {
      const res = await app.request(`${base}/v1/customers/cus_nonexistent`, { headers: auth() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { type: string; message: string; code: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("resource_missing");
      expect(body.error.message).toContain("cus_nonexistent");
    });

    it("lists with cursor pagination", async () => {
      // Create 3 customers
      const ids: string[] = [];
      for (const name of ["Alice", "Bob", "Carol"]) {
        const res = await app.request(`${base}/v1/customers`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({ name }),
        });
        const c = (await res.json()) as { id: string };
        ids.push(c.id);
      }

      // List with limit=2
      const page1 = await app.request(`${base}/v1/customers?limit=2`, { headers: auth() });
      const p1 = (await page1.json()) as { data: Array<{ id: string }>; has_more: boolean };
      expect(p1.data.length).toBe(2);
      expect(p1.has_more).toBe(true);

      // Next page using starting_after
      const lastId = p1.data[p1.data.length - 1].id;
      const page2 = await app.request(`${base}/v1/customers?limit=2&starting_after=${lastId}`, { headers: auth() });
      const p2 = (await page2.json()) as { data: Array<{ id: string }>; has_more: boolean };
      expect(p2.data.length).toBeGreaterThanOrEqual(1);
      // Ensure no overlap
      const p2Ids = p2.data.map((c) => c.id);
      expect(p2Ids).not.toContain(p1.data[0].id);
      expect(p2Ids).not.toContain(p1.data[1].id);
    });

    it("filters by email", async () => {
      await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "unique@test.com" }),
      });
      const res = await app.request(`${base}/v1/customers?email=unique@test.com`, { headers: auth() });
      const body = (await res.json()) as { data: Array<{ email: string }> };
      expect(body.data.every((c) => c.email === "unique@test.com")).toBe(true);
    });

    it("cascades delete to related entities", async () => {
      const custRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "cascade@test.com" }),
      });
      const cust = (await custRes.json()) as { id: string };

      // Create a payment intent linked to this customer
      const piRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 1000, currency: "usd", customer: cust.id }),
      });
      const pi = (await piRes.json()) as { id: string; customer: string };
      expect(pi.customer).toBe(cust.id);

      // Delete customer
      await app.request(`${base}/v1/customers/${cust.id}`, { method: "DELETE", headers: auth() });

      // Payment intent should have null customer
      const piCheck = await app.request(`${base}/v1/payment_intents/${pi.id}`, { headers: auth() });
      const piAfter = (await piCheck.json()) as { customer: string | null };
      expect(piAfter.customer).toBeNull();
    });
  });

  describe("payment intents", () => {
    it("creates a payment intent", async () => {
      const res = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 2000, currency: "usd" }),
      });
      expect(res.status).toBe(200);
      const pi = (await res.json()) as { id: string; object: string; amount: number; status: string };
      expect(pi.id).toMatch(/^pi_/);
      expect(pi.status).toBe("requires_payment_method");
    });

    it("confirms a payment intent and creates a charge", async () => {
      const createRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 5000, currency: "usd", payment_method: "pm_card_visa" }),
      });
      const pi = (await createRes.json()) as { id: string; status: string };
      expect(pi.status).toBe("requires_confirmation");

      const confirmRes = await app.request(`${base}/v1/payment_intents/${pi.id}/confirm`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(confirmRes.status).toBe(200);
      const confirmed = (await confirmRes.json()) as { status: string };
      expect(confirmed.status).toBe("succeeded");

      const chargesRes = await app.request(`${base}/v1/charges?payment_intent=${pi.id}`, { headers: auth() });
      const charges = (await chargesRes.json()) as { data: Array<{ amount: number; status: string }> };
      expect(charges.data).toHaveLength(1);
      expect(charges.data[0].amount).toBe(5000);
    });

    it("cancels a payment intent", async () => {
      const createRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 1000, currency: "eur" }),
      });
      const pi = (await createRes.json()) as { id: string };

      const cancelRes = await app.request(`${base}/v1/payment_intents/${pi.id}/cancel`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(cancelRes.status).toBe(200);
      const canceled = (await cancelRes.json()) as { status: string };
      expect(canceled.status).toBe("canceled");
    });

    it("returns Stripe error for confirming succeeded intent", async () => {
      const createRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 1000, currency: "usd", payment_method: "pm_card_visa" }),
      });
      const pi = (await createRes.json()) as { id: string };

      await app.request(`${base}/v1/payment_intents/${pi.id}/confirm`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });

      const res = await app.request(`${base}/v1/payment_intents/${pi.id}/confirm`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; code: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("payment_intent_unexpected_state");
    });

    it("filters by status", async () => {
      await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 100, currency: "usd" }),
      });

      const res = await app.request(`${base}/v1/payment_intents?status=requires_payment_method`, { headers: auth() });
      const body = (await res.json()) as { data: Array<{ status: string }> };
      expect(body.data.every((pi) => pi.status === "requires_payment_method")).toBe(true);
    });

    it("supports expand[]=customer", async () => {
      const custRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "expand@test.com", name: "Expand Test" }),
      });
      const cust = (await custRes.json()) as { id: string };

      const piRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 3000, currency: "usd", customer: cust.id }),
      });
      const pi = (await piRes.json()) as { id: string; customer: string };

      // Without expand - customer is a string ID
      expect(typeof pi.customer).toBe("string");

      // With expand - customer is an object
      const expanded = await app.request(`${base}/v1/payment_intents/${pi.id}?expand[]=customer`, { headers: auth() });
      const body = (await expanded.json()) as { customer: { id: string; object: string; email: string } };
      expect(typeof body.customer).toBe("object");
      expect(body.customer.object).toBe("customer");
      expect(body.customer.email).toBe("expand@test.com");
    });
  });

  describe("products and prices", () => {
    it("creates a product and price", async () => {
      const prodRes = await app.request(`${base}/v1/products`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "T-Shirt" }),
      });
      expect(prodRes.status).toBe(200);
      const product = (await prodRes.json()) as { id: string; name: string };
      expect(product.id).toMatch(/^prod_/);

      const priceRes = await app.request(`${base}/v1/prices`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ product: product.id, currency: "usd", unit_amount: 2000 }),
      });
      expect(priceRes.status).toBe(200);
      const price = (await priceRes.json()) as { id: string; product: string; unit_amount: number };
      expect(price.id).toMatch(/^price_/);
      expect(price.product).toBe(product.id);
    });

    it("supports expand[]=product on prices", async () => {
      const prodRes = await app.request(`${base}/v1/products`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "Expandable Widget" }),
      });
      const product = (await prodRes.json()) as { id: string };

      const priceRes = await app.request(`${base}/v1/prices`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ product: product.id, currency: "usd", unit_amount: 500 }),
      });
      const price = (await priceRes.json()) as { id: string };

      const expanded = await app.request(`${base}/v1/prices/${price.id}?expand[]=product`, { headers: auth() });
      const body = (await expanded.json()) as { product: { id: string; object: string; name: string } };
      expect(typeof body.product).toBe("object");
      expect(body.product.object).toBe("product");
      expect(body.product.name).toBe("Expandable Widget");
    });
  });

  describe("checkout sessions", () => {
    it("keeps the session unpaid after a declined test card and completes with a different card", async () => {
      const { app, store, webhooks } = createTestApp();
      const event = "checkout.session.completed";
      seedFromConfig(
        store,
        base,
        {
          products: [{ name: "Widget" }, { name: "Case" }],
          prices: [
            { id: "price_widget", product_name: "Widget", currency: "eur", unit_amount: 500 },
            { id: "price_case", product_name: "Case", currency: "eur", unit_amount: 700 },
          ],
          webhooks: [{ url: "http://127.0.0.1:14001/webhook", events: [event] }],
        },
        webhooks,
      );
      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", mockFetch);
      const successUrl = "http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}";
      const created = await createCheckout(app, {
        mode: "payment",
        success_url: successUrl,
        line_items: [
          { price: "price_widget", quantity: 3 },
          { price: "price_case", quantity: 1 },
        ],
      });
      expect(created.status).toBe(200);
      const session = (await created.json()) as { id: string };
      const { id } = session;
      const totals = { amount_total: 2200, currency: "eur" };
      expect(session).toMatchObject(totals);
      const checkout = `${base}/checkout/${id}`;
      const pay = (card: string) =>
        app.request(`${checkout}/complete`, {
          method: "POST",
          body: new URLSearchParams({ test_card: card }),
        });
      const retrieve = async () =>
        (await app.request(`${base}/v1/checkout/sessions/${id}`, { headers: auth() })).json();

      const decline = await pay("4000000000000002");
      expect(decline.status).toBe(303);
      const retryPath = decline.headers.get("Location");
      expect(retryPath).toBe(`/checkout/${id}?payment_error=card_declined`);
      expect(await (await app.request(base + retryPath)).text()).toContain("Your test card was declined.");
      expect(await retrieve()).toMatchObject({ id, status: "open", payment_status: "unpaid", ...totals });
      expect(mockFetch).not.toHaveBeenCalled();

      const recovery = await pay("4242424242424242");
      expect(recovery.headers.get("Location")).toBe(successUrl.replace("{CHECKOUT_SESSION_ID}", id));
      expect(await retrieve()).toMatchObject({ id, status: "complete", payment_status: "paid", ...totals });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(mockFetch.mock.calls[0]![1]!.body as string)).toMatchObject({
        type: event,
        data: { object: { id, payment_status: "paid", ...totals } },
      });
    });

    it("creates and expires a checkout session", async () => {
      const createRes = await app.request(`${base}/v1/checkout/sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ mode: "payment", success_url: "https://example.com/success" }),
      });
      expect(createRes.status).toBe(200);
      const session = (await createRes.json()) as { id: string; object: string; status: string; url: string };
      expect(session.id).toMatch(/^cs_/);
      expect(session.status).toBe("open");
      expect(session.url).toBeTruthy();

      const expireRes = await app.request(`${base}/v1/checkout/sessions/${session.id}/expire`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(expireRes.status).toBe(200);
      const expired = (await expireRes.json()) as { status: string; url: string | null };
      expect(expired.status).toBe("expired");
      expect(expired.url).toBeNull();
    });

    it("lists with status filter", async () => {
      await app.request(`${base}/v1/checkout/sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ mode: "payment" }),
      });

      const res = await app.request(`${base}/v1/checkout/sessions?status=open`, { headers: auth() });
      const body = (await res.json()) as { data: Array<{ status: string }> };
      expect(body.data.every((s) => s.status === "open")).toBe(true);
    });
  });

  describe("Checkout create idempotency", () => {
    it("returns the original result for concurrent retries and reordered nested object parameters", async () => {
      const { app, store } = createTestApp();
      const original = { mode: "payment", metadata: { order: "abc", user: "test" } };
      const reordered = { metadata: { user: "test", order: "abc" }, mode: "payment" };
      const responses = await Promise.all(
        [original, reordered, original].map((params) => createCheckout(app, params, "concurrent")),
      );
      const bodies = await Promise.all(responses.map((response) => response.text()));

      expect(responses.map(({ status }) => status)).toEqual([200, 200, 200]);
      expect(bodies).toEqual([bodies[0], bodies[0], bodies[0]]);
      expect(getStripeStore(store).checkoutSessions.count()).toBe(1);
    });

    it("rejects a changed value or array order even in parameters the route does not use", async () => {
      const { app, store } = createTestApp();
      const params = { mode: "payment", expand: ["payment_intent", "customer"], metadata: { order: "abc" } };
      expect((await createCheckout(app, params, "mismatch")).status).toBe(200);

      const mismatches = [
        { ...params, metadata: { order: "different" } },
        { ...params, expand: [...params.expand].reverse() },
      ];
      for (const mismatch of mismatches) {
        const response = await createCheckout(app, mismatch, "mismatch");
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { type: "idempotency_error" } });
      }
      expect(getStripeStore(store).checkoutSessions.count()).toBe(1);
    });

    it("compares the nested form parameters used to execute the request", async () => {
      const { app, store } = createTestApp();
      seedFromConfig(store, base, {
        products: [{ name: "Widget" }],
        prices: [{ id: "price_test", product_name: "Widget", currency: "usd", unit_amount: 500 }],
      });
      const fields: Array<[string, string]> = [
        ["mode", "payment"],
        ["line_items[0][price]", "price_test"],
        ["line_items[0][quantity]", "2"],
        ["metadata[order]", "abc"],
        ["metadata[constructor]", "a literal metadata key"],
      ];
      function postForm(entries: Array<[string, string]>) {
        return app.request(`${base}/v1/checkout/sessions`, {
          method: "POST",
          headers: {
            ...auth(),
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": "nested-form",
          },
          body: new URLSearchParams(entries).toString(),
        });
      }

      const original = await postForm(fields);
      const retry = await postForm([...fields].reverse());
      expect(original.status).toBe(200);
      expect(retry.status).toBe(200);
      const originalBody = await original.text();
      expect(await retry.text()).toBe(originalBody);
      expect(JSON.parse(originalBody).metadata).toEqual({ order: "abc", constructor: "a literal metadata key" });
      const sessions = getStripeStore(store).checkoutSessions.all();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].line_items).toEqual([{ price: "price_test", quantity: 2 }]);
    });

    it.each([
      [{}, "mode"],
      [{ mode: "payment", customer: "cus_missing" }, "customer"],
      [{ mode: "payment", line_items: {} }, "line_items"],
      [{ mode: "payment", line_items: [{ price: "price_missing", quantity: 1 }] }, "line_items[0][price]"],
      [{ mode: "payment", line_items: [{ price: "price_test", quantity: 1.5 }] }, "line_items[0][quantity]"],
    ])("allows a corrected retry after validation fails for %j", async (params, parameter) => {
      const { app, store } = createTestApp();
      seedFromConfig(store, base, {
        products: [{ name: "Widget" }],
        prices: [{ id: "price_test", product_name: "Widget", currency: "usd", unit_amount: 500 }],
      });
      const invalid = await createCheckout(app, params, "validation");
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { type: "invalid_request_error", param: parameter } });
      expect(getStripeStore(store).checkoutSessions.count()).toBe(0);

      expect((await createCheckout(app, { mode: "payment" }, "validation")).status).toBe(200);
      expect(getStripeStore(store).checkoutSessions.count()).toBe(1);
    });

    it("rejects an empty or oversized key and accepts a 255-character key", async () => {
      const { app, store } = createTestApp();
      const params = { mode: "payment" };
      for (const key of ["", "a".repeat(256)]) {
        const response = await createCheckout(app, params, key);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
      }
      expect(getStripeStore(store).checkoutSessions.count()).toBe(0);
      expect((await createCheckout(app, params, "a".repeat(255))).status).toBe(200);
    });

    it("keeps the first create response after the current session expires", async () => {
      const { app } = createTestApp();
      const params = { mode: "payment" };
      const original = await createCheckout(app, params, "expire");
      const originalBody = await original.text();
      const { id, url } = JSON.parse(originalBody);
      expect(url).toBe(`${base}/checkout/${id}`);

      const expired = await app.request(`${base}/v1/checkout/sessions/${id}/expire`, {
        method: "POST",
        headers: auth(),
      });
      expect(await expired.json()).toMatchObject({ status: "expired", url: null });
      const retry = await createCheckout(app, params, "expire");
      expect(retry.status).toBe(original.status);
      expect(await retry.text()).toBe(originalBody);
    });

    it("creates separate sessions for different keys and for requests without a key", async () => {
      const { app, store } = createTestApp();
      const params = { mode: "payment" };
      for (const key of ["first", "second", undefined, undefined]) {
        expect((await createCheckout(app, params, key)).status).toBe(200);
      }
      expect(getStripeStore(store).checkoutSessions.count()).toBe(4);
    });

    it("drops keys on reset and keeps a fresh Store isolated", async () => {
      const { app, store } = createTestApp();
      const first = await createCheckout(app, { mode: "payment" }, "same");
      const firstBody = (await first.json()) as { id: string };
      store.reset();
      const afterReset = await createCheckout(app, { mode: "payment" }, "same");
      const afterResetBody = (await afterReset.json()) as { id: string };
      expect(afterResetBody.id).not.toBe(firstBody.id);
      expect(getStripeStore(store).checkoutSessions.count()).toBe(1);

      const fresh = createTestApp();
      const freshResponse = await createCheckout(fresh.app, { mode: "payment" }, "same");
      expect(await freshResponse.json()).not.toMatchObject({ id: afterResetBody.id });
      expect(getStripeStore(fresh.store).checkoutSessions.count()).toBe(1);
    });

    it("restores idempotent responses from a round-tripped snapshot and supports snapshots without them", async () => {
      const { app, store } = createTestApp();
      const withoutCache = JSON.parse(JSON.stringify(store.snapshot()));
      const params = { mode: "payment" };
      const first = await createCheckout(app, params, "snapshot");
      const firstBody = await first.text();
      const withCache = JSON.parse(JSON.stringify(store.snapshot()));

      store.restore(withoutCache);
      const uncached = await createCheckout(app, params, "snapshot");
      expect(uncached.status).toBe(200);
      expect(await uncached.text()).not.toBe(firstBody);
      expect(getStripeStore(store).checkoutSessions.count()).toBe(1);

      store.restore(withCache);
      const restored = await createCheckout(app, params, "snapshot");
      expect(restored.status).toBe(200);
      expect(await restored.text()).toBe(firstBody);
      expect(getStripeStore(store).checkoutSessions.count()).toBe(1);
    });

    it("replays an execution failure without creating a second session", async () => {
      const { app, store } = createTestApp();
      const sessions = getStripeStore(store).checkoutSessions;
      const insert = sessions.insert.bind(sessions);
      vi.spyOn(sessions, "insert").mockImplementationOnce((params) => {
        insert(params);
        throw new Error("synthetic failure after session creation");
      });

      const params = { mode: "payment" };
      const original = await createCheckout(app, params, "execution-failure");
      expect(original.status).toBe(500);
      const originalBody = await original.text();
      expect(JSON.parse(originalBody)).toMatchObject({ error: { type: "api_error" } });

      const retry = await createCheckout(app, params, "execution-failure");
      expect(retry.status).toBe(500);
      expect(await retry.text()).toBe(originalBody);
      expect(sessions.count()).toBe(1);
    });
  });

  describe("customer sessions", () => {
    it("creates a customer session", async () => {
      const custRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "session@test.com" }),
      });
      const cust = (await custRes.json()) as { id: string };

      const res = await app.request(`${base}/v1/customer_sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          customer: cust.id,
          components: { payment_element: { enabled: true } },
        }),
      });
      expect(res.status).toBe(200);
      const session = (await res.json()) as {
        object: string;
        client_secret: string;
        customer: string;
        components: Record<string, unknown>;
        created: number;
        expires_at: number;
      };
      expect(session.object).toBe("customer_session");
      expect(session.client_secret).toBeTruthy();
      expect(session.customer).toBe(cust.id);
      expect(session.components).toEqual({ payment_element: { enabled: true } });
      expect(session.created).toBeTypeOf("number");
      expect(session.expires_at).toBeGreaterThan(session.created);
    });

    it("returns error for missing customer param", async () => {
      const res = await app.request(`${base}/v1/customer_sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; param: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("customer");
    });

    it("returns error for nonexistent customer", async () => {
      const res = await app.request(`${base}/v1/customer_sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ customer: "cus_nonexistent" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; code: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("resource_missing");
    });
  });

  describe("payment methods", () => {
    it("lists payment methods for a customer", async () => {
      const custRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "methods@test.com" }),
      });
      const cust = (await custRes.json()) as { id: string };

      const res = await app.request(`${base}/v1/payment_methods?customer=${cust.id}&type=card`, {
        headers: auth(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: unknown[];
        has_more: boolean;
        object: string;
        url: string;
      };
      expect(body.object).toBe("list");
      expect(body.url).toBe("/v1/payment_methods");
      expect(body.has_more).toBe(false);
      expect(body.data).toEqual([]);
    });

    it("returns error for nonexistent customer", async () => {
      const res = await app.request(`${base}/v1/payment_methods?customer=cus_nonexistent&type=card`, {
        headers: auth(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; param: string; type: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("resource_missing");
      expect(body.error.param).toBe("customer");
    });
  });

  describe("seed", () => {
    it("seeds customers and products from config", async () => {
      const store = new Store();
      stripePlugin.seed?.(store, base);
      seedFromConfig(store, base, {
        customers: [{ email: "seed@test.com", name: "Seeded User" }],
        products: [{ name: "Widget" }],
        prices: [{ product_name: "Widget", currency: "usd", unit_amount: 999 }],
      });

      const ss = getStripeStore(store);
      const customers = ss.customers.all();
      expect(customers.some((c) => c.email === "seed@test.com")).toBe(true);

      const products = ss.products.all();
      const widget = products.find((p) => p.name === "Widget");
      expect(widget).toBeDefined();

      const prices = ss.prices.findBy("product_id", widget!.stripe_id);
      expect(prices).toHaveLength(1);
      expect(prices[0].unit_amount).toBe(999);
    });
  });
});
