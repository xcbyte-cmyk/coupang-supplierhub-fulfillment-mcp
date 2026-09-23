from pathlib import Path
from html import escape
import base64
import json
import re
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/pdf/supplierhub-work-instructions-2026-09-15'
SHOTS=ROOT/'output/pdf/supplierhub-manual-2026-09-15/screenshots'
TMP=ROOT/'tmp/pdfs/supplierhub-work-instructions'
FOCUSED=OUT/'screenshots'
CAPTURES=json.loads((FOCUSED/'manifest.json').read_text(encoding='utf8'))
OUT.mkdir(parents=True,exist_ok=True); TMP.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('WorkRegular','C:/Windows/Fonts/malgun.ttf'))
pdfmetrics.registerFont(TTFont('WorkBold','C:/Windows/Fonts/malgunbd.ttf'))
pdfmetrics.registerFontFamily('WorkRegular',normal='WorkRegular',bold='WorkBold')
W,H=A4; M=34; CW=W-M*2
NAVY='#18354D'; BLUE='#087AC1'; MUTED='#667788'; INK='#263C4D'
PDF=OUT/'SupplierHub_실무자_작업지침서_캡처보완.pdf'
HTML=OUT/'SupplierHub_실무자_작업지침서_캡처보완.html'
c=canvas.Canvas(str(PDF),pagesize=A4)
c.setTitle('Supplier Hub 실무자 작업지침서 | 재고 확인부터 시작')
c.setAuthor('대령화학')
pages=[]; content=[]; bounds=[]; page_no=0


def p(text,x,y,w,size=11.2,color=INK,bold=False):
    st=ParagraphStyle('work',fontName='WorkBold' if bold else 'WorkRegular',fontSize=size,
                      leading=size*1.48,textColor=HexColor(color),wordWrap='CJK')
    block=Paragraph(text,st); _,h=block.wrap(w,H); block.drawOn(c,x,H-y-h)
    bounds.append((page_no,y+h,re.sub('<[^>]+>','',text)[:55]))
    return y+h


def page(title,subtitle):
    global page_no,content
    if page_no: end()
    page_no+=1; content=[f'<section id="page-{page_no}"><h2>{title}</h2><p class="sub">{subtitle}</p>']
    c.setFillColor(HexColor(NAVY));c.rect(0,H-8,W,8,fill=1,stroke=0)
    p('SUPPLIER HUB  /  실무자 작업지침서',M,23,CW,9,MUTED)
    p(title,M,44,CW,21,NAVY,True)
    p(subtitle,M,77,CW,10,MUTED)
    c.setStrokeColor(HexColor('#DCE5ED'));c.line(M,36,W-M,36)
    p('2026.09.15 · 실제 UI 기반 가상 발주 화면 예시 · 표시 번호 = 작업 순서',M,H-28,CW-42,8,MUTED)
    p(f'{page_no} / 5',W-M-32,H-29,32,9,NAVY,True)
    c.bookmarkPage(f'page{page_no}');c.addOutlineEntry(title,f'page{page_no}')


def end():
    content.append('</section>');pages.append(''.join(content));c.showPage()


def item(n,title,body,y,stock=False,width=None):
    if stock:
        c.setFillColor(HexColor('#FFF3DC'));c.roundRect(M,H-y-85,CW,93,7,fill=1,stroke=0)
    x=M+12 if stock else M
    w=(width or CW)-24 if stock else (width or CW)
    c.setStrokeColor(HexColor(BLUE));c.setLineWidth(1.2);c.rect(x,H-y-14,12,12,fill=0,stroke=1)
    bottom=p(f'{n:02d}  {title}',x+23,y,w-23,13,NAVY,True)
    bottom=p(body,x+23,bottom+5,w-23,11.1)
    content.append(f'<article class="task {"stock" if stock else ""}"><label><input type="checkbox" data-step="{n}"><strong>{n:02d}　{title}</strong></label><div class="instruction">{body}</div></article>')
    return bottom


def image(name,y,maxh=None,caption='',crop=None):
    im=Image.open(SHOTS/name)
    if crop: im=im.crop(crop)
    w=CW;h=w*im.height/im.width
    if maxh and h>maxh: w*=maxh/h;h=maxh
    x=M+(CW-w)/2
    c.drawImage(ImageReader(im),x,H-y-h,w,h)
    c.setStrokeColor(HexColor('#DCE5ED'));c.setLineWidth(.5);c.rect(x,H-y-h,w,h,fill=0,stroke=1)
    if caption:p(caption,M,y+h+5,CW,8.4,MUTED)
    bounds.append((page_no,y+h+22,'image'))
    import io
    b=io.BytesIO();im.save(b,format='PNG');data=base64.b64encode(b.getvalue()).decode()
    content.append(f'<figure><img tabindex="0" src="data:image/png;base64,{data}" alt="{escape(caption)}"><figcaption>{caption}</figcaption></figure>')
    return y+h+25


