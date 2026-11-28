/** Fictional UI contracts; every Xero route is intercepted. Real Demo acceptance is separate. */
import { test, expect, expectAccessible } from "./support/fixtures";
for (const width of [1440, 390])
    test(`review Xero contacts and GST at ${width}px`, async ({ as }) => {
        const page = await as("owner");
        await page.setViewportSize({ width, height: 900 });
        const remoteId = "00000000-0000-4000-8000-000000000031";
        const projection = { display_name: "Fictional Browser Customer", company_name: null, email: "browser@example.test", phone: null, billing_address: { line1: "10 Fictional Street", city: "Christchurch" }, payment_terms_days: 30, status: "active", people: [] };
        const settings = { paused: true, incoming: false, outgoing: false, basis: "Exclusive", revenue: null, bank: null, clearing: null, tax: null };
        let applied: Record<string, unknown> | null = null;
        let providerCalls = 0;
        let priceRequest: Record<string, unknown> | null = null;
        await page.route("https://api.xero.com/**", async (route) => { providerCalls++; await route.abort(); });
        await page.route("**/api/apps/xero/config", route => route.fulfill({ json: { enabled: true, configured: true, credentials_set: true, mode: "demo", paused: true, authorised: true, selected: { name: "Fictional Demo Company", demo: true }, checked_at: null, token_expired: false, redirect_uri: "https://crm.example.test/api/apps/xero/callback", contacts: { settings, contact_permission: true, catalogue: null, pending: null, retry_at: null, ai_policy: "Company AI is blocked after Xero contacts are imported." } } }));
        await page.route("**/api/apps/xero/sync/**", async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith("/history"))
                return route.fulfill({ json: { history: applied ? [{ operation_id: "fictional-operation", direction: "outgoing", outcome: "applied", code: "contact_saved", created_at: "2026-01-01T00:00:00Z" }] : [] } });
            if (url.pathname.endsWith("/settings")) {
                Object.assign(settings, route.request().postDataJSON());
                return route.fulfill({ json: { ok: true } });
            }
            if (url.pathname.endsWith("/pricing")) {
                priceRequest = route.request().postDataJSON();
                return route.fulfill({ json: { net: 100, tax: 15, total: 115 } });
            }
            if (url.pathname.endsWith("/preview"))
                return route.fulfill({ json: { id: "00000000-0000-4000-8000-000000000030", direction: "outgoing", created_at: "2026-01-01T00:00:00Z", total: 1, page: 0, rows: [{ id: "00000000-0000-4000-8000-000000000032", action: "review", name: "Fictional Browser Customer", local: projection, remote: null, candidates: [{ id: remoteId, name: "Fictional existing Xero customer", evidence: ["email"], contact: projection }], fields: [], reason: null }] } });
            if (url.pathname.endsWith("/apply")) {
                applied = route.request().postDataJSON();
                return route.fulfill({ json: { ok: true } });
            }
            return route.fulfill({ status: 400, json: { error: "Unexpected fixture route" } });
        });
        await page.goto("/apps/xero");
        await expect(page.getByRole("heading", { name: "Customer synchronisation", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Preview outgoing customers", exact: true }).click();
        const apply = page.getByRole("button", { name: "Export reviewed customer", exact: true });
        await expect(apply).toBeDisabled();
        await page.getByLabel("Pause all customer synchronisation", { exact: true }).uncheck();
        await page.getByLabel("Outgoing: Lemon CRM customers → Xero", { exact: true }).check();
        await page.getByRole("button", { name: "Save sync controls and mappings", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Contact sync controls saved" })).toBeVisible();
        await page.getByRole("button", { name: "Preview outgoing customers", exact: true }).click();
        await expect(apply).toBeDisabled();
        await page.getByLabel("Possible existing customer", { exact: true }).selectOption(remoteId);
        await expect(apply).toBeEnabled();
        await expectAccessible(page, "the owner Xero contact review");
        await apply.click();
        await expect(page.getByRole("status").filter({ hasText: "Operation completed" })).toBeVisible();
        expect(applied).toMatchObject({ candidate_id: remoteId, create_separate: false, resolve: false });
        await page.getByLabel("Xero price basis", { exact: true }).selectOption("Inclusive");
        await page.getByLabel("Preview unit price (NZD)", { exact: true }).fill("115");
        await page.getByRole("button", { name: "Calculate GST preview", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Net $100.00" })).toContainText("GST $15.00");
        expect(priceRequest).toMatchObject({ basis: "Inclusive", lines: [{ quantity: "1", unit_price: "115", tax_percent: "15" }] });
        await expect(page.getByLabel("Xero price basis", { exact: true })).toHaveValue("Inclusive");
        expect(providerCalls).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
