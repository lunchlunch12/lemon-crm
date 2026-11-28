import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Section } from "@/components/ui/Section";
import { api } from "@/lib/api";
interface Settings {
    paused: boolean;
    incoming: boolean;
    outgoing: boolean;
    basis: "Inclusive" | "Exclusive" | "NoTax";
    revenue: string | null;
    bank: string | null;
    clearing: string | null;
    tax: string | null;
}
interface Catalogue {
    accounts: Array<{
        AccountID: string;
        Code?: string;
        Name: string;
        Type: string;
        Status?: string;
        CurrencyCode?: string;
        EnablePaymentsToAccount?: boolean;
    }>;
    taxes: Array<{
        TaxType: string;
        Name: string;
        Status?: string;
        CanApplyToRevenue: boolean;
        EffectiveRate: number;
    }>;
    currency: string;
    fetched_at: string;
}
export interface ContactSyncConfig {
    settings: Settings;
    contact_permission: boolean;
    catalogue: Catalogue | null;
    pending: {
        id: string;
        direction: string;
        created_at: string;
    } | null;
    retry_at: string | null;
    ai_policy: string;
}
type Projection = Record<string, unknown>;
interface Row {
    id: string;
    action: string;
    name: string;
    local: Projection | null;
    remote: Projection | null;
    fields: string[];
    reason: string | null;
    candidates: Array<{
        id: string;
        name: string;
        evidence: string[];
        contact: Projection;
    }>;
}
interface Preview {
    id: string;
    direction: "incoming" | "outgoing";
    created_at: string;
    total: number;
    page: number;
    rows: Row[];
}
const labels: Record<string, string> = { display_name: "Customer / person name", company_name: "Company", email: "Email", phone: "Phone", billing_address: "Billing address", payment_terms_days: "Payment terms (days)", status: "Status", people: "Additional people" };
function show(value: unknown): string {
    if (value == null || value === "")
        return "—";
    if (Array.isArray(value))
        return value.map(v => typeof v === "object" && v ? `${(v as {
            name?: string;
        }).name ?? ""} ${(v as {
            email?: string;
        }).email ?? ""}`.trim() : String(v)).join("; ") || "—";
    if (typeof value === "object")
        return Object.values(value).filter(Boolean).join(", ") || "—";
    return String(value);
}
function Comparison({ local, remote }: {
    local: Projection | null;
    remote: Projection | null;
}) {
    return <div role="region" aria-label="Customer field comparison" tabIndex={0} style={{ overflowX: "auto" }}><table><caption>Review the supported fields before applying</caption><thead><tr><th>Field</th><th>Lemon CRM</th><th>Xero</th></tr></thead><tbody>{Object.entries(labels).map(([key, label]) => <tr key={key}><th>{label}</th><td>{show(local?.[key])}</td><td>{show(remote?.[key])}</td></tr>)}</tbody></table></div>;
}
function ReviewRow({ row, preview, busy, enabled, onApply }: {
    row: Row;
    preview: Preview;
    busy: boolean;
    enabled: boolean;
    onApply: (body: object) => void;
}) {
    const [candidate, setCandidate] = useState("");
    const [separate, setSeparate] = useState(false);
    const [resolve, setResolve] = useState(false);
    const match = row.candidates.find(c => c.id === candidate);
    const reviewNeeded = row.candidates.length > 0;
    const canApply = enabled && !busy && !['blocked', 'unchanged'].includes(row.action) && (!reviewNeeded || Boolean(match) || separate) && (row.action !== "conflict" || resolve);
    return <article style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBlock: 12 }}>
    <h3>{row.name}</h3><p><strong>{row.action.replace(/_/g, " ")}</strong>{row.fields.length ? ` — ${row.fields.map(k => labels[k] ?? k).join(", ")}` : ""}</p>
    {row.reason && <p role={row.action === "blocked" ? "note" : undefined}>{row.reason}</p>}
    {reviewNeeded && <><Field label="Possible existing customer"><select value={candidate} disabled={busy || separate} onChange={e => setCandidate(e.target.value)}><option value="">Choose a match after reviewing</option>{row.candidates.map(c => <option key={c.id} value={c.id}>{c.name} ({c.evidence.join(", ") || "possible identity"})</option>)}</select></Field>
      {!row.candidates.some(c => c.evidence.includes("reserved contact code")) && <p><label><input type="checkbox" checked={separate} disabled={busy} onChange={e => { setSeparate(e.target.checked); setCandidate(""); }}/> I reviewed these matches; this is a separate customer</label></p>}</>}
    <Comparison local={preview.direction === "incoming" ? match?.contact ?? row.local : row.local} remote={preview.direction === "outgoing" ? match?.contact ?? row.remote : row.remote}/>
    {row.action === "conflict" && <p><label><input type="checkbox" checked={resolve} onChange={e => setResolve(e.target.checked)}/> I reviewed the conflict and choose the {preview.direction === "incoming" ? "Xero" : "Lemon CRM"} version</label></p>}
    <Button disabled={!canApply} onClick={() => onApply({ preview_id: preview.id, row_id: row.id, ...(candidate ? { candidate_id: candidate } : {}), create_separate: separate, resolve })}>{preview.direction === "incoming" ? "Import reviewed customer" : "Export reviewed customer"}</Button>
  </article>;
}
export function XeroContactsPanel({ data, onRefresh, companyId }: {
    data: ContactSyncConfig;
    onRefresh: () => Promise<unknown>;
    companyId: string;
}) {
    const [settings, setSettings] = useState(data.settings);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [message, setMessage] = useState("");
    const [quantity, setQuantity] = useState("1");
    const [price, setPrice] = useState("115");
    const [percent, setPercent] = useState("15");
    const [calculation, setCalculation] = useState<{
        net: number;
        tax: number;
        total: number;
    } | null>(null);
    const savedSettingsKey = JSON.stringify(data.settings);
    useEffect(() => setSettings(data.settings), [savedSettingsKey]);
    const history = useQuery({ queryKey: ["xero-history", companyId], queryFn: () => api.get<{
            history: Array<{
                operation_id: string;
                direction: string;
                outcome: string;
                code: string;
                created_at: string;
            }>;
        }>("/apps/xero/sync/history"), gcTime: 0 });
    const action = useMutation({ mutationFn: async ({ path, body = {} }: {
            path: string;
            body?: object;
        }) => {
            setMessage("");
            if (path === "settings") {
                await api.put("/apps/xero/sync/settings", body);
                setPreview(null);
                setMessage("Contact sync controls saved.");
            }
            else if (path === "preview") {
                setPreview(await api.post<Preview>("/apps/xero/sync/preview", body));
            }
            else if (path === "pricing") {
                setCalculation(await api.post("/apps/xero/sync/pricing", body));
            }
            else {
                await api.post(`/apps/xero/sync/${path}`, body);
                if (path === "apply" || path === "reconcile") {
                    setPreview(null);
                    setMessage("Operation completed. Prepare a fresh preview to verify the result.");
                }
            }
            await onRefresh();
            await history.refetch();
        } });
    const busy = action.isPending;
    const c = data.catalogue;
    const accounts = c?.accounts.filter(a => a.Status === "ACTIVE") ?? [];
    const accountField = (label: string, key: "revenue" | "bank" | "clearing", eligible: typeof accounts) => <Field label={label}><select value={settings[key] ?? ""} disabled={busy} onChange={e => setSettings({ ...settings, [key]: e.target.value || null })}><option value="">Not mapped</option>{eligible.map(a => <option key={a.AccountID} value={a.AccountID}>{a.Code ? `${a.Code} — ` : ""}{a.Name}</option>)}</select></Field>;
    return <>
    <Section title="Customer synchronisation">
      <p>Demo Company only. Preview each change and review existing matches. This stage does not synchronise invoices, payments or send customer messages.</p>
      {!data.contact_permission && <p role="note">Reconnect to Xero to grant customer/contact permission. Connection checks still work with your earlier permission.</p>}
      <p><label><input type="checkbox" checked={settings.paused} disabled={busy} onChange={e => setSettings({ ...settings, paused: e.target.checked })}/> Pause all customer synchronisation</label></p>
      <p><label><input type="checkbox" checked={settings.incoming} disabled={busy} onChange={e => setSettings({ ...settings, incoming: e.target.checked })}/> Incoming: Xero customers → Lemon CRM</label></p>
      <p><label><input type="checkbox" checked={settings.outgoing} disabled={busy} onChange={e => setSettings({ ...settings, outgoing: e.target.checked })}/> Outgoing: Lemon CRM customers → Xero</label></p>
      <Button disabled={busy} onClick={() => action.mutate({ path: "settings", body: settings })}>Save sync controls and mappings</Button>{" "}
      <Button disabled={busy || data.settings.paused} onClick={() => action.mutate({ path: "settings", body: { ...data.settings, paused: true } })}>Pause now</Button>
      <p>Sync runs only when you apply a reviewed customer below. A change already being processed finishes before another control change; if busy, retry Pause now after it finishes.</p>
      <p>{data.ai_policy}</p>
      {data.retry_at && <p>Next allowed retry: {new Date(data.retry_at).toLocaleString()}.</p>}
      {data.pending && <div role="alert"><p>A prior change has an uncertain result. New previews are blocked to prevent duplicates.</p><Button disabled={busy} onClick={() => action.mutate({ path: "reconcile" })}>Reconcile uncertain change</Button></div>}
      {message && <p role="status">{message}</p>}{action.error && <p role="alert">{action.error.message}</p>}
    </Section>
    <Section title="Accounts and GST mappings">
      <p>Xero owns the chart of accounts and tax definitions. These controls select existing accounts; they never create or change accounts or tax rates.</p>
      <Button disabled={busy} onClick={() => action.mutate({ path: "catalogue" })}>Retrieve accounts and GST rates</Button>
      {c && <><p>{c.currency} · Last retrieved {new Date(c.fetched_at).toLocaleString()}. Bank account numbers are not retrieved into these settings.</p>
        {accountField("Revenue account", "revenue", accounts.filter(a => ['SALES', 'REVENUE'].includes(a.Type)))}
        {accountField("Bank account", "bank", accounts.filter(a => a.Type === "BANK" && (!a.CurrencyCode || a.CurrencyCode === "NZD")))}
        {accountField("Clearing / payment account", "clearing", accounts.filter(a => a.Type === "BANK" ? (!a.CurrencyCode || a.CurrencyCode === "NZD") : a.EnablePaymentsToAccount))}
        <Field label="GST / tax rate"><select value={settings.tax ?? ""} disabled={busy} onChange={e => setSettings({ ...settings, tax: e.target.value || null })}><option value="">Not mapped</option>{c.taxes.filter(t => t.Status === "ACTIVE" && t.CanApplyToRevenue).map(t => <option key={t.TaxType} value={t.TaxType}>{t.Name} ({t.EffectiveRate}%)</option>)}</select></Field>
        <p>Save these choices using Save sync controls and mappings above. Accounts are revalidated when you enable sync.</p></>}
      <Field label="Xero price basis"><select value={settings.basis} disabled={busy} onChange={e => setSettings({ ...settings, basis: e.target.value as Settings['basis'] })}><option value="Exclusive">GST exclusive</option><option value="Inclusive">GST inclusive</option><option value="NoTax">No tax</option></select></Field>
      <p>The basis is saved for Xero pricing. Existing CRM invoice prices and totals are unchanged by this setting; invoice synchronisation is a later stage.</p>
      <Field label="Preview quantity"><input value={quantity} onChange={e => setQuantity(e.target.value)} inputMode="decimal"/></Field>
      <Field label="Preview unit price (NZD)"><input value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal"/></Field>
      <Field label="Preview GST percent"><input value={percent} onChange={e => setPercent(e.target.value)} inputMode="decimal"/></Field>
      <Button disabled={busy} onClick={() => action.mutate({ path: "pricing", body: { basis: settings.basis, lines: [{ quantity, unit_price: price, tax_percent: percent }] } })}>Calculate GST preview</Button>
      {calculation && <p role="status">Net ${calculation.net.toFixed(2)} · GST ${calculation.tax.toFixed(2)} · Total ${calculation.total.toFixed(2)} NZD</p>}
    </Section>
    <Section title="Review customers">
      <Button disabled={busy || !data.contact_permission || Boolean(data.pending)} onClick={() => action.mutate({ path: "preview", body: { direction: "incoming" } })}>Preview incoming customers</Button>{" "}
      <Button disabled={busy || !data.contact_permission || Boolean(data.pending)} onClick={() => action.mutate({ path: "preview", body: { direction: "outgoing" } })}>Preview outgoing customers</Button>
      <p>A preview does not apply changes. Possible matches require your review; conflicting edits are never overwritten automatically.</p>
      {preview && <><p>{preview.direction} · {preview.total} customers · Page {preview.page + 1} of {Math.max(1, Math.ceil(preview.total / 25))}</p>
        {preview.rows.map(r => <ReviewRow key={`${preview.id}:${r.id}`} row={r} preview={preview} busy={busy} enabled={!data.settings.paused && data.settings[preview.direction]} onApply={body => action.mutate({ path: "apply", body })}/>)}
        <Button disabled={busy || preview.page === 0} onClick={async () => setPreview(await api.get(`/apps/xero/sync/preview?page=${preview.page - 1}`))}>Previous page</Button>{" "}
        <Button disabled={busy || (preview.page + 1) * 25 >= preview.total} onClick={async () => setPreview(await api.get(`/apps/xero/sync/preview?page=${preview.page + 1}`))}>Next page</Button></>}
    </Section>
    <Section title="Synchronisation history">
      <p>Last successful customer synchronisation: {history.data?.history.find(h => ["applied", "reconciled"].includes(h.outcome))?.created_at ? new Date(history.data.history.find(h => ["applied", "reconciled"].includes(h.outcome))!.created_at).toLocaleString() : "Not yet"}.</p>
      <Button disabled={history.isFetching} onClick={() => history.refetch()}>Refresh history</Button>
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.data?.history.length === 0 && <p>No customer changes have been applied yet.</p>}
      <ul>{history.data?.history.map(h => <li key={h.operation_id}>{new Date(h.created_at).toLocaleString()} — {h.direction}: {h.outcome} ({h.code.replace(/_/g, " ")})</li>)}</ul>
    </Section>
  </>;
}
