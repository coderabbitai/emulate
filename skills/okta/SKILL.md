---
name: okta
description: Emulated Okta API for local development and testing. Use when the user needs to manage users, groups, and apps locally, test Okta OAuth/OIDC flows, manage authorization servers, handle user lifecycle operations, or work with the Okta API without hitting the real Okta API. Triggers include "Okta API", "emulate Okta", "Okta auth", "Okta OIDC", "authorization server", "Okta users", or any task requiring a local identity provider API.
---

# Okta API Emulator

Stateful emulation of a subset of the Okta API with users, groups, apps, authorization servers, and OAuth/OIDC. Includes lifecycle helpers, group membership, app assignment, and per-authorization-server OAuth flows. It does not reproduce Okta authorization policies or full lifecycle validation.

Standalone state is in memory. Restart the process with the same seed to restore the baseline, then sign in again to obtain new codes and tokens. Each new process generates a new signing key while keeping the `kid` value `emulate-okta-1`; refresh clients' cached JWKS after a process restart before validating new ID tokens.

Adapted under Apache-2.0 from [Matt Van Horn (mvanhorn), vercel-labs/emulate PR #58](https://github.com/vercel-labs/emulate/pull/58), source commit `f37c8ec2e940e414d27c5f0e51bacba5cd32404d`.

The examples target the tested CodeRabbit fork runtime at commit `3ce3ebb264981c8f804aadef6cf7c23e533c3815` ([runtime PR #4](https://github.com/coderabbitai/emulate/pull/4)). This runtime is unreleased; use that exact revision. Its package manifest version is `0.10.0`, which alone does not identify the fork or commit.

## Start

Use an installation that includes the runtime above. Set `EMULATE_ROOT` to the deployed package directory, where `dist/index.js` sits directly beneath the root, and save the YAML in [Seed Config](#seed-config) as `okta-seed.yaml` in your current directory. Use `OKTA_PORT` to select a different port if necessary.

Standalone listeners bind beyond loopback. Run the service in an isolated VM or container network, or restrict access to the port with a firewall. This revision has no listener-host flag, and standalone management authentication accepts synthetic credentials.

```bash
node "$EMULATE_ROOT/dist/index.js" --service okta --port "${OKTA_PORT:-4000}" --seed okta-seed.yaml
```

Omit `--seed okta-seed.yaml` to use the built-in defaults. In a built checkout the CLI is at `packages/emulate/dist/index.js`.

Or programmatically, when the installed `emulate` package resolves to the same fork commit:

```typescript
import { createEmulator } from "emulate";

const okta = await createEmulator({ service: "okta", port: 4000 });
// okta.url === 'http://localhost:4000'
// When finished: await okta.close()
```

## Auth

Standalone CLI and `createEmulator` management calls require a nonempty Authorization header:

```bash
curl "http://localhost:${OKTA_PORT:-4000}/api/v1/users" \
  -H "Authorization: SSWS test_api_token"
```

With no header, management requests return 401. In these standalone modes, unknown nonempty Authorization values use a fallback identity, including the synthetic SSWS token above. This is permissive local behavior, not validation of real SSWS credentials, scopes, or Okta authorization policies. OAuth token and userinfo endpoints apply their own checks.

## Pointing Your App at the Emulator

### Okta Node.js SDK

This config illustrates the endpoint override. Compatibility with the installed SDK version must be checked separately.

```typescript
import { Client } from "@okta/okta-sdk-nodejs";

const client = new Client({
  orgUrl: "http://localhost:4000",
  token: "test_api_token",
});
```

### Environment Variable

```bash
export OKTA_ORG_URL="http://localhost:${OKTA_PORT:-4000}"
export OKTA_API_TOKEN=test_api_token
```

### Embedded in Next.js (adapter-next)

The pinned adapter does not configure the standalone fallback identity or a management token map. The same SSWS management calls return 401 in that mode. Use standalone CLI/API mode for the management recipes here; do not copy a standalone token into adapter settings and expect equivalent authentication. Embedded OAuth, CORS, and application SDK integration need separate qualification.

## Seed Config

```yaml
okta:
  users:
    - okta_id: 00u_guide_admin
      login: admin@example.com
      first_name: Admin
      last_name: User
      status: ACTIVE
    - okta_id: 00u_guide_dev
      login: dev@example.com
      first_name: Developer
      last_name: One
  groups:
    - name: Everyone
      type: BUILT_IN
    - okta_id: 00g_guide_engineering
      name: Engineering
      description: Engineering team
  apps:
    - okta_id: 0oa_guide_app
      name: myapp
      label: My Application
      sign_on_mode: OPENID_CONNECT
  authorization_servers:
    - id: default
      name: default
      description: Default authorization server
      audiences:
        - api://default
  oauth_clients:
    - client_id: emu_okta_client_id
      client_secret: emu_okta_client_secret
      name: My App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/okta
      grant_types:
        - authorization_code
        - refresh_token
      auth_server_id: default
  group_memberships:
    - group_okta_id: 00g_guide_engineering
      user_okta_id: 00u_guide_admin
```

The seed is additive to defaults. Existing logins, group/app names, clients, and authorization-server IDs are skipped rather than replaced. Membership references must match literal `okta_id` values.

Without this seed, defaults include `testuser@okta.local`, Everyone, a sample app, the `default` authorization server, and confidential client `okta-test-client` / `okta-test-secret` registered for `http://localhost:3000/callback`. The seeded `emu_okta_client_id` below is a separate client.

## API Endpoints

These are independent recipes, not one sequential script. Run this shared setup in the shell used for any recipe below. Load the seed above for the example IDs, or replace the quoted variables with IDs returned by create calls. Run reads and updates before deletion.

```bash
TOKEN="test_api_token"
BASE="http://localhost:${OKTA_PORT:-4000}"
USER_ID="00u_guide_admin"
GROUP_ID="00g_guide_engineering"
APP_ID="0oa_guide_app"
AUTH_SERVER_ID="default"
```

### Users

```bash
# Create user (ACTIVE by default; add ?activate=false for STAGED)
# Use the returned id for later operations on Jane.
curl -X POST "$BASE/api/v1/users" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"login": "jane@example.com", "email": "jane@example.com", "firstName": "Jane", "lastName": "Doe"}}'

# List users: q/search do substring matching; filter parses status eq only.
# Use page/per_page (1..100 per page), not Okta limit/after cursors.
# Unsupported filter expressions can be ignored; do not rely on them for selection.
curl "$BASE/api/v1/users?q=jane" \
  -H "Authorization: SSWS $TOKEN"

# Get current user
curl "$BASE/api/v1/users/me" \
  -H "Authorization: SSWS $TOKEN"

# Get user by ID
curl "$BASE/api/v1/users/${USER_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Update user (PUT merges supported profile fields; omitted fields remain)
curl -X PUT "$BASE/api/v1/users/${USER_ID}" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"firstName": "Updated"}}'

# Partial update (POST merges profile)
curl -X POST "$BASE/api/v1/users/${USER_ID}" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"nickName": "JD"}}'

# Delete user (first DELETE deprovisions; DELETE of DEPROVISIONED user removes it)
curl -X DELETE "$BASE/api/v1/users/${USER_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Get user's groups
curl "$BASE/api/v1/users/${USER_ID}/groups" \
  -H "Authorization: SSWS $TOKEN"
```

### User Lifecycle

Creation defaults to `ACTIVE`; `?activate=false` creates `STAGED`. Activate and unsuspend set `ACTIVE`, suspend sets `SUSPENDED`, deactivate sets `DEPROVISIONED`, and reactivate sets `PROVISIONED`. These helpers do not enforce a full state machine or test real Okta transition permissions.

Only `ACTIVE` users appear in the OAuth picker and can complete a new sign-in. Callback submissions selecting a non-`ACTIVE` user return HTTP `400` before a code is issued, including forms loaded before suspension or deactivation. This check does not revoke grants or tokens issued earlier.

```bash
# Activate user
curl -X POST "$BASE/api/v1/users/${USER_ID}/lifecycle/activate" \
  -H "Authorization: SSWS $TOKEN"

# Deactivate user
curl -X POST "$BASE/api/v1/users/${USER_ID}/lifecycle/deactivate" \
  -H "Authorization: SSWS $TOKEN"

# Suspend user (ACTIVE -> SUSPENDED)
curl -X POST "$BASE/api/v1/users/${USER_ID}/lifecycle/suspend" \
  -H "Authorization: SSWS $TOKEN"

# Unsuspend user (SUSPENDED -> ACTIVE)
curl -X POST "$BASE/api/v1/users/${USER_ID}/lifecycle/unsuspend" \
  -H "Authorization: SSWS $TOKEN"

# Reactivate user (sets PROVISIONED)
curl -X POST "$BASE/api/v1/users/${USER_ID}/lifecycle/reactivate" \
  -H "Authorization: SSWS $TOKEN"
```

### Groups

```bash
# Create group
curl -X POST "$BASE/api/v1/groups" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"name": "Backend Team", "description": "Backend engineers"}}'

# List groups (supports ?q= search)
curl "$BASE/api/v1/groups?q=backend" \
  -H "Authorization: SSWS $TOKEN"

# Get group
curl "$BASE/api/v1/groups/${GROUP_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Update group
curl -X PUT "$BASE/api/v1/groups/${GROUP_ID}" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile": {"name": "Updated Team"}}'

# Delete group
curl -X DELETE "$BASE/api/v1/groups/${GROUP_ID}" \
  -H "Authorization: SSWS $TOKEN"

# List group members
curl "$BASE/api/v1/groups/${GROUP_ID}/users" \
  -H "Authorization: SSWS $TOKEN"

# Add user to group
curl -X PUT "$BASE/api/v1/groups/${GROUP_ID}/users/${USER_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Remove user from group
curl -X DELETE "$BASE/api/v1/groups/${GROUP_ID}/users/${USER_ID}" \
  -H "Authorization: SSWS $TOKEN"
```

### Apps

```bash
# Create app
curl -X POST "$BASE/api/v1/apps" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "myapp", "label": "My App", "signOnMode": "OPENID_CONNECT"}'

# List apps
curl "$BASE/api/v1/apps" \
  -H "Authorization: SSWS $TOKEN"

# Get app
curl "$BASE/api/v1/apps/${APP_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Update app
curl -X PUT "$BASE/api/v1/apps/${APP_ID}" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "Updated App"}'

# Delete app (deactivate first; deleting an ACTIVE app returns 400)
curl -X POST "$BASE/api/v1/apps/${APP_ID}/lifecycle/deactivate" -H "Authorization: SSWS $TOKEN"
curl -X DELETE "$BASE/api/v1/apps/${APP_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Activate / Deactivate app
curl -X POST "$BASE/api/v1/apps/${APP_ID}/lifecycle/activate" -H "Authorization: SSWS $TOKEN"
curl -X POST "$BASE/api/v1/apps/${APP_ID}/lifecycle/deactivate" -H "Authorization: SSWS $TOKEN"

# List app users
curl "$BASE/api/v1/apps/${APP_ID}/users" \
  -H "Authorization: SSWS $TOKEN"

# Assign user to app
curl -X PUT "$BASE/api/v1/apps/${APP_ID}/users/${USER_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Remove user from app
curl -X DELETE "$BASE/api/v1/apps/${APP_ID}/users/${USER_ID}" \
  -H "Authorization: SSWS $TOKEN"
```

### Authorization Servers

```bash
# Create authorization server
curl -X POST "$BASE/api/v1/authorizationServers" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "custom", "description": "Custom auth server", "audiences": ["api://custom"]}'

# List authorization servers
curl "$BASE/api/v1/authorizationServers" \
  -H "Authorization: SSWS $TOKEN"

# Get authorization server
curl "$BASE/api/v1/authorizationServers/${AUTH_SERVER_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Update authorization server
curl -X PUT "$BASE/api/v1/authorizationServers/${AUTH_SERVER_ID}" \
  -H "Authorization: SSWS $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "updated", "description": "Updated description"}'

# Delete authorization server
curl -X DELETE "$BASE/api/v1/authorizationServers/${AUTH_SERVER_ID}" \
  -H "Authorization: SSWS $TOKEN"

# Activate / Deactivate
curl -X POST "$BASE/api/v1/authorizationServers/${AUTH_SERVER_ID}/lifecycle/activate" \
  -H "Authorization: SSWS $TOKEN"
curl -X POST "$BASE/api/v1/authorizationServers/${AUTH_SERVER_ID}/lifecycle/deactivate" \
  -H "Authorization: SSWS $TOKEN"
```

## OAuth / OIDC

Use `http://localhost:4000/oauth2/default` as the issuer for the seeded named-server client, substituting your port if you set `OKTA_PORT`. Its discovery document is at `/oauth2/default/.well-known/openid-configuration`. Org-level discovery is at `/.well-known/openid-configuration`. Use a client registered with the issuer and callback URI your app uses.

Run this setup in the same shell as the sign-in and exchange steps below. The state value here is for the synthetic example. Your app should generate and validate its own state.

```bash
OAUTH_BASE="http://localhost:${OKTA_PORT:-4000}/oauth2/default/v1"
CLIENT_ID="emu_okta_client_id"
CLIENT_SECRET="emu_okta_client_secret"
REDIRECT_URI="http://localhost:3000/api/auth/callback/okta"

okta_authorize_url() {
  printf '%s\n' "$OAUTH_BASE/authorize?client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&response_type=code&scope=openid+profile+email&state=okta-guide-state"
}

okta_exchange_code() {
  curl --silent --show-error --fail-with-body --max-time 5 "$OAUTH_BASE/token" \
    --data-urlencode "grant_type=authorization_code" \
    --data-urlencode "code=$1" \
    --data-urlencode "redirect_uri=$REDIRECT_URI" \
    --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "client_secret=$CLIENT_SECRET"
}
```

1. Open the URL printed by `okta_authorize_url` and choose `admin@example.com` in the Okta picker. On macOS, use `open "$(okta_authorize_url)"`.
2. Read the code from the registered callback URL and run `okta_exchange_code "$CODE"` with that value. A successful response contains an access token and an ID token. Keep their values local.

The emulator implements authorization code, client credentials, and refresh token grants. The issuer's discovery document lists endpoints such as userinfo, introspection, and revocation. Confidential-client introspection requires its secret. A logout redirect must match a registered redirect URI.

## Installed smoke check

From the source checkout, use a deployed package containing this guide and the qualified runtime. Run the check in an isolated environment. It uses the bundled seed, startup command, and OAuth recipe to select the seeded active user and exchange the authorization code for tokens. It requires Bash and curl. It stops the process after the check.

```bash
node scripts/smoke-okta-guide.mjs "$EMULATE_ROOT"
```
