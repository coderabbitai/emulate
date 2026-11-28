export const secretKey = "sk_test_clerk_browser_fixture";
export const proxyPath = "/__clerk";
// ClerkJS enables its dev-browser credential protocol only for recognized dev suffixes.
// The fixture routes all HTTP traffic to the loopback app's relative proxy.
export const frontendHostname = "clerk.emulate-fixture.lcl.dev";
export const publishableKey = `pk_test_${Buffer.from(`${frontendHostname}$`).toString("base64")}`;
export const organizationId = "org_clerk_fixture";
export const users = {
  admin: {
    clerk_id: "user_clerk_fixture_admin",
    email_addresses: ["admin@clerk-fixture.example.test"],
    password: "clerk-fixture-admin-password",
    private_metadata: { fixture: "clerk-fixture-admin-private" },
  },
  member: {
    clerk_id: "user_clerk_fixture_member",
    email_addresses: ["member@clerk-fixture.example.test"],
    password: "clerk-fixture-member-password",
    private_metadata: { fixture: "clerk-fixture-member-private" },
  },
};

export function fixtureSeed(appOrigin) {
  return {
    tokens: { [secretKey]: { login: users.admin.email_addresses[0] } },
    clerk: {
      browser_app_origin: appOrigin,
      users: Object.values(users),
      organizations: [
        {
          clerk_id: organizationId,
          name: "Fixture Organization",
          slug: "fixture-org",
          members: Object.entries(users).map(([role, user]) => ({
            email: user.email_addresses[0],
            role: `org:${role}`,
          })),
        },
      ],
    },
  };
}

export function loopbackOrigin(value, protocol = "http:") {
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== "127.0.0.1" || url.origin !== value || !url.port) {
    throw new Error(`Expected a ${protocol} 127.0.0.1 origin with a port`);
  }
  return url;
}

export function report(event, details = {}) {
  console.log(JSON.stringify({ event, ...details }));
}
