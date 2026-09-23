from pathlib import Path
import base64
import html
import re
import json
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.utils import ImageReader
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf/supplierhub-manual-2026-09-15'
SHOTS = OUT / 'screenshots'
OUT.mkdir(parents=True, exist_ok=True)
PDF = OUT / 'SupplierHub_화면으로_따라하는_운영매뉴얼.pdf'
HTML = OUT / 'SupplierHub_화면으로_따라하는_운영매뉴얼.html'
pdfmetrics.registerFont(TTFont('Malgun', 'C:/Windows/Fonts/malgun.ttf'))
pdfmetrics.registerFont(TTFont('MalgunBold', 'C:/Windows/Fonts/malgunbd.ttf'))
pdfmetrics.registerFontFamily('Malgun', normal='Malgun', bold='MalgunBold')
W, H, M = 1000, 750, 48
NAVY, BLUE, INK, MUTED = '#18354D', '#087AC1', '#243747', '#627586'
LINE, PALE = '#DCE5ED', '#F3F7FA'
c = canvas.Canvas(str(PDF), pagesize=(W, H))
c.setTitle('Supplier Hub | 화면으로 따라하는 운영 매뉴얼')
c.setAuthor('대령화학')
c.setSubject('운영 화면 캡처와 1~16단계 사용 방법 · 2026-09-15')
pages, page_html, count, checks = [], [], 0, []


def style(size=12, bold=False, color=INK, leading=None):
    return ParagraphStyle('body', fontName='MalgunBold' if bold else 'Malgun', fontSize=size,
                          leading=leading or size*1.52, textColor=HexColor(color), wordWrap='CJK')


def para(text, x, y, w, size=12, bold=False, color=INK, emit=True):
    p = Paragraph(text, style(size, bold, color))
    _, height = p.wrap(w, H)
    p.drawOn(c, x, H-y-height)
    checks.append((count, y+height, re.sub('<[^>]+>', '', text)[:65]))
    if emit:
        page_html.append(f'<p>{text}</p>')
    return y+height


def start(title, section, subtitle):
    global count, page_html
    if count:
        finish()
    count += 1
    page_html = [f'<section id="page-{count}"><div class="eyebrow">{section}</div><h2>{title}</h2><p class="lead">{subtitle}</p>']
    c.setFillColor(HexColor(NAVY)); c.rect(0,H-9,W,9,fill=1,stroke=0)
    para('SUPPLIER HUB / OPERATION GUIDE', M,25,600,9,True,MUTED,False)
    para(section, 780,25,172,9,True,BLUE,False)
    para(title,M,51,904,26,True,NAVY,False)
    para(subtitle,M,93,904,11.3,False,MUTED,False)
    c.setStrokeColor(HexColor(LINE)); c.line(M,43,W-M,43)
    para('2026.09.15  |  화면 캡처 기준 · 내부 업무용',M,H-32,750,9,False,MUTED,False)
    para(f'{count:02d} / 13',898,H-32,60,9,True,NAVY,False)
    c.bookmarkPage(f'p{count}'); c.addOutlineEntry(title,f'p{count}',0,False)


def finish():
    page_html.append('</section>')
    pages.append(''.join(page_html))
    c.showPage()


def shot(name,x,y,w,maxh=None,caption=''):
    im = Image.open(SHOTS/name)
    h = w*im.height/im.width
    if maxh and h>maxh:
        w*=maxh/h; h=maxh
    c.drawImage(ImageReader(im),x,H-y-h,width=w,height=h)
    c.setStrokeColor(HexColor(LINE)); c.setLineWidth(.6); c.rect(x,H-y-h,w,h,fill=0,stroke=1)
    if caption:
        para(caption,x,y+h+6,w,9,False,MUTED,False)
    checks.append((count,y+h+22,'screenshot '+name))
    b64=base64.b64encode((SHOTS/name).read_bytes()).decode()
    page_html.append(f'<figure><button class="screenshot" aria-label="{html.escape(caption)} 확대"><img src="data:image/png;base64,{b64}" alt="{html.escape(caption)}"></button><figcaption>{caption}</figcaption></figure>')
    return y+h+28


