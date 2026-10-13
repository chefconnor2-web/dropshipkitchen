// Claude's browser use toolset (browser_toolset_20260801), run on a Puppeteer page: the storefront's vision
// helper sends each member call Claude makes here and passes back what this returns. Elements are addressed
// by refs ("ref_12") that read_page / find hand out; a ref is a data attribute on the element, so it stays the
// same until the page navigates. Coordinates are viewport pixels of the screenshot.
// Tab members are switched off in the storefront (one tab per chat), so they aren't handled here.

import { settle } from "./forms.mjs";

const REF_ATTR = "data-cx-ref";
const MAX_TREE = 24000;

/** The page as tagged lines ("button \"Search\" [ref_4]"), built in the page. */
function treeInPage({ filter, depth, ref, attr, max }) {
  let n = window.__cxRefN || 0;
  const vw = innerWidth, vh = innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return false;
    if (filter !== "all" && (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)) return false;
    return true;
  };
  const text = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return text(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (text(t)) return text(t);
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && text(l.textContent)) return text(l.textContent);
    }
    const wrap = el.closest("label");
    if (wrap && wrap !== el && text(wrap.textContent)) return text(wrap.textContent);
    return text(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || (el.tagName === "INPUT" || el.tagName === "SELECT" ? "" : el.innerText) || "");
  };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName;
    if (t === "A" && el.hasAttribute("href")) return "link";
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = (el.type || "text").toLowerCase();
      if (ty === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      if (ty === "search") return "searchbox";
      return "textbox";
    }
    if (/^H[1-6]$/.test(t)) return "heading";
    if (t === "IMG") return el.getAttribute("alt") ? "img" : null;
    if (t === "LABEL") return "label";
    if (t === "TD" || t === "TH") return "cell";
    return null;
  };
  // Clickable things that aren't buttons in the markup (calendar days, custom dropdown options...).
  const clickable = (el) => {
    if (el.hasAttribute("onclick") || (el.tabIndex >= 0 && el.hasAttribute("tabindex"))) return true;
    if (getComputedStyle(el).cursor !== "pointer") return false;
    const p = el.parentElement;
    return !p || getComputedStyle(p).cursor !== "pointer";
  };
  const INTERACTIVE = /^(button|link|textbox|searchbox|combobox|checkbox|radio|option|menuitem|menuitemradio|menuitemcheckbox|tab|switch|slider|spinbutton|gridcell|listbox|treeitem)$/;
  const lines = [];
  let size = 0;
  const root = ref ? document.querySelector(`[${attr}="${ref}"]`) : document.body;
  if (!root) return { error: `${ref} is stale or not found on the current page. Re-read the page to get fresh references.` };
  const walk = (el, d, shown) => {
    if (size > max || d > depth + 40) return;
    if (!(el instanceof Element)) return;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "SVG" || tag === "svg") return;
    if (el.getAttribute("aria-hidden") === "true") return;
    let role = roleOf(el);
    if (!role && clickable(el) && text(el.innerText).length <= 80) role = "clickable";
    const isInteractive = role && (INTERACTIVE.test(role) || role === "clickable" || role === "cell" && clickable(el));
    let include = false;
    if (role && visible(el)) include = filter === "interactive" ? isInteractive : true;
    // Plain text (headings, prices, labels) in the default view, so the page reads like what's on screen.
    if (!include && filter !== "interactive" && !role && visible(el)) {
      const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" ");
      if (text(own).length > 1) {
        const line = `${"  ".repeat(Math.min(shown, 8))}text "${text(own).slice(0, 120)}"`;
        lines.push(line);
        size += line.length;
      }
    }
    if (include) {
      let r = el.getAttribute(attr);
      if (!r) {
        r = `ref_${++n}`;
        el.setAttribute(attr, r);
      }
      const extras = [];
      if ("value" in el && el.tagName !== "BUTTON" && el.value && role !== "checkbox" && role !== "radio") extras.push(`value="${text(el.tagName === "SELECT" ? el.options[el.selectedIndex]?.text : el.value).slice(0, 60)}"`);
      if (el.checked) extras.push("checked");
      if (el.disabled || el.getAttribute("aria-disabled") === "true") extras.push("disabled");
      if (el.getAttribute("aria-selected") === "true") extras.push("selected");
      if (el.getAttribute("aria-expanded")) extras.push(`expanded=${el.getAttribute("aria-expanded")}`);
      if (role === "combobox" && el.tagName === "SELECT") extras.push(`options=[${[...el.options].slice(0, 30).map((o) => text(o.text)).join(" | ")}]`);
      const line = `${"  ".repeat(Math.min(shown, 8))}${role} "${nameOf(el).slice(0, 100)}" [${r}]${extras.length ? ` ${extras.join(" ")}` : ""}`;
      lines.push(line);
      size += line.length;
    }
    if (shown >= depth) return;
    for (const c of el.children) walk(c, d + 1, include ? shown + 1 : shown);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, d + 1, include ? shown + 1 : shown);
  };
  walk(root, 0, 0);
  window.__cxRefN = n;
  return { lines, truncated: size > max };
}

