#!/usr/bin/env bun
/**
 * Gera o relatório de auditoria de segurança: report.html e relatorio-auditoria-seguranca.pdf.
 *
 * Uso:
 *   bun run security:report            lê findings-a.json e findings-b.json
 *   bun run security:report -- --sample  lê fixtures/sample-a.json e fixtures/sample-b.json
 *
 * PDF: Microsoft Edge headless via CDP (Page.printToPDF com cabeçalho/rodapé).
 * Caminho do Edge: variável EDGE_PATH. Pasta de saída: SECURITY_REPORT_OUT (padrão: esta pasta).
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = process.argv.includes("--sample");
const EDGE =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const REPORT_NAME = "Relatório de Auditoria de Segurança";
const REPORT_TITLE = `${REPORT_NAME} — Distributed Wagering Processor`;

// ---------- tipos (formato definido em Desafio/03-Plano/Auditoria de Seguranca.md) ----------

type Severity = "critica" | "alta" | "media" | "baixa" | "informativa";
type Category = "1" | "2" | "3" | "4" | "5" | "extra";
/** Ausente no JSON = "aberto". */
type Status = "corrigido" | "documentado" | "parcial" | "aberto";

interface Finding {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  file: string;
  lines: string;
  snippet: string;
  description: string;
  exploitability: string;
  impact: string;
  fix: string;
  acceptance: string[];
  issueGroup?: string;
  status?: Status;
  fixedIn?: string;
  note?: string;
}

interface Strength {
  category: Category;
  text: string;
  evidence: string;
}

interface Stack {
  language: string;
  framework: string;
  orm: string;
  auth: string;
  frontend: string;
  deploy: string[];
}

interface AuditFile {
  auditor: "A" | "B";
  stack: Stack;
  methodology: Partial<Record<Category, string>>;
  coverage: string[];
  findings: Finding[];
  strengths: Strength[];
}

// ---------- constantes ----------

const SEV_ORDER: Severity[] = ["critica", "alta", "media", "baixa", "informativa"];
const SEV_LABEL: Record<Severity, string> = {
  critica: "Crítica",
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
  informativa: "Informativa",
};
const COLOR = {
  critica: "#B91C1C",
  alta: "#EA580C",
  media: "#D97706",
  baixa: "#2563EB",
  informativa: "#6B7280",
  forte: "#059669",
} as const;
const CAT_ORDER: Category[] = ["1", "2", "3", "4", "5", "extra"];
const CAT_LABEL: Record<Category, string> = {
  "1": "Banco sem tranca",
  "2": "Permissão definida no navegador",
  "3": "IDOR",
  "4": "Chaves expostas",
  "5": "XSS",
  extra: "Testes extras",
};

const STATUS_ORDER: Status[] = ["corrigido", "parcial", "documentado", "aberto"];
const STATUS_LABEL: Record<Status, string> = {
  corrigido: "Corrigido",
  parcial: "Parcial",
  documentado: "Documentado",
  aberto: "Aberto",
};
const STATUS_COLOR: Record<Status, string> = {
  corrigido: "#059669",
  parcial: "#D97706",
  documentado: "#2563EB",
  aberto: "#B91C1C",
};

// ---------- utilitários ----------

/** Escapa qualquer texto antes de entrar no HTML. Todo dado do JSON passa por aqui. */
function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEV_ORDER as string[]).includes(v);
}

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CAT_ORDER as string[]).includes(v);
}

function fail(file: string, msg: string): never {
  throw new Error(`${file}: ${msg}`);
}

function validate(data: AuditFile, file: string): AuditFile {
  if (data.auditor !== "A" && data.auditor !== "B") fail(file, "auditor deve ser A ou B");
  if (!Array.isArray(data.findings)) fail(file, "findings deve ser uma lista");
  if (!Array.isArray(data.strengths)) fail(file, "strengths deve ser uma lista");
  if (!Array.isArray(data.coverage)) fail(file, "coverage deve ser uma lista");
  for (const f of data.findings) {
    if (!f.id || !isSeverity(f.severity) || !isCategory(f.category)) {
      fail(file, `achado inválido (id/category/severity): ${JSON.stringify(f.id)}`);
    }
    if (!Array.isArray(f.acceptance)) f.acceptance = [];
    f.fix ??= "";
    if (f.status !== undefined && !(STATUS_ORDER as string[]).includes(f.status)) {
      fail(file, `achado ${f.id} com status inválido: ${JSON.stringify(f.status)}`);
    }
  }
  for (const s of data.strengths) {
    if (!isCategory(s.category)) fail(file, `ponto forte com categoria inválida: ${s.category}`);
  }
  return data;
}

