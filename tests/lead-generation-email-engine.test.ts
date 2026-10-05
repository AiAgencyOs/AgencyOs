import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';

import { addProspectFact, qualifyProspect, validateOutreachDraft } from '../src/modules/acquisition/email-engine.ts';
import { disqualifierWords, FACTOR_LABEL, FUNNEL_LABEL, FUNNEL_STAGES, QUALIFICATION_FACTORS } from '../src/modules/acquisition/qualification-vocabulary.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261018100000_the_email_engine_qualifies_adopts_and_stays_in_its_lane.sql');
const chokepoint = read('supabase/migrations/20261018110000_a_follow_up_is_rechecked_when_it_is_sent.sql');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};
const quoted = (text: string) => [...text.matchAll(/'([A-Za-z_0-9]+)'/g)].map((m) => m[1]);

describe('lead generation, slice 6 - the Email engine\'s decisions', () => {
  describe('qualification: arithmetic first, then rules that outrank it', () => {
    test('the SQL and TypeScript factor lists are the same, and every factor has a label', () => {
      const body = fn('crm.qualification_factors');
      const start = body.indexOf('array[');
      assert.deepEqual(quoted(body.slice(start, body.indexOf(']', start))), [...QUALIFICATION_FACTORS]);
      for (const f of QUALIFICATION_FACTORS) assert.ok(FACTOR_LABEL[f], f);
    });

    test('a disqualifier decides whatever the score: the decision order and a CHECK on the table both say so', () => {
      const body = fn('crm.qualify_prospect');
      assert.ok(body.indexOf("when jsonb_array_length(v_dis) > 0 then 'disqualified'") < body.indexOf("when v_score >= v_threshold"), 'rules before the score');
      assert.match(sql, /constraint prospect_qualifications_rules_outrank_score check \(decision <> 'qualified' or jsonb_array_length\(disqualifiers\) = 0\)/);
    });

    test('a missing factor counts in the denominator, so not knowing LOWERS the score', () => {
      assert.match(fn('crm.qualify_prospect'), /v_den := v_den \+ wv;\s+if p_factors \? k then/);
    });

    test('every rule that can disqualify has words for a person, and a below-threshold result carries its own reason', () => {
      const body = fn('crm.qualify_prospect');
      for (const code of ['suppressed', 'do_not_contact', 'blocked', 'outside_target_geography', 'outside_target_industry', 'service_not_targeted', 'below_threshold']) {
        assert.ok(body.includes(`'${code}'`), `${code} not produced by the SQL`);
        assert.notEqual(disqualifierWords(code), code, `${code} has no words`);
      }
      assert.match(disqualifierWords('icp_exclusion:gambling'), /gambling/);
      assert.match(body, /'icp_exclusion:' \|\| v_excl/);
    });

    test('weights and the ICP are versioned and recorded with each decision, never edited', () => {
      assert.match(sql, /unique \(organization_id, version\)/);
      for (const t of ['qualification_models', 'prospect_facts', 'prospect_qualifications']) assert.match(sql, new RegExp(`create trigger ${t}_immutable before update or delete on crm\\.${t}`), t);
      assert.match(fn('crm.qualify_prospect'), /model_version, icp_version, score/);
    });

    test('loosening a safety rule (lifting a block) is the owner\'s; adding one is any admin\'s', () => {
      assert.match(fn('crm.lift_prospect_block'), /core\.is_owner\(\)/);
      assert.match(fn('crm.block_prospect'), /core\.is_admin\(\)/);
      assert.match(sql, /a lifted block stays lifted; block again instead/);
    });
  });

  describe('a message may only say what the research supports', () => {
    test('a claim must cite a recorded fact about THIS prospect and be present in the text', () => {
      const body = fn('crm.validate_outreach_draft');
      assert.match(body, /f\.id = v_fact and f\.prospect_id = p_prospect and f\.organization_id = p_organization_id/);
      assert.match(body, /position\(v_text in v_all\) = 0/);
      assert.match(body, /'unsupported_claim:'/);
      assert.match(body, /'claim_not_in_message:'/);
    });

    test('manufactured urgency, scarcity, guarantees and unearned familiarity are named and refused', () => {
      const body = fn('crm.validate_outreach_draft');
      for (const phrase of ['limited time', 'act now', 'last chance', 'only a few spots', 'guaranteed results', 'we guarantee', 'risk-free', 'i noticed your recent', 'congratulations on your']) {
        assert.ok(body.includes(`'${phrase}'`), phrase);
      }
      assert.match(body, /'familiarity_without_a_fact:'/);
    });

    test('a researched fact needs a source URL, and only a person may assert one from their own knowledge', () => {
      const body = fn('crm.add_prospect_fact');
      assert.match(body, /'needs_source'/);
      assert.match(body, /p_source_kind = 'manual' and p_recorded_by_type <> 'human'/);
      assert.match(sql, /source_url ~\* '\^https\?:\/\/'/);
    });

    test('the TypeScript wrappers treat a missing answer as a failure, never a pass', async () => {
      const answer = (data: unknown) => ({ schema: () => ({ rpc: async () => ({ data, error: null }) }) }) as never;
      const v = await validateOutreachDraft(answer(null), { organizationId: 'o', prospectId: 'p', subject: 'hello there', body: 'a long enough body for the validator to read here', claims: [] });
      assert.equal(v.valid, false);
      assert.deepEqual(v.problems, ['no_answer']);
      const q = await qualifyProspect(answer(null), { organizationId: 'o', prospectId: 'p', factors: { need_clarity: 90 }, evaluatedBy: 'agent' });
      assert.equal(q.ok, false);
      const f = await addProspectFact(answer([{ outcome: 'needs_source' }]), { organizationId: 'o', prospectId: 'p', fact: 'a fact', sourceKind: 'website', recordedBy: 'agent' });
      assert.deepEqual(f, { ok: false, refusal: 'needs_source' });
    });
  });

  describe('a reply is adopted', () => {
    test('it fires only when a prospect BECOMES replied, and never grants consent', () => {
      assert.match(sql, /create trigger adopt_replied_prospect after update of status on crm\.outreach_prospects\s+for each row when \(new\.status = 'replied' and old\.status is distinct from 'replied'\)/);
      const body = fn('crm._adopt_replied_prospect');
      assert.doesNotMatch(body, /communication_consent/);
      assert.match(body, /if new\.status <> 'replied' or old\.status = 'replied' then return new/);
    });

    test('it resolves ONE identity through the shared door (never inserts a contact itself) and defers a conflict to a person', () => {
      const body = fn('crm._adopt_replied_prospect');
      assert.match(body, /crm\.resolve_identity\(/);
      assert.doesNotMatch(body, /insert into crm\.contacts/);
      assert.match(body, /'email\.adopt_deferred'/);
    });

    test('a person who already has an OPEN lead keeps it: the outreach history attaches to that lead, and ownership is only ever filled, never taken', () => {
      const body = fn('crm._adopt_replied_prospect');
      assert.match(body, /crm\.lead_outcome\(l\.id\) = 'OPEN'/);
      assert.ok(body.indexOf("lead_outcome(l.id) = 'OPEN'") < body.indexOf('insert into crm.leads'), 'look for an open lead before creating one');
      assert.match(fn('crm._assign_first_owner'), /on conflict \(lead_id\) do nothing/);
      assert.doesNotMatch(fn('crm._assign_first_owner'), /do update/);
    });

    test('the first touch is the first email SENT, recorded at its own time, then the reply', () => {
      const body = fn('crm._adopt_replied_prospect');
      assert.match(body, /order by x\.sent_at/);
      assert.match(body, /'send:' \|\| s\.id::text, s\.sent_at/);
      assert.ok(body.indexOf("'outreach_sent'") < body.indexOf("'reply_received'"));
    });

    test('a failure is audited and swallowed: a reply must still stop the sequence', () => {
      const body = fn('crm._adopt_replied_prospect');
      assert.match(body, /exception when others then/);
      assert.match(body, /'email\.adopt_failed'/);
    });
  });

  describe('a follow-up is re-checked when it is sent', () => {
    test('the chokepoint is carried forward with exactly one marked edit, naming the lead-side blockers only', () => {
      assert.equal((chokepoint.match(/-- EDIT \(lead generation, 20261018110000\)/g) ?? []).length, 1);
      assert.match(chokepoint, /b in \('lead_closed', 'owner_moved', 'meeting_in_progress', 'subtask_open'\)/);
      assert.match(chokepoint, /refusal_reason = 'prospect_stopped'/);
      assert.match(chokepoint, /crm\.acquisition_blocked\(p_organization_id, 'email'\)/, 'the earlier pause edit survived');
      assert.match(chokepoint, /core\.org_paused\(p_organization_id, 'outbound_paused'\)/, 'the original stop survived');
    });

    test('the blockers look at every lead the PERSON has, across channels, not just the prospect\'s own', () => {
      const body = fn('crm.email_followup_blockers');
      assert.match(body, /identity_keys k where k\.organization_id = p_organization_id and k\.kind = 'email' and k\.value = p\.email/);
      for (const code of ['suppressed', 'lead_closed', 'owner_moved', 'meeting_in_progress', 'subtask_open', 'channel_blocked']) assert.ok(body.includes(`'${code}'`), code);
      assert.match(sql, /revoke all on function crm\.email_followup_blockers\([^)]*\) from public, anon, authenticated/);
    });
  });

  describe('the funnel', () => {
    test('the stages are the same in SQL and TypeScript, and each has words', () => {
      const body = fn('crm.email_funnel');
      const stages = [...body.matchAll(/select '([a-z_]+)'/g), ...body.matchAll(/union all select '([a-z_]+)'/g)].map((m) => m[1]);
      assert.deepEqual(new Set(stages), new Set(FUNNEL_STAGES));
      for (const s of FUNNEL_STAGES) assert.ok(FUNNEL_LABEL[s], s);
    });
    test('it counts the records themselves - there is no counter table to drift', () => {
      assert.doesNotMatch(sql, /create table[^;]*funnel/i);
      assert.match(fn('crm.email_funnel'), /security invoker/);
    });
  });

  describe('a class of bug that has bitten twice', () => {
    test('no lead-generation migration concatenates a bare string literal onto a text[] variable (`text[] || \'x\'` parses the literal as an array)', () => {
      const dir = new URL('../supabase/migrations/', import.meta.url);
      const files = readdirSync(dir).filter((f) => /^20261015|^20261016|^20261017|^20261018/.test(f));
      assert.ok(files.length >= 6, 'the lead-generation migrations were not found');
      for (const f of files) {
        const text = readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
        const arrays = [...text.matchAll(/\b(v_[a-z_]+)\s+text\[\]/g)].map((m) => m[1]);
        for (const v of arrays) {
          assert.doesNotMatch(text, new RegExp(`${v}\\s*:=\\s*${v}\\s*\\|\\|\\s*'`), `${f}: ${v} is concatenated with a bare literal`);
        }
      }
    });
  });

  describe('tenancy', () => {
    test('every new table revokes default privileges, freezes its organisation, guards its parent and forces RLS', () => {
      for (const t of ['qualification_models', 'blocked_prospects', 'prospect_facts', 'prospect_qualifications']) {
        assert.match(sql, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`), t);
        assert.match(sql, new RegExp(`create trigger freeze_org_${t} before update of organization_id on crm\\.${t}`), t);
        assert.match(sql, new RegExp(`alter table crm\\.${t} force row level security`), t);
      }
      for (const g of ['prospect_facts_prospect', 'prospect_qualifications_prospect']) assert.match(sql, new RegExp(`create trigger org_match_${g}`), g);
    });
  });
});
