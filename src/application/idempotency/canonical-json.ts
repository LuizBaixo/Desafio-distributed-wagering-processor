/**
 * JSON canônico: chaves de objeto ordenadas recursivamente, sem espaços,
 * propriedades `undefined` omitidas. Arrays mantêm a ordem; `undefined` em array vira `null`
 * (mesmo comportamento do JSON.stringify).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalize(item)));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        out[key] = normalize(v);
      }
    }
    return out;
  }
  return value;
}
