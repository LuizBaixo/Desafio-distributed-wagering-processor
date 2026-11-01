import { Injectable, type OnModuleDestroy } from "@nestjs/common";

/**
 * Estado de ciclo de vida do processo. Passa a "desligando" no gancho `onModuleDestroy`, que é o primeiro
 * do shutdown: o Nest roda todos os `onModuleDestroy` antes de qualquer `beforeApplicationShutdown`, e o
 * HealthController fecha o pool do Postgres no seu `onModuleDestroy`. Este módulo é importado pelo AppModule,
 * então o Nest o executa antes dele (módulos mais profundos primeiro). Ver ARCHITECTURE.md §16.
 */
@Injectable()
export class LifecycleState implements OnModuleDestroy {
  private shuttingDown = false;

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  onModuleDestroy(): void {
    this.markShuttingDown();
  }
}
