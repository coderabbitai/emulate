---
name: stripe
description: Emulated Stripe API for local development and testing. Use when the user needs to process payments locally, test checkout flows, create customers, manage products and prices, handle payment intents, work with webhooks, or use the Stripe SDK without hitting real Stripe servers. Triggers include "Stripe API", "emulate Stripe", "test payments locally", "checkout flow", "payment intent", "Stripe webhook", "Stripe SDK", "STRIPE_API_KEY", or any task requiring a local Stripe API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Stripe API Emulator

Fully stateful Stripe API emulation. Customers, products, prices, checkout sessions, payment intents, charges, and payment methods persist in memory. Webhooks fire on state changes. The hosted checkout UI lets you complete payments in the browser.

No real payments are processed. Every Stripe SDK call hits the emulator and produces realistic responses.

## Start

```bash
# Stripe only
npx emulate --service stripe

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const stripe = await createEmulator({ service: 'stripe', port: 4000 })
// stripe.url === 'http://localhost:4000'
```

## Pointing Your App at the Emulator

### Stripe SDK

Pass the emulator's host, port, and protocol when constructing the Stripe Node.js SDK client. The SDK expects these options explicitly.

```typescript
import Stripe from 'stripe'

const stripe = new Stripe('sk_test_emulated', {
  host: 'localhost',
  port: 4000,
  protocol: 'http',
})
```

### Embedded in Next.js (adapter-next)

When using `@emulators/adapter-next`, the emulator runs inside your Next.js app at `/emulate/stripe`. The SDK needs to point at `localhost` with a proxy route to forward `/v1/*` calls to `/emulate/stripe/v1/*`:

```typescript
// lib/stripe.ts
import Stripe from 'stripe'

export function getStripe() {
  return new Stripe('sk_test_emulated', {
    host: process.env.STRIPE_HOST ?? 'localhost',
    port: Number(process.env.STRIPE_PORT ?? process.env.PORT ?? '3000'),
    protocol: process.env.STRIPE_PROTOCOL === 'https' ? 'https' : 'http',
  })
}
```

Set `STRIPE_WEBHOOK_SECRET` to a fresh synthetic secret in the server's environment before starting the app.

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as stripe from '@emulators/stripe'

const secret = process.env.STRIPE_WEBHOOK_SECRET

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    stripe: {
      emulator: stripe,
      seed: {
        products: [
          { id: 'prod_widget', name: 'Widget', description: 'A useful widget' },
        ],
        prices: [
          { id: 'price_widget', product_name: 'Widget', currency: 'usd', unit_amount: 1000 },
        ],
        webhooks: [
          {
            url: `http://localhost:${process.env.PORT ?? '3000'}/api/webhooks/stripe`,
            events: ['checkout.session.completed'],
            secret,
          },
        ],
      },
    },
  },
})
```

```typescript
// app/v1/[...path]/route.ts  (proxy for Stripe SDK)
const STRIPE_URL = `http://localhost:${process.env.PORT ?? '3000'}/emulate/stripe`

async function handler(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  const url = new URL(req.url)
  const target = `${STRIPE_URL}/v1/${path.join('/')}${url.search}`

  const res = await fetch(target, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    duplex: 'half',
  } as any)

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE }
```

### Direct fetch

```bash
curl http://localhost:4000/v1/customers \
  -H "Authorization: Bearer sk_test_emulated"
```

## Seed Config

Seed data is optional. All entities support an optional `id` field for deterministic IDs that survive server restarts.

```yaml
stripe:
  customers:
    - id: cus_demo
      email: demo@example.com
      name: Demo User
  products:
    - id: prod_tshirt
      name: T-Shirt
      description: A comfortable tee
  prices:
    - id: price_tshirt
      product_name: T-Shirt
      currency: usd
      unit_amount: 2500
  webhooks:
    - url: http://localhost:3000/api/webhooks/stripe
      events: ['*']
      secret: whsec_test
```

The `product_name` field in prices links to the product by name. Use `events: ['*']` to receive all webhook events, or specify individual event types. Replace `whsec_test` with a fresh synthetic secret before starting the emulator and set the same value on your app server as `STRIPE_WEBHOOK_SECRET`.

## API Endpoints

### Customers

```bash
# Create customer
curl -X POST http://localhost:4000/v1/customers \
  -d "email=user@example.com" -d "name=Jane Doe"

# Retrieve customer
curl http://localhost:4000/v1/customers/cus_xxx

# Update customer
curl -X POST http://localhost:4000/v1/customers/cus_xxx \
  -d "name=Updated Name"

# Delete customer
curl -X DELETE http://localhost:4000/v1/customers/cus_xxx

# List customers
curl http://localhost:4000/v1/customers
```

### Products

```bash
# Create product
curl -X POST http://localhost:4000/v1/products \
  -d "name=Widget" -d "description=A useful widget"

# Retrieve product
curl http://localhost:4000/v1/products/prod_xxx

# List products
curl "http://localhost:4000/v1/products?active=true"
```

### Prices

```bash
# Create price
curl -X POST http://localhost:4000/v1/prices \
  -d "product=prod_xxx" -d "currency=usd" -d "unit_amount=1000"

# Retrieve price
curl http://localhost:4000/v1/prices/price_xxx

# List prices
curl "http://localhost:4000/v1/prices?active=true"
```

### Checkout Sessions

```bash
# Create checkout session
curl -X POST http://localhost:4000/v1/checkout/sessions \
  -d "mode=payment" \
  -d "line_items[0][price]=price_xxx" \
  -d "line_items[0][quantity]=1" \
  -d "success_url=http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}" \
  -d "cancel_url=http://localhost:3000/cart"

