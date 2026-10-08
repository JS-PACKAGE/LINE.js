import type { MemberRole } from "../src/model/dto.js";

const SVG = "http://www.w3.org/2000/svg";

const BADGES: Record<MemberRole, { label: string; shapes: { d: string; stroke?: boolean }[] }> = {
  // Crown for the community owner/admin.
  admin: { label: "社群管理員", shapes: [{ d: "M2 12.5 1 4.5l4 3L8 2l3 5.5 4-3-1 8z" }] },
  // Shield with a check for co-admins.
  coAdmin: { label: "共同管理員", shapes: [{ d: "M8 1 14 3v5c0 3.4-2.5 5.9-6 7-3.5-1.1-6-3.6-6-7V3z" }, { d: "m5.2 8 2 2 3.6-4", stroke: true }] },
};

/** Small icon shown next to the name of a community manager. */
export function createRoleBadge(role: MemberRole): HTMLSpanElement {
  const { label, shapes } = BADGES[role];
  const badge = document.createElement("span");
  badge.className = "role-badge";
  badge.dataset.role = role;
  badge.title = label;
  badge.role = "img";
  badge.ariaLabel = label;
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  for (const shape of shapes) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", shape.d);
    if (shape.stroke) path.setAttribute("class", "check");
    icon.append(path);
  }
  badge.append(icon);
  return badge;
}
