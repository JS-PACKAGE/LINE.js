import type { AuthState, Channel, Message, Profile } from "../model/dto.js";

export type ListenState = "starting" | "listening" | "reconnecting";

export type ServerFrame =
  | { type: "hello"; protocol: 1; serverVersion: string }
  | { type: "auth:state"; state: AuthState }
  | { type: "auth:qr"; url: string }
  | { type: "auth:pin"; code: string }
  | { type: "auth:ready"; profile: Profile }
  | { type: "channels"; channels: Channel[] }
  | { type: "message"; message: Message }
  | { type: "message:edit"; message: Message }
  | { type: "status"; state: ListenState }
  | { type: "error"; requestId?: string; code: string; message: string };

export type ClientFrame =
  | { type: "auth:start" }
  | { type: "channels:refresh" }
  | { type: "ping" };