# Retrieve session
curl http://localhost:4000/v1/checkout/sessions/cs_xxx

# List sessions
curl http://localhost:4000/v1/checkout/sessions

# Expire a session
curl -X POST http://localhost:4000/v1/checkout/sessions/cs_xxx/expire
```

The session's `url` field points to a hosted checkout page at `/checkout/cs_xxx`. Clicking "Pay" on that page completes the session, fires the `checkout.session.completed` webhook, and redirects to `success_url`. The `{CHECKOUT_SESSION_ID}` template in `success_url` is replaced with the actual session ID.

On the hosted page, choose the test card ending in 0002 to decline the payment. The same session stays open and unpaid. Choose the card ending in 4242 to complete it. A declined attempt sends no completion webhook.

Pass `{ idempotencyKey }` as the second argument to `stripe.checkout.sessions.create` to retry the same operation. The same key and parameters return the original response for the life of the emulator store. Changing parameters under that key returns HTTP 400 with `idempotency_error`.

### Payment Intents

```bash
# Create payment intent
curl -X POST http://localhost:4000/v1/payment_intents \
  -d "amount=2000" -d "currency=usd"

# Retrieve
curl http://localhost:4000/v1/payment_intents/pi_xxx

# Update
curl -X POST http://localhost:4000/v1/payment_intents/pi_xxx \
  -d "amount=3000"

# Confirm (triggers payment_intent.succeeded + charge.succeeded webhooks)
curl -X POST http://localhost:4000/v1/payment_intents/pi_xxx/confirm

# Cancel
curl -X POST http://localhost:4000/v1/payment_intents/pi_xxx/cancel

# List
curl http://localhost:4000/v1/payment_intents
```

### Charges

```bash
# Retrieve charge
curl http://localhost:4000/v1/charges/ch_xxx

# List charges
curl http://localhost:4000/v1/charges
```

Charges are created automatically when a payment intent is confirmed.

### Customer Sessions

```bash
# Create customer session
curl -X POST http://localhost:4000/v1/customer_sessions \
  -d "customer=cus_xxx"
```

### Payment Methods

```bash
# List payment methods
curl http://localhost:4000/v1/payment_methods
```

## Webhooks

The emulator dispatches webhook events when state changes. Register webhooks via seed config or programmatically.
Webhooks configured with a `secret` include `Stripe-Signature: t=<timestamp>,v1=<signature>`. The signature is an HMAC SHA-256 over `<timestamp>.<raw body>`.
All deliveries of the same event share its `evt_` ID.

### Events dispatched

| Event | Trigger |
|-------|---------|
| `customer.created` | Customer created |
| `customer.updated` | Customer updated |
| `customer.deleted` | Customer deleted |
| `product.created` | Product created |
| `price.created` | Price created |
| `payment_intent.created` | Payment intent created |
| `payment_intent.succeeded` | Payment intent confirmed |
| `payment_intent.canceled` | Payment intent canceled |
| `charge.succeeded` | Payment intent confirmed (charge auto-created) |
| `checkout.session.completed` | Checkout completed via hosted page |
| `checkout.session.expired` | Checkout session expired |

Failed Stripe webhook deliveries retry after 1, 2, and 4 seconds in the running emulator. Each attempt uses the original event ID and body with a new signing timestamp. Delivery stops on HTTP 2xx or after the final retry.

### Webhook handler example

```typescript
// app/api/webhooks/stripe/route.ts
import type Stripe from 'stripe'
import { recordPaidOrderOnce } from '@/lib/orders'
import { getStripe } from '@/lib/stripe'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) throw new Error('Set STRIPE_WEBHOOK_SECRET to the seeded synthetic secret')

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return Response.json({ error: 'Missing Stripe-Signature header' }, { status: 400 })
  }

  const rawBody = Buffer.from(await request.arrayBuffer())
  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret)
  } catch {
    return Response.json({ error: 'Invalid Stripe webhook' }, { status: 400 })
  }

  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    await recordPaidOrderOnce(event.data.object.id, event.id)
  }

  return Response.json({ received: true })
}
```

Implement `recordPaidOrderOnce` with the Checkout Session ID as the unique order key. The `examples/stripe-checkout` app includes a complete local handler, in-memory order store, and startup recipes for the bundled adapter and standalone CLI.

## Common Patterns

### Checkout Flow (embedded Next.js)

```typescript
// Server action
const stripe = getStripe()
const customer = await stripe.customers.create({
  email: 'shopper@example.com',
  name: 'Demo Shopper',
})

const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  customer: customer.id,
  line_items: [{ price: 'price_widget', quantity: 2 }],
  success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${origin}/cart`,
})

redirect(session.url!)
```

### Read the order on the success page

Set the success and cancel URLs to the app's origin. On success, use `session_id` to look up the order recorded by the verified webhook. Show a pending state and keep the cart until that order exists.
For a session with priced items, use `amount_total` and `currency` from the verified paid event to show the order total.

### Payment Intent Flow (no checkout UI)

```typescript
const stripe = getStripe()
const pi = await stripe.paymentIntents.create({
  amount: 5000,
  currency: 'usd',
  customer: 'cus_xxx',
})

// Confirm triggers payment_intent.succeeded + charge.succeeded webhooks
const confirmed = await stripe.paymentIntents.confirm(pi.id)
console.log(confirmed.status) // 'succeeded'
```
