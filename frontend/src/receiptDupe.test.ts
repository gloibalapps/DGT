import assert from "node:assert/strict";
import test from "node:test";
import { batchAlreadySavedLine, looksAlreadySaved, possibleHint } from "./receiptDupe.ts";

test("batch summary counts strong and likely matches only", () => {
  assert.equal(batchAlreadySavedLine(["strong", "likely", "possible", null, "strong", null]), "3 of 6 look already saved");
  assert.equal(batchAlreadySavedLine(["possible", null]), null);
  assert.equal(batchAlreadySavedLine(["strong"]), null);
  assert.equal(looksAlreadySaved("possible"), false);
  assert.equal(looksAlreadySaved("likely"), true);
  assert.equal(possibleHint().includes("duplicate"), false);
});
