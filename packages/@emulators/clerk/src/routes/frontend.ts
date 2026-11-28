/*! @license Apache-2.0
 * Adapted from vercel-labs/emulate PR #171 by Philip Snyder
 * at 73b9c4b4a72325d49560b43450799c2880f0c403.
 */
// Client credentials, ownership checks, and password/ticket transitions are local to this implementation.
import {
  constantTimeSecretEqual,
  type AppEnv,
  type Context,
  type InsertInput,
  type RouteContext,
} from "@emulators/core";
import {
  activeBrowserSession,
  browserCredential,
  browserPrimaryEmail,
  eligibleBrowserUser,
  getClerkBrowser,
  matchesSessionOrganization,
  ownedBrowserSession,
  preferredBrowserSessionId,
  signBrowserSession,
  signBrowserSessionSnapshot,
  type BrowserClient,
  type BrowserSignIn,
} from "../browser.js";
import type { ClerkSession, ClerkUser } from "../entities.js";
import { generateClerkId, nowUnix } from "../helpers.js";
import { clerkError, readJsonBody } from "../route-helpers.js";
import { getClerkStore, type ClerkStore } from "../store.js";
import { browserEnvironment } from "./frontend-environment.js";
import {
  browserClientResource,
  browserMembershipResource,
  browserSessionResource,
  browserSignInResource,
} from "./frontend-resources.js";

