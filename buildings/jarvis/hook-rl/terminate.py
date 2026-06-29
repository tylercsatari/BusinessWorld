"""Terminate THIS Lambda instance (id read from instance_id.txt) so the GPU stops billing."""
import json, urllib.request
KEY = open("/home/ubuntu/hookrl/lambda_key.txt").read().strip()
IID = open("/home/ubuntu/hookrl/instance_id.txt").read().strip()
req = urllib.request.Request("https://cloud.lambda.ai/api/v1/instance-operations/terminate",
    data=json.dumps({"instance_ids": [IID]}).encode(),
    headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
try:
    print(urllib.request.urlopen(req, timeout=30).read()[:200]); print("=== TERMINATED", IID, "===")
except Exception as e:
    print("!! terminate failed:", str(e)[:150], "- terminate manually in dashboard")
