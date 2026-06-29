"""Terminate THIS Lambda instance via the Cloud API so the GPU stops billing. Reads the API key
from lambda_key.txt; finds our instance by its public IP."""
import json, urllib.request

MYIP = "68.209.75.126"
KEY = open("/home/ubuntu/hookrl/lambda_key.txt").read().strip()
AUTH = "Bearer " + KEY
HOSTS = ["https://cloud.lambda.ai/api/v1", "https://cloud.lambdalabs.com/api/v1"]

def api(host, path, body=None):
    h = {"Authorization": AUTH, "Content-Type": "application/json"}
    req = urllib.request.Request(host + path, data=(json.dumps(body).encode() if body else None),
                                 headers=h, method=("POST" if body else "GET"))
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

iid = None; host_ok = None
for host in HOSTS:
    try:
        data = api(host, "/instances")
        for ins in data.get("data", []):
            if ins.get("ip") == MYIP or ins.get("private_ip") == MYIP:
                iid = ins["id"]; host_ok = host; break
        if iid: break
    except Exception as e:
        print("list via", host, "failed:", str(e)[:80])

if not iid:
    print("!! could not find instance id for", MYIP, "- NOT terminating (terminate manually in dashboard)")
else:
    try:
        r = api(host_ok, "/instance-operations/terminate", {"instance_ids": [iid]})
        print("=== TERMINATED", iid, "===", json.dumps(r)[:200])
    except Exception as e:
        print("!! terminate failed:", str(e)[:120], "- terminate manually")
