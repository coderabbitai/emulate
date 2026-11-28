import assert from "node:assert/strict";
import { createClerkClient } from "@clerk/backend";
import { clerk as clerkTesting, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  fixtureSeed,
  frontendHostname,
  organizationId,
  proxyPath,
  publishableKey,
  report,
  secretKey,
  users,
} from "./fixture.mjs";

const [cliPath, mode] = process.argv.slice(2);
if (!cliPath || ![undefined, "--baseline", "--guide-smoke"].includes(mode)) {
  throw new Error(
    "Usage: node clerk-browser.playwright.mjs <installed node_modules/.bin/emulate> [--baseline] or <installed dist/index.js> --guide-smoke",
  );
}
const guideSmoke = mode === "--guide-smoke";
const cli = guideSmoke ? process.execPath : await realpath(cliPath);
const installedCli = await realpath(guideSmoke ? cliPath : resolve(dirname(cliPath), "../emulate/dist/index.js"));
const cliArgs = guideSmoke ? [installedCli] : [];
if (!guideSmoke) {
  const consumer = await realpath(resolve(dirname(cliPath), "../.."));
  assert.ok(installedCli.startsWith(`${consumer}/node_modules/`), "Pass the executable from an installed CLI package");
}
process.env.CLERK_TELEMETRY_DISABLED = "1";
const fixture = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "clerk-browser-run-"));
let browser;
let app;
let emulator;
let currentStage = "setup";
const offlineAttempts = [];
const frontendLog = [];

function pass(check, details) {
  report("pass", { check, ...details });
}

async function measure(check, action) {
  currentStage = check;
  const result = await action();
  pass(check);
  return result;
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function startChild(bin, args, capture) {
  const child = spawn(bin, args, { cwd: scratch, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (error) => report("child_error", { code: error.code }));
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.startsWith("{") || !capture) continue;
        const entry = JSON.parse(line);
        if (entry.event === "frontend") frontendLog.push(entry);
        if (entry.event === "handshake" && entry.origin !== appOrigin) offlineAttempts.push(entry.origin);
        report(entry.event, entry);
      }
    });
  }
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = once(child, "close");
  child.kill();
  const timeout = AbortSignal.timeout(2000);
  await Promise.race([closed, once(timeout, "abort")]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function waitForHttp(check, child) {
  for (let attempt = 0; attempt < 80 && child.exitCode === null; attempt++) {
    try {
      if ((await check()).status === 200) return;
    } catch {}
    await delay(75);
  }
  throw new Error("Local listener failed health check");
}

const appPort = await freePort();
const clerkPort = await freePort();
assert.notEqual(appPort, clerkPort);
const appOrigin = `https://127.0.0.1:${appPort}`;
const issuer = `http://127.0.0.1:${clerkPort}`;
const caPath = join(scratch, "fixture-cert.pem");
const tlsKey = join(scratch, "fixture-key.pem");
const seed = join(scratch, "seed.json");

function appRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(appOrigin, { ca, path, ...options }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
      response.on("error", reject);
    });
    outgoing.setTimeout(3000, () => outgoing.destroy());
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

async function startEmulator(
  args = ["start", "--service", "clerk", "--port", String(clerkPort), "--base-url", issuer, "--seed", seed],
) {
  emulator = startChild(cli, [...cliArgs, ...args]);
  await waitForHttp(() => fetch(`${issuer}/v1/jwks`, { redirect: "error" }), emulator);
}

