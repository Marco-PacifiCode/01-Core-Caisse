"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import type { LineKind, PayMethod } from "@prisma/client";
import {
  openSessionAction,
  closeSessionAction,
  checkoutAction,
  type UiLine,
  type UiPayment,
  type ZReportResult,
} from "./actions";

export type SessionDTO = { id: string; openingFloatXpf: number; openedAt: string };
export type CatalogDTO = { id: string; name: string; sku: string | null; priceXpf: number; qtyOnHand: number };
export type RecentSaleDTO = {
  id: string;
  clientName: string | null;
  totalXpf: number;
  invoiceNumber: string | null;
  paidAt: string | null;
  methods: string[];
};

const fmt = (n: number) => n.toLocaleString("fr-FR") + " F";

type TicketLine = UiLine & { key: string };
type TicketPayment = UiPayment & { key: string };

const PAY_LABELS: Record<PayMethod, string> = {
  CASH: "Espèces",
  CARD: "Carte",
  TRANSFER: "Virement",
  CHEQUE: "Chèque",
  OTHER: "Autre",
};

export default function CaisseView({
  tenantName,
  session,
  catalog,
  recent,
}: {
  tenantName: string;
  session: SessionDTO | null;
  catalog: CatalogDTO[];
  recent: RecentSaleDTO[];
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Session
  const [floatXpf, setFloatXpf] = useState(0);
  const [counted, setCounted] = useState(0);
  const [zReport, setZReport] = useState<ZReportResult["report"] | null>(null);

  // Ticket
  const [lines, setLines] = useState<TicketLine[]>([]);
  const [clientName, setClientName] = useState("");

  // Ligne libre
  const [freeKind, setFreeKind] = useState<LineKind>("SERVICE");
  const [freeLabel, setFreeLabel] = useState("");
  const [freeQty, setFreeQty] = useState(1);
  const [freePrice, setFreePrice] = useState(0);

  // Paiements
  const [payments, setPayments] = useState<TicketPayment[]>([]);
  const [payMethod, setPayMethod] = useState<PayMethod>("CASH");
  const [payAmount, setPayAmount] = useState(0);
  const [payTendered, setPayTendered] = useState(0);
  const [lastReceipt, setLastReceipt] = useState<string | null>(null);

  const uid = () => Math.random().toString(36).slice(2);

  const total = useMemo(() => lines.reduce((t, l) => t + Math.round(l.unitXpf) * Math.trunc(l.qty), 0), [lines]);
  const paid = useMemo(() => payments.reduce((t, p) => t + Math.round(p.amountXpf), 0), [payments]);
  const remaining = Math.max(0, total - paid);
  const change = useMemo(() => {
    let tendered = 0;
    let amount = 0;
    for (const p of payments) {
      amount += Math.round(p.amountXpf);
      tendered += p.tenderedXpf !== undefined ? Math.round(p.tenderedXpf) : Math.round(p.amountXpf);
    }
    return Math.max(0, tendered - amount);
  }, [payments]);

  function addCatalogLine(p: CatalogDTO) {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === p.id);
      if (existing) {
        return prev.map((l) => (l.key === existing.key ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, { key: uid(), kind: "PRODUCT" as LineKind, label: p.name, productId: p.id, qty: 1, unitXpf: p.priceXpf }];
    });
  }

  function addFreeLine() {
    if (!freeLabel.trim() || freeQty <= 0) return;
    setLines((prev) => [
      ...prev,
      { key: uid(), kind: freeKind, label: freeLabel.trim(), productId: null, qty: Math.trunc(freeQty), unitXpf: Math.round(freePrice) },
    ]);
    setFreeLabel("");
    setFreeQty(1);
    setFreePrice(0);
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function addPayment() {
    const amount = payAmount > 0 ? payAmount : remaining;
    if (amount <= 0) return;
    setPayments((prev) => [
      ...prev,
      {
        key: uid(),
        method: payMethod,
        amountXpf: Math.round(amount),
        tenderedXpf: payMethod === "CASH" && payTendered > 0 ? Math.round(payTendered) : undefined,
      },
    ]);
    setPayAmount(0);
    setPayTendered(0);
  }

  function removePayment(key: string) {
    setPayments((prev) => prev.filter((p) => p.key !== key));
  }

  function resetTicket() {
    setLines([]);
    setPayments([]);
    setClientName("");
  }

  function doCheckout() {
    setErr(null);
    setOk(null);
    setLastReceipt(null);
    start(async () => {
      const res = await checkoutAction(
        session?.id ?? null,
        lines.map(({ key: _key, ...l }) => l),
        payments.map(({ key: _key, ...p }) => p),
        clientName || undefined,
      );
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      setOk(
        `Encaissé — ${res.invoiceNumber ?? "facture créée"} · payé ${fmt(res.paidXpf)}` +
          (res.changeXpf > 0 ? ` · rendu ${fmt(res.changeXpf)}` : ""),
      );
      setLastReceipt(res.receiptUrl);
      resetTicket();
    });
  }

  function doOpenSession() {
    setErr(null);
    start(async () => {
      const e = await openSessionAction(floatXpf);
      if (e) setErr(e);
      else setFloatXpf(0);
    });
  }

  function doCloseSession() {
    if (!session) return;
    setErr(null);
    setZReport(null);
    start(async () => {
      const res = await closeSessionAction(session.id, counted);
      if (!res.ok) setErr(res.error ?? "Erreur.");
      else setZReport(res.report ?? null);
    });
  }

  return (
    <main className="page">
      <div className="wrap">
        <div className="crumb">
          <Link href="/">Accueil</Link> <span>/</span> <span>Caisse</span>
        </div>
        <div className="page-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
          <div>
            <span className="label">Core Caisse · {tenantName}</span>
            <h1 className="title">Caisse</h1>
          </div>
          <div>
            {session ? (
              <span className="badge done">Session ouverte · fond {fmt(session.openingFloatXpf)}</span>
            ) : (
              <span className="badge warn">Aucune session ouverte</span>
            )}
          </div>
        </div>

        {err && <div className="err">{err}</div>}
        {ok && <div className="ok">{ok}{lastReceipt ? <> · <a href={lastReceipt} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Imprimer le reçu</a></> : null}</div>}

        {/* Gestion de session */}
        <div className="card" style={{ marginBottom: 26 }}>
          <h2 style={{ fontSize: 22, marginBottom: 14 }}>Session de caisse</h2>
          {!session ? (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Fond de caisse (F)</label>
                <input type="number" value={floatXpf} onChange={(e) => setFloatXpf(Number(e.target.value))} />
              </div>
              <button className="btn" onClick={doOpenSession} disabled={pending}>Ouvrir la session</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Espèces comptées à la clôture (F)</label>
                <input type="number" value={counted} onChange={(e) => setCounted(Number(e.target.value))} />
              </div>
              <button className="btn ghost" onClick={doCloseSession} disabled={pending}>Clôture Z</button>
            </div>
          )}
          {zReport && (
            <div className="card" style={{ marginTop: 16, background: "var(--cream)" }}>
              <h3 style={{ fontSize: 18, marginBottom: 8 }}>Rapport Z</h3>
              <div className="total-line"><span>Fond de caisse</span><span className="money">{fmt(zReport.openingFloatXpf)}</span></div>
              <div className="total-line"><span>Encaissements espèces</span><span className="money">{fmt(zReport.cashSalesXpf)}</span></div>
              <div className="total-line"><span>Attendu en caisse</span><span className="money">{fmt(zReport.expectedXpf)}</span></div>
              <div className="total-line"><span>Compté</span><span className="money">{fmt(zReport.countedXpf)}</span></div>
              <div className="total-line grand">
                <span>Écart</span>
                <span className="money" style={{ color: zReport.varianceXpf === 0 ? "var(--ok)" : "var(--danger)" }}>
                  {zReport.varianceXpf > 0 ? "+" : ""}{fmt(zReport.varianceXpf)}
                </span>
              </div>
              <div style={{ marginTop: 8, fontSize: 15, color: "var(--muted)" }}>
                {zReport.salesCount} ventes · CA {fmt(zReport.totalSalesXpf)}
              </div>
            </div>
          )}
        </div>

        <div className="grid cols-2">
          {/* Colonne gauche : composition */}
          <div>
            {/* Catalogue */}
            <div className="card" style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, marginBottom: 12 }}>Catalogue produits</h2>
              {catalog.length === 0 ? (
                <p style={{ color: "var(--muted)", fontStyle: "italic", fontSize: 16 }}>
                  Catalogue indisponible (Core-Stock non joint ou mode mock). Utilisez la saisie libre ci-dessous.
                </p>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {catalog.map((p) => (
                    <button key={p.id} className="btn ghost sm" onClick={() => addCatalogLine(p)} disabled={pending}>
                      {p.name} · {fmt(p.priceXpf)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Saisie libre */}
            <div className="card">
              <h2 style={{ fontSize: 20, marginBottom: 12 }}>Ligne libre (prestation / divers)</h2>
              <div className="row3">
                <div className="field">
                  <label>Type</label>
                  <select value={freeKind} onChange={(e) => setFreeKind(e.target.value as LineKind)}>
                    <option value="SERVICE">Prestation</option>
                    <option value="OTHER">Divers</option>
                    <option value="PRODUCT">Produit (sans stock)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Quantité</label>
                  <input type="number" value={freeQty} onChange={(e) => setFreeQty(Number(e.target.value))} />
                </div>
                <div className="field">
                  <label>Prix unitaire (F)</label>
                  <input type="number" value={freePrice} onChange={(e) => setFreePrice(Number(e.target.value))} />
                </div>
              </div>
              <div className="field">
                <label>Libellé</label>
                <input value={freeLabel} onChange={(e) => setFreeLabel(e.target.value)} placeholder="Ex : Soin visage" />
              </div>
              <button className="btn sm" onClick={addFreeLine} disabled={pending || !freeLabel.trim()}>Ajouter au ticket</button>
            </div>
          </div>

          {/* Colonne droite : ticket + encaissement */}
          <div>
            <div className="card" style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, marginBottom: 12 }}>Ticket</h2>
              <div className="field">
                <label>Client (optionnel)</label>
                <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
              </div>
              {lines.length === 0 ? (
                <p style={{ color: "var(--muted)", fontStyle: "italic", fontSize: 16 }}>Ticket vide.</p>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr><th>Article</th><th className="num">Qté</th><th className="num">PU</th><th className="num">Total</th><th></th></tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.key}>
                        <td>{l.label}{l.kind !== "PRODUCT" ? <span style={{ color: "var(--muted)" }}> · {l.kind === "SERVICE" ? "presta" : "divers"}</span> : null}</td>
                        <td className="num">{l.qty}</td>
                        <td className="num">{fmt(l.unitXpf)}</td>
                        <td className="num">{fmt(l.unitXpf * l.qty)}</td>
                        <td className="num"><button className="btn ghost sm" onClick={() => removeLine(l.key)}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="total-line grand"><span>Total</span><span className="money">{fmt(total)}</span></div>
            </div>

            <div className="card">
              <h2 style={{ fontSize: 20, marginBottom: 12 }}>Encaissement</h2>
              <div className="row3">
                <div className="field">
                  <label>Moyen</label>
                  <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as PayMethod)}>
                    {(Object.keys(PAY_LABELS) as PayMethod[]).map((m) => (
                      <option key={m} value={m}>{PAY_LABELS[m]}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Montant (vide = reste {fmt(remaining)})</label>
                  <input type="number" value={payAmount || ""} onChange={(e) => setPayAmount(Number(e.target.value))} />
                </div>
                <div className="field">
                  <label>Reçu (espèces)</label>
                  <input type="number" value={payTendered || ""} onChange={(e) => setPayTendered(Number(e.target.value))} disabled={payMethod !== "CASH"} />
                </div>
              </div>
              <button className="btn sm" onClick={addPayment} disabled={pending || total === 0}>Ajouter le paiement</button>

              {payments.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  {payments.map((p) => (
                    <div className="total-line" key={p.key}>
                      <span>{PAY_LABELS[p.method]}{p.tenderedXpf ? ` (reçu ${fmt(p.tenderedXpf)})` : ""}</span>
                      <span className="money">
                        {fmt(p.amountXpf)}
                        <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={() => removePayment(p.key)}>✕</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="total-line" style={{ marginTop: 10 }}><span>Payé</span><span className="money">{fmt(paid)}</span></div>
              <div className="total-line"><span>Reste</span><span className="money">{fmt(remaining)}</span></div>
              {change > 0 && <div className="total-line"><span>Rendu monnaie</span><span className="money change">{fmt(change)}</span></div>}

              <button
                className="btn lg"
                style={{ marginTop: 16, width: "100%" }}
                onClick={doCheckout}
                disabled={pending || total === 0 || paid < total}
              >
                Valider l&apos;encaissement
              </button>
            </div>
          </div>
        </div>

        {/* Historique récent */}
        <div className="section">
          <h2>Dernières ventes</h2>
          <div className="card" style={{ padding: "8px 12px" }}>
            <table className="tbl">
              <thead>
                <tr><th>Facture</th><th>Client</th><th>Moyens</th><th className="num">Total</th><th>Quand</th></tr>
              </thead>
              <tbody>
                {recent.length === 0 && (
                  <tr><td colSpan={5} style={{ color: "var(--muted)", fontStyle: "italic" }}>Aucune vente encore.</td></tr>
                )}
                {recent.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.invoiceNumber ?? "—"}</td>
                    <td>{s.clientName ?? "—"}</td>
                    <td>{s.methods.map((m) => PAY_LABELS[m as PayMethod] ?? m).join(", ")}</td>
                    <td className="num">{fmt(s.totalXpf)}</td>
                    <td style={{ color: "var(--muted)", fontSize: 15 }}>{s.paidAt ? new Date(s.paidAt).toLocaleString("fr-FR") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
