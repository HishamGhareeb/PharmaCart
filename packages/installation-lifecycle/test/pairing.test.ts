import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyInstallationCommand,
  authoriseInstallation,
  beginPairing,
  repairInstallation,
  syncDirective,
  type Installation,
  type InstallationCapability,
  type InstallationCommand,
} from '../src/pairing.ts';

const CAPABILITIES: readonly InstallationCapability[] = [
  'read_configuration',
  'submit_inventory',
  'submit_orders',
  'acknowledge_receipt',
];

function pending(): Installation {
  const result = beginPairing({
    installationId: 'inst-1',
    organisationId: 'org-1',
    branchId: 'branch-1',
    at: '2026-09-12T08:00:00Z',
  });
  assert.equal(result.kind, 'applied');
  return result.kind === 'applied' ? result.installation : (undefined as never);
}

function apply(installation: Installation, command: InstallationCommand): Installation {
  const result = applyInstallationCommand(installation, command);
  assert.equal(result.kind, 'applied', result.kind === 'refused' ? result.reason : result.kind);
  return result.kind === 'applied' ? result.installation : installation;
}

function active(): Installation {
  return apply(pending(), { kind: 'confirm_pairing', at: '2026-09-12T08:05:00Z' });
}

function refusal(installation: Installation, command: InstallationCommand): string {
  const result = applyInstallationCommand(installation, command);
  assert.equal(result.kind, 'refused', result.kind);
  return result.kind === 'refused' ? result.reason : '';
}

function permitted(installation: Installation): readonly InstallationCapability[] {
  return CAPABILITIES.filter((capability) =>
    authoriseInstallation(installation, capability).kind === 'permitted');
}

describe('AC-016 revoking a paired installation', () => {
  it('denies the next request and stops sync, whenever the work was queued', () => {
    const paired = active();
    assert.equal(authoriseInstallation(paired, 'submit_inventory').kind, 'permitted');
    assert.equal(syncDirective(paired), 'proceed');

    const revoked = apply(paired, {
      kind: 'revoke',
      at: '2026-09-12T09:00:00Z',
      reason: 'device reported stolen',
    });

    const denied = authoriseInstallation(revoked, 'submit_inventory');
    assert.equal(denied.kind, 'denied');
    assert.equal(denied.kind === 'denied' ? denied.reason : '', 'installation_revoked');
    assert.deepEqual(permitted(revoked), []);
    assert.equal(syncDirective(revoked), 'stop');
  });

  it('pauses rather than stops when an installation is only suspended', () => {
    const suspended = apply(active(), {
      kind: 'suspend',
      at: '2026-09-12T09:00:00Z',
      reason: 'terms renegotiation',
    });

    assert.equal(syncDirective(suspended), 'pause');
    assert.deepEqual(permitted(suspended), ['read_configuration']);
    assert.equal(
      authoriseInstallation(suspended, 'submit_orders').kind === 'denied'
        ? 'denied' : 'permitted',
      'denied',
    );
  });
});

