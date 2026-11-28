export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { getOrder } from "@/lib/orders";
import { formatCurrency } from "@/lib/products";
import { ClearCart } from "./clear-cart";

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-3 text-xs">
      <span className="tracking-[0.15em] uppercase text-muted-foreground">{label}</span>
      <span className={mono ? "break-all text-right font-mono text-[11px]" : "text-right"}>{value}</span>
    </div>
  );
}

export default async function SuccessPage({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const { session_id } = await searchParams;
  if (!session_id) redirect("/");

  const order = getOrder(session_id);
  const stripe = getStripe();
  if (!order) {
    try {
      await stripe.checkout.sessions.retrieve(session_id);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) notFound();
      throw error;
    }

    return (
      <div className="mx-auto max-w-[480px] px-6 py-32 text-center">
        <h1 className="font-pixel text-2xl">Order Pending</h1>
        <p className="mt-4 text-sm text-muted-foreground">Waiting for a verified payment webhook.</p>
        <form method="get" className="mt-10">
          <input type="hidden" name="session_id" value={session_id} />
          <button
            type="submit"
            className="inline-flex h-10 items-center border border-foreground px-8 text-[10px] tracking-[0.2em] uppercase font-medium transition-colors hover:bg-foreground hover:text-background"
          >
            Check Order Status
          </button>
        </form>
      </div>
    );
  }

  let customer: { name: string | null; email: string | null } | null = null;
  if (order.customerId) {
    const c = await stripe.customers.retrieve(order.customerId);
    if (!c.deleted) {
      customer = { name: c.name ?? null, email: c.email ?? null };
    }
  }

  return (
    <div className="mx-auto max-w-[480px] px-6 py-32">
      <ClearCart />
      <div className="text-center">
        <p className="text-[10px] tracking-[0.3em] uppercase text-muted-foreground mb-4">Order Confirmed</p>
        <h1 className="font-pixel text-2xl">Thank You</h1>
        <p className="mt-4 text-sm text-muted-foreground">Your order has been placed successfully</p>
      </div>

      <div className="mt-12 divide-y divide-border border-y border-border">
        {customer?.name && <Row label="Customer" value={customer.name} />}
        {customer?.email && <Row label="Email" value={customer.email} />}
        <Row label="Session" value={order.sessionId} mono />
        <Row label="Status" value={order.paymentStatus} />
        <Row label="Event" value={order.eventId} mono />
        <Row label="Confirmed" value={<time dateTime={order.completedAt}>{order.completedAt}</time>} mono />
        {order.paymentIntentId && <Row label="Payment Intent" value={order.paymentIntentId} mono />}
      </div>

      {order.amountTotal != null && (
        <div className="flex items-center justify-between border-b border-border py-4">
          <span className="text-[10px] tracking-[0.3em] uppercase font-medium">Total</span>
          <span className="font-mono text-sm tabular-nums">
            {formatCurrency(order.amountTotal, order.currency ?? "usd")}
            {order.currency && ` ${order.currency.toUpperCase()}`}
          </span>
        </div>
      )}

      <div className="mt-10 text-center">
        <Link
          href="/"
          className="inline-flex h-10 items-center border border-foreground px-8 text-[10px] tracking-[0.2em] uppercase font-medium transition-colors hover:bg-foreground hover:text-background"
        >
          Continue Shopping
        </Link>
      </div>
    </div>
  );
}