def steps(items,x,y,w,size=12,gap=12):
    page_html.append('<ol class="steps">')
    for i,(heading,body) in enumerate(items,1):
        c.setFillColor(HexColor(BLUE)); c.circle(x+10,H-y-10,10,fill=1,stroke=0)
        c.setFillColor(white); c.setFont('MalgunBold',10); c.drawCentredString(x+10,H-y-13.5,str(i))
        y=para(f'<b>{heading}</b><br/>{body}',x+29,y,w-29,size,emit=False)+gap
        page_html.append(f'<li><b>{heading}</b><p>{body}</p></li>')
    page_html.append('</ol>')
    return y


def table(headers,rows,x,y,widths,size=11):
    data=[[Paragraph(str(v),style(size,True,NAVY)) for v in headers]]
    data += [[Paragraph(str(v),style(size)) for v in row] for row in rows]
    t=Table(data,colWidths=widths,hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),HexColor('#EAF2F8')),
        ('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),
        ('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),
        ('LINEBELOW',(0,0),(-1,-1),.5,HexColor(LINE)),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[white,HexColor('#FAFCFE')]),
    ]))
    tw,th=t.wrap(sum(widths),H); t.drawOn(c,x,H-y-th)
    checks.append((count,y+th,'table'))
    page_html.append('<div class="table-wrap"><table><thead><tr>'+''.join(f'<th>{v}</th>' for v in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join(f'<td>{v}</td>' for v in row)+'</tr>' for row in rows)+'</tbody></table></div>')
    return y+th


def note(title,body,x,y,w,amber=False):
    text=f'<b>{title}</b><br/>{body}'
    p=Paragraph(text,style(11.5)); _,ph=p.wrap(w-28,H)
    c.setFillColor(HexColor('#FFF7E7' if amber else '#EEF6FC'))
    c.roundRect(x,H-y-ph-22,w,ph+22,7,fill=1,stroke=0)
    para(text,x+14,y+10,w-28,11.5,emit=False)
    checks.append((count,y+ph+22,'note'))
    page_html.append(f'<aside class="note {"amber" if amber else ""}"><b>{title}</b><p>{body}</p></aside>')
    return y+ph+34


# 01
start('화면으로 따라하는 운영 매뉴얼','START HERE','발주 준비부터 로젠 배송·쉽먼트 문서 출력까지, 화면의 버튼을 기준으로 설명합니다.')
para('한 번의 업무는<br/><b>준비 → 검토 → 확정 → 배송 → 입고</b>',48,152,540,23,color=NAVY)
para('운영 주소  http://127.0.0.1:4310/fulfillment<br/>실습 주소  http://127.0.0.1:4310/practice',48,233,565,13)
table(['업무 묶음','단계','먼저 볼 페이지'],[
    ['01 발주 준비','1~6','3쪽 · 조회부터 확정수량 작성'],
    ['02 확정과 발주서','7~10','4~5쪽 · 파일 검토와 발주서 출력'],
    ['03 로젠 배송','11~14','6~8쪽 · 포장 기준, 등록, 송장 확인'],
    ['04 입고 마무리','15~16','9쪽 · 쉽먼트 등록과 문서 출력'],
],48,301,[175,75,330],11.5)
shot('02-work-tools.png',686,145,255,caption='화면을 따라다니는 작업 도구 · 자세한 사용법은 10쪽')
note('처음 사용할 때','2쪽 설정 확인 → 3쪽 1~6 준비 실행 → 4쪽 파일 검토 순서로 시작합니다. 묶음 버튼은 해당 구간 끝에서 멈추고, 전체 실행은 검토 지점을 거쳐 다음 묶음으로 이어집니다.',48,522,904)
para('찾아보기: 10쪽 작업 도구·녹화 / 11쪽 중단 후 재개 / 12쪽 가상 실습 / 13쪽 문제 해결·종료 확인',48,615,904,12,True)
para('캡처는 2026.09.15 운영 화면입니다. 표시된 발주번호·상품·프린터·완료 상태는 캡처 당시 사례이며 매일의 작업 대상과 다를 수 있습니다. 매뉴얼 제작 중 실제 발주확정·등록·인쇄·녹화는 실행하지 않았습니다.',48,650,904,10.5,color=MUTED)

