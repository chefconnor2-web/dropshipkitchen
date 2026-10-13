// Smart form actions (forms.mjs) against a car-rental-like page: an autocomplete, a custom calendar a month
// ahead, native and custom time dropdowns, and a Search button. Each is one call; the whole form is quick.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { smartAction } from "../forms.mjs";

const PAGE = `<!doctype html><html><body style="font:16px sans-serif">
<label for=loc>Pick-up location</label>
<input id=loc autocomplete=off>
<ul id=sug style="list-style:none;padding:0"></ul>
<div><span>Pick-up date</span><button id=pd type=button>Choose a date</button></div>
<div id=cal style="display:none" class="calendar">
  <button type=button aria-label="Next month" onclick="show(1)">›</button>
  <div id=month></div><div id=days></div>
</div>
<label>Pick-up time <select id=pt><option value="10:00">10:00</option><option value="12:30">12:30</option><option value="13:00">13:00</option></select></label>
<div><span>Drop-off time</span><button id=dt type=button aria-haspopup=listbox onclick="document.getElementById('dl').style.display='block'">10:00 AM</button>
<ul id=dl role=listbox style="display:none"><li role=option>9:30 AM</li><li role=option>10:00 AM</li><li role=option>10:30 AM</li></ul></div>
<button id=search type=button onclick="document.title='searched:'+[loc.value,pd.textContent,pt.value,dt.textContent].join('|')">Search</button>
<script>
const names=["Miami Airport (MIA)","Miami Beach","Miami Downtown"];
loc.addEventListener("input",()=>{setTimeout(()=>{sug.innerHTML=names.filter(n=>n.toLowerCase().startsWith(loc.value.toLowerCase().slice(0,3))).map(n=>'<li role=option>'+n+'</li>').join("")},150)});
sug.addEventListener("click",e=>{if(e.target.tagName==="LI"){loc.value=e.target.textContent;sug.innerHTML=""}});
let m=new Date(Date.UTC(2026,9,1));
function show(step){m=new Date(Date.UTC(m.getUTCFullYear(),m.getUTCMonth()+step,1));month.textContent=m.toLocaleDateString("en-US",{month:"long",year:"numeric",timeZone:"UTC"});
 const n=new Date(Date.UTC(m.getUTCFullYear(),m.getUTCMonth()+1,0)).getUTCDate();let h="";
 for(let d=1;d<=n;d++){const dt=new Date(Date.UTC(m.getUTCFullYear(),m.getUTCMonth(),d));h+='<button type=button aria-label="'+dt.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric",timeZone:"UTC"})+'" onclick="pd.textContent=this.getAttribute(\\'aria-label\\');cal.style.display=\\'none\\'">'+d+'</button>'}
 days.innerHTML=h}
pd.onclick=()=>{cal.style.display="block";show(0)};
dl.addEventListener("click",e=>{if(e.target.tagName==="LI"){dt.textContent=e.target.textContent;dl.style.display="none"}});
</script></body></html>`;

let browser, page;
before(async () => {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.setContent(PAGE);
});
after(async () => browser?.close());

test("fills a whole rental-car search in a few quick calls, with no tapping by coordinates", async () => {
  const t0 = Date.now();
  const r1 = await smartAction(page, { type: "fill", field: "pick-up location", value: "Miami Airport (MIA)", choose: true });
  const r2 = await smartAction(page, { type: "date", field: "pick-up date", value: "2026-11-23" });
  const r3 = await smartAction(page, { type: "select", field: "pick-up time", value: "12:30" });
  const r4 = await smartAction(page, { type: "select", field: "drop-off time", value: "10:30" });
  const r5 = await smartAction(page, { type: "click_text", text: "Search" });
  const ms = Date.now() - t0;
  for (const r of [r1, r2, r3, r4, r5]) assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r2.did, /paged 1 month ahead/);
  assert.equal(await page.title(), "searched:Miami Airport (MIA)|November 23, 2026|12:30|10:30 AM");
  console.log(`# whole form: ${ms} ms`);
  assert.ok(ms < 4000, `took ${ms} ms`);
});

test("says what it couldn't do instead of guessing", async () => {
  assert.equal((await smartAction(page, { type: "fill", field: "frequent flyer number", value: "x" })).ok, false);
  assert.equal((await smartAction(page, { type: "select", field: "pick-up time", value: "23:45" })).ok, false);
  assert.equal((await smartAction(page, { type: "click_text", text: "Book a spaceship" })).ok, false);
  assert.equal((await smartAction(page, { type: "date", field: "pick-up date", value: "next tuesday" })).ok, false);
});

