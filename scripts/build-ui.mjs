import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { Script } from "node:vm";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const pages = {
  fulfillment: ["api.js", "app.js"],
  practice: ["curriculum.js", "model.js", "app.js"],
};

// Keep the deployed pages self-contained: practice still needs no network access.
export function assemblePage(name, root = projectRoot) {
  if (!Object.hasOwn(pages, name)) throw new Error(`Unknown UI page: ${name}`);
  const source = join(root, "src", "ui", name);
  const read = file => readFileSync(join(source, file), "utf8").replace(/\r\n/g, "\n");
  const css = read("styles.css");
  const script = '"use strict";\n(() => {\n' + pages[name].map(file => `// ${name}/${file}\n${read(file)}`).join("\n") + "\n})();\n";
  new Script(script, { filename: `${name}.html` });
  if (/<\/script/i.test(script) || /<\/style/i.test(css)) throw new Error(`Unexpected closing tag in ${name} assets`);
  let html = read("page.html");
  for (const [marker, content] of [["<!-- INLINE_STYLES -->", css], ["<!-- INLINE_SCRIPT -->", script]]) {
    if (html.split(marker).length !== 2) throw new Error(`${name}: expected one ${marker}`);
    html = html.replace(marker, () => content);
  }
  return html;
}

export function buildUi(root = projectRoot) {
  // Assemble every page before writing, so a syntax error cannot half-update the UI.
  const output = Object.keys(pages).map(name => [name, assemblePage(name, root)]);
  for (const [name, html] of output) {
    const file = join(root, "public", `${name}.html`);
    let existing;
    try { existing = readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing !== html) writeFileSync(file, html, "utf8");
  }
  return output.map(([name]) => name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`UI built: ${buildUi().join(", ")}`);
}