# 02
start('시작 전, 조회 조건과 작업 환경 확인','01 / 준비','날짜·발주번호·프린터·발송 설정을 정한 다음 실행합니다.')
shot('03-settings.png',48,147,576,maxh=494,caption='운영 화면 상단의 워크플로 설정값')
steps([
    ('조회 기준 선택','기본은 입고예정일입니다. 발주일로 찾을 때만 기준을 바꿉니다. 날짜를 비우는 빠른 조회는 입고예정일 기준입니다.'),
    ('조회 범위와 발주번호','시작·종료 날짜를 확인합니다. 특정 발주만 처리하려면 발주번호를 입력하고, 여러 번호는 쉼표로 구분합니다.'),
    ('프린터와 로젠 방식','발주서·송장·라벨 프린터가 맞는지 확인합니다. 현재 환경은 웹사이트 MCP 방식입니다. 프린터 이름은 설정값 표시입니다.'),
    ('발송일과 시간','실제 출고 일정으로 입력합니다. 비워두면 선택 실행의 저장값을 사용하고, 없으면 당일 기본 발송시간을 사용합니다.'),
],651,150,300,size=11.6,gap=14)
note('화면이 열리지 않을 때','프로젝트 폴더의 start-dashboard.ps1을 PowerShell로 실행한 뒤 운영 주소에 다시 접속합니다. 다른 PC의 127.0.0.1은 그 PC 자체를 가리키므로 서버가 실행 중인 PC에서 접속합니다.',48,620,904)

# 03
start('1~6단계: 발주 준비를 한 번에 진행','02 / 발주 준비','준비가 끝나면 엑셀을 검토합니다. 이 구간에서는 발주를 업로드·확정하지 않습니다.')
y=shot('04-preparation.png',48,142,904,caption='01 발주 준비 · 세부 단계는 펼쳐서 개별 이력을 확인할 수 있습니다.')
y=steps([
    ('1~6 준비 실행을 누릅니다','접속 → 발주 조회 → 상태 분류 → 처리 발주 선택 → 양식 다운로드 → 확정수량 작성을 순서대로 진행합니다.'),
    ('준비 완료와 대상 발주를 확인합니다','실행이 멈추면 실패한 단계의 안내를 먼저 확인합니다. 완료했다면 발주·파일 검토 화면 열기로 이동합니다.'),
    ('기존 작업을 이어갈 때는 같은 실행을 사용합니다','진행하던 발주가 있으면 11쪽의 최근 Run 기록에서 복구합니다. 신규 준비 실행으로 기존 작업을 처음부터 반복하지 않습니다.'),
],48,y+8,904,size=12,gap=10)
note('Scan과 Run','Scan은 조회 결과의 식별자이고, Run은 선택한 발주의 작업 묶음 식별자입니다. 1~3단계의 개별 기록 없음은 조회 단계 이력이 따로 저장되지 않았다는 표시이며, 실패 표시가 아닙니다.',48,y+1,904)

# 04
start('7단계 전: 파일을 열고 눈으로 검토','03 / 발주확정 전 확인','화면의 대상 발주와 실제 엑셀의 품목·수량을 대조한 뒤 확정합니다.')
shot('05-confirmation-review.png',48,147,622,caption='캡처 사례는 이미 발주확정된 건이라 확인 체크와 제출 버튼이 비활성화되어 있습니다.')
steps([
    ('대상 확인','발주번호, 물류센터, 입고예정일, 상품 수량이 처리할 발주와 맞는지 봅니다.'),
    ('파일 열기','버튼을 누르면 서버 PC의 기본 앱으로 확정 엑셀 열기를 요청합니다. 엑셀에서 품목별 발주수량·확정수량을 대조합니다.'),
    ('두 확인 항목 체크','발주 정보 확인과 엑셀 수량 확인을 모두 체크합니다. 새 확정 대상이 있을 때 체크할 수 있습니다.'),
    ('검토 완료 후 확정','검토 완료 · 7단계 업로드·발주확정을 누르면 실제 업로드·확정을 진행합니다.'),
],700,150,250,size=11.3,gap=12)
note('열기와 확정은 별도 동작입니다','파일 열기는 엑셀 열기 요청입니다. 열기만으로 검토 완료나 발주확정이 처리되지 않습니다. 닫기 · 나중에 진행 또는 Esc로 닫으면 7단계 호출 없이 종료합니다.',48,589,904)
para('파일이 없거나 변경됐다고 나오면 현재 Run의 준비 파일을 다시 확인합니다. 폴더를 임의로 바꾸어 다른 발주의 파일을 대신 사용하지 않습니다.',48,669,904,11,color=MUTED)

