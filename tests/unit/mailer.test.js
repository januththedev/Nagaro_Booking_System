/**
 * Unit tests for src/server/mail/mailer.js
 *
 * Proves the three honest outcomes (NOT_CONFIGURED / SENT / FAILED), the
 * transport injection seam, that sendMail never throws, and that the SMTP
 * password can never appear in a reported error string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mailerConfig,
  resetTransportForTests,
  safeErrorMessage,
  sendMail,
  setTransportFactoryForTests,
} from '../../src/server/mail/mailer.js';

const MANAGED_ENV = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM',
  'NAGARO_ADMIN_NOTIFICATION_EMAIL', 'NAGARO_MAIL_TRANSPORT',
];

function snapshotEnv() {
  const snapshot = {};
  for (const key of MANAGED_ENV) snapshot[key] = process.env[key];
  return snapshot;
}

function applyEnv(vars) {
  for (const key of MANAGED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(vars ?? {})) {
    if (value !== undefined && value !== null) process.env[key] = String(value);
  }
}

function restoreEnv(snapshot) {
  for (const key of MANAGED_ENV) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

/** Run `fn` with a clean email environment, restoring everything afterwards. */
async function withEnv(vars, fn) {
  const snapshot = snapshotEnv();
  applyEnv(vars);
  try {
    return await fn();
  } finally {
    resetTransportForTests();
    restoreEnv(snapshot);
  }
}

test('NOT_CONFIGURED: no SMTP_HOST means no connection attempt and an honest status', async () => {
  await withEnv({}, async () => {
    const config = mailerConfig();
    assert.equal(config.configured, false);
    assert.equal(config.reason, 'SMTP is not configured (SMTP_HOST is unset).');
    assert.equal(config.from, 'no-reply@nagaro.local');

    const result = await sendMail({ to: 'someone@example.com', subject: 'Hi', text: 'Body' });
    assert.equal(result.status, 'NOT_CONFIGURED');
    assert.equal(result.messageId, null);
    assert.match(result.error, /SMTP_HOST is unset/);
  });
});

test('mailerConfig prefers SMTP_FROM, then NAGARO_ADMIN_NOTIFICATION_EMAIL, then the default', async () => {
  await withEnv({ SMTP_HOST: 'smtp.example.com', NAGARO_ADMIN_NOTIFICATION_EMAIL: 'frontdesk@nagaro.local' }, async () => {
    const withAdmin = mailerConfig();
    assert.equal(withAdmin.configured, true);
    assert.equal(withAdmin.from, 'frontdesk@nagaro.local');
    assert.equal(withAdmin.to, 'frontdesk@nagaro.local');
  });

  await withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'bookings@nagaro.local', NAGARO_ADMIN_NOTIFICATION_EMAIL: 'frontdesk@nagaro.local' }, async () => {
    const withFrom = mailerConfig();
    assert.equal(withFrom.from, 'bookings@nagaro.local');
    assert.equal(withFrom.to, 'frontdesk@nagaro.local');
  });
});

test('SENT: the json transport seam delivers without an SMTP server', async () => {
  await withEnv({ NAGARO_MAIL_TRANSPORT: 'json' }, async () => {
    assert.equal(mailerConfig().configured, true);
    const result = await sendMail({
      to: 'visitor@example.com',
      subject: 'New booking request INQ-2026-00001',
      text: 'Plain body',
      html: '<p>Body</p>',
    });
    assert.equal(result.status, 'SENT');
    assert.equal(result.error, null);
    assert.ok('messageId' in result);
  });
});

test('SENT: the stream transport seam delivers without an SMTP server', async () => {
  await withEnv({ NAGARO_MAIL_TRANSPORT: 'stream' }, async () => {
    const result = await sendMail({ to: 'visitor@example.com', subject: 'Hello', text: 'Body' });
    assert.equal(result.status, 'SENT');
    assert.equal(result.error, null);
  });
});

test('FAILED: a throwing transport is reported, never thrown', async () => {
  await withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'apiuser' }, async () => {
    setTransportFactoryForTests(() => ({
      sendMail: async () => { throw new Error('550 mailbox unavailable'); },
    }));
    const result = await sendMail({ to: 'visitor@example.com', subject: 'Hi', text: 'Body' });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.messageId, null);
    assert.match(result.error, /550 mailbox unavailable/);
  });
});

test('FAILED: no recipient anywhere is an honest failure, not a crash', async () => {
  await withEnv({ SMTP_HOST: 'smtp.example.com' }, async () => {
    const result = await sendMail({ subject: 'Hi', text: 'Body' });
    assert.equal(result.status, 'FAILED');
    assert.match(result.error, /No recipient email address/);
  });
});

test('secrets: SMTP_PASS never appears in a reported delivery error', async () => {
  const password = 'sup3r-Secret-Pass!';
  await withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'apiuser', SMTP_PASS: password }, async () => {
    setTransportFactoryForTests(() => ({
      sendMail: async () => {
        throw new Error(`Invalid login: user=apiuser pass=${password} (smtp://apiuser:${password}@smtp.example.com)`);
      },
    }));
    const result = await sendMail({ to: 'visitor@example.com', subject: 'Hi', text: 'Body' });
    assert.equal(result.status, 'FAILED');
    assert.ok(!result.error.includes(password), 'raw password leaked into the error string');
    assert.match(result.error, /\[redacted\]/);
  });
});

test('safeErrorMessage redacts URL credentials even without SMTP_PASS set', async () => {
  await withEnv({}, async () => {
    const message = safeErrorMessage(new Error('connect ECONNREFUSED smtp://bob:hunter2@mail.example.com:587'));
    assert.ok(!message.includes('hunter2'));
    assert.match(message, /smtp:\/\/bob:\[redacted\]@mail\.example\.com:587/);
  });
});

test('the factory seam is used for every send until reset', async () => {
  await withEnv({ SMTP_HOST: 'smtp.example.com' }, async () => {
    const sent = [];
    setTransportFactoryForTests(() => ({
      sendMail: async (message) => {
        sent.push(message);
        return { messageId: `seam-${sent.length}` };
      },
    }));

    const first = await sendMail({ to: 'a@example.com', subject: 'One', text: '1', replyTo: 'reply@example.com' });
    const second = await sendMail({ to: 'b@example.com', subject: 'Two', text: '2' });

    assert.equal(first.status, 'SENT');
    assert.equal(first.messageId, 'seam-1');
    assert.equal(second.messageId, 'seam-2');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].to, 'a@example.com');
    assert.equal(sent[0].replyTo, 'reply@example.com');
    assert.equal(sent[1].subject, 'Two');
  });
});
