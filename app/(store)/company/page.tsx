import Link from "next/link";
import { prisma } from "@/lib/db";
import { getMember } from "@/lib/session";
import { expenseRows, membershipOf, ROLES } from "@/lib/company";
import { createCompanyAction, inviteAction, policyAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Company travel", robots: { index: false } };

const SAVED: Record<string, string> = {
  created: "Your company is set up. Write your travel policy and invite your team.",
  invited: "Invitation sent.",
  policy: "Policy saved. Neon follows it on every work trip from now on.",
  joined: "You've joined. Tell Neon when a trip is for work, and send it your receipts.",
};

const ym = (d: Date) => d.toISOString().slice(0, 7);
const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Company travel: create a company, policy, people, and the month's work expenses with a CSV download. */
export default async function CompanyPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; month?: string }> }) {
  const { error, saved, month: mq } = await searchParams;
  const me = await getMember();
  if (!me)
    return (
      <div className="wrap page narrow co">
        <h1 className="page-title">Company travel</h1>
        <p>Book your team’s work trips in a chat with Neon, under your company’s travel policy, with every receipt in one place. Sign in to start.</p>
        <Link className="btn primary" href="/account?next=/company">
          Sign in
        </Link>
      </div>
    );
  const mine = await membershipOf(me.id);
  const notices = (
    <>
      {error && <p className="notice err">{error}</p>}
      {saved && SAVED[saved] && <p className="notice ok">{SAVED[saved]}</p>}
    </>
  );
  if (!mine)
    return (
      <div className="wrap page narrow co">
        <h1 className="page-title">Company travel</h1>
        {notices}
        <ul className="co-points">
          <li>Write your travel policy in plain English. Neon follows it whenever someone books a work trip.</li>
          <li>Your team sends receipts in any format (a photo, a PDF, a forwarded email) and Neon files them.</li>
          <li>Everything booked in Chit for work goes in automatically. Download it all as CSV for your accounting.</li>
        </ul>
        <form action={createCompanyAction} className="co-card">
          <label>
            Company name
            <input name="name" required maxLength={80} placeholder="Acme Inc." />
          </label>
          <button className="btn primary">Create company</button>
        </form>
        <p className="muted small">Invited by your company? Open the link in your invitation email.</p>
      </div>
    );

  const admin = mine.role === "admin";
  const month = /^\d{4}-\d{2}$/.test(mq ?? "") ? mq! : ym(new Date());
  const prev = ym(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 15)));
  const next = ym(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 15)));
  const [members, invites, { rows }] = await Promise.all([
    prisma.companyMember.findMany({ where: { companyId: mine.company.id }, orderBy: { createdAt: "asc" } }),
    admin ? prisma.companyInvite.findMany({ where: { companyId: mine.company.id, acceptedAt: null }, orderBy: { createdAt: "desc" }, take: 20 }) : Promise.resolve([]),
    expenseRows(me.id, month),
  ]);
  const people = new Map((await prisma.customer.findMany({ where: { id: { in: members.map((m) => m.customerId) } }, select: { id: true, name: true, email: true } })).map((c) => [c.id, c]));
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + Number(r.amount));

  return (
    <div className="wrap page co">
      <p className="eyebrow">Company travel · {mine.role}</p>
      <h1 className="page-title">{mine.company.name}</h1>
      {notices}

      <section className="co-card">
        <h2 className="section-title">Travel policy</h2>
        {admin ? (
          <form action={policyAction}>
            <label>
              In plain English. Neon follows it on every work trip and tells travelers when something is over.
              <textarea name="policy" rows={6} defaultValue={mine.company.policy} maxLength={4000} placeholder={"Economy for flights under 6 hours, premium economy above.\nHotels up to $250 a night, near the office or client.\nRental cars: economy or compact.\nAsk a manager before booking anything over $1,500."} />
            </label>
            <label className="co-inline">
              Report currency
              <input name="currency" defaultValue={mine.company.currency} maxLength={3} size={4} />
            </label>
            <button className="btn primary">Save policy</button>
          </form>
        ) : (
          <p className="co-policy">{mine.company.policy || "Your admin hasn't written a policy yet."}</p>
        )}
      </section>

      <section className="co-card">
        <div className="co-head">
          <h2 className="section-title">Expenses · {monthLabel(month)}</h2>
          <span className="co-months">
            <Link href={`/company?month=${prev}`}>‹ {monthLabel(prev).split(" ")[0]}</Link>
            {month < ym(new Date()) && <Link href={`/company?month=${next}`}>{monthLabel(next).split(" ")[0]} ›</Link>}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="muted">No work expenses this month. Send Neon a photo or PDF of a receipt and say it’s for work, or book a work trip in a chat.</p>
        ) : (
          <div className="co-table-wrap">
            <table className="co-table">
              <thead>
                <tr>
                  <th>Date</th>
                  {!(mine.role === "traveler") && <th>Person</th>}
                  <th>Merchant</th>
                  <th>Category</th>
                  <th className="num">Amount</th>
                  <th>From</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.date}</td>
                    {!(mine.role === "traveler") && <td>{r.person}</td>}
                    <td>
                      {r.merchant}
                      {r.note && <div className="muted small">{r.note}</div>}
                    </td>
                    <td>{r.category}</td>
                    <td className="num">
                      {r.amount} {r.currency}
                    </td>
                    <td>{r.source === "booking" ? "Booked in Chit" : "Receipt"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="co-foot">
          <span>
            {[...totals].map(([c, n]) => (
              <b key={c} className="co-total">
                {n.toFixed(2)} {c}
              </b>
            ))}
          </span>
          <a className="btn" href={`/api/company/expenses.csv?month=${month}`}>
            Download CSV
          </a>
        </div>
      </section>

      <section className="co-card">
        <h2 className="section-title">People</h2>
        <ul className="co-people">
          {members.map((m) => (
            <li key={m.id}>
              <span>{people.get(m.customerId)?.name || people.get(m.customerId)?.email}</span>
              <span className="muted">{m.role}</span>
            </li>
          ))}
          {invites.map((v) => (
            <li key={v.id} className="muted">
              <span>{v.email}</span>
              <span>invited · {v.role}</span>
            </li>
          ))}
        </ul>
        {admin && (
          <form action={inviteAction} className="co-invite">
            <input name="email" type="email" required placeholder="teammate@company.com" />
            <select name="role" defaultValue="traveler">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button className="btn primary">Invite</button>
          </form>
        )}
      </section>
      <p>
        <Link href="/">← Back to Neon</Link>
      </p>
    </div>
  );
}
