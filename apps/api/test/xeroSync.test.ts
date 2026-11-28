/** Engine behaviour with fictional data and intercepted HTTP. SQL invariants have real SQL tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/lib/supabase";
import type { Env } from "../src/env";
import { newXeroState, XERO_SCOPES } from "../src/integrations/xero";
import { applyContact, defaultSyncSettings, loadCatalogue, previewContacts, reconcileContact, tenantSync, validateMappings, type SyncContext } from "../src/integrations/xeroSync";
import { contactNumber, localProjection, remoteContactSchema, type LocalContact } from "../src/integrations/xeroModel";
const COMPANY = "00000000-0000-4000-8000-000000000001", TENANT = "00000000-0000-4000-8000-000000000002", LOCAL = "00000000-0000-4000-8000-000000000003", REMOTE = "00000000-0000-4000-8000-000000000004";
const env: Env = { SUPABASE_URL: "https://db.example.test", APP_URL: "https://crm.example.test", ENCRYPTION_KEY: "fictional-encryption-key-for-sync-tests-only", XERO_ENABLED: "true", XERO_CLIENT_ID: "fictional_client", XERO_CLIENT_SECRET: "fictional_secret", XERO_REDIRECT_URI: "https://crm.example.test/api/apps/xero/callback" };
const client = (extra: Partial<LocalContact> = {}): LocalContact => ({ id: LOCAL, updated_at: "2026-01-01T00:00:00.000Z", display_name: "Fictional Alpha", company_name: null, email: "alpha@example.test", phone: null, billing_address: {}, payment_terms_days: 30, status: "active", people: [], ...extra });
const contact = (extra: Record<string, unknown> = {}) => remoteContactSchema.parse({ ContactID: REMOTE, Name: "Fictional Alpha", EmailAddress: "alpha@example.test", ContactStatus: "ACTIVE", IsCustomer: true, PaymentTerms: { Sales: { Type: "DAYSAFTERBILLDATE", Day: 30 } }, ...extra });
function setup(initial: LocalContact[] = [], initialRemote: ReturnType<typeof contact>[] = []) {
    const inv = { clients: structuredClone(initial), links: [] as Array<any>, history: [] as Array<any> };
    let remote = structuredClone(initialRemote);
    let saved = "";
    let failApply = false;
    const calls: Array<{
        path: string;
        method: string;
        body: any;
        key: string | null;
    }> = [];
    const state = { ...newXeroState(), mode: "demo" as const, selected: { id: REMOTE, tenantId: TENANT, tenantName: "Fictional Demo", tenantType: "ORGANISATION" as const, demo: true }, token: { access: "fictional_access", refresh: "fictional_refresh", expires: Date.now() + 1800000, scopes: XERO_SCOPES } };
    const t = tenantSync(state);
    t.settings = { ...defaultSyncSettings(), paused: false, incoming: true, outgoing: true };
    const rpc = vi.fn(async (name: string, args: any) => {
        if (name === "xero_save_connection") {
            saved = args.p_ciphertext;
            return { data: null, error: null };
        }
        if (name === "xero_sync_read")
            return { data: structuredClone(inv), error: null };
        if (name === "xero_sync_history") {
            inv.history.push(args);
            return { data: null, error: null };
        }
        if (name === "xero_sync_apply_contact") {
            if (failApply)
                return { data: null, error: { code: "40001" } };
            const old = inv.clients.find(c => c.id === args.p_local);
            if (args.p_contact) {
                const next = { ...(old ?? client({ id: args.p_local })), ...args.p_contact, people: args.p_contact.people.map((p: any) => ({ ...p, id: crypto.randomUUID(), updated_at: "2026-01-01T00:00:00.000Z", phone: null, role: null, notify_email: false, notify_sms: false, is_primary: false })) };
                if (old)
                    Object.assign(old, next);
                else
                    inv.clients.push(next);
            }
            const existing = inv.links.find(l => l.local_id === args.p_local);
            const link = { local_id: args.p_local, remote_id: args.p_remote, baseline: args.p_baseline, last_operation: args.p_operation, origin: args.p_origin };
            if (existing)
                Object.assign(existing, link);
            else
                inv.links.push(link);
            return { data: inv.clients.find(c => c.id === args.p_local), error: null };
        }
        return { data: null, error: { code: "unknown" } };
    });
    const ctx: SyncContext = { env, db: { rpc } as unknown as Db, company: COMPANY, lease: LOCAL, state, t, token: "fictional_access", started: Date.now() };
    let override: ((path: string, init: RequestInit) => Promise<Response> | Response) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
        const u = new URL(url);
        const body = init.body ? JSON.parse(String(init.body)) : null;
        const method = init.method ?? "GET";
        calls.push({ path: u.pathname + u.search, method, body, key: new Headers(init.headers).get("Idempotency-Key") });
        if (override)
            return override(u.pathname + u.search, init);
        if (method === "POST") {
            const c = contact({ ...body.Contacts[0], ContactID: body.Contacts[0].ContactID ?? REMOTE });
            remote = [...remote.filter(r => r.ContactID !== c.ContactID), c];
            return Response.json({ Contacts: [c] });
        }
        if (u.pathname.endsWith("/Accounts"))
            return Response.json({ Accounts: [{ AccountID: LOCAL, Code: "200", Name: "Fictional Sales", Type: "REVENUE", Status: "ACTIVE", BankAccountNumber: "do-not-retain" }, { AccountID: REMOTE, Code: "090", Name: "Fictional Bank", Type: "BANK", Status: "ACTIVE", CurrencyCode: "NZD", BankAccountNumber: "do-not-retain" }] });
        if (u.pathname.endsWith("/TaxRates"))
            return Response.json({ TaxRates: [{ TaxType: "OUTPUT2", Name: "Fictional GST Income", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: 15 }] });
        if (u.pathname.endsWith("/Organisation"))
            return Response.json({ Organisations: [{ OrganisationID: TENANT, IsDemoCompany: true, BaseCurrency: "NZD" }] });
        const id = u.pathname.split("/").at(-1);
        return Response.json({ Contacts: id === "Contacts" ? remote : remote.filter(c => c.ContactID === id) });
    }));
    return { ctx, inv, calls, rpc, get remote() { return remote; }, get saved() { return saved; }, setRemote: (r: typeof remote) => { remote = r; }, setOverride: (fn: typeof override) => { override = fn; }, setFailApply: (b: boolean) => { failApply = b; } };
}
afterEach(() => vi.unstubAllGlobals());
const input = (p: any, row = 0, extra: Record<string, unknown> = {}) => ({ preview_id: p.id, row_id: p.rows[row].id, create_separate: false, resolve: false, ...extra });
describe("reviewed customer identity", () => {
    it("creates a customer without payment terms without treating it as clearing existing terms", async () => {
        const f = setup([client({ payment_terms_days: null })]);
        await applyContact(f.ctx, input(await previewContacts(f.ctx, "outgoing")));
        expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1);
    });
    it("blocks a matching contact with unsupported terms instead of treating it as absent", async () => {
        const f = setup([client()], [contact({ PaymentTerms: { Sales: { Type: "OFFOLLOWINGMONTH", Day: 20 } } })]);
        const p = await previewContacts(f.ctx, "outgoing");
        expect(p!.rows[0].action).toBe("blocked");
        await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/not ready/);
        expect(f.calls.some(c => c.method === "POST")).toBe(false);
    });
    it("requires review for a name/email candidate rather than creating a duplicate", async () => { const f = setup([client()], [contact()]); const p = await previewContacts(f.ctx, "outgoing"); expect(p!.rows[0].action).toBe("review"); await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/Review the possible matches/); expect(f.calls.some(c => c.method === "POST")).toBe(false); });
    it("uses the reserved identity even when the name and email both changed", async () => { const f = setup([client()], [contact({ Name: "Old fictional name", EmailAddress: "old@example.test", ContactNumber: contactNumber(LOCAL) })]); const p = await previewContacts(f.ctx, "incoming"); expect(p!.rows[0].candidates[0].evidence).toContain("reserved contact code"); await expect(applyContact(f.ctx, input(p, 0, { create_separate: true }))).rejects.toThrow(/durable code/); });
    it("rejects a chosen candidate changed after the preview", async () => { const f = setup([client()], [contact()]); const p = await previewContacts(f.ctx, "outgoing"); f.setRemote([contact({ EmailAddress: "changed@example.test" })]); await expect(applyContact(f.ctx, input(p, 0, { candidate_id: REMOTE }))).rejects.toThrow(/Xero customer changed/); expect(f.calls.some(c => c.method === "POST")).toBe(false); });
    it("exports once, persists an encrypted baseline and is unchanged on a repeat preview", async () => { const f = setup([client()]); const p = await previewContacts(f.ctx, "outgoing"); await applyContact(f.ctx, input(p)); expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1); expect(f.calls.find(c => c.method === "POST")!.key).toMatch(/^[0-9a-f-]{36}$/); expect(f.inv.links).toHaveLength(1); expect(f.inv.links[0].baseline).not.toContain("alpha@example.test"); const repeat = await previewContacts(f.ctx, "outgoing"); expect(repeat!.rows[0].action).toBe("unchanged"); });
    it("imports once and a repeated preview does not create another customer", async () => { const f = setup([], [contact()]); const p = await previewContacts(f.ctx, "incoming"); await applyContact(f.ctx, input(p)); expect(f.inv.clients).toHaveLength(1); const repeat = await previewContacts(f.ctx, "incoming"); expect(repeat!.rows[0].action).toBe("unchanged"); expect(f.calls.every(c => c.method === "GET")).toBe(true); });
    it("rejects a local change after preview without contacting a write endpoint", async () => { const f = setup([client()]); const p = await previewContacts(f.ctx, "outgoing"); f.inv.clients[0].phone = "fictional new phone"; await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/CRM customer changed/); expect(f.calls.some(c => c.method === "POST")).toBe(false); });
    it.each(["paused", "incoming"])("rechecks the %s control before apply", async (field) => { const f = setup([], [contact()]); const p = await previewContacts(f.ctx, "incoming"); if (field === "paused")
        f.ctx.t.settings.paused = true;
    else
        f.ctx.t.settings.incoming = false; await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/paused|disabled/); expect(f.inv.clients).toHaveLength(0); });
    it("does not infer absence from a truncated contact scan", async () => { const f = setup([client()]); f.setOverride(path => Response.json({ Contacts: Array.from({ length: 100 }, (_, n) => contact({ ContactID: `00000000-0000-4000-8000-${String(Number(new URL('https://example.test' + path).searchParams.get('page')) * 100 + n).padStart(12, '0')}`, Name: `Fictional ${n}`, EmailAddress: null })) })); await expect(previewContacts(f.ctx, "outgoing")).rejects.toThrow(/complete customer list exceeds/); expect(f.calls.some(c => c.method === "POST")).toBe(false); });
});
describe("uncertain writes and bounded retries", () => {
    it("finds a newly appeared identity even when its other fields are unsupported", async () => {
        const f = setup([client()]);
        const p = await previewContacts(f.ctx, "outgoing");
        f.setRemote([contact({ Addresses: [{ AddressType: "POBOX", AddressLine3: "Extra unsupported line" }] })]);
        await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/existing Xero customer appeared/);
        expect(f.calls.some(c => c.method === "POST")).toBe(false);
    });
    it("rechecks the full identity list immediately before an outgoing create", async () => { const f = setup([client()]); const p = await previewContacts(f.ctx, "outgoing"); f.setRemote([contact()]); await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/existing Xero customer appeared/); expect(f.calls.some(c => c.method === "POST")).toBe(false); });
    it("preserves a disjoint local edit through an import and exports it on the next run", async () => {
        const f = setup([client()]);
        await applyContact(f.ctx, input(await previewContacts(f.ctx, "outgoing")));
        f.inv.clients[0].phone = "021 555 0199";
        f.setRemote([contact({ EmailAddress: "new@example.test", ContactNumber: contactNumber(LOCAL) })]);
        const incoming = await previewContacts(f.ctx, "incoming");
        expect(incoming!.rows[0].action).toBe("update");
        await applyContact(f.ctx, input(incoming));
        expect(f.inv.clients[0]).toMatchObject({ phone: "021 555 0199", email: "new@example.test" });
        const outgoing = await previewContacts(f.ctx, "outgoing");
        expect(outgoing!.rows[0]).toMatchObject({ action: "update", fields: ["phone"] });
        await applyContact(f.ctx, input(outgoing));
        expect((await previewContacts(f.ctx, "incoming"))!.rows[0].action).toBe("unchanged");
    });
    it("holds conflicting edits until the owner explicitly chooses a version", async () => {
        const f = setup([client()]);
        await applyContact(f.ctx, input(await previewContacts(f.ctx, "outgoing")));
        f.inv.clients[0].email = "local-edit@example.test";
        f.setRemote([contact({ EmailAddress: "remote-edit@example.test" })]);
        const p = await previewContacts(f.ctx, "incoming");
        expect(p!.rows[0].action).toBe("conflict");
        await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/explicitly resolve/);
        await applyContact(f.ctx, input(p, 0, { resolve: true }));
        expect(f.inv.clients[0].email).toBe("remote-edit@example.test");
    });
    it("records a lost create response and reconciles by its durable code without another POST", async () => { const f = setup([client()]); const p = await previewContacts(f.ctx, "outgoing"); f.setOverride((_path, init) => { if (init.method !== "POST")
        return Response.json({ Contacts: [] }); const body = JSON.parse(String(init.body)); f.setRemote([contact({ ...body.Contacts[0], ContactID: REMOTE })]); throw new Error("fictional lost response"); }); await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/did not respond/); expect(f.ctx.t.pending).toBeDefined(); await expect(previewContacts(f.ctx, "outgoing")).rejects.toThrow(/uncertain/); f.setOverride(undefined); await reconcileContact(f.ctx); expect(f.inv.links).toHaveLength(1); expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1); expect(f.ctx.t.pending).toBeUndefined(); });
    it("keeps an unconfirmed create blocked rather than retrying after the provider key expires", async () => { const f = setup([client()]); const p = await previewContacts(f.ctx, "outgoing"); f.setOverride((_path, init) => { if (init.method !== "POST")
        return Response.json({ Contacts: [] }); throw new Error("fictional timeout"); }); await expect(applyContact(f.ctx, input(p))).rejects.toThrow(); f.setOverride(undefined); f.ctx.t.pending!.created_at = Date.now() - 600000; await expect(reconcileContact(f.ctx)).rejects.toThrow(/cannot be confirmed/); expect(f.ctx.t.pending).toBeDefined(); expect(f.calls.filter(c => c.method === "POST")).toHaveLength(1); });
    it("reconciles after a mapping-save failure while preserving a newer local edit", async () => { const f = setup([client()]); const p = await previewContacts(f.ctx, "outgoing"); f.setFailApply(true); await expect(applyContact(f.ctx, input(p))).rejects.toThrow(/saved safely/); f.inv.clients[0].phone = "fictional later edit"; f.setFailApply(false); await reconcileContact(f.ctx); expect(f.inv.clients[0].phone).toBe("fictional later edit"); expect((await previewContacts(f.ctx, "outgoing"))!.rows[0].action).toBe("update"); });
    it("honours Retry-After and exposes no raw provider error content", async () => { const f = setup([client()]); f.setOverride(() => new Response('private provider response', { status: 429, headers: { 'Retry-After': '120' } })); await expect(previewContacts(f.ctx, "outgoing")).rejects.toThrow(/request limit/); expect(f.ctx.t.retry_at!).toBeGreaterThan(Date.now() + 119000); const count = f.calls.length; await expect(previewContacts(f.ctx, "outgoing")).rejects.toThrow(/rate limit/); expect(f.calls).toHaveLength(count); expect(f.saved).not.toContain("private provider response"); });
});
describe("accounting catalogue", () => {
    it("retrieves safe account/GST fields and discards bank account numbers", async () => { const f = setup(); const c = await loadCatalogue(f.ctx); expect(c.currency).toBe("NZD"); expect(c.taxes[0].EffectiveRate).toBe(15); expect(JSON.stringify(c)).not.toMatch(/BankAccountNumber|do-not-retain/); expect(f.calls.every(c => c.method === "GET")).toBe(true); });
    it("validates mappings against current account eligibility", async () => { const f = setup(); const c = await loadCatalogue(f.ctx); expect(() => validateMappings({ ...defaultSyncSettings(), revenue: LOCAL, bank: REMOTE, clearing: REMOTE, tax: "OUTPUT2" }, c)).not.toThrow(); expect(() => validateMappings({ ...defaultSyncSettings(), bank: LOCAL }, c)).toThrow(/bank account/); expect(() => validateMappings({ ...defaultSyncSettings(), revenue: REMOTE }, c)).toThrow(/revenue/); c.accounts[1].CurrencyCode = "USD"; expect(() => validateMappings({ ...defaultSyncSettings(), clearing: REMOTE }, c)).toThrow(/NZD/); });
    it("rejects a non-NZD or non-demo organisation before retrieving account data", async () => { const f = setup(); f.setOverride(() => Response.json({ Organisations: [{ OrganisationID: TENANT, IsDemoCompany: false, BaseCurrency: "USD" }] })); await expect(loadCatalogue(f.ctx)).rejects.toThrow(/New Zealand Demo Company/); expect(f.calls).toHaveLength(1); });
});
