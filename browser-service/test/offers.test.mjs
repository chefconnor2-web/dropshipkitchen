// Car results and driver-form dropdowns (forms.mjs): offers read from their own cards and opened by index,
// a searchable custom dropdown, and a native country select matched by name or code.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { smartAction } from "../forms.mjs";

const card = (i, car, supplier, perDay, total) =>
  `<div class="offer"><div class="inner"><h3>${car}</h3><p>${supplier} · 8.${i}</p><p>$${perDay}/day</p><p>Total $${total}</p><p>Full to full</p></div><a href="#" onclick="document.title='opened:${car}';return false">View deal</a></div>`;
const RESULTS = `<!doctype html><body style="font:16px sans-serif"><div id=list>
${card(1, "Chevrolet Equinox or similar", "Hertz", "61.20", "183.60")}
${card(2, "Kia Rio or similar", "Alamo", "41.00", "123.00")}
${card(3, "Nissan Versa or similar", "NextCar", "44.10", "132.30")}
</div></body>`;

const FORM = `<!doctype html><body style="font:16px sans-serif">
<label for=res>Country of residence</label>
<select id=res><option value="">Select</option><option value="US">United States</option><option value="CA">Canada</option><option value="MX">Mexico</option></select>
<div><span>Month</span>
  <div id=month class="Select" tabindex=0 role=combobox onclick="openList()" style="width:200px;border:1px solid #ccc">Month</div>
  <ul id=opts role=listbox style="display:none"></ul>
</div>
<script>
const months=["January","February","March","April","May","June","July","August","September","October","November","December"];
function openList(){opts.style.display="block";render("")}
// Only the first five show until you type (a virtualised list).
function render(q){opts.innerHTML=months.filter(m=>m.toLowerCase().startsWith(q.toLowerCase())).slice(0,5).map(m=>'<li role=option onclick="month.textContent=this.textContent;opts.style.display=\\'none\\'">'+m+'</li>').join("")}
let typed="";document.addEventListener("keydown",e=>{if(opts.style.display!=="block")return;if(e.key.length===1){typed+=e.key;render(typed)}else if(e.key==="Backspace"){typed=typed.slice(0,-1);render(typed)}});
</script></body>`;

let browser;
before(async () => {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true, args: ["--no-sandbox"] });
});
after(async () => browser?.close());

test("list_offers reads each card (car, supplier, total) cheapest first; open_offer opens exactly that card", async () => {
  const p = await browser.newPage();
  await p.setContent(RESULTS);
  const r = await smartAction(p, { type: "list_offers" });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.offers.map((o) => o.total), [123, 132.3, 183.6]);
  assert.match(r.offers[0].text, /Kia Rio or similar.*Alamo.*Total \$123\.00/);
  const o = await smartAction(p, { type: "open_offer", index: r.offers[0].index });
  assert.equal(o.ok, true, o.why);
  assert.equal(await p.title(), "opened:Kia Rio or similar");
  // A re-rendered list loses the marks: open_offer says so instead of clicking something else.
  await p.setContent(RESULTS);
  const stale = await smartAction(p, { type: "open_offer", index: r.offers[0].index });
  assert.equal(stale.ok, false);
  assert.match(stale.why, /List the offers again/);
  await p.close();
});

test("native country of residence: chosen by name, or by its code", async () => {
  const p = await browser.newPage();
  await p.setContent(FORM);
  const a = await smartAction(p, { type: "select", field: "country of residence", value: "Canada", alternates: ["CA"] });
  assert.equal(a.ok, true, a.why);
  assert.equal(await p.$eval("#res", (e) => e.value), "CA");
  await p.$eval("#res", (e) => (e.value = ""));
  const b = await smartAction(p, { type: "select", field: "country of residence", value: "Kanada", alternates: ["CA"] });
  assert.equal(b.ok, true, b.why);
  assert.equal(await p.$eval("#res", (e) => e.value), "CA");
  await p.close();
});

test("searchable custom dropdown: types to filter when the option isn't listed yet", async () => {
  const p = await browser.newPage();
  await p.setContent(FORM);
  const r = await smartAction(p, { type: "select", field: "month", value: "October", alternates: ["10"] });
  assert.equal(r.ok, true, r.why);
  assert.equal(await p.$eval("#month", (e) => e.textContent), "October");
  await p.close();
});
