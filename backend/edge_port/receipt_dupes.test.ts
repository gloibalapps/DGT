import assert from "node:assert/strict";
import test from "node:test";
import { ahashLuma, backfillDocuments, dhashLuma, matchExpense, planPaidScan } from "./receipt_dupes.ts";

test("pixel hashes match the Python golden grid", () => {
  const luma: number[] = [];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) luma.push((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 255 : 0);
  assert.equal(dhashLuma(luma, 32, 32), "b54ab54ab54ab54a");
  assert.equal(ahashLuma(luma, 32, 32), "aa55aa55aa55aa55");
});

test("edge port applies the same match rules", async () => {
  const fuel = { id: "a", date: "2026-04-02", amount: 63.4, category: "fuel", merchant: "Northside Servo", liters: 42.1, pump: "4", txn_time: "07:10" };
  assert.equal(matchExpense({ ...fuel, id: "b", txn_time: "07:28" }, [fuel]).level, null);
  assert.equal(matchExpense({ ...fuel, id: "c", txn_time: "07:14", liters: 51.8 }, [fuel]).level, null);
  assert.equal(matchExpense({ ...fuel, id: "d", txn_time: "07:14" }, [fuel]).level, "likely");

  const inv = { id: "i1", date: "2026-03-01", amount: 88, merchant: "Harbour Tools", category: "vehicle", receipt_number: "FICT-10042", abn: "00 000 000 001" };
  assert.equal(matchExpense({ ...inv, id: "i2", merchant: "Elsewhere" }, [inv]).reason, "receipt_abn");

  const cafe = { id: "c1", date: "2026-05-11", amount: 18.5, merchant: "Harbour Cafe", category: "other", txn_time: "12:00", card_last4: "4242" };
  assert.equal(matchExpense({ ...cafe, id: "c2", txn_time: "12:40" }, [cafe]).reason, "amount_date_merchant_card");
  assert.equal(matchExpense({ ...cafe, id: "c3", date: "2026-05-12", txn_time: null, card_last4: null }, [cafe]).level, "possible");
  assert.equal(matchExpense({ id: "m", category: "other" }, [{ id: "n", category: "other" }]).skipped, true);
  assert.equal(matchExpense({ ...cafe, id: "r", amount: -18.5 }, [cafe]).reason, "refund");
  assert.equal(matchExpense({ ...inv, id: "k" }, [inv], ["i1"]).level, null);

  const bytes = new Uint8Array([9, 8, 7, 6]);
  const saved = { id: "img", image_sha256: "c797e38c7d3b30c1ad0e2c1b6e53f0e7a5c0e5a5e5c0a5e5e5c0a5e5e5c0a5e5" };
  // The exact-file plan hashes the bytes, so a made-up stored hash must not skip.
  const miss = await planPaidScan(bytes, [saved]);
  assert.equal(miss.skip, false);
  const hit = await planPaidScan(bytes, [{ id: "img", image_sha256: miss.image_sha256, amount: 10, date: "2026-01-01", merchant: "Example Mart", category: "other" }]);
  assert.equal(hit.skip, true);
  assert.equal(hit.duplicate.reason, "exact_image");

  const original = { id: "old", receipt_image: "abc", amount: 19.95, date: "2026-02-02", merchant: "Example Mart" };
  const first = backfillDocuments([original, { id: "plain", amount: 1 }]);
  assert.equal(first.updated, 1);
  assert.equal(first.documents[0].amount_cents, 1995);
  const second = backfillDocuments(first.documents);
  assert.equal(second.updated, 0);
});
