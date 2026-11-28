import type Stripe from "stripe";
import { recordOrder } from "@/lib/orders";
import { getStripe, getStripeWebhookSecret } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "Missing Stripe-Signature header" }, { status: 400 });
  }

  const rawBody = Buffer.from(await request.arrayBuffer());
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, getStripeWebhookSecret());
  } catch {
    return Response.json({ error: "Invalid Stripe webhook" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.payment_status === "paid") {
      recordOrder({
        sessionId: session.id,
        eventId: event.id,
        customerId: typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
        paymentStatus: session.payment_status,
        paymentIntentId:
          typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
        amountTotal: session.amount_total ?? null,
        currency: session.currency ?? null,
        completedAt: new Date().toISOString(),
      });
    }
  }

  return Response.json({ received: true });
}
