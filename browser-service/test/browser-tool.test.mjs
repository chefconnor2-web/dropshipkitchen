// Claude's browser use toolset (browser-tool.mjs) on a Discover Cars-like page: a location box whose overlay
// stays open, div-only calendar days (no buttons, no labels: only cursor:pointer), a native time select and a
// Search button. read_page must hand out refs for all of them, and clicks / form_input on refs must work.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { runBrowserTool } from "../browser-tool.mjs";

const PAGE = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<input id=loc placeholder="Airport, city or station" value="Miami International Airport (MIA)">
<div class="Autocomplete-LocationPickerOverlay" style="position:fixed;inset:0;display:none"></div>
<div id=pd class="SearchDate" style="cursor:pointer;width:200px" onclick="cal.style.display='block'">Pick-up date</div>
<div id=cal style="display:none">
  <div class=month>October 2026</div>
  <div class=days>${Array.from({ length: 31 }, (_, i) => `<div class=day style="cursor:pointer;display:inline-block;width:30px" onclick="pick(${i + 1})">${i + 1}</div>`).join("")}</div>
</div>
<select id=pt aria-label="Pick-up time"><option>10:00</option><option>12:30</option><option>13:00</option></select>
<div style="height:1400px"></div>
<button id=search onclick="document.title='searched:'+loc.value+'|'+pd.textContent+'|'+pt.value">Search</button>
<script>function pick(d){pd.textContent='Oct '+d;cal.style.display='none'}</script>
</body></html>`;

let browser, page;
const ctx = { goto: async () => {}, shot: async () => "x" };
before(async () => {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setContent(PAGE);
});
after(async () => browser?.close());

const textOf = (r) => r.content.map((c) => c.text ?? "").join("");
const refFor = (tree, re) => tree.split("\n").find((l) => re.test(l))?.match(/\[(ref_\d+)\]/)?.[1];

test("read_page lists the form with refs, including div-only clickables", async () => {
  const r = await runBrowserTool(page, "read_page", { filter: "interactive" }, ctx);
  const t = textOf(r);
  assert.ok(!r.isError, t);
  assert.match(t, /textbox "Airport, city or station" \[ref_\d+\] value="Miami International Airport \(MIA\)"/);
  assert.match(t, /clickable "Pick-up date" \[ref_\d+\]/);
  assert.match(t, /combobox "Pick-up time" \[ref_\d+\] value="10:00" options=\[10:00 \| 12:30 \| 13:00\]/);
  // Search is below the fold: not in the visible view, but in "all".
  assert.doesNotMatch(t, /button "Search"/);
  assert.match(textOf(await runBrowserTool(page, "read_page", { filter: "all" }, ctx)), /button "Search" \[ref_\d+\]/);
});

test("refs stay the same between reads, and the calendar days get refs once open", async () => {
  const a = textOf(await runBrowserTool(page, "read_page", { filter: "interactive" }, ctx));
  const date = refFor(a, /Pick-up date/);
  const click = await runBrowserTool(page, "left_click", { target: { type: "ref", ref: date } }, ctx);
  assert.ok(!click.isError, textOf(click));
  const b = textOf(await runBrowserTool(page, "read_page", { filter: "interactive" }, ctx));
  assert.equal(refFor(b, /Pick-up date/), date);
  const day23 = refFor(b, /clickable "23"/);
  assert.ok(day23, b);
  await runBrowserTool(page, "left_click", { target: { type: "ref", ref: day23 } }, ctx);
  assert.equal(await page.$eval("#pd", (e) => e.textContent), "Oct 23");
});

test("form_input sets a native select by option text; find locates Search; click scrolls it into view", async () => {
  const tree = textOf(await runBrowserTool(page, "read_page", { filter: "interactive" }, ctx));
  const time = refFor(tree, /Pick-up time/);
  const set = await runBrowserTool(page, "form_input", { target: { type: "ref", ref: time }, value: "12:30" }, ctx);
  assert.match(textOf(set), /Selected "12:30"/);
  const found = textOf(await runBrowserTool(page, "find", { query: "search button" }, ctx));
  const search = refFor(found, /button "Search"/);
  assert.ok(search, found);
  await runBrowserTool(page, "left_click", { target: { type: "ref", ref: search } }, ctx);
  assert.equal(await page.title(), "searched:Miami International Airport (MIA)|Oct 23|12:30");
});

test("stale refs and bad input come back as errors, not throws", async () => {
  const r = await runBrowserTool(page, "left_click", { target: { type: "ref", ref: "ref_999" } }, ctx);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /stale or not found/);
  assert.equal((await runBrowserTool(page, "new_tab", {}, ctx)).isError, true);
  assert.equal((await runBrowserTool(page, "zoom", { region: [5, 5, 1, 1] }, ctx)).isError, true);
});

test("keys: combos and sequences", async () => {
  await page.focus("#loc");
  await runBrowserTool(page, "key", { text: "ctrl+a Backspace" }, ctx);
  await runBrowserTool(page, "type", { text: "MIA" }, ctx);
  assert.equal(await page.$eval("#loc", (e) => e.value), "MIA");
});
