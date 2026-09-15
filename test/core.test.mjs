import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sc = require("../steam-comment-deleter.user.js");
const defaults = {
  onlyText: "",
  neverText: "",
  onlyAuthor: "",
  neverAuthor: "",
  after: "",
  before: "",
};

function setFilters(overrides = {}) {
  sc.CONFIG.filters = { ...defaults, ...overrides };
}

function comment(overrides = {}) {
  return {
    id: "1",
    text: "",
    normalizedText: "",
    author: "",
    profile: "",
    when: null,
    ...overrides,
  };
}

test("plain terms are preserved, trimmed, and compared case-insensitively", () => {
  assert.deepEqual(sc.terms(" a , B ,,c "), ["a", "B", "c"]);
  assert.equal(sc.matchesTerms("A trade offer", ["trade"]), true);
  assert.equal(sc.matchesTerms("aggressive", ["gg"]), true);
});

test("legacy slash regex syntax is rejected instead of executed", () => {
  setFilters({ neverText: "/g{2}/, /spam/i" });
  assert.match(sc.validateConfig().join("; "), /legacy regex syntax/);
  assert.equal(sc.filterVerdict(comment({ text: "gg" })), "");
  setFilters();
});

test("author matching requires an exact name or canonical profile identity", () => {
  assert.equal(
    sc.matchesAuthor({ author: "Dave", profile: "" }, ["dave"]),
    true,
  );
  assert.equal(
    sc.matchesAuthor({ author: "Daveson", profile: "" }, ["dave"]),
    false,
  );
  assert.equal(
    sc.matchesAuthor(
      {
        author: "Anyone",
        profile: "https://steamcommunity.com/profiles/76561198000000001",
      },
      ["76561198000000001"],
    ),
    true,
  );
  assert.equal(
    sc.matchesAuthor(
      {
        author: "Anyone",
        profile: "https://evil.example/profiles/76561198000000001",
      },
      ["76561198000000001"],
    ),
    false,
  );
  assert.equal(
    sc.matchesAuthor(
      { author: "Anyone", profile: "https://steamcommunity.com/profiles/123" },
      ["123"],
    ),
    false,
  );
});

test("supported full dates are parsed explicitly and relative dates are unknown", () => {
  assert.equal(
    new Date(sc.absoluteDate("12 Jan, 2014 @ 3:24pm")).getFullYear(),
    2014,
  );
  assert.equal(
    new Date(sc.absoluteDate("January 12 2014 3:24 pm")).getMonth(),
    0,
  );
  assert.equal(
    new Date(
      sc.absoluteDate("8 November, 2025 @ 10:09:04 am BST"),
    ).getFullYear(),
    2025,
  );
  const pm = sc.absoluteDate("8 November 2025 10:09:04 pm");
  assert.equal(new Date(pm).getHours(), 22);
  assert.equal(sc.absoluteDate("8 November 2025 10:09:60 pm"), null);
  assert.equal(sc.absoluteDate("2 hours ago"), null);
  assert.equal(sc.absoluteDate("not a date"), null);
});

test("timestamp values are accepted only inside a plausible Steam range", () => {
  const stamp = new Date("2020-01-01T00:00:00Z").getTime();
  assert.equal(sc.plausibleTimestamp(stamp), true);
  assert.equal(sc.plausibleTimestamp(999999999999999), false);
  assert.equal(sc.timestampValue("1577836800"), stamp);
  assert.equal(sc.timestampValue(String(stamp)), stamp);
  assert.equal(sc.timestampValue("0"), null);
});

test("date bounds reject impossible dates, bad formatting, and reversed ranges", () => {
  assert.equal(
    sc.dateBound("2015-01-01", false),
    new Date(2015, 0, 1).getTime(),
  );
  assert.equal(sc.dateBound("2025-02-31", false), null);
  assert.notEqual(sc.dateBound("2024-02-29", false), null);
  assert.equal(sc.dateBound("2023-02-29", false), null);
  assert.equal(sc.dateBound("2015-1-1", false), null);
  setFilters({ after: "2021-01-01", before: "2020-01-01" });
  assert.match(sc.validateConfig().join("; "), /after date must not be later/);
  setFilters();
});

test("date filters fail closed for unknown timestamps", () => {
  setFilters({ after: "2015-01-01" });
  assert.equal(sc.filterVerdict(comment({ when: null })), "no date shown");
  assert.equal(
    sc.filterVerdict(
      comment({ when: new Date("2016-01-01T00:00:00Z").getTime() }),
    ),
    "",
  );
  assert.equal(
    sc.filterVerdict(
      comment({ when: new Date("2014-01-01T00:00:00Z").getTime() }),
    ),
    "date",
  );
  setFilters();
});

test("default settings are valid and permissive", () => {
  setFilters();
  assert.deepEqual(sc.validateConfig(), []);
  assert.equal(sc.filterVerdict(comment({ text: "anything" })), "");
});

test("the hard deletion cap cannot be raised above 500", () => {
  sc.CONFIG.maxDeletes = 501;
  assert.match(sc.validateConfig().join("; "), /must not exceed 500/);
  sc.CONFIG.maxDeletes = 500;
});

test("numeric settings reject invalid values without weakening the gate", () => {
  const original = {
    minDelayMs: sc.CONFIG.minDelayMs,
    maxDelayMs: sc.CONFIG.maxDelayMs,
    maxDeletes: sc.CONFIG.maxDeletes,
  };
  sc.CONFIG.minDelayMs = -1;
  sc.CONFIG.maxDelayMs = 0;
  sc.CONFIG.maxDeletes = 0;
  assert.match(sc.validateConfig().join("; "), /minDelayMs/);
  assert.match(sc.validateConfig().join("; "), /maxDeletes/);
  sc.CONFIG.minDelayMs = 5000;
  sc.CONFIG.maxDelayMs = 1000;
  assert.match(sc.validateConfig().join("; "), /maxDelayMs/);
  Object.assign(sc.CONFIG, original);
  assert.deepEqual(sc.validateConfig(), []);
});
