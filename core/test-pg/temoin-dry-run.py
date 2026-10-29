"""Joue à blanc le témoin journée face à une API Core locale simulée."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import threading
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse


SOURCE_PATH = "C:/dev/ecosysteme/00-Archi-NextGen/vps/tenants/caissedemo-seeds/temoin-journee.py"


class Core:
    def __init__(self, state):
        self.state = state
        self.day = None
        previous_business = ((datetime.now(timezone.utc) + timedelta(hours=11)).date() - timedelta(days=1)).isoformat()
        self.previous = {"status": state, "businessDay": previous_business, "cashDayId": "synthetic-previous"} if state in ("TO_CLOSE", "OPEN") else None
        self.sales = {}
        self.next_sale = 0
        self.opening = 10000
        self.expected = self.opening
        self.events = []
        self.conflicts = [{"entityKey": "dry-business", "kind": "conflit", "operation": "OUVERTURE_TARDIVE", "status": "APPLIED"}]

    def handle(self, method, path, body):
        route = urlparse(path).path
        query = parse_qs(urlparse(path).query)
        if method == "GET" and route == "/api/cash-days":
            day = query.get("businessDay", [""])[0]
            if self.previous and self.previous["businessDay"] == day:
                return 200, {"day": self.previous}
            return 200, {"day": self.day if self.day and self.day["businessDay"] == day else None}
        if method == "POST" and route == "/api/cash-days":
            if self.state == "OPEN" and self.previous:
                self.previous["status"] = "TO_CLOSE"
            self.day = {"cashDayId": "dry-day", "businessDay": body["businessDay"], "status": "OPEN", "cycle": 0}
            self.opening = int(body.get("openingFloatXpf", 10000))
            self.expected = self.opening
            return 200, self.day
        if route.endswith("/reopen"):
            self.day["status"] = "OPEN"
            self.day["cycle"] += 1
            return 200, self.day
        if method == "POST" and route.endswith("/sales"):
            self.next_sale += 1
            sale_id = f"dry-sale-{self.next_sale}"
            self.sales[sale_id] = {"total": int(body["totalXpf"]), "paid": False, "void": False}
            return 200, {"data": {"saleId": sale_id, "totalXpf": body["totalXpf"]}}
        if method == "POST" and route.endswith("/checkout"):
            sale_id = route.split("/")[-2]
            sale = self.sales[sale_id]
            sale["paid"] = True
            if not sale["void"]:
                self.expected += sale["total"]
                self.events.append({"kind": "SALE_PAID", "deviceId": body["deviceId"], "occurredAt": body["paidAt"], "totalXpf": str(sale["total"])})
            return 200, {"data": {"status": "PAID"}}
        if method == "POST" and route.endswith("/void"):
            sale_id = route.split("/")[-2]
            sale = self.sales[sale_id]
            if sale["paid"] and not sale["void"]:
                sale["void"] = True
                self.expected -= sale["total"]
            return 200, {"data": {"creditNoteId": "dry-credit"}}
        if method == "GET" and route.endswith("/ledger"):
            return 200, {"projection": {"totauxCourants": {"expectedXpf": str(self.expected)}},
                         "openings": [{"sourceKey": "dry-open", "deviceId": "temoin-to-close", "actorId": "dry-actor", "actorName": "Parcours temoin TO_CLOSE"}],
                         "data": self.events + ([{"kind": "TO_CLOSE", "deviceId": "core"}] if self.state == "TO_CLOSE" else []),
                         "hasMore": False}
        if method == "POST" and route.endswith("/close"):
            self.day["status"] = "CLOSED"
            self.day["closedLate"] = body["occurredAt"][:10] > self.day["businessDay"]
            self.day["closedByName"] = body["actorName"]
            return 200, {"data": {"report": {"varianceXpf": "0", "expectedXpf": str(self.expected)}}}
        if method == "GET" and route == "/api/cash-settings":
            return 200, {"toCloseEnabled": True}
        if method == "GET" and route == "/api/cash-deposits":
            return 200, {"items": self.conflicts, "nextCursor": None}
        return 404, {"error": "NOT_FOUND", "route": route}


def execute(source, state, core=None):
    core = core or Core(state)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def _reply(self, status, payload):
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            status, payload = core.handle("GET", self.path, {})
            self._reply(status, payload)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            status, payload = core.handle("POST", self.path, body)
            self._reply(status, payload)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    source = source.replace('BASE = "http://127.0.0.1:3106"', f'BASE = "http://127.0.0.1:{server.server_port}"')
    source = source.replace('URL = os.environ["TEMOIN_URL"].rstrip("/")', f'URL = "http://127.0.0.1:{server.server_port}"')
    original_open = open

    def safe_open(path, *args, **kwargs):
        if path == "/home/deploy/moteurs/01-Core-Caisse/core/.env":
            return io.StringIO("CORE_CAISSE_API_KEY=dry-run\n")
        return original_open(path, *args, **kwargs)

    namespace = {"__name__": "__main__", "open": safe_open}
    old_argv = sys.argv
    old_env = dict(os.environ)
    os.environ.update(TEMOIN_ID="synthetic-dry-run", TEMOIN_ENV_FILE="/home/deploy/moteurs/01-Core-Caisse/core/.env")
    out = io.StringIO()
    try:
        sys.argv = [SOURCE_PATH]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            exec(compile(source, SOURCE_PATH, "exec"), namespace)
        return out.getvalue(), core.day, core.previous
    except SystemExit as exc:
        return out.getvalue() + f"SystemExit({exc.code})\n", core.day, core.previous
    finally:
        sys.argv = old_argv
        os.environ.clear()
        os.environ.update(old_env)
        server.shutdown()
        server.server_close()
        thread.join()
        assert not thread.is_alive()


class LateCore(Core):
    """Fenêtre historique, journal et pannes pour le nouveau parcours TO_CLOSE."""
    def __init__(self, scenario):
        super().__init__("NONE")
        self.scenario, self.days, self.requests = scenario, {}, []
        self.today = (datetime.now(timezone.utc) + timedelta(hours=11)).date()
        self.conflicts = []
        self.opening_body = None
        for offset in (range(7, 1, -1) if scenario == "full" else [7] if scenario in ("occupied", "proved") else []):
            business = (self.today - timedelta(days=offset)).isoformat()
            self.days[business] = {"cashDayId": "occupied-" + business, "status": "CLOSED", "cycle": 0,
                "openedBy": "c0000000-0000-4000-8002-000000000001" if scenario == "proved" else "synthetic-other",
                "openedByName": "Parcours temoin TO_CLOSE" if scenario == "proved" else "Autre auteur synthétique"}

    def handle(self, method, path, body):
        route = urlparse(path).path
        self.requests.append((method, route, body))
        if method == "GET" and route == "/api/cash-days":
            business = parse_qs(urlparse(path).query)["businessDay"][0]
            return 200, {"day": self.days.get(business)}
        if self.scenario in ("failure", "manual") and route.endswith("/checkout"):
            if self.scenario == "manual":
                self.events.append({"kind": "CASH_OUT", "deviceId": "synthetic-other-device"})
            return 503, {"error": "SYNTHETIC_CHECKOUT_FAILURE"}
        if method == "GET" and route.endswith("/ledger"):
            b = self.opening_body
            return 200, {"projection": {"totauxCourants": {"expectedXpf": str(self.expected)}},
                "openings": [{k: b[k] for k in ("sourceKey", "deviceId", "actorId", "actorName")}],
                "data": self.events, "hasMore": False}
        status, result = super().handle(method, path, body)
        if method == "POST" and route == "/api/cash-days":
            assert body["businessDay"] not in self.days, "aucune ouverture sur un jour occupé"
            self.opening_body = body
            self.day.update(status="TO_CLOSE", openedBy=body["actorId"], openedByName=body["actorName"])
            self.days[body["businessDay"]] = self.day
            self.events = [{"kind": "OPENING", "deviceId": body["deviceId"]}, {"kind": "TO_CLOSE", "deviceId": "core"}]
            self.conflicts.append({"entityKey": body["businessDay"], "kind": "conflit", "operation": "OUVERTURE_TARDIVE", "status": "APPLIED"})
        if method == "POST" and route.endswith("/sales"):
            assert body["occurredAt"][:10] == self.day["businessDay"]
        if method == "POST" and route.endswith("/close"):
            assert int(body["countedXpf"]) == self.expected
            total = self.expected - self.opening
            report = {"expectedXpf": self.expected, "countedXpf": self.expected, "varianceXpf": 0,
                "totalSalesXpf": total, "salesCount": sum(s["paid"] for s in self.sales.values()),
                "cancelledCount": 0, "refundCashXpf": 0, "movementNetXpf": 0,
                "parTaux": {"0": {"ttcXpf": total, "htXpf": total, "tgcXpf": 0}}}
            self.events.append({"kind": "CLOSURE", "deviceId": body["deviceId"], "sourceRef": body["sourceKey"], "snapshot": {"report": report}})
            return 200, {"data": {"report": report}}
        return status, result


def main():
    if len(sys.argv) > 1:
        source = base64.b64decode(sys.argv[1]).decode("utf-8")
    else:
        source = open(SOURCE_PATH, encoding="utf-8").read()
    shell = Path("deploy/temoin.sh").read_text(encoding="utf-8").split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    preamble = shell[:shell.index("# ─── 1.")]
    part2 = preamble + shell[shell.index("# ─── 2."):shell.index("# 3.")] + '\nprint("VERT")\n'
    for name, script in (("temoin-journee.py", source), ("temoin.sh partie 2", part2)):
        for state in ("NONE", "TO_CLOSE", "OPEN"):
            core = Core(state)
            output, today, previous = execute(script, state, core)
            passed = "VERT" in output and "SystemExit(" not in output and today and today.get("status") == "CLOSED" and core.expected == 11200
            if state != "NONE":
                passed = passed and previous and previous.get("status") == "TO_CLOSE"
            print(f"{name} état={state} résultat={'VERT' if passed else 'KO'} jour={today} veille={previous}")
            assert passed, output
    tc = preamble + '\nT = "c0000000-0000-4000-8000-0000000000ca"\nACTEUR = "c0000000-0000-4000-8002-000000000001"\n'
    tc += shell[shell.index("# 3."):shell.index("\ntry:\n    TO_CLOSE =")]
    tc += '\ntry:\n    print(temoin_to_close())\nexcept Exception as e:\n    ko(str(e))\n'
    for scenario in ("free", "occupied", "full", "proved", "failure"):
        core = LateCore(scenario)
        output, _, _ = execute(tc, "NONE", core)
        posts = [r for r in core.requests if r[0] == "POST"]
        assert not any(d["status"] == "TO_CLOSE" for d in core.days.values()), output
        if scenario in ("full", "proved"):
            assert not posts and ("aucun jour libre" if scenario == "full" else "deja prouve") in output, output
        elif scenario == "failure":
            assert "SystemExit(1)" in output and "secours" in output and posts[-1][1].endswith("/close"), output
        else:
            business = (core.today - timedelta(days=6 if scenario == "occupied" else 7)).isoformat()
            assert "TO_CLOSE vert" in output and posts[0][2]["businessDay"] == business, output
        print(f"TO_CLOSE scénario={scenario} → PASS, POST={len(posts)}, aucune TO_CLOSE restante")
        if scenario == "failure":
            core.scenario = "recovery"
            core.requests = []
            replay, _, _ = execute(tc, "NONE", core)
            openings = [r for r in core.requests if r[:2] == ("POST", "/api/cash-days")]
            assert "TO_CLOSE vert" in replay and "deja prouve" not in replay, replay
            assert openings[0][2]["businessDay"] == (core.today - timedelta(days=6)).isoformat(), replay
            print("TO_CLOSE après secours → PASS, jour CLOSED de secours sauté, preuve complète sur J-6")
    manual = LateCore("manual")
    output, _, _ = execute(tc, "NONE", manual)
    assert "SystemExit(1)" in output and "usage concurrent, aucune ecriture" in output, output
    assert not any(method == "POST" and route.endswith("/close") for method, route, _ in manual.requests), output
    print("TO_CLOSE usage manuel concurrent → PASS, KO conservé, aucune clôture/comptage de l'autre appareil")
    print("Serveurs arrêtés et threads joints ; aucun processus auxiliaire restant.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
