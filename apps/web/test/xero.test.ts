import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XeroPanel } from "../src/features/apps/XeroPanel";
import { XeroContactsPanel } from "../src/features/apps/XeroContactsPanel";

const fixture = vi.hoisted(() => ({ role: "owner", configured: false }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ role: fixture.role, company: { id: "fictional-company" } }) }));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()], Link: ({ children }: { children: unknown }) => children }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: ({queryKey}:{queryKey:string[]}) => ({ data: queryKey[0]==="xero-history"?{history:[]}:{ configured: fixture.configured, credentials_set: fixture.configured, enabled: fixture.configured, mode: "read_only", paused: true, authorised: false, selected: null, checked_at: null, redirect_uri: "https://crm.example.test/api/apps/xero/callback" }, refetch: vi.fn(), isPending: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
afterEach(() => { fixture.role = "owner"; fixture.configured = false; });

describe("Xero setup screen", () => {
  it("shows safe setup guidance without credential inputs or financial sync promises", () => {
    const html = renderToStaticMarkup(createElement(XeroPanel));
    expect(html).toContain("XERO_CLIENT_SECRET");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="client_secret"');
    expect(html).toContain("Invoices, payments and quotes are not synchronised");
    expect(html).toContain("Invoice, payment and quote synchronisation paused");
    expect(html).toMatch(/<option value="live" disabled="">Live/);
    expect(html).toContain("https://crm.example.test/api/apps/xero/callback");
  });
  it("does not show configuration or organisation controls to an admin", () => {
    fixture.role = "admin";
    const html = renderToStaticMarkup(createElement(XeroPanel));
    expect(html).toContain("Xero is managed by the business owner");
    expect(html).not.toContain("XERO_CLIENT_SECRET");
    expect(html).not.toContain("Connect to Xero");
  });
  it("shows independent paused contact controls, review actions and privacy limits",()=>{
    const html=renderToStaticMarkup(createElement(XeroContactsPanel,{companyId:"fictional-company",onRefresh:async()=>undefined,data:{settings:{paused:true,incoming:false,outgoing:false,basis:"Inclusive",revenue:null,bank:null,clearing:null,tax:null},contact_permission:false,catalogue:null,pending:null,retry_at:null,ai_policy:"Company AI is blocked after Xero contacts are imported."}}));
    expect(html).toContain("Pause all customer synchronisation");expect(html).toContain("Incoming: Xero customers");expect(html).toContain("Outgoing: Lemon CRM customers");expect(html).toContain("grant customer/contact permission");expect(html).toContain("existing matches");expect(html).toContain("Existing CRM invoice prices and totals are unchanged");expect(html).toContain("Company AI is blocked");expect(html).not.toContain('type="password"');
  });
});
