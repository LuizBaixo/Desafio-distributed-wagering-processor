import { Injectable, type OnModuleDestroy } from "@nestjs/common";

/**
 * Estado de ciclo de vida do processo. Passa a "desligando" no `onModuleDestroy`, antes de qualquer
 * `beforeApplicationShutdown`. O pool do HealthController só fecha em `onApplicationShutdown`, então a
 * readiness responde `SHUTTING_DOWN` antes de qualquer ping falhar. Ver ARCHITECTURE.md §16.
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
