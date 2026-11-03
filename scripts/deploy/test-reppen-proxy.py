#!/usr/bin/env python3
"""Black-box checks against a built web image; no live service or account is used."""
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
import uuid


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def request(port, path, token="proof-token"):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def main():
    image = os.environ["WEB_IMAGE"]
    network = "reppen-proxy-proof-" + uuid.uuid4().hex[:10]
    containers = []
    docker("network", "create", network)
    try:
        fixture = docker("run", "-d", "--network", network, "--network-alias", "backend",
                         "node:22.23.4-alpine", "node", "-e",
                         "require('http').createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({path:q.url,authorization:q.headers.authorization}))}).listen(3000,'0.0.0.0')")
        containers.append(fixture)
        for prefix, enabled in [("", False), ("", True), ("/gym", True)]:
            web = docker("run", "-d", "--network", network, "-p", "127.0.0.1::8080",
                         "-e", "NGINX_PORT=8080", "-e", "BACKEND=backend", "-e", "PORT=3000",
                         "-e", f"BASE_PATH={prefix}", "-e", f"REPPEN_BACKEND={'backend:3000' if enabled else ''}", image)
            containers.append(web)
            port = docker("port", web, "8080/tcp").rsplit(":", 1)[1]
            deadline = time.monotonic() + 30
            while True:
                try:
                    status, body = request(port, prefix + "/api/health")
                    if status == 200:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                if time.monotonic() >= deadline:
                    raise AssertionError("web/API proxy did not start")
                time.sleep(.2)
            assert json.loads(body)["path"] == "/api/health"
            status, body = request(port, prefix + "/reppen/v1/program-catalog?limit=2&cursor=a%2Fb")
            if enabled:
                assert status == 200, (status, body)
                assert json.loads(body) == {
                    "path": "/v1/program-catalog?limit=2&cursor=a%2Fb",
                    "authorization": "Bearer proof-token",
                }, body
            else:
                assert status == 503, (status, body)
            print(json.dumps({"prefix": prefix, "reppenEnabled": enabled, "api": "pass", "reppen": "pass"}))
        docker("stop", fixture)
        status, _ = request(port, "/gym/reppen/v1/program-catalog")
        assert status in (502, 504), status
        print(json.dumps({"backendUnavailable": status, "result": "pass"}))
    finally:
        for container in reversed(containers):
            subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, check=False)
        subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    main()
