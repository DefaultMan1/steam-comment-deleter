(async function () {
  "use strict";
  var results = [];
  function check(name, condition) {
    results.push((condition ? "PASS: " : "FAIL: ") + name);
  }
  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  function fresh(page) {
    window.__current = page || 1;
    window.__renderComments();
    return wait(50);
  }
  var sc = window.steamCommentDeleter;
  check("userscript loaded", !!sc);
  if (!sc) {
    document.getElementById("results").textContent = results.join("\n");
    return;
  }

  var C = sc.CONFIG;
  C.minDelayMs = 5;
  C.maxDelayMs = 5;
  C.dialogWaitMs = 500;
  C.vanishWaitMs = 500;
  C.pageWaitMs = 500;
  C.maxDeletes = 20;
  var preview = document.querySelector('[data-scc="preview"]');
  var start = document.querySelector('[data-scc="start"]');
  var stop = document.querySelector('[data-scc="stop"]');
  var advance = document.querySelector('[data-scc="advance"]');
  var log = document.querySelector('[data-scc="log"]');
  check("preview is available", !!preview && preview.disabled === false);
  check("pagination is off by default", !!advance && advance.checked === false);
  check("archive controls are removed", !document.querySelector('[data-scc="archive"]'));
  check("start is gated before preview", start.disabled === true);
  preview.click();
  check(
    "preview selects the three current comments",
    /Preview: 3 of 3/.test(log.textContent),
  );
  check(
    "preview identifies the profile and cap",
    /Profile:/.test(log.textContent) &&
      /Deletion cap: 20/.test(log.textContent),
  );
  check(
    "preview reports current-page-only scope",
    /Pagination: current page only/.test(log.textContent),
  );
  check("start is enabled only after preview", start.disabled === false);
  check(
    "preview has not removed a row",
    document.querySelectorAll(".commentthread_comment").length === 3,
  );

  document.querySelector(
    "#comment_alpha .commentthread_comment_text",
  ).textContent = "same count but changed";
  await wait(250);
  check(
    "same-count DOM changes invalidate preview",
    start.disabled === true && /Preview cleared: comment list changed/.test(log.textContent),
  );
  await fresh(1);
  preview.click();

  C.filters.neverText = "/gg/";
  preview.click();
  check(
    "legacy regex syntax blocks preview",
    /legacy regex syntax/.test(log.textContent),
  );
  C.filters.neverText = "";
  preview.click();
  start.click();
  var deadline = Date.now() + 4000;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check(
    "current-page-only run deletes only the current page",
    document.querySelectorAll(".commentthread_comment").length === 0,
  );
  check("run finishes without stale callbacks", sc.stats().running === false);

  await fresh(1);
  advance.checked = true;
  window.__appendNewAfterDelete = true;
  preview.click();
  start.click();
  deadline = Date.now() + 6000;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check("all-pages mode processes refilled comments before advancing",
    sc.stats().deleted === 7 && !document.querySelector("#comment_late"));
  advance.checked = false;

  await fresh(1);
  C.maxDeletes = 20;
  window.__appendNewAfterDelete = true;
  preview.click();
  start.click();
  deadline = Date.now() + 4000;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check(
    "current-page run does not delete a row added after preview",
    document.querySelectorAll(".commentthread_comment").length === 1 &&
      document.querySelector("#comment_late") &&
      sc.stats().deleted === 3,
  );

  await fresh(1);
  C.maxDeletes = 20;
  window.__SCD_TEST_BEFORE_DELETE = function (meta) {
    if (meta.id === "alpha")
      document.querySelector("#comment_alpha .commentthread_comment_text").textContent =
        "changed after preview";
  };
  preview.click();
  start.click();
  deadline = Date.now() + 4000;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check(
    "changed preview target is skipped before the Delete click",
    document.querySelector("#comment_alpha") &&
      document.querySelectorAll(".commentthread_comment").length === 1 &&
      sc.stats().deleted === 2 &&
      /skipped: comment changed/.test(log.textContent),
  );
  window.__SCD_TEST_BEFORE_DELETE = null;

  await fresh(1);
  advance.checked = true;
  advance.dispatchEvent(new Event("change", { bubbles: true }));
  C.maxDeletes = 20;
  preview.click();
  start.click();
  deadline = Date.now() + 4000;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check(
    "explicit pagination run deletes across both pages",
    document.querySelectorAll(".commentthread_comment").length === 0,
  );
  check("pagination run finishes", sc.stats().running === false);

  await fresh(1);
  advance.checked = false;
  advance.dispatchEvent(new Event("change", { bubbles: true }));
  C.maxDeletes = 1;
  window.__dialogDeletes = true;
  preview.click();
  start.click();
  deadline = Date.now() + 2500;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check(
    "verified delayed confirmation deletes through the modal button",
    document.querySelectorAll(".commentthread_comment").length === 2,
  );
  window.__dialogDeletes = false;

  await fresh(1);
  C.maxDeletes = 1;
  window.__directDelete = true;
  preview.click();
  start.click();
  deadline = Date.now() + 2500;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check(
    "row disappearance without confirmation is unknown",
    document.querySelectorAll(".commentthread_comment").length === 2 &&
      sc.stats().deleted === 0 &&
      /not confirmed: unknown/.test(log.textContent),
  );
  window.__directDelete = false;

  await fresh(1);
  C.maxDeletes = 1;
  window.__dialogDeletes = true;
  window.__SCD_TEST_BEFORE_DELETE = function () {
    setTimeout(function () {
      sc.stop();
    }, 50);
  };
  preview.click();
  start.click();
  deadline = Date.now() + 2500;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check(
    "stop during dialog leaves submitted outcome unknown",
    document.querySelectorAll(".commentthread_comment").length === 3 &&
      sc.stats().submitted === 1 &&
      sc.stats().deleted === 0 &&
      /outcome is unknown/.test(log.textContent),
  );
  window.__SCD_TEST_BEFORE_DELETE = null;
  window.__dialogDeletes = false;

  await fresh(1);
  C.maxDeletes = 1;
  window.__unrelatedDialog = true;
  preview.click();
  start.click();
  deadline = Date.now() + 2500;
  while (sc.stats().running && Date.now() < deadline) await wait(20);
  check(
    "unrelated generic modal is never clicked",
    document.querySelectorAll(".commentthread_comment").length === 3,
  );
  window.__unrelatedDialog = false;

  await fresh(1);
  C.maxDeletes = 20;
  preview.click();
  start.click();
  stop.click();
  check("stop is safe when the run is already settling", true);
  check(
    "start stays disabled while a submitted request settles",
    start.disabled === true,
  );
  await wait(800);
  check("stop leaves the controller settled", sc.stats().running === false);

  document.getElementById("results").textContent = results.join("\n");
})();
