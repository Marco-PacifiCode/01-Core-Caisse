import type { Metadata } from "next";
import type { CSSProperties } from "react";
import "./globals.css";
import { resolveTenant } from "@/lib/tenant";
import { themeStyleVars } from "@/lib/theme";

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await resolveTenant();
  return {
    title: tenant?.name ? `Caisse — ${tenant.name}` : "Caisse",
    description: "Point de vente / tenue de caisse multi-tenant",
    robots: { index: false },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Charte du marchand appliquée par requête (cf. Core-Compta / Core-Stock).
  const tenant = await resolveTenant();
  const themeVars = themeStyleVars(tenant?.theme) as CSSProperties;

  return (
    <html lang="fr" style={themeVars}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Jost:wght@300;400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
