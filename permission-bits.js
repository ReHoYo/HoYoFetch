// Shared helpers for Stoat's numeric permission bitfields. JavaScript's
// bitwise operators truncate values to 32 bits, while Stoat permissions use
// safe integers up to bit 52, so all mutations happen as BigInt values.

export const PERMISSION_BITS = Object.freeze({
  ManagePermissions: 1n << 2n,
  BanMembers: 1n << 7n,
  ViewChannel: 1n << 20n,
  SendMessage: 1n << 22n,
  ManageMessages: 1n << 23n,
});

export function toPermissionBits(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed : null;
  }
  return null;
}

export function hasPermission(bits, permission) {
  return (bits & permission) === permission;
}

export function removePermission(bits, permission) {
  return bits & ~permission;
}

export function addPermission(bits, permission) {
  return bits | permission;
}

export function permissionBitsToNumber(bits) {
  const parsed = toPermissionBits(bits);
  if (parsed === null) return null;
  const value = Number(parsed);
  return Number.isSafeInteger(value) ? value : null;
}
