/** Fictional fixtures only. Every HTTP request is intercepted; no real Xero/database access. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { decryptJson, encryptJson } from "../src/lib/crypto";
import type { Db } from "../src/lib/supabase";
import { loadXero, newXeroState, saveXero, withXeroLease, xeroAccess, xeroRedirect, XERO_SCOPES, type XeroState } from "../src/integrations/xero";

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => current.db, userClient: () => current.db,
}));
const COMPANY = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000003";
const CONNECTION = "00000000-0000-4000-8000-000000000004";
const TENANT = "00000000-0000-4000-8000-000000000005";
const env: Env = { SUPABASE_URL: "https://db.example.test", SUPABASE_SECRET_KEY: "fictional_database_key", SUPABASE_PUBLISHABLE_KEY: "fictional_public_key", APP_URL: "https://crm.example.test", ENCRYPTION_KEY: "fictional-encryption-key-for-unit-tests-only", XERO_ENABLED: "true", XERO_CLIENT_ID: "fictional_client_id", XERO_CLIENT_SECRET: "fictional_client_secret", XERO_REDIRECT_URI: "https://crm.example.test/api/apps/xero/callback" };
const headers = { Authorization: "Bearer fictional_session", "X-Company-Id": COMPANY, "Content-Type": "application/json" };
const connected = (): XeroState => ({ ...newXeroState(), token: { access: "fictional_access", refresh: "fictional_refresh", expires: Date.now() + 1_800_000, scopes: XERO_SCOPES }, selected: { id: CONNECTION, tenantId: TENANT, tenantName: "Fictional Demo Company", tenantType: "ORGANISATION", demo: true } });

function fakeDb() {
  const ciphertext = new Map<string, string>();
  const leases = new Map<string, string>();
  const state = { role: "owner", oauth: false, saveFails: false };
  const db = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: any = new Proxy({}, { get: (_, key) => {
        if (key === "then") return (resolve: (value: unknown) => unknown) => Promise.resolve().then(() => resolve({ error: null, data:
          table === "memberships" ? (filters.company_id === COMPANY ? { role: state.role, role_id: null } : null)
          : table === "integration_secrets" && ciphertext.has(String(filters.company_id)) ? { ciphertext: ciphertext.get(String(filters.company_id)) }
          : null }));
        return (...args: any[]) => {
          if (key === "match") Object.assign(filters, args[0]);
          if (key === "eq") filters[args[0]] = args[1];
          return chain;
        };
      } });
      return chain;
    },
    rpc: async (name: string, args: any) => {
      if (name === "xero_acquire_lease") {
        if (leases.has(args.p_company)) return { data: null, error: null };
        const lease = crypto.randomUUID(); leases.set(args.p_company, lease); return { data: lease, error: null };
      }
      if (name === "xero_save_connection") {
        if (state.saveFails || leases.get(args.p_company) !== args.p_lease) return { error: { message: "fictional database error must stay private" }, data: null };
        ciphertext.set(args.p_company, args.p_ciphertext);
      }
      if (name === "xero_release_lease" && leases.get(args.p_company) === args.p_lease) leases.delete(args.p_company);
      return { data: null, error: null };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER, ...(state.oauth ? { client_id: "fictional_assistant" } : {}) } }, error: null }) },
  };
  current.db = db;
  return { db: db as unknown as Db, ciphertext, leases, state, keep: async (value: XeroState, company = COMPANY) => ciphertext.set(company, await encryptJson(env, value)) };
}
const call = (path: string, body: unknown = {}, method = "POST", settings = env, extra: Record<string, string> = {}) => app.request(`/api/apps/xero/${path}`, { method, headers: { ...headers, ...extra }, ...(method !== "GET" ? { body: JSON.stringify(body) } : {}) }, settings);
const tokenResponse = () => Response.json({ access_token: "fictional_rotated_access", refresh_token: "fictional_rotated_refresh", expires_in: 1800, scope: XERO_SCOPES });
const connectionsResponse = () => Response.json([{ id: CONNECTION, tenantId: TENANT, tenantName: "Fictional Demo Company", tenantType: "ORGANISATION" }]);
const orgResponse = (demo = true) => Response.json({ Organisations: [{ OrganisationID: TENANT, IsDemoCompany: demo }] });

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected HTTP: tests must stub every request"); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Xero owner-only configuration", () => {
  it("is off without explicit enablement; live mode and sync stay blocked", async () => {
    fakeDb();
    expect((await call("connect", {}, "POST", { ...env, XERO_ENABLED: undefined })).status).toBe(503);
    expect((await call("settings", { mode: "live", paused: true }, "PUT")).status).toBe(409);
    expect((await call("settings", { mode: "read_only", paused: false }, "PUT")).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires an authenticated current owner and refuses another company", async () => {
    const db = fakeDb(); db.state.role = "admin";
    for (const path of ["config", "connect", "check", "disconnect", "organisations"]) expect((await call(path, {}, path === "config" ? "GET" : "POST")).status).toBe(403);
    db.state.role = "owner";
    expect((await call("config", {}, "GET", env, { "X-Company-Id": OTHER })).status).toBe(403);
    expect((await app.request("/api/apps/xero/config", {}, env)).status).toBe(401);
  });
  it("blocks AI assistant sessions from protected metadata", async () => {
    const db = fakeDb(); db.state.oauth = true;
    // requireUser's companySwitch is tested separately; here its generic OAuth write guard applies.
    expect((await call("connect")).status).toBe(403);
    expect((await call("config", {}, "GET")).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("encrypts tokens and returns no credentials, tenant IDs, raw grants or customer data", async () => {
    const db = fakeDb(); await db.keep(connected());
    const result = await call("config", {}, "GET");
    const text = await result.text();
    for (const secret of [env.XERO_CLIENT_ID!, env.XERO_CLIENT_SECRET!, "fictional_access", "fictional_refresh", TENANT, CONNECTION]) expect(text).not.toContain(secret);
    expect(db.ciphertext.get(COMPANY)).not.toContain("fictional_access");
    expect(JSON.parse(text)).toMatchObject({ paused: true, live_mode_available: false, incoming_enabled: false, outgoing_enabled: false, sync_implemented: false });
  });
  it("validates the registered callback instead of trusting request hosts", () => {
    expect(xeroRedirect(env)).toBe(env.XERO_REDIRECT_URI);
    for (const uri of ["https://attacker.example.test/api/apps/xero/callback", "https://crm.example.test/api/apps/xero/callback?token=x", "https://crm.example.test/wrong", "http://crm.example.test/api/apps/xero/callback"]) expect(() => xeroRedirect({ ...env, XERO_REDIRECT_URI: uri })).toThrow();
  });
});

async function start() {
  const response = await call("connect");
  expect(response.status).toBe(200);
  const url = new URL((await response.json() as { authorization_url: string }).authorization_url);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { url, cookie };
}
const callback = (url: URL, cookie: string) => app.request(`/api/apps/xero/callback?state=${encodeURIComponent(url.searchParams.get("state")!)}&code=fictional_code`, { headers: { Cookie: cookie } }, env);

describe("Xero OAuth", () => {
  it("binds PKCE and one-use state to this owner/browser, then requires explicit selection", async () => {
    const db = fakeDb(); const { url, cookie } = await start();
    expect(url.origin).toBe("https://login.xero.com");
    expect(url.searchParams.get("scope")).toBe(XERO_SCOPES);
    expect(url.searchParams.get("scope")).not.toContain("accounting.transactions");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(env.XERO_REDIRECT_URI);
    const http = vi.fn(async (_url: string, init: RequestInit) => {
      expect(String(init.body)).toContain("code_verifier=");
      return tokenResponse();
    }); vi.stubGlobal("fetch", http);
    expect((await callback(url, cookie)).headers.get("location")).toBe("/apps/xero?status=connected");
    const saved = await loadXero(env, db.db, COMPANY);
    expect(saved.token?.refresh).toBe("fictional_rotated_refresh");
    expect(saved.selected).toBeUndefined(); expect(saved.paused).toBe(true);
    expect((await callback(url, cookie)).headers.get("location")).toBe("/apps/xero?status=error");
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("rejects missing cookie and demoted owners before token exchange", async () => {
    const db = fakeDb(); const { url, cookie } = await start();
    expect((await callback(url, "")).headers.get("location")).toContain("error");
    db.state.role = "admin";
    expect((await callback(url, cookie)).headers.get("location")).toContain("error");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects expired or tampered state before exchange", async () => {
    fakeDb(); const { url, cookie } = await start();
    url.searchParams.set("state", url.searchParams.get("state")! + "tampered");
    expect((await callback(url, cookie)).headers.get("location")).toContain("error");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("consumes a cancelled attempt without fetching or changing existing tokens", async () => {
    const db = fakeDb(); await db.keep(connected()); const { url, cookie } = await start();
    const response = await app.request(`/api/apps/xero/callback?state=${encodeURIComponent(url.searchParams.get("state")!)}&error=access_denied&error_description=fictional_provider_text`, { headers: { Cookie: cookie } }, env);
    expect(response.headers.get("location")).toBe("/apps/xero?status=error");
    expect((await loadXero(env, db.db, COMPANY)).pending).toBeUndefined();
    expect((await loadXero(env, db.db, COMPANY)).token?.access).toBe("fictional_access");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not leak hostile provider responses or throw credentials into logs", async () => {
    fakeDb(); const { url, cookie } = await start();
    const logs = vi.spyOn(console, "error");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fictional_secret_that_must_not_appear", { status: 400 })));
    const result = await callback(url, cookie);
    expect(result.headers.get("location")).toBe("/apps/xero?status=error");
    expect(logs).not.toHaveBeenCalled();
  });
});

describe("Xero tenant isolation, refresh and failure safety", () => {
  it("lists only authorised connections and rejects a forged selection", async () => {
    const db = fakeDb(); const saved = connected(); delete saved.selected; await db.keep(saved);
    vi.stubGlobal("fetch", vi.fn(async () => connectionsResponse()));
    expect((await call("organisations")).status).toBe(200);
    expect((await call("select", { connection_id: OTHER })).status).toBe(409);
    expect((await loadXero(env, db.db, COMPANY)).selected).toBeUndefined();
  });
  it("selects the verified Demo Company, passing its tenant header, without financial operations", async () => {
    const db = fakeDb(); const saved = connected(); delete saved.selected; await db.keep(saved);
    const http = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method ?? "GET").toBe("GET");
      if (url.endsWith("/connections")) return connectionsResponse();
      expect(url).toBe("https://api.xero.com/api.xro/2.0/Organisation");
      expect((init.headers as Record<string, string>)["Xero-tenant-id"]).toBe(TENANT);
      return orgResponse();
    }); vi.stubGlobal("fetch", http);
    expect((await call("select", { connection_id: CONNECTION })).status).toBe(200);
    expect((await loadXero(env, db.db, COMPANY)).selected?.demo).toBe(true);
    expect(http).toHaveBeenCalledTimes(2);
  });
  it("fails closed for non-demo organisations by default", async () => {
    const db = fakeDb(); const saved = connected(); delete saved.selected; await db.keep(saved);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/connections") ? connectionsResponse() : orgResponse(false)));
    expect((await call("select", { connection_id: CONNECTION })).status).toBe(409);
    expect((await loadXero(env, db.db, COMPANY)).selected).toBeUndefined();
  });
  it("serialises refreshes across workers and persists rotation before allowing use", async () => {
    const db = fakeDb(); const saved = connected(); saved.token!.expires = 0; await db.keep(saved);
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const first = withXeroLease(db.db, COMPANY, async (lease) => xeroAccess(env, db.db, COMPANY, lease, await loadXero(env, db.db, COMPANY)));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await expect(withXeroLease(db.db, COMPANY, async () => "must not run")).rejects.toThrow("Another Xero");
    finish(tokenResponse()); expect(await first).toBe("fictional_rotated_access");
    expect((await loadXero(env, db.db, COMPANY)).token?.refresh).toBe("fictional_rotated_refresh");
    expect(db.leases.size).toBe(0);
  });
  it("does not return an unsaved rotated token, and releases the lease on database failure", async () => {
    const db = fakeDb(); const saved = connected(); saved.token!.expires = 0; await db.keep(saved); db.state.saveFails = true;
    vi.stubGlobal("fetch", vi.fn(async () => tokenResponse()));
    await expect(withXeroLease(db.db, COMPANY, async (lease) => xeroAccess(env, db.db, COMPANY, lease, saved))).rejects.toThrow("could not be saved safely");
    expect(db.leases.size).toBe(0);
    expect((await loadXero(env, db.db, COMPANY)).token?.refresh).toBe("fictional_refresh");
  });
  it("refuses stale fenced saves after a new lease is acquired", async () => {
    const db = fakeDb(); db.leases.set(COMPANY, "new-worker-lease");
    await expect(saveXero(env, db.db, COMPANY, "old-worker-lease", connected())).rejects.toThrow("could not be saved safely");
    expect(db.ciphertext.size).toBe(0);
  });
  it.each([401, 429, 500])("handles HTTP %i safely without automatic request replay", async (status) => {
    const db = fakeDb(); await db.keep(connected());
    const http = vi.fn(async () => new Response("fictional_sensitive_provider_response", { status })); vi.stubGlobal("fetch", http);
    const result = await call("check"); expect(result.status).toBeGreaterThanOrEqual(400);
    expect(await result.text()).not.toContain("fictional_sensitive"); expect(http).toHaveBeenCalledTimes(1);
  });
  it("handles a dropped network without losing or revoking its saved grant", async () => {
    const db = fakeDb(); await db.keep(connected());
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fictional_provider_body"); }));
    const response = await call("check"); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("fictional_provider_body");
    expect((await loadXero(env, db.db, COMPANY)).token?.refresh).toBe("fictional_refresh");
  });
  it("disconnects only the chosen tenant and supports local forgetting without provider calls", async () => {
    const db = fakeDb(); await db.keep(connected());
    const http = vi.fn(async (url: string, init: RequestInit) => { expect(url).toBe(`https://api.xero.com/connections/${CONNECTION}`); expect(init.method).toBe("DELETE"); return new Response(null, { status: 204 }); }); vi.stubGlobal("fetch", http);
    expect((await call("disconnect")).status).toBe(200); expect(http).toHaveBeenCalledTimes(1);
    expect((await loadXero(env, db.db, COMPANY)).token).toBeUndefined();
    await db.keep(connected()); http.mockClear();
    expect((await call("disconnect", { local_only: true })).status).toBe(200); expect(http).not.toHaveBeenCalled();
  });
  it("a disconnect invalidates a pending OAuth callback", async () => {
    fakeDb(); const { url, cookie } = await start();
    expect((await call("disconnect", { local_only: true })).status).toBe(200);
    expect((await callback(url, cookie)).headers.get("location")).toContain("error");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows local forgetting even after server credentials are removed", async () => {
    const db = fakeDb(); await db.keep(connected());
    expect((await call("disconnect", { local_only: true }, "POST", { ...env, XERO_ENABLED: undefined, XERO_CLIENT_SECRET: undefined })).status).toBe(200);
    expect((await loadXero(env, db.db, COMPANY)).token).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("stores one company's settings without overwriting another company's encrypted state", async () => {
    const db = fakeDb(); await db.keep(connected(), OTHER);
    expect((await call("settings", { mode: "demo", paused: true }, "PUT")).status).toBe(200);
    expect((await decryptJson<XeroState>(env, db.ciphertext.get(OTHER)!)).mode).toBe("read_only");
  });
});