const CLIENT_CREDENTIAL = "__clerk_db_jwt";
const TESTING_TOKEN = "__clerk_testing_token";
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  if (c.req.header("Content-Type")?.includes("application/json")) {
    return Object.fromEntries(
      Object.entries(await readJsonBody(c)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  return Object.fromEntries(new URLSearchParams(await c.req.text()));
}

function signInError(c: Context<AppEnv>) {
  return clerkError(c, 422, "form_verification_failed", "Sign-in credentials are invalid");
}

function sessionUnavailable(c: Context<AppEnv>, client: BrowserClient, id: string) {
  return client.sessionIds.has(id)
    ? clerkError(c, 401, "signed_out", "Session is no longer active")
    : clerkError(c, 404, "resource_not_found", "Session not found");
}

function newSignIn(user: ClerkUser, identifier: string, strategy: BrowserSignIn["strategy"]): BrowserSignIn {
  return {
    id: generateClerkId("sia_"),
    userId: user.clerk_id,
    identifier,
    strategy,
    sessionId: null,
    expiresAt: Date.now() + ATTEMPT_TTL_MS,
  };
}

function passwordMatches(user: ClerkUser, password: string | undefined): boolean {
  return !!(
    user.password_enabled &&
    user.password_hash &&
    password &&
    constantTimeSecretEqual(user.password_hash, password)
  );
}

function newBrowserSession(cs: ClerkStore, client: BrowserClient, user: ClerkUser): InsertInput<ClerkSession> {
  const now = nowUnix();
  const org = cs.memberships
    .findBy("user_id", user.clerk_id)
    .find((membership) => cs.organizations.findOneBy("clerk_id", membership.org_id));
  return {
    clerk_id: generateClerkId("sess_"),
    user_id: user.clerk_id,
    client_id: client.id,
    browser_owned: true,
    browser_organization_id: org?.org_id ?? null,
    status: "active",
    last_active_at: now,
    expire_at: now + 86400,
    abandon_at: now + 604800,
    created_at_unix: now,
    updated_at_unix: now,
  };
}

function completeSignIn(
  cs: ClerkStore,
  client: BrowserClient,
  signIn: BrowserSignIn,
  user: ClerkUser,
  prepared = newBrowserSession(cs, client, user),
) {
  const now = nowUnix();
  const session = cs.sessions.insert(prepared);
  client.sessionIds.add(session.clerk_id);
  client.lastActiveSessionId = session.clerk_id;
  signIn.sessionId = session.clerk_id;
  client.signIn = signIn;
  cs.users.update(user.id, { last_active_at: now, last_sign_in_at: now, updated_at_unix: now });
  return session;
}

export function frontendRoutes({ app, store }: RouteContext): void {
  const cs = getClerkStore(store);
  type Browser = NonNullable<ReturnType<typeof getClerkBrowser>>;
  type Handler = (c: Context<AppEnv>, browser: Browser) => Response | Promise<Response>;

  function frontend(handler: Handler) {
    return (c: Context<AppEnv>) => {
      const browser = getClerkBrowser(store);
      if (!browser) return clerkError(c, 404, "resource_not_found", "Clerk browser mode is disabled");
      const origin = c.req.header("Origin");
      if (origin !== undefined && origin !== browser.config.origin) {
        return clerkError(c, 403, "origin_not_allowed", "Browser origin is not allowed");
      }
      c.header("Cache-Control", "no-store");

      // The SDK helper attaches a testing token to test traffic. It grants no browser or session authority.
      const testingToken = c.req.query(TESTING_TOKEN);
      if (testingToken) {
        const expiresAt = browser.testingTokens.get(testingToken);
        if (expiresAt !== undefined && expiresAt > Date.now()) {
          c.header("Clerk-Testing-Token", "accepted");
        } else if (expiresAt !== undefined) {
          browser.testingTokens.delete(testingToken);
        }
      }
      return handler(c, browser);
    };
  }

  function withClient(
    handler: (c: Context<AppEnv>, client: BrowserClient, browser: Browser) => Response | Promise<Response>,
  ) {
    return frontend((c, browser) => {
      const client = browser.clients.get(c.req.query(CLIENT_CREDENTIAL) ?? "");
      if (!client) return clerkError(c, 401, "signed_out", "Browser client is not recognized");
      return handler(c, client, browser);
    });
  }

  function createClient(c: Context<AppEnv>, browser: Browser) {
    const credential = browserCredential("cdb_");
    const client = {
      id: generateClerkId("client_"),
      createdAt: Date.now(),
      sessionIds: new Set<string>(),
      lastActiveSessionId: null,
    };
    browser.clients.set(credential, client);
    c.header("Clerk-Db-Jwt", credential);
    return { client, credential };
  }

  function signClientSessions(client: BrowserClient) {
    return Promise.all(
      Array.from(client.sessionIds, async (id) => [id, await signBrowserSession(store, cs, client, id)] as const),
    );
  }

  function clientSessions(client: BrowserClient, signed: Awaited<ReturnType<typeof signClientSessions>>) {
    return signed.flatMap(([id, signature]) => {
      const active = activeBrowserSession(cs, client, id);
      if (!active || !signature || !matchesSessionOrganization(cs, active.session, signature)) return [];
      return [browserSessionResource(cs, active.session, active.user, signature)];
    });
  }

  async function clientResource(client: BrowserClient) {
    return browserClientResource(client, clientSessions(client, await signClientSessions(client)));
  }

  async function signInReply(c: Context<AppEnv>, client: BrowserClient, attempt: BrowserSignIn) {
    const resource = await clientResource(client);
    if (attempt.sessionId && !resource.sessions.some((session) => session.id === attempt.sessionId)) {
      return sessionUnavailable(c, client, attempt.sessionId);
    }
    return c.json({ response: browserSignInResource(attempt), client: resource });
  }

  const environment = frontend((c, browser) => c.json({ response: browserEnvironment(browser.config.origin) }));
  app.get("/v1/environment", environment);
  app.post("/v1/environment", environment);
  app.post(
    "/v1/dev_browser",
    frontend((c, browser) => c.json({ id: createClient(c, browser).credential })),
  );

  const clientResponse = frontend(async (c, browser) => {
    const existing = browser.clients.get(c.req.query(CLIENT_CREDENTIAL) ?? "");
    const client = await clientResource(existing ?? createClient(c, browser).client);
    return c.json({ response: client, client });
  });
  app.get("/v1/client", clientResponse);
  app.post("/v1/client", clientResponse);

  app.post(
    "/v1/client/sign_ins",
    withClient(async (c, client, browser) => {
      const body = await form(c);
      if (getClerkBrowser(store) !== browser) return signInError(c);

      if (body.strategy === "ticket") {
        const ticket = browser.signInTickets.get(body.ticket);
        const user = ticket && cs.users.findOneBy("clerk_id", ticket.userId);
        if (!ticket || ticket.status !== "pending" || ticket.expiresAt <= Date.now() || !eligibleBrowserUser(user)) {
          return signInError(c);
        }
        const email = browserPrimaryEmail(cs, user);
        const attempt = newSignIn(user, email?.email_address ?? user.clerk_id, "ticket");
        const prepared = newBrowserSession(cs, client, user);
        const [existing, signature] = await Promise.all([
          signClientSessions(client),
          signBrowserSessionSnapshot(store, cs, prepared),
        ]);
        const currentUser = cs.users.findOneBy("clerk_id", ticket.userId);
        if (
          !signature ||
          getClerkBrowser(store) !== browser ||
          ticket.status !== "pending" ||
          ticket.expiresAt <= Date.now() ||
          !eligibleBrowserUser(currentUser) ||
          !matchesSessionOrganization(cs, prepared, signature)
        ) {
          return signInError(c);
        }
        // Publish the session and consume the ticket only after signing succeeds.
        const session = completeSignIn(cs, client, attempt, currentUser, prepared);
        ticket.status = "accepted";
        ticket.updatedAt = Date.now();
        const sessions = clientSessions(client, existing);
        sessions.push(browserSessionResource(cs, session, currentUser, signature));
        return c.json({ response: browserSignInResource(attempt), client: browserClientResource(client, sessions) });
      }

      if (body.strategy !== undefined && body.strategy !== "password") return signInError(c);
      const email = body.identifier && cs.emailAddresses.findOneBy("email_address", body.identifier);
      const user = email ? cs.users.findOneBy("clerk_id", email.user_id) : undefined;
      if (!email || !eligibleBrowserUser(user) || !user.password_enabled || !user.password_hash) return signInError(c);

      const attempt = newSignIn(user, email.email_address, "password");
      if (body.password !== undefined) {
        if (!passwordMatches(user, body.password)) return signInError(c);
        completeSignIn(cs, client, attempt, user);
      } else {
        client.signIn = attempt;
      }
      return signInReply(c, client, attempt);
    }),
  );

  app.post(
    "/v1/client/sign_ins/:signInId/attempt_first_factor",
    withClient(async (c, client, browser) => {
      const body = await form(c);
      const attempt = client.signIn;
      if (
        getClerkBrowser(store) !== browser ||
        !attempt ||
        attempt.id !== c.req.param("signInId") ||
        attempt.expiresAt <= Date.now() ||
        attempt.sessionId !== null
      ) {
        return clerkError(c, 404, "resource_not_found", "Sign-in attempt not found");
      }
      const user = cs.users.findOneBy("clerk_id", attempt.userId);
      if (body.strategy !== "password" || !eligibleBrowserUser(user) || !passwordMatches(user, body.password)) {
        return signInError(c);
      }
      completeSignIn(cs, client, attempt, user);
      return signInReply(c, client, attempt);
    }),
  );

  const readSession = async (c: Context<AppEnv>, client: BrowserClient) => {
    const id = c.req.param("sessionId");
    if (!activeBrowserSession(cs, client, id)) return sessionUnavailable(c, client, id);
    const resource = await clientResource(client);
    const session = resource.sessions.find((candidate) => candidate.id === id);
    return session ? c.json({ response: session, client: resource }) : sessionUnavailable(c, client, id);
  };
  app.get("/v1/client/sessions/:sessionId", withClient(readSession));

  app.post(
    "/v1/client/sessions/:sessionId/touch",
    withClient(async (c, client, browser) => {
      const body = await form(c);
      const id = c.req.param("sessionId");
      const active = activeBrowserSession(cs, client, id);
      if (getClerkBrowser(store) !== browser || !active) return sessionUnavailable(c, client, id);

      const orgId = body.active_organization_id;
      if (orgId && !cs.memberships.findBy("user_id", active.user.clerk_id).some((m) => m.org_id === orgId)) {
        return clerkError(c, 422, "organization_membership_not_found", "Organization membership not found");
      }
      const now = nowUnix();
      cs.sessions.update(active.session.id, {
        last_active_at: now,
        updated_at_unix: now,
        ...(orgId !== undefined && { browser_organization_id: orgId || null }),
      });
      client.lastActiveSessionId = id;
      return readSession(c, client);
    }),
  );

  app.post(
    "/v1/client/sessions/:sessionId/tokens",
    withClient(async (c, client) => {
      const id = c.req.param("sessionId");
      const signature = await signBrowserSession(store, cs, client, id);
      // Recheck in the route as well as in the signing helper before the response starts.
      const current = activeBrowserSession(cs, client, id);
      if (!signature || !current || !matchesSessionOrganization(cs, current.session, signature)) {
        return sessionUnavailable(c, client, id);
      }
      return c.json(signature.token);
    }),
  );

  const endOne = withClient(async (c, client) => {
    const id = c.req.param("sessionId");
    const session = ownedBrowserSession(cs, client, id);
    if (!session || session.status !== "active") return sessionUnavailable(c, client, id);
    const user = cs.users.findOneBy("clerk_id", session.user_id);
    const now = nowUnix();
    cs.sessions.update(session.id, { status: "ended", updated_at_unix: now });
    if (client.lastActiveSessionId === id) client.lastActiveSessionId = null;
    if (client.signIn?.sessionId === id) client.signIn = undefined;
    return c.json({
      response: user
        ? browserSessionResource(cs, { ...session, status: "ended", updated_at_unix: now }, user, null)
        : { object: "session", id, status: "ended" },
      client: await clientResource(client),
    });
  });
  app.post("/v1/client/sessions/:sessionId/end", endOne);
  app.post("/v1/client/sessions/:sessionId/remove", endOne);

  const endAll = withClient(async (c, client) => {
    if (c.req.method === "POST" && c.req.query("_method") !== "DELETE") {
      return clerkError(c, 405, "method_not_allowed", "Use DELETE to end sessions");
    }
    const now = nowUnix();
    for (const id of client.sessionIds) {
      const session = ownedBrowserSession(cs, client, id);
      if (session?.status === "active") cs.sessions.update(session.id, { status: "ended", updated_at_unix: now });
    }
    client.lastActiveSessionId = null;
    client.signIn = undefined;
    const resource = await clientResource(client);
    return c.json({ response: resource, client: resource });
  });
  app.post("/v1/client/sessions", endAll);
  app.delete("/v1/client/sessions", endAll);

  app.get(
    "/v1/me/organization_memberships",
    withClient((c, client) => {
      const id =
        c.req.query("_clerk_session_id") ??
        preferredBrowserSessionId(
          client,
          Array.from(client.sessionIds).filter((sessionId) => activeBrowserSession(cs, client, sessionId)),
        ) ??
        "";
      const active = activeBrowserSession(cs, client, id);
      if (!active) return sessionUnavailable(c, client, id);
      const data = cs.memberships
        .findBy("user_id", active.user.clerk_id)
        .flatMap((membership) => browserMembershipResource(cs, membership));
      return c.json({ response: { data, total_count: data.length } });
    }),
  );
}