const KEY_NAMES = {
  return: "Enter", enter: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", backspace: "Backspace", delete: "Delete", del: "Delete",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  page_down: "PageDown", pagedown: "PageDown", page_up: "PageUp", pageup: "PageUp", home: "Home", end: "End", space: "Space", " ": "Space",
  ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", cmd: "Meta", super: "Meta", meta: "Meta",
};
const keyName = (k) => KEY_NAMES[k.toLowerCase()] ?? (k.length === 1 ? k : k[0].toUpperCase() + k.slice(1));

async function pressCombo(page, combo) {
  const parts = combo.split("+").filter(Boolean).map(keyName);
  const main = parts.pop();
  for (const m of parts) await page.keyboard.down(m);
  await page.keyboard.press(main);
  for (const m of parts.reverse()) await page.keyboard.up(m);
}

const text = (t) => ({ content: [{ type: "text", text: t }] });

/** Center of a target ({type:"ref"} or {type:"coordinate"}) in viewport pixels, scrolling a ref into view. */
async function point(page, target) {
  if (target?.type === "coordinate" || (Number.isFinite(target?.x) && Number.isFinite(target?.y))) return { x: Number(target.x), y: Number(target.y) };
  if (target?.type === "ref" && typeof target.ref === "string") {
    const el = await page.$(`[${REF_ATTR}="${target.ref.replace(/[^\w-]/g, "")}"]`);
    if (!el) throw new ToolError(`${target.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    await el.evaluate((e) => e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }));
    const box = await el.boundingBox();
    if (!box) throw new ToolError(`${target.ref} isn't visible on the page.`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, el };
  }
  throw new ToolError("Give a target: {type:\"ref\", ref} or {type:\"coordinate\", x, y}.");
}

class ToolError extends Error {}

/**
 * Runs one member call. `goto(url)` opens a page (it enforces the allowed sites). `shot()` takes the
 * viewport screenshot (base64 JPEG). Returns { content } (tool_result blocks) or { content, isError }.
 */
export async function runBrowserTool(page, name, input = {}, { goto, shot }) {
  try {
    switch (name) {
      case "screenshot":
        return { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await shot() } }] };
      case "zoom": {
        const [x0, y0, x1, y1] = (Array.isArray(input.region) ? input.region : []).map(Number);
        if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) throw new ToolError("region must be [x0, y0, x1, y1].");
        const data = await page.screenshot({ type: "jpeg", quality: 70, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, encoding: "base64" });
        return { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }] };
      }
      case "navigate": {
        const u = String(input.url ?? "");
        if (u === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        else if (u === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        else if (u === "reload") await page.reload({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        else await goto(u);
        await settle(page, 800);
        return text(`Navigated. URL: ${page.url()} Title: ${await page.title().catch(() => "")}`);
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const p = await point(page, input.target);
        const mods = String(input.modifiers ?? "").split("+").filter(Boolean).map(keyName);
        for (const m of mods) await page.keyboard.down(m);
        const button = name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left";
        const count = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
        await page.mouse.click(p.x, p.y, { button, count, delay: 20 });
        for (const m of mods.reverse()) await page.keyboard.up(m);
        await settle(page, 600);
        return text(`Clicked ${input.target?.ref ? `element ${input.target.ref}` : `(${Math.round(p.x)}, ${Math.round(p.y)})`}.`);
      }
      case "hover":
      case "mouse_move": {
        const p = await point(page, input.target);
        await page.mouse.move(p.x, p.y);
        await settle(page, 300);
        return text("Moved the mouse.");
      }
      case "left_click_drag": {
        const a = await point(page, input.from);
        const b = await point(page, input.target);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x, b.y, { steps: 8 });
        await page.mouse.up();
        await settle(page, 400);
        return text("Dragged.");
      }
      case "scroll": {
        const p = input.target ? await point(page, input.target) : { x: 640, y: 400 };
        const amount = Math.max(1, Math.min(10, Number(input.scroll_amount) || 3)) * 100;
        const dir = String(input.scroll_direction || "down");
        await page.mouse.move(p.x, p.y);
        await page.mouse.wheel({ deltaX: dir === "left" ? -amount : dir === "right" ? amount : 0, deltaY: dir === "up" ? -amount : dir === "down" ? amount : 0 });
        await new Promise((r) => setTimeout(r, 200));
        return text(`Scrolled ${dir}.`);
      }
      case "scroll_to": {
        await point(page, input.target);
        return text(`Scrolled ${input.target?.ref} into view.`);
      }
      case "type": {
        await page.keyboard.type(String(input.text ?? "").slice(0, 500), { delay: 8 });
        await settle(page, 400);
        return text("Typed.");
      }
      case "key": {
        const repeat = Math.max(1, Math.min(100, Number(input.repeat) || 1));
        const seq = String(input.text ?? "").trim().split(/\s+/).filter(Boolean);
        if (!seq.length) throw new ToolError("No key given.");
        for (let i = 0; i < repeat; i++) for (const combo of seq) await pressCombo(page, combo);
        await settle(page, 400);
        return text(`Pressed ${seq.join(" ")}${repeat > 1 ? ` ×${repeat}` : ""}.`);
      }
      case "wait": {
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(5, Number(input.duration) || 1)) * 1000));
        return text("Waited.");
      }
      case "read_page": {
        const filter = ["interactive", "all"].includes(input.filter) ? input.filter : "visible";
        const depth = Math.max(1, Math.min(40, Number(input.depth) || 15));
        const r = await page.evaluate(treeInPage, { filter, depth, ref: typeof input.ref === "string" ? input.ref.replace(/[^\w-]/g, "") : null, attr: REF_ATTR, max: MAX_TREE });
        if (r.error) throw new ToolError(r.error);
        return text(`URL: ${page.url()}\n${r.lines.join("\n") || "(nothing visible)"}${r.truncated ? "\n[Output truncated: use filter \"interactive\" or a ref to read less.]" : ""}`);
      }
      case "find": {
        const q = String(input.query ?? "").toLowerCase();
        const words = q.split(/[^a-z0-9:]+/).filter((w) => w.length > 1);
        const r = await page.evaluate(treeInPage, { filter: "all", depth: 40, ref: null, attr: REF_ATTR, max: MAX_TREE * 3 });
        const scored = r.lines
          .filter((l) => /\[ref_\d+\]/.test(l))
          .map((l) => ({ l: l.trim(), s: words.reduce((a, w) => a + (l.toLowerCase().includes(w) ? 1 : 0), 0) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 20);
        return text(scored.length ? scored.map((x) => x.l).join("\n") : `Nothing matching "${input.query}". Try read_page or a screenshot.`);
      }
      case "get_page_text": {
        const t = await page.evaluate(() => (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n"));
        return text(t.slice(0, 20000) || "(no text)");
      }
      case "form_input": {
        const ref = String(input.target?.ref ?? "").replace(/[^\w-]/g, "");
        const el = await page.$(`[${REF_ATTR}="${ref}"]`);
        if (!el) throw new ToolError(`${ref || "That ref"} is stale or not found on the current page. Re-read the page to get fresh references.`);
        const did = await el.evaluate((e, value) => {
          const fire = () => {
            e.dispatchEvent(new Event("input", { bubbles: true }));
            e.dispatchEvent(new Event("change", { bubbles: true }));
          };
          if (e.tagName === "SELECT") {
            const want = String(value).toLowerCase();
            const opts = [...e.options];
            const o = opts.find((x) => x.value.toLowerCase() === want || x.text.trim().toLowerCase() === want) || opts.find((x) => x.text.toLowerCase().includes(want));
            if (!o) return `No option "${value}". Options: ${opts.slice(0, 30).map((x) => x.text.trim()).join(" | ")}`;
            e.value = o.value;
            fire();
            return `Selected "${o.text.trim()}".`;
          }
          if (e.type === "checkbox" || e.type === "radio") {
            const on = value === true || /^(true|on|yes|1)$/i.test(String(value));
            if (e.checked !== on) e.click();
            return `${on ? "Checked" : "Unchecked"}.`;
          }
          if (!("value" in e)) return "That element isn't a form field: click it instead.";
          const proto = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(e, String(value));
          fire();
          return `Set to "${String(value).slice(0, 40)}".`;
        }, input.value);
        await settle(page, 400);
        return text(did);
      }
      default:
        throw new ToolError(`${name} isn't available here.`);
    }
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    return { content: [{ type: "text", text: `Error: ${String(e?.message || e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200)}` }], isError: true };
  }
}
