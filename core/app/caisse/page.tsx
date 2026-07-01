import { requireStaff } from "@/lib/guards";
import { withTenant } from "@/lib/tenant";
import { currentSession } from "@/lib/caisse";
import { fetchCatalog } from "@/lib/catalog";
import CaisseView, { type SessionDTO, type CatalogDTO, type RecentSaleDTO } from "./CaisseView";

export const dynamic = "force-dynamic";

export default async function Caisse() {
  const { tenant } = await requireStaff("/caisse");

  const [session, catalog, recent] = await Promise.all([
    currentSession(tenant.id),
    fetchCatalog(tenant.id),
    withTenant(tenant.id, (tx) =>
      tx.sale.findMany({
        where: { tenantId: tenant.id, status: "PAID" },
        include: { payments: { select: { method: true, amountXpf: true } } },
        orderBy: { paidAt: "desc" },
        take: 10,
      }),
    ),
  ]);

  const sessionDto: SessionDTO | null = session
    ? {
        id: session.id,
        openingFloatXpf: Number(session.openingFloatXpf),
        openedAt: session.openedAt.toISOString(),
      }
    : null;

  const catalogDto: CatalogDTO[] = catalog.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    priceXpf: p.priceXpf,
    qtyOnHand: p.qtyOnHand,
  }));

  const recentDto: RecentSaleDTO[] = recent.map((s) => ({
    id: s.id,
    clientName: s.clientName,
    totalXpf: Number(s.totalXpf),
    invoiceNumber: s.invoiceNumber,
    paidAt: s.paidAt ? s.paidAt.toISOString() : null,
    methods: Array.from(new Set(s.payments.map((p) => p.method))),
  }));

  return (
    <CaisseView
      tenantName={tenant.name}
      session={sessionDto}
      catalog={catalogDto}
      recent={recentDto}
    />
  );
}
