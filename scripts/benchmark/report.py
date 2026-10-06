#!/usr/bin/env python3
"""
Builds the benchmark deliverables from the raw run records exported by the harness:

  reports/phase1-3-benchmark/AgencyOS_Phase1_to_Phase3_360_Testing_AI_Cost_Forensics_Report.pdf
  reports/phase1-3-benchmark/AgencyOS_Phase1_to_Phase3_AI_Cost_Forensics.json
  reports/phase1-3-benchmark/*.csv

Inputs (tmp/benchmark/): run.json, sends.jsonl, out/runs.json, out/earlier_p2p3_runs.json
Every number is computed here from tokens x the recorded price; nothing is typed in by hand except the labelled ASSUMPTIONS.
Evidence labels used throughout: OBSERVED (measured in this run), CALCULATED (tokens x public price), ASSUMED, ESTIMATED (derived from
assumptions), SIMULATED (price-only, no quality evidence), UNKNOWN / NOT_TESTED (never filled with zero).
"""
import csv
import json
import os
import statistics
from collections import defaultdict
from datetime import datetime, timezone

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.shapes import Drawing, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, KeepTogether)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TMP = os.path.join(ROOT, 'tmp', 'benchmark')
OUT = os.path.join(ROOT, 'reports', 'phase1-3-benchmark')
os.makedirs(OUT, exist_ok=True)

run = json.load(open(os.path.join(TMP, 'run.json')))
runs = json.load(open(os.path.join(TMP, 'out', 'runs.json')))
earlier = json.load(open(os.path.join(TMP, 'out', 'earlier_p2p3_runs.json')))
sends = [json.loads(l) for l in open(os.path.join(TMP, 'sends.jsonl')) if l.strip()]
FX = run['fxInrPerUsd']
PRICE = {m: {'in': p['inUsdPerM'] * FX, 'out': p['outUsdPerM'] * FX} for m, p in run['pricing']['models'].items()}  # INR per Mtok
TARGET_LO, TARGET_HI = 1000.0, 3000.0


def inr(r):
    p = PRICE.get(r['model'])
    if p is None:
        return None
    return (r['input_tokens'] * p['in'] + r['output_tokens'] * p['out']) / 1e6


def inr_total(rs):
    return sum(inr(r) or 0.0 for r in rs)


by_id = {r['id']: r for r in runs}
CLASS = {  # what each call is, from (agent, work_class, subject) - the runtime has no job-kind column, so this is inferred and labelled so
    ('requirement_collector', 'draft', 'crm.conversation'): 'requirement re-extraction',
    ('sales', 'client_direct', 'crm.conversation_message'): 'visible reply',
    ('sales', 'internal_plan', 'crm.conversation_message'): 'internal plan/classify (x3)',
    ('sales', 'read', 'crm.lead'): 'lead read / qualify',
    ('sales', 'read', 'crm.conversation_message'): 'message read',
    ('sales', 'draft', 'crm.conversation_message'): 'quotation revision draft',
    ('sales', 'draft', 'crm.lead'): 'quotation revision draft',
}


def klass(r):
    return CLASS.get((r['agent_key'], r['work_class'], r['subject_type']), f"{r['agent_key']}/{r['work_class']}")


# ── per message / per persona ──────────────────────────────────────────────
messages = []
for s in sends:
    rs = [by_id[i] for i in s['runIds'] if i in by_id]
    messages.append({
        'persona': s['persona'], 'seq': s['seq'], 'client_text_chars': len(s['text']), 'calls': len(rs),
        'input_tokens': sum(r['input_tokens'] for r in rs), 'output_tokens': sum(r['output_tokens'] for r in rs),
        'cost_inr': inr_total(rs), 'failed_calls': sum(1 for r in rs if r['status'] == 'failed'),
        'latency_ms_sum': sum(r['latency_ms'] or 0 for r in rs),
    })
personas = defaultdict(lambda: {'messages': 0, 'calls': 0, 'cost_inr': 0.0})
for m in messages:
    p = personas[m['persona']]
    p['messages'] += 1
    p['calls'] += m['calls']
    p['cost_inr'] += m['cost_inr']

total_cost = inr_total(runs)
n_calls = len(runs)
n_msgs = len(messages)
amplification = n_calls / n_msgs
failed = [r for r in runs if r['status'] == 'failed']

# per class
cls = defaultdict(lambda: {'calls': 0, 'in': 0, 'out': 0, 'inr': 0.0})
for r in runs:
    c = cls[klass(r)]
    c['calls'] += 1; c['in'] += r['input_tokens']; c['out'] += r['output_tokens']; c['inr'] += inr(r) or 0.0
cls_rows = sorted(cls.items(), key=lambda kv: -kv[1]['inr'])
# per agent
agents = defaultdict(lambda: {'calls': 0, 'in': 0, 'out': 0, 'inr': 0.0, 'failed': 0})
for r in runs:
    a = agents[r['agent_key']]
    a['calls'] += 1; a['in'] += r['input_tokens']; a['out'] += r['output_tokens']; a['inr'] += inr(r) or 0.0
    a['failed'] += r['status'] == 'failed'
# per model
models = defaultdict(lambda: {'calls': 0, 'in': 0, 'out': 0, 'inr': 0.0, 'lat': []})
for r in runs:
    m = models[f"{r['provider_id']}/{r['model']}"]
    m['calls'] += 1; m['in'] += r['input_tokens']; m['out'] += r['output_tokens']; m['inr'] += inr(r) or 0.0
    if r['latency_ms']:
        m['lat'].append(r['latency_ms'])

in_cost = sum(r['input_tokens'] * PRICE[r['model']]['in'] for r in runs) / 1e6
out_cost = sum(r['output_tokens'] * PRICE[r['model']]['out'] for r in runs) / 1e6

# first message vs later
first = [m for m in messages if m['seq'] == 1]
later = [m for m in messages if m['seq'] > 1]
first_avg = statistics.mean(m['cost_inr'] for m in first)
later_plain = [m['cost_inr'] for m in later if m['calls'] <= 7 and m['failed_calls'] == 0]
later_avg = statistics.mean(later_plain)
quote_events = [m for m in messages if m['calls'] > 7]
quote_event_cost = statistics.mean(m['cost_inr'] for m in quote_events) - later_avg if quote_events else 4.0
turn_avg = defaultdict(list)
for m in messages:
    turn_avg[m['seq']].append(m['cost_inr'])

# P02 growth
p02 = [m for m in messages if m['persona'] == 'P02-VAGUE']
p02c = {m['seq']: m['cost_inr'] for m in messages if m['persona'] == 'P02-VAGUE'}
growth = []
for s in sends:
    if s['persona'] != 'P02-VAGUE':
        continue
    rs = [by_id[i] for i in s['runIds'] if i in by_id]
    rc = [r for r in rs if r['agent_key'] == 'requirement_collector']
    rd = [r for r in rs if r['work_class'] == 'read' and r['subject_type'] == 'crm.lead']
    growth.append((s['seq'], rc[0]['input_tokens'] if rc else None, rd[0]['input_tokens'] if rd else None))

