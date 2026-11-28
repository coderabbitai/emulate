# Clerk browser integration fixture

The fixture runs ClerkJS 6.17.0 in Chromium and authenticates protected page requests with Clerk Backend 3.33.1. It serves local ClerkJS assets and uses the official Clerk Testing 2.3.9 setup and Playwright helper. Its synthetic publishable key uses an SDK-recognized development hostname. The browser uses a same-origin Frontend API proxy, with that placeholder hostname mapped to loopback in Chromium. The app uses temporary HTTPS locally so the official helper can match the requests. Its runner trusts the generated certificate and its browser contexts accept it for the one allowed origin.

Run from the repository root on macOS with Node 24 or newer and pnpm 11. Stage the dependencies, browser and CLI artifact before restricting network access.

```sh
fixture_source="$PWD/packages/emulate/test/fixtures/clerk-browser"
clerk_scratch="$(mktemp -d)"
mkdir "$clerk_scratch/fixture" "$clerk_scratch/consumer" "$clerk_scratch/artifact"
cp "$fixture_source"/* "$clerk_scratch/fixture/"

pnpm build
pnpm --dir packages/emulate pack --pack-destination "$clerk_scratch/artifact"
shasum -a 256 "$clerk_scratch/artifact"/emulate-*.tgz

printf '%s\n' '{"name":"clerk-browser-consumer","private":true,"packageManager":"pnpm@11.2.2"}' > "$clerk_scratch/consumer/package.json"
pnpm --dir "$clerk_scratch/consumer" add --ignore-scripts "$clerk_scratch/artifact"/emulate-*.tgz
pnpm --dir "$clerk_scratch/fixture" install --frozen-lockfile --ignore-scripts
pnpm --dir "$clerk_scratch/fixture" exec playwright install chromium
```

Run the fixture under the macOS outbound policy so the runner, app, CLI and Chromium inherit the restriction. macOS treats addresses attached to the host as local. The app and the runner both use explicit loopback addresses, and the browser checks for any destination outside the app origin. A full run takes roughly a minute to observe expiry on the original signed token.

```sh
/usr/bin/sandbox-exec -f "$clerk_scratch/fixture/mac-local.sb" \
  node "$clerk_scratch/fixture/clerk-browser.playwright.mjs" \
  "$clerk_scratch/consumer/node_modules/.bin/emulate"
```

Use `--baseline` with the unchanged package to exercise the seed and anonymous controls and confirm the first ClerkJS request fails on the missing Frontend API. The candidate run prints one JSON line per verification result and records protocol paths and parameter names. Credentials and credential values stay out of the log.