async function loadAudit(letter: "a" | "b"): Promise<AuditFile> {
  const rel = SAMPLE ? `fixtures/sample-${letter}.json` : `findings-${letter}.json`;
  const path = join(HERE, rel);
  if (!existsSync(path)) {
    fail(path, SAMPLE ? "fixture não encontrado" : "arquivo não encontrado (rode com --sample para os fixtures)");
  }
  return validate((await Bun.file(path).json()) as AuditFile, rel);
}

const sevChip = (s: Severity) =>
  `<span class="chip" style="background:${COLOR[s]}">${SEV_LABEL[s]}</span>`;

const statusOf = (f: Finding): Status => f.status ?? "aberto";

/** Chip de status + hash do commit (fixedIn), quando houver. */
function statusChip(f: Finding): string {
  const s = statusOf(f);
  return `<span class="chip" style="background:${STATUS_COLOR[s]}">${STATUS_LABEL[s]}</span>` +
    (f.fixedIn ? `<br><span class="hash">${esc(f.fixedIn)}</span>` : "");
}

function statusCounts(list: Finding[]): Record<Status, number> {
  const out = { corrigido: 0, documentado: 0, parcial: 0, aberto: 0 };
  for (const f of list) out[statusOf(f)]++;
  return out;
}

/** Só achados abertos ou parciais geram issue. */
function isOpenOrPartial(f: Finding): boolean {
  const s = statusOf(f);
  return s === "aberto" || s === "parcial";
}

/** Achado acionável: vira issue. Informativa só vira issue se tiver correção e critérios de aceite. */
function isActionable(f: Finding): boolean {
  return f.severity !== "informativa" || (f.fix.trim() !== "" && f.acceptance.length > 0);
}

function priorityOf(s: Severity): "P1" | "P2" | "P3" {
  if (s === "critica" || s === "alta") return "P1";
  if (s === "media") return "P2";
  return "P3";
}

function bySeverity(list: Finding[]): Record<Severity, number> {
  const out = { critica: 0, alta: 0, media: 0, baixa: 0, informativa: 0 };
  for (const f of list) out[f.severity]++;
  return out;
}

function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort(
    (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.id.localeCompare(b.id),
  );
}

// ---------- gráficos SVG inline ----------

function donutSvg(counts: Record<Severity, number>): string {
  const total = SEV_ORDER.reduce((n, s) => n + counts[s], 0);
  if (total === 0) return "<p>Nenhum achado.</p>";
  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = SEV_ORDER.filter((s) => counts[s] > 0)
    .map((s) => {
      const len = (counts[s] / total) * C;
      const arc = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${COLOR[s]}" stroke-width="34" stroke-dasharray="${len.toFixed(3)} ${(C - len).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}" transform="rotate(-90 100 100)"/>`;
      offset += len;
      return arc;
    })
    .join("");
  const legend = SEV_ORDER.map((s, i) => {
    const y = 40 + i * 28;
    const pct = ((counts[s] / total) * 100).toFixed(0);
    return `<rect x="210" y="${y - 11}" width="14" height="14" rx="3" fill="${COLOR[s]}"/>` +
      `<text x="232" y="${y}" font-size="13" fill="#111827">${SEV_LABEL[s]}: ${counts[s]} (${pct}%)</text>`;
  }).join("");
  return `<svg viewBox="0 0 470 200" width="100%" role="img" aria-label="Achados por severidade">` +
    `<g>${arcs}</g>` +
    `<text x="100" y="96" text-anchor="middle" font-size="28" font-weight="700" fill="#111827">${total}</text>` +
    `<text x="100" y="116" text-anchor="middle" font-size="12" fill="#6B7280">achados</text>` +
    legend + `</svg>`;
}

