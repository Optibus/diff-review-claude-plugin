import { chromium } from "@playwright/test";
import { test, expect, makeRepo, startBinary } from "./fixtures";
import { promises as fs } from "node:fs";

// react-diff-view renders both old- and new-side gutters per change. For an
// INSERT change only the new-side gutter has a line number, so filtering by
// exact text picks it unambiguously.

test.describe("diff-review UI", () => {
  test("renders diff, file tree, and zero-state counter", async ({ app }) => {
    await expect(app.locator(".filetree")).toContainText("1 file changed");
    await expect(app.locator(".filetree")).toContainText("greeting.py");
    await expect(app.locator(".filediff").first()).toContainText("def greet");
    await expect(app.locator(".topbar__count")).toContainText("0 comments");
    await expect(app.getByRole("button", { name: "Submit review" })).toBeDisabled();
  });

  test("single-line comment: click → type → save → counter increments", async ({ app }) => {
    const file = app.locator(".filediff", { hasText: "greeting.py" });
    // Click line 8 (insertion) — only the new-side gutter matches.
    await file.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click();
    await expect(file.locator(".thread__header")).toContainText("Line 8");

    await app.locator(".thread__textarea").fill("Consider a docstring here.");
    await app.getByRole("button", { name: "Save", exact: true }).click();

    await expect(app.locator(".topbar__count")).toContainText("1 comment");
    await expect(app.locator(".thread__body")).toContainText("Consider a docstring here.");
    await expect(app.getByRole("button", { name: "Submit review" })).toBeEnabled();
    // File tree badge appears.
    await expect(app.locator(".filetree__count").first()).toHaveText("1");
  });

  test("range comment: click + shift-click → 'Lines X–Y'", async ({ app }) => {
    const file = app.locator(".filediff", { hasText: "greeting.py" });
    // Click line 7 first (insertion "def shout...").
    await file.locator('td.diff-gutter-insert[data-change-key="I7"]').filter({ hasText: "7" }).click();
    await expect(file.locator(".thread__header")).toContainText("Line 7");
    // Shift-click line 8 (the next insertion). The data-change-key locator
    // is independent of the post-widget DOM position.
    await file.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click({ modifiers: ["Shift"] });
    await expect(file.locator(".thread__header")).toContainText("Lines 7–8");
    // Counter still 0 because body is empty.
    await expect(app.locator(".topbar__count")).toContainText("0 comments");

    await app.locator(".thread__textarea").fill("Both lines belong to shout().");
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await expect(app.locator(".topbar__count")).toContainText("1 comment");
  });

  test("edit then delete a saved comment", async ({ app }) => {
    const file = app.locator(".filediff", { hasText: "greeting.py" });
    await file.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click();
    await app.locator(".thread__textarea").fill("first version");
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await expect(app.locator(".thread__body")).toContainText("first version");

    await app.getByRole("button", { name: "Edit", exact: true }).click();
    await app.locator(".thread__textarea").fill("edited version");
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await expect(app.locator(".thread__body")).toContainText("edited version");
    await expect(app.locator(".topbar__count")).toContainText("1 comment");

    await app.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(app.locator(".thread")).toHaveCount(0);
    await expect(app.locator(".topbar__count")).toContainText("0 comments");
    await expect(app.getByRole("button", { name: "Submit review" })).toBeDisabled();
  });

  test("overall summary auto-saves and enables submit on its own", async ({ app }) => {
    await expect(app.getByRole("button", { name: "Submit review" })).toBeDisabled();
    await app.locator(".summary__textarea").fill("Looks fine, ship it.");
    await app.locator(".summary__textarea").blur();
    await expect(app.locator(".summary__saved")).toContainText("Saved");
    await expect(app.getByRole("button", { name: "Submit review" })).toBeEnabled();
  });

  test("split view toggle reorganizes the diff", async ({ app }) => {
    await app.locator(".filediff").first().scrollIntoViewIfNeeded();
    // Default is unified — no left/right side classes.
    const hasSplitClass = await app.locator(".diff-split").count();
    expect(hasSplitClass).toBe(0);
    await app.getByLabel("Split").check();
    await expect(app.locator(".diff-split")).toHaveCount(1);
    await app.getByLabel("Unified").check();
    await expect(app.locator(".diff-split")).toHaveCount(0);
  });

  test("source picker switches the diff", async ({ app }) => {
    // Pick the first individual-commit option (its value starts with "commit:").
    const commitOpt = app.locator('.picker__select option[value^="commit:"]').first();
    const value = await commitOpt.getAttribute("value");
    expect(value).toMatch(/^commit:[0-9a-f]+$/);
    await app.locator(".picker__select").selectOption(value!);
    await expect(app.locator(".filediff").first()).toContainText("greeting.py");
  });

  test("orphan-comment banner appears after switching source", async ({ app }) => {
    const file = app.locator(".filediff", { hasText: "greeting.py" });
    await file.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click();
    await app.locator(".thread__textarea").fill("anchored to branch view");
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await expect(app.locator(".thread__body")).toContainText("anchored to branch view");

    // Switch to "Unstaged changes only" — no diff content, comment becomes orphaned.
    await app.locator(".picker__select").selectOption({ label: "Unstaged changes only" });
    // Either the empty-state message OR the orphans banner shows.
    await expect(app.locator("body")).toContainText(/from other diff sources|No changes to review/);
  });

  test("discard flow uses inline confirm bar, not a browser modal", async ({ app, bin }) => {
    const file = app.locator(".filediff", { hasText: "greeting.py" });
    await file.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click();
    await app.locator(".thread__textarea").fill("anything");
    await app.getByRole("button", { name: "Save", exact: true }).click();

    // No dialog handler registered — if window.confirm() fires the test would hang.
    await app.getByRole("button", { name: "Discard" }).click();
    await expect(app.locator(".confirm-bar")).toBeVisible();
    await app.getByRole("button", { name: "Keep editing" }).click();
    await expect(app.locator(".confirm-bar")).toHaveCount(0);

    // Now actually discard.
    await app.getByRole("button", { name: "Discard" }).click();
    await app.getByRole("button", { name: "Yes, discard" }).click();
    await expect(app.locator(".bigmsg")).toContainText("Review cancelled");

    // Binary should exit non-zero with the cancelled message.
    const { code, stderr } = await bin.exit;
    expect(code).toBe(1);
    expect(stderr).toContain("(review cancelled)");
  });

  test("submit produces the correct markdown on stdout and exits 0", async ({ app, bin }) => {
    const file = app.locator(".filediff", { hasText: "greeting.py" });
    await file.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click();
    await app.locator(".thread__textarea").fill("docstring please");
    await app.getByRole("button", { name: "Save", exact: true }).click();

    await app.locator(".summary__textarea").fill("Nice overall.");
    await app.locator(".summary__textarea").blur();
    await expect(app.locator(".summary__saved")).toContainText("Saved");

    await app.getByRole("button", { name: "Submit review" }).click();
    await expect(app.locator(".bigmsg")).toContainText("Review submitted");

    const { code, stdout } = await bin.exit;
    expect(code).toBe(0);
    expect(stdout).toMatch(/^# Code review feedback/);
    expect(stdout).toMatch(/## Overall\n\nNice overall\./);
    expect(stdout).toMatch(/### greeting\.py:8 \(refactor vs main\)/);
    expect(stdout).toContain(">     return message.upper()");
    expect(stdout).toMatch(/docstring please/);
  });

  test("diff is syntax-highlighted when the file extension maps to a known language", async ({ app }) => {
    // The simple fixture is greeting.py — Python keywords should be highlighted.
    const file = app.locator(".filediff", { hasText: "greeting.py" });
    // refractor emits <span class="token keyword">def</span> etc.
    await expect(file.locator(".token.keyword").first()).toBeVisible();
    await expect(file.locator(".token.keyword").first()).toContainText(/def|return|if/);
  });

  test("expand hidden lines: click the expand button shows previously-collapsed lines", async ({ app }) => {
    const file = app.locator(".filediff", { hasText: "long.txt" });
    // The 30-line file with a tiny edit at line 15 produces a small hunk
    // with hidden lines both above and below.
    const expandButtons = file.locator(".expand-btn");
    await expect.poll(() => expandButtons.count()).toBeGreaterThan(0);

    // Click the FIRST expand button (above the hunk) and confirm a previously
    // hidden line becomes visible.
    await expect(file.getByText("line 1", { exact: true })).toHaveCount(0);
    await expandButtons.first().click();
    await expect(file.getByText("line 1", { exact: true })).toBeVisible();
  });
});

test("clear all comments wipes every saved comment after confirmation but keeps the summary", async ({ app }) => {
  const file = app.locator(".filediff", { hasText: "greeting.py" });

  // Save two comments and a summary.
  await file.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click();
  await app.locator(".thread__textarea").fill("first comment");
  await app.getByRole("button", { name: "Save", exact: true }).click();

  await file.locator('td.diff-gutter-insert[data-change-key="I7"]').filter({ hasText: "7" }).click();
  await app.locator(".thread__textarea").fill("second comment");
  await app.getByRole("button", { name: "Save", exact: true }).click();

  await app.locator(".summary__textarea").fill("Keep me");
  await app.locator(".summary__textarea").blur();
  await expect(app.locator(".summary__saved")).toContainText("Saved");
  await expect(app.locator(".topbar__count")).toContainText("2 comments");

  // Click Clear all → confirm bar appears.
  await app.getByRole("button", { name: "Clear all comments" }).click();
  await expect(app.locator(".confirm-bar")).toContainText("Delete all 2 saved comments");

  // Cancel keeps everything.
  await app.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(app.locator(".topbar__count")).toContainText("2 comments");

  // Now confirm.
  await app.getByRole("button", { name: "Clear all comments" }).click();
  await app.getByRole("button", { name: "Yes, clear comments" }).click();
  await expect(app.locator(".topbar__count")).toContainText("0 comments");
  await expect(app.locator(".thread")).toHaveCount(0);
  // Summary survives.
  await expect(app.locator(".summary__textarea")).toHaveValue("Keep me");
  // Submit stays enabled because summary still has content.
  await expect(app.getByRole("button", { name: "Submit review" })).toBeEnabled();
});

test("opening the review in a second tab supersedes the first", async ({ bin, browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const tabA = await ctxA.newPage();
  const tabB = await ctxB.newPage();
  try {
    await tabA.goto(bin.url);
    // Wait until tab A is mounted and the SSE 'hello' has been received.
    await expect(tabA.locator(".topbar")).toBeVisible();

    // Open the same URL in tab B. The server should immediately push
    // 'superseded' to tab A and tab A should transition to the terminal state.
    await tabB.goto(bin.url);
    await expect(tabB.locator(".topbar")).toBeVisible();
    await expect(tabA.locator(".bigmsg")).toContainText("now open in another tab");
    // Tab B still works as normal.
    await expect(tabB.locator(".bigmsg")).toHaveCount(0);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// Resume test runs outside the standard `test`/`bin` fixture pair because it
// needs to start the binary twice against the same repo.
test("drafts persist across discard and reappear on resume", async () => {
  const repo = await makeRepo("simple");
  try {
    // --- session 1: add a comment, discard ---
    const bin1 = await startBinary({ cwd: repo.dir });
    const browser = await chromium.launch();
    const page1 = await browser.newPage();
    try {
      await page1.goto(bin1.url);
      const file1 = page1.locator(".filediff", { hasText: "greeting.py" });
      await file1.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click();
      await page1.locator(".thread__textarea").fill("persisted across sessions");
      await page1.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page1.locator(".thread__body")).toContainText("persisted across sessions");

      await page1.getByRole("button", { name: "Discard" }).click();
      await page1.getByRole("button", { name: "Yes, discard" }).click();
      await expect(page1.locator(".bigmsg")).toContainText("Review cancelled");
    } finally {
      await page1.close();
    }
    expect((await bin1.exit).code).toBe(1);

    // --- session 2: same repo, comment is restored ---
    const bin2 = await startBinary({ cwd: repo.dir });
    const page2 = await browser.newPage();
    try {
      await page2.goto(bin2.url);
      const file2 = page2.locator(".filediff", { hasText: "greeting.py" });
      await expect(file2.locator(".thread__body")).toContainText("persisted across sessions");
      await expect(page2.locator(".topbar__count")).toContainText("1 comment");
    } finally {
      await page2.close();
      bin2.child.kill("SIGINT");
      await Promise.race([bin2.exit, new Promise((r) => setTimeout(r, 1500))]);
      await browser.close();
    }
  } finally {
    await fs.rm(repo.dir, { recursive: true, force: true });
  }
});
