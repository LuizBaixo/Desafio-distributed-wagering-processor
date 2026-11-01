import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "./config";

/** Torna a configuração validada injetável (APP_CONFIG) em qualquer módulo. */
@Global()
@Module({})
export class ConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
