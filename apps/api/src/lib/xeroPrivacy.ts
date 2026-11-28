import type { Db } from "./supabase";
import { HttpError } from "./http";
/** Fail closed before any data can be sent to a model, including personal ChatGPT plans. */
export async function xeroAiBlocked(db: Db, company: string): Promise<boolean> {
    const result = await (db as unknown as {
        rpc(name: string, args: {
            p_company: string;
        }): PromiseLike<{
            data: unknown;
            error: unknown;
        }>;
    }).rpc("xero_ai_blocked", { p_company: company });
    if (result.error || typeof result.data !== "boolean")
        throw new HttpError(503, "AI privacy checks are unavailable. No data was sent.");
    return result.data;
}
