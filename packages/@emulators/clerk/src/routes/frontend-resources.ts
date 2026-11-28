/*! @license Apache-2.0
 * Adapted from vercel-labs/emulate PR #171 by Philip Snyder
 * at 73b9c4b4a72325d49560b43450799c2880f0c403.
 */
// Browser resources use explicit fields and never embed the Backend API's private metadata.
import {
  browserMembership,
  browserPrimaryEmail,
  preferredBrowserSessionId,
  type BrowserClient,
  type BrowserSessionSignature,
  type BrowserSignIn,
} from "../browser.js";
import type { ClerkOrganizationMembership, ClerkSession, ClerkUser } from "../entities.js";
import { emailAddressResponse } from "../route-helpers.js";
import type { ClerkStore } from "../store.js";

export function browserMembershipResource(cs: ClerkStore, membership: ClerkOrganizationMembership) {
  const org = cs.organizations.findOneBy("clerk_id", membership.org_id);
  if (!org) return [];
  return [
    {
      object: "organization_membership",
      id: membership.membership_id,
      role: membership.role,
      permissions: membership.permissions,
      public_metadata: membership.public_metadata,
      organization: {
        object: "organization",
        id: org.clerk_id,
        name: org.name,
        slug: org.slug,
        image_url: "",
        has_image: false,
        members_count: org.members_count,
        max_allowed_memberships: org.max_allowed_memberships,
        admin_delete_enabled: org.admin_delete_enabled,
        public_metadata: org.public_metadata,
        created_at: org.created_at_unix * 1000,
        updated_at: org.updated_at_unix * 1000,
      },
      created_at: membership.created_at_unix * 1000,
      updated_at: membership.updated_at_unix * 1000,
    },
  ];
}

function browserUserResource(cs: ClerkStore, user: ClerkUser, primaryEmailId: string | null) {
  const emails = cs.emailAddresses.findBy("user_id", user.clerk_id);
  return {
    object: "user",
    id: user.clerk_id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    image_url: "",
    has_image: false,
    primary_email_address_id: primaryEmailId,
    primary_phone_number_id: user.primary_phone_number_id,
    primary_web3_wallet_id: null,
    email_addresses: emails.map((email) => ({
      ...emailAddressResponse(email),
      created_at: email.created_at_unix * 1000,
      updated_at: email.updated_at_unix * 1000,
    })),
    phone_numbers: [],
    web3_wallets: [],
    external_accounts: [],
    enterprise_accounts: [],
    passkeys: [],
    organization_memberships: cs.memberships
      .findBy("user_id", user.clerk_id)
      .flatMap((membership) => browserMembershipResource(cs, membership)),
    password_enabled: user.password_enabled,
    two_factor_enabled: user.two_factor_enabled,
    public_metadata: user.public_metadata,
    unsafe_metadata: user.unsafe_metadata,
    last_sign_in_at: user.last_sign_in_at === null ? null : user.last_sign_in_at * 1000,
    created_at: user.created_at_unix * 1000,
    updated_at: user.updated_at_unix * 1000,
  };
}

export function browserSessionResource(
  cs: ClerkStore,
  session: ClerkSession,
  user: ClerkUser,
  signature: BrowserSessionSignature | null,
) {
  const email = browserPrimaryEmail(cs, user);
  const organization = signature ? signature.organization : browserMembership(cs, session);
  return {
    object: "session",
    id: session.clerk_id,
    status: session.status,
    factor_verification_age: [0, -1],
    expire_at: session.expire_at * 1000,
    abandon_at: session.abandon_at * 1000,
    last_active_at: (session.last_active_at ?? session.created_at_unix) * 1000,
    last_active_token: signature?.token ?? null,
    last_active_organization_id: organization?.organization.clerk_id ?? null,
    actor: null,
    tasks: [],
    user: browserUserResource(cs, user, email?.email_id ?? null),
    public_user_data: {
      user_id: user.clerk_id,
      first_name: user.first_name,
      last_name: user.last_name,
      image_url: "",
      has_image: false,
      identifier: email?.email_address ?? user.username ?? user.clerk_id,
    },
    created_at: session.created_at_unix * 1000,
    updated_at: session.updated_at_unix * 1000,
  };
}

export function browserSignInResource(signIn: BrowserSignIn) {
  return {
    object: "sign_in",
    id: signIn.id,
    status: signIn.sessionId ? "complete" : "needs_first_factor",
    identifier: signIn.identifier,
    supported_identifiers: ["email_address"],
    supported_first_factors: [{ strategy: signIn.strategy, safe_identifier: signIn.identifier }],
    supported_second_factors: [],
    first_factor_verification: signIn.sessionId ? { status: "verified", strategy: signIn.strategy } : null,
    second_factor_verification: null,
    created_session_id: signIn.sessionId,
  };
}

export function browserClientResource(client: BrowserClient, sessions: ReturnType<typeof browserSessionResource>[]) {
  const signIn = client.signIn && client.signIn.expiresAt > Date.now() ? browserSignInResource(client.signIn) : null;
  return {
    object: "client",
    id: client.id,
    sessions,
    sign_up: null,
    sign_in: signIn,
    last_active_session_id: preferredBrowserSessionId(
      client,
      sessions.map((session) => session.id),
    ),
    last_authentication_strategy: signIn?.first_factor_verification?.strategy ?? null,
    cookie_expires_at: null,
    created_at: client.createdAt,
    updated_at: Date.now(),
  };
}
