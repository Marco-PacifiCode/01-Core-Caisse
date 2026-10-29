"""Exécute le vrai parcours TO_CLOSE sans réseau, secret, fichier .env ou serveur.

Depuis la racine : python core/test-pg/temoin-dry-run.py
Preuve rouge : python core/test-pg/temoin-dry-run.py --baseline=ca93ea4
"""
import contextlib
import copy
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid
import urllib.parse
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parents[2]
ACTOR = "c0000000-0000-4000-8002-000000000001"
TENANT = "c0000000-0000-4000-8000-0000000000ca"
AUTHOR = "Parcours temoin TO_CLOSE"
DEVICE = "temoin-to-close"
NOW = datetime(2026, 10, 29, 1, tzinfo=timezone.utc)
TODAY = (NOW + timedelta(hours=11)).date()
NS = uuid.UUID("6f1c2d6e-7a51-4c1e-9d0b-5c3a0e7d7e11")


def day(offset):
    return (TODAY + timedelta(days=offset)).isoformat()


class Core:
    def __init__(self, scenario, status="CLOSED"):
        self.scenario = scenario
        self.days, self.sales, self.requests, self.conflicts = {}, {}, [], []
        self.created = []
        self.legacy = []
        if scenario in ("occupied", "stale_manual", "closed_manual"):
            own = scenario in ("stale_manual", "closed_manual")
            self.days[day(-6)] = {
                "cashDayId": "occupied", "businessDay": day(-6), "status": "TO_CLOSE" if scenario == "stale_manual" else status,
                "cycle": 0, "openedBy": ACTOR if own else "synthetic-other",
                "openedByName": AUTHOR if own else "Autre auteur synthétique",
                "events": [{"kind": "SALE_PAID", "deviceId": "manual", "snapshot": {"sellerId": "synthetic-other"}}],
                "openings": [],
            }
            if scenario == "stale_manual":
                # L'ancienne recherche partait de J-7 : elle doit aussi rencontrer
                # un vrai reste du témoin utilisé par une autre vendeuse.
                previous = copy.deepcopy(self.days[day(-6)])
                previous.update(cashDayId="occupied-j7", businessDay=day(-7))
                previous["openings"] = [{"sourceKey": str(uuid.uuid5(NS, f"to-close:{day(-7)}:open")),
                                         "deviceId": DEVICE, "actorId": ACTOR, "actorName": AUTHOR}]
                previous["events"].append({"kind": "TO_CLOSE", "deviceId": "core"})
                self.days[day(-7)] = previous
        if scenario == "legacy":
            self.legacy = [{"businessDay": day(-6), "sessions": [{"status": status}],
                            "origins": [], "salesWithoutSource": 0, "more": False}]
        self.initial = copy.deepcopy(self.days)

    def totals(self, current):
        sales = [s for s in self.sales.values() if s["day"] is current]
        active = [s for s in sales if s["paid"] and not s["void"]]
        total = sum(s["total"] for s in active)
        return {"expectedXpf": 10000 + total, "totalSalesXpf": total, "salesCount": len(active),
                "cancelledCount": sum(s["void"] for s in sales), "refundCashXpf": 0, "movementNetXpf": 0,
                "parTaux": {"0": {"ttcXpf": total, "htXpf": total, "tgcXpf": 0}} if active else {}}

    def call(self, method, path, body=None, idem=None, **options):
        self.requests.append((method, path, copy.deepcopy(body), options))
        route = urllib.parse.urlparse(path).path
        query = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
        if route == "/api/cash-settings":
            return 200, {"toCloseEnabled": self.scenario != "off"}
        if route == "/api/cash-days/legacy":
            return 200, {"days": self.legacy, "nextCursor": None}
        if route == "/api/cash-deposits":
            return 200, {"items": self.conflicts, "nextCursor": None}
        if route == "/api/cash-days":
            if method == "GET":
                return 200, {"day": self.days.get(query["businessDay"][0])}
            business = body["businessDay"]
            assert business not in self.days, "réouverture d'un jour occupé"
            current = {"cashDayId": "created-" + business, "businessDay": business, "status": "TO_CLOSE", "cycle": 0,
                       "openedBy": body["actorId"], "openedByName": body["actorName"],
                       "events": [{"kind": "TO_CLOSE", "deviceId": "core"}, {"kind": "OPENING", "deviceId": body["deviceId"]}],
                       "openings": [{k: body[k] for k in ("sourceKey", "deviceId", "actorId", "actorName")}], "closedLate": False}
            self.days[business] = current
            self.created.append(current)
            self.conflicts.append({"entityKey": business, "kind": "conflit", "operation": "OUVERTURE_TARDIVE", "status": "APPLIED"})
            return 200, {"data": current}
        parts = route.split("/")
        current = next((d for d in self.days.values() if d["cashDayId"] == parts[3]), None)
        assert current is not None, route
        if route.endswith("/ledger"):
            return 200, {"data": current["events"], "openings": current["openings"], "hasMore": False,
                         "projection": {"totauxCourants": self.totals(current)}}
        if route.endswith("/sales"):
            sid = "sale-" + str(len(self.sales) + 1)
            self.sales[sid] = {"day": current, "total": int(body["totalXpf"]), "paid": False, "void": False,
                               "sellerId": body.get("sellerId"), "sellerName": body.get("sellerName")}
            return 200, {"data": {"saleId": sid}}
        if route.endswith("/checkout"):
            if self.scenario == "failure":
                return 503, {"error": "SYNTHETIC_CHECKOUT_FAILURE"}
            sid = parts[-2]
            sale = self.sales[sid]
            sale["paid"] = True
            current["events"].append({"kind": "SALE_PAID", "deviceId": body["deviceId"], "sourceRef": sid,
                                      "occurredAt": body["occurredAt"],
                                      "snapshot": {"sellerId": sale["sellerId"], "sellerName": sale["sellerName"]}})
            return 200, {"data": {"status": "PAID"}}
        if route.endswith("/void"):
            sid = parts[-2]
            self.sales[sid]["void"] = True
            current["events"].append({"kind": "SALE_VOID", "deviceId": body["deviceId"], "sourceRef": sid,
                                      "snapshot": {"creditNoteId": "synthetic-credit", "saleRef": sid}})
            # L'ACK peut être minimal : la preuve de l'avoir est dans le journal.
            return 200, {"data": {"status": "VOID"}}
        if route.endswith("/close"):
            if self.scenario == "failure_after_void" and not options.get("nettoyage"):
                return 503, {"error": "SYNTHETIC_CLOSE_FAILURE"}
            report = {**self.totals(current), "countedXpf": int(body["countedXpf"])}
            report["varianceXpf"] = report["countedXpf"] - report["expectedXpf"]
            current.update(status="CLOSED", closedLate=True, closedByName=body["actorName"])
            current["events"].append({"kind": "CLOSURE", "deviceId": body["deviceId"], "sourceRef": body["sourceKey"],
                                      "snapshot": {"report": report}})
            return 200, {"data": {"report": report}}
        raise AssertionError((method, route))


