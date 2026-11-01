import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { defer, from, type Observable } from "rxjs";
import { lastValueFrom } from "rxjs";
import { getTracing } from "../../application/ports/tracing";

/** Rotas de infraestrutura não geram span: seriam ruído a cada scrape e a cada probe. */
const SKIPPED_PREFIXES = ["/metrics", "/health"];

/**
 * Abre o span `http.request` em volta do handler. O span só termina quando a resposta termina ('finish'),
 * porque o status final (ex.: 400 do filtro de exceção) só existe depois do handler. Sem tracing ativo,
 * é uma passagem direta.
 */
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest<{ method?: string; url?: string; route?: { path?: string } }>();
    const res = ctx.switchToHttp().getResponse<{
      statusCode?: number;
      once(event: "finish" | "close", listener: () => void): unknown;
    }>();
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (SKIPPED_PREFIXES.some((p) => path.startsWith(p))) return next.handle();

    return defer(() => {
      // O valor (ou o erro) do handler vai para o observable; o span fica aberto até a resposta terminar.
      let settle!: (value: unknown) => void;
      let fail!: (e: unknown) => void;
      const outcome = new Promise<unknown>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      void getTracing()
        .withSpan(
          "http.request",
          { "http.method": req.method ?? "", "http.route": req.route?.path ?? path },
          async (span) => {
            let failure: { error: unknown } | undefined;
            try {
              settle(await lastValueFrom(next.handle(), { defaultValue: undefined }));
            } catch (e) {
              failure = { error: e };
              fail(e);
            }
            await new Promise<void>((resolve) => {
              const done = (): void => {
                if (res.statusCode !== undefined) span.setAttribute("http.status_code", res.statusCode);
                resolve();
              };
              res.once("finish", done);
              res.once("close", done);
            });
            if (failure) throw failure.error;
          },
        )
        .catch(() => undefined);
      return from(outcome);
    });
  }
}