# 05
start('7~10단계: 확정과 발주서 출력','04 / 확정과 발주서','검토한 발주를 확정하고, 내려받은 발주서의 인쇄 결과를 확인합니다.')
y=shot('06-documents.png',48,141,904,caption='02 확정과 발주서 · 완료된 묶음은 버튼이 잠기고 세부 이력을 볼 수 있습니다.')
y=table(['단계','화면에서 진행하는 일','작업자가 확인할 것'],[
    ['7 · 업로드·발주확정','검토 확인 후 확정 엑셀을 업로드합니다.','선택 발주가 발주확정 상태인지 확인합니다.'],
    ['8 · 발주서 다운로드','선택 발주서를 내려받고 상품·수취 정보를 읽습니다.','대상 발주서와 수량·센터가 맞는지 확인합니다.'],
    ['9 · 발주서 인쇄','설정된 프린터로 인쇄를 요청합니다.','프린터에서 실제 출력물이 나왔는지 봅니다.'],
    ['10 · 인쇄 결과 기록','인쇄 제출 결과를 이력에 남깁니다.','페이지 누락·잘림·다른 발주 혼입 여부를 확인합니다.'],
],48,y+4,[150,365,389],11.3)
note('이 구간을 시작하는 버튼','7~10 이어서 실행을 누르면 검토가 필요한 새 확정 건은 7단계 확인을 거칩니다. 묶음 실행은 10단계에서 멈춥니다. 실제 출력물을 확인한 뒤 로젠 배송을 시작합니다.',48,y+15,904)

# 06
start('13단계가 막힐 때: 포장 기준부터 보완','05 / 카톤 준비','입수수량은 한 상자에 들어가는 상품 개수입니다. 발주수량과 구분해서 입력합니다.')
y=shot('07-carton-preparation.png',48,143,904,maxh=280,caption='입수수량 누락 사례 · 후보 입력은 저장이나 등록을 뜻하지 않습니다.')
y=steps([
    ('입수수량 입력','카톤당 입수수량 칸에 실제 포장 기준을 입력합니다. 추정 후보 버튼은 계산을 위한 후보를 입력하는 기능입니다.'),
    ('입력값으로 계산','예상 카톤 수와 보완 항목을 확인합니다. 발주수량이 입력한 입수수량으로 나머지 없이 나누어져야 합니다.'),
    ('포장 기준 확인 후 저장','실제 기준이 맞으면 확인 체크 → 확인한 포장 기준 저장을 누릅니다. 저장값 새로 확인으로 반영 여부를 봅니다.'),
    ('13단계 등록 미리보기','저장한 기준으로 수량·카톤·수취 정보를 검토합니다. 기준정보 저장만으로 로젠 주문이 등록되지는 않습니다.'),
],48,y+3,904,size=11.5,gap=7)
note('캡처 사례의 계산은 조건부 예시','SKU 70924435는 발주수량 200개입니다. 실제 포장이 50개입이라면 200 ÷ 50 = 4카톤입니다. 50개는 유사 품목에서 나온 추정 후보이며, 이 매뉴얼에서 확정한 포장 기준이 아닙니다.',48,y+1,904,True)

