#!/usr/bin/env bash
# Parcours temoin de core-caisse. Le moteur de deploiement le joue SUR LE VPS juste apres la bascule
# (contrat : 00-Archi-NextGen/_routine/deploy/README.md, section « Parcours temoin »). Rouge = retour
# arriere automatique. Deux passages, sur des tenants de DEMONSTRATION uniquement :
#  1. mode classique (sessions), salondemo : prestation encaissee puis annulee avec avoir ; produit
#     encaisse, stock decremente (jamais annule : une vente qui a decremente le stock est refusee
#     en STOCK_DECREMENTED, elle reste PAID sur la demo) ;
#  2. mode journee de caisse (Rotisserie et futures caisses), caissedemo : ouverture, reouverture ou
#     reprise de la journee, vente produit encaissee, prestation encaissee puis annulee avec avoir,
#     cloture a ecart nul (00-Archi-NextGen/vps/tenants/caissedemo-seeds/README.md).
# Chaque passage vend une unite de produit jamais rendue : avant chaque vente produit, le stock de demo
# sous SEUIL est remonte a CIBLE par une entree IN Core-Stock idempotente (sourceType temoin-reassort).
# Idempotent par TEMOIN_ID : identifiants, cles d'action et dates en derivent, un rejeu ne cree aucune
# vente. Si la journee etait deja close, un rejeu la rouvre puis la referme sans vente (un Z vide).
# La cle de service est LUE dans TEMOIN_ENV_FILE, jamais affichee (ni dans la sortie, ni dans `ps`).
# Derniere ligne : « TEMOIN=OK <resume> » (code 0) ou « TEMOIN=KO <raison> » (code 1).
set -u
: "${TEMOIN_URL:?}" "${TEMOIN_ID:?}" "${TEMOIN_ENV_FILE:?}"
export TEMOIN_URL TEMOIN_ID TEMOIN_ENV_FILE
exec python3 - <<'PY'
import json, os, re, sys, time, uuid, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

URL = os.environ["TEMOIN_URL"].rstrip("/")
ID = os.environ["TEMOIN_ID"]
DEBUT = time.monotonic()
BUDGET = 80                                   # secondes ; le moteur coupe a TEMOIN_DELAI (90 par defaut)
NS = uuid.UUID("6f1c2d6e-7a51-4c1e-9d0b-5c3a0e7d7e11")   # espace FIXE des UUID v5 du temoin

def u(etape):
    return str(uuid.uuid5(NS, f"{ID}:{etape}"))

# TEMOIN_ID = <cible>-<sha>-<AAAAMMJJhhmmss>[-retour] : la date en derive, stable d'un rejeu a l'autre
# (le moteur compare le corps entier d'une action rejouee : une date qui bouge = ACTION_ID_CONFLICT).
m = re.search(r"-(\d{14})(?:-|$)", ID)
QUAND = datetime.strptime(m.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc) if m else datetime.now(timezone.utc)
ISO = QUAND.isoformat(timespec="milliseconds").replace("+00:00", "Z")
JOUR = (QUAND + timedelta(hours=11)).strftime("%Y-%m-%d")   # jour metier Noumea (UTC+11, sans heure d'ete)

def lire_env(nom):
    try:
        with open(os.environ["TEMOIN_ENV_FILE"], encoding="utf-8") as f:
            for ligne in f:
                if ligne.startswith(nom + "="):
                    return ligne.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""

CLE = lire_env("CORE_CAISSE_API_KEY")
STOCK_URL = lire_env("CORE_STOCK_URL").rstrip("/")   # Core-Stock, joint par core-caisse depuis le VPS
STOCK_CLE = lire_env("CORE_STOCK_API_KEY")
SECOURS = []   # (nom, action) : nettoyage si le parcours casse au milieu, rien ne doit rester ouvert

def appel(methode, chemin, corps=None, idem=None, base=None, cle=None):
    reste = BUDGET - (time.monotonic() - DEBUT)
    if reste < 2:
        return 0, {"error": "DELAI_DEPASSE"}
    entetes = {"Content-Type": "application/json", "X-Core-Key": CLE if cle is None else cle}
    if idem:
        entetes["Idempotency-Key"] = idem
    data = json.dumps(corps).encode() if corps is not None else None
    req = urllib.request.Request((base or URL) + chemin, data=data, method=methode, headers=entetes)
    try:
        with urllib.request.urlopen(req, timeout=min(20, reste)) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": type(e).__name__}

