import { BorshCoder, type Idl } from "@anchor-lang/core";
import idlJson from "./idl/pixel.json" with { type: "json" };

export type { Pixel } from "./idl/pixel.js";

/** Raw IDL (snake_case, as emitted by `anchor build`). */
export const IDL = idlJson as unknown as Idl;
export const coder = new BorshCoder(IDL);
