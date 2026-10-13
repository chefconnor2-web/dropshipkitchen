// Fast form filling: Neon says what to put where ("pick-up location" = "Miami Airport (MIA)", "pick-up date" =
// 2026-10-23, "pick-up time" = 12:30, click "Search"), and the page itself finds the field (by its label,
// placeholder, aria-label, name or nearby text) and sets it, in one step with no screenshot in between. Works on
// plain inputs, autocompletes (types, then picks the matching suggestion), native and custom dropdowns, native
// and custom calendars (pages to the right month) and buttons by their text. Each action says what it did, so
// Neon falls back to tapping only when one can't be done this way.

const settle = (page, max = 700) => page.waitForNetworkIdle({ idleTime: 120, timeout: max }).catch(() => {});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Marks the field that best matches `hint` (data-neon-pick) and says what it is; null when nothing matches. */
function findField(hint, kinds) {
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const want = norm(hint);
  const words = want.split(" ").filter(Boolean);
  if (!words.length) return null;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const textsOf = (el) => {
    const t = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id, el.getAttribute("title"), el.getAttribute("data-testid")];
    if (el.id) for (const l of document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) t.push(l.textContent);
    const lab = el.closest("label");
    if (lab) t.push(lab.textContent);
    const by = el.getAttribute("aria-labelledby");
    if (by) for (const id of by.split(/\s+/)) t.push(document.getElementById(id)?.textContent);
    // Text just before it (a heading or span acting as the label), and a button's own text.
    let p = el.previousElementSibling;
    for (let i = 0; i < 2 && p; i++, p = p.previousElementSibling) t.push(p.textContent?.slice(0, 80));
    const parentLabel = el.parentElement?.querySelector("label, span, div")?.textContent;
    if (parentLabel && parentLabel.length < 80) t.push(parentLabel);
    if (el.matches("button, [role=button], [role=combobox], [aria-haspopup]")) t.push(el.textContent?.slice(0, 80));
    return t.filter(Boolean).map(norm);
  };
  const selector = {
    text: "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea, [contenteditable=true], [role=combobox], [role=textbox]",
    select: "select, [role=combobox], [aria-haspopup=listbox], [aria-haspopup=true], button, [role=button], input",
    date: "input, button, [role=button], [role=combobox], [aria-haspopup], [class*=date i], [data-testid*=date i]",
  }[kinds] || "input, select, textarea, button";
  let best = null;
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el) || el.disabled) continue;
    let score = 0;
    for (const t of textsOf(el)) {
      if (!t) continue;
      if (t === want) score = Math.max(score, 100);
      else if (t.includes(want)) score = Math.max(score, 80);
      else {
        // A partial match must include the hint's last word, the kind of field ("date", "time", "location",
        // "name"): "pick-up date" must not land on "Pick-up location".
        const tw = t.split(" ");
        const hit = words.filter((w) => tw.includes(w)).length;
        if (hit && tw.includes(words[words.length - 1])) score = Math.max(score, (hit / words.length) * 60);
      }
    }
    if (score > (best?.score ?? 0)) best = { el, score };
  }
  // More than half the words must match ("first name" must not land on "Full name").
  if (!best || best.score <= 30) return null;
  document.querySelectorAll("[data-neon-pick]").forEach((e) => e.removeAttribute("data-neon-pick"));
  best.el.setAttribute("data-neon-pick", "1");
  const el = best.el;
  return { tag: el.tagName.toLowerCase(), type: (el.getAttribute("type") || "").toLowerCase(), readOnly: !!el.readOnly, score: best.score };
}

/** The form's visible fields and buttons by their labels (when a field wasn't found: what's there instead). */
function fieldInventory() {
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const out = [];
  for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea, button, [role=combobox], [role=button]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || out.length >= 25) continue;
    const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "";
    const name = clean(el.getAttribute("aria-label") || lab || el.closest("label")?.textContent || el.getAttribute("placeholder") || el.previousElementSibling?.textContent || el.textContent || el.getAttribute("name"));
    if (name) out.push(`${el.tagName.toLowerCase()}${el.getAttribute("type") ? `[${el.getAttribute("type")}]` : ""}: ${name}`);
  }
  return out;
}