function barSvg(rows: { label: string; counts: Record<Severity, number> }[]): string {
  const LABEL_W = 250;
  const AREA_W = 290;
  const ROW_H = 30;
  const max = Math.max(1, ...rows.map((r) => SEV_ORDER.reduce((n, s) => n + r.counts[s], 0)));
  const scale = AREA_W / max;
  const legendY = 14;
  const legend = SEV_ORDER.map((s, i) =>
    `<rect x="${LABEL_W + i * 78}" y="${legendY - 9}" width="11" height="11" rx="2" fill="${COLOR[s]}"/>` +
    `<text x="${LABEL_W + i * 78 + 15}" y="${legendY}" font-size="11" fill="#374151">${SEV_LABEL[s]}</text>`,
  ).join("");
  const body = rows.map((r, i) => {
    const y = 34 + i * ROW_H;
    let x = LABEL_W;
    const bars = SEV_ORDER.map((s) => {
      const w = r.counts[s] * scale;
      if (w <= 0) return "";
      const rect = `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="18" fill="${COLOR[s]}"/>`;
      x += w;
      return rect;
    }).join("");
    const total = SEV_ORDER.reduce((n, s) => n + r.counts[s], 0);
    return `<text x="${LABEL_W - 8}" y="${y + 13}" text-anchor="end" font-size="11" fill="#111827">${esc(r.label)}</text>` +
      `<rect x="${LABEL_W}" y="${y}" width="${AREA_W}" height="18" fill="#F3F4F6"/>` +
      bars +
      `<text x="${(x + 6).toFixed(1)}" y="${y + 13}" font-size="11" fill="#111827">${total}</text>`;
  }).join("");
  const height = 34 + rows.length * ROW_H + 8;
  return `<svg viewBox="0 0 ${LABEL_W + AREA_W + 40} ${height}" width="100%" role="img" aria-label="Achados por categoria">` +
    legend + body + `</svg>`;
}

