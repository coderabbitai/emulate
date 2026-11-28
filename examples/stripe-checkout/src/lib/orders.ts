export interface Order {
  sessionId: string;
  eventId: string;
  customerId: string | null;
  paymentStatus: "paid";
  paymentIntentId: string | null;
  amountTotal: number | null;
  currency: string | null;
  completedAt: string;
}

const stripeCheckoutGlobal = globalThis as typeof globalThis & {
  stripeCheckoutOrders?: Map<string, Order>;
};
const orders = (stripeCheckoutGlobal.stripeCheckoutOrders ??= new Map<string, Order>());

export function recordOrder(order: Order): void {
  if (!orders.has(order.sessionId)) {
    orders.set(order.sessionId, order);
  }
}

export function getOrder(sessionId: string): Order | undefined {
  return orders.get(sessionId);
}
