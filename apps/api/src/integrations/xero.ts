/** Xero connection foundation. Intentionally no financial record or email endpoints. */
import { z } from "zod";
import type { Env } from "../env";
import { decryptJson, encryptJson } from "../lib/crypto";
import { HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";

// Least privilege for this increment: organisation metadata only. Add granular financial
// scopes through reviewed re-consent when their corresponding features are implemented.
export const XERO_SCOPES = "offline_access accounting.settings.read";
const IDENTITY = "https://identity.xero.com/connect/token";
const CONNECTIONS = "https://api.xero.com/connections";
const ORGANISATION = "https://api.xero.com/api.xro/2.0/Organisation";
const id = z.string().uuid();
const connection = z.object({ id, tenantId: id, tenantName: z.string().max(500), tenantType: z.literal("ORGANISATION") });
export type XeroConnection = z.infer<typeof connection>;
export interface XeroState {
  version: 1;
  mode: "read_only" | "demo";
  paused: boolean;
  token?: { access: string; refresh: string; expires: number; scopes: string };
  pending?: { nonce: string; verifier: string; user: string; expires: number };
  selected?: XeroConnection & { demo: boolean };
  checked_at?: string;
}
export const newXeroState = (): XeroState => ({ version: 1, mode: "read_only", paused: true });
export const configured = (env: Env) => env.XERO_ENABLED === "true" && Boolean(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET && env.XERO_REDIRECT_URI);

export function xeroRedirect(env: Env): string {
  const uri = env.XERO_REDIRECT_URI;
  if (!uri) throw new HttpError(503, "Set the Xero redirect URI on the server first.");
  let url: URL;
  try { url = new URL(uri); } catch { throw new HttpError(503, "The Xero redirect URI is not valid."); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/api/apps/xero/callback" || url.origin !== new URL(env.APP_URL!).origin) {
    throw new HttpError(503, "The Xero redirect URI must use this application's address and /api/apps/xero/callback.");
  }
  return url.href;
}

export async function loadXero(env: Env, db: Db, company: string): Promise<XeroState> {
  const { data, error } = await db.from("integration_secrets").select("ciphertext").match({ company_id: company, provider: "xero" }).maybeSingle();
  if (error) throw new HttpError(503, "Xero settings are temporarily unavailable.");
  if (!data) return newXeroState();
  try {
    const state = await decryptJson<XeroState>(env, data.ciphertext);
    if (state.version !== 1 || !["read_only", "demo"].includes(state.mode) || typeof state.paused !== "boolean") throw new Error();
    return state;
  } catch { throw new HttpError(503, "Xero settings could not be read. Check the server's existing encryption configuration."); }
}

export async function withXeroLease<T>(db: Db, company: string, action: (lease: string) => Promise<T>): Promise<T> {
  const { data: lease, error } = await db.rpc("xero_acquire_lease", { p_company: company });
  if (error) throw new HttpError(503, "Xero setup is unavailable. Check that the reviewed database migration has been applied.");
  if (!lease) throw new HttpError(409, "Another Xero connection update is running. Try again in a moment.");
  try { return await action(lease); }
  finally { await db.rpc("xero_release_lease", { p_company: company, p_lease: lease }); }
}

export async function saveXero(env: Env, db: Db, company: string, lease: string, state: XeroState): Promise<void> {
  const { error } = await db.rpc("xero_save_connection", {
    p_company: company, p_lease: lease, p_ciphertext: await encryptJson(env, state),
    p_expires: state.token ? new Date(state.token.expires).toISOString() : null,
    p_connected: Boolean(state.token && state.selected),
  });
  if (error) throw new HttpError(503, "The Xero connection could not be saved safely. Try again.");
}

async function request(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new HttpError(503, "Xero did not respond. Try again later."); }
  // Never include a provider body, URL, credentials or tenant in thrown errors or logs.
  if (response.status === 429) throw new HttpError(429, "Xero's request limit was reached. Wait before trying again.");
  if (response.status === 401 || response.status === 403) throw new HttpError(409, "Xero access needs attention. Reconnect or check the app permissions.");
  if (!response.ok) throw new HttpError(503, "Xero could not complete the connection request.");
  return response;
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new HttpError(503, "Xero returned an unreadable connection response."); }
}

export async function xeroTokens(env: Env, form: Record<string, string>): Promise<NonNullable<XeroState["token"]>> {
  const response = await request(IDENTITY, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`)}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive().max(86400), scope: z.string() }).safeParse(await json(response));
  if (!parsed.success || !XERO_SCOPES.split(" ").every((s) => parsed.data.scope.split(" ").includes(s))) throw new HttpError(409, "Xero did not grant the required connection permissions. Reconnect.");
  return { access: parsed.data.access_token, refresh: parsed.data.refresh_token, expires: Date.now() + parsed.data.expires_in * 1000, scopes: parsed.data.scope };
}

/** Must be called under the database lease. Persist rotation before returning any access. */
export async function xeroAccess(env: Env, db: Db, company: string, lease: string, state: XeroState): Promise<string> {
  if (!state.token) throw new HttpError(409, "Connect to Xero first.");
  if (state.token.expires - Date.now() < 120_000) {
    const next = await xeroTokens(env, { grant_type: "refresh_token", refresh_token: state.token.refresh });
    state.token = next;
    await saveXero(env, db, company, lease, state);
  }
  return state.token.access;
}

export async function xeroConnections(token: string): Promise<XeroConnection[]> {
  const parsed = z.array(connection).safeParse(await json(await request(CONNECTIONS, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })));
  if (!parsed.success) throw new HttpError(503, "Xero returned an unexpected organisation list.");
  return parsed.data;
}

export async function xeroOrganisation(token: string, tenant: string): Promise<boolean> {
  if (!id.safeParse(tenant).success) throw new HttpError(400, "Choose an organisation from the list.");
  const parsed = z.object({ Organisations: z.array(z.object({ OrganisationID: id, IsDemoCompany: z.boolean() })).length(1) }).safeParse(await json(await request(ORGANISATION, {
    headers: { Authorization: `Bearer ${token}`, "Xero-tenant-id": tenant, Accept: "application/json" },
  })));
  if (!parsed.success || parsed.data.Organisations[0]!.OrganisationID !== tenant) throw new HttpError(503, "Xero did not confirm the selected organisation.");
  return parsed.data.Organisations[0]!.IsDemoCompany;
}

export async function deleteXeroConnection(token: string, connectionId: string): Promise<void> {
  if (!id.safeParse(connectionId).success) throw new HttpError(400, "The Xero connection is not valid.");
  await request(`${CONNECTIONS}/${connectionId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}
