import { NextRequest } from "next/server";
import { cashRead } from "@/lib/cash-shared-http";
import { listPendingLegacyClosures } from "@/lib/cash-days";

export function GET(req: NextRequest) { return cashRead(req, listPendingLegacyClosures); }
