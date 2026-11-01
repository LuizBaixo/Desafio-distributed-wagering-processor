import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { from, type Observable } from "rxjs";
import { lastValueFrom } from "rxjs";
import { getTracing } from "../../application/ports/tracing";

/** Rotas de infraestrutura não geram span: seriam ruído a cada scrape e a cada probe. */
const SKIPPED_PREFIXES = ["/metrics", "/health"];

/** Abre o span `http.request` em volta do handler. Sem tracing ativo, é uma passagem direta. */
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest<{ method?: string; url?: string; route?: { path?: string } }>();
    const res = ctx.switchToHttp().getResponse<{ statusCode?: number }>();
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (SKIPPED_PREFIXES.some((p) => path.startsWith(p))) return next.handle();

    return from(
      getTracing().withSpan(
        "http.request",
        { "http.method": req.method ?? "", "http.route": req.route?.path ?? path },
        async (span) => {
          try {
            return await lastValueFrom(next.handle(), { defaultValue: undefined });
          } finally {
            if (res.statusCode !== undefined) span.setAttribute("http.status_code", res.statusCode);
          }
        },
      ),
    );
  }
}