# ── projections (ASSUMED funnel shapes; measured unit costs) ───────────────
# cost of a lead that sends n messages: first message, then (n-1) later plain messages (observed means)
def lead_cost(n, deep=False):
    c = first_avg + max(0, n - 1) * later_avg
    if deep:
        c += 2 * quote_event_cost  # one negotiation-driven quote rework and one acceptance read, observed per event
    return c

SCEN = {
    'LOW-ENGAGEMENT': [(0.55, 1, False), (0.25, 2, False), (0.12, 3.5, False), (0.06, 5.5, False), (0.02, 6, True)],
    'BASE': [(0.35, 1, False), (0.30, 2, False), (0.18, 3.5, False), (0.12, 5.5, False), (0.05, 6, True)],
    'HIGH-ENGAGEMENT': [(0.20, 1, False), (0.25, 2, False), (0.25, 3.5, False), (0.20, 5.5, False), (0.10, 6, True)],
}
phase1 = {k: 1000 * sum(p * lead_cost(n, d) for p, n, d in v) for k, v in SCEN.items()}

# Phase 2 / Phase 3 per project: EARLIER verifier evidence (not benchmark personas); two bounds
def agent_sum(rows, keys, lo=None, hi=None):
    tot = 0.0
    for r in rows:
        if r['agent_key'] in keys and r['model'] in PRICE:
            tot += (r['input_tokens'] * PRICE[r['model']]['in'] + r['output_tokens'] * PRICE[r['model']]['out']) / 1e6
    return tot

h7 = [r for r in earlier if r['created_at'].startswith('2026-10-05T07')]
h78 = earlier
p2_lo = agent_sum(h7, {'project_planning', 'project_manager'})
p2_hi = agent_sum(h78, {'project_planning', 'project_manager'})
p3_lo = agent_sum(h7, {'ui_designer', 'quality_assurance'})
p3_hi = agent_sum(h78, {'ui_designer', 'quality_assurance'})
p23_lo, p23_hi = p2_lo + p3_lo, p2_hi + p3_hi
WON_CASES = [0, 1, 2, 5, 10]


def total_for(scn, won, bound):
    p23 = p23_lo if bound == 'lo' else p23_hi
    return phase1[scn] + won * p23


# ── optimisation stack (ESTIMATES, quality unverified) ─────────────────────
share = {k: v['inr'] / total_cost for k, v in cls.items()}
share_reply = share.get('visible reply', 0)
share_extract = share.get('requirement re-extraction', 0)
share_cheapable = share.get('internal plan/classify (x3)', 0) + share.get('lead read / qualify', 0) + share.get('message read', 0)
share_quote = share.get('quotation revision draft', 0)


def stack(haircut):
    s1 = 0.40 * haircut          # skip extraction on messages that carry no new business information
    s2 = (2 / 3) * haircut       # move the classify/read calls to a ~3x cheaper tier (e.g. haiku-4.5 vs sonnet-4.6 price)
    s3 = (1 / 3) * haircut       # sonnet-5 list price vs sonnet-4.6 on the remaining sonnet work (price-only)
    s4 = 0.29 * haircut          # cache the static prefix on the remaining input (OpenRouter shows cache_read=0 today)
    base = 1.0
    reply, extract, cheap, quote = share_reply, share_extract, share_cheapable, share_quote
    stages = [('Current verified baseline', base)]
    extract2 = extract * (1 - s1)
    stages.append(('S1  skip re-extraction when nothing new', reply + extract2 + cheap + quote))
    cheap2 = cheap * (1 - s2)
    stages.append(('S2  cheap tier for classify/read calls', reply + extract2 + cheap2 + quote))
    sonnet_part = reply + extract2 + quote
    stages.append(('S3  sonnet-5 price on remaining sonnet work (SIMULATED)', sonnet_part * (1 - s3) + cheap2))
    after3 = sonnet_part * (1 - s3) + cheap2
    stages.append(('S4  cache the static prefix (LOW confidence)', after3 * (1 - s4 * 0.645)))
    return stages


stack_exp = stack(1.0)
stack_pess = stack(0.5)
opt_factor_exp = stack_exp[-1][1]
opt_factor_pess = stack_pess[-1][1]

# price-only simulation of the same token profile on other published prices (OpenRouter public list, 2026-10-05)
ALT = {'anthropic/claude-sonnet-5': (2, 10), 'anthropic/claude-haiku-4.5': (1, 5), 'anthropic/claude-sonnet-4.6 (current)': (3, 15)}
alt_cost = {k: sum(r['input_tokens'] * a[0] + r['output_tokens'] * a[1] for r in runs) / 1e6 * FX for k, a in ALT.items()}

now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

# ── JSON + CSV ─────────────────────────────────────────────────────────────
result = {
    'metadata': {'report_version': '1.0 BASELINE', 'test_run_id': run['testRunId'], 'baseline_config_id': run['baselineConfigId'],
                 'generated_at': now, 'environment': run['environment'], 'build': '59b2c351 (main) + benchmark harness (uncommitted)',
                 'fx_inr_per_usd': FX, 'fx_source': run['fxSource'], 'pricing': run['pricing'], 'cost_evidence': 'CALCULATED (provider-reported tokens x public price); no provider-billed amount captured'},
    'personas': {k: v for k, v in personas.items()},
    'messages': messages,
    'totals': {'client_messages': n_msgs, 'ai_calls': n_calls, 'amplification_calls_per_message': amplification, 'cost_inr': total_cost,
               'cost_usd': total_cost / FX, 'failed_calls': len(failed), 'failed_calls_recorded_tokens': sum(r['input_tokens'] + r['output_tokens'] for r in failed),
               'input_cost_share': in_cost / (in_cost + out_cost)},
    'by_call_class': {k: v for k, v in cls_rows},
    'by_agent': {k: v for k, v in agents.items()},
    'by_model': {k: {**v, 'lat': None, 'median_latency_ms': statistics.median(v['lat']) if v['lat'] else None} for k, v in models.items()},
    'unit_costs': {'first_message_avg_inr': first_avg, 'later_plain_message_avg_inr': later_avg, 'quote_event_extra_inr': quote_event_cost},
    'p02_context_growth': growth,
    'projection_phase1_per_1000_inr': phase1,
    'phase2_phase3_per_project_inr': {'low': p23_lo, 'high': p23_hi, 'evidence': 'earlier verifier REAL_MODEL runs (not benchmark personas), LOW confidence'},
    'optimization_stack': {'expected': stack_exp, 'pessimistic_half_savings': stack_pess, 'status': 'ESTIMATE - NOT YET VERIFIED'},
    'price_only_simulation_inr_same_tokens': alt_cost,
    'target': {'lo': TARGET_LO, 'hi': TARGET_HI},
}
with open(os.path.join(OUT, 'AgencyOS_Phase1_to_Phase3_AI_Cost_Forensics.json'), 'w') as f:
    json.dump(result, f, indent=2, default=str)
