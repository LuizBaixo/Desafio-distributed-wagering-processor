import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const read = async (rel: string) => (await Bun.file(join(ROOT, rel)).text()).replace(/\r\n/g, "\n");

/** Linhas de mapeamento de porta do host, ex.: - "${POSTGRES_PORT:-5432}:5432" */
function hostPortLines(compose: string): string[] {
  return compose.split("\n").filter((l) => /^\s*-\s*"[^"]*:\d+"\s*$/.test(l));
}

describe("S3: portas publicadas só em 127.0.0.1", () => {
  for (const file of ["docker-compose.yml", "docker-compose.test.yml"]) {
    test(`${file}: toda porta publicada faz bind em 127.0.0.1`, async () => {
      const lines = hostPortLines(await read(file));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/"127\.0\.0\.1:/);
      }
    });
  }
});

describe("S3: credenciais de dev por variável de ambiente", () => {
  test("docker-compose.yml não tem senha literal no postgres, no grafana nem no init", async () => {
    const compose = await read("docker-compose.yml");
    expect(compose).not.toMatch(/POSTGRES_PASSWORD: postgres\s*$/m);
    expect(compose).not.toMatch(/GF_SECURITY_ADMIN_PASSWORD: admin\s*$/m);
    expect(compose).toMatch(/POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:-/);
    expect(compose).toMatch(/GF_SECURITY_ADMIN_PASSWORD: \$\{GRAFANA_ADMIN_PASSWORD:-/);
    expect(compose).toMatch(/WAGERING_OWNER_PASSWORD/);
    expect(compose).toMatch(/WAGERING_APP_PASSWORD/);
  });

  test("grafana mantém acesso anônimo só como Viewer", async () => {
    const compose = await read("docker-compose.yml");
    expect(compose).toMatch(/GF_AUTH_ANONYMOUS_ORG_ROLE: Viewer/);
    expect(compose).not.toMatch(/GF_AUTH_ANONYMOUS_ORG_ROLE: (Editor|Admin)/);
  });

  test("init-roles.sql tem cabeçalho de aviso de desenvolvimento", async () => {
    const sql = await read("infra/postgres/init-roles.sql");
    expect(sql.split("\n").slice(0, 5).join("\n")).toMatch(/somente desenvolvimento local/i);
  });
});

describe("S3: CI e imagem", () => {
  test("ci.yml tem permissions somente leitura no topo", async () => {
    const ci = await read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^permissions:\n\s+contents: read\s*$/m);
  });

  test("ci.yml fixa todas as actions por SHA de 40 caracteres", async () => {
    const ci = await read(".github/workflows/ci.yml");
    const uses = ci.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/@[0-9a-f]{40}\b/);
    }
  });

  test("ci.yml fixa o runner em versão explícita", async () => {
    const ci = await read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/runs-on: ubuntu-latest/);
  });

  test("Dockerfile roda como usuário não root", async () => {
    const df = await read("Dockerfile");
    expect(df).toMatch(/^USER bun\s*$/m);
  });
});
