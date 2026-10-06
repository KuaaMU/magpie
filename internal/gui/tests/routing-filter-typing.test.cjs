// Run with Node's test runner and Playwright on the module path; see README.md.
// #1055: in the routing groups' filter, one key press put in two
// characters. drawGroups() runs synchronously from the filter's own input
// event, and rebuilt the header with gHead.replaceChildren(...head) — which
// took the box being typed in out of the document on every keystroke and put
// it back with a hand-written focus() + setSelectionRange(). The caret went
// with it, and on the WebKit builds macOS and WebKitGTK run on, the next
// character landed twice.
// - While the filter holds the keyboard it is the very same box throughout:
//   not taken out of the document, still focused, caret following the text,
//   and one key press putting in exactly one character.
// - What the header is made of still changes when it should: with nothing to
//   filter there is no box at all, and with two groups Select and New group
//   are there beside it.
// - No keystroke moves the page. In English and Chinese, Chromium and WebKit.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const models = [
  { id: "a/one", name: "one", providerName: "A", icon: "generic" },
  { id: "a/two", name: "two", providerName: "A", icon: "generic" },
  { id: "b/three", name: "three", providerName: "B", icon: "generic" },
];

const words = {
  en: { filter: "Filter groups and models", none: "No group or model matches “zzz”" },
  zh: { filter: "筛选路由组和模型", none: "没有路由组或模型匹配“zzz”" },
};

// one group: nothing to filter, so the filter is not there to begin with
const oneGroup = [
  { id: "g", name: "G", members: ["a/one"], off: [], routing: "order", ready: true, memberInfo: [{ id: "a/one", ready: true }] },
];
const threeGroups = [
  ...oneGroup,
  { id: "other", name: "Other", members: ["a/two"], off: [], routing: "order", ready: true, memberInfo: [{ id: "a/two", ready: true }] },
  { id: "fast", name: "Fast lane", members: ["b/three"], off: [], routing: "order", ready: true, memberInfo: [{ id: "b/three", ready: true }] },
];

function serve(lang, list) {
  const state = { agents: [{ id: "codex", name: "Codex", path: "/test/codex", fields: [] }], profiles: [], settings: { lang, theme: "light" } };
  return async (r) => {
    const url = new URL(r.request().url());
    const json = (data) => r.fulfill({ json: data });
    if (url.pathname === "/boot.js") return r.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return r.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/gateway/trace") {
      if (url.searchParams.get("wait")) return new Promise(() => {}); // nothing more comes
      return json({ mine: true, now: new Date().toISOString(), seq: 1, totals: { requests: 0, rerouted: 0, errors: 0 }, routes: [] });
    }
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/groups") return json({ models, pools: [], groups: list });
    if (url.pathname.startsWith("/api/groups/")) return json({ models, pools: [], groups: list });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true, url: "http://127.0.0.1:3999" } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await r.fulfill({ body: await fs.readFile(file), contentType });
  };
}

