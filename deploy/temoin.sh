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
import json, os, re, sys, time, uuid, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

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
HORLOGE = None   # Date HTTP du Core ; aucune ouverture tardive sur une horloge locale seule

def appel(methode, chemin, corps=None, idem=None, base=None, cle=None, nettoyage=False):
    global HORLOGE
    reste = 3 if nettoyage else BUDGET - (time.monotonic() - DEBUT)
    if reste < 2:
        return 0, {"error": "DELAI_DEPASSE"}
    entetes = {"Content-Type": "application/json", "X-Core-Key": CLE if cle is None else cle}
    if idem:
        entetes["Idempotency-Key"] = idem
    data = json.dumps(corps).encode() if corps is not None else None
    req = urllib.request.Request((base or URL) + chemin, data=data, method=methode, headers=entetes)
    try:
        with urllib.request.urlopen(req, timeout=min(20, reste)) as r:
            if base is None and r.headers.get("Date"):
                HORLOGE = parsedate_to_datetime(r.headers["Date"])
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

# 3. Ouverture tardive directe (voie ii). La voie i demanderait une veille encore OPEN au jour
# serveur : impossible a fabriquer ici sans changer l'horloge ou la journee reelle de la demo.
# Premier jour libre entre J-6 et J-2. Une seule preuve par jour,
# independante du SHA/TEMOIN_ID : les livraisons suivantes relisent le Z, sans rouvrir ni revendre.
def temoin_to_close():
    s, settings = appel("GET", f"/api/cash-settings?tenantId={T}")
    if s != 200:
        ko(f"TO_CLOSE, reglages : HTTP {s}")
    if settings.get("toCloseEnabled") is not True:
        print("TO_CLOSE non joué (interrupteur éteint)")
        return "TO_CLOSE non joué (interrupteur éteint)"
    if HORLOGE is None or HORLOGE.utcoffset() is None:
        ko("TO_CLOSE, horloge serveur absente")
    serveur = HORLOGE.astimezone(timezone.utc)
    jour_serveur = (serveur + timedelta(hours=11)).date()
    if QUAND > serveur + timedelta(seconds=60):
        ko("TO_CLOSE, horloge future")
    device, auteur = "temoin-to-close", "Parcours temoin TO_CLOSE"
    jour = None
    def lire(chemin):
        s, r = appel("GET", chemin)
        if s != 200:
            ko(f"TO_CLOSE, lecture : HTTP {s}")
        return r
    legacy = lire(f"/api/cash-days/legacy?tenantId={T}&cursor={(jour_serveur - timedelta(days=7)).isoformat()}&limit=31")
    legacy_jours = legacy.get("days", [])
    legacy_occupes = {d.get("businessDay") for d in legacy_jours
                      if d.get("sessions") or d.get("origins") or d.get("salesWithoutSource", 0) > 0 or d.get("more")}
    for recul in range(6, 1, -1):
        fictif = jour_serveur - timedelta(days=recul)
        business = fictif.isoformat()
        if business in legacy_occupes:
            print(f"TO_CLOSE : {business} ancien usage manuel, saute (aucune ecriture)")
            continue
        query = f"/api/cash-days?tenantId={T}&businessDay={business}"
        s, r = appel("GET", query)
        if s != 200:
            ko(f"TO_CLOSE, recherche du jour libre : HTTP {s}")
        jour = r.get("day")
        if jour is None:
            break
        propre = jour.get("openedByName") == auteur and jour.get("openedBy") == ACTEUR
        if propre and jour.get("status") == "CLOSED" and jour.get("closedByName") != "Secours temoin TO_CLOSE":
            print(f"caissedemo TO_CLOSE : {business}, deja prouve (CLOSED, meme auteur)")
            jid_preuve = jour.get("cashDayId")
            if not jid_preuve:
                ko("TO_CLOSE, jour deja prouve sans identifiant")
            led_preuve = appel("GET", f"/api/cash-days/{jid_preuve}/ledger?tenantId={T}&afterSequence=0")
            if led_preuve[0] != 200:
                ko(f"TO_CLOSE, relecture du Z deja prouve : HTTP {led_preuve[0]}")
            data_preuve = led_preuve[1].get("data", [])
            ouverts_preuve = led_preuve[1].get("openings", [])
            if (led_preuve[1].get("hasMore") or len(ouverts_preuve) != 1
                    or any(o.get("actorId") != ACTEUR or o.get("actorName") != auteur
                           or o.get("deviceId") != device for o in ouverts_preuve)
                    or any(f.get("deviceId") not in ("core", device)
                           or f.get("kind") not in ("TO_CLOSE", "OPENING", "SALE_PAID", "SALE_VOID", "CLOSURE")
                           or (f.get("kind") == "SALE_PAID" and
                               ((f.get("snapshot") or {}).get("sellerId") != ACTEUR or
                                (f.get("snapshot") or {}).get("sellerName") != auteur))
                           for f in data_preuve)):
                print(f"TO_CLOSE : {business} utilisé manuellement, sauté (aucune écriture)")
                continue
            cl = [f for f in data_preuve if f.get("kind") == "CLOSURE"]
            ventes_preuve = [f for f in data_preuve if f.get("kind") == "SALE_PAID"]
            annulations_preuve = [f for f in data_preuve if f.get("kind") == "SALE_VOID"]
            report = ((cl[-1].get("snapshot") or {}).get("report") or {}) if cl else {}
            attendu_preuve = {"expectedXpf": "10000", "countedXpf": "10000", "varianceXpf": "0",
                              "totalSalesXpf": "0", "salesCount": "0", "cancelledCount": "1"}
            if (len(cl) != 1 or len(ventes_preuve) != 1 or len(annulations_preuve) != 1
                    or not (annulations_preuve[0].get("snapshot") or {}).get("creditNoteId")
                    or any(str(report.get(k)) != v for k, v in attendu_preuve.items())
                    or report.get("parTaux") != {}):
                ko("TO_CLOSE, Z deja prouve absent ou incorrect")
            return "TO_CLOSE vert (deja prouve, Z relu, ecart 0)"
        # Tout jour existant est occupé, même s'il s'agit d'un reste TO_CLOSE du témoin.
        print(f"TO_CLOSE : {business} occupe, saute (aucune ecriture)")
    else:
        print("TO_CLOSE non joué (aucun jour libre)")
        return "TO_CLOSE non joué (aucun jour libre)"
    ouverture = business + "T01:00:00.000Z"  # midi Noumea, toujours strictement avant le serveur
    fermeture = (fictif + timedelta(days=1)).isoformat() + "T01:00:00.000Z"
    def cle(etape):
        return str(uuid.uuid5(NS, f"to-close:{business}:{etape}"))
    def ecrire(etape, chemin, entite, at=ouverture, **extra):
        a = cle(etape)
        corps = {"tenantId": T, "actionId": a, "deviceId": device, "entityKey": entite,
                 "occurredAt": at, "actorId": ACTEUR, "actorName": auteur, "receivedById": ACTEUR,
                 "deviceName": auteur, **extra}
        s, r = appel("POST", chemin, corps, a)
        if s != 200:
            ko(f"TO_CLOSE, {etape} : HTTP {s}")
        return donnees(r)
    source = cle("open")
    def secours_tc():
        # Pas de ko/ecrire ici : un echec du secours doit garder le verdict KO initial.
        s, r = appel("GET", query, nettoyage=True)
        etat = r.get("day") or {}
        if s != 200:
            return f"lecture HTTP {s}"
        if etat.get("status") != "TO_CLOSE":
            return "journee deja close ou non TO_CLOSE"
        if etat.get("openedBy") != ACTEUR or etat.get("openedByName") != auteur:
            return "autre auteur, aucune ecriture"
        jid_sec = etat.get("cashDayId")
        s, led_sec = appel("GET", f"/api/cash-days/{jid_sec}/ledger?tenantId={T}&afterSequence=0", nettoyage=True)
        ouvertures = led_sec.get("openings", [])
        if s != 200 or len(ouvertures) != 1 or any(o.get("sourceKey") != source or o.get("deviceId") != device
                or o.get("actorId") != ACTEUR or o.get("actorName") != auteur for o in ouvertures):
            return "propriete non prouvee, aucune ecriture"
        if led_sec.get("hasMore") or any(f.get("kind") not in ("TO_CLOSE", "OPENING", "SALE_PAID", "SALE_VOID", "CLOSURE")
                or f.get("deviceId") != ("core" if f.get("kind") == "TO_CLOSE" else device)
                or (f.get("kind") == "SALE_PAID" and
                    ((f.get("snapshot") or {}).get("sellerId") != ACTEUR or
                     (f.get("snapshot") or {}).get("sellerName") != auteur))
                for f in led_sec.get("data", [])):
            return "usage concurrent, aucune ecriture"
        att = str(led_sec.get("projection", {}).get("totauxCourants", {}).get("expectedXpf"))
        if not re.fullmatch(r"-?\d+", att):
            return "attendu introuvable"
        a = cle("close-secours")
        corps = {"tenantId": T, "actionId": a, "deviceId": device, "entityKey": jid_sec,
                 "occurredAt": fermeture, "actorId": ACTEUR, "actorName": "Secours temoin TO_CLOSE", "receivedById": ACTEUR,
                 "deviceName": auteur, "sourceKey": a, "countedXpf": att, "closureMode": "ONLINE",
                 "localExpectedXpf": att, "localVarianceXpf": "0", "cycle": etat.get("cycle", 0)}
        return appel("POST", f"/api/cash-days/{jid_sec}/close", corps, a, nettoyage=True)[0]
    SECOURS.append((f"cloture TO_CLOSE {business}", secours_tc))
    if jour is None:
        jour = ecrire("open", "/api/cash-days", source, businessDay=business, sourceKey=source,
                      localSessionKey=source, openingFloatXpf="10000")
    jid_tc = jour.get("cashDayId")
    if not jid_tc or jour.get("status") not in ("TO_CLOSE", "CLOSED") or jour.get("cycle") != 0:
        ko("TO_CLOSE, statut ou cycle inattendu")
    ledger_url = f"/api/cash-days/{jid_tc}/ledger?tenantId={T}&afterSequence=0"
    led = lire(ledger_url)
    openings = led.get("openings", [])
    # Verifie toutes les ouvertures, pas seulement le nom courant ; jamais de reprise manuelle.
    if len(openings) != 1 or any(o.get("sourceKey") != source or o.get("deviceId") != device
                                or o.get("actorId") != ACTEUR or o.get("actorName") != auteur for o in openings):
        print(f"TO_CLOSE : {business} utilisé manuellement, sauté (aucune écriture)")
        return "TO_CLOSE non joué (jour occupé)"
    def faits(ledger):
        if ledger.get("hasMore"):
            return None
        return ledger.get("data", [])
    fs_led = faits(led)
    if fs_led is None:
        print(f"TO_CLOSE : {business} journal incomplet, sautÃ© (aucune Ã©criture)")
        return "TO_CLOSE non joué (journal incomplet)"
    if len([f for f in fs_led if f.get("kind") == "TO_CLOSE"]) != 1:
        ko("TO_CLOSE, evenement absent ou duplique")
    if any(f.get("kind") not in ("TO_CLOSE", "OPENING", "SALE_PAID", "SALE_VOID", "CLOSURE")
           or f.get("deviceId") != ("core" if f.get("kind") == "TO_CLOSE" else device)
           or (f.get("kind") == "SALE_PAID" and
               ((f.get("snapshot") or {}).get("sellerId") != ACTEUR or
                (f.get("snapshot") or {}).get("sellerName") != auteur)) for f in fs_led):
        print(f"TO_CLOSE : {business} utilisé manuellement, sauté (aucune écriture)")
        return "TO_CLOSE non joué (jour occupé)"
    # CashDeposit est lisible, pagine par receivedAt/id. Aucun payload ni autre tenant demande.
    cursor, conflits = None, []
    while True:
        chemin = f"/api/cash-deposits?tenantId={T}&status=APPLIED&limit=200"
        if cursor:
            chemin += "&cursor=" + urllib.parse.quote(cursor, safe="")
        page = lire(chemin)
        conflits.extend(d for d in page.get("items", []) if d.get("entityKey") == business
                         and d.get("kind") == "conflit" and d.get("operation") == "OUVERTURE_TARDIVE"
                         and d.get("status") == "APPLIED")
        suivant = page.get("nextCursor")
        if not suivant:
            break
        if suivant == cursor:
            ko("TO_CLOSE, pagination des conflits bloquee")
        cursor = suivant
    if len(conflits) != 1:
        ko("TO_CLOSE, conflit APPLIED absent ou duplique")
    vente_source = cle("vente-source")
    if jour["status"] == "TO_CLOSE":
        vente = ecrire("vente", f"/api/cash-days/{jid_tc}/sales", vente_source,
                       ticketNumber="TEMOIN-TC-" + business, sourceType=device, sourceId=vente_source,
                       sellerId=ACTEUR, sellerName=auteur,
                       totalXpf="100", lines=[{"kind": "SERVICE", "label": auteur, "qty": 1,
                       "unitXpf": "100", "lineXpf": "100", "productId": None, "tgcRatePpm": 0}])
        vid_tc = vente.get("saleId")
        if not vid_tc:
            ko("TO_CLOSE, vente sans identifiant")
        ecrire("checkout", f"/api/cash-days/{jid_tc}/sales/{vid_tc}/checkout", vente_source,
                ticketNumber="TEMOIN-TC-" + business, paidAt=ouverture,
                payments=[{"method": "CASH", "amountXpf": "100", "tenderedXpf": "100"}])
        annule = ecrire("void", f"/api/cash-days/{jid_tc}/sales/{vid_tc}/void", vente_source,
                reason="Parcours temoin TO_CLOSE : annulation avant fermeture")
        if annule.get("status") != "VOID":
            ko("TO_CLOSE, annulation absente")
        led = lire(ledger_url)
        avoirs_tc = [f for f in faits(led) if f.get("kind") == "SALE_VOID"]
        if len(avoirs_tc) != 1 or not (avoirs_tc[0].get("snapshot") or {}).get("creditNoteId"):
            ko("TO_CLOSE, avoir Comptabilite absent du journal")
        attendu_tc = str(led.get("projection", {}).get("totauxCourants", {}).get("expectedXpf"))
        if attendu_tc != "10000":
            ko("TO_CLOSE, attendu different de 10000 F apres annulation")
        ecrire("close", f"/api/cash-days/{jid_tc}/close", jid_tc, at=fermeture,
                sourceKey=cle("close"), countedXpf="10000", closureMode="ONLINE",
                localExpectedXpf="10000", localVarianceXpf="0", cycle=0)
    ferme = lire(query).get("day") or {}
    if ferme.get("status") != "CLOSED" or ferme.get("closedLate") is not True:
        ko("TO_CLOSE, fermeture tardive non CLOSED")
    led = lire(ledger_url)
    fs = faits(led)
    if fs is None:
        ko("TO_CLOSE, journal incomplet apres fermeture")
    ventes = [f for f in fs if f.get("kind") == "SALE_PAID"]
    zs = [f for f in fs if f.get("kind") == "CLOSURE"]
    annulations = [f for f in fs if f.get("kind") == "SALE_VOID"]
    if (len(ventes) != 1 or ventes[0].get("deviceId") != device
            or (ventes[0].get("snapshot") or {}).get("sellerId") != ACTEUR
            or (ventes[0].get("snapshot") or {}).get("sellerName") != auteur
            or not str(ventes[0].get("occurredAt", "")).startswith(business)
            or len(annulations) != 1 or annulations[0].get("deviceId") != device
            or not (annulations[0].get("snapshot") or {}).get("creditNoteId")
            or len(zs) != 1 or zs[0].get("sourceRef") != cle("close")):
        ko("TO_CLOSE, preuve de vente ou de Z inattendue")
    z = (zs[0].get("snapshot") or {}).get("report") or {}
    attendu_z = {"expectedXpf": "10000", "countedXpf": "10000", "varianceXpf": "0",
        "totalSalesXpf": "0", "salesCount": "0", "cancelledCount": "1",
                 "refundCashXpf": "0", "movementNetXpf": "0"}
    if any(str(z.get(k)) != v for k, v in attendu_z.items()) or z.get("parTaux") != {}:
        ko("TO_CLOSE, Z fige incorrect ou champs 4b absents")
    if len([f for f in fs if f.get("kind") == "SALE_VOID"]) != 1:
        ko("TO_CLOSE, annulation absente ou dupliquee")
    SECOURS.pop()
    print(f"caissedemo TO_CLOSE : {business}, vente annulee, aucune vente due, CLOSED tardif, Z fige 10000 F ecart 0")
    return "TO_CLOSE vert"

try:
    TO_CLOSE = temoin_to_close()
except Exception as e:
    ko(f"TO_CLOSE, reponse inexploitable ({type(e).__name__})")
print(f"TEMOIN=OK {CLASSIQUE} ; caissedemo vert (journee {quoi}, Z ecart {ecart}) ; {TO_CLOSE} en {round(time.monotonic() - DEBUT)} s")
PY
