import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * W10 wiring: the cron tick runs the design-share reminder sweep. Source-pinned (the sender imports server-only modules), so removing the wiring line
 * or the send path turns a test red.
 */
const route = readFileSync(new URL('../app/api/jobs/run/route.ts', import.meta.url), 'utf8');
const sender = readFileSync(new URL('../src/modules/projects/design-share-reminder-sender.ts', import.meta.url), 'utf8');

describe('W10 design-share reminders are scheduled from the cron tick', () => {
  test('the route imports the all-organizations sweep and runs it on the idle tick, and reports it', () => {
    assert.match(route, /import \{ sweepDesignShareRemindersAllOrganizations \} from '@\/modules\/projects\/design-share-reminder-sender';/);
    assert.match(route, /const designShareReminders = idleTick \? await sweepDesignShareRemindersAllOrganizations\(admin\) : null;/);
    assert.match(route, /\n {4}designShareReminders,\n/);
  });

  test('the sweep is given a sender that is the ordinary outbound client path (consent, window, kill switch and provider all still decide)', () => {
    assert.match(sender, /sweepDesignShareReminders\(admin, \{ organizationId: org\.id \}, reminderSenderFor\(admin, org\.id\)\)/);
    assert.match(sender, /sendSystemText\(/);
    assert.match(sender, /loadContext\(admin, organizationId, share\.project_id\)/);
  });

  test('a send that did not happen is never reported as sent (so no reminder is recorded)', () => {
    for (const kind of ['paused', 'no_consent', 'in_flight', 'failed']) {
      assert.match(sender, new RegExp(`case '${kind}':\\n\\s+return \\{ sent: false`), kind);
    }
    assert.match(sender, /case 'sent':\n\s+return \{ sent: true, channel: 'whatsapp', evidenceRef: result\.messageId \}/);
  });

  test('each reminder has its own stable reference, so a retried sweep cannot send it twice', () => {
    assert.match(sender, /ref: `p13:design-share-reminder:\$\{share\.share_id\}:\$\{share\.next_reminder_number\}`/);
  });
});