describe('installation pairing lifecycle', () => {
  it('starts pending and can only read its own configuration', () => {
    const installation = pending();
    assert.equal(installation.status, 'pending');
    assert.equal(installation.pairedAt, null);
    assert.deepEqual(permitted(installation), ['read_configuration']);
    assert.equal(syncDirective(installation), 'pause');
  });

  it('records when pairing completed and grants the full capability set', () => {
    const installation = active();
    assert.equal(installation.status, 'active');
    assert.equal(installation.pairedAt, '2026-09-12T08:05:00Z');
    assert.deepEqual(permitted(installation), CAPABILITIES);
  });

  it('suspends and resumes without losing the pairing', () => {
    const suspended = apply(active(), {
      kind: 'suspend',
      at: '2026-09-12T09:00:00Z',
      reason: 'terms renegotiation',
    });
    assert.equal(suspended.statusReason, 'terms renegotiation');

    const resumed = apply(suspended, { kind: 'resume', at: '2026-09-12T10:00:00Z' });
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.statusReason, null);
    assert.equal(resumed.pairedAt, '2026-09-12T08:05:00Z');
  });

  it('escalates a suspended installation straight to revoked', () => {
    const suspended = apply(active(), {
      kind: 'suspend', at: '2026-09-12T09:00:00Z', reason: 'under review',
    });
    const revoked = apply(suspended, {
      kind: 'revoke', at: '2026-09-12T09:30:00Z', reason: 'review failed',
    });
    assert.equal(revoked.status, 'revoked');
  });

  it('treats revocation as terminal', () => {
    const revoked = apply(active(), {
      kind: 'revoke', at: '2026-09-12T09:00:00Z', reason: 'device lost',
    });

    assert.equal(refusal(revoked, { kind: 'resume', at: '2026-09-12T10:00:00Z' }), 'terminal_state');
    assert.equal(
      refusal(revoked, { kind: 'confirm_pairing', at: '2026-09-12T10:00:00Z' }),
      'terminal_state',
    );
    assert.equal(
      refusal(revoked, { kind: 'suspend', at: '2026-09-12T10:00:00Z', reason: 'x' }),
      'terminal_state',
    );
  });

  it('ignores a replayed command instead of failing it', () => {
    const revoked = apply(active(), {
      kind: 'revoke', at: '2026-09-12T09:00:00Z', reason: 'device lost',
    });
    const replay = applyInstallationCommand(revoked, {
      kind: 'revoke', at: '2026-09-12T09:00:00Z', reason: 'device lost',
    });

    assert.equal(replay.kind, 'ignored');
    assert.deepEqual(replay.kind === 'ignored' ? replay.installation : null, revoked);

    const confirmAgain = applyInstallationCommand(active(), {
      kind: 'confirm_pairing', at: '2026-09-12T11:00:00Z',
    });
    assert.equal(confirmAgain.kind, 'ignored');
  });

  it('refuses a transition that is not legal from the current state', () => {
    const suspended = apply(active(), {
      kind: 'suspend', at: '2026-09-12T09:00:00Z', reason: 'under review',
    });

    assert.equal(refusal(pending(), { kind: 'resume', at: '2026-09-12T09:00:00Z' }), 'illegal_transition');
    assert.equal(
      refusal(suspended, { kind: 'confirm_pairing', at: '2026-09-12T10:00:00Z' }),
      'illegal_transition',
    );
  });

  it('refuses a command that would move the audit trail backwards', () => {
    assert.equal(
      refusal(active(), { kind: 'suspend', at: '2026-09-12T07:00:00Z', reason: 'x' }),
      'time_moves_backwards',
    );
  });

  it('refuses a command it cannot record honestly', () => {
    assert.equal(refusal(active(), { kind: 'suspend', at: 'not-a-time', reason: 'x' }), 'invalid_time');
    assert.equal(
      refusal(active(), { kind: 'revoke', at: '2026-09-12T09:00:00Z', reason: '' }),
      'invalid_reason',
    );
  });
});

describe('re-pairing after revocation', () => {
  it('issues a new identity that supersedes the revoked one', () => {
    const revoked = apply(active(), {
      kind: 'revoke', at: '2026-09-12T09:00:00Z', reason: 'device lost',
    });
    const result = repairInstallation(revoked, 'inst-2', '2026-09-12T11:00:00Z');
    assert.equal(result.kind, 'applied');

    const replacement = result.kind === 'applied' ? result.installation : (undefined as never);
    assert.equal(replacement.installationId, 'inst-2');
    assert.equal(replacement.status, 'pending');
    assert.equal(replacement.supersedesInstallationId, 'inst-1');
    assert.equal(replacement.organisationId, revoked.organisationId);
    assert.equal(replacement.branchId, revoked.branchId);
  });

  it('never reuses a revoked identity', () => {
    const revoked = apply(active(), {
      kind: 'revoke', at: '2026-09-12T09:00:00Z', reason: 'device lost',
    });
    const result = repairInstallation(revoked, 'inst-1', '2026-09-12T11:00:00Z');
    assert.equal(result.kind, 'refused');
    assert.equal(result.kind === 'refused' ? result.reason : '', 'identity_reused');
  });

  it('refuses to replace an installation that is still live', () => {
    const result = repairInstallation(active(), 'inst-2', '2026-09-12T11:00:00Z');
    assert.equal(result.kind, 'refused');
    assert.equal(result.kind === 'refused' ? result.reason : '', 'illegal_transition');
  });
});