test("an autocomplete takes the suggestion holding every typed word ('Miami MIA' → 'Miami Airport (MIA)')", async () => {
  // A fresh tab: setContent on the same tab keeps the old page's script globals, so its own script would fail.
  page = await browser.newPage();
  await page.setContent(PAGE);
  const r = await smartAction(page, { type: "fill", field: "pick-up location", value: "Miami MIA", choose: true });
  assert.equal(r.ok, true);
  assert.equal(await page.$eval("#loc", (e) => e.value), "Miami Airport (MIA)");
});

test("picks a day from a react-datepicker-style calendar ('Choose Friday, October 23rd, 2026')", async () => {
  page = await browser.newPage();
  await page.setContent(`<!doctype html><body>
  <div><label for=d>Pick-up date</label><input id=d readonly onclick="document.getElementById('cal').style.display='block'"></div>
  <div id=cal class="react-datepicker" style="display:none"><div class="react-datepicker__month">
    ${[21, 22, 23, 24].map((n) => `<div role="option" class="react-datepicker__day" aria-label="Choose ${["Wednesday", "Thursday", "Friday", "Saturday"][n - 21]}, October ${n}${n === 21 ? "st" : n === 22 ? "nd" : n === 23 ? "rd" : "th"}, 2026" onclick="d.value='2026-10-${n}'">${n}</div>`).join("")}
  </div></div></body>`);
  const r = await smartAction(page, { type: "date", field: "pick-up date", value: "2026-10-23" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await page.$eval("#d", (e) => e.value), "2026-10-23");
});

test("'pick-up date' never lands on 'Pick-up location' (the kind of field must match)", async () => {
  page = await browser.newPage();
  await page.setContent(`<!doctype html><body>
  <label>Pick-up location <input id=loc></label>
  <div><span>Pick-up date</span><input id=d type=date></div></body>`);
  const r = await smartAction(page, { type: "date", field: "pick-up date", value: "2026-10-23" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await page.$eval("#d", (e) => e.value), "2026-10-23");
  assert.equal(await page.$eval("#loc", (e) => e.value), "");
});

// Discover Cars-like location box: a nav menu of <li>s already on the page, a long scrolling suggestion list
// (the airport is far down, out of view) of divs, an overlay left open after choosing, and a list that only
// answers some searches.
const LOCATION = `<!doctype html><html><body style="font:16px sans-serif">
<ul id=nav><li>Miami deals</li><li>Help</li></ul>
<label for=loc>Pick-up location</label><input id=loc autocomplete=off>
<div id=box class="Autocomplete-List" style="max-height:120px;overflow:auto"></div>
<div id=ov class="Autocomplete-LocationPickerOverlay" style="position:fixed;inset:0;display:none"></div>
<script>
const all=["Miami Beach","Miami Downtown","Miami Gardens","Miami Lakes","Miami Springs","Miami Shores","Miami International Airport (MIA)","Miami Port"];
let typed=[];
loc.addEventListener("input",()=>{typed.push(loc.value);setTimeout(()=>{
  const q=loc.value.toLowerCase();
  const hits=q==="miami mia"?[]:all.filter(n=>n.toLowerCase().includes(q.split(" ")[0])||n.toLowerCase().includes("("+q+")"));
  box.innerHTML=hits.map(n=>'<div class="Autocomplete-item" style="height:30px">'+n+'</div>').join("");ov.style.display=hits.length?"block":"none"},200)});
box.addEventListener("click",e=>{if(e.target.classList.contains("Autocomplete-item")){loc.value=e.target.textContent;box.innerHTML="";window.chosen=e.target.textContent}});
document.addEventListener("keydown",e=>{if(e.key==="Escape")ov.style.display="none"});
</script></body></html>`;

test("location: always one of the site's suggestions, the airport by its code, even scrolled out of view", async () => {
  const p = await browser.newPage();
  await p.setContent(LOCATION);
  // "Miami MIA" shows no list on this site: the code alone does, and the airport is 7th in a scrolling list.
  const r = await smartAction(p, { type: "fill", field: "pick-up location", value: "Miami MIA", choose: true, code: "MIA", alternates: ["MIA", "Miami airport", "Miami"] });
  assert.equal(r.ok, true, r.why);
  assert.match(r.did, /chose "Miami International Airport \(MIA\)" from the site's list/);
  assert.equal(await p.evaluate(() => window.chosen), "Miami International Airport (MIA)");
  // The overlay the site left open is closed, and the page's own menu was never touched.
  assert.equal(await p.$eval("#ov", (e) => e.style.display), "none");
  await p.close();
});

test("location: no suggestion list at all is reported, never left as typed text", async () => {
  const p = await browser.newPage();
  await p.setContent(`<label for=loc>Pick-up location</label><input id=loc><ul><li>Menu</li></ul>`);
  const r = await smartAction(p, { type: "fill", field: "pick-up location", value: "Miami MIA", choose: true, code: "MIA", alternates: ["MIA"] });
  assert.equal(r.ok, false);
  assert.match(r.why, /no suggestion list/);
  await p.close();
});