def execute(source, core):
    namespace = {"json": json, "re": re, "sys": sys, "uuid": uuid, "urllib": urllib,
                 "datetime": datetime, "timezone": timezone, "timedelta": timedelta,
                 "T": TENANT, "ACTEUR": ACTOR, "NS": NS, "QUAND": NOW, "HORLOGE": NOW,
                 "SECOURS": [], "appel": core.call}
    # Réutilise aussi le vrai nettoyage d'erreur du témoin, sans son préambule qui lit l'environnement.
    helpers = source[source.index("def ko("):source.index("# Reassort")]
    part = source[source.index("def temoin_to_close("):source.index("\ntry:\n    TO_CLOSE =")]
    output = io.StringIO()
    code = 0
    with contextlib.redirect_stdout(output):
        exec(compile(helpers + "\n" + part, "temoin.sh:TO_CLOSE", "exec"), namespace)
        try:
            print(namespace["temoin_to_close"]())
        except SystemExit as error:
            code = error.code
    return code, output.getvalue()


def check(source, scenario, status="CLOSED"):
    core = Core(scenario, status)
    code, output = execute(source, core)
    posts = [r for r in core.requests if r[0] == "POST"]
    expected_code = 1 if scenario.startswith("failure") else 0
    assert code == expected_code, output
    assert all(d["status"] == "CLOSED" for d in core.created), output
    assert all(core.days[k] == v for k, v in core.initial.items()), "jour manuel modifié"
    if scenario == "off":
        assert not posts and "interrupteur éteint" in output, output
    else:
        expected_day = day(-5 if scenario in ("occupied", "stale_manual", "closed_manual", "legacy") else -6)
        assert core.created and core.created[0]["businessDay"] == expected_day, output
        if scenario.startswith("failure"):
            assert "secours" in output and posts[-1][1].endswith("/close"), output
        else:
            assert "TO_CLOSE vert" in output, output
            assert all(not s["paid"] or s["void"] for s in core.sales.values()), "vente non neutralisée"
            report = core.created[0]["events"][-1]["snapshot"]["report"]
            assert report["varianceXpf"] == 0 and report["totalSalesXpf"] == 0 and report["cancelledCount"] == 1, report
    print(f"{scenario}/{status} → PASS ; sortie : {output.strip().replace(chr(10), ' | ')}")
    if scenario == "green":
        before = len(posts)
        code, replay = execute(source, core)
        assert code == 0 and "deja prouve" in replay, replay
        assert len([r for r in core.requests if r[0] == "POST"]) == before
        print("rejeu déjà prouvé → PASS ; Z relu, aucune écriture")
        core.created[0]["events"][-1]["snapshot"]["report"]["varianceXpf"] = 1
        code, broken = execute(source, core)
        assert code == 1 and "Z deja prouve" in broken, broken
        print("rejeu Z altéré → PASS ; KO attendu")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) > 1:
        assert sys.argv[1].startswith("--baseline=")
        commit = sys.argv[1].split("=", 1)[1]
        source = subprocess.check_output(["git", "show", f"{commit}:deploy/temoin.sh"], cwd=ROOT).decode("utf-8")
    else:
        source = (ROOT / "deploy/temoin.sh").read_text(encoding="utf-8")
    source = source.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    failures = 0
    cases = [("off", "CLOSED"), ("green", "CLOSED"), ("stale_manual", "TO_CLOSE"), ("closed_manual", "CLOSED"),
             ("failure", "CLOSED"), ("failure_after_void", "CLOSED")]
    cases += [(scenario, status) for scenario in ("occupied", "legacy") for status in ("OPEN", "CLOSED", "TO_CLOSE")]
    for scenario, status in cases:
        try:
            check(source, scenario, status)
        except Exception as error:
            failures += 1
            print(f"{scenario}/{status} → FAIL : {type(error).__name__}: {error}")
    print(f"BILAN : {len(cases) - failures}/{len(cases)} cas verts ; aucun réseau, serveur ou processus auxiliaire.")
    return int(failures != 0)


if __name__ == "__main__":
    raise SystemExit(main())