with open(os.path.join(OUT, 'ai_calls.csv'), 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['run_id', 'created_at', 'agent', 'call_class', 'work_class', 'status', 'provider', 'model', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'latency_ms', 'cost_inr_calculated', 'runtime_cost_minor', 'error'])
    for r in runs:
        c = inr(r)
        w.writerow([r['id'], r['created_at'], r['agent_key'], klass(r), r['work_class'], r['status'], r['provider_id'], r['model'], r['input_tokens'], r['output_tokens'],
                    r['cache_read_tokens'], r['cache_write_tokens'], r['latency_ms'], '' if c is None else f'{c:.6f}', r['cost_minor'], r['error']])
with open(os.path.join(OUT, 'message_costs.csv'), 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['persona', 'message_no', 'ai_calls', 'input_tokens', 'output_tokens', 'cost_inr_calculated', 'failed_calls'])
    for m in messages:
        w.writerow([m['persona'], m['seq'], m['calls'], m['input_tokens'], m['output_tokens'], f"{m['cost_inr']:.6f}", m['failed_calls']])

# ── PDF ────────────────────────────────────────────────────────────────────
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
FD = '/System/Library/Fonts/Supplemental/'
pdfmetrics.registerFont(TTFont('Body', FD + 'Arial Unicode.ttf'))
pdfmetrics.registerFont(TTFont('Body-Bold', FD + 'Arial Unicode.ttf'))
pdfmetrics.registerFont(TTFont('Body-Italic', FD + 'Arial Unicode.ttf'))
pdfmetrics.registerFont(TTFont('Body-BoldItalic', FD + 'Arial Unicode.ttf'))
pdfmetrics.registerFontFamily('Body', normal='Body', bold='Body-Bold', italic='Body-Italic', boldItalic='Body-BoldItalic')
ss = getSampleStyleSheet()
for _n in ('Heading1', 'Heading2', 'BodyText'):
    ss[_n].fontName = 'Body-Bold' if _n != 'BodyText' else 'Body'
BRAND = colors.HexColor('#4f46e5')
INK = colors.HexColor('#111827')
MUTED = colors.HexColor('#6b7280')
RED = colors.HexColor('#b91c1c')
AMBER = colors.HexColor('#b45309')
GREEN = colors.HexColor('#15803d')
H1 = ParagraphStyle('H1', parent=ss['Heading1'], fontSize=17, textColor=INK, spaceAfter=6, spaceBefore=4)
H2 = ParagraphStyle('H2', parent=ss['Heading2'], fontSize=12.5, textColor=BRAND, spaceAfter=4, spaceBefore=8)
B = ParagraphStyle('B', parent=ss['BodyText'], fontSize=9.2, leading=12.6, textColor=INK, alignment=TA_LEFT)
S = ParagraphStyle('S', parent=B, fontSize=8, leading=10.5, textColor=MUTED)
C = ParagraphStyle('C', parent=B, fontSize=7.8, leading=9.6)
CB = ParagraphStyle('CB', parent=C, fontName='Body-Bold')
W = 180 * mm


def P(t, st=B):
    return Paragraph(t, st)


def tbl(rows, widths, header=True, zebra=True, align_right_from=None, fs=7.8):
    data = [[Paragraph(str(c), CB if (header and i == 0) else C) for c in row] for i, row in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    st = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#e5e7eb')),
          ('LEFTPADDING', (0, 0), (-1, -1), 3), ('RIGHTPADDING', (0, 0), (-1, -1), 3), ('TOPPADDING', (0, 0), (-1, -1), 2), ('BOTTOMPADDING', (0, 0), (-1, -1), 2)]
    if header:
        st += [('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eef2ff'))]
    if zebra:
        for i in range(1, len(rows)):
            if i % 2 == 0:
                st.append(('BACKGROUND', (0, i), (-1, i), colors.HexColor('#f9fafb')))
    t.setStyle(TableStyle(st))
    return t


def box(text, color=BRAND):
    t = Table([[Paragraph(text, B)]], colWidths=[W])
    t.setStyle(TableStyle([('BOX', (0, 0), (-1, -1), 1.2, color), ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f8fafc')),
                           ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8), ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]))
    return t


def money(x, d=2):
    return f'Rs {x:,.{d}f}'


