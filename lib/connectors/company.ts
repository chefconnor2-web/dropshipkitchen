// Company travel in the chat: Neon reads the shopper's company travel policy before booking work trips,
// tags a chat as work travel (its bookings go to the company's expenses), and logs expenses from receipts in
// any format the shopper sends (photo, PDF, screenshot, pasted email). Admins see and export it on /company.

import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { CATEGORIES, logExpense, membershipOf } from "@/lib/company";
import type { Connector } from "./types";

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "company_policy",
    description: "The shopper's company and its travel policy (plain English, written by their admin), if they belong to one. Call it before searching or booking anything for a work trip.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_work_trip",
    description: "Tag this chat as a work trip (true) or personal (false). Work trips' bookings go to the company's expenses.",
    input_schema: { type: "object", properties: { work: { type: "boolean" } }, required: ["work"], additionalProperties: false },
  },
  {
    name: "log_expense",
    description:
      "Log one work expense from a receipt the shopper sent (photo, PDF, screenshot, pasted email). Copy exactly what the receipt shows. Don't log things booked in Chit (they're added automatically).",
    input_schema: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Who was paid, e.g. 'Uber', 'Joe's Diner', 'Marriott Miami'" },
        category: { type: "string", enum: [...CATEGORIES] },
        amount: { type: "number", description: "The total paid, tip included, e.g. 42.18" },
        currency: { type: "string", description: "3-letter code, e.g. USD, CAD" },
        tax: { type: "number", description: "Tax shown on the receipt, or 0 if none shown" },
        date: { type: "string", description: "YYYY-MM-DD as on the receipt" },
        note: { type: "string", description: "Short note, e.g. 'Client dinner, 3 people' or empty" },
      },
      required: ["merchant", "category", "amount", "currency", "tax", "date", "note"],
      additionalProperties: false,
    },
  },
];

async function ownerOf(chatId: string): Promise<string | null> {
  return (await prisma.assistantChat.findUnique({ where: { id: chatId }, select: { customerId: true } }))?.customerId ?? null;
}

export const companyConnector: Connector = {
  id: "company",
  label: "Company travel",
  enabled: () => true,
  prompt: () => `
Work travel and expenses:
- When a trip is for work (they say so, or it's for a client, conference or their company), call company_policy first and follow it: pick options within the policy, and if the best option is over it, say so plainly in one line and offer the in-policy alternative. Then call set_work_trip with true.
- When the shopper sends a receipt (photo, PDF, screenshot or pasted email) for a work expense, read it and call log_expense once per receipt with exactly what it shows, then confirm in one line (merchant, amount, date). If it's unclear whether it's work, ask once.
- Bookings made in Chit on work trips are added to the company's expenses automatically; don't log them again. Admins see everything and export CSV on the Company page.`,
  tools: TOOLS,
  async run(tool, input, ctx) {
    const owner = await ownerOf(ctx.chatId);
    if (tool === "company_policy") {
      const me = await membershipOf(owner);
      if (!me) return { content: JSON.stringify({ in_company: false, note: owner ? "They're not in a company. Book normally; they can create one on the Company page." : "They're not signed in, so no company policy applies." }) };
      return { content: JSON.stringify({ in_company: true, company: me.company.name, role: me.role, currency: me.company.currency, policy: me.company.policy || "No written policy yet: use good judgement (economy, mid-range hotels)." }) };
    }
    if (tool === "set_work_trip") {
      if (!owner) return { content: "The shopper isn't signed in, so the trip can't go to a company. Ask them to sign in (Account) first.", isError: true };
      await prisma.assistantChat.update({ where: { id: ctx.chatId }, data: { work: input.work === true } });
      return { content: JSON.stringify({ work: input.work === true }) };
    }
    if (tool === "log_expense") {
      if (!owner) return { content: "The shopper isn't signed in, so the expense can't be saved. Ask them to sign in (Account) first.", isError: true };
      const r = await logExpense(owner, ctx.chatId, {
        merchant: String(input.merchant ?? ""),
        category: String(input.category ?? "other"),
        amount: Number(input.amount),
        currency: String(input.currency ?? ""),
        tax: Number(input.tax) || null,
        spentOn: String(input.date ?? ""),
        note: String(input.note ?? ""),
      });
      if (r.error) return { content: r.error, isError: true };
      await prisma.assistantChat.update({ where: { id: ctx.chatId }, data: { work: true } }).catch(() => {});
      return { content: JSON.stringify({ logged: true, company: r.company ?? "none (kept in their own expenses)" }) };
    }
    return { content: `Unknown tool ${tool}.`, isError: true };
  },
};
