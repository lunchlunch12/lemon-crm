import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field } from "@/components/ui/Field";
import { BackLink } from "@/components/ui/PageHeader";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { ErrorState, NoAccess } from "@/components/ui/States";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { CodeRow, Step, Steps, kit } from "./PanelKit";

interface Config {
  enabled: boolean; configured: boolean; credentials_set: boolean; redirect_uri: string | null;
  mode: "read_only" | "demo"; paused: boolean; authorised: boolean;
  selected: { name: string; demo: boolean } | null; checked_at: string | null; token_expired: boolean;
}

/** No credential entry in the browser: protected runtime configuration only. */
export function XeroPanel() {
  const session = useSession();
  const owner = session.role === "owner";
  const [params, setParams] = useSearchParams();
  const [organisations, setOrganisations] = useState<Array<{ id: string; name: string }>>([]);
  const config = useQuery({ queryKey: ["xero-config", session.company.id], queryFn: () => api.get<Config>("/apps/xero/config"), enabled: owner, gcTime: 0 });
  const update = useMutation({
    mutationFn: async ({ path, body = {} }: { path: string; body?: object }) => {
      if (path === "settings") return api.put("/apps/xero/settings", body);
      if (path === "connect") {
        const result = await api.post<{ authorization_url: string }>("/apps/xero/connect");
        window.location.assign(result.authorization_url);
        return;
      }
      if (path === "organisations") {
        const result = await api.post<{ organisations: Array<{ id: string; name: string }> }>("/apps/xero/organisations");
        setOrganisations(result.organisations);
        return;
      }
      await api.post(`/apps/xero/${path}`, body);
      if (path === "select" || path === "disconnect") setOrganisations([]);
    },
    onSuccess: () => config.refetch(),
  });
  if (!owner) return <NoAccess title="Xero is managed by the business owner" />;
  const data = config.data;
  const busy = update.isPending;
  const disconnect = async (localOnly: boolean) => {
    if (await confirm({ title: localOnly ? "Forget this connection locally?" : "Disconnect Xero?", body: localOnly ? "Lemon CRM will forget its tokens. Xero access may remain authorised; you can remove it under Connected apps in Xero." : "Remove the selected organisation's connection and forget its tokens. No accounting records will be changed. Other organisations are not disconnected.", confirmLabel: "Disconnect", danger: true })) update.mutate({ path: "disconnect", body: { local_only: localOnly } });
  };
  return <>
    <BackLink to="/apps">Apps</BackLink>
    <h1>Xero</h1>
    <p>Secure connection setup. Xero keeps the accounts; Lemon CRM handles the work and all customer messages.</p>
    <div className="callout callout-info" role="note">This version connects and checks your organisation only. It does not synchronise customers, invoices, payments or quotes. Live mode is unavailable and all synchronisation remains paused.</div>
    {params.has("status") && <div className={`callout ${params.get("status") === "connected" ? "callout-good" : "callout-warning"}`} role="status">
      {params.get("status") === "connected" ? "Xero sign-in completed. Choose the Demo Company below. No records have been synchronised." : "Xero sign-in could not be completed. Try connecting again; no records were synchronised."}
      <Button onClick={() => setParams({}, { replace: true })}>Dismiss</Button>
    </div>}
    {config.error && <ErrorState error={config.error} onRetry={() => config.refetch()} />}
    {update.error && <div className="callout callout-warning" role="alert">{update.error.message}</div>}
    {config.isPending && <p role="status">Loading Xero settings…</p>}
    {data && <div className="app-panels">
      <Section title="Connection">
        <Facts>
          <Fact label="Server setup">{data.configured ? "Ready" : "Not ready"}</Fact>
          <Fact label="Credentials">{data.credentials_set ? "Set securely on server" : "Not set"}</Fact>
          <Fact label="Organisation">{data.selected ? `${data.selected.name}${data.selected.demo ? " (Demo)" : ""}` : data.authorised ? "Choose an organisation" : "Not connected"}</Fact>
          <Fact label="Last successful check">{data.checked_at ? new Date(data.checked_at).toLocaleString() : "Not checked"}</Fact>
        </Facts>
        <p>Only the owner can manage this connection. No live organisation can be selected unless the server is explicitly configured to allow a read-only connection.</p>
        <Button variant="primary" disabled={!data.configured || busy} onClick={() => update.mutate({ path: "connect" })}>{data.authorised ? "Reconnect to Xero" : "Connect to Xero"}</Button>{" "}
        {data.authorised && <Button disabled={busy} onClick={() => update.mutate({ path: "organisations" })}>Choose organisation</Button>}{" "}
        {data.selected && <Button disabled={busy} onClick={() => update.mutate({ path: "check" })}>Check connection</Button>}
        {organisations.length > 0 && <ul>{organisations.map((organisation) => <li key={organisation.id}>{organisation.name}{" "}<Button disabled={busy} onClick={() => update.mutate({ path: "select", body: { connection_id: organisation.id } })}>Select</Button></li>)}</ul>}
        {data.authorised && <p><Button disabled={busy} onClick={() => disconnect(false)}>Disconnect</Button>{" "}<Button disabled={busy} onClick={() => disconnect(true)}>Forget locally</Button></p>}
      </Section>
      <Section title="Safety controls">
        <Field label="Mode"><select value={data.mode} disabled={!data.configured || busy} onChange={(e) => update.mutate({ path: "settings", body: { mode: e.target.value, paused: true } })}>
          <option value="read_only">Read only — connection checks</option><option value="demo">Demo — Xero Demo Company only</option><option value="live" disabled>Live — not available yet</option>
        </select></Field>
        <p><label><input type="checkbox" checked disabled readOnly /> All synchronisation paused</label></p>
        <p><label><input type="checkbox" disabled /> Incoming record synchronisation (not built yet)</label></p>
        <p><label><input type="checkbox" disabled /> Outgoing record synchronisation (not built yet)</label></p>
        <p>Connection checks can refresh an expiring token without reading financial records. They do not email customers or change the accounts.</p>
      </Section>
      <Section title="Secure setup" className={kit.panel}>
        <p>Keep your credentials out of GitHub, chat and screenshots. Enter them only in the Railway test app's protected Variables screen.</p>
        <Steps>
          <Step>Create a Standard OAuth 2.0 Web App in the Xero Developer Portal, using the free Starter tier where it meets your needs.</Step>
          <Step>Register the redirect URI for this environment. It must match the server setting exactly.
            <CodeRow label="Redirect URI" value={data.redirect_uri ?? `${window.location.origin}/api/apps/xero/callback`} />
          </Step>
          <Step>After the code has been reviewed and a test deployment authorised, set XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI on that test app service. Set XERO_ENABLED=true. Keep XERO_ALLOW_LIVE_CONNECTION=false.</Step>
          <Step>Connect with the Xero Demo Company only. Do not configure the production app or connect real books during development.</Step>
        </Steps>
        <p>Request only offline_access and accounting.settings.read for this connection-only version. More permissions will be requested when the financial features are ready.</p>
      </Section>
    </div>}
  </>;
}