/** Barra empilhada com achados por status (um só segmento por status). */
function statusBarSvg(counts: Record<Status, number>): string {
  const W = 640;
  const total = STATUS_ORDER.reduce((n, s) => n + counts[s], 0);
  if (total === 0) return "<p>Nenhum achado.</p>";
  let x = 0;
  const bar = STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => {
    const w = (counts[s] / total) * W;
    const rect = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="24" fill="${STATUS_COLOR[s]}"/>`;
    x += w;
    return rect;
  }).join("");
  const legend = STATUS_ORDER.map((s, i) =>
    `<rect x="${i * 160}" y="40" width="12" height="12" rx="2" fill="${STATUS_COLOR[s]}"/>` +
    `<text x="${i * 160 + 17}" y="51" font-size="12" fill="#111827">${STATUS_LABEL[s]}: ${counts[s]}</text>`,
  ).join("");
  return `<svg viewBox="0 0 ${W} 60" width="100%" role="img" aria-label="Achados por status">${bar}${legend}</svg>`;
}

function statusSummaryLine(list: Finding[]): string {
  const c = statusCounts(list);
  return `${c.corrigido} corrigidos, ${c.parcial} parciais, ${c.documentado} documentados, ${c.aberto} abertos`;
}

// ---------- seções do relatório ----------

function renderCover(a: AuditFile, b: AuditFile, date: string): string {
  const stackRows = [a, b].map((x) => {
    const s = x.stack;
    return `<tr><th>Auditor ${esc(x.auditor)}</th><td>${esc(s.language)} · ${esc(s.framework)} · ${esc(s.orm)}` +
      `<br>Autenticação: ${esc(s.auth)} · Front-end: ${esc(s.frontend)}` +
      `<br>Deploy: ${esc(s.deploy.join(", "))}</td></tr>`;
  }).join("");
  const methodology = CAT_ORDER.map((c) => {
    const parts = [a, b]
      .filter((x) => x.methodology[c])
      .map((x) => `<p class="small"><strong>Auditor ${esc(x.auditor)}:</strong> ${esc(x.methodology[c])}</p>`)
      .join("");
    return `<div class="meth"><h4>Categoria ${esc(c)} — ${esc(CAT_LABEL[c])}</h4>${parts || '<p class="small">Sem nota metodológica.</p>'}</div>`;
  }).join("");
  return `<section class="cover">
  <p class="kicker">Auditoria de segurança</p>
  <h1>${esc(REPORT_TITLE)}</h1>
  <p class="date">Data: ${esc(date)}</p>
  <p class="date">Situação após correções em ${esc(date)}</p>
  ${SAMPLE ? '<p class="banner">AMOSTRA: dados de exemplo gerados por --sample. Não é o relatório final.</p>' : ""}
  <h2>Escopo</h2>
  <p>Auditoria da aplicação em <code>app/</code>, com dois auditores independentes (A e B) cujos achados foram consolidados neste relatório.</p>
  <table class="kv"><tbody>${stackRows}</tbody></table>
  <h2>Nota metodológica</h2>
  ${methodology}
</section>`;
}

function renderSummary(all: Finding[], strengths: Strength[], a: AuditFile, b: AuditFile): string {
  const counts = bySeverity(all);
  const cards = SEV_ORDER.map((s) =>
    `<div class="stat" style="border-top:4px solid ${COLOR[s]}"><div class="num" style="color:${COLOR[s]}">${counts[s]}</div><div>${SEV_LABEL[s]}</div></div>`,
  ).join("") +
    `<div class="stat" style="border-top:4px solid ${COLOR.forte}"><div class="num" style="color:${COLOR.forte}">${strengths.length}</div><div>Pontos fortes</div></div>`;
  const byCat = CAT_ORDER.map((c) => ({
    label: `${c === "extra" ? "Extra" : "Cat. " + c} · ${CAT_LABEL[c]}`,
    counts: bySeverity(all.filter((f) => f.category === c)),
  }));
  const total = all.length;
  const worst = counts.critica + counts.alta;
  return `<section class="sec">
  <h2>Resumo executivo</h2>
  <p>Foram registrados <strong>${total}</strong> achados (${counts.critica} crítico(s), ${counts.alta} alto(s), ${counts.media} médio(s), ${counts.baixa} baixo(s), ${counts.informativa} informativo(s)) e <strong>${strengths.length}</strong> pontos fortes. ${worst > 0 ? `Os <strong>${worst}</strong> achados críticos e altos concentram o risco e devem ser tratados primeiro.` : "Não há achados críticos ou altos."}</p>
  <div class="stats">${cards}</div>
  <figure>
    <figcaption>Achados por severidade</figcaption>
    ${donutSvg(counts)}
  </figure>
  <figure>
    <figcaption>Achados por categoria, empilhados por severidade</figcaption>
    ${barSvg(byCat)}
  </figure>
  <figure>
    <figcaption>Achados por status</figcaption>
    ${statusBarSvg(statusCounts(all))}
    <p class="small"><strong>${statusSummaryLine(all)}</strong></p>
  </figure>
  <p class="small">Auditor A: ${a.findings.length} achado(s). Auditor B: ${b.findings.length} achado(s).</p>
</section>`;
}

function renderStrengthsAndWeaknesses(all: Finding[], strengths: Strength[]): string {
  const weak = sortFindings(all.filter((f) => f.severity === "critica" || f.severity === "alta"));
  const weakHtml = weak.length === 0
    ? "<p>Nenhum achado crítico ou alto.</p>"
    : weak.map((f) =>
      `<article class="card" style="border-left-color:${COLOR[f.severity]}">
        <p>${sevChip(f.severity)} ${statusChip(f)} <strong>${esc(f.id)}</strong> · ${esc(f.title)}</p>
        <p class="small"><code>${esc(f.file)}:${esc(f.lines)}</code></p>
        <p>${esc(f.description)}</p>
        <p class="small"><strong>Explorabilidade:</strong> ${esc(f.exploitability)}</p>
      </article>`).join("");
  const strengthRows = strengths.map((s) =>
    `<tr><td><span class="chip" style="background:${COLOR.forte}">Ponto forte</span></td>` +
    `<td>${esc(CAT_LABEL[s.category])}</td><td>${esc(s.text)}</td><td><code>${esc(s.evidence)}</code></td></tr>`).join("");
  return `<section class="sec">
  <h2>Pontos fortes</h2>
  ${strengths.length === 0 ? "<p>Nenhum ponto forte registrado.</p>" : `<table>
    <thead><tr><th>Tipo</th><th>Categoria</th><th>O que está protegido</th><th>Evidência</th></tr></thead>
    <tbody>${strengthRows}</tbody></table>`}
  <h2>Pontos fracos (riscos centrais)</h2>
  ${weakHtml}
</section>`;
}

function renderFindingTables(all: Finding[]): string {
  const sections = CAT_ORDER.map((c) => {
    const list = sortFindings(all.filter((f) => f.category === c));
    if (list.length === 0) return `<h3>Categoria ${esc(c)} — ${esc(CAT_LABEL[c])}</h3><p class="small">Nenhum achado nesta categoria.</p>`;
    const rows = list.map((f) =>
      `<tr><td>${sevChip(f.severity)}</td>` +
      `<td>${statusChip(f)}</td>` +
      `<td><code>${esc(f.file)}:${esc(f.lines)}</code></td>` +
      `<td><strong>${esc(f.id)} — ${esc(f.title)}</strong><br>${esc(f.description)}` +
      (f.note ? `<br><span class="small"><strong>Situação:</strong> ${esc(f.note)}</span>` : "") +
      `</td></tr>`).join("");
    return `<h3>Categoria ${esc(c)} — ${esc(CAT_LABEL[c])}</h3>
    <table>
      <thead><tr><th style="width:12%">Severidade</th><th style="width:14%">Status</th><th style="width:22%">Arquivo:linha</th><th>Descrição</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }).join("");
  return `<section class="sec"><h2>Achados por categoria</h2>${sections}</section>`;
}