def ko(raison, detail=None):
    for nom, action in reversed(SECOURS):
        try:
            print(f"secours : {nom} -> {action()}")
        except Exception as e:
            print(f"secours : {nom} -> echec {type(e).__name__}")
    extrait = "" if detail is None else " : " + json.dumps(detail, ensure_ascii=False)[:180]
    print(f"TEMOIN=KO {raison}{extrait}")
    sys.exit(1)

def donnees(r):
    return r.get("data", r) if isinstance(r, dict) else {}

# Reassort du stock de DEMONSTRATION. La vente produit n'est jamais annulee (STOCK_DECREMENTED) : sans
# reassort, le stock seme tombe a 0 et le temoin passe au rouge sur INSUFFICIENT_STOCK, ancienne version
# comprise (vecu le 19/10, Dissolvant de salondemo). Sous SEUIL, une entree IN remonte le produit a CIBLE
# AVANT la vente : la preuve « stock decremente » reste entiere. Rejeu du meme TEMOIN_ID = aucun doublon
# (Core-Stock deduplique sur sourceType + sourceId + sourceLineKey, index uniq_source_line).
SEUIL, CIBLE = 5, 60

def reassortir(tenant, produit, nom):
    if not (STOCK_URL and STOCK_CLE):
        print(f"{nom} : reassort saute, CORE_STOCK_URL ou CORE_STOCK_API_KEY absente de TEMOIN_ENV_FILE")
        return
    s, r = appel("GET", f"/api/stock/levels?tenantId={tenant}&productIds={produit}", base=STOCK_URL, cle=STOCK_CLE)
    niveaux = r.get("levels") if s == 200 and isinstance(r, dict) else None
    q = niveaux[0].get("qtyOnHand") if niveaux and isinstance(niveaux[0], dict) else None
    if isinstance(q, bool) or not isinstance(q, (int, float)):
        print(f"{nom} : reassort saute, lecture du stock HTTP {s}")
        return
    if q >= SEUIL:
        return
    s, r = appel("POST", "/api/movements", {"tenantId": tenant, "productId": produit, "type": "IN", "qty": CIBLE - q,
                 "reason": "Reassort automatique du parcours temoin (demonstration)", "sourceType": "temoin-reassort",
                 "sourceId": f"{ID}-{nom}", "sourceLineKey": produit, "billable": False}, base=STOCK_URL, cle=STOCK_CLE)
    if s != 200 or not isinstance(r, dict) or not r.get("ok"):
        if q < 1:
            ko(f"{nom}, reassort du stock de demo ({q} en stock) : HTTP {s}", r)
        print(f"{nom} : reassort refuse (HTTP {s}), {q} en stock suffit pour ce passage")
        return
    deja = " (deja pose)" if r.get("alreadyExisted") else ""
    print(f"{nom} : stock de demo a {q}, reassort IN +{CIBLE - q}{deja} -> {r.get('qtyOnHand')}")

if not CLE:
    ko("CORE_CAISSE_API_KEY absente de TEMOIN_ENV_FILE")

# ─── 1. Mode classique : salondemo ────────────────────────────────────────────────────────────────
SALON = "d0000000-0000-4000-8000-0000000000de"
SESSION = "d0000000-0000-4000-8008-000000000001"      # session ouverte en permanence sur la demo
CAISSIER = "d0000000-0000-4000-8002-000000000001"
DISSOLVANT = "d0000000-0000-4000-8006-000000000003"   # « Dissolvant doux 500 ml », 1 200 F

def annuler_classique(vid, etape):
    return appel("POST", f"/api/sales/{vid}/void", {"tenantId": SALON, "reason": "Parcours temoin apres deploiement", "actionId": u(etape)})