async function readBrowserGuide() {
  const path = join(dirname(installedCli), "../skills/clerk/SKILL.md");
  const guide = await readFile(path, "utf8");
  const section = guide.split(/^### Browser seed$/m)[1];
  const blocks = section?.match(/```json\n([\s\S]*?)\n```\n\n```bash\n([\s\S]*?)\n```/);
  assert.ok(blocks, "Expected the installed guide's browser seed and launch command");
  const [, seedJson, launch] = blocks;
  const config = JSON.parse(seedJson);
  config.clerk.browser_app_origin = appOrigin;

  const [npx, offline, emulate, ...args] = launch.replaceAll("\\\n", " ").trim().split(/\s+/);
  assert.deepEqual([npx, offline, emulate], ["npx", "--no-install", "emulate"]);
  for (const [option, value] of [
    ["--port", String(clerkPort)],
    ["--base-url", issuer],
    ["--seed", seed],
  ]) {
    const index = args.indexOf(option);
    assert.ok(index >= 0 && args[index + 1] && !args[index + 1].startsWith("--"), `Expected a value for ${option}`);
    args[index + 1] = value;
  }
  report("guide", { path });
  return { config, args };
}

async function newProfile() {
  let credential;
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === appOrigin) {
      const observed = url.searchParams.get("__clerk_db_jwt");
      if (observed) credential = observed;
      return route.continue();
    }
    offlineAttempts.push(url.origin);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  return {
    context,
    page,
    get credential() {
      return credential;
    },
  };
}

async function loadClerk(page) {
  await page.goto(appOrigin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.Clerk));
  await page.evaluate(async (proxyUrl) => {
    await window.Clerk.load({ proxyUrl, standardBrowser: true, telemetry: { disabled: true } });
  }, proxyPath);
  await page.waitForFunction(() => window.Clerk.loaded === true);
  return browserIdentity(page);
}

function browserIdentity(page) {
  return page.evaluate(() => ({ userId: window.Clerk.user?.id ?? null, sessionId: window.Clerk.session?.id ?? null }));
}

async function passwordSignIn(profile, user) {
  const input = { identifier: user.email_addresses[0], password: user.password };
  return profile.page.evaluate(async ({ identifier, password }) => {
    const clerk = window.Clerk;
    const attempt = await clerk.client.signIn.create({ identifier, password, strategy: "password" });
    if (attempt.status !== "complete" || !attempt.createdSessionId)
      throw new Error("Password sign-in did not complete");
    await clerk.setActive({ session: attempt.createdSessionId });
    return { userId: clerk.user?.id, sessionId: clerk.session?.id };
  }, input);
}

function freshJwt(profile) {
  return profile.page.evaluate(async () => window.Clerk.session.getToken({ skipCache: true }));
}

function decodeJwt(jwt) {
  assert.ok(typeof jwt === "string" && jwt.split(".").length === 3);
  const [header, payload] = jwt
    .split(".")
    .slice(0, 2)
    .map((segment) => JSON.parse(Buffer.from(segment, "base64url").toString()));
  for (const user of Object.values(users)) {
    assert.equal(JSON.stringify(payload).includes(user.password), false);
    assert.equal(JSON.stringify(payload).includes(user.private_metadata.fixture), false);
  }
  assert.equal(payload.exp - payload.iat, 60);
  assert.match(header.kid, /^emulate-clerk-browser-/);
  return { header, payload };
}

async function protectedNavigation(profile, path, status, identity) {
  const page = await profile.context.newPage();
  try {
    const response = await page.goto(`${appOrigin}${path}`);
    assert.equal(response.status(), status);
    if (status === 200) {
      assert.equal(await page.locator("h1").textContent(), "Protected Clerk page");
      assert.deepEqual(JSON.parse(await page.locator("#identity").textContent()), identity);
    }
  } finally {
    await page.close();
  }
}

function authorizedIdentity(identity, role) {
  assert.equal(identity.userId, users[role].clerk_id);
  assert.match(identity.sessionId, /^sess_/);
  return { ...identity, orgId: organizationId, orgRole: `org:${role}`, issuer, party: appOrigin };
}

async function proxyRenewal(credential, sessionId, expectedStatus) {
  assert.ok(credential);
  const query = new URLSearchParams({ __clerk_db_jwt: credential });
  const response = await appRequest(`${proxyPath}/v1/client/sessions/${sessionId}/tokens?${query}`, {
    method: "POST",
    headers: { origin: appOrigin },
  });
  assert.equal(response.status, expectedStatus);
}

