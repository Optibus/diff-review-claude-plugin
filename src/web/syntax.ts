// Syntax highlighting setup for diff lines. Uses `refractor` (Prism-based)
// via react-diff-view's tokenize API. We register only the languages we
// expect to encounter to keep the bundle small.

import refractor from "refractor/core.js";
import bash from "refractor/lang/bash.js";
import css from "refractor/lang/css.js";
import diff from "refractor/lang/diff.js";
import go from "refractor/lang/go.js";
import graphql from "refractor/lang/graphql.js";
import markup from "refractor/lang/markup.js";
import java from "refractor/lang/java.js";
import javascript from "refractor/lang/javascript.js";
import json from "refractor/lang/json.js";
import jsx from "refractor/lang/jsx.js";
import kotlin from "refractor/lang/kotlin.js";
import markdown from "refractor/lang/markdown.js";
import python from "refractor/lang/python.js";
import ruby from "refractor/lang/ruby.js";
import rust from "refractor/lang/rust.js";
import sql from "refractor/lang/sql.js";
import swift from "refractor/lang/swift.js";
import toml from "refractor/lang/toml.js";
import tsx from "refractor/lang/tsx.js";
import typescript from "refractor/lang/typescript.js";
import yaml from "refractor/lang/yaml.js";

[
  bash, css, diff, go, graphql, markup, java, javascript, json, jsx,
  kotlin, markdown, python, ruby, rust, sql, swift, toml, tsx,
  typescript, yaml,
].forEach((lang) => refractor.register(lang));

export { refractor };

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  css: "css",
  scss: "css",
  less: "css",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  patch: "diff",
};

export function languageFor(filePath: string): string | null {
  const ext = filePath.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
  if (!ext) return null;
  return EXT_TO_LANG[ext] ?? null;
}