function renderRecommendations(all: Finding[]): string {
  const sorted = sortFindings(all);
  const group = (p: "P1" | "P2" | "P3") => sorted.filter((f) => priorityOf(f.severity) === p);
  const item = (f: Finding) =>
    `<li>${sevChip(f.severity)} ${statusChip(f)} <strong>${esc(f.id)}</strong> ${esc(f.title)}` +
    (isActionable(f) ? `<br><span class="small">${esc(f.fix) || "—"}</span>` : ` <span class="small">(sem ação; não vira issue)</span>`) +
    `</li>`;
  const block = (p: "P1" | "P2" | "P3", heading: string) => {
    const list = group(p);
    return `<h3>${p} — ${esc(heading)}</h3>${list.length === 0 ? '<p class="small">Nenhum item.</p>' : `<ol>${list.map(item).join("")}</ol>`}`;
  };
  return `<section class="sec"><h2>Recomendações priorizadas</h2>
  ${block("P1", "crítica e alta: corrigir antes de qualquer exposição")}
  ${block("P2", "média: corrigir no próximo ciclo")}
  ${block("P3", "baixa e informativa: melhoria e higiene")}
</section>`;
}

/** Monta a issue em Markdown. Um grupo (issueGroup) junta vários achados numa única issue. */
function issueMarkdown(findings: Finding[], n: number): string {
  const top = findings.reduce((best, f) => (SEV_ORDER.indexOf(f.severity) < SEV_ORDER.indexOf(best.severity) ? f : best));
  const single = findings.length === 1 && !findings[0].issueGroup;
  const title = single ? findings[0].title : findings[0].issueGroup!;
  const labels = ["security", `severidade:${top.severity}`];
  const sections = findings.map((f) => {
    const snippet = f.snippet.replace(/```/g, "` ` `");
    return `### ${f.id} — ${f.title}

**Categoria:** ${f.category} — ${CAT_LABEL[f.category]}
**Severidade:** ${SEV_LABEL[f.severity]}
**Status:** ${STATUS_LABEL[statusOf(f)]}${f.note ? ` — ${f.note}` : ""}

**Descrição:** ${f.description}

**Por que é explorável:** ${f.exploitability}

**Evidência:** \`${f.file}:${f.lines}\`

\`\`\`
${snippet}
\`\`\`

**Impacto:** ${f.impact}

**Sugestão de correção:** ${f.fix}`;
  }).join("\n\n");
  const acceptance = [...new Set(findings.flatMap((f) => f.acceptance))]
    .map((a) => (a.startsWith("- [ ]") ? a : `- [ ] ${a.replace(/^\[ \] ?/, "")}`))
    .join("\n");
  return `# [Segurança] ${title}

**Labels:** ${labels.map((l) => `\`${l}\``).join(", ")}

${sections}

## Critérios de aceite

