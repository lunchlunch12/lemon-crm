/** Pure projections only. Never retain financial fields from a provider contact. */
import { z } from "zod";
import { toUnits } from "@crewtavo/core/money";
const text = (max: number) => z.string().trim().max(max);
export const personSchema = z.object({ name: text(200).min(1), email: text(254).nullable() });
export const contactSchema = z.object({
    display_name: text(200).min(1), company_name: text(200).nullable(), email: text(254).nullable(), phone: text(40).nullable(),
    billing_address: z.object({ line1: text(200), line2: text(200), city: text(100), region: text(100), postal_code: text(20), country: text(100) }),
    payment_terms_days: z.number().int().min(0).max(365).nullable(), status: z.enum(["active", "archived"]), people: z.array(personSchema).max(5),
});
export type ContactProjection = z.infer<typeof contactSchema>;
export interface LocalContact {
    id: string;
    updated_at: string;
    display_name: string;
    company_name: string | null;
    email: string | null;
    phone: string | null;
    billing_address: unknown;
    payment_terms_days: number | null;
    status: string;
    people: Array<{
        id: string;
        name: string;
        email: string | null;
        phone: string | null;
        role: string | null;
        updated_at: string;
        notify_email: boolean;
        notify_sms: boolean;
        is_primary: boolean;
    }>;
}
export const remoteContactSchema = z.object({
    ContactID: z.string().uuid(), ContactNumber: text(50).nullish(), Name: text(500), FirstName: text(255).nullish(), LastName: text(255).nullish(),
    EmailAddress: text(500).nullish(), ContactStatus: z.enum(["ACTIVE", "ARCHIVED", "GDPRREQUEST"]).optional(), IsCustomer: z.boolean().optional(), IsSupplier: z.boolean().optional(),
    UpdatedDateUTC: text(100).optional(), MergedToContactID: z.string().uuid().nullish(),
    Phones: z.array(z.object({ PhoneType: text(20), PhoneNumber: text(50).nullish(), PhoneAreaCode: text(20).nullish(), PhoneCountryCode: text(20).nullish() })).default([]),
    Addresses: z.array(z.object({ AddressType: text(20), AddressLine1: text(200).nullish(), AddressLine2: text(200).nullish(), AddressLine3: text(200).nullish(), AddressLine4: text(200).nullish(), City: text(100).nullish(), Region: text(100).nullish(), PostalCode: text(20).nullish(), Country: text(100).nullish(), AttentionTo: text(255).nullish() })).default([]),
    ContactPersons: z.array(z.object({ FirstName: text(255).nullish(), LastName: text(255).nullish(), EmailAddress: text(500).nullish(), IncludeInEmails: z.boolean().optional() })).default([]),
    PaymentTerms: z.object({ Sales: z.object({ Day: z.number().int().optional(), Type: text(50).optional() }).optional() }).optional(),
});
export type RemoteContact = z.infer<typeof remoteContactSchema>;
const clean = (s: string | null | undefined) => s?.trim() || null;
const emailKey = (s: string | null | undefined) => s?.trim().toLowerCase() || "";
const nameKey = (s: string | null | undefined) => s?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") || "";
const phoneKey = (s: string | null | undefined) => s?.replace(/\D/g, "") || "";
const blankAddress = { line1: "", line2: "", city: "", region: "", postal_code: "", country: "" };
const byPerson = (a: {
    name: string;
    email: string | null;
}, b: {
    name: string;
    email: string | null;
}) => `${a.email ?? ""}:${a.name}`.localeCompare(`${b.email ?? ""}:${b.name}`, "en");
type ContactIdentity = Pick<ContactProjection, "display_name" | "company_name" | "email" | "phone">;
/** Identity evidence remains usable even when other fields cannot be synchronised. */
export function remoteIdentity(c: RemoteContact): ContactIdentity {
    const person = [clean(c.FirstName), clean(c.LastName)].filter(Boolean).join(" ");
    const phone = c.Phones.find(p => p.PhoneType === "DEFAULT" && clean(p.PhoneNumber)) ?? c.Phones.find(p => p.PhoneType === "MOBILE" && clean(p.PhoneNumber));
    return { display_name: person || c.Name, company_name: person && nameKey(person) !== nameKey(c.Name) ? c.Name : null,
        email: clean(c.EmailAddress)?.toLowerCase() ?? null, phone: phone ? clean([phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(" ")) : null };
}
export function localProjection(c: LocalContact): ContactProjection {
    const a = c.billing_address && typeof c.billing_address === "object" ? c.billing_address as Record<string, unknown> : {};
    return contactSchema.parse({ display_name: c.display_name.trim(), company_name: clean(c.company_name), email: clean(c.email)?.toLowerCase() ?? null, phone: clean(c.phone),
        billing_address: Object.fromEntries(Object.keys(blankAddress).map(k => [k, typeof a[k] === "string" ? a[k] : ""])),
        payment_terms_days: c.payment_terms_days, status: c.status === "archived" ? "archived" : "active",
        people: c.people.map(p => ({ name: p.name.trim(), email: clean(p.email)?.toLowerCase() ?? null })).sort(byPerson),
    });
}
/** A company with a named primary person maps to Name plus FirstName/LastName. */
export function remoteProjection(c: RemoteContact): ContactProjection {
    if (c.MergedToContactID || c.ContactStatus === "GDPRREQUEST")
        throw new Error("This Xero contact was merged or is restricted. Review its identity before syncing.");
    const person = [clean(c.FirstName), clean(c.LastName)].filter(Boolean).join(" ");
    const a = c.Addresses.find(a => a.AddressType === "POBOX");
    if (a?.AddressLine3 || a?.AddressLine4 || a?.AttentionTo)
        throw new Error("This billing address has extra lines or an attention name. Review it before syncing.");
    const phone = c.Phones.find(p => p.PhoneType === "DEFAULT" && clean(p.PhoneNumber)) ?? c.Phones.find(p => p.PhoneType === "MOBILE" && clean(p.PhoneNumber));
    const terms = c.PaymentTerms?.Sales;
    if (terms?.Type && terms.Type !== "DAYSAFTERBILLDATE")
        throw new Error("This payment-term rule needs review; CRM currently supports days after invoice only.");
    return contactSchema.parse({ display_name: person || c.Name, company_name: person && nameKey(person) !== nameKey(c.Name) ? c.Name : null,
        email: clean(c.EmailAddress)?.toLowerCase() ?? null, phone: phone ? clean([phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(" ")) : null,
        billing_address: a ? { line1: a.AddressLine1 ?? "", line2: a.AddressLine2 ?? "", city: a.City ?? "", region: a.Region ?? "", postal_code: a.PostalCode ?? "", country: a.Country ?? "" } : blankAddress,
        payment_terms_days: terms?.Type ? terms.Day ?? null : null, status: c.ContactStatus === "ARCHIVED" ? "archived" : "active",
        people: c.ContactPersons.map(p => ({ name: [p.FirstName, p.LastName].filter(Boolean).join(" ").trim(), email: clean(p.EmailAddress)?.toLowerCase() ?? null })).sort(byPerson),
    });
}
const splitName = (name: string) => { const [first = "", ...rest] = name.split(/\s+/); return { FirstName: first, LastName: rest.join(" ") }; };
export const contactNumber = (id: string) => `lemon-${z.string().uuid().parse(id)}`;
export function remotePayload(c: ContactProjection, localId: string, previous?: RemoteContact) {
    const a = c.billing_address;
    const previousPeople = previous?.ContactPersons ?? [];
    const people = c.people.map(p => ({ ...splitName(p.name), EmailAddress: p.email ?? "", IncludeInEmails: false }));
    // Updating an existing recipient list must not silently drop an unrelated person.
    if (previousPeople.some(p => !people.some(q => nameKey(`${q.FirstName} ${q.LastName}`) === nameKey(`${p.FirstName ?? ""} ${p.LastName ?? ""}`) && emailKey(q.EmailAddress) === emailKey(p.EmailAddress))))
        throw new Error("Xero has an additional contact person. Import or review it before exporting.");
    return { ...(previous ? { ContactID: previous.ContactID } : { ContactNumber: contactNumber(localId) }), Name: c.company_name || c.display_name,
        ...(c.company_name ? splitName(c.display_name) : { FirstName: "", LastName: "" }), EmailAddress: c.email ?? "", ContactStatus: c.status === "archived" ? "ARCHIVED" : "ACTIVE",
        Phones: [...(previous?.Phones.filter(p => p.PhoneType !== "DEFAULT") ?? []), { PhoneType: "DEFAULT", PhoneNumber: c.phone ?? "", PhoneAreaCode: "", PhoneCountryCode: "" }],
        Addresses: [...(previous?.Addresses.filter(a => a.AddressType !== "POBOX") ?? []), { AddressType: "POBOX", AddressLine1: a.line1, AddressLine2: a.line2, City: a.city, Region: a.region, PostalCode: a.postal_code, Country: a.country }],
        ContactPersons: people,
        // Null terms cannot clear a provider default safely by omission; callers surface that difference.
        ...(c.payment_terms_days === null ? {} : { PaymentTerms: { Sales: { Type: "DAYSAFTERBILLDATE", Day: c.payment_terms_days } } }),
    };
}
/** Stable JSON for digests; object insertion order must never decide staleness. */
export function canonical(value: unknown): string {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export async function digest(value: unknown): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))).map(n => n.toString(16).padStart(2, "0")).join(""); }
export function changedFields(a: ContactProjection, b: ContactProjection): string[] { return (Object.keys(a) as Array<keyof ContactProjection>).filter(k => canonical(a[k]) !== canonical(b[k])); }
export function conflictingFields(base: ContactProjection, local: ContactProjection, remote: ContactProjection): string[] { return changedFields(base, local).filter(k => changedFields(base, remote).includes(k) && canonical(local[k as keyof ContactProjection]) !== canonical(remote[k as keyof ContactProjection])); }
export function matchCandidates(c: ContactIdentity, others: Array<{
    id: string;
    contact: ContactIdentity;
}>) {
    return others.filter(({ contact: o }) => (emailKey(c.email) && emailKey(c.email) === emailKey(o.email)) || (phoneKey(c.phone) && phoneKey(c.phone) === phoneKey(o.phone)) || nameKey(c.display_name) === nameKey(o.display_name) || (c.company_name && nameKey(c.company_name) === nameKey(o.company_name))).map(({ id, contact: o }) => ({ id, evidence: [...(emailKey(c.email) && emailKey(c.email) === emailKey(o.email) ? ["email"] : []), ...(phoneKey(c.phone) && phoneKey(c.phone) === phoneKey(o.phone) ? ["phone"] : []), ...(nameKey(c.display_name) === nameKey(o.display_name) ? ["name"] : [])] }));
}
const decimal = z.union([z.string().regex(/^-?\d{1,9}(?:\.\d{1,4})?$/), z.number().finite().min(-999999999).max(999999999).refine(n => /^-?\d{1,9}(?:\.\d{1,4})?$/.test(String(n)))]);
export const pricingSchema = z.object({ basis: z.enum(["Inclusive", "Exclusive", "NoTax"]), lines: z.array(z.object({ quantity: decimal, unit_price: decimal, tax_percent: decimal })).min(1).max(100) });
const roundDivide = (n: bigint, d: bigint) => { const v = ((n < 0n ? -n : n) * 2n + d) / (2n * d); return n < 0n ? -v : v; };
// Keep currency output within an exact minor-unit range, including two-decimal display.
const currencyAmount = (minor: bigint) => {
    if (minor < -1000000000000000n || minor > 1000000000000000n)
        throw new Error("The calculated amount exceeds the supported NZD range.");
    return Number(minor) / 100;
};
/** NZD minor units; tax rounded per line, never via binary floating-point multiplication. */
export function pricingPreview(input: z.infer<typeof pricingSchema>) {
    let net = 0n, tax = 0n;
    const lines = input.lines.map(l => {
        const rate = toUnits(l.tax_percent, 4);
        if (rate < 0n || rate > 1000000n)
            throw new Error("Tax percent must be between 0 and 100.");
        const amount = roundDivide(toUnits(l.quantity, 4) * toUnits(l.unit_price, 4), 1000000n);
        const t = input.basis === "NoTax" ? 0n : input.basis === "Inclusive" ? roundDivide(amount * rate, 1000000n + rate) : roundDivide(amount * rate, 1000000n);
        const n = input.basis === "Inclusive" ? amount - t : amount;
        net += n;
        tax += t;
        return { net: currencyAmount(n), tax: currencyAmount(t), total: currencyAmount(n + t) };
    });
    return { currency: "NZD", basis: input.basis, lines, net: currencyAmount(net), tax: currencyAmount(tax), total: currencyAmount(net + tax) };
}
