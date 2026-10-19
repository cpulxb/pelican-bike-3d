import json,sys,time,urllib.request,os,base64
os.makedirs("raw",exist_ok=True)
# 用法：IMAGE_API_BASE=https://<你的网关>/v1 python3 gen.py prompts.json
# 网关需兼容 OpenAI Images（异步任务：POST /images/generations|edits → GET /images/jobs/:id）。
# 鉴权头由你的环境注入（例如 IMAGE_API_KEY），本脚本不在仓库里保存任何密钥。
import os
B=os.environ["IMAGE_API_BASE"].rstrip("/")
KEY=os.environ.get("IMAGE_API_KEY")
def req(method,path,body=None):
    data=json.dumps(body).encode() if body is not None else None
    r=urllib.request.Request(B+path,data=data,method=method,headers=dict({"Content-Type":"application/json"}, **({"Authorization":"Bearer "+KEY} if KEY else {})))
    with urllib.request.urlopen(r,timeout=120) as f: return json.loads(f.read())
jobs=json.load(open(sys.argv[1]))
pending={}
for j in jobs:
    name=j.pop("name"); out=f"raw/{name}.{j.get('output_format','png')}"
    if os.path.exists(out): continue
    ref=j.pop("ref",None)
    body={"model":"gpt-image-2.5","n":1,"quality":"high","response_format":"url","async":True,"output_format":"png"}
    body.update(j)
    ep="/images/generations"
    if ref:
        ep="/images/edits"
        mime="image/png" if ref.endswith("png") else ("image/webp" if ref.endswith("webp") else "image/jpeg")
        body["image"]="data:%s;base64,%s"%(mime,base64.b64encode(open(ref,"rb").read()).decode())
    for a in range(3):
        try:
            r=req("POST",ep,body); pending[r["id"]]=(name,out,body,ep,0); print("submit",name,r["id"],flush=True); break
        except Exception as e: print("submit err",name,e,flush=True); time.sleep(3)
while pending:
    time.sleep(3)
    for jid,(name,out,body,ep,tries) in list(pending.items()):
        try: r=req("GET","/images/jobs/"+jid)
        except Exception as e: print("poll err",name,e,flush=True); continue
        if r["status"]=="completed":
            url=r["result"]["data"][0].get("url")
            if url: urllib.request.urlretrieve(url,out)
            else: open(out,"wb").write(base64.b64decode(r["result"]["data"][0]["b64_json"]))
            print("done",name,flush=True); del pending[jid]
        elif r["status"]=="failed":
            print("FAILED",name,r.get("error"),flush=True); del pending[jid]
            if tries<1:
                try:
                    r2=req("POST",ep,body); pending[r2["id"]]=(name,out,body,ep,tries+1); print("retry",name,flush=True)
                except Exception as e: print("retry err",e,flush=True)
print("ALL DONE",flush=True)
