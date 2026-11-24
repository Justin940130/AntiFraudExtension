"""Run in a fresh process against a supplied backend directory, with no real model."""
import sys, types, tempfile, json, time, threading, contextlib, io, sqlite3, gc
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.dont_write_bytecode=True
backend=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(backend))
temporary=tempfile.TemporaryDirectory()
import database
database.DB_PATH=Path(temporary.name)/'bench.db'
class Model:
    def __init__(self,*a,**kw): self.calls=0; self.lock=threading.Lock()
    def generate_content(self,*a,**kw):
        with self.lock: self.calls+=1
        time.sleep(.2)
        return types.SimpleNamespace(text='{"risk_level":"high","category":"fixture"}')
google=types.ModuleType('google'); sdk=types.ModuleType('google.generativeai'); st=types.ModuleType('google.generativeai.types')
sdk.configure=lambda **kw:None; sdk.GenerativeModel=Model;google.generativeai=sdk
st.HarmCategory=types.SimpleNamespace(**{f'HARM_CATEGORY_{x}':x for x in ['HATE_SPEECH','HARASSMENT','SEXUALLY_EXPLICIT','DANGEROUS_CONTENT']})
st.HarmBlockThreshold=types.SimpleNamespace(BLOCK_NONE=0)
sys.modules.update({'google':google,'google.generativeai':sdk,'google.generativeai.types':st})
with contextlib.redirect_stdout(io.StringIO()):
    import app
    rows=[]
    for trial in range(5):
        app.model=Model()
        barrier=threading.Barrier(8)
        def run(i):
            barrier.wait()
            with app.app.test_client() as client:
                return client.post('/analyze',json={'text':f'identical request trial {trial}','id':str(i)})
        start=time.perf_counter()
        with ThreadPoolExecutor(max_workers=8) as pool: replies=list(pool.map(run,range(8)))
        rows.append({'trial':trial+1,'modelCalls':app.model.calls,'elapsedMs':(time.perf_counter()-start)*1000,'successful':sum(r.status_code==200 for r in replies)})
gc.collect()
print(json.dumps({'workload':'8 simultaneous identical cold-cache requests; fake model sleeps 200 ms; 5 trials; in-process Flask clients', 'rows':rows},indent=2))
