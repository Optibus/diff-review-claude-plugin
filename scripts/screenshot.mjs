#!/usr/bin/env node
// Regenerate docs/screenshot.png by spinning up the binary against a temp
// fixture repo and driving the UI to a populated state with Playwright.
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "diff-review.js");
const outPath = path.join(root, "docs", "screenshot.png");

async function makeFixture() {
  const dir = await fs.mkdtemp("/tmp/diff-review-ss-");
  const git = (...args) => exec("git", args, { cwd: dir });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "T");
  await fs.writeFile(path.join(dir, "greeting.py"), [
    "def greet(name):",
    '    return "Hello, " + name + "!"',
    "",
    "def farewell(name):",
    '    return "Goodbye, " + name + "!"',
    "",
    'print(greet("World"))',
    'print(farewell("World"))',
    "",
  ].join("\n"));
  await git("add", ".");
  await git("commit", "-q", "-m", "initial");
  await git("checkout", "-q", "-b", "refactor");
  await fs.writeFile(path.join(dir, "greeting.py"), [
    "def greet(name: str) -> str:",
    '    return f"Hello, {name}!"',
    "",
    "def farewell(name: str) -> str:",
    '    return f"Goodbye, {name}!"',
    "",
    "def shout(message: str) -> str:",
    "    return message.upper()",
    "",
    'if __name__ == "__main__":',
    '    print(greet("World"))',
    '    print(farewell("World"))',
    '    print(shout(greet("loud")))',
    "",
  ].join("\n"));
  await git("add", ".");
  await git("commit", "-q", "-m", "modernize greeting");
  return dir;
}

async function startBinary(cwd) {
  const child = spawn(process.execPath, [bin, "--no-browser", "--cwd", cwd]);
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (b) => {
      buf += b.toString();
      const m = buf.match(/open (http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/);
      if (m) resolve(m[1]);
    };
    child.stderr.on("data", onData);
    child.on("close", () => reject(new Error("binary exited before ready")));
    setTimeout(() => reject(new Error("not ready in 5s")), 5000);
  });
  return { child, url };
}

const fixture = await makeFixture();
const { child, url } = await startBinary(fixture);
try {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.goto(url);
  const file = page.locator(".filediff", { hasText: "greeting.py" });
  await file.locator('td.diff-gutter-insert[data-change-key="I8"]').filter({ hasText: "8" }).click();
  await page.locator(".thread__textarea").fill("Add a docstring — callers won't know `shout` uppercases without reading the source.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".thread__body").waitFor();
  await page.locator(".summary__textarea").fill("Looks good overall — type hints + f-strings + a `__main__` guard. One inline nit.");
  await page.locator(".summary__textarea").blur();
  await page.locator(".summary__saved").waitFor();
  await page.screenshot({ path: outPath, fullPage: false });
  await browser.close();
  console.log(`Wrote ${path.relative(root, outPath)}`);
} finally {
  child.kill("SIGINT");
  await new Promise((r) => child.on("close", r));
  await fs.rm(fixture, { recursive: true, force: true });
}
