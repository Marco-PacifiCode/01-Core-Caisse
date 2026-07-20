"use client"

// Filet ULTIME côté client (socle observabilité) : une erreur de rendu racine affiche
// un écran propre au lieu d'une page blanche, et se signale en console navigateur.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  console.error("[core-caisse] ERROR global-error", error.message, error.digest ?? "")
  return (
    <html lang="fr">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#1a1a1a", color: "#eee", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <p style={{ fontSize: 40, margin: 0 }}>🌺</p>
          <h1 style={{ fontSize: 20 }}>Une erreur est survenue</h1>
          <p style={{ opacity: 0.7 }}>L&apos;équipe est prévenue. Vous pouvez réessayer.</p>
          <button onClick={reset} style={{ padding: "8px 20px", borderRadius: 8, border: "1px solid #666", background: "transparent", color: "#eee", cursor: "pointer" }}>
            Réessayer
          </button>
        </div>
      </body>
    </html>
  )
}
