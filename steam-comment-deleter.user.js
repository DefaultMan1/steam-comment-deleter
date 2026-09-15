// ==UserScript==
// @name         Steam Comment Deleter
// @namespace    https://github.com/DefaultMan1/steam-comment-deleter
// @version      1.0.0
// @description  Preview and carefully delete your Steam profile comments one at a time.
// @author       DefaultMan1
// @license      MIT
// @homepageURL  https://github.com/DefaultMan1/steam-comment-deleter
// @supportURL   https://github.com/DefaultMan1/steam-comment-deleter/issues
// @match        https://steamcommunity.com/id/*
// @match        https://steamcommunity.com/profiles/*
// @match        https://steamcommunity.com/my/
// @match        https://steamcommunity.com/my
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/*
 * Steam Comment Deleter 1.0.0
 *
 * The normal flow is deliberately small: Scan comments, then Delete, then
 * Stop if needed. A preview is an authorization for one exact page state. Any
 * change to the filters, keep marks, profile, or comment IDs invalidates it.
 *
 * The script never calls an API and never sends data anywhere. It only clicks a
 * Delete control that Steam rendered inside a comment row. Deletion is permanent.
 */
(function () {
  "use strict";

  var HAS_DOM =
    typeof window !== "undefined" && typeof document !== "undefined";
  var VERSION = "1.0.0";
  var COMMENT_HISTORY_URL = "https://steamcommunity.com/my/commenthistory/";
  var MAX_DELETE_CAP = 500;

  var CONFIG = {
    minDelayMs: 500,
    maxDelayMs: 900,
    maxDeletes: 500,
    dialogWaitMs: 2500,
    vanishWaitMs: 7500,
    pageWaitMs: 8000,
    failureLimit: 3,
    previewLimit: 30,
    filters: {
      onlyText: "",
      neverText: "",
      onlyAuthor: "",
      neverAuthor: "",
      after: "",
      before: "",
    },
    review: false,
  };

  var state = {
    run: null,
    lastRun: { deleted: 0, failed: 0, submitted: 0, page: 1 },
    nextRunId: 0,
    page: 1,
    keepIds: new Set(),
    preview: null,
    observer: null,
    threadRoot: null,
  };

  function testMode() {
    return (
      HAS_DOM &&
      window.__SCD_TEST__ === true &&
      location.hostname !== "steamcommunity.com"
    );
  }

  var ui = {
    panel: null,
    status: null,
    live: null,
    log: null,
    preview: null,
    start: null,
    stop: null,
    advance: null,
    review: null,
    warn: null,
    info: null,
    dot: null,
    head: null,
    fold: null,
    theme: null,
    advToggle: null,
    advLabel: null,
    collapsed: false,
    drag: null,
    position: null,
    themeName: "dark",
  };

  function lsGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function lsSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {}
  }
  function lsRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }

  function log(message) {
    if (!ui.log) return;
    if (/^(Run stopped:|Stopped -|Stopped after|Preview blocked:|Start blocked:|  not confirmed:)/.test(message))
      state.notice = message.trim();
    var line = document.createElement("div");
    line.textContent = message;
    ui.log.appendChild(line);
    while (ui.log.childElementCount > 80) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  var announceToken = 0;
  function announce(message) {
    if (!ui.live) return;
    var token = ++announceToken;
    ui.live.textContent = "";
    setTimeout(function () {
      if (ui.live && token === announceToken) ui.live.textContent = message;
    }, 0);
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    var style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function supportedRoute(path) {
    path = path == null ? location.pathname : path;
    if (/^\/my\/?$/.test(path)) return true;
    return /^\/(?:id|profiles)\/[^/]+\/?$/.test(path);
  }

  function isCommentHistoryPage(path) {
    path = path == null ? location.pathname : path;
    return (
      /^\/my\/commenthistory(?:\/|$)/.test(path) ||
      /^\/(?:id|profiles)\/[^/]+\/commenthistory(?:\/|$)/.test(path)
    );
  }

  // ----------------------------------------------------------- pure filtering

  function terms(value) {
    return String(value || "")
      .split(",")
      .map(function (term) {
        return term.trim();
      })
      .filter(Boolean);
  }

  function legacyPatternTerms(value) {
    return terms(value).filter(function (term) {
      // Reject slash-delimited expressions, including an optional flag
      // suffix too, so `/spam/i` cannot silently become literal text.
      return /^\/(?:\\.|[^/\\])*\/[A-Za-z]*$/.test(term);
    });
  }

  function validateTerms(value, label) {
    var patterns = legacyPatternTerms(value);
    return patterns.length
      ? label +
          " contains legacy regex syntax (" +
          patterns.join(", ") +
          "). Use plain text terms instead."
      : "";
  }

  function matchesTerms(text, list) {
    var haystack = String(text || "").toLowerCase();
    return list.some(function (term) {
      return haystack.indexOf(term.toLowerCase()) !== -1;
    });
  }

  function normalizeName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function canonicalProfile(value) {
    var raw = String(value || "").trim();
    if (!raw) return null;
    var path = raw;
    try {
      if (/^https?:\/\//i.test(raw)) {
        var url = new URL(raw);
        if (url.hostname.toLowerCase() !== "steamcommunity.com") return null;
        path = url.pathname;
      }
    } catch (e) {
      return null;
    }
    path = path.replace(/\/+$/, "");
    var id = /^\/profiles\/(\d{17})$/.exec(path);
    if (id) return { kind: "profiles", value: id[1] };
    var vanity = /^\/id\/([^/]+)$/i.exec(path);
    return vanity ? { kind: "id", value: vanity[1].toLowerCase() } : null;
  }

  function matchesAuthor(meta, list) {
    var name = normalizeName(meta && meta.author);
    var profile = canonicalProfile(meta && meta.profile);
    return list.some(function (term) {
      var wanted = canonicalProfile(term);
      if (wanted && profile)
        return wanted.kind === profile.kind && wanted.value === profile.value;
      if (/^\d{17}$/.test(term) && profile)
        return profile.kind === "profiles" && profile.value === term;
      return !!name && name === normalizeName(term);
    });
  }

  function validDateParts(year, month, day) {
    var date = new Date(year, month - 1, day);
    return (
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
    );
  }

  function dateBound(value, endOfDay) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    if (!validDateParts(year, month, day)) return null;
    return new Date(
      year,
      month - 1,
      day,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    ).getTime();
  }

  var MONTHS = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };

  function plausibleTimestamp(value) {
    var lower = new Date(2003, 8, 1).getTime();
    var upper = Date.now() + 86400000;
    return Number.isFinite(value) && value >= lower && value <= upper;
  }

  function absoluteDate(text) {
    var value = String(text || "")
      .replace(/,/g, " ")
      .replace(/@/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!value || /(ago|just now|moment|today|yesterday)/i.test(value))
      return null;
    var match =
      /^(\d{1,2}) ([A-Za-z]+) (\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?(?:\s+[A-Za-z]{2,5})?$/i.exec(
        value,
      );
    if (!match) {
      var swapped =
        /^([A-Za-z]+) (\d{1,2}) (\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?(?:\s+[A-Za-z]{2,5})?$/i.exec(
          value,
        );
      if (!swapped) return null;
      match = [
        swapped[0],
        swapped[2],
        swapped[1],
        swapped[3],
        swapped[4],
        swapped[5],
        swapped[6],
        swapped[7],
      ];
    }
    var day = Number(match[1]);
    var month = MONTHS[String(match[2]).toLowerCase()];
    var year = Number(match[3]);
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var seconds = match[6] ? Number(match[6]) : 0;
    var suffix = match[7] ? match[7].toLowerCase() : "";
    if (
      !month ||
      minute > 59 ||
      seconds > 59 ||
      hour > 23 ||
      (suffix && (hour < 1 || hour > 12)) ||
      !validDateParts(year, month, day)
    )
      return null;
    if (suffix === "am" && hour === 12) hour = 0;
    if (suffix === "pm" && hour < 12) hour += 12;
    var result = new Date(
      year,
      month - 1,
      day,
      hour,
      minute,
      seconds,
      0,
    ).getTime();
    return plausibleTimestamp(result) ? result : null;
  }

  function timestampValue(raw) {
    if (!/^\d+$/.test(String(raw || ""))) return null;
    var number = Number(raw);
    var value = String(raw).length >= 12 ? number : number * 1000;
    return plausibleTimestamp(value) ? value : null;
  }

  function timestampOf(row) {
    var el =
      row.querySelector("[data-timestamp]") ||
      row.querySelector(".commentthread_comment_timestamp[title]") ||
      row.querySelector(".commentthread_comment_timestamp");
    if (!el) return null;
    return (
      timestampValue(el.getAttribute("data-timestamp")) ||
      absoluteDate(el.getAttribute("title")) ||
      absoluteDate(el.textContent)
    );
  }

  function commentMeta(row) {
    var textEl = row.querySelector(".commentthread_comment_text");
    var authorEl =
      row.querySelector(".commentthread_author_link") ||
      row.querySelector(".commentthread_comment_author a") ||
      row.querySelector(".commentthread_comment_author");
    var id =
      row.getAttribute("data-comment-id") || row.id.replace(/^comment_/, "");
    return {
      id: /^[A-Za-z0-9_-]+$/.test(id) ? id : "",
      text: textEl ? textEl.textContent : "",
      normalizedText: textEl
        ? textEl.textContent.replace(/\s+/g, " ").trim()
        : "",
      author: authorEl
        ? (authorEl.textContent || "").replace(/\s+/g, " ").trim()
        : "",
      profile:
        authorEl && authorEl.getAttribute
          ? authorEl.getAttribute("href") || ""
          : "",
      when: timestampOf(row),
    };
  }

  function validateConfig(config) {
    var errors = [];
    [
      "minDelayMs",
      "maxDelayMs",
      "dialogWaitMs",
      "vanishWaitMs",
      "pageWaitMs",
    ].forEach(function (key) {
      if (!Number.isFinite(config[key]) || config[key] < 0)
        errors.push(key + " must be a non-negative number");
    });
    ["maxDeletes", "failureLimit", "previewLimit"].forEach(function (key) {
      if (!Number.isInteger(config[key]) || config[key] <= 0)
        errors.push(key + " must be a positive integer");
    });
    if (
      Number.isInteger(config.maxDeletes) &&
      config.maxDeletes > MAX_DELETE_CAP
    )
      errors.push("maxDeletes must not exceed " + MAX_DELETE_CAP);
    if (config.maxDelayMs < config.minDelayMs)
      errors.push("maxDelayMs must be at least minDelayMs");
    var f = config.filters || {};
    [
      ["onlyText", "only-text"],
      ["neverText", "never-text"],
      ["onlyAuthor", "only-author"],
      ["neverAuthor", "never-author"],
    ].forEach(function (item) {
      var error = validateTerms(f[item[0]], item[1]);
      if (error) errors.push(error);
    });
    var after = String(f.after || "").trim();
    var before = String(f.before || "").trim();
    if (after && dateBound(after, false) === null)
      errors.push("after date is not a valid calendar date");
    if (before && dateBound(before, true) === null)
      errors.push("before date is not a valid calendar date");
    if (after && before && dateBound(after, false) > dateBound(before, true))
      errors.push("after date must not be later than before date");
    return errors;
  }

  function filterVerdict(meta, config) {
    config = config || CONFIG;
    var f = config.filters || {};
    var onlyText = terms(f.onlyText);
    var neverText = terms(f.neverText);
    var onlyAuthor = terms(f.onlyAuthor);
    var neverAuthor = terms(f.neverAuthor);
    var text = meta.normalizedText || meta.text || "";
    if (onlyText.length && !matchesTerms(text, onlyText)) return "text";
    if (neverText.length && matchesTerms(text, neverText)) return "text";
    if (onlyAuthor.length && !matchesAuthor(meta, onlyAuthor)) return "author";
    if (neverAuthor.length && matchesAuthor(meta, neverAuthor)) return "author";
    var after = f.after ? dateBound(f.after, false) : null;
    var before = f.before ? dateBound(f.before, true) : null;
    if (after !== null || before !== null) {
      if (!meta.when || !plausibleTimestamp(meta.when)) return "no date shown";
      if (after !== null && meta.when < after) return "date";
      if (before !== null && meta.when > before) return "date";
    }
    return "";
  }

  // ------------------------------------------------------------- DOM adapter
  function threadRoot() {
    if (state.threadRoot && state.threadRoot.isConnected)
      return state.threadRoot;
    state.threadRoot = document.querySelector(
      '.commentthread_area, [id^="commentthread_"]',
    );
    if (!state.threadRoot) {
      var first = document.querySelector(".commentthread_comment");
      state.threadRoot = first ? first.parentElement : null;
    }
    return state.threadRoot;
  }
  function rowElements() {
    var root = threadRoot();
    return root
      ? Array.prototype.slice.call(
          root.querySelectorAll(".commentthread_comment"),
        )
      : [];
  }
  function commentIds() {
    return rowElements()
      .map(function (row) {
        return commentMeta(row).id;
      })
      .filter(Boolean);
  }
  function deleteControl(row, id) {
    var scope = row.querySelector(".commentthread_comment_actions");
    if (!scope) return null;
    return (
      Array.prototype.slice
        .call(scope.querySelectorAll('a,button,[role="button"]'))
        .find(function (el) {
          var dataAction = el.getAttribute("data-action") || "";
          var onclick = el.getAttribute("onclick") || "";
          var href = el.getAttribute("href") || "";
          var action = dataAction + " " + onclick + " " + href;
          var semantic = /deletecomment/i.test(action);
          var referencesId =
            action.indexOf("'" + id + "'") !== -1 ||
            action.indexOf('"' + id + '"') !== -1 ||
            el.getAttribute("data-comment-id") === id;
          return (
            (semantic && referencesId) ||
            (!semantic &&
              !dataAction &&
              !onclick &&
              !href &&
              el.getAttribute("data-comment-id") === id &&
              /^delete(?: comment)?$/i.test((el.textContent || "").trim()))
          );
        }) || null
    );
  }
  function scanRows(config) {
    config = config || CONFIG;
    return rowElements().map(function (row) {
      var meta = commentMeta(row);
      var control = deleteControl(row, meta.id);
      var reason = !meta.id
        ? "unknown comment id"
        : !control
          ? "no Delete control"
          : state.keepIds.has(meta.id) && config.review
            ? "kept"
            : filterVerdict(meta, config);
      return { row: row, control: control, meta: meta, reason: reason };
    });
  }
  function targetsFrom(scan, attempted) {
    return scan.filter(function (item) {
      return (
        item.control &&
        item.meta.id &&
        !item.reason &&
        !(attempted && attempted.has(item.meta.id))
      );
    });
  }
  function skippedCounts(scan) {
    return scan.reduce(function (out, item) {
      if (item.reason) out[item.reason] = (out[item.reason] || 0) + 1;
      return out;
    }, {});
  }
  function configSnapshot() {
    return JSON.parse(JSON.stringify(CONFIG));
  }
  function signature(scan, config) {
    var root = threadRoot();
    return JSON.stringify({
      profile: location.pathname,
      thread: root && root.id ? root.id : "",
      config: config,
      rows: scan.map(function (item) {
        return itemSignature(item).concat([state.keepIds.has(item.meta.id)]);
      }),
    });
  }
  function itemSignature(item) {
    return [
      item.meta.id,
      item.meta.normalizedText,
      item.meta.author,
      item.meta.profile,
      item.meta.when,
      controlSignature(item.control),
    ];
  }
  function controlSignature(control) {
    if (!control) return "";
    return [
      control.tagName,
      control.textContent,
      control.getAttribute("data-action"),
      control.getAttribute("data-comment-id"),
      control.getAttribute("data-tooltip-text"),
      control.getAttribute("onclick"),
      control.getAttribute("href"),
    ].join("|");
  }
  function currentPreviewValid() {
    if (!state.preview || validateConfig(CONFIG).length) return false;
    return (
      state.preview.profile === location.pathname &&
      state.preview.signature === signature(scanRows(), CONFIG)
    );
  }

  function isCurrentRun(run) {
    return !!run && state.run === run && state.nextRunId === run.id;
  }
  function clearPreview(reason) {
    state.preview = null;
    document.querySelectorAll(".scd-would").forEach(function (row) {
      row.classList.remove("scd-would");
    });
    if (reason)
      log(
        "Preview cleared: " + reason + ". Run Preview again before deletion.",
      );
  }
  function markReview(scan) {
    scan.forEach(function (item) {
      var existing = item.row.querySelector(".scd-keep");
      if (!CONFIG.review || !item.control) {
        if (existing) existing.remove();
        return;
      }
      if (!existing) {
        existing = document.createElement("button");
        existing.type = "button";
        existing.className = "scd-keep";
        (
          item.row.querySelector(".commentthread_comment_actions") || item.row
        ).appendChild(existing);
        existing.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (state.run) return;
          if (state.keepIds.has(item.meta.id))
            state.keepIds.delete(item.meta.id);
          else state.keepIds.add(item.meta.id);
          clearPreview("keep selection changed");
          render();
        });
      }
      var kept = state.keepIds.has(item.meta.id);
      existing.textContent = kept ? "kept" : "keep";
      existing.setAttribute("aria-pressed", kept ? "true" : "false");
      existing.disabled = !!state.run;
      existing.className = kept ? "scd-keep scd-keep-on" : "scd-keep";
    });
  }
  function preview() {
    if (state.run) return false;
    state.notice = "";
    var errors = validateConfig(CONFIG);
    if (errors.length) {
      clearPreview();
      log("Preview blocked: " + errors.join("; "));
      announce("Preview blocked by invalid settings");
      render();
      return false;
    }
    var scan = scanRows();
    markReview(scan);
    var deletable = scan.filter(function (x) {
        return x.control && x.meta.id;
      }),
      targets = targetsFrom(scan),
      skipped = skippedCounts(scan);
    targets.forEach(function (item) {
      item.row.classList.add("scd-would");
    });
    state.preview = {
      profile: location.pathname,
      signature: signature(scan, CONFIG),
      targetIds: targets.map(function (item) {
        return item.meta.id;
      }),
      targetSignatures: targets.reduce(function (out, item) {
        out[item.meta.id] = itemSignature(item);
        return out;
      }, {}),
      createdAt: Date.now(),
      config: configSnapshot(),
    };
    log(
      "Preview: " +
        targets.length +
        " of " +
        deletable.length +
        " deletable comment(s) selected.",
    );
    log("Profile: " + location.pathname + ".");
    log("Deletion cap: " + CONFIG.maxDeletes + " submitted operation(s).");
    if (Object.keys(skipped).length)
      log(
        "Excluded: " +
          Object.keys(skipped)
            .map(function (key) {
              return skipped[key] + " " + key;
            })
            .join(", ") +
          ".",
      );
    if (
      targets.length &&
      targets.length === deletable.length &&
      (CONFIG.filters.onlyText || CONFIG.filters.onlyAuthor)
    )
      log(
        'Warning: an "only" filter currently selects every deletable comment.',
      );
    targets.slice(0, CONFIG.previewLimit).forEach(function (item, index) {
      log("  " + (index + 1) + ". comment " + item.meta.id + " selected");
    });
    if (targets.length > CONFIG.previewLimit)
      log("  ... and " + (targets.length - CONFIG.previewLimit) + " more.");
    log(
      "Pagination: " +
        (ui.advance && ui.advance.checked
          ? "enabled; later pages are not individually previewed and use the same filters as they load"
          : "current page only") +
        ".",
    );
    if (!targets.length) log("Nothing will be deleted.");
    announce("Preview complete: " + targets.length + " selected");
    render();
    return true;
  }

  // ---------------------------------------------------------- deletion engine
  function dialogElements() {
    return Array.prototype.slice
      .call(document.querySelectorAll('.newmodal, .ui_modal, [role="dialog"]'))
      .filter(visible);
  }
  function dialogBelongs(dialog, meta) {
    var text = (dialog.textContent || "").replace(/\s+/g, " ").trim();
    var lower = text.toLowerCase();
    var referencesId =
      dialog.getAttribute("data-comment-id") === meta.id ||
      dialog.getAttribute("data-commentid") === meta.id ||
      Array.prototype.some.call(
        dialog.querySelectorAll("[data-comment-id], [data-commentid]"),
        function (element) {
          return (
            element.getAttribute("data-comment-id") === meta.id ||
            element.getAttribute("data-commentid") === meta.id
          );
        },
      );
    var sample = meta.normalizedText
      ? meta.normalizedText.toLowerCase().slice(0, 40)
      : "";
    return (
      /delete\s+(?:this\s+)?comment/i.test(lower) &&
      (referencesId || (sample.length >= 8 && lower.indexOf(sample) !== -1))
    );
  }
  function explicitDeleteButton(dialog) {
    var buttons = Array.prototype.slice
      .call(dialog.querySelectorAll('button, a, [role="button"]'))
      .filter(function (button) {
        return (
          visible(button) &&
          /^delete(?: comment)?$/i.test(
            (button.textContent || "").replace(/\s+/g, " ").trim(),
          )
        );
      });
    return buttons.length === 1 ? buttons[0] : null;
  }
  function wait(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      var timer = setTimeout(resolve, ms);
      if (signal)
        signal.addEventListener(
          "abort",
          function () {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
    });
  }
  function waitForRemoval(meta, root, run, signal) {
    var deadline = Date.now() + run.config.vanishWaitMs;
    var absentSince = 0;
    var settled = false;
    return new Promise(function (resolve, reject) {
      function finish(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      function fail(error) {
        if (settled) return;
        settled = true;
        reject(error);
      }
      function check() {
        if (signal && signal.aborted) {
          fail(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (!isCurrentRun(run)) {
          finish(false);
          return;
        }
        if (!root.isConnected || threadRoot() !== root || !identityStable(run)) {
          finish(false);
          return;
        }
        var present = Array.prototype.some.call(
          root.querySelectorAll(".commentthread_comment"),
          function (row) {
            return commentMeta(row).id === meta.id;
          },
        );
        if (!present) {
          if (!absentSince) absentSince = Date.now();
          if (Date.now() - absentSince >= 300) {
            finish(true);
            return;
          }
        } else {
          absentSince = 0;
        }
        if (Date.now() >= deadline) {
          finish(false);
          return;
        }
        setTimeout(check, 120);
      }
      check();
    });
  }
  // Observe only the existing Steam thread's delete callback. Steam still owns
  // the request; no credentials or request payloads are read or constructed.
  function observeSteamDelete(current, root) {
    var handler = current.control.getAttribute("href") || "";
    var match = /^javascript:\s*CCommentThread\.DeleteComment\(\s*'([^']+)'\s*,\s*'(\d+)'\s*\);?\s*$/.exec(handler);
    if (!match || match[2] !== current.meta.id ||
        root.id !== "commentthread_" + match[1] + "_area") return null;
    var thread = window.g_rgCommentThreads && window.g_rgCommentThreads[match[1]];
    if (!thread || thread.m_bLoading ||
        !Number.isInteger(thread.m_nRenderAjaxSequenceNumber) ||
        typeof thread.OnResponseDeleteComment !== "function")
      throw new Error("Steam's comment thread is busy or unavailable. Wait and try again.");
    var original = thread.OnResponseDeleteComment;
    var own = Object.prototype.hasOwnProperty.call(thread, "OnResponseDeleteComment");
    var sequence = thread.m_nRenderAjaxSequenceNumber + 1;
    var observation = { success: false, failed: false, restore: function () {
      if (thread.OnResponseDeleteComment !== wrapper) return;
      if (own) thread.OnResponseDeleteComment = original;
      else delete thread.OnResponseDeleteComment;
    } };
    function wrapper(number, transport) {
      if (this === thread && number === sequence &&
          thread.m_nRenderAjaxSequenceNumber === sequence) {
        observation.success = !!(transport && transport.responseJSON && transport.responseJSON.success);
        observation.failed = !observation.success;
      }
      return original.apply(this, arguments);
    }
    thread.OnResponseDeleteComment = wrapper;
    return observation;
  }
  async function deleteOne(item, run) {
    var root = threadRoot(),
      current = scanRows(run.config).find(function (candidate) {
        return candidate.meta.id === item.meta.id;
      });
    var expected = run.initialTargetSignatures[item.meta.id];
    if (
      !root ||
      !identityStable(run) ||
      !current ||
      current.reason ||
      !current.control ||
      (run.onPreviewPage &&
        (!expected ||
          JSON.stringify(itemSignature(current)) !== JSON.stringify(expected))) ||
      run.controller.signal.aborted
    )
      return {
        kind: run.controller.signal.aborted ? "cancelled" : "changed",
      };
    var beforeDialogs = dialogElements();
    var receipt = null;
    current.row.dataset.scdBusy = "1";
    current.row.style.opacity = "0.45";
    var busyRow = current.row;
    function clearBusy() {
      if (receipt) receipt.restore();
      busyRow.dataset.scdBusy = "0";
      busyRow.style.opacity = "";
    }
    function submittedOutcome(kind, message) {
      clearBusy();
      return { kind: kind, message: message };
    }
    async function settleSubmitted(confirmed, fallbackKind, message) {
      var gone = false;
      try {
        // Once Steam has received the click, Stop cancels our control loop but
        // leaves this read-only observation alive until the bounded wait ends.
        gone = await waitForRemoval(current.meta, root, run);
      } catch (error) {}
      clearBusy();
      if ((confirmed || (receipt && receipt.success)) && gone)
        return { kind: "deleted", confirmed: true };
      return {
        kind:
          fallbackKind ||
          (run.controller.signal.aborted ? "cancelled-after-submit" : "unknown"),
        confirmed: confirmed,
        gone: gone,
        message: message,
      };
    }
    try {
      if (testMode() && typeof window.__SCD_TEST_BEFORE_DELETE === "function")
        window.__SCD_TEST_BEFORE_DELETE(current.meta);
      if (run.onPreviewPage) {
        var refreshed = scanRows(run.config).find(function (candidate) {
          return candidate.meta.id === item.meta.id;
        });
        if (
          !refreshed ||
          refreshed.reason ||
          !refreshed.control ||
          JSON.stringify(itemSignature(refreshed)) !==
            JSON.stringify(expected)
        )
          return submittedOutcome("changed");
        if (refreshed.row !== busyRow) {
          clearBusy();
          busyRow = refreshed.row;
          busyRow.dataset.scdBusy = "1";
          busyRow.style.opacity = "0.45";
        }
        current = refreshed;
      }
      receipt = observeSteamDelete(current, root);
      run.submitted += 1;
      current.control.click();
    } catch (error) {
      return submittedOutcome("failed", error.message || String(error));
    }
    var deadline = Date.now() + run.config.dialogWaitMs,
      confirmed = false;
    while (Date.now() < deadline) {
      if (run.controller.signal.aborted)
        return settleSubmitted(false, "cancelled-after-submit");
      if (receipt && receipt.failed) return submittedOutcome("failed", "Steam rejected the deletion.");
      if (receipt && receipt.success) break;
      if (!current.row.isConnected || !root.contains(current.row)) {
        break;
      }
      var dialogs = dialogElements().filter(function (dialog) {
        return beforeDialogs.indexOf(dialog) === -1;
      });
      if (dialogs.length) {
        var owned = dialogs.filter(function (dialog) {
          return dialogBelongs(dialog, current.meta);
        });
        if (owned.length !== 1)
          return settleSubmitted(false, "ambiguous-dialog");
        var button = explicitDeleteButton(owned[0]);
        if (!button) return settleSubmitted(false, "unknown-dialog");
        if (run.controller.signal.aborted)
          return settleSubmitted(false, "cancelled-after-submit");
        try {
          button.click();
        } catch (error) {
          return settleSubmitted(
            false,
            "failed",
            error.message || String(error),
          );
        }
        confirmed = true;
        break;
      }
      try {
        await wait(100, run.controller.signal);
      } catch (e) {
        return settleSubmitted(false, "cancelled-after-submit");
      }
    }
    var gone;
    try {
      gone = await waitForRemoval(current.meta, root, run, run.controller.signal);
    } catch (e) {
      if (run.controller.signal.aborted)
        return settleSubmitted(confirmed, "cancelled-after-submit");
      clearBusy();
      return { kind: "unknown", message: e.message || String(e) };
    }
    clearBusy();
    if (gone && (confirmed || (receipt && receipt.success)))
      return { kind: "deleted", confirmed: true };
    return { kind: "unknown" };
  }
  function nextPageControl() {
    var root = threadRoot();
    if (!root) return null;
    var links = Array.prototype.slice.call(
      root.querySelectorAll(
        ".commentthread_pagelinks a, .commentthread_pagelinks span, a[aria-label], button[aria-label]",
      ),
    );
    function disabled(el) {
      return (
        el.disabled === true ||
        /disabled|inactive/i.test(String(el.className || "")) ||
        el.getAttribute("aria-disabled") === "true"
      );
    }
    function number(el) {
      var text = (el.textContent || "").trim();
      return /^\d+$/.test(text) ? Number(text) : null;
    }
    var active = links.find(function (el) {
      return (
        /active|current|selected/i.test(String(el.className || "")) ||
        el.getAttribute("aria-current") === "page"
      );
    });
    var currentPage = active ? number(active) : null;
    var higher =
      currentPage === null
        ? []
        : links
            .filter(function (el) {
              var n = number(el);
              return n !== null && n > currentPage && !disabled(el);
            })
            .sort(function (a, b) {
              return number(a) - number(b);
            });
    if (higher.length) return higher[0];
    return (
      links.find(function (el) {
        return (
          !disabled(el) &&
          (/^(next|>|>>|»|›)$/i.test((el.textContent || "").trim()) ||
            /next/i.test(el.getAttribute("aria-label") || ""))
        );
      }) || null
    );
  }
  function loadMoreControl() {
    var root = threadRoot();
    if (!root) return null;
    return (
      Array.prototype.slice
        .call(root.querySelectorAll('a,button,[role="button"]'))
        .find(function (el) {
          return (
            visible(el) &&
            el.disabled !== true &&
            el.getAttribute("aria-disabled") !== "true" &&
            !/disabled|inactive/i.test(String(el.className || "")) &&
            /^(load|show|view)\s+more(?:\s+comments)?$/i.test(
              (el.textContent || "").trim(),
            )
          );
        }) || null
    );
  }
  function waitForPageChange(before, run) {
    var deadline = Date.now() + run.config.pageWaitMs;
    return new Promise(function (resolve, reject) {
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      function fail(error) {
        if (settled) return;
        settled = true;
        reject(error);
      }
      function check() {
        if (run.controller.signal.aborted) {
          fail(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (!isCurrentRun(run)) {
          finish(false);
          return;
        }
        var now = commentIds();
        if (
          now.some(function (id) {
            return before.indexOf(id) === -1;
          }) ||
          now.length !== before.length
        ) {
          finish(true);
          return;
        }
        if (Date.now() >= deadline) {
          finish(false);
          return;
        }
        setTimeout(check, 150);
      }
      check();
    });
  }
  function executionLock(work) {
    if ((!navigator.locks || !navigator.locks.request) && testMode())
      return work();
    if (!navigator.locks || !navigator.locks.request)
      return Promise.reject(
        new Error(
          "This browser does not support the Web Locks API; live deletion is disabled.",
        ),
      );
    return navigator.locks.request(
      "steam-comment-deleter",
      { ifAvailable: true },
      function (lock) {
        if (!lock)
          throw new Error(
            "Another Steam Comment Deleter tab is already deleting.",
          );
        return work();
      },
    );
  }
  function liveDeletionSupported() {
    return !!((navigator.locks && navigator.locks.request) || testMode());
  }
  function identityStable(run) {
    var root = threadRoot();
    return (
      location.pathname === run.profile &&
      root === run.threadRoot &&
      !!root &&
      (root.id || "") === run.threadId
    );
  }
  async function loop(run) {
    while (isCurrentRun(run) && !run.controller.signal.aborted) {
      if (!identityStable(run)) {
        log("Stopped - the profile or comment thread changed.");
        return;
      }
      if (run.submitted >= run.config.maxDeletes) {
        log("Stopped at the maxDeletes limit (" + run.config.maxDeletes + ").");
        return;
      }
      var scan = scanRows(run.config);
      markReview(scan);
      var targets = targetsFrom(scan, run.attempted);
      if (run.onPreviewPage) {
        var available = targets;
        targets = targets.filter(function (item) {
          return run.initialTargetIds.has(item.meta.id);
        });
        // Steam refills the same page after deletion. All-pages mode must
        // consume these rows before advancing or it skips incoming comments.
        if (!targets.length && available.length && ui.advance.checked) {
          run.onPreviewPage = false;
          targets = available;
        }
      }
      if (targets.length) {
        var item = targets[0];
        run.attempted.add(item.meta.id);
        log("Deleting comment " + item.meta.id + " ...");
        var result = await deleteOne(item, run);
        if (!isCurrentRun(run)) return;
        if (result.kind === "deleted") {
          run.deleted += 1;
          run.failed = 0;
          log("  deleted (total " + run.deleted + ")");
        } else if (
          result.kind === "cancelled" ||
          result.kind === "cancelled-after-submit"
        ) {
          if (result.kind === "cancelled-after-submit")
            log(
              result.confirmed && result.gone
                ? "Stopped after the request was submitted; deletion was observed."
                : "Stopped after the request was submitted; the outcome is unknown.",
            );
          else log("Stopped before the Delete click.");
          return;
        } else if (result.kind === "changed") {
          log("  skipped: comment changed before the Delete click.");
        } else {
          run.failed += 1;
          log(
            "  not confirmed: " +
              result.kind +
              (result.message ? " (" + result.message + ")" : ""),
          );
          if (
            result.kind === "ambiguous-dialog" ||
            result.kind === "unknown-dialog"
          )
            return;
          if (run.failed >= run.config.failureLimit) {
            log(
              "Stopped after " +
                run.failed +
                " consecutive uncertain or failed operations.",
            );
            return;
          }
        }
        render();
        if (run.controller.signal.aborted) return;
        try {
          await wait(
            run.config.minDelayMs +
              Math.random() * (run.config.maxDelayMs - run.config.minDelayMs),
            run.controller.signal,
          );
        } catch (e) {
          return;
        }
        continue;
      }
      if (!ui.advance || !ui.advance.checked) {
        log("Done - no eligible comments left on this page.");
        return;
      }
      var control = loadMoreControl() || nextPageControl();
      if (!control) {
        log("Done - no more comments were offered.");
        return;
      }
      var before = commentIds(),
        pageKey = before.join("|") + "|" + (control.textContent || "");
      if (run.pages.has(pageKey)) {
        log("Stopped - pagination repeated the same page.");
        return;
      }
      run.pages.add(pageKey);
      log("Page clear - advancing through the verified pagination control.");
      if (run.controller.signal.aborted) return;
      if (!identityStable(run)) {
        log("Stopped - the profile or comment thread changed.");
        return;
      }
      control.click();
      var changed = await waitForPageChange(before, run).catch(function () {
        return false;
      });
      if (!isCurrentRun(run)) return;
      if (!changed) {
        log("Stopped - the next page did not produce a different comment set.");
        return;
      }
      if (!identityStable(run)) {
        log("Stopped - the profile or comment thread changed.");
        return;
      }
      state.page += 1;
      run.onPreviewPage = false;
      render();
    }
  }
  async function run() {
    if (state.run) {
      log("A deletion run is already settling.");
      return false;
    }
    if (!currentPreviewValid()) {
      log(
        "Start blocked: the page changed or no current preview exists. Run Preview again.",
      );
      announce("Start blocked; run Preview again");
      render();
      return false;
    }
    var errors = validateConfig(CONFIG);
    if (errors.length) {
      log("Start blocked: " + errors.join("; "));
      return false;
    }
    var runRoot = threadRoot();
    state.notice = "";
    var authorization = state.preview;
    var runState = {
      id: ++state.nextRunId,
      controller: new AbortController(),
      config: configSnapshot(),
      profile: location.pathname,
      threadRoot: runRoot,
      threadId: (runRoot && runRoot.id) || "",
      attempted: new Set(),
      pages: new Set(),
      initialTargetIds: new Set(authorization.targetIds),
      initialTargetSignatures: authorization.targetSignatures || {},
      onPreviewPage: true,
      deleted: 0,
      failed: 0,
      submitted: 0,
      stopRequested: false,
    };
    state.run = runState;
    state.preview = null;
    clearPreview();
    log(
      "Started. Stop prevents future clicks; a request already submitted may still finish.",
    );
    announce("Deletion started");
    render();
    try {
      await executionLock(function () {
        return loop(runState);
      });
    } catch (error) {
      if (!runState.controller.signal.aborted)
        log("Run stopped: " + (error.message || String(error)));
    } finally {
      if (state.run === runState) {
        state.lastRun = {
          deleted: runState.deleted,
          failed: runState.failed,
          submitted: runState.submitted,
          page: state.page,
        };
        state.run = null;
        state.page = 1;
        log(runState.controller.signal.aborted ? "Stopped." : "Run finished.");
        announce(
          runState.controller.signal.aborted
            ? "Deletion stopped"
            : "Deletion finished",
        );
        render();
      }
    }
    return true;
  }
  function stop() {
    if (!state.run) {
      log("Nothing is running.");
      return false;
    }
    state.run.stopRequested = true;
    state.run.controller.abort();
    log("Stopping. No new Delete or pagination click will be made.");
    announce("Stopping deletion");
    render();
    return true;
  }

  // --------------------------------------------------------------- panel/UI
  function filterCount() {
    return [
      "onlyText",
      "neverText",
      "onlyAuthor",
      "neverAuthor",
      "after",
      "before",
    ].filter(function (key) {
      return String(CONFIG.filters[key] || "").trim();
    }).length;
  }
  function input(name) {
    return ui.panel.querySelector('[data-scc="' + name + '"]');
  }
  function updateFieldsFromStorage() {
    [
      "scd_auto_resume",
      "scd_deleted",
      "scd_failed",
      "scd_page",
      "scd_path",
      "scd_running",
      "scd_archive_on",
    ].forEach(lsRemove);
    var saved = {};
    try {
      saved = JSON.parse(lsGet("scd_filters") || "{}") || {};
    } catch (e) {}
    CONFIG.filters = {
      onlyText: saved.onlyText || "",
      neverText: saved.neverText || "",
      onlyAuthor: saved.onlyAuthor || "",
      neverAuthor: saved.neverAuthor || "",
      after: saved.after || "",
      before: saved.before || "",
    };
    ["onlyText", "neverText", "onlyAuthor", "neverAuthor"].forEach(
      function (name) {
        input(name).value = CONFIG.filters[name];
      },
    );
    input("afterDate").value = CONFIG.filters.after;
    input("beforeDate").value = CONFIG.filters.before;
    CONFIG.review = lsGet("scd_review_on") === "1";
  }
  function setTheme(value, remember) {
    ui.themeName = value === "light" ? "light" : "dark";
    if (remember !== false) lsSet("scd_theme", ui.themeName);
    ui.panel.classList.toggle("scd-light", ui.themeName === "light");
    ui.theme.textContent = ui.themeName === "light" ? "☀" : "☾";
    ui.theme.title =
      ui.themeName === "light"
        ? "Switch to dark theme"
        : "Switch to light theme";
    ui.theme.setAttribute("aria-label", ui.theme.title);
  }
  function setCollapsed(value, remember) {
    ui.collapsed = !!value;
    ui.panel.classList.toggle("scd-collapsed", ui.collapsed);
    ui.fold.textContent = ui.collapsed ? "▸" : "▾";
    ui.fold.setAttribute("aria-expanded", ui.collapsed ? "false" : "true");
    if (remember !== false) lsSet("scd_collapsed", ui.collapsed ? "1" : "0");
  }
  function moveTo(x, y) {
    var margin = 8,
      rect = ui.panel.getBoundingClientRect();
    x = Math.min(
      Math.max(x, margin - rect.width),
      Math.max(margin, window.innerWidth - margin),
    );
    y = Math.min(
      Math.max(y, margin),
      Math.max(margin, window.innerHeight - margin),
    );
    ui.panel.style.left = x + "px";
    ui.panel.style.top = y + "px";
    ui.panel.style.bottom = "auto";
    ui.position = { x: x, y: y };
  }
  function resetPanel() {
    ["scd_pos", "scd_collapsed", "scd_theme", "scd_adv_open"].forEach(lsRemove);
    ui.position = null;
    ui.panel.style.left = "";
    ui.panel.style.top = "";
    ui.panel.style.bottom = "";
    setTheme(
      window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark",
      false,
    );
    setCollapsed(false, false);
    setAdvanced(false, false);
    render();
    log("Panel reset to its default corner.");
    return "panel reset";
  }
  function setAdvanced(open, remember) {
    ui.panel.classList.toggle("scd-adv-open", !!open);
    ui.advToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (remember !== false) lsSet("scd_adv_open", open ? "1" : "0");
  }
  function render() {
    if (!ui.panel) return;
    var scan = scanRows();
    var eligible = scan.filter(function (item) {
      return item.control && item.meta.id && !item.reason;
    }).length;
    markReview(scan);
    var runState = state.run;
    ui.status.textContent = runState
      ? (runState.stopRequested ? "Stopping · " : "Deleting · ") +
        runState.deleted +
        " deleted / " +
        runState.submitted +
        " submitted"
      : state.notice ? state.notice : state.lastRun && state.lastRun.submitted
        ? state.lastRun.deleted + " deleted · " + eligible + " selected"
        : eligible + (eligible === 1 ? " comment selected" : " comments selected");
    ui.dot.className = runState ? "scd-dot scd-dot-busy" : "scd-dot";
    ui.info.textContent = runState ? "working" : "v" + VERSION;
    ui.preview.disabled = !!runState;
    ui.start.disabled =
      !!runState ||
      !currentPreviewValid() ||
      !eligible ||
      !liveDeletionSupported();
    ui.stop.disabled = !runState;
    ui.close.disabled = !!runState;
    ui.preview.hidden = !!runState || currentPreviewValid();
    ui.start.hidden = !!runState || !currentPreviewValid();
    ui.stop.hidden = !runState;
    ui.start.textContent = ui.advance.checked ? "Delete all selected pages" : "Delete " + eligible + (eligible === 1 ? " comment" : " comments");
    input("scope").textContent = ui.advance.checked
      ? "All pages · up to " + CONFIG.maxDeletes + " deletions"
      : "Current page only";
    if (currentPreviewValid()) input("scope").textContent += " · " + location.pathname;
    input("confirmation").hidden = !!runState || !currentPreviewValid();
    input("cancelreview").hidden = !!runState || !currentPreviewValid();
    ui.advance.disabled = !!runState;
    ui.review.disabled = !!runState;
    ui.advToggle.disabled = !!runState;
    input("check").disabled = !!runState;
    [
      "onlyText",
      "neverText",
      "onlyAuthor",
      "neverAuthor",
      "afterDate",
      "beforeDate",
    ].forEach(function (name) {
      input(name).disabled = !!runState;
    });
    ui.warn.textContent = runState
      ? runState.stopRequested
        ? "stopping; waiting for any submitted request to settle"
        : "stop prevents future clicks; submitted requests may still finish"
      : !liveDeletionSupported()
        ? "this browser cannot coordinate multiple tabs; live deletion is disabled"
        : "";
    var activeFilters = filterCount();
    ui.advLabel.textContent = activeFilters
      ? "Filters & options · " +
        activeFilters +
        (activeFilters === 1 ? " filter" : " filters")
      : "Filters & options";
  }
  function readFilters() {
    CONFIG.filters = {
      onlyText: input("onlyText").value.trim(),
      neverText: input("neverText").value.trim(),
      onlyAuthor: input("onlyAuthor").value.trim(),
      neverAuthor: input("neverAuthor").value.trim(),
      after: input("afterDate").value.trim(),
      before: input("beforeDate").value.trim(),
    };
    lsSet("scd_filters", JSON.stringify(CONFIG.filters));
    clearPreview("filters changed");
    render();
  }

  function buildPanel() {
    var style = document.createElement("style");
    style.id = "scd-style";
    style.textContent = `
      .scd-panel {
        --font-ui: "Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
        --line: #35546a;
        --action: #1a9fff;
        --action-text: #ffffff;
        --bg: #18191e;
        --input: #ffffff06;
        --text: #ededf0;
        --muted: #a6a8b3;
        --accent: #66c0f4;
        --ok: #a4d007;
        --warn: #e5a83b;
        position: fixed;
        left: 14px;
        bottom: 14px;
        z-index: 2147483000;
        width: 320px;
        max-width: calc(100vw - 24px);
        background: var(--bg);
        color: var(--text);
        color-scheme: dark;
        font: 12px/1.45 var(--font-ui);
        border: 1px solid #ffffff1a;
        box-shadow: 0 12px 36px #0005, inset 0 1px 0 #ffffff06;
        border-radius: 12px;
        overflow: hidden;
      }
      .scd-panel.scd-light {
        --line: #8bb7d0;
        --action: #1a6fa5;
        --action-text: #ffffff;
        --bg: #f5f5f8;
        --input: #00000004;
        --text: #25262d;
        --muted: #626571;
        --accent: #1a75a8;
        --ok: #527300;
        --warn: #8a5b0c;
        color-scheme: light;
        border-color: #d0d0d9;
        box-shadow: 0 12px 28px #2424311f, inset 0 1px 0 #ffffff;
      }
      .scd-head {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        padding: 7px 12px 0;
        background: transparent;
        border-bottom: 0;
        cursor: grab;
        user-select: none;
      }
      .scd-head:active { cursor: grabbing; }
      .scd-light .scd-head {
        background: transparent;
        border-bottom-color: #a9c5d8;
      }
      .scd-brand {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      .scd-title {
        overflow: hidden;
        color: var(--text);
        font-size: 12px;
        font-weight: 650;
        letter-spacing: .01em;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .scd-light .scd-title { color: var(--text); }
      .scd-info {
        margin-left: auto;
        color: var(--muted);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .scd-light .scd-info { color: var(--muted); }
      .scd-icon {
        flex: 0 0 28px;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 7px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
      }
      .scd-icon:hover,
      .scd-icon:focus-visible {
        border-color: #66c0f455;
        background: #66c0f412;
      }
      .scd-icon:disabled { cursor: not-allowed; opacity: .35; }
      .scd-light .scd-icon { color: var(--muted); }
      .scd-body { padding: 10px 14px 12px; max-height: calc(100dvh - 90px); overflow-y: auto; }
      .scd-panel [hidden] { display: none !important; }
      .scd-scope { color: var(--muted); font-size: 11px; margin: 3px 0 8px; }
      .scd-all {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 8px 0 4px;
        color: var(--text);
        cursor: pointer;
        font-size: 12px;
      }
      .scd-all input { width: 15px; height: 15px; margin: 0; accent-color: var(--ok); }
      .scd-all strong { font-size: 11px; letter-spacing: .08em; }
      .scd-all small { color: var(--muted); font-size: 11px; }
      .scd-confirmation { color: var(--warn); font-size: 11px; margin: 8px 0; }
      .scd-details { margin-top: 8px; color: var(--muted); font-size: 11px; }
      .scd-details summary { cursor: pointer; }
      .scd-details summary:focus-visible { outline: 2px solid var(--accent); }
      .scd-status {
        min-height: 17px;
        padding: 0;
        color: var(--text);
        font: 600 17px/1.35 var(--font-ui);
        letter-spacing: -.025em;
        font-variant-numeric: tabular-nums;
      }
      .scd-light .scd-status {
        border-color: #d0d0d9;
        background: transparent;
      }
      .scd-row {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 8px 0;
        color: var(--muted);
        font-size: 11px;
      }
      .scd-row input {
        width: 14px;
        height: 14px;
        margin: 0;
        accent-color: var(--accent);
      }
      .scd-actions {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        margin-top: 11px;
      }
      .scd-btn {
        min-height: 36px;
        padding: 7px 8px;
        border: 1px solid transparent;
        border-radius: 7px;
        background: var(--action);
        color: var(--action-text);
        cursor: pointer;
        font: 600 12px/1.3 var(--font-ui);
        letter-spacing: .01em;
        transition: filter .15s ease, transform .15s ease, border-color .15s ease;
      }
      .scd-btn:hover:not(:disabled),
      .scd-btn:focus-visible {
        border-color: var(--accent);
        filter: brightness(1.06);

      }
      .scd-btn:active:not(:disabled) { transform: translateY(0); }
      .scd-btn:disabled { cursor: not-allowed; opacity: .42; }
      .scd-danger {
        border-color: #f28b8f;
        color: #fff;
        background: #a83f49;
      }
      .scd-ghost {
        border-color: #ffffff26;
        background: transparent;
        color: var(--text);
      }
      .scd-adv {
        margin-top: 10px;
        border-top: 0;
      }
      .scd-light .scd-adv { border-top-color: #2134451f; }
      .scd-advtoggle {
        display: flex;
        align-items: center;
        width: 100%;
        padding: 4px 0;
        border: 0;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        font: 500 12px/1.3 var(--font-ui);
        text-align: left;
      }
      .scd-advtoggle::before {
        width: 16px;
        color: var(--accent);
        content: "›";
        font-size: 15px;
        font-weight: 400;
        line-height: 10px;
      }
      .scd-adv-open .scd-advtoggle::before { content: "⌄"; }
      .scd-advtoggle:focus-visible,
      .scd-link:focus-visible,
      .scd-keep:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .scd-advbody { display: none; padding: 0 6px 2px 0; max-height: 180px; overflow-y: auto; overscroll-behavior: contain; }
      .scd-adv-open .scd-advbody { display: block; }
      .scd-field {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 44%;
        align-items: center;
        gap: 8px;
        margin: 7px 0;
      }
      .scd-field span { color: var(--muted); font-size: 12px; }
      .scd-field input {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        height: 29px;
        padding: 5px 7px;
        border: 1px solid var(--line);
        border-radius: 4px;
        background: var(--input);
        color: var(--text);
        font: 12px/1.3 var(--font-ui);
      }
      .scd-field input::placeholder { color: var(--muted); opacity: 1; }
      .scd-field input:focus-visible {
        border-color: var(--accent);
        outline: 2px solid #66c0f433;
        outline-offset: 0;
      }
      .scd-log {
        max-height: 100px;
        overflow: auto;
        margin-top: 9px;
        padding: 7px 8px;
        border: 1px solid #ffffff12;
        border-radius: 7px;
        background: #00000015;
        color: var(--muted);
        font: 12px/1.5 var(--font-ui);
        white-space: pre-wrap;
      }
      .scd-light .scd-log {
        border-color: #d0d0d9;
        background: transparent;
        color: var(--muted);
      }
      .scd-foot {
        margin-top: 8px;
        color: var(--muted);
        font-size: 10px;
      }
      .scd-link {
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--accent);
        cursor: pointer;
        font: inherit;
      }
      .scd-warn { margin-top: 7px; color: var(--warn); font-size: 11px; }
      .scd-warn:empty { display: none; }
      .scd-keep {
        margin-left: 6px;
        padding: 2px 6px;
        border: 1px solid #66c0f466;
        border-radius: 4px;
        background: #101821cc;
        color: var(--accent);
        cursor: pointer;
        font: 600 10px/1.2 "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
      }
      .scd-keep-on { border-color: #e5a83b99; color: var(--warn); }
      .scd-would { outline: 2px solid var(--warn, #e5a83b) !important; outline-offset: -2px; }
      .scd-dot {
        width: 5px;
        height: 5px;
        flex: 0 0 5px;
        border-radius: 50%;
        background: var(--accent);

      }
      .scd-dot-busy { background: var(--warn); box-shadow: 0 0 0 3px #e5a83b26; }
      .scd-collapsed { width: 252px; }
      .scd-collapsed .scd-body { display: none; }
      .scd-live {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
      }
      @supports (backdrop-filter: blur(14px)) {
        .scd-panel { background: #18191ef0; backdrop-filter: blur(14px); }
        .scd-panel.scd-light { background: #f5f5f8f5; }
      }
      @media (prefers-reduced-transparency: reduce) {
        .scd-panel, .scd-panel.scd-light { background: var(--bg); backdrop-filter: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        .scd-panel *, .scd-panel *::before { transition: none !important; transform: none !important; }
      }
    `;
    document.head.appendChild(style);
    ui.panel = document.createElement("div");
    ui.panel.className = "scd-panel";
    ui.panel.innerHTML = `
      <div data-scc="head" class="scd-head">
        <span class="scd-brand"><span data-scc="dot" class="scd-dot"></span><span class="scd-title">Comment Deleter</span></span>
        <span data-scc="info" class="scd-info"></span>
        <button data-scc="theme" class="scd-icon" type="button" aria-label="Switch theme" title="Switch theme">☾</button>
        <button data-scc="fold" class="scd-icon" type="button" aria-label="Collapse panel" aria-controls="scd-panel-body" title="Collapse panel">▾</button>
        <button data-scc="close" class="scd-icon" type="button" aria-label="Close panel" title="Close panel; reload Steam to reopen">×</button>
      </div>
      <div id="scd-panel-body" class="scd-body">
        <div data-scc="status" class="scd-status"></div>
        <div data-scc="scope" class="scd-scope"></div>
        <label class="scd-all" title="Process every available comment page, respecting filters"><input type="checkbox" data-scc="advance"><strong>DELETE ALL</strong><small>all pages · respects filters</small></label>
        <div data-scc="live" class="scd-live" aria-live="polite"></div>
        <div class="scd-adv">
          <button data-scc="advtoggle" class="scd-advtoggle" type="button" aria-expanded="false" aria-controls="scd-advanced-options"><span data-scc="advlabel">Filters &amp; options</span></button>
          <div id="scd-advanced-options" class="scd-advbody">
            <label class="scd-field"><span>only if text contains</span><input data-scc="onlyText" placeholder="trade, scam"></label>
            <label class="scd-field"><span>never if text contains</span><input data-scc="neverText" placeholder="gg, thanks"></label>
            <label class="scd-field"><span>only from this person</span><input data-scc="onlyAuthor" placeholder="name, URL or SteamID"></label>
            <label class="scd-field"><span>never from this person</span><input data-scc="neverAuthor" placeholder="name, URL or SteamID"></label>
            <label class="scd-field"><span>posted on or after</span><input data-scc="afterDate" type="date"></label>
            <label class="scd-field"><span>posted on or before</span><input data-scc="beforeDate" type="date"></label>
            <label class="scd-row"><input type="checkbox" data-scc="review"> review: click keep on comments to spare</label>
            <div class="scd-foot">waits ${CONFIG.minDelayMs / 1000}–${CONFIG.maxDelayMs / 1000}s between deletes · <button data-scc="check" class="scd-link" type="button">check this page</button></div>
            <div class="scd-foot"><a class="scd-link" href="${COMMENT_HISTORY_URL}" target="_blank" rel="noreferrer noopener">my comment history</a></div>
          </div>
        </div>
        <div class="scd-actions">
          <button data-scc="preview" class="scd-btn" type="button">Scan comments</button>
          <button data-scc="start" class="scd-btn scd-danger" type="button">Start deletion</button>
          <button data-scc="stop" class="scd-btn scd-ghost" type="button">Stop</button>
          <button data-scc="cancelreview" class="scd-link" type="button" hidden>Cancel</button>
        </div>
        <div data-scc="confirmation" class="scd-confirmation" hidden>Deletion is permanent. Check the selected comments before continuing.</div>
        <div data-scc="warn" class="scd-warn"></div>
        <details class="scd-details"><summary>Activity</summary><div data-scc="log" class="scd-log"></div></details>
      </div>`;
    document.body.appendChild(ui.panel);
    ui.status = input("status");
    ui.live = input("live");
    ui.log = input("log");
    ui.preview = input("preview");
    ui.start = input("start");
    ui.stop = input("stop");
    ui.advance = input("advance");
    ui.review = input("review");
    ui.warn = input("warn");
    ui.info = input("info");
    ui.dot = input("dot");
    ui.head = input("head");
    ui.fold = input("fold");
    ui.theme = input("theme");
    ui.close = input("close");
    ui.advToggle = input("advtoggle");
    ui.advLabel = input("advlabel");
    updateFieldsFromStorage();
    ui.review.checked = CONFIG.review;
    ui.preview.addEventListener("click", function () {
      preview();
      setAdvanced(false, false);
    });
    ui.start.addEventListener("click", run);
    ui.stop.addEventListener("click", stop);
    ui.close.addEventListener("click", function () {
      if (state.run) return;
      ui.panel.remove();
    });
    input("cancelreview").addEventListener("click", function () {
      clearPreview();
      render();
      ui.preview.focus();
    });
    ui.advance.addEventListener("change", function () {
      clearPreview("pagination setting changed");
      render();
    });
    ui.review.addEventListener("change", function () {
      CONFIG.review = ui.review.checked;
      lsSet("scd_review_on", CONFIG.review ? "1" : "0");
      clearPreview("review setting changed");
      render();
    });
    [
      "onlyText",
      "neverText",
      "onlyAuthor",
      "neverAuthor",
      "afterDate",
      "beforeDate",
    ].forEach(function (name) {
      input(name).addEventListener("input", readFilters);
    });
    ui.advToggle.addEventListener("click", function () {
      setAdvanced(!ui.panel.classList.contains("scd-adv-open"), true);
    });
    input("check").addEventListener("click", checkPage);
    ui.head.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 || event.target.closest(".scd-icon")) return;
      var rect = ui.panel.getBoundingClientRect();
      ui.drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      try {
        ui.head.setPointerCapture(event.pointerId);
      } catch (e) {}
    });
    ui.head.addEventListener("pointermove", function (event) {
      if (ui.drag)
        moveTo(event.clientX - ui.drag.dx, event.clientY - ui.drag.dy);
    });
    ui.head.addEventListener("pointerup", function () {
      if (!ui.drag) return;
      ui.drag = null;
      if (ui.position) lsSet("scd_pos", JSON.stringify(ui.position));
    });
    ui.fold.addEventListener("click", function () {
      setCollapsed(!ui.collapsed, true);
    });
    ui.theme.addEventListener("click", function () {
      setTheme(ui.themeName === "light" ? "dark" : "light", true);
    });
    var savedTheme = lsGet("scd_theme");
    setTheme(savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark", false);
    setCollapsed(lsGet("scd_collapsed") === "1", false);
    setAdvanced(false, false);
    try {
      var savedPosition = JSON.parse(lsGet("scd_pos") || "null");
      if (
        savedPosition &&
        Number.isFinite(savedPosition.x) &&
        Number.isFinite(savedPosition.y)
      )
        moveTo(savedPosition.x, savedPosition.y);
    } catch (e) {}
    document.addEventListener(
      "keydown",
      function (event) {
        if (event.key === "Escape" && state.run) {
          event.preventDefault();
          stop();
        }
      },
      true,
    );
  }
  function checkPage() {
    var scan = scanRows(),
      targets = targetsFrom(scan),
      skipped = skippedCounts(scan),
      next = nextPageControl() || loadMoreControl();
    log("--- Page check ---");
    log("Profile: " + location.pathname);
    log("Comment rows: " + scan.length);
    log(
      "Rows with a Delete control: " +
        scan.filter(function (x) {
          return x.control && x.meta.id;
        }).length,
    );
    log("Passing current filters: " + targets.length);
    if (Object.keys(skipped).length)
      log(
        "Excluded: " +
          Object.keys(skipped)
            .map(function (key) {
              return skipped[key] + " " + key;
            })
            .join(", ") +
          ".",
      );
    log("Pagination control: " + (next ? "available" : "none"));
    if (isCommentHistoryPage())
      log(
        "This is Steam’s comment-history index; open a profile from it to find Delete controls.",
      );
    if (!scan.length)
      log("No supported comment rows detected on this profile page.");
    else if (!targets.length)
      log("VERDICT: no comments currently pass the selection.");
    else
      log(
        "VERDICT: run Preview to authorize " +
          targets.length +
          " current-page selection(s).",
      );
  }
  function watchComments() {
    if (typeof MutationObserver === "undefined" || !threadRoot()) return;
    var queued = false;
    var observedRoot = threadRoot();
    function isToolNode(node) {
      if (!node || node.nodeType !== 1) return false;
      return (
        node.matches(".scd-keep,[data-scc]") ||
        !!node.querySelector(".scd-keep,[data-scc]")
      );
    }
    function isToolMutation(mutation) {
      if (ui.panel && ui.panel.contains(mutation.target)) return true;
      if (
        mutation.target.nodeType === 1 &&
        mutation.target.closest &&
        mutation.target.closest(".scd-keep,[data-scc]")
      )
        return true;
      return (
        mutation.type === "childList" &&
        Array.prototype.every.call(mutation.addedNodes, isToolNode) &&
        Array.prototype.every.call(mutation.removedNodes, isToolNode)
      );
    }
    function touchesComments(mutation) {
      if (!observedRoot || !observedRoot.isConnected) return true;
      if (observedRoot.contains(mutation.target)) return true;
      if (mutation.type !== "childList") return false;
      return Array.prototype.some.call(
        Array.prototype.slice
          .call(mutation.addedNodes)
          .concat(Array.prototype.slice.call(mutation.removedNodes)),
        function (node) {
          return (
            node === observedRoot ||
            (node.nodeType === 1 &&
              (node.matches(
                ".commentthread_area,[id^='commentthread_'],.commentthread_comment",
              ) ||
                node.querySelector(
                  ".commentthread_area,[id^='commentthread_'],.commentthread_comment",
                )))
          );
        },
      );
    }
    state.observer = new MutationObserver(function (mutations) {
      if (state.run || queued || mutations.every(isToolMutation)) return;
      if (!mutations.some(touchesComments)) return;
      queued = true;
      setTimeout(function () {
        queued = false;
        if (state.run) return;
        observedRoot = threadRoot();
        clearPreview("comment list changed");
        render();
      }, 150);
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
  function api() {
    return {
      CONFIG: CONFIG,
      preview: preview,
      run: run,
      stop: stop,
      stats: function () {
        var r = state.run || state.lastRun;
        return {
          running: !!state.run,
          deleted: r.deleted,
          failed: r.failed,
          submitted: r.submitted,
          page: r.page,
        };
      },
      checkPage: checkPage,
      reset: resetPanel,
    };
  }
  function testApi() {
    return {
      isCommentHistoryPage: isCommentHistoryPage,
      filterVerdict: function (meta) {
        return filterVerdict(meta, CONFIG);
      },
      terms: terms,
      matchesTerms: matchesTerms,
      matchesAuthor: matchesAuthor,
      absoluteDate: absoluteDate,
      dateBound: dateBound,
      validateConfig: function () {
        return validateConfig(CONFIG);
      },
    };
  }
  function boot() {
    if (!supportedRoute() && !testMode()) return;
    buildPanel();
    render();
    log("Ready. Preview is required before every deletion run.");
    if (isCommentHistoryPage())
      log("This page is an index; open a profile page to work on comments.");
    console.log(
      "[Steam Comment Deleter] v" +
        VERSION +
        " ready on " +
        location.pathname +
        ".",
    );
    watchComments();
    window.steamCommentDeleter = api();
    if (testMode()) window.__SCD_TEST_API__ = testApi();
  }
  if (HAS_DOM) boot();
  else if (typeof module === "object" && module.exports)
    module.exports = {
      CONFIG: CONFIG,
      terms: terms,
      matchesTerms: matchesTerms,
      matchesAuthor: matchesAuthor,
      absoluteDate: absoluteDate,
      dateBound: dateBound,
      timestampValue: timestampValue,
      filterVerdict: function (meta) {
        return filterVerdict(meta, CONFIG);
      },
      validateConfig: function () {
        return validateConfig(CONFIG);
      },
      plausibleTimestamp: plausibleTimestamp,
    };
})();