${acceptance}`;
}

function renderIssues(all: Finding[]): string {
  const groups = new Map<string, Finding[]>();
  for (const f of sortFindings(all.filter((x) => isOpenOrPartial(x) && isActionable(x)))) {
    const key = f.issueGroup ? `group:${f.issueGroup}` : `id:${f.id}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  let n = 0;
  const blocks = [...groups.values()].map((findings) => {
    n++;
    const md = issueMarkdown(findings, n);
    return `<pre class="issue">--- ISSUE ${n} ---\n${esc(md)}\n--- FIM ISSUE ${n} ---</pre>`;
  });
  const issuesHtml = !all.some(isOpenOrPartial)
    ? "<p><strong>Nenhum achado aberto ou parcial: nenhuma issue a abrir.</strong></p>"
    : blocks.length === 0 ? "<p>Nenhuma issue acionável.</p>" : blocks.join("\n");
  const fixed = sortFindings(all.filter((f) => statusOf(f) === "corrigido"));
  const documented = sortFindings(all.filter((f) => statusOf(f) === "documentado"));
  const fixedHtml = fixed.length === 0
    ? '<p class="small">Nenhum achado corrigido.</p>'
    : `<ul class="fixed">${fixed.map((f) =>
      `<li><span class="hash">${esc(f.fixedIn ?? "sem hash")}</span> <strong>${esc(f.id)}</strong> ${esc(f.title)}</li>`).join("")}</ul>`;
  const documentedHtml = documented.length === 0
    ? ""
    : `<h3>Documentados (sem issue)</h3><p class="small">${documented.map((f) =>
      `<strong>${esc(f.id)}</strong> ${esc(f.title)}`).join("<br>")}</p>`;
  return `<section class="sec">
  <h2>ISSUES PARA O GITHUB</h2>
  <p class="small">Cada bloco abaixo é uma issue completa em Markdown, somente para achados <strong>aberto</strong> ou <strong>parcial</strong>. Achados informativos sem ação não viram issue. Achados com o mesmo <code>issueGroup</code> ficam numa única issue; membros já corrigidos ficam fora dela.</p>
  ${issuesHtml}
  <h3>Já corrigidos</h3>
  ${fixedHtml}
  ${documentedHtml}
</section>`;
}

// ---------- página ----------

const CSS = `
* { box-sizing: border-box; }
.hash { font-family: Consolas, "Courier New", monospace; font-size: 7.5pt; color: #374151; white-space: nowrap; }
ul.fixed { margin: 4pt 0 10pt; padding-left: 18px; } ul.fixed li { margin-bottom: 3pt; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #111827; margin: 0; }
h1 { font-size: 22pt; line-height: 1.2; margin: 6pt 0 14pt; }
h2 { font-size: 15pt; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px; margin: 0 0 10pt; break-after: avoid; }
h3 { font-size: 12pt; margin: 16pt 0 6pt; break-after: avoid; }
h4 { font-size: 10.5pt; margin: 8pt 0 2pt; }
.sec { break-before: page; }
.cover .kicker { color: #6B7280; text-transform: uppercase; letter-spacing: 1px; font-size: 9pt; margin: 0; }
.cover .date { color: #374151; }
.banner { border: 2px solid #B91C1C; color: #B91C1C; padding: 6px 10px; font-weight: 700; }
.small { font-size: 9pt; color: #374151; margin: 2pt 0; }
code, pre { font-family: Consolas, "Courier New", monospace; font-size: 8.5pt; }
code { background: #F3F4F6; padding: 0 3px; border-radius: 3px; word-break: break-all; }
pre { background: #F3F4F6; padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; margin: 0 0 12pt; }
pre.issue { break-inside: auto; }
table { width: 100%; border-collapse: collapse; margin: 4pt 0 10pt; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { text-align: left; vertical-align: top; padding: 5px 6px; border-bottom: 1px solid #E5E7EB; font-size: 9.5pt; }
th { background: #F9FAFB; }
table.kv th { width: 26%; background: none; }
.chip { display: inline-block; color: #fff; font-weight: 700; font-size: 8.5pt; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
.stats { display: flex; gap: 8px; margin: 10pt 0; }
.stat { flex: 1; background: #F9FAFB; padding: 8px; text-align: center; border-radius: 4px; font-size: 9pt; }
.stat .num { font-size: 20pt; font-weight: 700; }
figure { margin: 12pt 0; break-inside: avoid; }
figcaption { font-weight: 700; font-size: 10pt; margin-bottom: 4pt; }
.card { break-inside: avoid; border-left: 4px solid #6B7280; padding: 6px 10px; margin: 0 0 10pt; background: #FAFAFA; }
.card p { margin: 3pt 0; }
.meth { break-inside: avoid; }
ol { padding-left: 20px; } li { margin-bottom: 6pt; break-inside: avoid; }
`;