/** Clicks the visible option/button/link whose text best matches (exact first). `scope`: only inside open popups. */
function clickMatching(texts, scope) {
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const wants = texts.map(norm).filter(Boolean);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const sel =
    scope === "options"
      ? "[role=option], [role=menuitem], [role=listbox] li, ul li, [class*=option i], [class*=suggest i] li, [class*=dropdown i] li, [class*=autocomplete i] li, [data-value]"
      : "button, a, [role=button], input[type=submit], input[type=button], [role=option], [role=menuitem], [role=tab], label";
  let best = null;
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    const t = norm(el.textContent || el.value || el.getAttribute("aria-label"));
    if (!t || t.length > 200) continue;
    for (const w of wants) {
      const s = t === w ? 100 : t.startsWith(w) ? 85 : t.includes(w) ? 70 : 0;
      // Prefer the innermost element with the text (the option itself, not its list).
      const score = s ? s - Math.min(20, el.querySelectorAll("*").length / 5) : 0;
      if (score > (best?.score ?? 0)) best = { el, score, text: t };
    }
  }
  if (!best) return null;
  best.el.scrollIntoView({ block: "center" });
  best.el.click();
  return best.text.slice(0, 80);
}

// Things that look like autocomplete options. Plain "ul li" is only trusted when it appeared after typing.
const OPTION_SEL = "[role=option], [role=listbox] li, [role=listbox] > *, [class*=suggest i] li, [class*=suggest i] [class*=item i], [class*=autocomplete i] li, [class*=autocomplete i] [class*=item i], [class*=autocomplete i] [class*=option i], [class*=location i] [class*=item i], [class*=dropdown i] li, [class*=result i] li, ul li";

/** Marks the option-like elements already on the page before typing, so only the new dropdown counts. */
function markOptionsBefore(sel) {
  for (const el of document.querySelectorAll(sel)) el.setAttribute("data-neon-pre", "1");
}

/**
 * The best suggestion in the dropdown that appeared after typing, scored across the whole list (scrolled-off
 * options included): every typed word present, the airport code exactly (e.g. "(MIA)"), and "airport" when an
 * airport is wanted. Clicks it and returns its text, or null when no dropdown appeared.
 */
function pickSuggestion(value, code, sel) {
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const words = norm(value).split(" ").filter((w) => w.length > 1);
  const iata = String(code || "").toLowerCase();
  const shown = (el) => {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    // Inside a scrolling list an option may be out of view but still laid out.
    return el.getClientRects().length > 0;
  };
  const opts = [...document.querySelectorAll(sel)].filter((el) => {
    if (el.hasAttribute("data-neon-pre") || !shown(el)) return false;
    const t = norm(el.textContent);
    if (!t || t.length > 200) return false;
    // The option itself, not a list holding several.
    return !el.querySelector("li, [role=option]");
  });
  if (!opts.length) return null;
  let best = null;
  opts.forEach((el, idx) => {
    const t = norm(el.textContent);
    const tw = t.split(" ");
    let score = words.filter((w) => tw.includes(w)).length * 10;
    if (iata && tw.includes(iata)) score += 40;
    if (iata && /\bairport\b/.test(t)) score += 15;
    if (/\b(all locations|see all|show more|view all)\b/.test(t)) score -= 50;
    score -= idx * 0.1; // ties go to the site's own order
    if (!best || score > best.score) best = { el, score };
  });
  const el = best.el;
  el.scrollIntoView({ block: "nearest" });
  el.click();
  return el.textContent.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** After choosing: the field shows the choice, and no location dropdown or overlay is left covering the form. */
function closeLeftovers() {
  const open = [...document.querySelectorAll("[class*=Overlay], [class*=overlay], [class*=autocomplete i], [role=listbox]")].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== "none";
  });
  return open.length;
}

/** Every way a page might write a time: "12:30", "12:30 PM", "12.30", "1230". */
function timeForms(v) {
  const m = /^(\d{1,2})[:.]?(\d{2})$/.exec(String(v).trim());
  if (!m) return [String(v)];
  const h = Number(m[1]);
  const mm = m[2];
  const h12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? "am" : "pm";
  return [`${String(h).padStart(2, "0")}:${mm}`, `${h}:${mm}`, `${h12}:${mm} ${ap}`, `${h12}:${mm}${ap}`, `${String(h).padStart(2, "0")}.${mm}`, `${h12}:${mm} ${ap.toUpperCase()}`];
}

