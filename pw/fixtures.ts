import { ChildProcess, execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { createServer } from "node:net";
import path from "node:path";
import { test as base, Page, expect } from "@playwright/test";

const exec = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, "..", "bin", "diff-review.js");

export interface RepoFixture {
  /** Absolute path to the temp repo. */
  dir: string;
  /** Helper: run a git command in the repo. */
  git: (...args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export async function makeRepo(scenario: "simple" | "multifile" | "expandable"): Promise<RepoFixture> {
  const dir = await fs.mkdtemp("/tmp/diff-review-pw-");
  const git = (...args: string[]) => exec("git", args, { cwd: dir });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "T");

  if (scenario === "simple") {
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
  } else if (scenario === "expandable") {
    // A 30-line file with one tiny edit in the middle. The diff hunk
    // exposes ~3 lines of context around the change, leaving the rest
    // hidden — perfect for testing expand-collapsed behavior.
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await fs.writeFile(path.join(dir, "long.txt"), before);
    await git("add", ".");
    await git("commit", "-q", "-m", "initial 30-line file");
    await git("checkout", "-q", "-b", "tiny-edit");
    const after = Array.from({ length: 30 }, (_, i) => i === 14 ? "line 15 EDITED" : `line ${i + 1}`).join("\n") + "\n";
    await fs.writeFile(path.join(dir, "long.txt"), after);
    await git("add", ".");
    await git("commit", "-q", "-m", "edit line 15");
  } else {
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "initial");
    await git("checkout", "-q", "-b", "feature");
    await fs.writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
    await fs.writeFile(path.join(dir, "b.txt"), "hello\nworld\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "edit a, add b");
    await fs.writeFile(path.join(dir, "b.txt"), "hello\nworld\nbang\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "extend b");
  }

  return { dir, git };
}

export async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}

export interface RunningBinary {
  url: string;
  port: number;
  token: string;
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Resolves when the child exits with code and accumulated stdout/stderr. */
  exit: Promise<{ code: number; stdout: string; stderr: string }>;
}

export async function startBinary(opts: { cwd: string }): Promise<RunningBinary> {
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "--no-browser", "--port", String(port), "--cwd", opts.cwd], {
    env: { ...process.env, HOME: process.env.HOME ?? "/tmp" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => { stdout += b.toString(); });
  child.stderr.on("data", (b) => { stderr += b.toString(); });

  const exit = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

  // Wait until the binary prints the "open URL" line.
  const ready = new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (b: Buffer) => {
      buf += b.toString();
      const m = buf.match(/open (http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/);
      if (m) {
        child.stderr.off("data", onData);
        resolve(m[1]);
      }
    };
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", () => reject(new Error("binary exited before becoming ready")));
    setTimeout(() => reject(new Error("binary did not become ready in 5s")), 5000);
  });

  const url = await ready;
  const token = new URL(url).searchParams.get("t")!;
  return {
    url,
    port,
    token,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exit,
  };
}

type Fixtures = {
  repo: RepoFixture;
  bin: RunningBinary;
  app: Page;
};

export const test = base.extend<Fixtures>({
  repo: async ({}, use, testInfo) => {
    const t = testInfo.title;
    const scenario = t.includes("expand") ? "expandable" : t.includes("multi") ? "multifile" : "simple";
    const repo = await makeRepo(scenario);
    await use(repo);
    await fs.rm(repo.dir, { recursive: true, force: true });
  },
  bin: async ({ repo }, use) => {
    const b = await startBinary({ cwd: repo.dir });
    try {
      await use(b);
    } finally {
      // Make sure the child is cleaned up even if the test left it alive.
      if (b.child.exitCode === null && !b.child.killed) {
        b.child.kill("SIGINT");
        await Promise.race([b.exit, new Promise((r) => setTimeout(r, 1500))]);
      }
    }
  },
  app: async ({ page, bin }, use) => {
    await page.goto(bin.url);
    await use(page);
  },
});

export { expect };
