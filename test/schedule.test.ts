import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlist, cronLine, editCrontab, schtasksCommand } from '../src/schedule.ts';

test('cron: install replaces an old second-brain line and keeps the rest', () => {
  const line = cronLine(15);
  assert.match(line, /^\*\/15 \* \* \* \* PATH='.+' SECOND_BRAIN_HOME='.+' '.+node' '.+cli\.ts' sync --notify --quiet >> '.+sync\.log' 2>&1 # second-brain-sync$/);
  const mine = '0 9 * * 1 /usr/bin/backup.sh\n';
  const once = editCrontab(mine, line);
  assert.equal(once, `0 9 * * 1 /usr/bin/backup.sh\n${line}\n`);
  assert.equal(editCrontab(once, cronLine(30)).match(/second-brain-sync/g)?.length, 1, 'no duplicates');
  assert.equal(editCrontab(once, null), mine, 'uninstall leaves other jobs alone');
  assert.equal(editCrontab('', null), '');
});

test('launchd plist and Windows command are well formed', () => {
  const plist = buildPlist(15);
  assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(plist, /<string>sync<\/string>\s*<string>--notify<\/string>/);
  assert.match(schtasksCommand(15), /^schtasks \/Create \/F \/SC MINUTE \/MO 15 \/TN "second-brain sync" \/TR /);
});
