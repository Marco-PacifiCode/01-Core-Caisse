// Route handler minimal — requis par NextAuth pour la gestion des cookies de session.
// La connexion elle-même se fait sur core_auth (:3102).
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