/** Every way a calendar might label a day (aria-label, title, data attributes). */
function dateForms(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  const opt = (o) => d.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  const day = d.getUTCDate();
  const mon = opt({ month: "long" });
  const mo = opt({ month: "short" });
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  // "23rd": calendar widgets often label days "Choose Friday, October 23rd, 2026".
  const th = day % 100 >= 11 && day % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] || "th";
  const wd = opt({ weekday: "long" });
  return [
    iso,
    `${y}/${mm}/${dd}`,
    `${dd}/${mm}/${y}`,
    `${mm}/${dd}/${y}`,
    `${dd}.${mm}.${y}`,
    `${mon} ${day}, ${y}`,
    `${day} ${mon} ${y}`,
    `${mo} ${day}, ${y}`,
    `${day} ${mo} ${y}`,
    `${mon} ${day}${th}, ${y}`,
    `${wd}, ${mon} ${day}${th}, ${y}`,
    `${wd} ${day} ${mon} ${y}`,
    opt({ weekday: "long", month: "long", day: "numeric", year: "numeric" }),
  ];
}

/** Clicks the calendar day for `forms` if it's showing; else "next" when given, to page forward. */
function calendarStep(forms, goNext) {
  const norm = (t) => String(t || "").toLowerCase().replace(/[\s,]+/g, " ").trim();
  const wants = forms.map(norm);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const attrs = ["data-date", "data-day", "data-value", "aria-label", "title", "datetime", "data-testid"];
  for (const el of document.querySelectorAll("[data-date], [data-day], [data-value], [aria-label], td[title], time, [role=gridcell], button, td")) {
    if (!visible(el)) continue;
    if (el.disabled || el.getAttribute("aria-disabled") === "true" || /disabled|outside/.test(el.className || "")) continue;
    for (const a of attrs) {
      const v = norm(el.getAttribute(a));
      if (v && wants.some((w) => v === w || v.includes(w))) {
        (el.querySelector("button") || el).click();
        return "picked";
      }
    }
  }
  if (!goNext) return "missing";
  for (const el of document.querySelectorAll("button, [role=button], a, span, div")) {
    if (!visible(el)) continue;
    const label = norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent);
    if (label.length > 30) continue;
    if (/^(next|next month|›|»|→|>)$|next month|go to next/.test(label) || /next/.test(String(el.className || "").toLowerCase())) {
      if (el.closest("[class*=calend i], [class*=picker i], [class*=month i], [role=dialog], [role=grid], [class*=date i]") || /month/.test(label)) {
        el.click();
        return "next";
      }
    }
  }
  return "missing";
}

/** Clicks the marked element: a real mouse click, or a script click when it isn't clickable that way. */
async function clickPicked(page) {
  const h = await page.$("[data-neon-pick]");
  if (!h) return false;
  await h.click().catch(() => h.evaluate((el) => el.click()).catch(() => {}));
  return true;
}

/** A short sample of the open calendar's markup, for the logs when a day couldn't be found. */
function calendarSample() {
  const cal = document.querySelector("[class*=calend i], [class*=datepicker i], [class*=picker i], [role=dialog], [role=grid]");
  return cal ? cal.outerHTML.replace(/\s+/g, " ").slice(0, 700) : "";
}

/** Types into the marked field, replacing what's there (real key presses, so autocompletes react). */
async function typeInto(page, value) {
  const h = await page.$("[data-neon-pick]");
  await h.click({ clickCount: 3 }).catch(() => h.focus().catch(() => {}));
  await page.keyboard.down("Control").catch(() => {});
  await page.keyboard.press("KeyA").catch(() => {});
  await page.keyboard.up("Control").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(String(value).slice(0, 200), { delay: 4 });
}

/** Sets a native input/select value the way frameworks notice (React, Vue). */
async function setNative(page, value) {
  return page.$eval(
    "[data-neon-pick]",
    (el, v) => {
      const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    },
    value,
  );
}

/**
 * One smart action. Returns { ok, did } (or { ok: false, why }) for Neon.
 * fill:   { field, value, choose? }  text field; choose = pick the matching suggestion that appears
 * select: { field, value }           native or custom dropdown (times understood in any format)
 * date:   { field?, value }          YYYY-MM-DD: native date input, or open the calendar and page to the day
 * click_text: { text }               the visible button/link/option with that text
 */
