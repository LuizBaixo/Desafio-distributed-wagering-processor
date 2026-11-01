import { Global, Module } from "@nestjs/common";
import { LifecycleState } from "./lifecycle-state";

/** Estado de ciclo de vida, global: a readiness o consulta sem importar o módulo. */
@Global()
@Module({
  providers: [LifecycleState],
  exports: [LifecycleState],
})
export class SystemModule {}
