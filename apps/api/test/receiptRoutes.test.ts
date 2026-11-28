/**
 * routes/receipts.ts: the company's switch, reading a receipt picked in Add expense, and a draft
 * dropped in with others. The signed-in person's Supabase client and the service-role client are
 * stand-ins (tables of rows that eq, neq, in and ilike filter); Anthropic answers through a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { RECEIPT_READS_PER_COMPANY, RECEIPT_READS_PER_PERSON } from "../src/services/ai";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: Row }>,
  role: "owner",
  file: null as Uint8Array | null,
  /** The rate limit keys that are past their allowance (matched by how they start, before hashing isn't known: by call order instead). */
  refuse: null as ((call: number) => boolean) | null,
  hits: 0,
}));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if(fn === "xero_ai_blocked") return {data:false,error:null};
      state.rpcs.push({ fn, args });
      if (fn === "rate_limit_hit") return { data: !(state.refuse?.(state.hits++) ?? false), error: null };
      if (fn === "job_estimated_materials") return { data: [{ service_id: null, name: "Top coat asphalt", unit: "ton" }], error: null };
      return { data: null, error: null };
    },
    storage: { from: () => ({ download: async () => (state.file ? { data: new Blob([state.file]), error: null } : { data: null, error: { message: "not found" } }) }) },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row | null = null;
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const value = (row: Row, column: string) => column.split(".").reduce<unknown>((v, k) => (v as Row | null)?.[k], row);
      const result = () => {
        if (patch) {
          state.updates.push({ table, patch });
          for (const r of rows()) Object.assign(r, patch);
        }
        return { data: rows(), error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (p: Row) => ((patch = p), builder),
        order: () => builder,
        limit: () => builder,
        range: () => builder,
        eq: (column: string, v: unknown) => (filters.push((row) => value(row, column) === v), builder),
        neq: (column: string, v: unknown) => (filters.push((row) => value(row, column) !== v), builder),
        in: (column: string, vs: unknown[]) => (filters.push((row) => vs.includes(value(row, column))), builder),
        ilike: (column: string, pattern: string) => (filters.push((row) => new RegExp(`^${pattern.replace(/%/g, ".*")}$`, "i").test(String(value(row, column) ?? ""))), builder),
        maybeSingle: () => Promise.resolve({ data: result().data[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  ANTHROPIC_API_KEY: "sk-ant-deployment",
} as Env;
const CO = "00000000-0000-4000-8000-0000000000b1";
const request = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const reading = (more: Row = {}) => ({
  kind: "supplier_invoice", vendor: "Valley Asphalt", date: "2026-11-10", invoice_number: "88", subtotal: 1840, tax: 0, total: 1840, category: "Materials",
  lines: [{ description: "Top coat asphalt", quantity: 20, unit: "tons", unit_price: 92, amount: 1840 }],
  job_reference: { job_number: null, po_number: null, address: "18 Birch Lane" },
  ...more,
});

/** Anthropic: models.retrieve answers `modelStatus`; a message answers with `answer`. */
function anthropic(answer: unknown, modelStatus = 200) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    if (url.includes("/v1/models/")) return modelStatus === 200 ? Response.json({ id: "claude-opus-5-5", type: "model" }) : Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: modelStatus });
    return Response.json({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(answer) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  return asked;
}

function company(settings: Row, role = "owner") {
  state.role = role;
  state.tables = {
    memberships: [{ company_id: CO, user_id: "viewer", active: true, role, role_id: null, subcontractor_id: null }],
    companies: [{ id: CO, settings }],
    integrations: [],
    integration_secrets: [],
    // Two jobs on Birch Lane the person can see, one on Elm; the database would hide the rest.
    jobs: [
      { id: "j-birch", company_id: CO, number: 1042, title: "Birch drive", status: "active", po_number: null, property: { line1: "18 Birch Lane" } },
      { id: "j-elm", company_id: CO, number: 1043, title: "Elm lot", status: "active", po_number: "PO-7", property: { line1: "4 Elm St" } },
    ],
    services: [{ id: "s-seal", company_id: CO, name: "Sealcoat", unit: "sq ft" }],
    expense_drafts: [{ id: "00000000-0000-4000-8000-0000000000d1", company_id: CO, job_id: null, receipt_path: `${CO}/receipts/a.jpg`, status: "reading", read: null, error: null }],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  state.rpcs = [];
  state.updates = [];
  state.file = null;
  state.refuse = null;
  state.hits = 0;
});

describe("the switch", () => {
  it("turns on only once the Claude key answers, and says what to fix when it doesn't", async () => {
    company({});
    anthropic({}, 401);
    const refused = await request("PUT", "/receipts/reading", { on: true });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("turned the Claude key down");
    expect(state.rpcs.some((r) => r.fn === "merge_company_settings")).toBe(false);

    const asked = anthropic({});
    expect((await request("PUT", "/receipts/reading", { on: true })).status).toBe(200);
    expect(asked.some((u) => u.includes("/v1/models/claude-opus-5-5"))).toBe(true);
    expect(state.rpcs.find((r) => r.fn === "merge_company_settings")?.args).toEqual({ p_company: CO, p_settings: { receipt_reading: true } });
  });

  it("is the owners' and admins' to change", async () => {
    company({}, "office");
    anthropic({});
    expect((await request("PUT", "/receipts/reading", { on: true })).status).toBe(403);
  });
});

describe("reading a receipt picked in Add expense", () => {
  const file = Buffer.from(JPEG).toString("base64");

  it("isn't done while the switch is off, so the form is filled by hand", async () => {
    company({});
    const asked = anthropic(reading());
    expect((await request("POST", "/receipts/read", { file })).status).toBe(409);
    expect(asked).toEqual([]);
  });

  it("fills the form, says what was read, and suggests the job and its material", async () => {
    company({ receipt_reading: true }, "office");
    anthropic(reading());
    const res = await request("POST", "/receipts/read", { file });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.fields).toEqual(["vendor", "date", "amount", "tax", "category", "lines"]);
    expect(body.problems).toEqual([]);
    expect(body.job).toEqual({ id: "j-birch", number: 1042, title: "Birch drive", why: "address" });
    expect(body.candidates[0]).toEqual({ service_id: null, name: "Top coat asphalt", unit: "ton", estimated: true });
    expect(body.matches).toEqual([0]);
    expect(state.rpcs.find((r) => r.fn === "job_estimated_materials")?.args).toEqual({ p_job: "j-birch" });
    // Counted against the hour's receipts, for the person and for the company: 60 and 300.
    expect(state.rpcs.filter((r) => r.fn === "rate_limit_hit").map((r) => [r.args.p_max, r.args.p_window_seconds])).toEqual([[RECEIPT_READS_PER_PERSON, 3600], [RECEIPT_READS_PER_COMPANY, 3600]]);
    expect([RECEIPT_READS_PER_PERSON, RECEIPT_READS_PER_COMPANY]).toEqual([60, 300]);
  });

  it("has its own hourly allowance, apart from the other AI features': its keys aren't theirs", async () => {
    const limiter = await import("../src/lib/limit");
    const allowed = vi.spyOn(limiter, "allow");
    try {
      company({ receipt_reading: true }, "office");
      anthropic(reading());
      await request("POST", "/receipts/read", { file });
      expect(allowed.mock.calls.map((c) => c[1])).toEqual(["receipts:person:viewer", `receipts:company:${CO}`]);
      expect(allowed.mock.calls.some((c) => String(c[1]).startsWith("ai:"))).toBe(false);
    } finally {
      allowed.mockRestore();
    }
  });

  it("is filled in by hand once the hour's receipts are used up, without asking Claude", async () => {
    company({ receipt_reading: true }, "office");
    const asked = anthropic(reading());
    state.refuse = () => true;
    const res = await request("POST", "/receipts/read", { file });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("That's all the receipts that can be read this hour. Fill this one in by hand, or add it again later.");
    expect(asked).toEqual([]);
  });

  it("is for the people who can add an expense: the crew, yes; a subcontractor, who can't add one, no", async () => {
    for (const role of ["owner", "admin", "office", "estimator", "crew_lead", "field_crew"]) {
      company({ receipt_reading: true }, role);
      anthropic(reading());
      expect((await request("POST", "/receipts/read", { file })).status, role).toBe(200);
    }
    // (They were already turned away before this: the route's default is the team.)
    company({ receipt_reading: true }, "subcontractor");
    state.rpcs = [];
    const asked = anthropic(reading());
    expect((await request("POST", "/receipts/read", { file })).status).toBe(403);
    expect(asked).toEqual([]);
    expect(state.rpcs.some((r) => r.fn === "rate_limit_hit")).toBe(false);
  });

  it("gives the crew what the receipt says, without the price list", async () => {
    company({ receipt_reading: true }, "field_crew");
    anthropic(reading());
    const body = (await (await request("POST", "/receipts/read", { file, job_id: "00000000-0000-4000-8000-00000000000a" })).json()) as Record<string, any>;
    expect(body.reading.vendor).toBe("Valley Asphalt");
    expect(body.job).toBeNull();
    expect(body.candidates).toEqual([]);
    expect(state.rpcs.some((r) => r.fn === "job_estimated_materials")).toBe(false);
  });
});

describe("a draft dropped in with others", () => {
  const id = "00000000-0000-4000-8000-0000000000d1";

  it("keeps what was read on the draft", async () => {
    company({ receipt_reading: true }, "office");
    state.file = JPEG;
    anthropic(reading({ job_reference: { job_number: "Job 1043", po_number: null, address: null } }));
    const res = await request("POST", `/receipts/drafts/${id}/read`);
    expect(res.status).toBe(200);
    const draft = state.tables.expense_drafts![0]!;
    expect(draft).toMatchObject({ status: "read", error: null });
    expect((draft.read as Record<string, any>).job).toMatchObject({ id: "j-elm", why: "job_number" });
  });

  it("waits to be filled in, and isn't called a failure, when reading is off", async () => {
    company({}, "office");
    const asked = anthropic(reading());
    const res = await request("POST", `/receipts/drafts/${id}/read`);
    expect(res.status).toBe(200);
    expect(state.tables.expense_drafts![0]).toMatchObject({ status: "to_fill", read: null, error: null });
    expect(asked).toEqual([]);
    expect(state.rpcs.some((r) => r.fn === "rate_limit_hit")).toBe(false);
  });

  it("waits when the hour's receipts are used up, and is read when it's asked again with room", async () => {
    company({ receipt_reading: true }, "office");
    state.file = JPEG;
    const asked = anthropic(reading());
    state.refuse = () => true;
    expect((await request("POST", `/receipts/drafts/${id}/read`)).status).toBe(200);
    // Not a failure, and nothing asked of Claude: it waits.
    expect(state.tables.expense_drafts![0]).toMatchObject({ status: "waiting", read: null, error: null });
    expect(asked).toEqual([]);
    // The next hour, the page asks again.
    state.refuse = null;
    expect((await request("POST", `/receipts/drafts/${id}/read`)).status).toBe(200);
    expect(state.tables.expense_drafts![0]).toMatchObject({ status: "read", error: null });
  });

  it("is marked as not read when reading fails, to be filled in by hand", async () => {
    company({ receipt_reading: true }, "office");
    state.file = new TextEncoder().encode("not a picture");
    anthropic(reading());
    await request("POST", `/receipts/drafts/${id}/read`);
    expect(state.tables.expense_drafts![0]).toMatchObject({ status: "failed", read: null, error: expect.stringContaining("Only photos") });
  });

  it("is the office's with job costs", async () => {
    company({ receipt_reading: true }, "field_crew");
    expect((await request("POST", `/receipts/drafts/${id}/read`)).status).toBe(403);
  });
});
