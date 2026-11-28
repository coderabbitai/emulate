import { createClerkClient } from "@clerk/backend";
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { loopbackOrigin, organizationId, proxyPath, publishableKey, report, secretKey, users } from "./fixture.mjs";

const [appOrigin, issuer, tlsKey, tlsCert] = process.argv.slice(2);
const appUrl = loopbackOrigin(appOrigin, "https:");
loopbackOrigin(issuer);
const require = createRequire(import.meta.url);
const assets = dirname(require.resolve("@clerk/clerk-js"));
const clerk = createClerkClient({
  secretKey,
  publishableKey,
  apiUrl: issuer,
  proxyUrl: `${appOrigin}${proxyPath}`,
  telemetry: { disabled: true },
});
const browserKeyPrefix = "emulate-clerk-browser-";

const fapiMethods = [
  ["POST", /^\/v1\/(?:dev_browser|client\/sign_ins)$/],
  ["GET", /^\/v1\/client$/],
  ["POST", /^\/v1\/environment$/, "PATCH"],
  ["POST", /^\/v1\/client\/sessions\/sess_[\w-]+\/(?:touch|tokens)$/],
  ["POST", /^\/v1\/client\/sessions$/, "DELETE"],
];
const browserRequestHeaders = ["accept", "content-type", "cookie", "origin"];
const fapiQuery = new Set([
  "__clerk_api_version",
  "_clerk_js_version",
  "__clerk_db_jwt",
  "__clerk_testing_token",
  "_method",
  "debug",
]);

function reply(response, status, contentType, body) {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

async function proxy(req, res, route) {
  const path = route.pathname.slice(proxyPath.length);
  const override = route.searchParams.get("_method") ?? undefined;
  if (
    !fapiMethods.some(
      ([method, pattern, expectedOverride]) =>
        method === req.method && pattern.test(path) && override === expectedOverride,
    ) ||
    [...route.searchParams.keys()].some((key) => !fapiQuery.has(key) || route.searchParams.getAll(key).length !== 1) ||
    (route.searchParams.has("debug") &&
      !(path.endsWith("/tokens") && route.searchParams.get("debug") === "skip_cache")) ||
    (req.headers.origin && req.headers.origin !== appOrigin) ||
    req.headers.authorization
  ) {
    reply(res, 403, "text/plain", "Frontend request denied");
    return;
  }
  const headers = new Headers();
  for (const key of browserRequestHeaders) {
    if (req.headers[key]) headers.set(key, req.headers[key]);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) {
      reply(res, 413, "text/plain", "Frontend request too large");
      return;
    }
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const upstream = await fetch(`${issuer}${path}${route.search}`, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });
  const responseBody = await upstream.text();
  report("frontend", {
    method: req.method,
    path: path.replace(/\/(?:sia|sess)_[\w-]+/g, "/:id"),
    query: [...route.searchParams.keys()].sort(),
    ...(override && { override }),
    apiVersion: route.searchParams.get("__clerk_api_version"),
    origin: req.headers.origin ? "app" : "absent",
    credentials: [req.headers.cookie && "cookie", route.searchParams.has("__clerk_db_jwt") && "dev_browser"].filter(
      Boolean,
    ),
    form:
      req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") && body
        ? [...new URLSearchParams(body.toString()).keys()].sort()
        : [],
    status: upstream.status,
    setCookie: upstream.headers.has("set-cookie"),
    devBrowserHeader: upstream.headers.has("clerk-db-jwt"),
    testingTokenAccepted: upstream.headers.get("clerk-testing-token") === "accepted",
    redirect: Boolean(upstream.headers.get("location")),
  });
  if (upstream.headers.has("location") || (upstream.status >= 300 && upstream.status < 400)) {
    reply(res, 502, "text/plain", "Unexpected Frontend API redirect");
    return;
  }
  for (const user of Object.values(users)) {
    if (responseBody.includes(user.password) || responseBody.includes(user.private_metadata.fixture)) {
      reply(res, 502, "text/plain", "Synthetic seed sentinel appeared in a browser response");
      return;
    }
  }
  const responseHeaders = {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  };
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) responseHeaders["set-cookie"] = cookies;
  for (const header of ["clerk-db-jwt", "clerk-testing-token"]) {
    if (upstream.headers.has(header)) responseHeaders[header] = upstream.headers.get(header);
  }
  res.writeHead(upstream.status, responseHeaders);
  res.end(responseBody);
}

