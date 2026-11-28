import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { browserCredential, eligibleBrowserUser, getClerkBrowser, type SignInTicket } from "../browser.js";
import { generateClerkId } from "../helpers.js";
import { clerkError, hasConfiguredTestKey, readJsonBody } from "../route-helpers.js";
import { getClerkStore } from "../store.js";

const TESTING_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TICKET_TTL_SECONDS = 30 * 24 * 60 * 60;

function ticketResource(ticket: SignInTicket, origin: string) {
  const url = new URL("/sign-in", origin);
  url.searchParams.set("__clerk_ticket", ticket.token);
  return {
    object: "sign_in_token",
    id: ticket.id,
    user_id: ticket.userId,
    token: ticket.token,
    status: ticket.status,
    url: url.href,
    created_at: ticket.createdAt,
    updated_at: ticket.updatedAt,
  };
}

export function testingRoutes({ app, store, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  function withTestKey(
    handler: (
      c: Context<AppEnv>,
      browser: NonNullable<ReturnType<typeof getClerkBrowser>>,
    ) => Response | Promise<Response>,
  ) {
    return (c: Context<AppEnv>) => {
      // The pinned Backend SDK only deserializes an exact application/json Content-Type.
      c.header("Content-Type", "application/json");
      c.header("Cache-Control", "no-store");
      const browser = getClerkBrowser(store);
      if (!browser) return clerkError(c, 404, "resource_not_found", "Clerk browser mode is disabled");
      if (!hasConfiguredTestKey(c, tokenMap)) {
        return clerkError(c, 401, "unauthorized", "A configured Clerk test secret key is required");
      }
      return handler(c, browser);
    };
  }

  app.post(
    "/v1/testing_tokens",
    withTestKey((c, browser) => {
      const now = Date.now();
      for (const [token, expiresAt] of browser.testingTokens) {
        if (expiresAt <= now) browser.testingTokens.delete(token);
      }
      const token = browserCredential("ctt_");
      const expiresAt = now + TESTING_TOKEN_TTL_MS;
      browser.testingTokens.set(token, expiresAt);
      return c.json({ object: "testing_token", token, expires_at: expiresAt });
    }),
  );

  app.post(
    "/v1/sign_in_tokens",
    withTestKey(async (c, browser) => {
      const body = await readJsonBody(c);
      if (getClerkBrowser(store) !== browser) {
        return clerkError(c, 404, "resource_not_found", "Clerk browser mode is disabled");
      }
      if (typeof body.user_id !== "string" || !body.user_id) {
        return clerkError(c, 422, "form_param_missing", "user_id is required");
      }
      if (body.org_id !== undefined || body.second_factor_verification !== undefined) {
        return clerkError(
          c,
          422,
          "form_param_not_supported",
          "Organization and second-factor overrides are unsupported",
        );
      }
      const ttl = body.expires_in_seconds === undefined ? MAX_TICKET_TTL_SECONDS : body.expires_in_seconds;
      if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TICKET_TTL_SECONDS) {
        return clerkError(c, 422, "form_param_invalid", "expires_in_seconds must be an integer from 1 to 2592000");
      }
      const user = cs.users.findOneBy("clerk_id", body.user_id);
      if (!eligibleBrowserUser(user)) {
        return clerkError(c, 404, "resource_not_found", "Synthetic user is not available");
      }

      const now = Date.now();
      const ticket: SignInTicket = {
        id: generateClerkId("sit_"),
        token: browserCredential("st_"),
        userId: user.clerk_id,
        status: "pending",
        expiresAt: now + ttl * 1000,
        createdAt: now,
        updatedAt: now,
      };
      browser.signInTickets.set(ticket.token, ticket);
      return c.json(ticketResource(ticket, browser.config.origin));
    }),
  );

  app.post(
    "/v1/sign_in_tokens/:ticketId/revoke",
    withTestKey((c, browser) => {
      const id = c.req.param("ticketId");
      const ticket = Array.from(browser.signInTickets.values()).find((candidate) => candidate.id === id);
      if (!ticket) return clerkError(c, 404, "resource_not_found", "Sign-in ticket not found");
      if (ticket.status === "accepted" || ticket.expiresAt <= Date.now()) {
        return clerkError(c, 422, "ticket_inactive", "Sign-in ticket is not active");
      }
      ticket.status = "revoked";
      ticket.updatedAt = Date.now();
      return c.json(ticketResource(ticket, browser.config.origin));
    }),
  );
}
