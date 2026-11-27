import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XeroPanel } from "../src/features/apps/XeroPanel";

const fixture = vi.hoisted(() => ({ role: "owner", configured: false }));
vi.mock("@/lib/session", () => ({ useSession: () => ({ role: fixture.role, company: { id: "fictional-company" } }) }));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()], Link: ({ children }: { children: unknown }) => children }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: { configured: fixture.configured, credentials_set: fixture.configured, enabled: fixture.configured, mode: "read_only", paused: true, authorised: false, selected: null, checked_at: null, redirect_uri: "https://crm.example.test/api/apps/xero/callback" }, refetch: vi.fn(), isPending: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
afterEach(() => { fixture.role = "owner"; fixture.configured = false; });

describe("Xero setup screen", () => {
  it("shows safe setup guidance without credential inputs or financial sync promises", () => {
    const html = renderToStaticMarkup(createElement(XeroPanel));
    expect(html).toContain("XERO_CLIENT_SECRET");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="client_secret"');
    expect(html).toContain("does not synchronise customers, invoices, payments or quotes");
    expect(html).toContain("All synchronisation paused");
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
});
