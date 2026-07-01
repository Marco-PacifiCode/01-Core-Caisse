import Link from "next/link";
import { resolveTenant, currentHost } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const coreAuthUrl = process.env.CORE_AUTH_URL ?? "http://localhost:3102";

export default async function Home() {
  const host = await currentHost();
  const tenant = await resolveTenant();

  return (
    <main className="page">
      <div className="wrap-narrow" style={{ paddingTop: 40 }}>
        <span className="label" style={{ display: "block", marginBottom: 10 }}>
          Core Caisse · point de vente multi-tenant
        </span>
        {tenant ? (
          <>
            <h1 className="title">{tenant.name}</h1>
            <p className="subtitle">
              Tenant résolu depuis le domaine <b>{host}</b> (slug <code>{tenant.slug}</code>).
            </p>
            <p style={{ marginTop: 20, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link className="btn" href="/caisse">
                Ouvrir la caisse <span className="arr">→</span>
              </Link>
              <Link className="btn ghost" href={`${coreAuthUrl}/connexion?next=/caisse`}>
                Connexion staff
              </Link>
            </p>
          </>
        ) : (
          <>
            <h1 className="title">Aucun marchand pour ce domaine</h1>
            <p className="subtitle">
              Le domaine <b>{host || "(inconnu)"}</b> n&apos;est rattaché à aucun tenant. En dev,
              assurez-vous que core_auth tourne sur <code>{coreAuthUrl}</code> et que le domaine est
              configuré dans core_auth.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