# 07
start('13단계: 등록 내용 확인 후 로젠에 저장','06 / 로젠 배송 등록','기준정보가 준비되어야 확인한 건 등록 버튼을 사용할 수 있습니다.')
shot('08-registration-review.png',48,145,620,caption='현재 사례는 입수수량이 없어 등록 버튼이 비활성화된 상태입니다.')
steps([
    ('발주와 상품','발주번호·SKU·상품명이 맞는지 확인합니다. 같은 발주의 다른 상품과 혼동하지 않습니다.'),
    ('수량과 카톤','발주수량, 카톤당 입수수량, 총 카톤 수를 대조합니다. 계산 보완 안내가 있으면 먼저 해결합니다.'),
    ('송수하인과 이력','센터 주소·수취 연락처, 송하인, 거래처코드·운임, 기존 등록 상태를 확인합니다.'),
    ('확인한 건 등록','모든 보완 항목을 해결한 뒤 등록 버튼을 누릅니다. 닫기 · 등록 안 함은 등록 없이 종료합니다.'),
],700,150,252,size=11.6,gap=14)
note('11~14 이어서 실행','로젠 로그인과 주문등록 화면 연결 후 13단계에서 검토를 기다립니다. 13단계 등록이 완료되어야 14단계 송장 출력으로 이어집니다. 서버를 재시작한 경우에는 같은 Run에서 11~12 연결이 다시 필요할 수 있습니다.',48,589,904)
para('결과가 unknown(결과 불명확)이면 기존 예약행을 먼저 확인합니다. 새 Run을 만들거나 이력을 초기화해 동일 주문을 다시 등록하지 않습니다.',48,669,904,11,color=MUTED)

# 08
start('14단계: 송장 출력과 사용할 번호 확인','07 / 송장 확인','송장 장수와 카톤 수를 맞추고, Supplier Hub에 넘길 번호를 확인합니다.')
y=shot('11-logen-details.png',48,144,904,maxh=242,caption='11~14 세부 단계·이력 펼치기 안의 14단계와 송장번호 확인 버튼')
y=steps([
    ('출력 대상 확인','13단계 등록 완료 후 송장을 출력합니다. 출력할 배치가 없다는 안내가 나오면 13단계의 등록 상태부터 확인합니다.'),
    ('실제 라벨 대조','출력 장수가 카톤 수와 맞는지, 발주·센터·상품 정보가 맞는지 봅니다. 인쇄 요청 기록만으로 정상 출력 여부를 판단하지 않습니다.'),
    ('번호 선택이 필요하면 송장번호 확인','14단계에서 사용자 확인을 요청하면 각 카톤의 원송장번호·운송장번호 후보를 실제 라벨과 대조해 사용할 번호를 선택합니다.'),
    ('확정 후 다음 구간으로','번호를 확정한 뒤 15~16 이어서 실행을 누릅니다. 전체 실행으로 진행하던 경우에도 번호 확인 후 전체 실행을 다시 눌러 남은 단계를 이어갑니다.'),
],48,y+10,904,size=12,gap=11)
note('번호 후보가 없거나 출력 결과가 불명확한 경우','번호 조회·출력 결과를 먼저 확인합니다. 이력 초기화나 재출력을 반복하는 방식으로 해결하지 않습니다. 현재 캡처 사례는 등록 전이므로 실제 송장번호 선택 화면은 포함하지 않았습니다.',48,y+2,904,True)

# 09
start('15~16단계: 쉽먼트 등록과 문서 출력','08 / 입고 마무리','확인된 카톤별 송장번호를 발주별 입고 배송 정보에 연결합니다.')
y=shot('09-inbound.png',48,145,904,caption='04 입고 마무리 · 15단계가 부분 완료이면 16단계로 넘어가지 않습니다.')
y=table(['순서','작동 방법','완료 확인'],[
    ['실행 전','발송일·발송시간과 라벨·내역서 프린터를 확인합니다.','선택 Run, 대상 발주, 센터, 입고예정일이 맞습니다.'],
    ['15단계','15~16 이어서 실행 또는 세부 단계의 실제 등록을 누릅니다.','발주별 쉽먼트 번호와 송장 연결 결과를 확인합니다.'],
    ['준비 테스트','세부 단계의 준비 테스트는 업로드 전 첨부·요약까지 확인합니다.','준비 완료를 실제 쉽먼트 등록 완료로 보지 않습니다.'],
    ['16단계','등록된 쉽먼트의 라벨과 내역서 출력을 진행합니다.','출력 문서가 대상 발주와 맞고 누락·잘림이 없습니다.'],
],48,y+9,[106,398,400],11.4)
note('같은 센터라도 발주별로 확인합니다','센터와 입고예정일이 같아도 발주번호가 다르면 별도 쉽먼트로 연결합니다. 부분 완료나 결과 불명확 안내가 나오면 해당 발주의 결과를 확인하고 같은 실행에서 재개합니다.',48,y+17,904)

