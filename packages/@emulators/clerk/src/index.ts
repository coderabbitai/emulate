import type { Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { generateClerkId, nowUnix, createDefaultUser, createDefaultEmailAddress } from "./helpers.js";
import { oauthRoutes } from "./routes/oauth.js";
import { userRoutes } from "./routes/users.js";
import { emailAddressRoutes } from "./routes/email-addresses.js";
import { organizationRoutes } from "./routes/organizations.js";
import { membershipRoutes } from "./routes/memberships.js";
import { invitationRoutes } from "./routes/invitations.js";
import { sessionRoutes } from "./routes/sessions.js";
import { getClerkStore } from "./store.js";
import { configureClerkBrowser, getClerkBrowser } from "./browser.js";
import { clerkError, hasConfiguredTestKey } from "./route-helpers.js";
import { frontendRoutes } from "./routes/frontend.js";
import { testingRoutes } from "./routes/testing.js";

export { getClerkStore, type ClerkStore } from "./store.js";
export * from "./entities.js";

const DEFAULT_SEED_USER_KEY = "clerk.seed.defaultUserId";
const BROWSER_AUTHORITY_PATH = /^\/v1\/(?:users|email_addresses|organizations|sessions)(?:\/|$)/;

export interface ClerkSeedConfig {
  browser_app_origin?: string;
  users?: Array<{
    clerk_id?: string;
    email_addresses: string[];
    first_name?: string;
    last_name?: string;
    username?: string;
    password?: string;
    external_id?: string;
    public_metadata?: Record<string, unknown>;
    private_metadata?: Record<string, unknown>;
    unsafe_metadata?: Record<string, unknown>;
  }>;
  organizations?: Array<{
    clerk_id?: string;
    name: string;
    slug?: string;
    max_allowed_memberships?: number;
    public_metadata?: Record<string, unknown>;
    private_metadata?: Record<string, unknown>;
    members?: Array<{
      email: string;
      role: string;
    }>;
  }>;
  oauth_applications?: Array<{
    client_id: string;
    client_secret?: string;
    name: string;
    redirect_uris: string[];
    scopes?: string[];
    public?: boolean;
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const cs = getClerkStore(store);

  if (cs.users.all().length > 0) return;

  const userInput = createDefaultUser();
  const user = cs.users.insert(userInput);
  store.setData(DEFAULT_SEED_USER_KEY, user.clerk_id);

  const email = cs.emailAddresses.insert(createDefaultEmailAddress(user.clerk_id, "test@example.com", true));

  cs.users.update(user.id, { primary_email_address_id: email.email_id });

  const now = nowUnix();
  cs.oauthApps.insert({
    app_id: generateClerkId("oauth_app_"),
    name: "Emulate App",
    client_id: "clerk_emulate_client",
    client_secret: "clerk_emulate_secret",
    is_public: false,
    scopes: ["openid", "profile", "email"],
    redirect_uris: ["http://localhost:3000/api/auth/callback/clerk"],
    created_at_unix: now,
    updated_at_unix: now,
  });
}

export function seedFromConfig(store: Store, baseUrl: string, config: ClerkSeedConfig): void {
  const browserOrigin = config.browser_app_origin;
  const browserEnabled = browserOrigin !== undefined;
  if (browserEnabled) configureClerkBrowser(store, baseUrl, browserOrigin);
  const cs = getClerkStore(store);
  const now = nowUnix();

  if (config.users) {
    for (const userCfg of config.users) {
      const addresses = browserEnabled ? [...new Set(userCfg.email_addresses)] : userCfg.email_addresses;
      const firstEmail = addresses?.[0];
      const existingEmail = firstEmail ? cs.emailAddresses.findOneBy("email_address", firstEmail) : undefined;
      const defaultUserId = browserEnabled ? store.getData<string>(DEFAULT_SEED_USER_KEY) : undefined;
      const defaultUser =
        existingEmail && existingEmail.user_id === defaultUserId
          ? cs.users.findOneBy("clerk_id", defaultUserId)
          : undefined;
      if (!browserEnabled && existingEmail) continue;

      const clerkId = userCfg.clerk_id ?? defaultUser?.clerk_id ?? generateClerkId("user_");
      const existingUser = browserEnabled ? cs.users.findOneBy("clerk_id", clerkId) : undefined;
      const existingPrimaryOwner = existingUser && existingEmail?.user_id === clerkId;
      const allowedOwnerId = defaultUser?.clerk_id ?? (existingPrimaryOwner ? clerkId : undefined);
      if (
        browserEnabled &&
        addresses.some((address) =>
          cs.emailAddresses.findBy("email_address", address).some((email) => email.user_id !== allowedOwnerId),
        )
      ) {
        throw new Error("Clerk browser seed email address is already owned by another user.");
      }

      if (existingUser && existingUser.id !== defaultUser?.id) {
        if (existingPrimaryOwner) continue;
        throw new Error("Clerk browser seed requires unique user IDs.");
      }
      const attributes = {
        clerk_id: clerkId,
        browser_seeded: true,
        username: userCfg.username ?? null,
        first_name: userCfg.first_name ?? "Test",
        last_name: userCfg.last_name ?? "User",
        image_url: null,
        profile_image_url: null,
        external_id: userCfg.external_id ?? null,
        primary_email_address_id: null,
        primary_phone_number_id: null,
        password_enabled: typeof userCfg.password === "string" && userCfg.password.length > 0,
        password_hash: userCfg.password ?? null,
        totp_enabled: false,
        backup_code_enabled: false,
        two_factor_enabled: false,
        banned: false,
        locked: false,
        public_metadata: userCfg.public_metadata ?? {},
        private_metadata: userCfg.private_metadata ?? {},
        unsafe_metadata: userCfg.unsafe_metadata ?? {},
        last_active_at: null,
        last_sign_in_at: null,
        created_at_unix: now,
        updated_at_unix: now,
      };
      const user = defaultUser ? cs.users.update(defaultUser.id, attributes)! : cs.users.insert(attributes);
      if (defaultUser) {
        for (const email of cs.emailAddresses.findBy("user_id", defaultUser.clerk_id)) {
          cs.emailAddresses.update(email.id, { user_id: clerkId, is_primary: false });
        }
        if (defaultUser.clerk_id !== clerkId) {
          for (const membership of cs.memberships.findBy("user_id", defaultUser.clerk_id)) {
            cs.memberships.update(membership.id, { user_id: clerkId });
          }
          for (const session of cs.sessions.findBy("user_id", defaultUser.clerk_id)) {
            cs.sessions.update(session.id, { user_id: clerkId });
          }
        }
        store.setData(DEFAULT_SEED_USER_KEY, null);
      }

      let primaryEmailId: string | null = null;
      if (addresses) {
        for (let i = 0; i < addresses.length; i++) {
          const address = addresses[i];
          const existing = defaultUser ? cs.emailAddresses.findOneBy("email_address", address) : undefined;
          const email = existing
            ? cs.emailAddresses.update(existing.id, { is_primary: i === 0 })!
            : cs.emailAddresses.insert(createDefaultEmailAddress(clerkId, address, i === 0));
          if (i === 0) primaryEmailId = email.email_id;
        }
      }

      if (primaryEmailId) {
        cs.users.update(user.id, { primary_email_address_id: primaryEmailId });
      }
    }
  }

  if (config.organizations) {
    for (const orgCfg of config.organizations) {
      const existingSlug =
        orgCfg.slug ??
        orgCfg.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      const existing = cs.organizations.findOneBy("slug", existingSlug);
      if (existing) continue;

      const orgId = orgCfg.clerk_id ?? generateClerkId("org_");
      const org = cs.organizations.insert({
        clerk_id: orgId,
        name: orgCfg.name,
        slug: existingSlug,
        image_url: null,
        has_logo: false,
        members_count: 0,
        pending_invitations_count: 0,
        public_metadata: orgCfg.public_metadata ?? {},
        private_metadata: orgCfg.private_metadata ?? {},
        max_allowed_memberships: orgCfg.max_allowed_memberships ?? null,
        admin_delete_enabled: true,
        created_at_unix: now,
        updated_at_unix: now,
      });

      if (orgCfg.members) {
        let memberCount = 0;
        for (const memberCfg of orgCfg.members) {
          const emailEntry = cs.emailAddresses.findOneBy("email_address", memberCfg.email);
          if (!emailEntry) continue;

          const user = cs.users.findOneBy("clerk_id", emailEntry.user_id);
          if (!user) continue;

          const existingMembership = cs.memberships.findBy("org_id", orgId).find((m) => m.user_id === user.clerk_id);
          if (existingMembership) continue;

          const role = memberCfg.role.startsWith("org:") ? memberCfg.role : `org:${memberCfg.role}`;
          cs.memberships.insert({
            membership_id: generateClerkId("orgmem_"),
            org_id: orgId,
            user_id: user.clerk_id,
            role,
            permissions:
              role === "org:admin"
                ? [
                    "org:sys_profile:manage",
                    "org:sys_profile:delete",
                    "org:sys_memberships:read",
                    "org:sys_memberships:manage",
                  ]
                : ["org:sys_memberships:read"],
            public_metadata: {},
            private_metadata: {},
            created_at_unix: now,
            updated_at_unix: now,
          });
          memberCount++;
        }
        cs.organizations.update(org.id, { members_count: memberCount });
      }
    }
  }

  if (config.oauth_applications) {
    for (const appCfg of config.oauth_applications) {
      const existing = cs.oauthApps.findOneBy("client_id", appCfg.client_id);
      if (existing) continue;

      cs.oauthApps.insert({
        app_id: generateClerkId("oauth_app_"),
        name: appCfg.name,
        client_id: appCfg.client_id,
        client_secret: appCfg.client_secret ?? "",
        is_public: appCfg.public ?? false,
        scopes: appCfg.scopes ?? ["openid", "profile", "email"],
        redirect_uris: appCfg.redirect_uris,
        created_at_unix: now,
        updated_at_unix: now,
      });
    }
  }
}

export const clerkPlugin: ServicePlugin = {
  name: "clerk",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    // In browser mode, backend writes can change sign-in identities and session claims.
    app.use("*", async (c, next) => {
      const readOnly = c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS";
      if (
        !readOnly &&
        BROWSER_AUTHORITY_PATH.test(c.req.path) &&
        getClerkBrowser(store) &&
        !hasConfiguredTestKey(c, tokenMap)
      ) {
        return clerkError(c, 401, "UNAUTHORIZED", "A configured Clerk test secret key is required");
      }
      await next();
    });
    oauthRoutes(ctx);
    userRoutes(ctx);
    emailAddressRoutes(ctx);
    organizationRoutes(ctx);
    membershipRoutes(ctx);
    invitationRoutes(ctx);
    sessionRoutes(ctx);
    frontendRoutes(ctx);
    testingRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default clerkPlugin;
