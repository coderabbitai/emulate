import { randomBytes } from "node:crypto";
import Stripe from "stripe";

const stripeCheckoutGlobal = globalThis as typeof globalThis & {
  stripeCheckoutWebhookSecret?: string;
};

let stripe: Stripe | undefined;

export function getAppOrigin(): string {
  return `http://localhost:${process.env.PORT ?? "3000"}`;
}

export function getStripe(): Stripe {
  return (stripe ??= new Stripe("sk_emulated_key", {
    host: process.env.STRIPE_HOST ?? "localhost",
    port: Number(process.env.STRIPE_PORT ?? process.env.PORT ?? "3000"),
    protocol: process.env.STRIPE_PROTOCOL === "https" ? "https" : "http",
  }));
}

export function getStripeWebhookSecret(): string {
  return (
    process.env.STRIPE_WEBHOOK_SECRET ||
    (stripeCheckoutGlobal.stripeCheckoutWebhookSecret ??= `whsec_${randomBytes(32).toString("hex")}`)
  );
}
