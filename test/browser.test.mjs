import test from "node:test";
import assert from "node:assert/strict";
import { chromium, firefox } from "playwright";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const useFirefox =
  process.env.SCD_BROWSER_ENGINE === "firefox" ||
  process.argv.includes("--firefox");
const browserType = useFirefox ? firefox : chromium;
const bravePath =
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const browserPath =
  process.env.SCD_BROWSER ||
  (browserType === chromium &&
  process.platform === "win32" &&
  existsSync(bravePath)
    ? bravePath
    : "");
const fixture = fileURLToPath(new URL("./fixture.html", import.meta.url));
const realShape = fileURLToPath(
  new URL("./fixtures/steam-real-profile-shape.html", import.meta.url),
);
const userscript = fileURLToPath(
  new URL("../steam-comment-deleter.user.js", import.meta.url),
);

test("browser fixture exercises the real panel flow", async () => {
  const browser = await browserType.launch(
    browserPath
      ? { headless: true, executablePath: browserPath }
      : { headless: true },
  );
  try {
    const page = await browser.newPage();
    await page.goto(`file://${fixture.replaceAll("\\", "/")}`);
    await page.waitForFunction(
      () =>
        document
          .querySelector("#results")
          ?.textContent.includes("PASS: run finishes without stale callbacks"),
      null,
      { timeout: 30000 },
    );
    const output = await page.locator("#results").textContent();
    assert.ok(output, "fixture returned no result text");
    const failures = output
      .split("\n")
      .filter((line) => line.startsWith("FAIL:"));
    assert.deepEqual(failures, [], output);
  } finally {
    await browser.close();
  }
});

test("sanitised real-Steam structure is detected read-only", async () => {
  const browser = await browserType.launch(
    browserPath
      ? { headless: true, executablePath: browserPath }
      : { headless: true },
  );
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(realShape, "utf8"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => {
      window.__SCD_TEST__ = true;
    });
    await page.addScriptTag({ path: userscript });
    assert.equal(await page.locator('.scd-panel.scd-light').count(), 1);
    assert.equal(await page.locator('[data-scc="theme"]').getAttribute('aria-label'), 'Switch to dark theme');
    await page.locator('[data-scc="theme"]').click();
    assert.equal(await page.locator('.scd-panel.scd-light').count(), 0);
    assert.equal(await page.locator('[data-scc="theme"]').getAttribute('aria-label'), 'Switch to light theme');
    assert.equal(await page.locator('[data-scc="archive"]').count(), 0);
    assert.equal(await page.locator('[data-scc="advance"]').isChecked(), false);
    assert.equal(await page.locator('[data-scc="advance"]').isVisible(), true);
    assert.equal(await page.locator('[data-scc="onlyText"]').isVisible(), false);
    await page.locator('[data-scc="advtoggle"]').click();
    assert.equal(await page.locator('[data-scc="advance"]').isVisible(), true);
    assert.equal(await page.locator('[data-scc="onlyText"]').isVisible(), true);
    await page.locator('[data-scc="fold"]').click();
    assert.equal(await page.locator('[data-scc="onlyText"]').isVisible(), false);
    await page.locator('[data-scc="fold"]').click();
    assert.equal(await page.locator('[data-scc="start"]').isEnabled(), false);
    await page.locator('[data-scc="preview"]').click();
    assert.equal(await page.locator(".commentthread_comment").count(), 1);
    assert.equal(await page.locator(".scd-would").count(), 1);
    assert.equal(await page.locator('[data-scc="start"]').isEnabled(), true);
    assert.match(
      await page.locator('[data-scc="log"]').textContent(),
      /Preview: 1 of 1/,
    );
    assert.equal(await page.locator('[data-scc="close"]').isVisible(), true);
    assert.equal(await page.locator('[data-scc="close"]').getAttribute('aria-label'), 'Close panel');
    await page.locator('[data-scc="close"]').click();
    assert.equal(await page.locator('.scd-panel').count(), 0);
  } finally {
    await browser.close();
  }
});

// Synthetic responses use the callback shape observed in Steam global.js.
// They are fault-injection tests, not evidence of a live deletion.
for (const outcome of ["success", "rejected", "wrong-sequence", "stop", "thread-replaced", "no-response", "busy"]) {
  test(`Steam direct deletion: ${outcome}`, async () => {
    const browser = await browserType.launch(browserPath
      ? { headless: true, executablePath: browserPath } : { headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 420, height: 640 } });
      await page.setContent(readFileSync(realShape, "utf8"));
      await page.evaluate((outcome) => {
        window.__SCD_TEST__ = true;
        window.__originalCallback = function () {};
        window.g_rgCommentThreads = { Profile_fixture: {
          m_bLoading: outcome === "busy", m_nRenderAjaxSequenceNumber: 0,
          OnResponseDeleteComment: window.__originalCallback,
        } };
        window.CCommentThread = { DeleteComment(threadId, id) {
          const thread = window.g_rgCommentThreads[threadId];
          const sequence = ++thread.m_nRenderAjaxSequenceNumber;
          const callback = thread.OnResponseDeleteComment.bind(thread);
          setTimeout(() => {
            if (outcome === "no-response") return;
            callback(outcome === "wrong-sequence" ? sequence + 1 : sequence,
              { responseJSON: { success: outcome !== "rejected" } });
            if (outcome !== "rejected") document.getElementById("comment_" + id).remove();
            if (outcome === "thread-replaced") {
              const root = document.querySelector('.commentthread_area');
              root.replaceWith(root.cloneNode(true));
            }
          }, 150);
        } };
      }, outcome);
      await page.addScriptTag({ path: userscript });
      await page.evaluate(() => Object.assign(window.steamCommentDeleter.CONFIG, {
        minDelayMs: 0, maxDelayMs: 0, dialogWaitMs: 300, vanishWaitMs: 600,
      }));
      assert.equal(await page.locator('[data-scc="log"]').isVisible(), false);
      await page.locator('[data-scc="advtoggle"]').click();
      assert.ok(await page.locator('.scd-panel').evaluate(el => el.getBoundingClientRect().height) < 440);
      await page.locator('[data-scc="preview"]').click();
      assert.equal(await page.locator('[data-scc="onlyText"]').isVisible(), false);
      assert.equal(await page.locator('[data-scc="preview"]').isVisible(), false);
      await page.locator('[data-scc="start"]').click();
      if (outcome === "stop") await page.locator('[data-scc="stop"]').click();
      await page.waitForFunction(() => !window.steamCommentDeleter.stats().running);
      const stats = await page.evaluate(() => window.steamCommentDeleter.stats());
      assert.equal(stats.deleted, outcome === "success" || outcome === "stop" ? 1 : 0);
      if (outcome === "busy") assert.equal(stats.submitted, 0);
      assert.equal(await page.evaluate(() =>
        window.g_rgCommentThreads.Profile_fixture.OnResponseDeleteComment === window.__originalCallback), true);
      assert.equal(await page.locator('[data-scc="stop"]').isVisible(), false);
    } finally { await browser.close(); }
  });
}
