// Journal d'erreurs structuré — SOCLE OBSERVABILITÉ écosystème.
// Contrat : toute erreur attrapée passe par log.error AVANT tout fallback (return null/[]…).
// Les lignes partent sur stderr → log pm2 → détectées par logs-cron (mot-clé "ERROR")
// → table LogEvent (admin PacifiCode) → digest lu par la ronde. Un catch muet = bug invisible.

type Ctx = Record<string, unknown>

function describe(err: unknown): Ctx {
  if (err instanceof Error) {
    return {
      msg: err.message,
      name: err.name,
      // 3 premières frames utiles, aplaties (les stack multi-lignes sont filtrées par logs-cron)
      stack: err.stack?.split("\n").slice(1, 4).map(s => s.trim()).join(" <- "),
    }
  }
  return { msg: String(err) }
}

export const log = {
  /** Erreur réelle (visible du watchdog). scope = "module.operation", ex "auth.authorize". */
  error(scope: string, err: unknown, ctx?: Ctx): void {
    console.error(`[core-caisse] ERROR ${scope} ${JSON.stringify({ ...describe(err), ...ctx })}`)
  },
  /** Anomalie non bloquante mais suspecte. */
  warn(scope: string, ctx?: Ctx): void {
    console.warn(`[core-caisse] WARN ${scope} ${ctx ? JSON.stringify(ctx) : ""}`)
  },
}