def focused(name,y,x=M,w=CW,caption=''):
    asset=CAPTURES[name];im=Image.open(FOCUSED/asset['file'])
    scale=w/im.width;h=im.height*scale
    c.drawImage(ImageReader(im),x,H-y-h,w,h)
    c.setStrokeColor(HexColor('#DCE5ED'));c.setLineWidth(.6);c.rect(x,H-y-h,w,h,fill=0,stroke=1)
    encoded=base64.b64encode((FOCUSED/asset['file']).read_bytes()).decode()
    svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{im.width}" height="{im.height}" viewBox="0 0 {im.width} {im.height}"><image href="data:image/png;base64,{encoded}" width="{im.width}" height="{im.height}"/>']
    for mark in asset['marks']:
        bx=mark['x']-3;by=mark['y']-3;bw=mark['width']+6;bh=mark['height']+6
        c.setStrokeColor(HexColor('#E56722'));c.setLineWidth(1.6)
        c.roundRect(x+bx*scale,H-y-(by+bh)*scale,bw*scale,bh*scale,3,fill=0,stroke=1)
        svg.append(f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="4" fill="none" stroke="#e56722" stroke-width="3"/>')
        if mark['label']:
            label=mark['label'];lw=46 if len(label)>2 else 31;lx=max(3,bx-5);ly=1
            if name=='13-waybill' and label=='13-2':ly=max(1,by-24)
            c.setFillColor(HexColor(BLUE));c.roundRect(x+lx*scale,H-y-(ly+23)*scale,lw*scale,23*scale,4,fill=1,stroke=0)
            c.setFillColor(white);c.setFont('WorkBold',12*scale)
            c.drawCentredString(x+(lx+lw/2)*scale,H-y-(ly+16)*scale,label)
            svg.append(f'<rect x="{lx}" y="{ly}" width="{lw}" height="23" rx="4" fill="#087ac1"/><text x="{lx+lw/2}" y="{ly+16}" fill="white" font-size="12" font-family="Arial,sans-serif" font-weight="700" text-anchor="middle">{label}</text>')
    svg.append('</svg>');svg_text=''.join(svg)
    (FOCUSED/(name+'.svg')).write_text(svg_text,encoding='utf8')
    svg_data=base64.b64encode(svg_text.encode()).decode()
    if caption:p(caption,x,y+h+5,w,8.4,MUTED)
    content.append(f'<figure><img tabindex="0" src="data:image/svg+xml;base64,{svg_data}" alt="{escape(caption)}"><figcaption>가상 발주 화면 예시 · {caption}</figcaption></figure>')
    bounds.append((page_no,y+h+25,'focused '+name))
    return y+h+25


def text_note(text,y,x=M,w=CW,size=10.4):
    bottom=p(text,x,y,w,size)
    content.append(f'<p class="instruction">{text}</p>')
    return bottom


def note(title,body,y,amber=False):
    text=f'<b>{title}</b><br/>{body}'
    st=ParagraphStyle('note',fontName='WorkRegular',fontSize=10.2,leading=15.1,wordWrap='CJK')
    block=Paragraph(text,st);_,h=block.wrap(CW-24,H)
    c.setFillColor(HexColor('#FFF3DC' if amber else '#EEF6FC'))
    c.roundRect(M,H-y-h-20,CW,h+20,6,fill=1,stroke=0)
    p(text,M+12,y+9,CW-24,10.2)
    bounds.append((page_no,y+h+20,'note'))
    content.append(f'<aside class="note {"amber" if amber else ""}"><b>{title}</b><div>{body}</div></aside>')
    return y+h+20


# 1. No cover page: stock is the first instruction.
page('1. 재고 확인하고 발주 준비하기','지시 옆의 번호와 캡처의 번호를 맞춰 보세요. 주황색 테두리가 조작할 위치입니다.')
item(1,'가장 먼저, 재고를 확인하세요.',
     '<b>발주 상품의 실제 재고와 출고 가능한 수량을 확인하세요.</b><br/>재고가 부족하면 다음 작업을 멈추고, 출고할 수량부터 정리하세요.',113,True)
item(2,'운영 화면을 열고 작업 조건을 입력하세요.',
     '주소: <link href="http://127.0.0.1:4310/fulfillment" color="#087AC1">http://127.0.0.1:4310/fulfillment</link><br/>'
     '<b>날짜 기준 → 시작·종료일 → 처리할 발주번호</b>를 입력하세요.<br/>특정 발주만 처리할 때는 해당 번호를 입력하고, 여러 번호는 쉼표로 구분하세요.<br/>'
     '<b>발주서·송장·라벨 프린터</b> 이름도 확인하세요.',221)
focused('02-query',329,caption='02 · 날짜 기준·조회 기간·처리할 발주번호 입력 위치')
item(3,'[1~6 준비 실행]을 누르세요.',
     '화면 중간의 <b>01 발주 준비</b> 묶음에서 누르세요.<br/>준비가 끝날 때까지 기다린 뒤 2쪽으로 가세요.',509,width=310)
focused('03-prepare',502,x=375,w=185,caption='03 · 이 버튼을 누르세요')
note('캡처를 보는 방법','본문의 작업 번호와 캡처의 파란 번호가 같습니다. 입력칸·버튼은 주황색 테두리로 표시했습니다. 캡처의 예시 상품·수량 대신 실제 작업 값을 사용하세요.',647)
note('진행하던 발주를 이어서 처리할 때','선택된 실행과 완료 이력을 확인한 뒤 필요한 구간부터 이어가세요.',736)

# 2. Start the documents group, then its review dialog; do not branch into single stage 7.
page('2. 파일을 확인하고 발주확정하기','재고와 출고 수량을 확인한 발주만 확정합니다.')
item(4,'[7~10 이어서 실행]을 누르세요.',
     '<b>확정과 발주서</b> 묶음에서 누르면 검토 창이 열립니다.<br/>묶음이 이미 완료된 경우 3쪽으로 가세요.',113,width=315)
focused('04-documents',111,x=380,w=180,caption='04 · 확정과 발주서 시작')
item(5,'[파일 열기]를 누르세요.',
     '엑셀에서 <b>상품·발주수량·확정수량</b>을 실제 출고할 수량과 대조하세요.<br/>다르면 확정하지 말고 수량을 먼저 정리하세요.',246)
focused('05-file',332,w=465,caption='05 · 검토 창의 준비 파일 아래에 있는 파일 열기')
item(6,'두 항목을 체크한 뒤 발주확정 버튼을 누르세요.',
     '<b>06-1</b> 발주 정보와 엑셀 수량을 확인하고 두 항목을 체크하세요.<br/>'
     '<b>06-2</b> 그다음 <b>[검토 완료 · 7단계 업로드·발주확정]</b>을 누르세요.',492)
focused('06-checks',575,w=309,caption='06-1 · 두 항목 모두 체크')
focused('06-confirm',571,x=364,w=196,caption='06-2 · 체크 후 이 버튼 클릭')
item(7,'나온 발주서를 확인하세요.',
     '발주서 다운로드·인쇄가 끝나면 <b>실제 출력물의 발주번호, 수량, 누락</b>을 확인하고 3쪽으로 가세요.',711)

# 3. Only missing/wrong units require the edit branch.
page('3. 카톤당 입수수량 확인하기','입수수량은 한 상자에 들어가는 상품 개수입니다.')
note('값이 이미 맞게 저장되어 있으면','예상 카톤 수와 보완 항목을 확인하고 4쪽으로 가세요. 값이 없거나 틀린 상품만 아래 08~10번을 진행하세요.',113)
item(8,'[카톤당 입수수량] 칸에 실제 포장 수량을 입력하세요.',
     '<b>한 상자에 넣는 실제 개수</b>를 입력하세요. 아래 50은 화면 예시입니다.<br/>추정 후보도 실제 포장 기준과 맞는지 확인하세요.',202)
focused('08-units',289,w=450,caption='08 · 입수수량 입력 / 09 · 계산 뒤 예상 카톤 수 확인')
item(9,'[입력값으로 계산]을 누르세요.',
     '<b>예상 카톤 수</b>가 실제 상자 수와 맞는지 확인하세요.<br/>보완 안내가 남으면 입력값을 다시 확인하세요.',483,width=303)
focused('09-calculate',470,x=393,w=167,caption='09 · 입력한 값으로 계산')
item(10,'포장 기준을 체크하고 저장하세요.',
     '<b>10-1</b> 포장 기준 확인 체크 → <b>10-2 [확인한 포장 기준 저장]</b> 클릭.<br/>저장 완료를 확인한 뒤 4쪽으로 가세요.',576)
focused('10-save',646,w=379,caption='10-1 체크 → 10-2 저장 · 입력·계산만으로는 저장되지 않습니다.')

# 4. The actual registration review occurs inside the 11-14 group.
page('4. 로젠 등록하고 송장 확인하기','11~14단계는 등록 내용 확인을 거쳐 송장 출력까지 진행합니다.')
item(11,'[11~14 이어서 실행]을 누르세요.',
     '<b>로젠 배송</b> 묶음에서 누르세요.<br/>로그인·등록 화면 연결 후 검토 창이 열립니다.',113,width=315)
focused('11-logen',112,x=383,w=177,caption='11 · 로젠 배송 시작')
item(12,'내용을 대조하고 [확인한 N건 등록]을 누르세요.',
     '<b>발주번호·상품·수량·카톤 수·수취 센터·주소·연락처</b>를 대조하세요.<br/>N은 화면에 표시되는 등록 건수입니다.',226)
focused('12-review',305,w=447,caption='12 · 수취 정보와 수량·카톤 수를 대조하는 위치')
text_note('내용이 모두 맞으면 오른쪽 <b>12번 버튼</b>을 누르세요.<br/>이후 송장 출력까지 기다리세요.',503,w=303)
focused('12-register',478,x=397,w=163,caption='12 · 검토 후 실제 등록')
item(13,'실제 송장과 번호를 확인하세요.',
     '<b>송장 장수 = 실제 카톤 수</b>인지 확인하세요.<br/>번호 확인 창이 뜨면 <b>13-1 카톤별 번호 선택</b> → <b>13-2 [선택한 번호 확정]</b>을 누르세요.<br/>확인 후 5쪽으로 가세요.',605,width=302)
focused('13-waybill',617,x=355,w=205,caption='13-1 선택 → 13-2 확정 · 번호는 예시입니다')
text_note('송장이 없거나 번호가 다르면<br/>다음 구간을 시작하지 말고 결과를 확인하세요.',746,w=290,size=10)

# 5. Finish with operational checks and a small optional tools box.
page('5. 쉽먼트 등록하고 작업 마치기','송장번호를 확인한 발주를 입고 배송 정보에 연결합니다.')
item(14,'[15~16 이어서 실행]을 누르세요.',
     '상단의 <b>발송일·발송시간</b>을 확인한 뒤, <b>입고 마무리</b> 묶음에서 누르세요.<br/>쉽먼트 등록과 문서 출력이 끝날 때까지 기다리세요.',113)
focused('14-schedule',208,caption='14 · 먼저 실제 발송일과 시간을 입력·확인')
text_note('<b>04 입고 마무리</b> 묶음에서<br/>오른쪽 버튼을 누르고 완료될 때까지 기다리세요.',325,w=310)
focused('14-inbound',316,x=382,w=178,caption='14 · 확인 후 입고 마무리 시작')
item(15,'라벨과 내역서를 확인하고 작업을 마치세요.',
     '<b>발주번호·센터·수량</b>이 맞고 출력물이 빠짐없이 나왔는지 확인하세요.<br/>화면의 입고 마무리 묶음도 <b>완료</b>인지 확인하세요.',444)
note('작업 종료 전 마지막 확인','재고·확정수량 일치 / 카톤 수·송장 장수 일치 / 발주별 배송 연결 / 라벨·내역서 출력물 확인',544)
note('도중에 멈추거나 확인 필요가 나오면','[다음 단계 전 멈춤] → 현재 요청이 끝날 때까지 기다림 → [현재 실행 확인]으로 사유 확인. 원인을 보완한 뒤 같은 실행의 해당 묶음에서 이어가세요.',632,True)
note('녹화가 필요한 작업만','작업 시작 전 [녹화 시작] → 공유할 화면 선택. 작업을 마친 뒤 [녹화 중지·파일 저장] → 다운로드한 WebM 파일을 확인하세요.',721)

end();c.save()

html_pages=''.join(pages).replace('<link href="http://127.0.0.1:4310/fulfillment" color="#087AC1">','<a href="http://127.0.0.1:4310/fulfillment" target="_blank" rel="noopener">').replace('</link>','</a>')
HTML.write_text('''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supplier Hub 실무자 작업지침서</title><style>
*{box-sizing:border-box}body{margin:0;background:#eef3f7;color:#263c4d;font:17px/1.75 "Malgun Gothic",sans-serif}header{max-width:900px;margin:28px auto 0;padding:0 24px}header h1{font-size:26px;color:#18354d;margin:0}header p{color:#667788;font-size:14px;margin:6px 0}main{max-width:900px;margin:16px auto;padding:0 24px}section{background:white;padding:34px;margin:20px 0;border:1px solid #dce5ed;border-radius:9px}h2{color:#18354d;font-size:27px;margin:0 0 4px}.sub{font-size:15px;color:#667788;margin:0 0 26px}.task{padding:18px 0;border-bottom:1px solid #dce5ed}.task label{display:flex;gap:12px;align-items:flex-start;cursor:pointer;font-size:19px;color:#18354d}.task input{accent-color:#087ac1;width:21px;height:21px;flex:0 0 21px;margin-top:7px}.task.done{opacity:.6}.task.done strong{text-decoration:line-through}.instruction{margin:9px 0 0 33px}.stock{background:#fff3dc;border-radius:8px;padding:20px;border-bottom:0;margin-bottom:10px}.note{background:#eef6fc;border-radius:7px;padding:16px 20px;margin:24px 0;font-size:15px}.note.amber{background:#fff3dc}.note div{margin-top:5px}figure{margin:22px 0}figure img{display:block;max-width:100%;max-height:610px;margin:auto;border:1px solid #dce5ed;cursor:zoom-in}figcaption{font-size:12px;color:#667788;margin-top:7px}a{color:#087ac1}.tools{position:sticky;bottom:0;background:#18354d;color:white;display:flex;gap:20px;justify-content:space-between;align-items:center;padding:12px 22px;box-shadow:0 -3px 15px #18354d20}.tools button{padding:8px 15px;background:white;border:0;border-radius:5px;color:#18354d;cursor:pointer}dialog{border:0;border-radius:9px;padding:12px;width:min(92vw,1000px);max-width:96vw;max-height:94vh}dialog::backdrop{background:#162c43c9}dialog img{display:block;width:100%;height:auto}dialog button{position:sticky;top:0;display:block;margin-left:auto;background:#18354d;color:white;border:0;padding:10px 18px;border-radius:5px;cursor:pointer}footer{max-width:900px;margin:22px auto;padding:0 24px;color:#667788;font-size:12px}@media(max-width:600px){main,header{padding:0 12px}section{padding:22px}.task label{font-size:17px}h2{font-size:23px}}@media print{body{background:white}.tools,dialog{display:none}section{break-before:page;border:0;padding:0}.task.done{opacity:1}.task.done strong{text-decoration:none}}
</style><header><h1>실무자 작업지침서</h1><p>완료한 줄에 체크하며 순서대로 진행하세요. 대괄호 안의 버튼은 운영 화면에서 누릅니다.</p></header><main>'''+html_pages+'''</main><footer>2026.09.15 실제 UI에 가상 발주를 적용해 촬영한 화면 예시입니다. 실제 발주·송장 번호가 아닙니다. 이 문서의 체크는 읽기 진행 표시이며, 발주·배송 시스템을 실행하거나 완료 처리하지 않습니다.</footer><div class="tools"><span id="count" aria-live="polite">완료 체크 0 / 15</span><button id="clear" type="button">체크 모두 해제</button></div><dialog id="zoom"><button type="button">닫기</button><img alt="화면 확대"></dialog><script>
const boxes=[...document.querySelectorAll('[data-step]')];const key='supplierhub-operator-instructions-v1';const zoom=document.querySelector('#zoom');let checked=[];try{checked=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(checked))checked=[]}catch{}function sync(){boxes.forEach(b=>b.closest('.task').classList.toggle('done',b.checked));document.querySelector('#count').textContent=`완료 체크 ${boxes.filter(b=>b.checked).length} / 15`;try{localStorage.setItem(key,JSON.stringify(boxes.filter(b=>b.checked).map(b=>b.dataset.step)))}catch{}}boxes.forEach(b=>{b.checked=checked.includes(b.dataset.step);b.addEventListener('change',sync)});sync();document.querySelector('#clear').addEventListener('click',()=>{boxes.forEach(b=>b.checked=false);sync()});document.querySelectorAll('figure img').forEach(im=>{function open(){zoom.querySelector('img').src=im.src;zoom.querySelector('img').alt=im.alt;zoom.showModal()}im.addEventListener('click',open);im.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();open()}})});zoom.querySelector('button').addEventListener('click',()=>zoom.close());zoom.addEventListener('click',e=>{if(e.target===zoom)zoom.close()});
</script></html>''',encoding='utf-8')
overflow=[v for v in bounds if v[1]>795 and not v[2].startswith('2026.09.15') and not re.fullmatch(r'[1-5] / 5',v[2])]
(TMP/'layout-check.json').write_text(json.dumps({'pages':page_no,'overflow':overflow,'elements':bounds},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'pdf':str(PDF),'html':str(HTML),'pages':page_no,'overflow':overflow},ensure_ascii=False))
