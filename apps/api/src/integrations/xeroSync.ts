/** On-demand, owner-reviewed Demo contacts. All durable details live encrypted in Xero state. */
import { z } from "zod";
import type { Env } from "../env";
import type { Db } from "../lib/supabase";
import { HttpError } from "../lib/http";
import { decryptJson, encryptJson } from "../lib/crypto";
import { loadXero, saveXero, xeroAccess, xeroOrganisation, type XeroState } from "./xero";
import { canonical, changedFields, contactNumber, contactSchema, digest, localProjection, matchCandidates, remoteContactSchema, remotePayload, remoteProjection, type ContactProjection, type LocalContact, type RemoteContact } from "./xeroModel";
export interface SyncSettings {
    paused: boolean;
    incoming: boolean;
    outgoing: boolean;
    basis: "Inclusive" | "Exclusive" | "NoTax";
    revenue: string | null;
    bank: string | null;
    clearing: string | null;
    tax: string | null;
}
export const defaultSyncSettings = (): SyncSettings => ({ paused: true, incoming: false, outgoing: false, basis: "Exclusive", revenue: null, bank: null, clearing: null, tax: null });
export const syncSettingsSchema = z.object({ paused: z.boolean(), incoming: z.boolean(), outgoing: z.boolean(), basis: z.enum(["Inclusive", "Exclusive", "NoTax"]), revenue: z.string().uuid().nullable(), bank: z.string().uuid().nullable(), clearing: z.string().uuid().nullable(), tax: z.string().max(50).nullable() }).strict();
const providerBoolean = z.union([z.boolean(), z.enum(["true", "false"]).transform(v => v === "true")]);
const accountSchema = z.object({ AccountID: z.string().uuid(), Code: z.string().max(50).optional(), Name: z.string().max(255), Type: z.string().max(30), Status: z.string().max(30).optional(), CurrencyCode: z.string().max(3).optional(), TaxType: z.string().max(50).optional(), EnablePaymentsToAccount: providerBoolean.optional(), SystemAccount: z.string().nullish() });
const taxSchema = z.object({ TaxType: z.string().max(50), Name: z.string().max(255), Status: z.string().optional(), CanApplyToRevenue: providerBoolean, EffectiveRate: z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)]).pipe(z.number().finite().min(0).max(100)) });
export interface Catalogue {
    accounts: z.infer<typeof accountSchema>[];
    taxes: z.infer<typeof taxSchema>[];
    currency: "NZD";
    fetched_at: string;
    period_lock: string | null;
    year_lock: string | null;
}
interface Baseline {
    local: ContactProjection;
    remote: ContactProjection;
}
interface Link {
    local_id: string;
    remote_id: string;
    baseline: string;
    last_operation: string;
    origin: "crm" | "xero" | "matched";
}
interface History {
    operation_id: string;
    direction: string;
    outcome: string;
    code: string;
    created_at: string;
}
interface Inventory {
    clients: LocalContact[];
    links: Link[];
    history: History[];
}
interface Preview {
    id: string;
    direction: "incoming" | "outgoing";
    created_at: number;
    rows: PreviewRow[];
}
interface PreviewRow {
    id: string;
    local: LocalContact | null;
    remote: RemoteContact | null;
    localProjection?: ContactProjection;
    remoteProjection?: ContactProjection;
    baseline?: Baseline;
    candidateLocals?: LocalContact[];
    candidateRemotes?: RemoteContact[];
    candidates: Array<{
        id: string;
        name: string;
        evidence: string[];
    }>;
    action: "create" | "update" | "unchanged" | "review" | "conflict" | "blocked";
    fields: string[];
    reason?: string;
}
interface Pending {
    id: string;
    direction: "incoming" | "outgoing";
    localId: string;
    remoteId?: string;
    created_at: number;
    request: unknown;
    expected: LocalContact | null;
    target: ContactProjection;
    baseline: Baseline;
    origin: "crm" | "xero" | "matched";
    reviewed: string[];
}
export interface TenantSync {
    settings: SyncSettings;
    catalogue?: Catalogue;
    preview?: Preview;
    pending?: Pending;
    calls: number[];
    retry_at?: number;
}
export interface XeroSyncState {
    tenants: Record<string, TenantSync>;
}
export const pauseXeroSync = (state: XeroState) => { for (const t of Object.values(state.sync?.tenants ?? {})) {
    t.settings.paused = true;
    delete t.preview;
} };
export const tenantSync = (state: XeroState): TenantSync => {
    if (!state.selected)
        throw new HttpError(409, "Choose the Demo Company first.");
    state.sync ??= { tenants: {} };
    return state.sync.tenants[state.selected.tenantId] ??= ({ settings: defaultSyncSettings(), calls: [] });
};
export function syncStatus(state: XeroState) {
    const t = state.selected ? state.sync?.tenants[state.selected.tenantId] : undefined;
    return { settings: t?.settings ?? defaultSyncSettings(), contact_permission: state.token?.scopes.split(" ").includes("accounting.contacts") ?? false,
        catalogue: t?.catalogue ?? null, pending: t?.pending ? { id: t.pending.id, direction: t.pending.direction, created_at: new Date(t.pending.created_at).toISOString() } : null,
        retry_at: t?.retry_at ? new Date(t.retry_at).toISOString() : null, ai_policy: "Company AI is blocked after Xero contacts are imported, until provenance filtering is implemented." };
}
/** Single typed boundary for additive service-role RPCs, pending regenerated schema types. */
export async function syncRpc<T>(db: Db, name: string, args: Record<string, unknown>): Promise<T> {
    const result = await (db as unknown as {
        rpc(n: string, a: Record<string, unknown>): PromiseLike<{
            data: unknown;
            error: {
                code?: string;
            } | null;
        }>;
    }).rpc(name, args);
    if (result.error)
        throw new HttpError(result.error.code === "40001" || result.error.code === "23505" ? 409 : 503, "Xero sync could not be saved safely. Refresh the preview and review the latest state.");
    return result.data as T;
}
export class SyncFailure extends HttpError {
    constructor(readonly code: string, readonly uncertain: boolean, status: 400 | 409 | 429 | 503, message: string) { super(status, message); }
}
export interface SyncContext {
    env: Env;
    db: Db;
    company: string;
    lease: string;
    state: XeroState;
    t: TenantSync;
    token: string;
    started: number;
}
const persist = (ctx: SyncContext) => saveXero(ctx.env, ctx.db, ctx.company, ctx.lease, ctx.state);
export async function syncContext(env: Env, db: Db, company: string, lease: string, contacts = false): Promise<SyncContext> {
    const state = await loadXero(env, db, company);
    if (state.mode !== "demo" || !state.selected?.demo)
        throw new HttpError(409, "Customer sync is restricted to Xero Demo Company in Demo mode.");
    const token = await xeroAccess(env, db, company, lease, state);
    if (contacts && !state.token!.scopes.split(" ").includes("accounting.contacts"))
        throw new HttpError(409, "Reconnect to grant contact permission before previewing or syncing customers.");
    if (!await xeroOrganisation(token, state.selected.tenantId))
        throw new HttpError(409, "Xero did not confirm a Demo Company. No sync was performed.");
    return { env, db, company, lease, state, t: tenantSync(state), token, started: Date.now() };
}
/** Fixed endpoint constructors only; no user-supplied URLs, bank details or provider error bodies. */
async function request(ctx: SyncContext, path: string, body?: unknown, key?: string): Promise<unknown> {
    if (!/^(Organisation|Accounts|TaxRates|Contacts(?:\/[0-9a-f-]{36})?)(?:\?[^#]*)?$/i.test(path))
        throw new HttpError(400, "Unsupported Xero resource.");
    if (Date.now() - ctx.started > 65000)
        throw new SyncFailure("work_budget", false, 409, "This preview exceeded its work budget. Try a smaller organisation or resume after review.");
    const now = Date.now();
    ctx.t.calls = ctx.t.calls.filter(t => t > now - 86400000);
    const minute = ctx.t.calls.filter(t => t > now - 60000);
    if ((ctx.t.retry_at ?? 0) > now || minute.length >= 50 || ctx.t.calls.length >= 950) {
        ctx.t.retry_at = Math.max(ctx.t.retry_at ?? 0, minute.length >= 50 ? minute[0]! + 60000 : ctx.t.calls.length >= 950 ? ctx.t.calls[0]! + 86400000 : now);
        await persist(ctx);
        throw new SyncFailure("rate_limit", false, 429, "Xero calls are paused for the rate limit. Wait until the retry time shown.");
    }
    ctx.t.calls.push(now);
    await persist(ctx);
    let response: Response;
    try {
        response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${ctx.token}`, "Xero-tenant-id": ctx.state.selected!.tenantId, Accept: "application/json", ...(body ? { "Content-Type": "application/json", "Idempotency-Key": key! } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(15000) });
    }
    catch {
        throw new SyncFailure("network", Boolean(body), 503, "Xero did not respond. A submitted change may need reconciliation before retrying.");
    }
    if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        ctx.t.retry_at = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) : 60) * 1000;
        await persist(ctx);
        throw new SyncFailure("rate_limit", false, 429, "Xero's request limit was reached. Wait until the retry time shown.");
    }
    if (!response.ok)
        throw new SyncFailure(response.status === 400 ? "validation" : response.status === 401 || response.status === 403 ? "permission" : "provider", Boolean(body) && response.status >= 500, response.status === 400 ? 400 : response.status === 401 || response.status === 403 ? 409 : 503, "Xero could not complete this operation. Check permissions or review the customer fields; no provider details were exposed.");
    try {
        return await response.json();
    }
    catch {
        throw new SyncFailure("response", Boolean(body), 503, "Xero returned an unreadable result. Reconcile a submitted change before retrying.");
    }
}
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const r = schema.safeParse(value); if (!r.success)
    throw new HttpError(409, "Xero returned fields that need review before syncing. No records were applied."); return r.data; };
export async function loadCatalogue(ctx: SyncContext): Promise<Catalogue> {
    const org = parse(z.object({ Organisations: z.array(z.object({ OrganisationID: z.string().uuid(), IsDemoCompany: z.boolean(), BaseCurrency: z.string(), PeriodLockDate: z.string().nullish(), EndOfYearLockDate: z.string().nullish() })).length(1) }), await request(ctx, "Organisation")).Organisations[0]!;
    if (org.OrganisationID !== ctx.state.selected!.tenantId || !org.IsDemoCompany || org.BaseCurrency !== "NZD")
        throw new HttpError(409, "This stage requires the New Zealand Demo Company with NZD base currency.");
    const accounts = parse(z.object({ Accounts: z.array(accountSchema) }), await request(ctx, "Accounts")).Accounts;
    const taxes = parse(z.object({ TaxRates: z.array(taxSchema) }), await request(ctx, "TaxRates")).TaxRates;
    return ctx.t.catalogue = { accounts, taxes, currency: "NZD", fetched_at: new Date().toISOString(), period_lock: org.PeriodLockDate ?? null, year_lock: org.EndOfYearLockDate ?? null };
}
export function validateMappings(settings: SyncSettings, c: Catalogue) {
    const active = (id: string | null) => id ? c.accounts.find(a => a.AccountID === id && a.Status === "ACTIVE") : undefined;
    if (settings.revenue && !active(settings.revenue))
        throw new HttpError(409, "The revenue account is no longer active.");
    if (settings.revenue && !['REVENUE', 'SALES'].includes(active(settings.revenue)!.Type))
        throw new HttpError(400, "Choose an active sales or revenue account.");
    if (settings.bank && !(active(settings.bank)?.Type === "BANK" && (!active(settings.bank)?.CurrencyCode || active(settings.bank)?.CurrencyCode === "NZD")))
        throw new HttpError(400, "Choose an active NZD bank account.");
    if (settings.clearing && !(active(settings.clearing)?.Type === "BANK" && (!active(settings.clearing)?.CurrencyCode || active(settings.clearing)?.CurrencyCode === "NZD") || active(settings.clearing)?.Type !== "BANK" && active(settings.clearing)?.EnablePaymentsToAccount))
        throw new HttpError(400, "Choose an active NZD bank or payment-enabled clearing account.");
    if (settings.tax && !c.taxes.some(t => t.TaxType === settings.tax && t.Status === "ACTIVE" && t.CanApplyToRevenue))
        throw new HttpError(400, "Choose an active GST/tax rate that can apply to revenue.");
}
async function contacts(ctx: SyncContext): Promise<RemoteContact[]> {
    const all: RemoteContact[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 20; page++) {
        const values = parse(z.object({ Contacts: z.array(remoteContactSchema) }), await request(ctx, `Contacts?page=${page}&pageSize=100&includeArchived=true&order=ContactID`)).Contacts;
        for (const c of values) {
            if (seen.has(c.ContactID))
                throw new HttpError(409, "Xero changed during paging. Refresh the preview; no records were applied.");
            seen.add(c.ContactID);
            all.push(c);
        }
        if (values.length < 100)
            return all;
    }
    throw new HttpError(409, "The complete customer list exceeds this stage's preview limit. No matches or creates were assumed from a partial list.");
}
const inventory = (ctx: SyncContext) => syncRpc<Inventory>(ctx.db, "xero_sync_read", { p_company: ctx.company, p_lease: ctx.lease, p_tenant: ctx.state.selected!.tenantId });
const history = (ctx: SyncContext, id: string, direction: string, outcome: string, code: string) => syncRpc(ctx.db, "xero_sync_history", { p_company: ctx.company, p_tenant: ctx.state.selected!.tenantId, p_lease: ctx.lease, p_operation: id, p_direction: direction, p_outcome: outcome, p_code: code });
async function baseline(ctx: SyncContext, link: Link): Promise<Baseline> { try {
    return await decryptJson<Baseline>(ctx.env, link.baseline);
}
catch {
    throw new HttpError(503, "The saved customer comparison could not be read safely.");
} }
const safeProjection = (remote: RemoteContact) => { try {
    return remoteProjection(remote);
}
catch {
    throw new HttpError(409, "This contact has unsupported or restricted fields, address lines, contact people or payment terms. Review it before syncing.");
} };
const safeLocal = (local: LocalContact) => { try {
    return localProjection(local);
}
catch {
    throw new HttpError(409, "This CRM customer has fields or too many contact people for Xero. Review it before syncing.");
} };
const usable = (ctx: SyncContext, direction: "incoming" | "outgoing") => { if (ctx.t.settings.paused || !ctx.t.settings[direction])
    throw new HttpError(409, "Contact sync is paused or this direction is disabled."); };
export async function previewContacts(ctx: SyncContext, direction: "incoming" | "outgoing") {
    if (ctx.t.pending)
        throw new HttpError(409, "Reconcile the uncertain operation before preparing another preview.");
    const inv = await inventory(ctx);
    const remotes = await contacts(ctx);
    const rows: PreviewRow[] = [];
    const sources = direction === "incoming" ? remotes : inv.clients;
    for (const source of sources) {
        const remoteSource = direction === "incoming" ? source as RemoteContact : null;
        const localSource = direction === "outgoing" ? source as LocalContact : null;
        const link = inv.links.find(l => direction === "incoming" ? l.remote_id === remoteSource!.ContactID : l.local_id === localSource!.id);
        const local = localSource ?? (link ? inv.clients.find(c => c.id === link.local_id) ?? null : null);
        const remote = remoteSource ?? (link ? remotes.find(c => c.ContactID === link.remote_id) ?? null : null);
        const row: PreviewRow = { id: crypto.randomUUID(), local, remote, candidates: [], action: "create", fields: [] };
        try {
            if (local)
                row.localProjection = safeLocal(local);
            if (remote)
                row.remoteProjection = safeProjection(remote);
            if (link) {
                if (!local || !remote)
                    throw new HttpError(409, "A mapped customer is missing. Review its identity instead of recreating it.");
                row.baseline = await baseline(ctx, link);
                const lc = changedFields(row.baseline.local, row.localProjection!);
                const rc = changedFields(row.baseline.remote, row.remoteProjection!);
                row.fields = direction === "incoming" ? rc : lc;
                const conflict = lc.filter(k => rc.includes(k) && canonical(row.localProjection![k as keyof ContactProjection]) !== canonical(row.remoteProjection![k as keyof ContactProjection]));
                row.action = conflict.length ? "conflict" : row.fields.length ? "update" : "unchanged";
                if (conflict.length) {
                    row.fields = conflict;
                    row.reason = "Both systems changed these fields. Review and choose the incoming or outgoing version explicitly.";
                }
            }
            else {
                const candidatePool = direction === "incoming" ? inv.clients.filter(c => !inv.links.some(l => l.local_id === c.id)).map(c => ({ id: c.id, contact: safeLocal(c) }))
                    : remotes.filter(c => !inv.links.some(l => l.remote_id === c.ContactID)).flatMap(c => { try {
                        return [{ id: c.ContactID, contact: safeProjection(c) }];
                    }
                    catch {
                        return [];
                    } });
                const candidates = matchCandidates(direction === "incoming" ? row.remoteProjection! : row.localProjection!, candidatePool);
                const reserved = localSource ? remotes.filter(c => c.ContactNumber === contactNumber(localSource.id)) : [];
                row.candidates = candidates.map(c => ({ ...c, name: direction === "incoming" ? inv.clients.find(l => l.id === c.id)!.display_name : remotes.find(r => r.ContactID === c.id)!.Name }));
                for (const r of reserved)
                    if (!row.candidates.some(c => c.id === r.ContactID))
                        row.candidates.push({ id: r.ContactID, name: r.Name, evidence: ["reserved contact code"] });
                if (remoteSource)
                    for (const c of inv.clients.filter(c => remoteSource.ContactNumber === contactNumber(c.id))) {
                        const existing = row.candidates.find(x => x.id === c.id);
                        if (existing)
                            existing.evidence.push("reserved contact code");
                        else
                            row.candidates.push({ id: c.id, name: c.display_name, evidence: ["reserved contact code"] });
                    }
                row.candidateLocals = inv.clients.filter(c => row.candidates.some(x => x.id === c.id));
                row.candidateRemotes = remotes.filter(c => row.candidates.some(x => x.id === c.ContactID));
                if (row.candidates.length)
                    row.action = "review";
                if (remoteSource?.IsSupplier && !remoteSource.IsCustomer && !row.candidates.length)
                    continue;
            }
        }
        catch (e) {
            row.action = "blocked";
            row.reason = e instanceof HttpError ? e.message : "This contact needs field review before syncing.";
        }
        rows.push(row);
    }
    ctx.t.preview = { id: crypto.randomUUID(), direction, created_at: Date.now(), rows };
    await persist(ctx);
    return previewPage(ctx, 0);
}
export function previewPage(ctx: Pick<SyncContext, "t">, page: number) {
    const p = ctx.t.preview;
    if (!p)
        return null;
    return { id: p.id, direction: p.direction, created_at: new Date(p.created_at).toISOString(), total: p.rows.length, page,
        rows: p.rows.slice(page * 25, page * 25 + 25).map(r => ({ id: r.id, action: r.action, name: r.local?.display_name ?? r.remote?.Name ?? "Customer", local: r.localProjection ?? null, remote: r.remoteProjection ?? null, candidates: r.candidates.map(c => ({ ...c, contact: r.candidateLocals?.some(l => l.id === c.id) ? safeLocal(r.candidateLocals.find(l => l.id === c.id)!) : safeProjection(r.candidateRemotes!.find(x => x.ContactID === c.id)!) })), fields: r.fields, reason: r.reason ?? null })) };
}
export const applySchema = z.object({ preview_id: z.string().uuid(), row_id: z.string().uuid(), candidate_id: z.string().uuid().optional(), create_separate: z.boolean().default(false), resolve: z.boolean().default(false) }).strict();
export async function applyContact(ctx: SyncContext, input: z.infer<typeof applySchema>) {
    const preview = ctx.t.preview;
    if (!preview || preview.id !== input.preview_id || Date.now() - preview.created_at > 900000)
        throw new HttpError(409, "This preview expired. Prepare a fresh preview.");
    usable(ctx, preview.direction);
    if (ctx.t.pending)
        throw new HttpError(409, "Reconcile the uncertain operation first.");
    const row = preview.rows.find(r => r.id === input.row_id);
    if (!row || row.action === "blocked")
        throw new HttpError(409, "This customer is not ready to apply.");
    if (row.action === "unchanged")
        return { ok: true, unchanged: true };
    if (row.action === "conflict" && !input.resolve)
        throw new HttpError(409, "Review both versions and explicitly resolve the conflict.");
    const inv = await inventory(ctx);
    let local = row.local;
    let remote = row.remote;
    if (row.candidates.length) {
        if (input.candidate_id && !row.candidates.some(c => c.id === input.candidate_id))
            throw new HttpError(409, "Choose a match from this preview.");
        if (!input.candidate_id && !input.create_separate)
            throw new HttpError(409, "Review the possible matches before creating another customer.");
        if (input.create_separate && row.candidates.some(c => c.evidence.includes("reserved contact code")))
            throw new HttpError(409, "An existing contact has this customer's durable code. Link it instead of creating a duplicate.");
        if (input.candidate_id) {
            if (preview.direction === "incoming")
                local = row.candidateLocals?.find(c => c.id === input.candidate_id) ?? null;
            else
                remote = row.candidateRemotes?.find(c => c.ContactID === input.candidate_id) ?? null;
        }
    }
    if (local && canonical(inv.clients.find(c => c.id === local!.id)) !== canonical(local))
        throw new HttpError(409, "The CRM customer changed. Refresh the preview.");
    if (remote) {
        const current = parse(z.object({ Contacts: z.array(remoteContactSchema).length(1) }), await request(ctx, `Contacts/${remote.ContactID}`)).Contacts[0]!;
        if (canonical(current) !== canonical(remote))
            throw new HttpError(409, "The Xero customer changed. Refresh the preview.");
        remote = current;
    }
    const lp = local ? safeLocal(local) : null;
    const rp = remote ? safeProjection(remote) : null;
    const source = preview.direction === "incoming" ? rp : lp;
    if (!source)
        throw new HttpError(409, "Customer source is missing.");
    const target = { ...source };
    const existingLink = inv.links.find(l => local && l.local_id === local.id || remote && l.remote_id === remote.ContactID);
    if (existingLink && (!local || !remote || existingLink.local_id !== local.id || existingLink.remote_id !== remote.ContactID))
        throw new HttpError(409, "That identity is already mapped to another customer.");
    let nextBaseline: Baseline = { local: target, remote: target };
    if (row.baseline && !input.resolve) {
        const fields = preview.direction === "incoming" ? changedFields(row.baseline.remote, rp!) : changedFields(row.baseline.local, lp!);
        Object.assign(target, preview.direction === "incoming" ? lp : rp);
        for (const field of fields)
            (target as unknown as Record<string, unknown>)[field] = source[field as keyof ContactProjection];
        nextBaseline = preview.direction === "incoming" ? { local: { ...row.baseline.local, ...Object.fromEntries(fields.map(k => [k, target[k as keyof ContactProjection]])) }, remote: rp! }
            : { local: lp!, remote: { ...row.baseline.remote, ...Object.fromEntries(fields.map(k => [k, target[k as keyof ContactProjection]])) } };
    }
    if (preview.direction === "incoming" && local?.people.some(p => !target.people.some(q => (q.email && q.email.toLowerCase() === p.email?.toLowerCase()) || q.name.toLowerCase() === p.name.toLowerCase())))
        throw new HttpError(409, "CRM has an additional contact person. Review that person before importing this version.");
    if (preview.direction === "outgoing" && rp?.payment_terms_days !== null && target.payment_terms_days === null)
        throw new HttpError(409, "Clearing an existing Xero payment-term rule needs manual review.");
    const localId = local?.id ?? crypto.randomUUID();
    if (preview.direction === "outgoing" && !remote) {
        const current = await contacts(ctx); // A contact may have appeared since the original preview.
        const possible = matchCandidates(target, current.flatMap(r => { try {
            return [{ id: r.ContactID, contact: safeProjection(r) }];
        }
        catch {
            return [];
        } }));
        if (current.some(r => r.ContactNumber === contactNumber(localId)) || possible.some(c => !input.create_separate || !row.candidates.some(old => old.id === c.id)))
            throw new HttpError(409, "A possible existing Xero customer appeared or changed. Refresh the matching preview before creating.");
    }
    const payload = preview.direction === "outgoing" ? (() => { try {
        return { Contacts: [remotePayload(target, localId, remote ?? undefined)] };
    }
    catch {
        throw new HttpError(409, "Export would remove an existing Xero person. Review contact people first.");
    } })() : target;
    const pending: Pending = { id: crypto.randomUUID(), direction: preview.direction, localId, remoteId: remote?.ContactID, created_at: Date.now(), request: payload, expected: local, target, baseline: nextBaseline, origin: existingLink?.origin ?? (local && remote ? "matched" : preview.direction === "incoming" ? "xero" : "crm"), reviewed: input.create_separate && preview.direction === "incoming" ? row.candidates.map(c => c.id) : [] };
    ctx.t.pending = pending;
    await persist(ctx); // Durable identity BEFORE any remote write/local apply.
    try {
        let remoteId = remote?.ContactID;
        if (preview.direction === "outgoing") {
            usable(ctx, "outgoing");
            const result = parse(z.object({ Contacts: z.array(remoteContactSchema.extend({ HasValidationErrors: z.boolean().optional() })).length(1) }), await request(ctx, "Contacts", payload, pending.id));
            if (result.Contacts[0]!.HasValidationErrors)
                throw new SyncFailure("validation", false, 400, "Xero rejected a customer field. Review it before retrying.");
            remoteId = result.Contacts[0]!.ContactID;
        }
        if (!remoteId)
            throw new HttpError(409, "Xero did not confirm the customer's identity.");
        usable(ctx, preview.direction);
        await saveApplied(ctx, pending, remoteId);
        delete ctx.t.pending;
        delete ctx.t.preview;
        await persist(ctx);
        return { ok: true };
    }
    catch (e) {
        const uncertain = preview.direction === "outgoing" && (!(e instanceof SyncFailure) || e.uncertain);
        if (!uncertain) {
            delete ctx.t.pending;
            await persist(ctx);
        }
        await history(ctx, pending.id, preview.direction, uncertain ? "uncertain" : "failed", e instanceof SyncFailure ? e.code : "save_failed");
        throw e;
    }
}
async function saveApplied(ctx: SyncContext, p: Pending, remoteId: string) {
    return syncRpc<LocalContact>(ctx.db, "xero_sync_apply_contact", { p_company: ctx.company, p_lease: ctx.lease, p_tenant: ctx.state.selected!.tenantId, p_local: p.localId, p_remote: remoteId,
        p_expected: p.expected, p_contact: p.direction === "incoming" ? p.target : null, p_baseline: await encryptJson(ctx.env, p.baseline), p_operation: p.id, p_origin: p.origin, p_reviewed: p.reviewed ?? [] });
}
export async function reconcileContact(ctx: SyncContext) {
    const p = ctx.t.pending;
    if (!p)
        return { ok: true };
    const inv = await inventory(ctx);
    if (inv.links.some(l => l.last_operation === p.id)) {
        await history(ctx, p.id, p.direction, "reconciled", "contact_reconciled");
        delete ctx.t.pending;
        delete ctx.t.preview;
        await persist(ctx);
        return { ok: true, recovered: true };
    }
    if (p.direction === "incoming") {
        // Atomic local RPC either committed its mapping or rolled back. Revalidate via a new preview.
        delete ctx.t.pending;
        delete ctx.t.preview;
        await history(ctx, p.id, "incoming", "failed", "local_rollback");
        await persist(ctx);
        return { ok: true };
    }
    const found = parse(z.object({ Contacts: z.array(remoteContactSchema) }), await request(ctx, p.remoteId ? `Contacts/${p.remoteId}` : `Contacts?where=${encodeURIComponent(`ContactNumber=="${contactNumber(p.localId)}"`)}&includeArchived=true&page=1&pageSize=100`)).Contacts;
    if (found.length !== 1 || canonical(safeProjection(found[0]!)) !== canonical(p.target))
        throw new HttpError(409, "The uncertain write cannot be confirmed. Leave it blocked and review Xero; no create was retried.");
    // Reconciliation only repairs the identity map; it does not issue another remote write or
    // change customer fields. Preserve any newer local edits as differences from the old baseline.
    p.expected = inv.clients.find(c => c.id === p.localId) ?? null;
    if (!p.expected)
        throw new HttpError(409, "The local customer is missing. Review this uncertain operation manually.");
    await saveApplied(ctx, p, found[0]!.ContactID);
    await history(ctx, p.id, "outgoing", "reconciled", "contact_reconciled");
    delete ctx.t.pending;
    delete ctx.t.preview;
    await persist(ctx);
    return { ok: true, recovered: true };
}
export const readSyncHistory = async (ctx: SyncContext) => (await inventory(ctx)).history;
export const saveSyncContext = persist;
