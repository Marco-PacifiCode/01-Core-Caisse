import Link from "next/link";

export const dynamic = "force-dynamic";

const coreAuthUrl = process.env.CORE_AUTH_URL ?? "http://localhost:3102";

/**
 * Stub de connexion — l'identité est externalisée à core_auth (:3102).
 * On redirige simplement l'utilisateur vers le formulaire de core_auth, qui émet le JWT partagé.
 */
export default async function Connexion({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = `${coreAuthUrl}/connexion?next=${encodeURIComponent(next ?? "/caisse")}`;

  return (
    <main className="page">
      <div className="wrap-narrow" style={{ paddingTop: 40 }}>
        <span className="label" style={{ display: "block", marginBottom: 10 }}>
          Core Caisse · connexion
        </span>
        <h1 className="title">Connexion staff</h1>
        <p className="subtitle">
          L&apos;authentification se fait sur le moteur d&apos;identité (core_auth).
        </p>
        <p style={{ marginTop: 20 }}>
          <Link className="btn" href={target}>
            Se connecter <span className="arr">→</span>
          </Link>
        </p>
      </div>
    </main>
  );
}