export async function smartAction(page, a) {
  const value = String(a.value ?? "");
  if (a.type === "click_text") {
    const did = await page.evaluate(clickMatching, [String(a.text ?? "")], "any");
    if (!did) return { ok: false, why: `No visible button or link reads "${a.text}".`, fields: await page.evaluate(fieldInventory).catch(() => []) };
    await settle(page);
    return { ok: true, did: `clicked "${did}"` };
  }
  if (a.type === "fill") {
    const f = await page.evaluate(findField, String(a.field ?? ""), "text");
    if (!f) return { ok: false, why: `No field like "${a.field}".`, fields: await page.evaluate(fieldInventory).catch(() => []) };
    if (a.choose) {
      // Always end on one of the site's own suggestions (never free text): the typed value first, then the
      // alternates (e.g. the airport code, "<city> airport", the city), each given time for the list to load.
      const tries = [value, ...(Array.isArray(a.alternates) ? a.alternates.map(String) : [])].filter((v, k, all) => v && all.indexOf(v) === k).slice(0, 3);
      for (const q of tries) {
        await page.evaluate(markOptionsBefore, OPTION_SEL).catch(() => {});
        await typeInto(page, q);
        // About 1.6 s per search: a list that hasn't appeared by then usually won't for this text.
        for (let i = 0; i < 12; i++) {
          await pause(i < 5 ? 100 : 150);
          const picked = await page.evaluate(pickSuggestion, q, String(a.code ?? ""), OPTION_SEL).catch(() => null);
          if (picked) {
            await settle(page, 500);
            // A dropdown or overlay still open would swallow the next click (Discover Cars' location picker).
            if (await page.evaluate(closeLeftovers).catch(() => 0)) {
              await page.keyboard.press("Escape").catch(() => {});
              await pause(150);
            }
            await page.evaluate(() => document.querySelectorAll("[data-neon-pre]").forEach((e) => e.removeAttribute("data-neon-pre"))).catch(() => {});
            return { ok: true, did: `typed "${q}", chose "${picked}" from the site's list` };
          }
        }
        // Re-find the field: typing may have re-rendered it.
        if (!(await page.evaluate(findField, String(a.field ?? ""), "text"))) break;
      }
      await page.evaluate(() => document.querySelectorAll("[data-neon-pre]").forEach((e) => e.removeAttribute("data-neon-pre"))).catch(() => {});
      return { ok: false, why: `Typed ${tries.map((t) => `"${t}"`).join(", ")} but the site showed no suggestion list to choose from.`, fields: await page.evaluate(fieldInventory).catch(() => []) };
    }
    await typeInto(page, value);
    return { ok: true, did: `typed "${value}"` };
  }
  if (a.type === "select") {
    const f = await page.evaluate(findField, String(a.field ?? ""), "select");
    if (!f) return { ok: false, why: `No dropdown like "${a.field}".`, fields: await page.evaluate(fieldInventory).catch(() => []) };
    const forms = timeForms(value).concat(value);
    if (f.tag === "select") {
      const did = await page.$eval(
        "[data-neon-pick]",
        (el, forms) => {
          const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
          const wants = forms.map(norm);
          const opt = [...el.options].find((o) => wants.includes(norm(o.text)) || wants.includes(norm(o.value))) || [...el.options].find((o) => wants.some((w) => norm(o.text).includes(w)));
          if (!opt) return null;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return opt.text.trim();
        },
        forms,
      );
      if (!did) return { ok: false, why: `"${a.field}" has no option "${value}".` };
      return { ok: true, did: `chose "${did}"` };
    }
    await clickPicked(page);
    for (let i = 0; i < 8; i++) {
      await pause(100);
      const did = await page.evaluate(clickMatching, forms, "options");
      if (did) {
        await settle(page, 400);
        return { ok: true, did: `chose "${did}"` };
      }
    }
    return { ok: false, why: `Opened "${a.field}" but found no option "${value}".` };
  }
  if (a.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, why: "Dates are YYYY-MM-DD." };
    if (a.field) {
      const f = await page.evaluate(findField, String(a.field), "date");
      if (!f) return { ok: false, why: `No date field like "${a.field}".`, fields: await page.evaluate(fieldInventory).catch(() => []) };
      if (f.tag === "input" && (f.type === "date" || f.type === "datetime-local")) {
        await setNative(page, f.type === "date" ? value : `${value}T12:00`);
        return { ok: true, did: `set ${value}` };
      }
      await clickPicked(page);
      await pause(250);
    }
    const forms = dateForms(value);
    for (let i = 0; i < 14; i++) {
      const step = await page.evaluate(calendarStep, forms, true);
      if (step === "picked") {
        await settle(page, 400);
        return { ok: true, did: `picked ${value}${i ? ` (paged ${i} month${i === 1 ? "" : "s"} ahead)` : ""}` };
      }
      if (step === "missing") break;
      await pause(120);
    }
    return { ok: false, why: `Couldn't find ${value} in the calendar.`, calendar: await page.evaluate(calendarSample).catch(() => "") };
  }
  return { ok: false, why: `Unknown action ${a.type}.` };
}

export const SMART = new Set(["fill", "select", "date", "click_text"]);
export { settle };
