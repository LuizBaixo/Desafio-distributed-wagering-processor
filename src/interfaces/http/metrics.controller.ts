import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from "@nestjs/swagger";
import { PromMetrics } from "../../infrastructure/observability/prom-metrics";

@ApiTags("ops")
@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: PromMetrics) {}

  @Get()
  @ApiOperation({ summary: "Métricas no formato Prometheus" })
  @ApiProduces("text/plain")
  @ApiResponse({ status: 200, description: "Exposição Prometheus (text/plain; version=0.0.4)." })
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async get(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
