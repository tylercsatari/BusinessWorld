"""Terminate THIS Lambda instance (id read from instance_id.txt) so the GPU stops billing.
Reads the key from lambda_key.txt and instance id from instance_id.txt in the same dir."""
import json, os, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
KEY = open(os.path.join(HERE, "lambda_key.txt")).read().strip()
IID = open(os.path.join(HERE, "instance_id.txt")).read().strip()
req = urllib.request.Request("https://cloud.lambda.ai/api/v1/instance-operations/terminate",
    data=json.dumps({"instance_ids": [IID]}).encode(),
    headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
try:
    print(urllib.request.urlopen(req, timeout=30).read()[:200]); print("=== TERMINATED", IID, "===")
except Exception as e:
    print("!! terminate failed:", str(e)[:150], "- terminate manually in the Lambda dashboard")
