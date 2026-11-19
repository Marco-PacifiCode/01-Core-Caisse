import assert from "node:assert/strict";
import * as modules from "node:module";
import { test } from "node:test";

const tenantId = "11111111-1111-4111-8111-111111111111";
const postesUrl = new URL("./postes.ts", import.meta.url).href;
const quotaUrl = new URL("./quota.ts", import.meta.url).href;
const fauxTenantUrl = "data:text/javascript,export const withTenant = (id, fn) => globalThis.__postesTestTransaction(id, fn)";
const fauxLogUrl = "data:text/javascript,export const log = { error() {} }";
const fauxQuotaUrl = "data:text/javascript," + encodeURIComponent(
  `export { decisionInscription, refusPostes } from ${JSON.stringify(quotaUrl)};
   export const lireDroit = async () => ({ niveau: 1, plafond: 1, quoi: "caisses" });`,
);
// Le runtime Node 22+ fournit ces hooks, absents des types Node 20 du projet.
type Resolve = (specifier: string, context: { parentURL?: string }) => { url: string; shortCircuit?: boolean };
const { registerHooks } = modules as typeof modules & {
  registerHooks(hooks: { resolve(...args: [...Parameters<Resolve>, Resolve]): ReturnType<Resolve> }): { deregister(): void };
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === postesUrl) {
      if (specifier === "./tenant") return { url: fauxTenantUrl, shortCircuit: true };
      if (specifier === "./log") return { url: fauxLogUrl, shortCircuit: true };
      if (specifier === "./quota") return { url: fauxQuotaUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const service = await import("./postes.ts");
hooks.deregister();

type Poste = { tenantId: string; posteId: string; caisse: string; actif: boolean };

test("le registre compte les caisses actives et accepte trois appareils sur la principale", async (t) => {
  const postes: Poste[] = [
    { tenantId, posteId: "tablette-1", caisse: "principale", actif: true },
    { tenantId, posteId: "inactive", caisse: "reserve", actif: false },
    { tenantId: "autre", posteId: "autre", caisse: "autre", actif: true },
  ];
  const trouve = ({ tenantId, posteId }: Pick<Poste, "tenantId" | "posteId">) =>
    postes.find((poste) => poste.tenantId === tenantId && poste.posteId === posteId);
  const tx = {
    $executeRaw: async () => {},
    cashSession: { findFirst: async () => null },
    sale: { findFirst: async () => null },
    poste: {
      findUnique: async ({ where }: { where: { tenantId_posteId: Parameters<typeof trouve>[0] } }) =>
        trouve(where.tenantId_posteId) ?? null,
      findMany: async ({ where }: { where: { tenantId: string } }) =>
        postes.filter((poste) => poste.tenantId === where.tenantId),
      groupBy: async ({ where }: { where: { tenantId: string; actif: boolean } }) => {
        const caisses = new Map<string, number>();
        for (const poste of postes) {
          if (poste.tenantId !== where.tenantId || poste.actif !== where.actif) continue;
          caisses.set(poste.caisse, (caisses.get(poste.caisse) ?? 0) + 1);
        }
        return Array.from(caisses, ([caisse, count]) => ({ caisse, _count: { _all: count } }));
      },
      upsert: async ({ create }: { create: Omit<Poste, "actif"> }) => {
        postes.push({ ...create, actif: true });
      },
      update: async () => assert.fail("le rattachement refusé ne doit rien modifier"),
    },
  };
  const contexte = globalThis as typeof globalThis & {
    __postesTestTransaction?: (id: string, fn: (transaction: typeof tx) => unknown) => unknown;
  };
  contexte.__postesTestTransaction = (id, fn) => {
    assert.equal(id, tenantId);
    return fn(tx);
  };
  t.after(() => {
    delete contexte.__postesTestTransaction;
  });

  for (const posteId of ["tablette-2", "tablette-3"]) {
    assert.deepEqual(await service.inscrirePosteEnLigne(tenantId, posteId), { ok: true, nouveau: true });
    const registre = await service.listerPostes(tenantId);
    assert.equal(registre.utilise, 1);
    assert.equal(registre.postes.find((poste) => poste.posteId === posteId)?.caisse, "principale");
  }
  const refus = await service.modifierPoste(tenantId, "tablette-2", { caisse: " seconde " });
  assert.ok(!refus.ok && "code" in refus);
  assert.equal(refus.code, "quota_atteint");
  assert.equal(refus.plafond, 1);
  assert.equal(refus.utilise, 1);
});