async function protectedPage(req, res, route) {
  const { keys } = await fetch(`${issuer}/v1/jwks`, { redirect: "error" }).then((response) => response.json());
  const key = keys.find(({ kid }) => kid?.startsWith(browserKeyPrefix));
  if (!key) {
    reply(res, 401, "text/plain", "Browser verification key is unavailable");
    return;
  }
  const jwtKey = createPublicKey({ key, format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
  // A verification control sends the otherwise valid JWT to a route with a different expectation.
  const expectedIssuer = route.pathname === "/protected/wrong-issuer" ? `${issuer}/wrong-issuer` : issuer;
  const expectedParty = route.pathname === "/protected/wrong-party" ? `${appOrigin}/wrong-party` : appOrigin;
  const auth = await clerk.authenticateRequest(new Request(route, { headers: req.headers }), {
    jwtKey,
    authorizedParties: [expectedParty],
  });
  if (auth.status !== "signed-in") {
    if (auth.headers.has("location")) {
      const target = new URL(auth.headers.get("location"), appOrigin);
      report("handshake", { origin: target.origin, path: target.pathname });
    }
    reply(res, 401, "text/plain", "Clerk session required");
    return;
  }
  const { userId, sessionId, orgId, orgRole, sessionClaims, has } = auth.toAuth();
  if (
    !userId ||
    !sessionId ||
    sessionClaims.iss !== expectedIssuer ||
    sessionClaims.azp !== expectedParty ||
    orgId !== organizationId ||
    !["org:admin", "org:member"].includes(orgRole)
  ) {
    reply(res, 401, "text/plain", "Unexpected session claims");
    return;
  }
  if (route.pathname === "/admin" && !has({ role: "org:admin" })) {
    reply(res, 403, "text/plain", "Administrator role required");
    return;
  }
  const escapedIdentity = JSON.stringify({
    userId,
    sessionId,
    orgId,
    orgRole,
    issuer: sessionClaims.iss,
    party: sessionClaims.azp,
  }).replaceAll("<", "\\u003c");
  reply(
    res,
    200,
    "text/html",
    `<!doctype html><title>Protected Clerk page</title><h1>Protected Clerk page</h1><script type="application/json" id="identity">${escapedIdentity}</script>`,
  );
}

const tls = { key: await readFile(tlsKey), cert: await readFile(tlsCert) };
const app = createServer(tls, async (req, res) => {
  try {
    const target = req.url ?? "";
    if (
      req.headers.host !== appUrl.host ||
      !target.startsWith("/") ||
      target.startsWith("//") ||
      /%(?:2e|2f|5c)|\\|(?:^|\/)\.{1,2}(?:\/|\?|$)/i.test(target.split("?")[0])
    ) {
      reply(res, 403, "text/plain", "Invalid fixture request target");
      return;
    }
    const route = new URL(target, appOrigin);
    if (route.pathname.startsWith(`${proxyPath}/`)) {
      await proxy(req, res, route);
    } else if (req.method === "GET" && /^\/assets\/[\w.-]+\.js$/.test(route.pathname)) {
      const source = await readFile(join(assets, route.pathname.slice("/assets/".length)));
      report("asset", { path: route.pathname });
      reply(res, 200, "text/javascript", source);
    } else if (
      req.method === "GET" &&
      ["/protected", "/protected/wrong-issuer", "/protected/wrong-party", "/admin"].includes(route.pathname)
    ) {
      await protectedPage(req, res, route);
    } else if (req.method === "GET" && route.pathname === "/") {
      reply(
        res,
        200,
        "text/html",
        `<!doctype html><title>Local Clerk browser fixture</title><script src="/assets/clerk.browser.js" data-clerk-publishable-key="${publishableKey}" data-clerk-proxy-url="${proxyPath}"></script><h1>Local Clerk browser fixture</h1>`,
      );
    } else {
      reply(res, 404, "text/plain", "Fixture route not found");
    }
  } catch (error) {
    report("app_error", { name: error.name, code: error.code });
    if (!res.headersSent) reply(res, 500, "text/plain", "Fixture request failed");
    else res.destroy();
  }
});
app.listen(Number(appUrl.port), appUrl.hostname, () => report("app_started", { origin: appOrigin }));