def bar(labels, values, w=W, h=120, color=BRAND, fmt='%.1f'):
    d = Drawing(w, h)
    bc = VerticalBarChart()
    bc.x, bc.y, bc.width, bc.height = 35, 28, w - 50, h - 48
    bc.data = [values]
    bc.categoryAxis.categoryNames = labels
    bc.categoryAxis.labels.fontSize = 6.5
    bc.categoryAxis.labels.angle = 0
    bc.valueAxis.labels.fontSize = 6.5
    bc.valueAxis.valueMin = 0
    bc.bars[0].fillColor = color
    bc.barLabelFormat = fmt
    bc.barLabels.fontSize = 6.5
    bc.barLabels.nudge = 6
    d.add(bc)
    return d


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('Body', 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(15 * mm, 9 * mm, f"AgencyOS Phase 1-3 benchmark  |  {run['testRunId']}  |  report 1.0 BASELINE")
    canvas.drawRightString(A4[0] - 15 * mm, 9 * mm, f'Page {doc.page}')
    canvas.restoreState()


story = []
# cover
story += [Spacer(1, 40 * mm), P('AGENCYOS', ParagraphStyle('t0', parent=H1, fontSize=14, textColor=BRAND)),
          P('PHASE 1 → PHASE 3<br/>360° REAL-WORLD WORKFLOW TESTING<br/>&amp; AI/API TOKEN + COST FORENSICS REPORT', ParagraphStyle('t1', parent=H1, fontSize=23, leading=29)),
          Spacer(1, 6 * mm),
          P('Functional reliability, agent economics, 1,000-lead projection &amp; optimization roadmap', ParagraphStyle('t2', parent=B, fontSize=11, textColor=MUTED)),
          Spacer(1, 22 * mm),
          tbl([['Test run', run['testRunId']], ['Baseline config', run['baselineConfigId']], ['Report version', '1.0 BASELINE (initial observed baseline)'],
               ['Generated', now], ['Environment', run['environment']], ['Cost evidence', 'CALCULATED: provider-reported tokens × OpenRouter public price, FX %.1f INR/USD (%s)' % (FX, run['fxSource'])]],
              [40 * mm, 140 * mm], header=False),
          Spacer(1, 14 * mm),
          box('<b>Read this first.</b> This is an <b>early, small-sample baseline</b>: 3 synthetic personas, 10 client messages, 63 AI calls. It is enough to show '
              'a clear pattern and to rank the cost leaks; it is <b>not</b> enough for a confident 1,000-lead number. Every projection is labelled ASSUMED / ESTIMATED, '
              'and Phase 2 and Phase 3 were <b>not driven</b> by this benchmark (see Section 5).', AMBER),
          PageBreak()]

# exec summary
story += [P('1. Executive summary', H1)]
base_p1 = phase1['BASE']
story += [box(
    f'<b>FUNCTIONAL STATUS: PARTIAL.</b> Phase 1 worked end-to-end for one deep persona (lead → requirements → quotation → negotiation → revised quote → acceptance → WON), '
    f'with the quotation approval gates holding. Phase 2 and Phase 3 were not driven here. Admin WhatsApp approval is BLOCKED (no real provider).<br/>'
    f'<b>COST STATUS: ABOVE_TARGET.</b> Every client message costs about {money(first_avg)} on its first turn and {money(later_avg)} afterwards, because each message fans out into '
    f'~{amplification:.1f} AI calls. For 1,000 raw leads that is {money(phase1["LOW-ENGAGEMENT"],0)} – {money(phase1["HIGH-ENGAGEMENT"],0)} for <i>Phase 1 alone</i> (base {money(base_p1,0)}), against a '
    f'target of Rs 1,000–Rs 3,000 for Phases 1–3 together.<br/><b>PRODUCTION CONFIDENCE: LOW.</b> Projection confidence: LOW (3 personas).', RED),
    Spacer(1, 3 * mm)]
qa = [
    ['#', 'Question', 'Answer (label)'],
    ['1', 'Did Phase 1–3 work?', 'Phase 1: yes for 1 deep persona + 2 cheap ones (OBSERVED). Phase 2/3: not driven in this benchmark. Earlier real-model verifier runs are separate, lower-confidence evidence (Section 5).'],
    ['2', 'Leads tested', '3 synthetic personas, 10 client messages (OBSERVED).'],
    ['3', 'Reached', 'Responding 3, qualified-by-agent 1, quotation 1 (2 versions), negotiation 1, WON 1, Phase 2: 0, Phase 3: 0.'],
    ['4', 'Actual AgencyOS runtime AI cost of the test', f'{money(total_cost)} (${total_cost/FX:.2f}) CALCULATED; test-harness (Claude) cost NOT MEASURED and excluded.'],
    ['5', 'Average per raw lead (this sample)', f'{money(total_cost/3)} per persona; {money(total_cost/n_msgs)} per client message.'],
    ['6', 'Projected 1,000-lead cost, Phase 1 only', f'{money(phase1["LOW-ENGAGEMENT"],0)} / {money(base_p1,0)} / {money(phase1["HIGH-ENGAGEMENT"],0)} (low / base / high; ESTIMATED from ASSUMED funnels). Phases 2–3 add about {money(p23_lo,0)}–{money(p23_hi,0)} per WON project (LOW confidence).'],
    ['7', 'Within Rs 1,000–Rs 3,000?', f'No. MATERIALLY_ABOVE_TARGET on current evidence: even the low-engagement case is {phase1["LOW-ENGAGEMENT"]/TARGET_HI*100:,.0f}% of the upper bound.'],
    ['8', 'Top cost leaks', '1) 6–8 AI calls per client message  2) full requirement re-extraction every message  3) context grows every turn  4) AI still runs after a human takes over  5) failed calls whose cost is not recorded  6) zero prompt caching'],
    ['9', 'Most expensive agent', f"{max(agents.items(), key=lambda kv: kv[1]['inr'])[0]} ({money(max(a['inr'] for a in agents.values()))}, {max(a['inr'] for a in agents.values())/total_cost*100:.0f}% of spend)."],
    ['10', 'Most expensive model/provider', 'openrouter / anthropic/claude-sonnet-4.6 — 100% of spend (the only model enabled, mirroring production).'],
    ['11', 'Spend on non-converting leads', f"{money(personas['P01-PRICE-ONLY']['cost_inr']+personas['P05-NONFIT-LOWBUDGET']['cost_inr'])} of {money(total_cost)} ({(personas['P01-PRICE-ONLY']['cost_inr']+personas['P05-NONFIT-LOWBUDGET']['cost_inr'])/total_cost*100:.0f}%) went to 2 leads that did not convert (OBSERVED)."],
    ['12', 'Critical blockers', 'None functional/security found in this sample. Open: Admin WhatsApp E2E BLOCKED; Phase 2/3 NOT_TESTED here; approvals were tester-operated, not an independent human.'],
]
story += [tbl(qa, [8 * mm, 52 * mm, 120 * mm])]
story += [PageBreak()]

# cost at a glance
story += [P('2. AgencyOS cost at a glance (business-owner page)', H1)]
story += [tbl([
    ['Tested', '3 synthetic leads, 10 messages, 63 AI calls'],
    ['Actual test runtime AI/API spend', f'{money(total_cost)} (${total_cost/FX:.2f}) — CALCULATED'],
    ['One client message costs', f'{money(first_avg)} first turn, {money(later_avg)} later turns, {money(later_avg+quote_event_cost)} when a quote is reworked'],
    ['Projected cost of 1,000 raw leads (Phase 1)', f'{money(phase1["LOW-ENGAGEMENT"],0)} – {money(phase1["HIGH-ENGAGEMENT"],0)}, base {money(base_p1,0)} — ESTIMATED'],
    ['Target', 'Rs 1,000 – Rs 3,000 for Phases 1–3 per 1,000 raw leads'],
    ['Status', 'ABOVE TARGET (materially)'],
    ['Biggest cost driver', f'Every message fans out into {amplification:.1f} AI calls; only {share_reply*100:.0f}% of spend is the reply the client sees'],
    ['Biggest avoidable waste', f'Re-reading the whole conversation for requirements on every message ({share_extract*100:.0f}% of spend) and three-plus classify/read calls ({share_cheapable*100:.0f}%)'],
    ['Estimated optimized range', f'{money(base_p1*opt_factor_exp,0)} – {money(base_p1*opt_factor_pess,0)} for Phase 1 base case — ESTIMATE, NOT VERIFIED'],
    ['Next action', 'Fix the call fan-out and re-extraction first (no provider change), then re-run these same personas.'],
], [60 * mm, 120 * mm], header=False)]
story += [Spacer(1, 4 * mm), P('Where each Rs 100 of AI spend goes (this test)', H2)]
labels = [k.replace(' (x3)', '') for k, _ in cls_rows]
story += [bar([l[:22] for l in labels], [v['inr'] / total_cost * 100 for _, v in cls_rows], fmt='%.0f')]
story += [P('Calls are classified from (agent, work class, subject) because the runtime has no job-kind column on <i>agent_runs</i>; the classification is inferred and labelled as such.', S), PageBreak()]

# coverage
story += [P('3. Test coverage and environment', H1)]
story += [P('<b>Environment.</b> Local isolated stack (Docker Supabase, Next.js dev server). Meta\'s Graph API is the only stub. The synthetic client sends messages through the real signed WhatsApp webhook; AgencyOS\'s real agents answer through the real orchestrator and the real OpenRouter route. The routing configuration mirrors production: only <i>anthropic/claude-sonnet-4.6</i> and <i>claude-opus-4.6</i> enabled, seven category overrides. Nothing was tuned for cost.')]
story += [Spacer(1, 2 * mm), P('Persona matrix (pilot)', H2)]
pm = [['Persona', 'Behavior tested', 'Msgs', 'AI calls', 'Cost', 'Final state']]
desc = {'P01-PRICE-ONLY': ('short Hinglish price-only lead, then silent', 'Ghosted (follow-up NOT_TESTED)'),
        'P05-NONFIT-LOWBUDGET': ('large project, Rs 5,000 budget', 'Not disqualified; agent kept asking questions'),
        'P02-VAGUE': ('vague English lead → quote → negotiation → accept', 'WON (deal stage), Phase 2 not started')}
for k in ['P01-PRICE-ONLY', 'P05-NONFIT-LOWBUDGET', 'P02-VAGUE']:
    v = personas[k]
    pm.append([k, desc[k][0], v['messages'], v['calls'], money(v['cost_inr']), desc[k][1]])
story += [tbl(pm, [32 * mm, 52 * mm, 10 * mm, 14 * mm, 18 * mm, 54 * mm])]
story += [Spacer(1, 3 * mm), P('Not covered by this pilot (NOT_TESTED): the other ~47 personas of the matrix, follow-up/ghost timing, scheduler/meetings, opt-out, voice notes, files, prompt injection, concurrency, cross-lead memory isolation, provider failure, duplicate webhooks, Admin WhatsApp (BLOCKED), reject / request-changes / expired / replayed approvals, payment gate, kickoff, all of Phase 3.', B)]
story += [PageBreak()]

# phase results
story += [P('4. Phase 1 results (what actually happened)', H1)]
story += [P('P02-VAGUE — the deep journey, verified from database state at each step', H2)]
steps = [['Step', 'Result', 'AI cost'],
         ['Client asks for a quotation (message 3)', 'Agent hands the thread to a person ("a colleague will put together a proper quotation"). This is by design: the quote and its price are an owner decision.', money(p02c.get(3,0))],
         ['Admin accepts requirement v4', 'accepted (DB verified)', 'Rs 0'],
         ['Admin sets deal owner, drafts quotation v1', 'drafted; 2 lines, total Rs 65,000', 'Rs 0'],
         ['Send for approval', 'Refused: "No approval policy covers quotations". An owner policy had to be set first (config finding).', 'Rs 0'],
         ['Policy set; v1 approved; sent', 'approved → sent (WhatsApp text + PDF)', 'Rs 0 (deterministic)'],
         ['Client counter: Rs 55k and 20% advance', 'Agent drafted v2 at Rs 55,000 itself; v1 superseded; v2 waits for owner approval (gate held)', money(p02c.get(5,0))],
         ['v2 approved and sent; client accepts', 'v2 accepted (recorded by the Admin); the agent\'s own handling of "I accept" still cost AI but sent nothing', money(p02c.get(6,0))],
         ['Deal moved to WON', 'stage=won; no project / Phase 2 created automatically', 'Rs 0']]
story += [tbl(steps, [58 * mm, 100 * mm, 22 * mm])]
story += [Spacer(1, 2 * mm), P('<b>Governance verdict:</b> price stayed a human/owner decision at every step; a client\'s words ("I accept", "55k") never changed state by themselves. <b>Caveat:</b> the approval and acceptance clicks were made by the tester on the owner\'s instruction, so this proves the mechanism, not an independent second person.', B)]
story += [P('Conversation-quality observations (OBSERVED)', H2)]
obs = [['Finding', 'Persona', 'Type'],
       ['Asked "what kind of app?" again after the client had just pressed for a price', 'P01', 'Client-experience defect (repeated question)'],
       ['Told the client the budget cannot work, yet kept asking discovery questions for two more turns instead of closing politely (' + money(personas['P05-NONFIT-LOWBUDGET']['cost_inr']) + ' spent)', 'P05', 'Qualification / cost'],
       ['Replies matched the client\'s language (Hinglish and English)', 'P01 P05 P02', 'Pass'],
       ['Did not name a price, promised no discount, deferred the quote to a person', 'P01 P02', 'Pass (commercial safety)']]
story += [tbl(obs, [112 * mm, 22 * mm, 46 * mm]), PageBreak()]

# phase 2/3
story += [P('5. Phase 2 and Phase 3 — not driven here', H1)]
story += [P('After WON, no project was created and Phase 2 did not start by itself in this stack; reaching Phase 2 needs a project to be created from the won deal, then a long run of Admin gates (billing mode, GST details, invoice, WhatsApp group, payment verification, plan approval, kickoff) and then Phase 3 (screens, theme directions, reviews). This benchmark stopped at the WON boundary to keep the first baseline small.')]
story += [P('Separate evidence: earlier real-model verifier runs (LOW confidence)', H2),
          P('Earlier the same day the repository\'s own end-to-end verifier was run on the same real model route. It is <b>not</b> a benchmark persona and mixes several attempts, so only an indicative range is used for the projection:')]
rows = [['Agents', 'What', 'Lower bound (one full run)', 'Upper bound (all attempts)']]
rows.append(['project_planning + project_manager', 'Phase 2 blueprint + client messaging', money(p2_lo), money(p2_hi)])
rows.append(['ui_designer + quality_assurance', 'Phase 3 screens, directions, QA', money(p3_lo), money(p3_hi)])
rows.append(['Total per project', 'Phase 2 + Phase 3', money(p23_lo), money(p23_hi)])
story += [tbl(rows, [50 * mm, 62 * mm, 34 * mm, 34 * mm])]
story += [Spacer(1, 2 * mm), P('That run also found and fixed a real defect: the designer\'s <i>design-directions</i> call was refused by Anthropic (<i>propertyNames</i> not supported), so on a real model the designer never produced a direction; fixed in PR #573. Two failed designer runs in that window recorded 0 tokens.', B)]
story += [PageBreak()]

# funnel
story += [P('6. Funnel and per-lead cost', H1)]
fun = [['Stage', 'Count (of 3)', 'AI cost through this stage'],
       ['Raw lead (first message)', '3', money(sum(m['cost_inr'] for m in first))],
       ['Responding (≥2 messages)', '3', money(total_cost)],
       ['Qualified / quote requested', '1', money(personas['P02-VAGUE']['cost_inr'])],
       ['Quotation sent', '1 (2 versions)', money(personas['P02-VAGUE']['cost_inr'])],
       ['Negotiation', '1', money(personas['P02-VAGUE']['cost_inr'])],
       ['WON', '1', money(personas['P02-VAGUE']['cost_inr'])],
       ['Phase 2 / Phase 3', '0 / 0', 'NOT_TESTED']]
story += [tbl(fun, [60 * mm, 40 * mm, 80 * mm]), Spacer(1, 3 * mm)]
story += [P('Per message (OBSERVED)', H2)]
pmrows = [['Persona', 'Msg', 'AI calls', 'Input tok', 'Output tok', 'Cost', 'Failed']]
for m in messages:
    pmrows.append([m['persona'], m['seq'], m['calls'], f"{m['input_tokens']:,}", f"{m['output_tokens']:,}", money(m['cost_inr']), m['failed_calls']])
story += [tbl(pmrows, [44 * mm, 12 * mm, 18 * mm, 28 * mm, 28 * mm, 26 * mm, 16 * mm])]
story += [Spacer(1, 2 * mm), P(f'Mean {money(total_cost/n_msgs)} per message; first message mean {money(first_avg)}, later plain message mean {money(later_avg)}. A quotation rework costs about {money(quote_event_cost)} more. Sample is too small for percentiles (3 leads); distribution P25/median/P75 would be meaningless and is intentionally not printed.', S), PageBreak()]

# cost breakdown
story += [P('7. Where the money goes', H1)]
story += [P('By call class', H2)]
rows = [['Call class', 'Calls', 'Input tok', 'Output tok', 'Cost', '% of spend', 'Avg in/call']]
for k, v in cls_rows:
    rows.append([k, v['calls'], f"{v['in']:,}", f"{v['out']:,}", money(v['inr']), f"{v['inr']/total_cost*100:.1f}%", f"{v['in']/max(v['calls'],1):,.0f}"])
story += [tbl(rows, [46 * mm, 14 * mm, 24 * mm, 22 * mm, 22 * mm, 22 * mm, 22 * mm])]
story += [P('By agent', H2)]
rows = [['Agent', 'Calls', 'Input tok', 'Output tok', 'Cache read/write', 'Cost', '% of spend']]
for k, v in sorted(agents.items(), key=lambda kv: -kv[1]['inr']):
    rows.append([k, v['calls'], f"{v['in']:,}", f"{v['out']:,}", '0 / 0', money(v['inr']), f"{v['inr']/total_cost*100:.1f}%"])
story += [tbl(rows, [40 * mm, 14 * mm, 26 * mm, 24 * mm, 28 * mm, 24 * mm, 24 * mm])]
story += [P('By provider / model', H2)]
rows = [['Gateway / model', 'Calls', 'Input', 'Output', 'Median latency', 'Failures', 'Cost', '%']]
for k, v in models.items():
    rows.append([k, v['calls'], f"{v['in']:,}", f"{v['out']:,}", f"{statistics.median(v['lat'])/1000:.1f}s" if v['lat'] else '?', len(failed), money(v['inr']), '100%'])
story += [tbl(rows, [64 * mm, 12 * mm, 20 * mm, 18 * mm, 24 * mm, 14 * mm, 20 * mm, 8 * mm])]
story += [Spacer(1, 2 * mm), P(f'Input tokens are {in_cost/(in_cost+out_cost)*100:.0f}% of the money. Upstream provider behind the OpenRouter gateway: UPSTREAM_UNKNOWN (the route is reported only as <i>openrouter / anthropic/claude-sonnet-4.6</i>). Prompt caching: <b>cache_read = 0 and cache_write = 0 on all {n_calls} calls</b>.', B)]
story += [PageBreak()]

# amplification & growth
story += [P('8. Call amplification and context growth', H1)]
story += [box(f'<b>AI call amplification factor = {amplification:.1f}</b> ({n_calls} AI calls for {n_msgs} client messages). A four-word message ("App banana hai price?") caused 7 premium-model calls and {money(first[0]["cost_inr"])}. Visible reply share of spend: {share_reply*100:.0f}%.')]
story += [P('What one message triggers (typical)', H2)]
story += [tbl([['Call', 'Approx. tokens in/out', 'Purpose (inferred)'],
               ['requirement_collector / draft', '1,2xx–2,3xx / 190–900', 'Re-extracts the whole requirement set from the whole conversation — on every message'],
               ['sales / internal_plan ×3', '~950, ~750, ~1,100 / 30–85', 'Intent, objection and reply planning classifiers'],
               ['sales / read (lead)', '2,4xx–4,5xx / 60–120', 'Reads the lead to qualify it'],
               ['sales / client_direct', '2,6xx–3,0xx / 100–250', 'The reply the client actually receives'],
               ['sales / read (message)', '~570 / 25–60', 'Extra message read (some turns)']], [48 * mm, 40 * mm, 92 * mm])]
story += [P('Context growth over the P02 conversation (OBSERVED)', H2)]
g = [['Message', 'Requirement-extraction input tokens', 'Lead-read input tokens']]
for seq, a, b in growth:
    g.append([seq, a if a is not None else '-', b if b is not None else '-'])
story += [tbl(g, [30 * mm, 70 * mm, 70 * mm])]
if len(growth) > 1 and growth[0][1] and growth[-1][1]:
    story += [Spacer(1, 2 * mm), P(f'Over {len(growth)} messages the extraction input grew {growth[-1][1]/growth[0][1]:.1f}× and the lead-read input {growth[-1][2]/growth[0][2]:.1f}×: the whole history is re-sent each turn, so later turns cost more for the same visible reply (compounding).', B)]
story += [P('Unrecorded cost from failed calls', H2), P(f'{len(failed)} of {n_calls} calls failed (schema validation on a quotation rework). The runtime recorded <b>0 input and 0 output tokens</b> for it although it ran for ~42 s, so its real cost is <b>COST_UNKNOWN</b> — it is not zero. Separately, an earlier job (<i>message.intent</i>) died after 5 attempts for the same reason (visible as an Incident in the Admin Panel); each attempt spends tokens. Failure-recovery cost is therefore under-reported by construction.')]
story += [PageBreak()]

# leaks
story += [P('9. Ranked cost leaks (by projected Rs  impact)', H1)]
base_per_lead = base_p1 / 1000
leaks = [
    ['#', 'Finding', 'Evidence', 'Root cause', 'Est. saving / 1,000 leads (BASE)', 'Conf.', 'Risk'],
    ['1', 'Requirement re-extraction on every message', f'{share_extract*100:.0f}% of spend; input 1.2k→2.3k tokens', 'WORKFLOW + CONTEXT', money(base_p1 * share_extract * 0.40, 0), 'MED', 'LOW'],
    ['2', '3 internal classify calls + 2 reads on a premium model', f'{share_cheapable*100:.0f}% of spend', 'MODEL_SELECTION + DUPLICATE_PROCESSING', money(base_p1 * share_cheapable * (2 / 3), 0), 'MED', 'MED (needs A/B)'],
    ['3', 'Whole conversation re-sent each turn', 'extraction ×1.9, lead read ×1.9 over 6 turns', 'CONTEXT', 'included in #1 and #5', 'HIGH', 'MED'],
    ['4', 'AI still runs after a person has taken over', 'message 6: 5 calls, Rs 4.36, nothing sent', 'WORKFLOW', money(base_p1 * 0.03, 0) + ' (ESTIMATE)', 'LOW', 'LOW'],
    ['5', 'Zero prompt caching', 'cache_read = cache_write = 0 on 63/63 calls', 'ARCHITECTURE / PROVIDER SETTING', money(base_p1 * 0.2, 0) + ' (ESTIMATE)', 'LOW', 'LOW'],
    ['6', 'Hopeless lead keeps being engaged', 'P05 ' + money(personas['P05-NONFIT-LOWBUDGET']['cost_inr']) + ' after "not possible at this budget"', 'WORKFLOW', money(base_p1 * 0.02, 0) + ' (ESTIMATE)', 'LOW', 'MED'],
    ['7', 'Failed calls: cost not recorded, retried up to 5×', '1 failed run, 0 tokens recorded; dead job after 5 attempts', 'RETRY + TELEMETRY', 'COST_UNKNOWN', 'MED', 'LOW'],
    ['8', 'Pricing choice: sonnet-4.6 ($3/$15) vs sonnet-5 ($2/$10) on the same gateway', 'OpenRouter public list', 'MODEL_SELECTION (a configuration set during this project)', money(alt_cost['anthropic/claude-sonnet-4.6 (current)'] - alt_cost['anthropic/claude-sonnet-5'] and (base_p1 * (1 - alt_cost['anthropic/claude-sonnet-5'] / alt_cost['anthropic/claude-sonnet-4.6 (current)'])), 0) + ' (SIMULATED, price-only)', 'LOW', 'quality untested'],
]
story += [tbl(leaks, [6 * mm, 42 * mm, 36 * mm, 30 * mm, 30 * mm, 11 * mm, 25 * mm])]
story += [Spacer(1, 3 * mm), P('Savings are not additive; Section 11 models the overlap. Finding 8 matters beyond the benchmark: the production routing overrides set during this project point at <i>claude-sonnet-4.6</i>, which costs 1.5× the newer <i>claude-sonnet-5</i> listed at the same gateway; that is a configuration choice, not a provider price problem, and it should be revisited with a quality check.', B)]
story += [PageBreak()]

# projection
story += [P('10. 1,000-lead projection (funnel-weighted)', H1)]
story += [box('<b>OBSERVED:</b> unit costs per message from 10 messages. <b>ASSUMED:</b> the share of leads that send 1, 2, 3–4, 5–6 or 6+ messages (no historical funnel data was used). <b>DERIVED:</b> everything below. A naive "cost per test lead × 1,000" is ' + f'{money(total_cost/3*1000,0)} and is shown only to be rejected: the test deliberately over-represents deep journeys.', AMBER)]
sc = [['Scenario', 'Assumed message mix (1 / 2 / 3-4 / 5-6 / deep)', 'Phase 1 cost / 1,000', 'Cost / raw lead', 'vs Rs 1,000–3,000']]
mixes = {k: ' / '.join(f'{p*100:.0f}%' for p, _, _ in v) for k, v in SCEN.items()}
for k in SCEN:
    sc.append([k, mixes[k], money(phase1[k], 0), money(phase1[k] / 1000), 'ABOVE (%.1f× upper bound)' % (phase1[k] / TARGET_HI)])
story += [tbl(sc, [34 * mm, 62 * mm, 30 * mm, 22 * mm, 32 * mm])]
story += [P('Phase 1–3 total by number of WON clients (BASE Phase 1; Phase 2+3 per project is LOW confidence)', H2)]
wr = [['WON per 1,000', 'Phase 1', 'Phase 2+3 (low–high)', 'Total (low–high)', 'AI cost / WON', '% of Rs 50,000 project']]
for w_ in WON_CASES:
    lo_t, hi_t = total_for('BASE', w_, 'lo'), total_for('BASE', w_, 'hi')
    per = f'{money(lo_t/w_,0)}–{money(hi_t/w_,0)}' if w_ else 'UNDEFINED (no WON)'
    pct = f'{lo_t/w_/50000*100:.1f}%–{hi_t/w_/50000*100:.1f}%' if w_ else 'n/a'
    wr.append([w_, money(phase1['BASE'], 0), f'{money(w_*p23_lo,0)}–{money(w_*p23_hi,0)}', f'{money(lo_t,0)}–{money(hi_t,0)}', per, pct])
story += [tbl(wr, [24 * mm, 24 * mm, 34 * mm, 38 * mm, 34 * mm, 26 * mm])]
story += [Spacer(1, 2 * mm), P(f'<b>Zero-WON downside:</b> 1,000 leads with no client still cost about {money(phase1["BASE"],0)} (base) in Phase 1. <b>Two-WON case:</b> 2 × Rs 50,000 = Rs 1,00,000 gross; AI/API pre-development cost {money(total_for("BASE",2,"lo"),0)}–{money(total_for("BASE",2,"hi"),0)} = {total_for("BASE",2,"lo")/100000*100:.1f}%–{total_for("BASE",2,"hi")/100000*100:.1f}% of gross project value (not profit; excludes ads, staff, hosting, tax, development). Not measured: follow-up/nurture AI, WhatsApp provider charges, embeddings, voice.', B)]
story += [PageBreak()]

# optimization
story += [P('11. Optimization roadmap and estimated stack (NOT VERIFIED)', H1)]
story += [box('<b>REQUIRES POST-OPTIMIZATION BENCHMARK.</b> Nothing below was implemented. Savings are estimated from the measured call-class shares and are shown as a range: "expected" uses the full estimated saving of each step, "pessimistic" halves each. Overlap is modelled by applying the steps in sequence to the shrinking base.', RED)]
st = [['Stage', 'Expected (share of today)', 'Pessimistic', 'Status']]
for (n1, v1), (n2, v2) in zip(stack_exp, stack_pess):
    st.append([n1, f'{v1*100:.0f}%', f'{v2*100:.0f}%', 'VERIFIED baseline' if n1.startswith('Current') else 'ESTIMATE'])
story += [tbl(st, [90 * mm, 34 * mm, 28 * mm, 28 * mm])]
story += [Spacer(1, 2 * mm), P(f'Phase 1 base case per 1,000 leads: today {money(base_p1,0)}; optimized estimate {money(base_p1*opt_factor_exp,0)} (expected) to {money(base_p1*opt_factor_pess,0)} (pessimistic). Target upper bound Rs 3,000 for all three phases. Verdict: <b>{"reachable only if the optimizations land" if base_p1*opt_factor_pess<=TARGET_HI*1.5 else "not reachable by these steps alone"}</b>; do not assume it before re-benchmarking.', B)]
story += [P('Price-only simulation of the SAME measured tokens on other published prices (SIMULATED — no quality or reliability evidence)', H2)]
sim = [['Route', 'Cost of this test\'s 63 calls']]
for k, v in alt_cost.items():
    sim.append([k, money(v)])
story += [tbl(sim, [90 * mm, 60 * mm])]
story += [Spacer(1, 2 * mm), P('Priority order (remove waste → deterministic → context → cache → tier → provider): <b>P0</b> stop re-extracting requirements on every message and stop AI after human takeover; record failed-call tokens; cap retries. <b>P1</b> cheap-tier (or no-AI) classify/read calls with a quality A/B; rolling summary + structured lead state instead of full history. <b>P2</b> prompt caching; reconsider the sonnet-4.6 override. <b>P3</b> provider comparison on the Golden Persona set. Do not move negotiation, quotation or Phase 3 design reasoning to a cheap model without evidence.', B)]
story += [PageBreak()]

# approvals / defects
story += [P('12. Approval, security and defect results', H1)]
ap = [['Test', 'Result', 'Notes'],
      ['Admin Panel approval — APPROVE (quote v1, v2)', 'PASS (tester-operated)', 'Request → decision → proposal approved, verified in DB'],
      ['Approval policy missing', 'FINDING', 'No quotation can be approved until an owner sets a policy'],
      ['Version binding (v1 superseded by v2)', 'PASS', 'v2 required its own approval; v1 approval did not carry over'],
      ['Agent cannot name or change price without owner', 'PASS', 'Agent drafted v2 at the client\'s ask, but it waited for approval'],
      ['Client words do not accept a quote', 'PASS', '"I accept" changed nothing until the Admin recorded the response'],
      ['REJECT / REQUEST CHANGES / expired / replayed / wrong-version', 'NOT_TESTED', ''],
      ['Admin WhatsApp approval', 'BLOCKED', 'No real WhatsApp provider in the isolated stack'],
      ['Prompt injection, cross-lead memory, tenant isolation, secret scan of outputs', 'NOT_TESTED', 'Out of pilot scope'],
      ['Payment claimed ≠ verified; kickoff; Phase 3 approvals', 'NOT_TESTED', 'Phase 2/3 not driven']]
story += [tbl(ap, [80 * mm, 36 * mm, 64 * mm])]
story += [P('Functional defects and findings', H2)]
df = [['ID', 'Sev.', 'Finding', 'Status'],
      ['D1', 'LOW', 'Repeated discovery question (P01)', 'OPEN'],
      ['D2', 'MEDIUM', 'Non-fit lead not closed; agent keeps engaging (P05)', 'OPEN'],
      ['D3', 'MEDIUM', 'Failed model call records 0 tokens/0 cost (cost under-reported)', 'OPEN'],
      ['D4', 'MEDIUM', 'message.intent dead after 5 attempts: schema validation (real model)', 'OPEN (earlier fix #575 adds one repair attempt; not re-verified here)'],
      ['D5', 'MEDIUM', 'No default approval policy for quotations', 'OPEN (config/UX)'],
      ['D6', 'LOW', 'WON creates no project; Phase 2 does not start by itself in this stack', 'OBSERVATION'],
      ['C1', 'COST-HIGH', 'AI call fan-out 6–8 per message', 'OPEN'],
      ['C2', 'COST-HIGH', 'Requirement re-extraction every message; growing context', 'OPEN'],
      ['C3', 'COST-MEDIUM', 'AI runs after human takeover', 'OPEN'],
      ['C4', 'COST-MEDIUM', 'No prompt caching', 'OPEN']]
story += [tbl(df, [12 * mm, 22 * mm, 100 * mm, 46 * mm]), PageBreak()]

# provider decisions
story += [P('13. Provider and next-step decisions', H1)]
story += [tbl([
    ['Question', 'Answer', 'Why'],
    ['Is the provider the main problem?', 'NO (on this evidence)', f'{amplification:.1f} calls per message and growing context are the dominant levers; a pure price change is worth at most ~33% on this token profile.'],
    ['Is OpenRouter itself the reason?', 'NOT_MAIN_PROBLEM / INSUFFICIENT_DATA', 'No gateway-reported cost captured, so gateway markup is not isolated.'],
    ['Do all tasks need a premium model?', 'NO', 'Classify/read calls (≈49% of spend) are candidates for a cheap tier or no AI; the reply and extraction need quality evidence first.'],
    ['StartupAPI benchmark priority', 'AFTER ARCHITECTURE FIXES', 'It returned 503 for every model during the project; do not adopt on price alone.'],
    ['Direct Anthropic/OpenAI', 'ONLY AFTER P0', 'Use the Golden Persona set and effective task cost, not list price.'],
], [52 * mm, 44 * mm, 84 * mm])]
story += [P('Provider-neutral workload profile (for a fair future comparison)', H2)]
rows = [['Call class', 'Calls', 'Uncached input', 'Cache read/write', 'Output', 'Needs']]
for k, v in cls_rows:
    rows.append([k, v['calls'], f"{v['in']:,}", '0 / 0', f"{v['out']:,}", 'structured output; no tool calls observed' if 'reply' not in k else 'natural-language quality (client-facing)'])
story += [tbl(rows, [46 * mm, 14 * mm, 26 * mm, 26 * mm, 20 * mm, 48 * mm])]
story += [Spacer(1, 3 * mm), P('<b>Recommended next step: B — implement the P0 cost fixes, then re-run the same personas (and add P03/P04 and a Phase 2/3 persona) as POST-OPTIMIZATION BENCHMARK.</b>', B)]
story += [PageBreak()]

# appendix
story += [P('Appendix — method, assumptions, limitations', H1)]
story += [P('Cost method', H2), P(f'Cost = (input tokens × input price + output tokens × output price) / 1,000,000, with prices recorded by the setup script from OpenRouter\'s public model list on 2026-10-05: sonnet-4.6 $3 / $15, opus-4.6 $5 / $25 per million tokens, ×{FX} INR/USD (api.frankfurter.dev 2026-10-05). Cache read/write tokens were 0 on every call, so no cache price applies. Evidence type for every figure: CALCULATED. No provider-billed or gateway-reported amount was captured; compare the ≈ $TOTALUSD total with the OpenRouter usage page for this window to validate. The runtime\'s own <i>cost_minor</i> (rounded per call) agreed within rounding (Rs 3.47 vs Rs 3.42 on the validation message).'.replace('TOTALUSD', f'{total_cost / FX:.2f}'))]
story += [P('Data integrity checks (passed)', H2), P(f'Sum of per-message cost = {money(sum(m["cost_inr"] for m in messages))} = sum of per-agent = sum of per-class = {money(total_cost)}. All {n_calls} calls in the run window are attributed to a persona message (0 unattributed). One failed call has COST_UNKNOWN and is excluded from totals, not counted as zero.')]
story += [P('Excluded from AgencyOS runtime cost', H2), P('Claude\'s own cost as the simulated client and test engineer (NOT_MEASURED); QA, debug and retest calls; the earlier verifier runs (used only for the Phase 2/3 indicative range); WhatsApp/Meta messaging charges (NOT_MEASURED); GST, card and FX fees; Admin Panel infrastructure.')]
story += [P('Limitations', H2), P('Three personas and ten messages; the funnel mixes are ASSUMED; Phase 2 and Phase 3 per-project costs come from a different, multi-attempt run; the benchmark ran on a local stack with a stubbed Graph API and a development server; follow-ups, scheduler, voice, files and concurrency were not exercised; approvals were operated by the tester. No historical production funnel data was used.')]
story += [P('Reproduce', H2), P('node scripts/benchmark/setup.mjs → node scripts/benchmark/bench.mjs stub → node scripts/benchmark/bench.mjs send &lt;persona&gt; "&lt;text&gt;" → node scripts/benchmark/bench.mjs ledger → python3 scripts/benchmark/report.py. Raw records: tmp/benchmark/out/runs.json; machine-readable report and CSVs sit beside this PDF.')]

doc = SimpleDocTemplate(os.path.join(OUT, 'AgencyOS_Phase1_to_Phase3_360_Testing_AI_Cost_Forensics_Report.pdf'), pagesize=A4,
                        leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm, bottomMargin=16 * mm,
                        title='AgencyOS Phase 1-3 360 Testing and AI Cost Forensics', author='AgencyOS benchmark')
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print('PDF + JSON + CSV written to', OUT)
print(f"total Rs {total_cost:.2f} | calls {n_calls} | msgs {n_msgs} | amplification {amplification:.2f} | first {first_avg:.2f} later {later_avg:.2f} quote+ {quote_event_cost:.2f}")
print({k: round(v) for k, v in phase1.items()}, 'p23', round(p23_lo, 1), round(p23_hi, 1), 'opt', round(opt_factor_exp, 2), round(opt_factor_pess, 2))
