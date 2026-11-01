// Verifica o index.html da apresentação. Sai com 1 e lista os problemas se encontrar algum.
// Uso: bun run check:apresentacao

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const file = join(import.meta.dir, "index.html");

if (!existsSync(file)) {
  console.error(`FALHA: arquivo não encontrado: ${file}`);
  process.exit(1);
}

const html = readFileSync(file, "utf8");
const lines = html.split("\n");
const problems: string[] = [];

const externalPatterns: Array<[RegExp, string]> = [
  [/<link\b/i, "recurso externo: <link>"],
  [/<script[^>]+src=/i, "recurso externo: <script src=>"],
  [/@import/i, "recurso externo: @import"],
  [/url\(\s*['"]?https?:/i, "recurso externo: url(http...)"],
];

lines.forEach((line, i) => {
  const n = i + 1;
  if (/data-pending/.test(line)) {
    problems.push(`linha ${n}: data-pending (número sem fonte confirmada)`);
  }
  for (const [re, label] of externalPatterns) {
    if (re.test(line)) problems.push(`linha ${n}: ${label}`);
  }
  if (/aria-label\s*=\s*(["'])\s*\1/i.test(line)) {
    problems.push(`linha ${n}: aria-label vazio`);
  }
});

const slideCount = (html.match(/<section class="slide"/g) ?? []).length;
if (slideCount !== 14) {
  problems.push(`esperado 14 <section class="slide">, encontrado ${slideCount}`);
}

if (problems.length > 0) {
  console.error(`FALHA: ${problems.length} problema(s) em index.html:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`OK: index.html sem data-pending, sem recurso externo, 14 slides, aria-label preenchido.`);
