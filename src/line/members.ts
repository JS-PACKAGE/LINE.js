import type { MemberRole } from "../model/dto.js";

/** Square member role as LINE reports it (names or numbers); only managers get a badge. */
export function memberRole(role: unknown): MemberRole | undefined {
  if (role === "ADMIN" || role === 1) return "admin";
  if (role === "CO_ADMIN" || role === 2) return "coAdmin";
  return undefined;
}
