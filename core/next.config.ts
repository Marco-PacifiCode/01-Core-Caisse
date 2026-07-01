import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cohabitation par chemin sous un host unique : assets sous un préfixe distinct pour éviter la
  // collision /_next entre moteurs (cf. Core-Compta /_compta, Core-Stock /_stock).
  assetPrefix: "/_caisse",
};

export default nextConfig;