async function open(t, engine, lang, list) {
  const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 1400 }, reducedMotion: "reduce" })).newPage();
  t.after(() => browser.close());
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", serve(lang, list));
  await page.goto("http://magpie.test/?view=routing");
  await page.locator(".rt-group").first().waitFor();
  return { page, errors };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    const w = words[lang];

    test(`${engine} ${lang}: one key press in the groups filter puts in one character`, async (t) => {
      const { page, errors } = await open(t, engine, lang, threeGroups);
      const q = page.locator(".rt-gsec .row-head input.rt-gfilter");
      await q.waitFor();
      assert.equal(await q.getAttribute("placeholder"), w.filter);
      assert.equal(await q.getAttribute("aria-label"), w.filter);
      await page.locator(".rt-gsec").evaluate((x) => x.scrollIntoView({ block: "center" })); // as the reader would
      await page.waitForTimeout(200);
      const at = () => page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => e.scrollTop).map((e) => [e.id || e.className, e.scrollTop]).join(";"));
      const before = await at();
      await q.click();

      // watch the box being taken out of the document, and put it back if it goes
      await page.evaluate(() => {
        window.__box = document.querySelector(".rt-gfilter");
        window.__out = 0;
        new MutationObserver((ms) => {
          for (const m of ms) for (const n of m.removedNodes) {
            if (n === window.__box || (n.contains && n.contains(window.__box))) window.__out++;
          }
        }).observe(document.body, { childList: true, subtree: true });
      });

      // one key at a time, as a reader types: exactly one character each
      const seen = [];
      for (const c of "12345") {
        await page.keyboard.type(c);
        seen.push(await q.inputValue());
      }
      assert.deepEqual(seen, ["1", "12", "123", "1234", "12345"], "one press did not put in one character");
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".rt-gfilter")), true, "the keyboard left the filter");
      assert.equal(await page.evaluate(() => window.__out), 0, "the box was taken out of the document while being typed in");

      // the same box throughout, and the caret following the text
      assert.equal(await page.evaluate(() => document.querySelector(".rt-gfilter") === window.__box), true, "the filter is a new box each keystroke");
      assert.equal(await q.evaluate((x) => x.selectionStart), 5, "the caret did not follow the text");

      // the caret can be moved and more typed after it, still one each
      await q.evaluate((x) => x.setSelectionRange(2, 2));
      await page.keyboard.type("9");
      assert.equal(await q.inputValue(), "129345", "typing after moving the caret lost or doubled a character");
      assert.equal(await q.evaluate((x) => x.selectionStart), 3, "the caret did not follow the text");
      assert.equal(await page.evaluate(() => window.__out), 0, "the box was taken out of the document while being typed in");

      // deleting takes characters out again, one at a time
      for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
      assert.equal(await q.inputValue(), "12", "Backspace lost or doubled a character");
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".rt-gfilter")), true, "the keyboard left the filter");
      assert.equal(await page.evaluate(() => window.__out), 0);

      // it still filters: every word in a group's name, id or models
      await q.fill("three");
      assert.deepEqual(await page.locator(".rt-groups .rt-group").evaluateAll((rs) => rs.map((r) => r.dataset.id)), ["fast"], "by a model's name");
      await q.fill("zzz");
      assert.deepEqual(await page.locator(".rt-groups .rt-group").evaluateAll((rs) => rs.map((r) => r.dataset.id)), []);
      assert.equal((await page.locator(".rt-groups .rt-gnone").textContent()).trim(), w.none);
      await q.focus();
      await page.keyboard.press("Escape");
      assert.equal(await q.inputValue(), "");
      assert.deepEqual(await page.locator(".rt-groups .rt-group").evaluateAll((rs) => rs.map((r) => r.dataset.id)), ["g", "other", "fast"]);
      assert.equal(await at(), before, "the filter moved the page");

      // Select and New group are still there beside it
      const head = await page.locator(".rt-gsec .row-head").evaluate((h) => [...h.children].map((c) => c.className || c.tagName));
      assert.deepEqual(head.filter((c) => /rt-gfilter|rt-gselect|rt-gnew/.test(c)), ["sess-filter rt-gfilter", "text rt-gselect", "text rt-gnew"], "the header lost or reordered what sits beside the box");
      assert.deepEqual(errors, []);
    });

    test(`${engine} ${lang}: one group leaves nothing to filter, so no filter`, async (t) => {
      const { page, errors } = await open(t, engine, lang, oneGroup);
      assert.equal(await page.locator(".rt-gsec .row-head input.rt-gfilter").count(), 0, "there is a filter with nothing to filter");
      assert.equal(await page.locator(".rt-gnew").count(), 1, "New group is gone");
      assert.equal(await page.locator(".rt-gselect").count(), 0, "Select is there with one group");
      assert.deepEqual(errors, []);
    });

    // The header is left alone while it is the one asked for, which is every
    // keystroke. It must still be rebuilt when it stops being that one, even
    // when the box being typed in is the thing holding the keyboard: Select
    // takes the filter's own buttons away with it.
    test(`${engine} ${lang}: the header is still rebuilt when what it is made of changes`, async (t) => {
      const { page, errors } = await open(t, engine, lang, threeGroups);
      const q = page.locator(".rt-gsec .row-head input.rt-gfilter");
      await q.waitFor();
      const head = () => page.locator(".rt-gsec .row-head").evaluate((h) => [...h.children].map((c) => c.className || c.tagName));
      assert.deepEqual((await head()).filter((c) => /rt-gfilter|rt-gselect|rt-gnew/.test(c)), ["sess-filter rt-gfilter", "text rt-gselect", "text rt-gnew"]);

      await q.click();
      await page.keyboard.type("1");
      assert.equal(await q.evaluate((x) => x.selectionStart), 1, "the caret did not follow the text");

      // .click() dispatches without moving focus, so this is the header changing
      // shape underneath the keyboard: picking takes Select and New group away.
      await page.locator(".rt-gselect").evaluate((b) => b.click());
      assert.deepEqual((await head()).filter((c) => /rt-gfilter|rt-gselect|rt-gnew/.test(c)), ["sess-filter rt-gfilter"], "the header kept Select and New group while picking");
      assert.equal(await page.locator(".rt-group .rt-gpick").count(), 3, "picking did not take hold");
      assert.equal(await q.inputValue(), "1", "rebuilding the header lost what was typed");
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".rt-gfilter")), true, "the keyboard left the filter");
      assert.equal(await q.evaluate((x) => x.selectionStart), 1, "rebuilding the header lost the caret");

      // and more typing still lands one character at a time, in the new header
      await page.keyboard.type("23");
      assert.equal(await q.inputValue(), "123", "one press did not put in one character");
      assert.equal(await q.evaluate((x) => x.selectionStart), 3, "the caret did not follow the text");
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".rt-gfilter")), true, "the keyboard left the filter");
      assert.deepEqual(errors, []);
    });
  }
}