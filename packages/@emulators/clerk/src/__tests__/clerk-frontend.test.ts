import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { describe, it, expect, vi } from "vitest";
import { clerkPlugin, getClerkStore, seedFromConfig, type ClerkSeedConfig } from "../index.js";

const issuer = "http://127.0.0.1:4200";
const origin = "http://127.0.0.1:3000";
const secretKey = "sk_test_clerk_fixture";
const password = "fixture-password-sentinel";
const privateMetadata = "fixture-private-sentinel";

interface ClientReply {
  client: {
    id: string;
    sessions: Array<{ id: string; user: { id: string }; last_active_token: { jwt: string } }>;
  };
}

interface SignInReply extends ClientReply {
  response: { id: string; status: string; created_session_id: string };
}

function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function setup(browser = true, baseUrl = issuer, configuredUser?: NonNullable<ClerkSeedConfig["users"]>[number]) {
  const store = new Store();
  const tokens: TokenMap = new Map([
    [secretKey, { login: "admin", id: 1, scopes: [] }],
    ["sk_live_fixture", { login: "admin", id: 1, scopes: [] }],
  ]);
  const app = new Hono<AppEnv>();
  app.use("*", authMiddleware(tokens, undefined, { login: "fallback", id: 1, scopes: [] }));
  clerkPlugin.register(app, store, new WebhookDispatcher(), baseUrl, tokens);
  clerkPlugin.seed?.(store, baseUrl);
  const seed = {
    browser_app_origin: browser ? origin : undefined,
    users: [
      {
        clerk_id: "user_fixture_a",
        email_addresses: ["a@example.test"],
        password,
        private_metadata: { privateMetadata },
      },
      { clerk_id: "user_fixture_b", email_addresses: ["b@example.test"], password },
      ...(configuredUser ? [configuredUser] : []),
    ],
    organizations: [
      {
        clerk_id: "org_fixture",
        name: "Fixture",
        private_metadata: { privateMetadata },
        members: [
          { email: "a@example.test", role: "admin" },
          { email: "b@example.test", role: "member" },
        ],
      },
    ],
  } satisfies ClerkSeedConfig;
  seedFromConfig(store, baseUrl, seed);

  async function request(
    path: string,
    options: { method?: string; client?: string; body?: Record<string, string>; requestOrigin?: string } = {},
  ) {
    const url = new URL(`/v1/${path}`, issuer);
    if (options.client) url.searchParams.set("__clerk_db_jwt", options.client);
    return app.request(url.href, {
      method: options.method ?? (options.body ? "POST" : "GET"),
      headers: {
        ...(options.requestOrigin ? { Origin: options.requestOrigin } : {}),
        ...(options.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: options.body && new URLSearchParams(options.body),
    });
  }

  function backend(path: string, body: object = {}, key: string | null = secretKey, method = "POST") {
    return app.request(`${issuer}/v1/${path}`, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function bootstrap() {
    const reply = await request("dev_browser", { method: "POST", requestOrigin: origin });
    expect(reply.status).toBe(200);
    return (await json<{ id: string }>(reply)).id;
  }

  async function signIn(client: string, identifier = "a@example.test") {
    const reply = await request("client/sign_ins", {
      client,
      body: { identifier, password },
      requestOrigin: origin,
    });
    expect(reply.status).toBe(200);
    return json<SignInReply>(reply);
  }

  return { app, store, backend, request, bootstrap, signIn, seed };
}

describe("Clerk browser sessions", () => {
  it("keeps the frontend opt-in and rejects a foreign browser origin", async () => {
    expect(() => setup(true, "https://hosted.clerk.invalid")).toThrow(/requires exact loopback/);
    expect((await setup(false).request("dev_browser", { method: "POST" })).status).toBe(404);
    const fixture = setup();
    expect(
      (await fixture.request("dev_browser", { method: "POST", requestOrigin: "http://localhost:3010" })).status,
    ).toBe(403);
    const client = await fixture.bootstrap();
    expect(
      (
        await fixture.request("client/sign_ins", {
          client,
          body: { identifier: "a@example.test", password },
          requestOrigin: "http://localhost:3010",
        })
      ).status,
    ).toBe(403);
    expect(
      (await fixture.request("client/sign_ins", { body: { identifier: "a@example.test", password } })).status,
    ).toBe(401);
  });

  it("keeps session identity, tokens and permissions isolated between clients", async () => {
    const fixture = setup();
    const a = await fixture.bootstrap();
    const b = await fixture.bootstrap();
    expect(a).not.toBe(b);
    const login = await fixture.signIn(a);
    const sessionId = login.response.created_session_id;
    expect(login.client.sessions.map(({ id }: { id: string }) => id)).toEqual([sessionId]);
    expect((await json<ClientReply>(await fixture.request("client", { client: b }))).client.sessions).toEqual([]);
    const reload = await json<ClientReply>(await fixture.request("client", { client: a }));
    expect(reload.client.sessions.map(({ id }: { id: string }) => id)).toEqual([sessionId]);
    const jwt = reload.client.sessions[0].last_active_token.jwt;
    expect(decodeProtectedHeader(jwt).cat).toBe("cl_B7d4PD111AAA");
    const claims = decodeJwt(jwt);
    expect(claims).toMatchObject({
      iss: issuer,
      azp: origin,
      sid: sessionId,
      sub: "user_fixture_a",
      org_role: "org:admin",
      org_id: "org_fixture",
    });
    expect(claims.exp! - claims.iat!).toBe(60);
    const jwks = await json<{ keys: JWK[] }>(await fixture.request("jwks"));
    const key = jwks.keys.find(({ kid }) => kid === decodeProtectedHeader(jwt).kid);
    expect(key).toBeDefined();
    await expect(jwtVerify(jwt, await importJWK(key!, "RS256"), { issuer })).resolves.toBeTruthy();
    for (const sensitive of ["password_hash", "private_metadata", password, privateMetadata]) {
      expect(JSON.stringify([login, reload, claims])).not.toContain(sensitive);
    }

    for (const action of ["touch", "tokens", "end"]) {
      expect(
        (await fixture.request(`client/sessions/${sessionId}/${action}`, { client: b, method: "POST" })).status,
      ).toBe(404);
    }
    expect((await fixture.request(`client/sessions/${sessionId}`, { client: b })).status).toBe(404);
    expect(
      (await fixture.request(`me/organization_memberships?_clerk_session_id=${sessionId}`, { client: b })).status,
    ).toBe(404);

    const second = await fixture.signIn(b, "b@example.test");
    const secondId = second.response.created_session_id;
    expect(secondId).not.toBe(sessionId);
    expect((await fixture.request(`client/sessions/${sessionId}/end`, { client: a, method: "POST" })).status).toBe(200);
    expect((await fixture.request(`client/sessions/${sessionId}/tokens`, { client: a, method: "POST" })).status).toBe(
      401,
    );
    const secondRenewal = await fixture.request(`client/sessions/${secondId}/tokens`, { client: b, method: "POST" });
    expect(secondRenewal.status).toBe(200);
    expect(decodeJwt((await json<{ jwt: string }>(secondRenewal)).jwt)).toMatchObject({
      sub: "user_fixture_b",
      org_role: "org:member",
    });
    expect((await fixture.signIn(a)).response.created_session_id).not.toBe(sessionId);
  });

  it("denies renewals after expiry, revocation and store reset", async () => {
    const fixture = setup();
    const a = await fixture.bootstrap();
    const login = await fixture.signIn(a);
    const sessionId = login.response.created_session_id;
    const path = `client/sessions/${sessionId}/tokens`;
    const legacyMint = await fixture.backend(`sessions/${sessionId}/tokens`);
    expect(legacyMint.status).toBe(422);
    expect((await fixture.backend(`sessions/${sessionId}/revoke`, {}, "sk_test_unknown")).status).toBe(401);

    const [renewal, revoke] = await Promise.all([
      fixture.request(path, { client: a, method: "POST" }),
      fixture.backend(`sessions/${sessionId}/revoke`),
    ]);
    expect(revoke.status).toBe(200);
    expect(renewal.status).toBe(401);

    const oldToken = login.client.sessions[0]!.last_active_token.jwt;
    const oldClaims = decodeJwt(oldToken);
    const jwks = await json<{ keys: JWK[] }>(await fixture.request("jwks"));
    const signingKey = await importJWK(
      jwks.keys.find((key) => key.kid === decodeProtectedHeader(oldToken).kid)!,
      "RS256",
    );
    await expect(
      jwtVerify(oldToken, signingKey, { issuer, currentDate: new Date((oldClaims.exp! - 1) * 1000) }),
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(oldToken, signingKey, { issuer, currentDate: new Date((oldClaims.exp! + 1) * 1000) }),
    ).rejects.toMatchObject({ code: "ERR_JWT_EXPIRED" });
    expect((await fixture.request(path, { client: a, method: "POST" })).status).toBe(401);

    const sessionId2 = (await fixture.signIn(a)).response.created_session_id;
    const sessions = getClerkStore(fixture.store).sessions;
    sessions.update(sessions.findOneBy("clerk_id", sessionId2)!.id, { expire_at: 1 });
    expect((await fixture.request(`client/sessions/${sessionId2}/touch`, { client: a, method: "POST" })).status).toBe(
      401,
    );

    const oldKey = (await json<{ keys: JWK[] }>(await fixture.request("jwks"))).keys[1];
    fixture.store.reset();
    seedFromConfig(fixture.store, issuer, fixture.seed);
    expect((await json<ClientReply>(await fixture.request("client", { client: a }))).client.sessions).toEqual([]);
    expect((await fixture.request(path, { client: a, method: "POST" })).status).toBe(401);
    expect((await json<{ keys: JWK[] }>(await fixture.request("jwks"))).keys[1].kid).not.toBe(oldKey.kid);
  });

  it("ends one session without ending another session owned by the same browser", async () => {
    const fixture = setup();
    const a = await fixture.bootstrap();
    const first = (await fixture.signIn(a)).response.created_session_id;
    const second = (await fixture.signIn(a, "b@example.test")).response.created_session_id;
    expect((await fixture.request(`client/sessions/${first}/end`, { client: a, method: "POST" })).status).toBe(200);
    expect((await fixture.request(`client/sessions/${second}/tokens`, { client: a, method: "POST" })).status).toBe(200);
    expect((await fixture.request("client/sessions", { client: a, method: "POST" })).status).toBe(405);
    const logout = await fixture.request("client/sessions?_method=DELETE", { client: a, method: "POST" });
    expect(logout.status).toBe(200);
    expect((await json<ClientReply>(logout)).client.sessions).toEqual([]);
    expect((await fixture.request(`client/sessions/${second}/tokens`, { client: a, method: "POST" })).status).toBe(401);
  });

  it("keeps legacy BAPI sessions and JWTs outside the browser client", async () => {
    const fixture = setup();
    const a = await fixture.bootstrap();
    const { client } = await json<ClientReply>(await fixture.request("client", { client: a }));
    const reply = await fixture.backend("sessions", { user_id: "user_fixture_a", client_id: client.id });
    expect(reply.status).toBe(200);
    const legacySession = await json<{ id: string }>(reply);
    const tokenReply = await fixture.backend(`sessions/${legacySession.id}/tokens`);
    expect(tokenReply.status).toBe(200);
    const token = (await json<{ jwt: string }>(tokenReply)).jwt;
    expect(decodeProtectedHeader(token).kid).toBe("emulate-clerk-1");
    expect((await json<ClientReply>(await fixture.request("client", { client: a }))).client.sessions).toEqual([]);
    expect(
      (await fixture.request(`client/sessions/${legacySession.id}/tokens`, { client: a, method: "POST" })).status,
    ).toBe(404);
  });
});

describe("Clerk password and test credentials", () => {
  it("requires a configured test key on backend changes that affect browser sessions", async () => {
    const fixture = setup();
    const oldKey = "sk_test_unknown";
    for (const key of [null, "sk_live_fixture"]) {
      expect((await fixture.backend("users/user_fixture_a/lock", {}, key)).status).toBe(401);
    }
    for (const [method, route, body] of [
      ["PATCH", "users/user_fixture_a", { password: "fixture-rotation" }],
      ["DELETE", "users/user_fixture_a", {}],
      ["POST", "users/user_fixture_a/lock", {}],
      ["POST", "users/user_fixture_a/verify_password", { password }],
      ["POST", "email_addresses", { user_id: "user_fixture_a", email_address: "other@example.test" }],
      ["PATCH", "organizations/org_fixture/memberships/user_fixture_b", { role: "org:admin" }],
      ["DELETE", "organizations/org_fixture", {}],
      ["POST", "sessions", { user_id: "user_fixture_a" }],
    ] as const) {
      expect((await fixture.backend(route, body, oldKey, method)).status, route).toBe(401);
    }
    expect(
      (
        await fixture.backend(
          "organizations/org_fixture/memberships/user_fixture_b",
          { role: "org:member" },
          secretKey,
          "PATCH",
        )
      ).status,
    ).toBe(200);
    expect(
      (await setup(false).backend("users/user_fixture_a", { first_name: "Fallback" }, oldKey, "PATCH")).status,
    ).toBe(200);
  });

  it("uses an explicit browser seed when it matches the automatic default email", async () => {
    const user = {
      clerk_id: "user_fixture_default",
      email_addresses: ["test@example.com", "secondary@example.test"],
      first_name: "Configured",
      password,
      public_metadata: { group: "fixture" },
      private_metadata: { privateMetadata },
    };
    const fixture = setup(true, issuer, user);
    const client = await fixture.bootstrap();
    const oldDefault = await fixture.request("client/sign_ins", {
      client,
      body: { identifier: "test@example.com", password: "test_password" },
    });
    expect(oldDefault.status).toBe(422);
    const signedIn = await fixture.signIn(client, "test@example.com");
    expect(signedIn.client.sessions[0].user).toMatchObject({
      id: user.clerk_id,
      first_name: user.first_name,
      public_metadata: user.public_metadata,
      email_addresses: [
        expect.objectContaining({ email_address: "test@example.com" }),
        expect.objectContaining({ email_address: "secondary@example.test" }),
      ],
    });
    expect(JSON.stringify(signedIn)).not.toContain(privateMetadata);
    const legacy = setup(false, issuer, user);
    const legacyDefault = await legacy.app.request(`${issuer}/v1/users?email_address=test%40example.com`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    expect((await json<{ data: Array<{ first_name: string }> }>(legacyDefault)).data[0].first_name).toBe("Test");
  });

  it("omits another user's primary email reference from browser and ticket responses", async () => {
    const fixture = setup();
    const b = getClerkStore(fixture.store).emailAddresses.findOneBy("email_address", "b@example.test")!;
    const edit = await fixture.backend(
      "users/user_fixture_a",
      { primary_email_address_id: b.email_id },
      secretKey,
      "PATCH",
    );
    expect(edit.status).toBe(200);
    const client = await fixture.bootstrap();
    const signIn = await fixture.signIn(client);
    expect(signIn.client.sessions[0].user).toMatchObject({ primary_email_address_id: null });
    expect(JSON.stringify(signIn)).not.toContain(b.email_address);
    const issue = await fixture.backend("sign_in_tokens", { user_id: "user_fixture_a" });
    const { token } = await json<{ token: string }>(issue);
    const redeem = await fixture.request("client/sign_ins", { client, body: { strategy: "ticket", ticket: token } });
    expect(redeem.status).toBe(200);
    expect(await redeem.text()).not.toContain(b.email_address);
  });

  it("binds one password attempt to its client and rejects ineligible users and strategies", async () => {
    const fixture = setup();
    const a = await fixture.bootstrap();
    const b = await fixture.bootstrap();
    const prep = await fixture.request("client/sign_ins", { client: a, body: { identifier: "a@example.test" } });
    expect(prep.status).toBe(200);
    const attempt = (await json<SignInReply>(prep)).response;
    expect(attempt.status).toBe("needs_first_factor");
    const complete = `client/sign_ins/${attempt.id}/attempt_first_factor`;
    const credentials = { strategy: "password", password };
    expect((await fixture.request(complete, { client: b, body: credentials })).status).toBe(404);
    expect(
      (await fixture.request(complete, { client: a, body: { ...credentials, password: "incorrect" } })).status,
    ).toBe(422);
    expect(
      (await fixture.request(complete, { client: a, body: { ...credentials, strategy: "unsupported" } })).status,
    ).toBe(422);
    expect((await fixture.backend("users/user_fixture_a/lock")).status).toBe(200);
    expect((await fixture.request(complete, { client: a, body: credentials })).status).toBe(422);
    expect((await fixture.backend("users/user_fixture_a/unlock")).status).toBe(200);
    expect((await fixture.request(complete, { client: a, body: credentials })).status).toBe(200);
    expect((await fixture.request(complete, { client: a, body: credentials })).status).toBe(404);
    expect(
      (await fixture.request("client/sign_ins", { client: b, body: { identifier: "absent@example.test", password } }))
        .status,
    ).toBe(422);

    const bapiUser = await fixture.backend("users", { email_address: ["bapi-only@example.test"], password });
    expect(bapiUser.status).toBe(200);
    expect(
      (
        await fixture.request("client/sign_ins", {
          client: b,
          body: { identifier: "bapi-only@example.test", password },
        })
      ).status,
    ).toBe(422);
  });

  it("requires an exact configured test key even when fallback auth is active", async () => {
    const fixture = setup();
    for (const key of [null, "sk_test_unknown", "sk_live_fixture"]) {
      expect((await fixture.backend("testing_tokens", {}, key)).status).toBe(401);
      expect((await fixture.backend("sign_in_tokens", { user_id: "user_fixture_a" }, key)).status).toBe(401);
    }
    expect((await setup(false).backend("testing_tokens")).status).toBe(404);
    expect((await fixture.backend("sign_in_tokens", { user_id: "user_missing" })).status).toBe(404);
    expect((await fixture.backend("users/user_fixture_a/ban")).status).toBe(200);
    expect((await fixture.backend("sign_in_tokens", { user_id: "user_fixture_a" })).status).toBe(404);
  });

  it("recognizes a current testing token without granting identity, and rejects prior-run scope", async () => {
    const fixture = setup();
    const reply = await fixture.backend("testing_tokens");
    expect(reply.status).toBe(200);
    const testing = await json<{ token: string }>(reply);
    expect(testing).toMatchObject({ object: "testing_token", token: expect.stringMatching(/^ctt_/) });

    const other = setup();
    const startTime = Date.now();
    for (const [instance, token, accepted] of [
      [fixture, testing.token, "accepted"],
      [fixture, "invalid-testing-token", null],
      [other, testing.token, null],
    ] as const) {
      const query = `__clerk_testing_token=${token}`;
      const probe = await instance.request(`client?${query}`);
      expect(probe.headers.get("Clerk-Testing-Token")).toBe(accepted);
      expect((await json<ClientReply>(probe)).client.sessions).toEqual([]);
      expect(
        (
          await instance.request(`client/sign_ins?${query}`, {
            body: { identifier: "a@example.test", password },
          })
        ).status,
      ).toBe(401);
    }
    const clock = vi.spyOn(Date, "now").mockReturnValue(startTime + 10 * 60 * 1000 + 1000);
    try {
      const expired = await fixture.request(`client?__clerk_testing_token=${testing.token}`);
      expect(expired.headers.has("Clerk-Testing-Token")).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects revoked, expired and foreign tickets and permits exactly one concurrent redemption", async () => {
    const fixture = setup();
    const a = await fixture.bootstrap();
    const b = await fixture.bootstrap();

    async function issue(expiresInSeconds = 60) {
      const reply = await fixture.backend("sign_in_tokens", {
        user_id: "user_fixture_b",
        expires_in_seconds: expiresInSeconds,
      });
      expect(reply.status).toBe(200);
      return json<{ id: string; token: string }>(reply);
    }

    function redeem(client: string, ticket: string, instance = fixture) {
      return instance.request("client/sign_ins", { client, body: { strategy: "ticket", ticket } });
    }

    const ticket = await issue();
    expect((await fixture.backend(`sign_in_tokens/${ticket.id}/revoke`, {}, "sk_test_unknown")).status).toBe(401);
    const races = await Promise.all([redeem(a, ticket.token), redeem(b, ticket.token)]);
    expect(races.map((reply) => reply.status).sort()).toEqual([200, 422]);
    const signed = await json<SignInReply>(races.find((reply) => reply.ok)!);
    expect(signed.response.status).toBe("complete");
    expect(signed.client.sessions.map(({ user }: { user: { id: string } }) => user.id)).toEqual(["user_fixture_b"]);
    const sessions = await fixture.app.request(`${issuer}/v1/sessions`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    expect((await json<{ total_count: number }>(sessions)).total_count).toBe(1);
    expect((await redeem(a, ticket.token)).status).toBe(422);

    const revoked = await issue();
    const revocation = await fixture.backend(`sign_in_tokens/${revoked.id}/revoke`);
    expect(revocation.status).toBe(200);
    expect((await json<{ status: string }>(revocation)).status).toBe("revoked");
    expect((await redeem(a, revoked.token)).status).toBe(422);
    expect((await redeem(a, "invalid-ticket")).status).toBe(422);

    const short = await issue(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    try {
      expect((await redeem(a, short.token)).status).toBe(422);
    } finally {
      clock.mockRestore();
    }

    const foreign = await issue();
    const other = setup();
    expect((await redeem(await other.bootstrap(), foreign.token, other)).status).toBe(422);
  });
});
