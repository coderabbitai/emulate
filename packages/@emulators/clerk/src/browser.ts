import { randomBytes } from "node:crypto";
import type { Store } from "@emulators/core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ClerkSession, ClerkUser } from "./entities.js";
import { generateClerkId, nowUnix } from "./helpers.js";
import type { ClerkStore } from "./store.js";

const CONFIG_KEY = "clerk.browser.config";
const SESSION_TOKEN_TTL_SECONDS = 60;
// Clerk Backend SDK categorizes the token from this protected JOSE header.
const CLERK_SESSION_JWT_CATEGORY = "cl_B7d4PD111AAA";

interface BrowserConfig {
  origin: string;
  issuer: string;
}

export interface BrowserSignIn {
  id: string;
  userId: string;
  identifier: string;
  expiresAt: number;
  strategy: "password" | "ticket";
  sessionId: string | null;
}

export interface BrowserClient {
  id: string;
  createdAt: number;
  lastActiveSessionId: string | null;
  sessionIds: Set<string>;
  signIn?: BrowserSignIn;
}

export interface SignInTicket {
  id: string;
  token: string;
  userId: string;
  expiresAt: number;
  status: "pending" | "revoked" | "accepted";
  createdAt: number;
  updatedAt: number;
}

interface ClerkBrowser {
  config: BrowserConfig;
  kid: string;
  keyPair?: ReturnType<typeof generateKeyPair>;
  clients: Map<string, BrowserClient>;
  signInTickets: Map<string, SignInTicket>;
  testingTokens: Map<string, number>;
}

// Keep ephemeral credentials and the signing key out of Store snapshots.
const runtimes = new WeakMap<Store, ClerkBrowser>();

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value === url.origin &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}

export function configureClerkBrowser(store: Store, issuer: string, origin: string): void {
  if (!isLoopbackOrigin(origin) || !isLoopbackOrigin(issuer)) {
    throw new Error("Clerk browser mode requires exact loopback HTTP(S) origins for the app and emulator.");
  }
  const existing = store.getData<BrowserConfig>(CONFIG_KEY);
  if (existing?.origin === origin && existing.issuer === issuer) return;
  store.setData(CONFIG_KEY, { origin, issuer });
}

export function getClerkBrowser(store: Store): ClerkBrowser | undefined {
  const config = store.getData<BrowserConfig>(CONFIG_KEY);
  if (!config) {
    runtimes.delete(store);
    return undefined;
  }
  let runtime = runtimes.get(store);
  if (runtime?.config !== config) {
    runtime = {
      config,
      kid: generateClerkId("emulate-clerk-browser-"),
      clients: new Map(),
      signInTickets: new Map(),
      testingTokens: new Map(),
    };
    runtimes.set(store, runtime);
  }
  return runtime;
}

export function browserCredential(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function eligibleBrowserUser(user: ClerkUser | undefined): user is ClerkUser {
  return !!user?.browser_seeded && !user.banned && !user.locked && !user.two_factor_enabled && !user.totp_enabled;
}

export function ownedBrowserSession(cs: ClerkStore, client: BrowserClient, id: string) {
  if (!client.sessionIds.has(id)) return undefined;
  const session = cs.sessions.findOneBy("clerk_id", id);
  return session?.browser_owned && session.client_id === client.id ? session : undefined;
}

export function activeBrowserSession(cs: ClerkStore, client: BrowserClient, id: string) {
  const session = ownedBrowserSession(cs, client, id);
  if (!session || session.status !== "active" || nowUnix() >= session.expire_at || nowUnix() >= session.abandon_at) {
    return undefined;
  }
  const user = cs.users.findOneBy("clerk_id", session.user_id);
  if (!eligibleBrowserUser(user)) return undefined;
  return { session, user };
}

export function browserPrimaryEmail(cs: ClerkStore, user: ClerkUser) {
  if (!user.primary_email_address_id) return undefined;
  const email = cs.emailAddresses.findOneBy("email_id", user.primary_email_address_id);
  return email?.user_id === user.clerk_id ? email : undefined;
}

export function browserMembership(cs: ClerkStore, session: ClerkSession) {
  if (!session.browser_organization_id) return undefined;
  const organization = cs.organizations.findOneBy("clerk_id", session.browser_organization_id);
  if (!organization) return undefined;
  const membership = cs.memberships.findBy("user_id", session.user_id).find((m) => m.org_id === organization.clerk_id);
  if (membership) return { organization, membership };
}

function signingKeys(browser: ClerkBrowser) {
  return (browser.keyPair ??= generateKeyPair("RS256"));
}

export async function clerkBrowserJwk(store: Store) {
  const browser = getClerkBrowser(store);
  if (!browser) return undefined;
  const { publicKey } = await signingKeys(browser);
  const jwk = await exportJWK(publicKey);
  if (getClerkBrowser(store) !== browser) return undefined;
  return { ...jwk, kid: browser.kid, use: "sig", alg: "RS256" };
}

export async function signBrowserSession(store: Store, cs: ClerkStore, client: BrowserClient, id: string) {
  const browser = getClerkBrowser(store);
  if (!browser || !activeBrowserSession(cs, client, id)) return undefined;
  const { privateKey } = await signingKeys(browser);
  const active = activeBrowserSession(cs, client, id);
  if (getClerkBrowser(store) !== browser || !active) return undefined;

  const { session, user } = active;
  const organizationLink = browserMembership(cs, session);
  const now = nowUnix();
  const jwt = await new SignJWT({
    sid: session.clerk_id,
    azp: browser.config.origin,
    fva: [0, -1],
    ...(organizationLink && {
      org_id: organizationLink.organization.clerk_id,
      org_role: organizationLink.membership.role,
      org_slug: organizationLink.organization.slug,
      org_permissions: organizationLink.membership.permissions,
    }),
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: browser.kid, cat: CLERK_SESSION_JWT_CATEGORY })
    .setIssuer(browser.config.issuer)
    .setSubject(user.clerk_id)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(Math.min(now + SESSION_TOKEN_TTL_SECONDS, session.expire_at, session.abandon_at))
    .sign(privateKey);

  const current = activeBrowserSession(cs, client, id)?.session;
  if (
    getClerkBrowser(store) !== browser ||
    !current ||
    current.browser_organization_id !== session.browser_organization_id ||
    browserMembership(cs, current)?.membership !== organizationLink?.membership
  ) {
    return undefined;
  }
  return { object: "token", jwt };
}