# 10
start('작업 도구: 실행·모니터링·녹화','09 / 따라다니는 창','페이지 스크롤과 별개로 작업 도구를 계속 사용할 수 있습니다.')
shot('02-work-tools.png',48,145,292,caption='제목 드래그로 이동 · 접기/펼치기 · ↘ 기본 위치')
y=table(['버튼','사용 방법'],[
    ['현재 실행 확인','선택 Run의 저장 기록을 조회해 하단 실행 결과에 표시합니다. 업무를 실행하는 버튼은 아닙니다.'],
    ['전체 실행','선택 Run이 있으면 남은 단계부터, 없으면 1~16단계를 진행합니다. 7·13단계 검토와 14단계 번호 확인은 유지됩니다.'],
    ['모니터링 켜짐/꺼짐','5초마다 완료 수·진행 단계·확인 필요 상태·마지막 조회 시각을 확인합니다. 표시는 저장 기록 기준입니다.'],
    ['다음 단계 전 멈춤','현재 요청이 끝난 뒤 다음 단계를 호출하지 않습니다. 검토 대기 중에는 검토를 취소합니다. 이미 시작한 요청을 강제 취소하지 않습니다.'],
],377,145,[154,421],11.5)
para('<b>녹화하는 순서</b>',377,y+16,575,14,emit=True)
steps([
    ('녹화 시작 → 화면 선택','브라우저가 표시하는 공유 대상에서 녹화할 화면을 선택합니다. 다른 프로그램까지 담으려면 전체 화면을 선택합니다.'),
    ('녹화 중 표시 → 작업 진행','작업창의 녹화 중 표시를 확인합니다. 검토 창이 떠 있어도 녹화를 유지할 수 있습니다.'),
    ('녹화 중지·파일 저장','중지 후 브라우저 다운로드에서 WebM 파일을 확인합니다. 저장된 영상을 열어 필요한 장면이 담겼는지 봅니다.'),
],377,y+43,575,size=11.3,gap=8)
note('창 사용 팁','위치·접힘·모니터링 설정은 같은 브라우저에 보관됩니다. 검토 창이 열리면 작은 도구 창으로 표시됩니다. 이 창은 운영 웹페이지 안에서 동작하며, 녹화 지원 여부와 오디오 공유 범위는 브라우저의 선택 화면을 따릅니다.',48,625,904)

# 11
start('중단 후, 같은 실행에서 이어가기','10 / 실행 복구','최근 Run을 다시 선택하고 완료된 기록을 유지한 채 남은 작업을 진행합니다.')
y=shot('10-recovery.png',48,144,904,maxh=302,caption='상단 고급 복구 옵션 · 최근 Run 기록과 선택 ID 사용 버튼을 사용합니다.')
y=steps([
    ('최근 Run 기록에서 작업 선택','발주 건수·상태·날짜를 보고 이어갈 Run을 선택한 뒤, 오른쪽 Run 영역의 선택 ID 사용을 누릅니다.'),
    ('단계 이력 불러오기와 현재 실행 확인','어느 단계가 완료·확인 필요 상태인지 읽고 대상 발주를 확인합니다. Scan을 복구해야 할 때만 왼쪽 Scan 영역을 사용합니다.'),
    ('원인 보완 후 묶음 또는 전체 실행','입수수량·로그인 연결·송장 확인 등 중단 원인을 해결합니다. 해당 묶음의 이어서 실행 또는 작업 도구의 전체 실행으로 재개합니다.'),
],48,y+5,904,size=11.8,gap=9)
note('복구용 조회와 초기화는 다릅니다','현재 실행 확인·선택 ID 사용·단계 이력 불러오기는 기록 확인에 사용합니다. 발주 배정 해제, 기록 삭제, 등록키·이력 초기화는 단순 이어가기 기능이 아니므로 일상 복구 절차에서 사용하지 않습니다.',48,y+2,904,True)

