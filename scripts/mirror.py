from pathlib import Path
from html.parser import HTMLParser
from urllib.request import urlopen, Request
from urllib.parse import urljoin, urlparse
import concurrent.futures, re, json, hashlib, subprocess
ROOT=Path(__file__).resolve().parents[1]
DEST=ROOT/'public/game'
DEST.mkdir(parents=True, exist_ok=True)
BASE='https://bonk.io/'
html=(ROOT/'evidence/original/gameframe-release.html').read_text()
class Parser(HTMLParser):
 def __init__(self):super().__init__();self.urls=set()
 def handle_starttag(self,t,a):
  a=dict(a)
  for key in ['src','href']:
   v=a.get(key,'')
   if v and not v.startswith(('http','data:','#','//')):self.urls.add(v)
p=Parser();p.feed(html)
urls=p.urls|set(re.findall(r'url\([\"\']?([^\)\"\']+)',html))|{'js/alpha2s.js','GameResources.js'}
seen=set();manifest=[];failures=[]
def fetch(rel):
 try:
  url=urljoin(BASE,rel)
  if urlparse(url).netloc!='bonk.io':return []
  path=DEST/urlparse(url).path.lstrip('/')
  if path.exists():data=path.read_bytes()
  else:
   data=subprocess.check_output(['curl','--fail','--location','--silent','--max-time','30',url])
   path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
  manifest.append({'path':str(path.relative_to(DEST)),'url':url,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
  if path.suffix in ['.css']:
   return [urljoin(rel,x) for x in re.findall(r'url\([\"\']?([^\)\"\']+)',data.decode(errors='replace')) if not x.startswith('data:')]
  return []
 except Exception as e:failures.append({'url':rel,'error':str(e)});return []
while urls:
 batch=urls-seen;seen|=batch;urls=set()
 with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
  for new in pool.map(fetch,batch):urls.update(new)
(DEST/'index.html').write_text(html)
(ROOT/'evidence/original/asset-manifest.json').write_text(json.dumps({'assets':sorted(manifest,key=lambda x:x['path']),'failures':failures},indent=2))
print(f'Mirrored {len(manifest)} assets; {len(failures)} missing',failures)