def vente_classique(nom, ligne, prix):
    s, r = appel("POST", "/api/sales", {"tenantId": SALON, "cashierId": CAISSIER, "sessionId": SESSION, "clientName": "Parcours temoin",
                 "sourceType": "surface-caisse", "sourceId": f"{ID}-{nom}", "lines": [{**ligne, "qty": 1, "unitXpf": prix}]})
    vid = r.get("saleId") if isinstance(r, dict) else None
    if s not in (200, 201) or not vid:
        ko(f"salondemo, vente {nom} : HTTP {s}", r)
    deja = bool(r.get("alreadyExisted"))
    secours = (f"annulation de la vente {nom} {vid}", lambda: annuler_classique(vid, f"classique-{nom}-void")[0])
    SECOURS.append(secours)
    s, r = appel("POST", f"/api/sales/{vid}/checkout", {"tenantId": SALON, "payments": [{"method": "CASH", "amountXpf": prix, "tenderedXpf": prix}]})
    if deja and s == 409 and r.get("error") == "ALREADY_VOID":
        SECOURS.remove(secours)   # rejeu du meme TEMOIN_ID : vente deja encaissee puis annulee
        return vid, r
    if s != 200 or r.get("status") != "PAID":
        ko(f"salondemo, encaissement {nom} : HTTP {s}", r)
    SECOURS.remove(secours)   # encaissee : plus rien d'ouvert (la prestation est annulee juste apres)
    if r.get("syncPending"):
        ko(f"salondemo, encaissement {nom} : synchro Compta/Stock en attente", r.get("syncError"))
    return vid, r

vid, _ = vente_classique("prestation", {"kind": "SERVICE", "label": "Parcours temoin", "productId": None}, 100)
SECOURS.append(("annulation de la prestation", lambda: annuler_classique(vid, "classique-prestation-void")[0]))
s, r = annuler_classique(vid, "classique-prestation-void")
if s == 409:
    ko(f"salondemo, annulation : HTTP 409 {r.get('error')} juste apres un encaissement reussi (panne de Compta ou de Stock, pas de nouvel essai)", r)
if s != 200 or not r.get("ok") or not r.get("creditNoteId"):
    ko(f"salondemo, annulation : HTTP {s}", r)
SECOURS.pop()
print(f"salondemo : prestation {vid} encaissee puis annulee, avoir {r.get('creditNoteId')}")

reassortir(SALON, DISSOLVANT, "salondemo")
vid, r = vente_classique("produit", {"kind": "PRODUCT", "label": "Dissolvant doux 500 ml", "productId": DISSOLVANT}, 1200)
if r.get("stockDecremented") != 1:
    ko("salondemo, produit : stock non decremente", r)
print(f"salondemo : produit {vid} encaisse, stock decremente (vente laissee PAID sur la demo)")
CLASSIQUE = "salondemo vert"

# ─── 2. Mode journee de caisse : caissedemo ───────────────────────────────────────────────────────
T = "c0000000-0000-4000-8000-0000000000ca"
ACTEUR = "c0000000-0000-4000-8002-000000000001"
ARTICLE_A = "c0000000-0000-4000-8006-000000000001"     # « Article temoin A », 1 200 F
DEVICE, NOM_POSTE = "temoin", "Parcours temoin"

def action(etape, entite, **extra):
    a = u(etape)
    corps = {"tenantId": T, "actionId": a, "deviceId": DEVICE, "entityKey": entite, "occurredAt": ISO,
             "actorId": ACTEUR, "actorName": NOM_POSTE, "receivedById": ACTEUR, **extra}
    return corps, a

def poster(etape, chemin, entite, **extra):
    corps, a = action(etape, entite, **extra)
    return appel("POST", chemin, corps, a)

def attendu(jid):
    s, led = appel("GET", f"/api/cash-days/{jid}/ledger?tenantId={T}&afterSequence=0")
    val = str(((led.get("projection") or {}).get("totauxCourants") or {}).get("expectedXpf") or "") if isinstance(led, dict) else ""
    return val if re.fullmatch(r"-?\d+", val) else None

def cloturer(jid, cycle):
    att = attendu(jid)
    if att is None:
        return 0, {"error": "ATTENDU_INTROUVABLE"}, None
    corps, a = action(f"journee-close-{cycle}", jid, deviceName=NOM_POSTE, countedXpf=att, closureMode="ONLINE",
                      localExpectedXpf=att, localVarianceXpf="0", cycle=cycle)
    corps["sourceKey"] = a
    s, r = appel("POST", f"/api/cash-days/{jid}/close", corps, a)
    return s, r, att

s, r = appel("GET", f"/api/cash-days?tenantId={T}&businessDay={JOUR}")
if s != 200:
    ko(f"caissedemo, lecture de la journee {JOUR} : HTTP {s}", r)