function renderHtml(a: AuditFile, b: AuditFile, date: string): string {
  const all = [...a.findings, ...b.findings];
  const strengths = [...a.strengths, ...b.strengths];
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${esc(REPORT_TITLE)}</title>
<style>${CSS}</style>
</head>
<body>
${renderCover(a, b, date)}
${renderSummary(all, strengths, a, b)}
${renderStrengthsAndWeaknesses(all, strengths)}
${renderFindingTables(all)}
${renderRecommendations(all)}
${renderIssues(all)}
</body>
</html>
`;
}

// Cabeçalho e rodapé: Page.printToPDF com displayHeaderFooter (Chromium gera em cada página).
// Medidas em polegadas: A4 = 8.27 x 11.69; margem lateral 2 cm ≈ 0.79 in.
const MARGIN_X = 0.79;
const PAGE_PDF = {
  paperWidth: 8.27,
  paperHeight: 11.69,
  marginTop: 0.9,
  marginBottom: 0.9,
  marginLeft: MARGIN_X,
  marginRight: MARGIN_X,
};
const HF_STYLE = `font-family:'Segoe UI',Arial,sans-serif;font-size:8.5pt;color:#6B7280;width:100%;padding:0 ${MARGIN_X}in;`;
const HEADER_TEMPLATE = `<div style="${HF_STYLE}">${esc(REPORT_NAME)}</div>`;
const FOOTER_TEMPLATE =
  `<div style="${HF_STYLE}text-align:right;">Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>`;

const CDP_PORT = 9300 + Math.floor(Math.random() * 600);

async function waitForPageSocket(port: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()) as { type: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Edge ainda não abriu a porta de depuração
    }
    await Bun.sleep(200);
  }
  throw new Error("Edge não abriu a porta de depuração em 20 s");
}

async function printPdf(htmlPath: string, pdfPath: string): Promise<void> {
  const userData = await mkdtemp(join(tmpdir(), "security-report-edge-"));
  const edge = Bun.spawn(
    [
      EDGE,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  let socket: WebSocket | undefined;
  try {
    socket = new WebSocket(await waitForPageSocket(CDP_PORT));
    const ws = socket;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("falha ao conectar no Edge via CDP"));
    });
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let nextId = 0;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}`));
      else p.resolve(msg.result);
    };
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send("Page.enable");
    await send("Page.navigate", { url: pathToFileURL(htmlPath).href });
    const deadline = Date.now() + 60_000;
    while ((await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true })).result.value !== "complete") {
      if (Date.now() > deadline) throw new Error("página não carregou em 60 s");
      await Bun.sleep(100);
    }
    const { data } = await send("Page.printToPDF", {
      ...PAGE_PDF,
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: true,
      headerTemplate: HEADER_TEMPLATE,
      footerTemplate: FOOTER_TEMPLATE,
    });
    await Bun.write(pdfPath, Buffer.from(data, "base64"));
  } catch (e) {
    edge.kill();
    const err = await new Response(edge.stderr).text();
    throw new Error(`Falha ao gerar PDF pelo Edge: ${(e as Error).message}. ${err.slice(0, 500)}`);
  } finally {
    socket?.close();
    edge.kill();
    await edge.exited;
    await rm(userData, { recursive: true, force: true }).catch(() => {});
  }
  if (!existsSync(pdfPath)) throw new Error(`PDF não foi criado: ${pdfPath}`);
}

async function main(): Promise<void> {
  const a = await loadAudit("a");
  const b = await loadAudit("b");
  const date = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  });

  const outDir = process.env.SECURITY_REPORT_OUT ?? HERE;
  const htmlPath = join(outDir, "report.html");
  const pdfPath = join(outDir, "relatorio-auditoria-seguranca.pdf");
  await Bun.write(htmlPath, renderHtml(a, b, date));
  await printPdf(htmlPath, pdfPath);

  const all = [...a.findings, ...b.findings];
  const counts = bySeverity(all);
  console.log(`${SAMPLE ? "[amostra] " : ""}achados: ${all.length} · ${SEV_ORDER.map((s) => `${SEV_LABEL[s]} ${counts[s]}`).join(" · ")}`);
  console.log(`HTML: ${htmlPath}`);
  console.log(`PDF:  ${pdfPath}`);
}

await main();
