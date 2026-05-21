import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatReview } from "../src/cli/output.js";
import type { DraftStore } from "../src/cli/types.js";

function draft(file: string, startLine: number, endLine: number, body: string, id = `${file}:${startLine}:${endLine}:RIGHT`): DraftStore["comments"][string] {
  return {
    id,
    file,
    startLine,
    endLine,
    side: "RIGHT",
    body,
    sourceId: "branch",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("formatReview returns null for empty store", () => {
  const store: DraftStore = { schemaVersion: 1, comments: {}, summary: "" };
  assert.equal(formatReview(store), null);
});

test("formatReview returns null when summary is only whitespace and no comments", () => {
  const store: DraftStore = { schemaVersion: 1, comments: {}, summary: "   \n  " };
  assert.equal(formatReview(store), null);
});

test("formatReview emits summary only", () => {
  const store: DraftStore = { schemaVersion: 1, comments: {}, summary: "looks good overall" };
  const md = formatReview(store);
  assert.ok(md);
  assert.match(md, /^# Code review feedback/);
  assert.match(md, /## Overall/);
  assert.match(md, /looks good overall/);
  assert.doesNotMatch(md, /## Comments/);
});

test("formatReview emits single-line and multi-line comments correctly", () => {
  const c1 = draft("src/a.ts", 10, 10, "use const");
  const c2 = draft("src/a.ts", 20, 25, "extract helper");
  const store: DraftStore = {
    schemaVersion: 1,
    comments: { [c1.id]: c1, [c2.id]: c2 },
    summary: "",
  };
  const md = formatReview(store)!;
  assert.match(md, /### src\/a\.ts:10\n\nuse const/);
  assert.match(md, /### src\/a\.ts:20-25\n\nextract helper/);
});

test("formatReview sorts by file then start line", () => {
  const c1 = draft("b.ts", 5, 5, "B5");
  const c2 = draft("a.ts", 100, 100, "A100");
  const c3 = draft("a.ts", 10, 10, "A10");
  const store: DraftStore = {
    schemaVersion: 1,
    comments: { [c1.id]: c1, [c2.id]: c2, [c3.id]: c3 },
    summary: "",
  };
  const md = formatReview(store)!;
  const a10 = md.indexOf("A10");
  const a100 = md.indexOf("A100");
  const b5 = md.indexOf("B5");
  assert.ok(a10 < a100, "A10 before A100");
  assert.ok(a100 < b5, "a.ts entries before b.ts");
});

test("formatReview trims trailing whitespace from body but preserves internal newlines", () => {
  const c = draft("x.ts", 1, 1, "line1\nline2\n\n  ");
  const store: DraftStore = { schemaVersion: 1, comments: { [c.id]: c }, summary: "" };
  const md = formatReview(store)!;
  assert.match(md, /line1\nline2/);
  assert.doesNotMatch(md, /line2\n\n  /);
});