jour = r.get("day")
if jour is None:
    cle_locale = f"temoin:{JOUR}"
    s, r = poster("journee-open", "/api/cash-days", cle_locale, businessDay=JOUR, sourceKey=cle_locale, localSessionKey=cle_locale,
                  openingFloatXpf="10000", deviceName=NOM_POSTE)
    if s != 200:
        ko("caissedemo, ouverture de la journee : HTTP {s}".format(s=s), r)
    jour = donnees(r); quoi = "ouverte"
elif jour.get("status") != "OPEN":
    jid = jour["cashDayId"]
    s, r = poster(f"journee-reopen-{jour.get('cycle', 0)}", f"/api/cash-days/{jid}/reopen", jid, administration=True)
    if s != 200:
        ko(f"caissedemo, reouverture de la journee : HTTP {s}", r)
    jour = donnees(r); quoi = "rouverte"
else:
    quoi = "reprise"
jid = jour.get("cashDayId")
if not jid:
    ko("caissedemo : journee sans identifiant", jour)

def secours_cloture():
    s, r = appel("GET", f"/api/cash-days?tenantId={T}&businessDay={JOUR}")
    etat = r.get("day") or {}
    if etat.get("status") != "OPEN":
        return "journee deja close"
    return cloturer(jid, etat.get("cycle", 0))[0]
SECOURS.append(("cloture de la journee", secours_cloture))

def vente_journee(nom, ligne, prix):
    source = u(f"journee-{nom}-source"); ticket = f"TEMOIN-{source[:8]}"
    s, r = poster(f"journee-{nom}-vente", f"/api/cash-days/{jid}/sales", source, deviceName=NOM_POSTE, ticketNumber=ticket,
                  sourceType="temoin", sourceId=source, totalXpf=str(prix),
                  lines=[{**ligne, "qty": 1, "unitXpf": str(prix), "lineXpf": str(prix)}])
    d = donnees(r); vid = d.get("saleId") or d.get("id")
    if s != 200 or not vid:
        ko(f"caissedemo, vente {nom} : HTTP {s}", r)
    if str(d.get("totalXpf")) != str(prix):
        ko(f"caissedemo, vente {nom} : total {d.get('totalXpf')} au lieu de {prix}", d)
    s, r = poster(f"journee-{nom}-checkout", f"/api/cash-days/{jid}/sales/{vid}/checkout", source, deviceName=NOM_POSTE,
                  ticketNumber=ticket, paidAt=ISO, payments=[{"method": "CASH", "amountXpf": str(prix), "tenderedXpf": str(prix)}])
    if s != 200 or donnees(r).get("status") not in ("PAID", None):
        ko(f"caissedemo, encaissement {nom} : HTTP {s}", r)
    return vid

reassortir(T, ARTICLE_A, "caissedemo")
vente_journee("produit", {"kind": "PRODUCT", "label": "Article temoin A", "productId": ARTICLE_A}, 1200)
vid = vente_journee("prestation", {"kind": "SERVICE", "label": "Prestation temoin", "productId": None}, 300)
s, r = poster("journee-prestation-void", f"/api/cash-days/{jid}/sales/{vid}/void", f"cash-days:{jid}:sales:{vid}:void",
              deviceName=NOM_POSTE, reason="Parcours temoin apres deploiement")
avoir = donnees(r).get("creditNoteId")
if s == 409:
    ko(f"caissedemo, annulation : HTTP 409 {donnees(r).get('error') or r.get('error')} juste apres un encaissement reussi (pas de nouvel essai)", r)
if s != 200 or not avoir:
    ko(f"caissedemo, annulation : HTTP {s}", r)

s, r = appel("GET", f"/api/cash-days?tenantId={T}&businessDay={JOUR}")
cycle = (r.get("day") or {}).get("cycle", 0) if isinstance(r, dict) else 0
s, r, att = cloturer(jid, cycle)
if s != 200:
    ko(f"caissedemo, cloture : HTTP {s}", r)
ecart = str((donnees(r).get("report") or {}).get("varianceXpf", "?"))
if ecart not in ("0", "?"):
    ko(f"caissedemo, cloture : ecart de caisse {ecart} F", donnees(r).get("report"))
SECOURS.pop()
print(f"caissedemo : journee {JOUR} {quoi}, produit encaisse, prestation annulee (avoir {avoir}), Z a {att} F, ecart {ecart}")
print(f"TEMOIN=OK {CLASSIQUE} ; caissedemo vert (journee {quoi}, Z ecart {ecart}) en {round(time.monotonic() - DEBUT)} s")
PY
