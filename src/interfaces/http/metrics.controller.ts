import { Controller, Get, Header } from "@nestjs/common";
import { PromMetrics } from "../../infrastructure/observability/prom-metrics";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: PromMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async get(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
