import test from "node:test";
import assert from "node:assert/strict";
import {
  addPermission,
  hasPermission,
  permissionBitsToNumber,
  PERMISSION_BITS,
  removePermission,
  toPermissionBits,
} from "../permission-bits.js";

test("permission helpers preserve bits above JavaScript's 32-bit operators", () => {
  const highBit = 2n ** 48n;
  const lowBit = 2n ** 5n;
  const original = highBit | lowBit | PERMISSION_BITS.SendMessage;
  const locked = removePermission(original, PERMISSION_BITS.SendMessage);

  assert.equal(hasPermission(locked, PERMISSION_BITS.SendMessage), false);
  assert.equal(locked, highBit | lowBit);
  assert.equal(addPermission(locked, PERMISSION_BITS.SendMessage), original);
  assert.equal(toPermissionBits(permissionBitsToNumber(original)), original);
});

test("permission parsing rejects unsafe, negative, and malformed values", () => {
  assert.equal(toPermissionBits(-1), null);
  assert.equal(toPermissionBits(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(toPermissionBits("12.5"), null);
  assert.equal(toPermissionBits({}), null);
});
