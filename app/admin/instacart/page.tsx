// Admin › Instacart: is the connector set up, which Instacart server it talks to, and who gets it. Until launch
// only browsers turned on here can use it in the chat; INSTACART_ROLLOUT=everyone opens it to US and Canadian shoppers.

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { instacartBaseUrl, instacartConfigured, instacartForEveryone, instacartTestMode } from "@/lib/instacart";
import { isTester, TESTER_COOKIE, testerCookieValue } from "@/lib/session";

export const dynamic = "force-dynamic";

async function setTester(formData: FormData) {
  "use server";
  const jar = await cookies();
  if (formData.get("on") === "1")
    jar.set(TESTER_COOKIE, await testerCookieValue(), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 365 * 86400 });
  else jar.delete(TESTER_COOKIE);
  revalidatePath("/admin/instacart");
}

export default async function InstacartAdmin() {
  const configured = instacartConfigured();
  const tester = await isTester();
  const everyone = instacartForEveryone();
  return (
    <>
      <div className="a-head">
        <div>
          <h1>Instacart</h1>
          <div className="a-sub">Neon turns meals, recipes and shopping lists into an Instacart link. Shoppers pick a store and check out on Instacart.</div>
        </div>
      </div>

      <div className="a-card ic-status">
        <dl>
          <dt>API key</dt>
          <dd>{configured ? "Set" : <span className="err">Not set: add INSTACART_API_KEY on Railway</span>}</dd>
          <dt>Server</dt>
          <dd>
            {instacartTestMode() ? "Development (test links)" : "Production"} · <code>{instacartBaseUrl()}</code>
          </dd>
          <dt>Who gets it</dt>
          <dd>{everyone ? "Every shopper in the US and Canada, plus testers" : "Only browsers turned on below"}</dd>
          <dt>This browser</dt>
          <dd>{tester ? "On: Neon can make Instacart lists for you" : "Off"}</dd>
        </dl>
        <form action={setTester}>
          <input type="hidden" name="on" value={tester ? "0" : "1"} />
          <button className={`a-btn ${tester ? "a-btn-ghost" : "a-btn-primary"}`}>{tester ? "Turn off for this browser" : "Turn on for this browser"}</button>
        </form>
        {configured && tester && <p className="small muted">Open the chat and ask for something like “groceries for taco night for 6”.</p>}
      </div>

      <div className="a-card">
        <h2>Going live</h2>
        <ol className="small">
          <li>Try it here with the development key until it works the way you want.</li>
          <li>Create a production key in Instacart’s developer dashboard and book the review demo.</li>
          <li>Once approved, set <code>INSTACART_API_KEY</code> to the production key and <code>INSTACART_API_URL</code> to <code>https://connect.instacart.com</code>.</li>
          <li>
            Set <code>INSTACART_ROLLOUT</code> to <code>everyone</code> to offer it to all shoppers in the US and Canada.
          </li>
        </ol>
      </div>
    </>
  );
}
