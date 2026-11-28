# Clerk browser integration fixture

The fixture runs ClerkJS 6.17.0 in Chromium and authenticates protected page requests with Clerk Backend 3.33.1. It serves local ClerkJS assets and uses the official Clerk Testing 2.3.9 setup and Playwright helper. Its synthetic publishable key uses an SDK-recognized development hostname. The browser uses a same-origin Frontend API proxy, with that placeholder hostname mapped to loopback in Chromium. The app uses temporary HTTPS locally so the official helper can match the requests. Its runner trusts the generated certificate and its browser contexts accept it for the one allowed origin.

Run from the repository root on macOS with Node 24 or newer and pnpm 11. Stage the shared fixture dependencies and browser before restricting network access.

```sh
fixture_source="$PWD/packages/emulate/test/fixtures/clerk-browser"
clerk_scratch="$(mktemp -d)"
mkdir "$clerk_scratch/fixture"
cp "$fixture_source"/* "$clerk_scratch/fixture/"

pnpm build
pnpm --dir "$clerk_scratch/fixture" install --frozen-lockfile --ignore-scripts
pnpm --dir "$clerk_scratch/fixture" exec playwright install chromium
```

## Full browser runtime fixture

```sh
mkdir "$clerk_scratch/consumer" "$clerk_scratch/artifact"
pnpm --dir packages/emulate pack --pack-destination "$clerk_scratch/artifact"
shasum -a 256 "$clerk_scratch/artifact"/emulate-*.tgz

printf '%s\n' '{"name":"clerk-browser-consumer","private":true,"packageManager":"pnpm@11.2.2"}' > "$clerk_scratch/consumer/package.json"
pnpm --dir "$clerk_scratch/consumer" add --ignore-scripts "$clerk_scratch/artifact"/emulate-*.tgz
```

Run the fixture under the macOS outbound policy so the runner, app, CLI and Chromium inherit the restriction. macOS treats addresses attached to the host as local. The app and the runner both use explicit loopback addresses, and the browser checks for any destination outside the app origin. A full run takes roughly a minute to observe expiry on the original signed token.

```sh
/usr/bin/sandbox-exec -f "$clerk_scratch/fixture/mac-local.sb" \
  node "$clerk_scratch/fixture/clerk-browser.playwright.mjs" \
  "$clerk_scratch/consumer/node_modules/.bin/emulate"
```

Use `--baseline` with the unchanged package to exercise the seed and anonymous controls and confirm the first ClerkJS request fails on the missing Frontend API. The candidate run prints one JSON line per verification result and records protocol paths and parameter names. Credentials and credential values stay out of the log.

## Installed guide smoke

After the shared fixture staging and build, deploy from the same source revision and copy the guide catalog and README the way the source installer does. The standalone npm package contains the CLI only.

```sh
emulate_root="$clerk_scratch/deployed"
pnpm --filter emulate deploy --prod --legacy "$emulate_root"
cp -R skills "$emulate_root/skills"
cp README.md "$emulate_root/README.md"

/usr/bin/sandbox-exec -f "$clerk_scratch/fixture/mac-local.sb" \
  node "$clerk_scratch/fixture/clerk-browser.playwright.mjs" \
  "$emulate_root/dist/index.js" --guide-smoke
```

The smoke reads `skills/clerk/SKILL.md` from the deployed root. It runs the guide's browser seed and launch recipe with temporary loopback ports and a seed path. It signs in a seeded user in ClerkJS and verifies HTTP 200 with that identity on the Backend SDK's protected route. The full browser fixture above covers additional protocol behavior.
