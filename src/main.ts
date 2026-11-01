import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/config";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.port, "0.0.0.0");
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
