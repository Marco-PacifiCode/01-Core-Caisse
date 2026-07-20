// Instrumentation Next — SOCLE OBSERVABILITÉ écosystème.
// - register() : filets process (unhandledRejection / uncaughtException) → stderr pm2.
// - onRequestError : TOUTE erreur serveur non catchée (RSC, route handler, server action)
//   est journalisée avec sa route — fini les erreurs invisibles côté serveur.
// Détection aval : logs-cron (mot-clé "ERROR") → LogEvent → digest ronde.

export function register(): void {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    process.on("unhandledRejection", (reason) => {
      console.error(`[core-caisse] ERROR unhandledRejection ${reason instanceof Error ? `${reason.message} <- ${reason.stack?.split("\n")[1]?.trim() ?? ""}` : String(reason)}`)
    })
    process.on("uncaughtException", (err) => {
      console.error(`[core-caisse] ERROR uncaughtException ${err.message} <- ${err.stack?.split("\n")[1]?.trim() ?? ""}`)
    })
  }
}

export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routeType: string },
): Promise<void> {
  const e = err instanceof Error ? { msg: err.message, stack: err.stack?.split("\n").slice(1, 3).map(s => s.trim()).join(" <- ") } : { msg: String(err) }
  console.error(`[core-caisse] ERROR request ${JSON.stringify({ method: request.method, path: request.path, kind: `${context.routerKind}/${context.routeType}`, ...e })}`)
}
