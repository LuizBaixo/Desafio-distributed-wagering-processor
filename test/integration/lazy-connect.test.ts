import { afterAll, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { TransientInfrastructureError } from "../../src/application/errors";
import { buildMikroOrmConfig } from "../../mikro-orm.config";
import { MikroUnitOfWork } from "../../src/infrastructure/persistence/mikro-unit-of-work";
import { TEST_APP_DATABASE_URL } from "../helpers/env";

const orms: MikroORM[] = [];
afterAll(async () => {
  for (const o of orms) await o.close(true);
});

// O PersistenceModule inicializa o MikroORM com connect:false (a app sobe com o banco fora).
// Nota: orm.isConnected() faz um ping e por isso não serve de pré-condição; o que importa
// é que init não conecta/falha e que a primeira consulta conecta sozinha.
test("connect:false against a live database: the first query connects by itself", async () => {
  const orm = await MikroORM.init({ ...buildMikroOrmConfig(TEST_APP_DATABASE_URL), connect: false });
  orms.push(orm);
  const found = await new MikroUnitOfWork(orm.em).run((s) => s.wallets.findById(crypto.randomUUID()));
  expect(found).toBeNull();
});

test("connect:false against a dead port: init succeeds and the first query fails as TransientInfrastructureError", async () => {
  const dead = TEST_APP_DATABASE_URL.replace(":5433/", ":5999/");
  const orm = await MikroORM.init({ ...buildMikroOrmConfig(dead), connect: false });
  orms.push(orm);
  await expect(new MikroUnitOfWork(orm.em).run((s) => s.wallets.findById(crypto.randomUUID()))).rejects.toBeInstanceOf(
    TransientInfrastructureError,
  );
});
