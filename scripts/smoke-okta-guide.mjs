import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function guideBlock(guide, heading, language) {
  const section = guide.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
  const block = section?.split(`\n\`\`\`${language}\n`)[1]?.split("\n```")[0];
  assert(block, `Missing ${language} example under ${heading} in the installed guide`);
  return block;
}

async function choosePort() {
  const listener = createServer().listen(Number(process.env.OKTA_PORT ?? 0), "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  const closed = once(listener, "close");
  listener.close();
  await closed;
  return port;
}

async function waitForPicker(authorize, child) {
  for (let attempt = 0; attempt < 50; attempt++) {
    assert(
      child.exitCode === null && child.signalCode === null,
      "The installed Okta process exited before authorization",
    );
    try {
      return await fetch(authorize, { redirect: "manual", signal: AbortSignal.timeout(1000) });
    } catch (error) {
      if (error.cause?.code !== "ECONNREFUSED") throw error;
    }
    await delay(100);
  }
  throw new Error("The installed Okta process did not start in time");
}

function runOAuthStep(recipe, command, env, args = []) {
  const result = spawnSync("bash", ["-e", "-c", `${recipe}\n${command}`, "okta-guide", ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, `The installed guide's ${command.split(" ")[0]} step failed`);
  return result.stdout.trim();
}

async function checkSignIn(recipe, env, child) {
  const authorize = new URL(runOAuthStep(recipe, "okta_authorize_url", env));
  const base = `http://localhost:${env.OKTA_PORT}`;
  assert.equal(authorize.origin, base, "Authorization must target the launched emulator");
  const redirectUri = authorize.searchParams.get("redirect_uri");
  const state = authorize.searchParams.get("state");
  assert(redirectUri && state, "The guide's authorize URL must include a callback and state");
  const picker = await waitForPicker(authorize, child);
  assert.equal(picker.status, 200, "Authorization picker did not load");

  const forms = (await picker.text()).matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g);
  const selected = [...forms].find(([, , contents]) => contents.includes("admin@example.com"));
  assert(selected, "The authorization picker did not show the seeded active user");
  const [, action, contents] = selected;
  const callbackUrl = new URL(action, base);
  assert.equal(callbackUrl.origin, base, "The picker form must submit to the local emulator");
  const fields = new URLSearchParams();
  for (const [, name, value] of contents.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    fields.set(name, value);
  }
  const callback = await fetch(callbackUrl, {
    method: "POST",
    body: fields,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(callback.status, 302, "Sign-in did not redirect to the registered callback");
  const location = new URL(callback.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, redirectUri);
  assert.equal(location.searchParams.get("state"), state);
  const code = location.searchParams.get("code");
  assert(code, "Sign-in did not issue an authorization code");

  const token = JSON.parse(runOAuthStep(recipe, 'okta_exchange_code "$1"', env, [code]));
  assert.equal(typeof token.access_token, "string", "The token response must contain an access token");
  assert.equal(typeof token.id_token, "string", "The token response must contain an ID token");
  assert(token.access_token && token.id_token, "The tokens must be nonempty");
  console.log("Okta installed guide smoke passed: picker HTTP 200, callback HTTP 302, access and ID tokens issued.");
}

const installedRoot = process.argv[2];
assert(installedRoot, "Usage: node scripts/smoke-okta-guide.mjs <deployed-emulate-root>");
const root = resolve(installedRoot);
const guide = await readFile(join(root, "skills", "okta", "SKILL.md"), "utf8");
const seed = guideBlock(guide, "Seed Config", "yaml");
const launch = guideBlock(guide, "Start", "bash");
const oauth = guideBlock(guide, "OAuth / OIDC", "bash");
const port = await choosePort();
const env = { ...process.env, EMULATE_ROOT: root, OKTA_PORT: String(port) };
const scratch = await mkdtemp(join(tmpdir(), "emulate-okta-guide-"));
try {
  await writeFile(join(scratch, "okta-seed.yaml"), seed);
  const child = spawn("bash", ["-c", `exec ${launch}`], {
    cwd: scratch,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const closed = new Promise((done) => child.once("close", done));
  try {
    await once(child, "spawn");
    await checkSignIn(oauth, env, child);
  } finally {
    const running = child.pid && child.exitCode === null && child.signalCode === null;
    if (running) child.kill();
    const forceKill = running ? setTimeout(() => child.kill("SIGKILL"), 5000) : undefined;
    try {
      await closed;
    } finally {
      clearTimeout(forceKill);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