# 12
start('실제 작업 전, 가상 실습으로 익히기','11 / 실습실','실습 페이지의 발주·송장·출력은 모두 가상 데이터입니다.')
shot('12-practice.png',48,144,575,maxh=522,caption='실습실 첫 화면 · 실제 계정과 프린터를 사용하지 않습니다.')
steps([
    ('실습 예제 열기','운영 화면 오른쪽 위 실습 예제 열기를 누르거나 /practice 주소로 이동합니다.'),
    ('상황 선택','신규 발주 전체 처리, 이미 확정된 발주, 재고가 부족한 경우 중 하나를 선택합니다.'),
    ('설명 읽고 버튼 실행','현재 단계의 설명·확인 항목을 읽고 아래 실행 버튼을 누릅니다. 이후 단계는 앞 단계를 마치면 열립니다.'),
    ('결과 저장과 다시 연습','완료 후 실습 결과를 텍스트로 저장할 수 있습니다. 처음부터 다시 하기는 실습 진행만 초기화합니다.'),
],657,145,295,size=11.8,gap=14)
note('운영 화면과 다른 점','실습은 개별 16단계 학습용입니다. 운영 화면은 1~6, 7~10, 11~14, 15~16으로 묶여 있습니다. 실습 완료가 실제 발주 처리 완료로 연결되지는 않습니다.',657,540,295)

# 13
start('자주 막히는 상황과 작업 종료 확인','12 / 빠른 참조','오류 안내와 저장 기록을 읽고 필요한 부분만 보완합니다.')
y=table(['화면의 상황','확인·처리 방법','관련 쪽'],[
    ['7단계 버튼이 비활성화됨','새 확정 대상이 있는지, 준비 파일이 있는지, 두 검토 항목을 확인했는지 봅니다. 이미 확정된 건이면 재확정하지 않습니다.','4'],
    ['13단계 입수수량 누락','실제 포장 기준 입력 → 계산 → 확인 체크 → 저장 → 등록 미리보기 순서로 진행합니다. 추정 후보는 자동 확정값이 아닙니다.','6~7'],
    ['14단계 출력할 배치가 없음','13단계 등록 완료 여부를 먼저 확인합니다. 등록되지 않은 건은 송장을 출력할 수 없습니다.','7~8'],
    ['부분 완료 또는 결과 불명확','해당 발주·예약행·출력 결과를 확인하고 같은 Run을 사용합니다. 중복 등록·업로드·인쇄를 피하도록 기존 이력을 유지합니다.','8~11'],
    ['파일 열기 실패','선택한 Run의 준비 파일 존재 여부와 변경 안내를 확인합니다. 파일은 서버가 실행 중인 PC에서 열립니다.','4'],
    ['모니터링 연결 확인 필요','서버가 실행 중인지 확인합니다. 마지막 확인 시각이 오래됐다면 최신 상태가 아닐 수 있습니다. 현재 실행 확인으로 다시 조회합니다.','10'],
    ['녹화가 시작되지 않음','공유 선택 취소 또는 브라우저 지원 여부를 확인합니다. 녹화 데이터가 없다는 안내가 나오면 파일 저장 여부를 따로 확인합니다.','10'],
],48,142,[200,634,70],11.3)
para('<b>업무를 마치기 전 확인할 4가지</b>',48,y+18,904,15)
para('① 선택 발주와 확정수량 일치　② 카톤 수와 송장 장수·번호 일치<br/>③ 발주별 쉽먼트 연결 결과　④ 라벨·내역서 실제 출력물 및 녹화 파일 저장 여부',48,y+50,904,13)
note('이 매뉴얼의 확인 범위','2026.09.15 운영 화면을 열어 캡처하고, public/fulfillment.html·public/practice.html 및 README·docs/DEVELOPMENT_SPEC.md의 동작 설명을 대조했습니다. 실제 제출·인쇄·녹화로 성공 상태를 만들지는 않았습니다.',48,y+102,904)
para('현재 캡처 사례: run-a19f4407-405 / 발주 140802144 / 완료 9단계 / 13단계 입수수량 보완 필요. 캡처된 상태는 매뉴얼 작성 시점의 기록입니다.',48,673,904,9.8,color=MUTED)

finish(); c.save()