function replayJwt(jwt, path = "/protected") {
  return appRequest(path, { headers: { authorization: `Bearer ${jwt}` } });
}

async function verifySessions(a) {
  await measure("fresh admin browser bootstraps signed out", async () =>
    assert.deepEqual(await loadClerk(a.page), anonymous),
  );
  const admin = await measure("real ClerkJS signs in seeded admin with password", async () =>
    authorizedIdentity(await passwordSignIn(a, users.admin), "admin"),
  );
  await measure("admin reload preserves user and session then reaches protected and admin pages", async () => {
    const withReload = await loadClerk(a.page);
    assert.deepEqual(authorizedIdentity(withReload, "admin"), admin);
    await protectedNavigation(a, "/protected", 200, admin);
    await protectedNavigation(a, "/admin", 200, admin);
  });

  const b = await newProfile();
  await measure("isolated member browser has no admin identity or protected access", async () => {
    assert.deepEqual(await loadClerk(b.page), anonymous);
    await protectedNavigation(b, "/protected", 401);
  });
  const member = await measure("real ClerkJS signs in seeded member and app enforces member role", async () => {
    const identity = authorizedIdentity(await passwordSignIn(b, users.member), "member");
    assert.notEqual(identity.sessionId, admin.sessionId);
    await protectedNavigation(b, "/protected", 200, identity);
    await protectedNavigation(b, "/admin", 403);
    return identity;
  });

  const beforeLogout = await measure("admin browser forces fresh renewal through ClerkJS", () => freshJwt(a));
  const savedAdminCredential = a.credential;
  const adminJwt = decodeJwt(beforeLogout);
  await measure(
    "app rejects tampered token and otherwise valid token with mismatched issuer or authorized party",
    async () => {
      assert.equal(adminJwt.payload.sub, admin.userId);
      assert.equal(adminJwt.payload.sid, admin.sessionId);
      assert.equal(adminJwt.payload.iss, issuer);
      assert.equal(adminJwt.payload.azp, appOrigin);
      assert.equal((await replayJwt(beforeLogout)).status, 200);
      assert.equal((await replayJwt(beforeLogout, "/protected/wrong-issuer")).status, 401);
      assert.equal((await replayJwt(beforeLogout, "/protected/wrong-party")).status, 401);
      const [jwtHeader, payload, signature] = beforeLogout.split(".");
      const tampered = `${jwtHeader}.${payload}.${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
      assert.equal((await replayJwt(tampered)).status, 401);
    },
  );
  await measure("member client cannot renew admin session with its session ID", async () => {
    await proxyRenewal(b.credential, admin.sessionId, 404);
  });
  await measure("ClerkJS logout ends admin session and blocks old client renewal and protected access", async () => {
    await a.page.evaluate(async (redirectUrl) => window.Clerk.signOut({ redirectUrl }), appOrigin);
    assert.deepEqual(await loadClerk(a.page), anonymous);
    await proxyRenewal(savedAdminCredential, admin.sessionId, 401);
    await protectedNavigation(a, "/protected", 401);
    assert.equal((await replayJwt(beforeLogout)).status, 200);
  });
  await measure("admin can sign in after logout with a new session", async () => {
    const replacement = authorizedIdentity(await passwordSignIn(a, users.admin), "admin");
    assert.notEqual(replacement.sessionId, admin.sessionId);
    await protectedNavigation(a, "/protected", 200, replacement);
  });
  await measure("member stays signed in and still renews after admin logout", async () => {
    assert.equal(decodeJwt(await freshJwt(b)).payload.sid, member.sessionId);
    await protectedNavigation(b, "/protected", 200, member);
  });

  const oldTestCredentials = await verifyTestingAndTickets();
  await measure("copied pre-logout JWT is denied after its expiry", async () => {
    await delay(Math.max(0, adminJwt.payload.exp * 1000 - Date.now() + 6100));
    assert.equal((await replayJwt(beforeLogout)).status, 401);
  });

  await measure("same-origin cold restart invalidates still valid member JWT and old client state", async () => {
    const savedMemberToken = await freshJwt(b);
    const savedMemberJwt = decodeJwt(savedMemberToken);
    const savedMemberCredential = b.credential;
    assert.equal((await replayJwt(savedMemberToken)).status, 200);
    await proxyRenewal(savedMemberCredential, member.sessionId, 200);
    await stopChild(emulator);
    await startEmulator();
    assert.ok(savedMemberJwt.payload.exp * 1000 > Date.now());
    assert.equal((await replayJwt(savedMemberToken)).status, 401);
    await proxyRenewal(savedMemberCredential, member.sessionId, 401);
    assert.deepEqual(await loadClerk(b.page), anonymous);
    await protectedNavigation(b, "/protected", 401);
    const oldTestingToken = await testingClient(oldTestCredentials.testingToken);
    assert.equal(oldTestingToken.status, 200);
    assert.equal(oldTestingToken.headers["clerk-testing-token"], undefined);
    await assert.rejects(() => redeemTicket(b, oldTestCredentials.pendingTicket));
    const replacement = authorizedIdentity(await passwordSignIn(b, users.member), "member");
    assert.notEqual(replacement.sessionId, member.sessionId);
    assert.notEqual(decodeJwt(await freshJwt(b)).header.kid, savedMemberJwt.header.kid);
    await protectedNavigation(b, "/protected", 200, replacement);
  });
}

function testingClient(token) {
  const query = new URLSearchParams({ __clerk_testing_token: token });
  return appRequest(`${proxyPath}/v1/client?${query}`);
}

function redeemTicket(profile, ticket) {
  return profile.page.evaluate(async (value) => {
    const clerk = window.Clerk;
    const attempt = await clerk.client.signIn.create({ strategy: "ticket", ticket: value });
    if (attempt.status !== "complete" || !attempt.createdSessionId) throw new Error("Ticket sign-in did not complete");
    await clerk.setActive({ session: attempt.createdSessionId });
    return { userId: clerk.user?.id, sessionId: clerk.session?.id };
  }, ticket);
}

async function verifyTestingAndTickets() {
  const backend = createClerkClient({ apiUrl: issuer, secretKey, publishableKey, telemetry: { disabled: true } });
  const memberTicket = (seconds = 120) =>
    backend.signInTokens.createSignInToken({ userId: users.member.clerk_id, expiresInSeconds: seconds });
  const frontendApiUrl = `${new URL(appOrigin).host}${proxyPath}`;
  await measure(
    "new Backend issuance routes reject missing, wrong and live credentials under CLI fallback",
    async () => {
      for (const path of ["/v1/testing_tokens", "/v1/sign_in_tokens", "/v1/sign_in_tokens/sit_unknown/revoke"]) {
        for (const key of [undefined, "sk_test_invalid_fixture", "sk_live_unusable_fixture"]) {
          const response = await fetch(`${issuer}${path}`, {
            method: "POST",
            headers: key ? { authorization: `Bearer ${key}` } : {},
            redirect: "error",
          });
          assert.equal(response.status, 401);
        }
      }
    },
  );
  const helper = await newProfile();
  const testingToken = await measure(
    "official Clerk test setup issues a local token and helper propagates it without authentication",
    async () => {
      delete process.env.CLERK_TESTING_TOKEN;
      await clerkSetup({ apiUrl: issuer, publishableKey, secretKey, frontendApiUrl, dotenv: false });
      const token = process.env.CLERK_TESTING_TOKEN;
      assert.match(token, /^ctt_/);
      const before = frontendLog.length;
      await setupClerkTestingToken({ context: helper.context, options: { frontendApiUrl } });
      assert.deepEqual(await loadClerk(helper.page), anonymous);
      assert.ok(
        frontendLog
          .slice(before)
          .some((entry) => entry.query.includes("__clerk_testing_token") && entry.testingTokenAccepted),
      );
      await protectedNavigation(helper, "/protected", 401);
      const valid = await testingClient(token);
      const invalid = await testingClient("fixture-fake-testing-token");
      assert.equal(valid.status, 200);
      assert.equal(invalid.status, 200);
      assert.equal(valid.headers["clerk-testing-token"], "accepted");
      assert.equal(invalid.headers["clerk-testing-token"], undefined);
      for (const reply of [valid, invalid]) assert.deepEqual(JSON.parse(reply.body).response.sessions, []);
      await assert.rejects(() => redeemTicket(helper, token));
      return token;
    },
  );

  const ticket = await measure(
    "Backend SDK issues a one-use ticket and official Playwright helper signs in the intended member",
    async () => {
      const ticket = await memberTicket();
      assert.match(ticket.id, /^sit_/);
      assert.match(ticket.token, /^st_/);
      assert.equal(ticket.userId, users.member.clerk_id);
      assert.equal(new URL(ticket.url).origin, appOrigin);
      await clerkTesting.signIn({
        page: helper.page,
        signInParams: { strategy: "ticket", ticket: ticket.token },
        setupClerkTestingTokenOptions: { frontendApiUrl },
      });
      const identity = authorizedIdentity(await browserIdentity(helper.page), "member");
      await protectedNavigation(helper, "/protected", 200, identity);
      return ticket;
    },
  );

  await measure("used, expired, revoked and unknown tickets fail through ClerkJS", async () => {
    const expired = await memberTicket(1);
    const revoked = await memberTicket();
    assert.equal((await backend.signInTokens.revokeSignInToken(revoked.id)).status, "revoked");
    await assert.rejects(() => backend.signInTokens.createSignInToken({ userId: "user_unknown_fixture" }));
    const fresh = await newProfile();
    await loadClerk(fresh.page);
    await delay(1100);
    for (const value of [ticket.token, expired.token, revoked.token, "fixture-unknown-ticket"]) {
      await assert.rejects(() => redeemTicket(fresh, value));
      assert.deepEqual(await browserIdentity(fresh.page), anonymous);
    }
    await protectedNavigation(fresh, "/protected", 401);
    await fresh.context.close();
  });

  await measure("concurrent ticket redemption across two browser profiles signs in exactly one", async () => {
    const ticket = await memberTicket();
    const profiles = await Promise.all([newProfile(), newProfile()]);
    await Promise.all(profiles.map(({ page }) => loadClerk(page)));
    const attempts = await Promise.allSettled(profiles.map((profile) => redeemTicket(profile, ticket.token)));
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    for (const [index, profile] of profiles.entries()) {
      const attempt = attempts[index];
      if (attempt.status === "fulfilled") {
        await protectedNavigation(profile, "/protected", 200, authorizedIdentity(attempt.value, "member"));
      } else {
        assert.deepEqual(await browserIdentity(profile.page), anonymous);
        await protectedNavigation(profile, "/protected", 401);
      }
      await profile.context.close();
    }
  });
  await helper.context.close();
  return { testingToken, pendingTicket: (await memberTicket()).token };
}

const anonymous = { userId: null, sessionId: null };
let ca;
try {
  report("runtime", {
    node: process.version,
    cli,
    installedCli,
    cliVersion: execFileSync(cli, [...cliArgs, "--version"], { encoding: "utf8" }).trim(),
    appOrigin,
    issuer,
    mode: mode?.slice(2) ?? "candidate",
  });
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      tlsKey,
      "-out",
      caPath,
    ],
    { stdio: "ignore" },
  );
  ca = await readFile(caPath);
  const guide = guideSmoke ? await readBrowserGuide() : undefined;
  await writeFile(seed, JSON.stringify(guide?.config ?? fixtureSeed(appOrigin)), { mode: 0o600 });
  await startEmulator(guide?.args);
  app = startChild(process.execPath, [join(fixture, "app.mjs"), appOrigin, issuer, tlsKey, caPath], true);
  await waitForHttp(() => appRequest("/"), app);

  if (!guideSmoke) {
    await measure("legacy Backend API reads both configured synthetic users", async () => {
      for (const user of Object.values(users)) {
        const response = await fetch(`${issuer}/v1/users/${user.clerk_id}`, {
          headers: { authorization: `Bearer ${secretKey}` },
          redirect: "error",
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).id, user.clerk_id);
      }
    });
    await measure("fixture serves pinned ClerkJS and rejects disallowed proxy traffic", async () => {
      assert.equal((await appRequest("/assets/clerk.browser.js")).status, 200);
      for (const [path, options] of [
        ["/v1/users"],
        ["/v1/jwks"],
        ["/v1/testing_tokens", { method: "POST" }],
        ["/v1/client", { method: "PUT" }],
        ["/v1/client?destination=x"],
        ["/v1/client?__clerk_db_jwt=a&__clerk_db_jwt=b"],
        ["/v1/client?debug=skip_cache"],
        ["/v1/client", { headers: { origin: "https://different.invalid" } }],
        ["/v1/client", { headers: { authorization: `Bearer ${secretKey}` } }],
        ["/%2e%2e/v1/jwks"],
        ["/../v1/jwks"],
      ])
        assert.equal((await appRequest(`${proxyPath}${path}`, options)).status, 403);
      assert.equal((await appRequest("//different.invalid/v1/client")).status, 403);
    });
  }
  browser = await chromium.launch({
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      `--host-resolver-rules=MAP ${frontendHostname} 127.0.0.1`,
    ],
  });
  report("browser", { version: browser.version() });
  const a = await newProfile();
  if (guide) {
    await measure(
      "installed guide signs in a seeded ClerkJS user and the Backend SDK grants protected HTTP 200",
      async () => {
        await loadClerk(a.page);
        const [user] = guide.config.clerk.users;
        const [organization] = guide.config.clerk.organizations;
        const identity = await passwordSignIn(a, user);
        assert.equal(identity.userId, user.clerk_id);
        await protectedNavigation(a, "/protected", 200, {
          ...identity,
          orgId: organization.clerk_id,
          orgRole: organization.members[0].role,
          issuer,
          party: appOrigin,
        });
        assert.deepEqual(offlineAttempts, []);
      },
    );
  } else {
    await measure("anonymous browser access to protected app denied", async () => {
      assert.equal((await a.page.goto(`${appOrigin}/protected`)).status(), 401);
    });
    if (mode === "--baseline") {
      currentStage = "ClerkJS bootstrap on unchanged package";
      await assert.rejects(() => loadClerk(a.page));
      assert.ok(frontendLog.some(({ path, status }) => path === "/v1/dev_browser" && status === 404));
      pass("unchanged package stops at first actual ClerkJS protocol request", {
        path: "/v1/dev_browser",
        status: 404,
      });
      await measure("unchanged package lacks other planned frontend and issuance paths", async () => {
        for (const [method, path] of [
          ["GET", "/v1/client"],
          ["POST", "/v1/client/sign_ins"],
          ["POST", "/v1/testing_tokens"],
          ["POST", "/v1/sign_in_tokens"],
        ]) {
          assert.equal(
            (await fetch(`${issuer}${path}`, { method, headers: { authorization: `Bearer ${secretKey}` } })).status,
            404,
          );
          report("baseline_missing", { method, path, status: 404 });
        }
      });
    } else {
      await verifySessions(a);
    }
    await measure("browser made zero requests or handshakes to unapproved origins", async () =>
      assert.deepEqual(offlineAttempts, []),
    );
  }
} catch (error) {
  // Never serialize exceptions carrying request URLs, cookies, or token values.
  report("failed", { stage: currentStage, name: error.name, code: error.code ?? error.status });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await Promise.all([stopChild(app), stopChild(emulator)]);
  await rm(scratch, { force: true, recursive: true });
}
