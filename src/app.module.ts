import { Controller, Get, Module } from "@nestjs/common";

@Controller("health")
class LiveController {
  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }
}

@Module({
  controllers: [LiveController],
})
export class AppModule {}
