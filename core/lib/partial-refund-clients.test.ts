import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { comptaClient } from "./clients.ts";

test("client Compta: contrat total inchangé, champs partiels additifs et GET S2S", async () => {
  const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers["x-core-key"], "test-key");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      assert.equal(req.url, "/api/invoices/invoice?tenantId=tenant");
      res.end(JSON.stringify({ id: "invoice", lines: [] })); return;
    }
    assert.equal(req.url, "/api/invoices/invoice/credit-note");
    let raw = ""; for await (const part of req) raw += part;
    bodies.push(JSON.parse(raw));
    res.end(JSON.stringify({ creditNoteId: "cn", totalXpf: -100 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const previous = { url: process.env.CORE_COMPTA_URL, key: process.env.CORE_COMPTA_API_KEY, mock: process.env.CORE_CLIENTS_MOCK };
  process.env.CORE_COMPTA_URL = `http://127.0.0.1:${address.port}`;
  process.env.CORE_COMPTA_API_KEY = "test-key"; process.env.CORE_CLIENTS_MOCK = "0";
  try {
    const client = comptaClient();
    await client.creditNote({ tenantId: "tenant", invoiceId: "invoice", reason: "Retour" });
    await client.creditNote({ tenantId: "tenant", invoiceId: "invoice", reason: "Retour", amountXpf: 100, creditKey: "key-1" });
    await client.creditNote({ tenantId: "tenant", invoiceId: "invoice", reason: "Retour", lineIds: ["line-1"], creditKey: "key-2" });
    assert.deepEqual(bodies, [
      { tenantId: "tenant", reason: "Retour" },
      { tenantId: "tenant", reason: "Retour", amountXpf: 100, creditKey: "key-1" },
      { tenantId: "tenant", reason: "Retour", lineIds: ["line-1"], creditKey: "key-2" },
    ]);
    assert.equal((await client.invoiceDetail!("tenant", "invoice")).id, "invoice");
  } finally {
    for (const [name, value] of [["CORE_COMPTA_URL", previous.url], ["CORE_COMPTA_API_KEY", previous.key], ["CORE_CLIENTS_MOCK", previous.mock]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
