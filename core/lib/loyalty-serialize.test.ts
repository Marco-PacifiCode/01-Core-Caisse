import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeProgram } from "./loyalty-serialize.ts";

test("le montant bigint devient un nombre, et la réponse s'écrit en JSON", () => {
  const program = { mode: "VISITS", rewardAmountXpf: 1500n };
  const out = serializeProgram(program);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { mode: "VISITS", rewardAmountXpf: 1500 });
  assert.equal(program.rewardAmountXpf, 1500n);
});

test("null et zéro sont gardés", () => {
  assert.equal(serializeProgram({ rewardAmountXpf: null }).rewardAmountXpf, null);
  assert.equal(serializeProgram({ rewardAmountXpf: 0n }).rewardAmountXpf, 0);
});

test("le programme absent ({mode:OFF}) passe tel quel", () => {
  const off = { mode: "OFF" };
  assert.equal(serializeProgram(off), off);
});
