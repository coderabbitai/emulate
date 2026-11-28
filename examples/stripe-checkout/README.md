# Stripe Checkout with emulate

This Next.js storefront uses the Stripe Node SDK to create a Checkout Session and redirects the browser to the local hosted checkout. It records a paid order once per session after verifying the signed webhook. The confirmation page shows the recorded payment status, event ID, and fulfilment time. All payments are simulated.

## Build from a clean checkout

Run from the repository root with Node 24 or later and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm exec turbo build --filter=@emulators/adapter-next --filter=@emulators/stripe
pnpm --filter stripe-checkout build
```

## Run with the bundled emulator

```bash
PORT=3000 pnpm --filter stripe-checkout start
```

Open [http://localhost:3000](http://localhost:3000). The app seeds four products and uses a fresh in-memory signing secret on each start. The app's `/v1/*` route forwards SDK requests to the emulator mounted at `/emulate/stripe`.

## Run with the standalone CLI

Build and install the CLI from this checkout in a temporary directory. The seed creates one product and configures signed webhook delivery back to the app.

```bash
pnpm exec turbo build --filter=emulate
stripe_demo_dir=$(mktemp -d)
pnpm --filter emulate pack --pack-destination "$stripe_demo_dir"
stripe_webhook_secret="whsec_$(openssl rand -hex 32)"
printf '%s\n' "$stripe_webhook_secret" > "$stripe_demo_dir/webhook-secret"
cat > "$stripe_demo_dir/stripe.yaml" <<EOF
stripe:
  products:
    - id: prod_mug
      name: Emulate Mug
  prices:
    - id: price_mug
      product_name: Emulate Mug
      currency: usd
      unit_amount: 1500
  webhooks:
    - url: http://localhost:3000/api/webhooks/stripe
      events: ['checkout.session.completed']
      secret: $stripe_webhook_secret
EOF
printf 'Temporary directory: %s\n' "$stripe_demo_dir"
(
  cd "$stripe_demo_dir" || exit
  pnpm init
  pnpm add ./emulate-*.tgz
  npx emulate start --service stripe --port 4000 --seed stripe.yaml
)
```

In a second terminal, from the repository root, set `stripe_demo_dir` to the path printed above and start the app.

```bash
stripe_demo_dir=/path/to/the/temporary/directory
PORT=3000 STRIPE_HOST=localhost STRIPE_PORT=4000 STRIPE_PROTOCOL=http \
  STRIPE_WEBHOOK_SECRET="$(cat "$stripe_demo_dir/webhook-secret")" \
  pnpm --filter stripe-checkout start
```

Open [http://localhost:3000](http://localhost:3000). The Stripe SDK reads its host, port, and protocol when the app starts. Use a fresh synthetic webhook secret in both the seed and the app for each run.

## Try the flow

1. Add a product to the bag and proceed to checkout.
2. Choose the test card ending in **0002** and click **Pay** to reproduce a decline. The same Checkout Session stays open and unpaid. Choose **4242** and click **Pay** to complete it.
3. On **Order Confirmed**, check for status `paid`, an `evt_` event ID, the fulfilment timestamp, and the same total and currency you saw at checkout.
4. If **Order Pending** appears, the cart remains intact. Select **Check Order Status** after the signed webhook arrives.
5. For a separate checkout, select **Cancel** to return to the bag without creating an order.

The webhook route passes the original bytes to `stripe.webhooks.constructEvent`. Invalid or absent signatures return HTTP 400. Failed Stripe webhook deliveries retry after 1, 2, and 4 seconds in the running emulator. Each attempt uses the original event ID and body with a new signing timestamp. A replay of the same paid event preserves the original fulfilment timestamp. Orders live in the app's memory and are cleared on restart.
