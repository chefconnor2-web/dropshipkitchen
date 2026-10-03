import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";

// Reads distributor case stickers and printed product dates with Claude vision + structured outputs.

export type LabelReading = {
  itemCode: string | null;
  description: string | null;
  brand: string | null;
  packSize: string | null;
  gtin: string | null;
  lotCode: string | null;
  packDate: string | null;
  expiryDate: string | null;
  expiryRawText: string | null;
  labelText: string;
  confidence: "high" | "medium" | "low";
  notes: string | null;
};

export type DateReading = {
  expiryDate: string | null;
  dateLabel: string | null;
  rawText: string | null;
  confidence: "high" | "medium" | "low";
  notes: string | null;
};

const str = { type: ["string", "null"] };
const date = { type: ["string", "null"], description: "YYYY-MM-DD, or null when not printed" };
const confidence = { type: "string", enum: ["high", "medium", "low"] };

const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["itemCode", "description", "brand", "packSize", "gtin", "lotCode", "packDate", "expiryDate", "expiryRawText", "labelText", "confidence", "notes"],
  properties: {
    itemCode: { ...str, description: "Distributor item number (GFS item numbers are usually 6 digits, often printed beside a barcode)" },
    description: { ...str, description: "Product description as printed, e.g. 'STRAWBERRY PREMIUM 8/2LB'" },
    brand: str,
    packSize: { ...str, description: "Pack/size, e.g. '8/2 LB' or '1/10 LB'" },
    gtin: { ...str, description: "14-digit GTIN from a (01) element or the printed barcode digits" },
    lotCode: { ...str, description: "Lot / batch / pack code, including a (10) element" },
    packDate: date,
    expiryDate: { ...date, description: "Best-by / use-by / sell-by / expiry date on the sticker, YYYY-MM-DD" },
    expiryRawText: { ...str, description: "That date exactly as printed, with its label" },
    labelText: { type: "string", description: "Every legible line of the sticker, top to bottom, separated by newlines" },
    confidence,
    notes: { ...str, description: "Anything unreadable, torn or ambiguous" },
  },
};

const DATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["expiryDate", "dateLabel", "rawText", "confidence", "notes"],
  properties: {
    expiryDate: { ...date, description: "The best-by / use-by / expiry date, YYYY-MM-DD" },
    dateLabel: { ...str, description: "What the date is called on the pack, e.g. 'BEST BY', 'USE BY', 'EXP'" },
    rawText: { ...str, description: "The date exactly as printed" },
    confidence,
    notes: str,
  },
};

const today = () => new Date().toISOString().slice(0, 10);

const LABEL_PROMPT = () => `This is a photo of the sticker on a case delivered to a restaurant kitchen by Gordon Food Service (GFS) or another food distributor. The sticker may be torn, curled, angled or partly covered by a hand.

Read it and fill in the fields. Rules:
- Only report what is printed. Use null for anything absent or illegible; never guess digits.
- GS1 human-readable lines look like (01)GTIN (10)LOT (13)PACK DATE (15)BEST BEFORE (17)EXPIRY; dates there are YYMMDD.
- Dates must be YYYY-MM-DD. Today is ${today()}; use it to resolve two-digit years and printed month names.
- Codes on produce stickers that are not clearly an item number, lot or date (e.g. "23-199-01", "B1", "1-2") belong in labelText only.`;

const DATE_PROMPT = () => `This is a photo of a food product or its packaging, taken while receiving a delivery. Find the printed best-by / use-by / sell-by / expiry date.
- Report it as YYYY-MM-DD. Today is ${today()}; use it to resolve two-digit years and formats like 10/09, 09OCT, 2026-10-09 or a Julian code.
- If several dates appear, choose the best-by / use-by / expiry date rather than a pack or production date, and say so in notes.
- If no date is legible, return null and explain in notes. Never guess.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!config.receiving.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set: enter the fields by hand.");
  client ??= new Anthropic({ apiKey: config.receiving.anthropicApiKey });
  return client;
}

type ImageInput = { data: Buffer; mimeType: string };

async function readImage<T>(image: ImageInput, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const response = await anthropic().beta.messages.create({
    model: config.receiving.model,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
              data: image.data.toString("base64"),
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("The label reader declined this photo: enter the fields by hand.");
  if (response.stop_reason === "max_tokens") throw new Error("The label reader's answer was cut off: try a closer photo.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("The label reader returned an unreadable answer.");
  }
}

function describe(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY was rejected.";
  if (e instanceof Anthropic.RateLimitError) return "The label reader is rate limited: try again in a minute.";
  if (e instanceof Anthropic.BadRequestError) return `The label reader rejected the photo: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Label reader error ${e.status ?? ""}: ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}

export async function readCaseLabel(image: ImageInput): Promise<{ ok: true; reading: LabelReading } | { ok: false; error: string }> {
  try {
    return { ok: true, reading: await readImage<LabelReading>(image, LABEL_PROMPT(), LABEL_SCHEMA) };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
}

export async function readProductDate(image: ImageInput): Promise<{ ok: true; reading: DateReading } | { ok: false; error: string }> {
  try {
    return { ok: true, reading: await readImage<DateReading>(image, DATE_PROMPT(), DATE_SCHEMA) };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
}
