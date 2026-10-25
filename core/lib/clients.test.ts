// Tests des clients S2S sortants (lib/clients.ts) — timeouts et erreurs DISTINGUABLES.
// Un vrai serveur HTTP local simule : cible muette (timeout), port fermé (network), réponse 4xx (http).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { comptaClient, CoreClientError, type CreateInvoiceInput } from "./clients.ts";

// Mode RÉEL (pas mock) + timeout court pour des tests rapides.
process.env.CORE_CLIENTS_MOCK = "";
process.env.CORE_CLIENT_TIMEOUT_MS = "200";

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

const input: CreateInvoiceInput = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  sourceType: "caisse",
  sourceId: "sale-1",
  lines: [{ label: "Test", qty: 1, unitXpf: 1000 }],
};

test("cible muette → CoreClientError kind=timeout, status=0 (l'encaissement ne gèle jamais)", async () => {
  const silent = createServer(() => {
    /* ne répond JAMAIS */
  });
  const port = await listen(silent);
  process.env.CORE_COMPTA_URL = `http://127.0.0.1:${port}`;

  const err = await comptaClient()
    .createInvoice(input)
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof CoreClientError);
  assert.equal(err.kind, "timeout");
  assert.equal(err.status, 0);
  assert.equal(err.core, "compta");
  assert.equal(err.op, "createInvoice");
  assert.match(err.detail, /200 ms/);
});

test("port fermé → CoreClientError kind=network, status=0", async () => {
  // Ouvre puis ferme un port : plus personne n'écoute → connexion refusée.
  const tmp = createServer(() => {});
  const port = await listen(tmp);
  await new Promise((r) => tmp.close(r));
  process.env.CORE_COMPTA_URL = `http://127.0.0.1:${port}`;

  const err = await comptaClient()
    .createInvoice(input)
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof CoreClientError);
  assert.equal(err.kind, "network");
  assert.equal(err.status, 0);
});

test("réponse non-2xx → CoreClientError kind=http avec status + corps", async () => {
  const conflict = createServer((_req, res) => {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "INSUFFICIENT_STOCK" }));
  });
  const port = await listen(conflict);
  process.env.CORE_COMPTA_URL = `http://127.0.0.1:${port}`;

  const err = await comptaClient()
    .createInvoice(input)
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof CoreClientError);
  assert.equal(err.kind, "http");
  assert.equal(err.status, 409);
  assert.match(err.detail, /INSUFFICIENT_STOCK/);
});

test("réponse 2xx → résultat parsé (chemin nominal HTTP réel)", async () => {
  const okServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ invoiceId: "inv-9", number: "FAC-9", totalXpf: 1000, alreadyExisted: false }));
  });
  const port = await listen(okServer);
  process.env.CORE_COMPTA_URL = `http://127.0.0.1:${port}`;

  const res = await comptaClient().createInvoice(input);
  assert.equal(res.invoiceId, "inv-9");
  assert.equal(res.alreadyExisted, false);
});

test("stock HTTP : allowNegative transmis seulement quand fourni", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    assert.equal(req.url, "/api/movements");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, movementId: "mv-test", productId: "product-test", qtyOnHand: -2, alreadyExisted: false }));
  });
  process.env.CORE_STOCK_URL = `http://127.0.0.1:${await listen(server)}`;
  const { stockClient } = await import("./clients.ts");
  const movement = { tenantId: input.tenantId, productId: "product-test", qty: 2, sourceType: "caisse", sourceId: "sale-http" };
  await stockClient().recordSale(movement);
  await stockClient().recordSale({ ...movement, allowNegative: true });
  await stockClient().recordSale({ ...movement, allowNegative: false });
  assert.deepEqual(bodies[0], { ...movement, type: "SALE" });
  assert.deepEqual(bodies[1], { ...movement, type: "SALE", allowNegative: true });
  assert.deepEqual(bodies[2], { ...movement, type: "SALE", allowNegative: false });
});

test("stock simulé : défaut inchangé, opt-in négatif et rejeu idempotent", async () => {
  const { stockClient } = await import("./clients.ts");
  process.env.CORE_CLIENTS_MOCK = "1";
  try {
    const movement = { tenantId: input.tenantId, productId: "product-test", qty: 2, sourceType: "caisse", sourceId: "sale-mock" };
    assert.equal((await stockClient().recordSale(movement)).qtyOnHand, 0);
    const negative = { ...movement, sourceId: "sale-mock-negative", allowNegative: true };
    const first = await stockClient().recordSale(negative);
    assert.equal(first.qtyOnHand, -2);
    const replay = await stockClient().recordSale(negative);
    assert.equal(replay.alreadyExisted, true); assert.equal(replay.movementId, first.movementId);
    assert.equal(replay.qtyOnHand, -2);
  } finally { process.env.CORE_CLIENTS_MOCK = ""; }
});
