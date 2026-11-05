"use client";
import { BUYBACKS_LIVE } from "./phase";

/** Whether buybacks and $PXL payments are live. See lib/phase.ts. */
export const useBuybacksLive = () => BUYBACKS_LIVE;
