/** Owner-only, human-session Xero setup. No imports, exports, emails or scheduled sync. */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { randomId, safeEqual, signToken, toBase64Url, verifyToken } from "../lib/crypto";
import { HttpError, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { configured, deleteXeroConnection, loadXero, newXeroState, saveXero, withXeroLease, xeroAccess, xeroConnections, xeroOrganisation, xeroRedirect, xeroTokens, XERO_SCOPES } from "../integrations/xero";

export const xero = new Hono<AppEnv>();
const COOKIE = "lemon_xero_oauth";
const COOKIE_PATH = "/api/apps/xero";
const callbackState = z.object({ company: z.string().uuid(), user: z.string().uuid(), nonce: z.string(), provider: z.literal("xero"), exp: z.number() });

// Prevent browser caching of protected connection metadata and callback codes/referrers.
xero.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

// No raw provider/DB errors reach logs or the browser. Auth errors remain plain-language.
xero.onError((error, c) => error instanceof HTTPException
  ? c.json({ error: error.message }, error.status)
  : c.json({ error: "Xero setup could not be completed safely. Try again." }, 503));

/** No bearer token on an OAuth redirect. Signed state, browser cookie, one-use stored nonce,
 * expiration and CURRENT ownership must all match before any token exchange. */
xero.get("/callback", async (c) => {
  const done = (status: "connected" | "error") => c.redirect(`/apps/xero?status=${status}`);
  const cookie = getCookie(c, COOKIE);
  deleteCookie(c, COOKIE, { path: COOKIE_PATH });
  const verified = await verifyToken<Record<string, unknown> & { exp: number }>(c.env, c.req.query("state") ?? "").catch(() => null);
  const parsed = callbackState.safeParse(verified);
  if (!parsed.success || !cookie || !safeEqual(cookie, parsed.data.nonce) || !configured(c.env)) return done("error");
  const state = parsed.data;
  const db = adminClient(c.env);
  try {
    const { data: owner, error } = await db.from("memberships").select("role").match({ company_id: state.company, user_id: state.user, active: true }).maybeSingle();
    if (error || owner?.role !== "owner") return done("error");
    await withXeroLease(db, state.company, async (lease) => {
      const saved = await loadXero(c.env, db, state.company);
      const pending = saved.pending;
      if (!pending || !safeEqual(pending.nonce, cookie) || pending.user !== state.user || pending.expires < Date.now()) throw new HttpError(409, "The Xero sign-in has expired.");
      // Consume the attempt BEFORE contacting Xero, including cancellations. Replays cannot
      // exchange a code twice or race disconnect/reconnect. Keep any old working grant on failure.
      delete saved.pending;
      await saveXero(c.env, db, state.company, lease, saved);
      const code = c.req.query("code");
      if (c.req.query("error") || !code || code.length > 4096) throw new HttpError(409, "Xero sign-in was not completed.");
      saved.token = await xeroTokens(c.env, { grant_type: "authorization_code", code, redirect_uri: xeroRedirect(c.env), code_verifier: pending.verifier });
      // Selection is explicit after every new authorisation; do not carry a tenant into new tokens.
      delete saved.selected;
      delete saved.checked_at;
      saved.paused = true;
      await saveXero(c.env, db, state.company, lease, saved);
    });
    return done("connected");
  } catch { return done("error"); }
});

xero.use("*", requireUser, requireCompany(["owner"], "apps"), async (c, next) => {
  if (c.var.oauthClientId) throw new HttpError(403, "Manage Xero directly in Lemon CRM, not through an AI assistant.");
  await next();
});

xero.get("/config", async (c) => {
  const saved = await loadXero(c.env, adminClient(c.env), c.var.companyId);
  let redirect: string | null = null;
  try { redirect = xeroRedirect(c.env); } catch { /* Show setup instructions without exposing values. */ }
  return c.json({
    enabled: c.env.XERO_ENABLED === "true", configured: configured(c.env) && Boolean(redirect), redirect_uri: redirect,
    credentials_set: Boolean(c.env.XERO_CLIENT_ID && c.env.XERO_CLIENT_SECRET), scopes: XERO_SCOPES.split(" "),
    mode: saved.mode, paused: true, incoming_enabled: false, outgoing_enabled: false,
    sync_implemented: false, live_mode_available: false, live_connection_allowed: c.env.XERO_ALLOW_LIVE_CONNECTION === "true",
    authorised: Boolean(saved.token), selected: saved.selected ? { name: saved.selected.tenantName, demo: saved.selected.demo } : null,
    checked_at: saved.checked_at ?? null, token_expired: saved.token ? saved.token.expires <= Date.now() : false,
  });
});

// All remaining endpoints require explicitly configured server-side credentials.
xero.use("*", async (c, next) => {
  // The owner must still be able to forget local tokens after credentials are
  // removed or the feature is disabled. Remote disconnect validates setup below.
  if (c.req.path === "/api/apps/xero/disconnect") return next();
  if (!configured(c.env)) throw new HttpError(503, "Xero is disabled or not configured on this server.");
  xeroRedirect(c.env);
  await next();
});

xero.post("/connect", async (c) => {
  const db = adminClient(c.env);
  const nonce = randomId(32);
  const verifier = randomId(48);
  await withXeroLease(db, c.var.companyId, async (lease) => {
    const saved = await loadXero(c.env, db, c.var.companyId);
    saved.pending = { nonce, verifier, user: c.var.userId, expires: Date.now() + 600_000 };
    await saveXero(c.env, db, c.var.companyId, lease, saved);
  });
  const state = await signToken(c.env, { company: c.var.companyId, user: c.var.userId, provider: "xero", nonce, exp: Math.floor(Date.now() / 1000) + 600 });
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  setCookie(c, COOKIE, nonce, { httpOnly: true, secure: xeroRedirect(c.env).startsWith("https:"), sameSite: "Lax", path: COOKIE_PATH, maxAge: 600 });
  const params = new URLSearchParams({ response_type: "code", client_id: c.env.XERO_CLIENT_ID!, redirect_uri: xeroRedirect(c.env), scope: XERO_SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" });
  return c.json({ authorization_url: `https://login.xero.com/identity/connect/authorize?${params}` });
});

xero.post("/organisations", async (c) => {
  const db = adminClient(c.env);
  return withXeroLease(db, c.var.companyId, async (lease) => {
    const saved = await loadXero(c.env, db, c.var.companyId);
    const token = await xeroAccess(c.env, db, c.var.companyId, lease, saved);
    const connections = await xeroConnections(token);
    // No provider response is stored or logged; return only the owner's selection list.
    return c.json({ organisations: connections.map((x) => ({ id: x.id, name: x.tenantName })) });
  });
});

xero.post("/select", async (c) => {
  const body = await readJson(c, z.object({ connection_id: z.string().uuid() }).strict());
  const db = adminClient(c.env);
  return withXeroLease(db, c.var.companyId, async (lease) => {
    const saved = await loadXero(c.env, db, c.var.companyId);
    if (saved.selected && saved.selected.id !== body.connection_id) throw new HttpError(409, "Disconnect before choosing a different organisation.");
    const token = await xeroAccess(c.env, db, c.var.companyId, lease, saved);
    const selected = (await xeroConnections(token)).find((x) => x.id === body.connection_id);
    if (!selected) throw new HttpError(409, "That organisation is no longer authorised. Reconnect and choose again.");
    const demo = await xeroOrganisation(token, selected.tenantId);
    if (!demo && (saved.mode === "demo" || c.env.XERO_ALLOW_LIVE_CONNECTION !== "true")) throw new HttpError(409, "Only the Xero Demo Company can be selected on this server.");
    saved.selected = { ...selected, demo };
    saved.checked_at = new Date().toISOString();
    await saveXero(c.env, db, c.var.companyId, lease, saved);
    return c.json({ ok: true });
  });
});

xero.post("/check", async (c) => {
  const db = adminClient(c.env);
  return withXeroLease(db, c.var.companyId, async (lease) => {
    const saved = await loadXero(c.env, db, c.var.companyId);
    if (!saved.selected) throw new HttpError(409, "Choose an organisation first.");
    if (!saved.selected.demo && c.env.XERO_ALLOW_LIVE_CONNECTION !== "true") throw new HttpError(409, "Live organisation access is disabled on this server.");
    const token = await xeroAccess(c.env, db, c.var.companyId, lease, saved);
    if (!(await xeroConnections(token)).some((x) => x.id === saved.selected!.id && x.tenantId === saved.selected!.tenantId)) throw new HttpError(409, "The selected Xero organisation is disconnected. Reconnect.");
    const demo = await xeroOrganisation(token, saved.selected.tenantId);
    if (!demo && saved.mode === "demo") throw new HttpError(409, "Demo mode requires the Xero Demo Company.");
    saved.checked_at = new Date().toISOString();
    saved.selected.demo = demo;
    await saveXero(c.env, db, c.var.companyId, lease, saved);
    return c.json({ ok: true, checked_at: saved.checked_at });
  });
});

xero.put("/settings", async (c) => {
  const body = await readJson(c, z.object({ mode: z.enum(["read_only", "demo", "live"]), paused: z.boolean() }).strict());
  if (body.mode === "live" || !body.paused) throw new HttpError(409, "Financial synchronisation and Live mode are not implemented. Synchronisation must remain paused.");
  const db = adminClient(c.env);
  return withXeroLease(db, c.var.companyId, async (lease) => {
    const saved = await loadXero(c.env, db, c.var.companyId);
    if (body.mode === "demo" && saved.selected && !saved.selected.demo) throw new HttpError(409, "Disconnect the live organisation before choosing Demo mode.");
    saved.mode = body.mode as "read_only" | "demo";
    saved.paused = true;
    await saveXero(c.env, db, c.var.companyId, lease, saved);
    return c.json({ ok: true });
  });
});

xero.post("/disconnect", async (c) => {
  const { local_only } = await readJson(c, z.object({ local_only: z.boolean().default(false) }).strict());
  const db = adminClient(c.env);
  return withXeroLease(db, c.var.companyId, async (lease) => {
    const saved = await loadXero(c.env, db, c.var.companyId);
    if (!local_only && saved.selected && saved.token) {
      if (!configured(c.env)) throw new HttpError(409, "Xero is disabled. Choose Forget locally, or restore server configuration to disconnect at Xero.");
      // Delete only this selected connection, NEVER revoke a token's other tenants.
      const token = await xeroAccess(c.env, db, c.var.companyId, lease, saved);
      await deleteXeroConnection(token, saved.selected.id);
    }
    await saveXero(c.env, db, c.var.companyId, lease, { ...newXeroState(), mode: saved.mode });
    return c.json({ ok: true, remote_connection_removed: !local_only && Boolean(saved.selected) });
  });
});
