import { NextRequest } from "next/server";
import { cashRead } from "@/lib/cash-shared-http";
import { listLegacyCashDays } from "@/lib/cash-days";

export function GET(req: NextRequest) { return cashRead(req, listLegacyCashDays); }
