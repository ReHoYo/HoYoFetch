import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;
const distRoot = join(projectRoot, "dist");
const base = "/HoYoFetch/";

function collectHtml(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? collectHtml(path)
      : path.endsWith(".html")
        ? [path]
        : [];
  });
}

function targetFor(href) {
  const clean = href.split(/[?#]/, 1)[0];
  if (!clean.startsWith(base)) return null;

  const path = clean.slice(base.length);
  if (!path) return join(distRoot, "index.html");
  if (path.endsWith("/")) return join(distRoot, path, "index.html");
  return join(distRoot, path);
}

const failures = [];

for (const htmlPath of collectHtml(distRoot)) {
  const html = readFileSync(htmlPath, "utf8");
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = targetFor(match[1]);
    if (target && !existsSync(target)) {
      failures.push(
        `${relative(distRoot, htmlPath)} -> ${match[1]} (${relative(distRoot, target)})`
      );
    }
  }
}

if (failures.length) {
  console.error("Broken generated site links:\n" + failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("All generated HoYoFetch project-page links resolve.");
}