toc = [(i+1,re.search(r'<h2>(.*?)</h2>',p).group(1)) for i,p in enumerate(pages)]
nav=''.join(f'<a href="#page-{i}"><span>{i:02d}</span>{t}</a>' for i,t in toc)
HTML.write_text('''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supplier Hub 운영 매뉴얼</title><style>
:root{--navy:#18354d;--blue:#087ac1;--ink:#243747}*{box-sizing:border-box}body{margin:0;background:#edf2f6;color:var(--ink);font:16px/1.7 "Malgun Gothic",sans-serif}header{background:var(--navy);color:white;padding:32px max(24px,calc((100vw - 1000px)/2))}h1{font-size:30px;margin:0 0 8px}header p{margin:0;color:#cfdeeb}main{max-width:1100px;margin:24px auto;padding:0 20px}nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px;background:white;padding:26px;border-radius:10px}nav a{color:var(--navy);text-decoration:none;padding:5px;border-bottom:1px solid #e9eef3}nav span{display:inline-block;width:32px;color:var(--blue);font-weight:bold}section{margin:28px 0;background:white;padding:44px;border:1px solid #dce5ed;border-radius:10px;scroll-margin-top:16px}h2{font-size:29px;line-height:1.35;color:var(--navy);margin:8px 0 10px}.eyebrow{font-size:12px;letter-spacing:1.5px;color:var(--blue);font-weight:bold}.lead,figcaption{color:#627586}.lead{margin-bottom:28px}figure{margin:28px 0}.screenshot{display:block;width:100%;padding:0;background:white;border:1px solid #dce5ed;cursor:zoom-in}.screenshot img{display:block;max-width:100%;max-height:700px;margin:auto}figcaption{font-size:13px;margin-top:7px}.steps{padding-left:28px}.steps li{padding-left:6px;margin:18px 0}.steps li::marker{color:var(--blue);font-weight:bold}.steps p{margin:4px 0 0}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:15px;margin:24px 0}th{background:#eaf2f8;color:var(--navy);text-align:left}td,th{padding:12px 15px;border-bottom:1px solid #dce5ed;vertical-align:top}tr:nth-child(even){background:#fafcfe}.note{background:#eef6fc;padding:19px 22px;border-radius:8px;margin:24px 0}.note p{margin:5px 0}.note.amber{background:#fff7e7}footer{text-align:center;font-size:13px;color:#627586;padding:30px}.top{position:fixed;bottom:20px;right:20px;background:var(--navy);color:white;padding:8px 16px;border-radius:30px;text-decoration:none}dialog{padding:14px;border:0;border-radius:9px;width:min(96vw,1500px);max-height:94vh;background:#fff}dialog::backdrop{background:#0e233cc9}dialog img{display:block;width:100%;height:auto}dialog button{position:sticky;top:0;float:right;border:0;border-radius:6px;background:var(--navy);color:#fff;padding:10px 20px;cursor:pointer} @media(max-width:700px){nav{grid-template-columns:1fr}section{padding:22px}h2{font-size:24px}}@media print{body{background:white}nav,.top,dialog{display:none}section{break-before:page;border:0;padding:0}header{background:white;color:#18354d}header p{color:#627586}.screenshot{border:0}}
</style><header id="top"><h1>Supplier Hub · 화면으로 따라하는 운영 매뉴얼</h1><p>2026.09.15 기준 · 화면을 누르면 원본 크기로 확대됩니다.</p></header><main><nav>'''+nav+'</nav>'+''.join(pages)+'''</main><a class="top" href="#top">목차 ↑</a><footer>로컬 운영 화면과 개발 명세를 기준으로 작성했습니다. 화면의 상태는 캡처 시점의 사례입니다.</footer><dialog id="zoom"><button type="button">닫기 ×</button><img alt="확대 화면"></dialog><script>const zoom=document.querySelector('#zoom');document.querySelectorAll('.screenshot').forEach(b=>b.addEventListener('click',()=>{zoom.querySelector('img').src=b.querySelector('img').src;zoom.querySelector('img').alt=b.querySelector('img').alt;zoom.showModal()}));zoom.querySelector('button').addEventListener('click',()=>zoom.close());zoom.addEventListener('click',e=>{if(e.target===zoom)zoom.close()});</script></html>''',encoding='utf-8')

overflows=[v for v in checks if v[1]>710 and not (v[2].startswith('2026.09.15') or re.match(r'\d\d / 13',v[2]))]
(OUT/'layout-check.json').write_text(json.dumps({'pages':count,'overflow':overflows,'elements':checks,'pdf':str(PDF),'html':str(HTML)},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'pages':count,'overflow':overflows,'pdf':str(PDF),'html':str(HTML)},ensure_ascii=False))
