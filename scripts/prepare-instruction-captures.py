from pathlib import Path
from PIL import Image
import json, math

ROOT=Path(__file__).resolve().parents[1]
RAW=ROOT/'tmp/pdfs/supplierhub-work-instructions/revision-captures'
OUT=ROOT/'output/pdf/supplierhub-work-instructions-2026-09-15/screenshots'
OUT.mkdir(parents=True,exist_ok=True)
meta=json.loads((RAW/'rects.json').read_text(encoding='utf8'))
assets={}

def rect(name,key):
 r=meta[name]['rects'][key]
 return [r['x'],r['y'],r['x']+r['width'],r['y']+r['height']]

def save(name,source,box,marks):
 im=Image.open(RAW/(source+'.png'));x0,y0,x1,y1=map(lambda v:round(v),box)
 assert 0<=x0<x1<=im.width and 0<=y0<y1<=im.height,(name,box,im.size)
 part=im.crop((x0,y0,x1,y1))
 pad=26
 target=Image.new('RGB',(part.width+pad*2,part.height+pad*2),'white');target.paste(part,(pad,pad));target.save(OUT/(name+'.png'))
 highlights=[]
 for label,b in marks:
  x,y,xx,yy=b
  highlights.append({'label':label,'x':x-x0+pad,'y':y-y0+pad,'width':xx-x,'height':yy-y})
 assets[name]={'file':name+'.png','width':target.width,'height':target.height,'marks':highlights,'source':'가상 발주 화면 예시'}

def button(name,key,label):
 b=rect('main',key)
 # Full-page captures can shift the scrollbar width. Anchor the outline to the
 # actual blue button pixels within the small, observed target region.
 im=Image.open(RAW/'main.png').convert('RGB')
 box=[max(0,math.floor(b[0]-30)),math.floor(b[1]-24),min(im.width,math.ceil(b[2]+28)),math.ceil(b[3]+24)]
 found=[]
 for y in range(box[1],box[3]):
  for x in range(box[0],box[2]):
   r,g,bl=im.getpixel((x,y))
   if 10<r<70 and 75<g<170 and 150<bl<240 and bl-r>80:found.append((x,y))
 if found:b=[min(x for x,y in found),min(y for x,y in found),max(x for x,y in found)+1,max(y for x,y in found)+1]
 save(name,'main',[b[0]-12,b[1]-16,b[2]+12,b[3]+12],[(label,b)])

def blue_control(name,source,key,label):
 b=rect(source,key);im=Image.open(RAW/(source+'.png')).convert('RGB');found=[]
 for y in range(round(b[1]-15),round(b[3]+15)):
  for x in range(round(b[0]-23),round(b[2]+15)):
   r,g,bl=im.getpixel((x,y))
   if 10<r<70 and 75<g<170 and 150<bl<240 and bl-r>80:found.append((x,y))
 assert found,name
 b=[min(x for x,y in found),min(y for x,y in found),max(x for x,y in found)+1,max(y for x,y in found)+1]
 save(name,source,[b[0]-7,b[1]-14,b[2]+7,b[3]+9],[(label,b)])

button('03-prepare','prepare','03')
button('04-documents','documents','04')
button('11-logen','logen','11')
button('14-inbound','inbound','14')
save('02-query','main',[243,263,1240,475],[('02',rect('main','query')),('',rect('main','date')),('',rect('main','endDate')),('',rect('main','order'))])
save('14-schedule','main',[244,828,1238,920],[('14',rect('main','schedule')),('',rect('main','time'))])
save('05-file','confirmation-before',[186,313,737,434],[('05',rect('confirmation-before','open'))])
save('06-checks','confirmation-checked',[186,432,689,503],[('06-1',[192,443,625,494])])
blue_control('06-confirm','confirmation-checked','accept','06-2')
save('08-units','units',[550,177,973,296],[('08',rect('units','input')),('09',rect('units','cartons'))])
save('09-calculate','units',[186,372,307,421],[('09',rect('units','calculate'))])
save('10-save','units',[59,336,452,426],[('10-1',[70,347,434,366]),('10-2',rect('units','save'))])
save('12-review','registration',[187,163,1065,442],[('12', [197,263,622,310]),('',[512,342,786,431])])
blue_control('12-register','registration','confirm','12')
save('13-waybill','waybill',[787,229,1073,410],[('13-1',rect('waybill','select')),('13-2',rect('waybill','confirm'))])
(OUT/'manifest.json').write_text(json.dumps(assets,ensure_ascii=False,indent=2),encoding='utf8')
print('Prepared',len(assets),'focused screenshot assets')
