export type InstallationStatus = 'pending' | 'active' | 'suspended' | 'revoked';

export type InstallationCapability =
  | 'read_configuration'
  | 'submit_inventory'
  | 'submit_orders'
  | 'acknowledge_receipt';

export type SyncDirective = 'proceed' | 'pause' | 'stop';

export type Installation = Readonly<{
  installationId: string;
  organisationId: string;
  branchId: string;
  status: InstallationStatus;
  pairedAt: string | null;
  statusChangedAt: string;
  statusReason: string | null;
  supersedesInstallationId: string | null;
}>;

export type InstallationCommand =
  | Readonly<{ kind: 'confirm_pairing'; at: string }>
  | Readonly<{ kind: 'resume'; at: string }>
  | Readonly<{ kind: 'suspend'; at: string; reason: string }>
  | Readonly<{ kind: 'revoke'; at: string; reason: string }>;

export type TransitionRefusal =
  | 'terminal_state'
  | 'illegal_transition'
  | 'identity_reused'
  | 'invalid_time'
  | 'invalid_reason'
  | 'invalid_identity'
  | 'time_moves_backwards';

export type TransitionResult =
  | Readonly<{ kind: 'applied'; installation: Installation }>
  | Readonly<{ kind: 'ignored'; installation: Installation }>
  | Readonly<{ kind: 'refused'; reason: TransitionRefusal }>;

export type AuthorisationDecision =
  | Readonly<{ kind: 'permitted' }>
  | Readonly<{
      kind: 'denied';
      reason: 'pairing_incomplete' | 'installation_suspended' | 'installation_revoked';
    }>;

/**
 * A suspended installation keeps read_configuration so it can discover that it
 * has been suspended and pause itself. A revoked one is granted nothing at all,
 * because anything it can still call is something a stolen device can call.
 */
const CAPABILITIES_BY_STATUS: Readonly<Record<InstallationStatus, readonly InstallationCapability[]>> = {
  pending: ['read_configuration'],
  active: ['read_configuration', 'submit_inventory', 'submit_orders', 'acknowledge_receipt'],
  suspended: ['read_configuration'],
  revoked: [],
};

const SYNC_BY_STATUS: Readonly<Record<InstallationStatus, SyncDirective>> = {
  pending: 'pause',
  active: 'proceed',
  suspended: 'pause',
  revoked: 'stop',
};

const DENIAL_BY_STATUS: Readonly<Record<InstallationStatus, AuthorisationDecision>> = {
  pending: { kind: 'denied', reason: 'pairing_incomplete' },
  active: { kind: 'permitted' },
  suspended: { kind: 'denied', reason: 'installation_suspended' },
  revoked: { kind: 'denied', reason: 'installation_revoked' },
};

export function beginPairing(request: Readonly<{
  installationId: string;
  organisationId: string;
  branchId: string;
  at: string;
}>): TransitionResult {
  if (!identifier(request.installationId)
    || !identifier(request.organisationId)
    || !identifier(request.branchId)) {
    return { kind: 'refused', reason: 'invalid_identity' };
  }
  if (!instant(request.at)) {
    return { kind: 'refused', reason: 'invalid_time' };
  }

  return {
    kind: 'applied',
    installation: Object.freeze({
      installationId: request.installationId,
      organisationId: request.organisationId,
      branchId: request.branchId,
      status: 'pending',
      pairedAt: null,
      statusChangedAt: request.at,
      statusReason: null,
      supersedesInstallationId: null,
    }),
  };
}

export function applyInstallationCommand(
  installation: Installation,
  command: InstallationCommand,
): TransitionResult {
  if (!instant(command.at)) {
    return { kind: 'refused', reason: 'invalid_time' };
  }
  if ((command.kind === 'suspend' || command.kind === 'revoke') && !reason(command.reason)) {
    return { kind: 'refused', reason: 'invalid_reason' };
  }
  if (Date.parse(command.at) < Date.parse(installation.statusChangedAt)) {
    return { kind: 'refused', reason: 'time_moves_backwards' };
  }

  const target = targetStatus(command.kind);
  if (installation.status === target) {
    return { kind: 'ignored', installation };
  }
  if (installation.status === 'revoked') {
    return { kind: 'refused', reason: 'terminal_state' };
  }
  if (!legalTransition(installation.status, command.kind)) {
    return { kind: 'refused', reason: 'illegal_transition' };
  }

  return {
    kind: 'applied',
    installation: Object.freeze({
      ...installation,
      status: target,
      pairedAt: command.kind === 'confirm_pairing' ? command.at : installation.pairedAt,
      statusChangedAt: command.at,
      statusReason: command.kind === 'suspend' || command.kind === 'revoke' ? command.reason : null,
    }),
  };
}

export function repairInstallation(
  revoked: Installation,
  installationId: string,
  at: string,
): TransitionResult {
  if (revoked.status !== 'revoked') {
    return { kind: 'refused', reason: 'illegal_transition' };
  }
  if (installationId === revoked.installationId) {
    return { kind: 'refused', reason: 'identity_reused' };
  }

  const replacement = beginPairing({
    installationId,
    organisationId: revoked.organisationId,
    branchId: revoked.branchId,
    at,
  });
  if (replacement.kind !== 'applied') {
    return replacement;
  }

  return {
    kind: 'applied',
    installation: Object.freeze({
      ...replacement.installation,
      supersedesInstallationId: revoked.installationId,
    }),
  };
}

export function authoriseInstallation(
  installation: Installation,
  capability: InstallationCapability,
): AuthorisationDecision {
  return CAPABILITIES_BY_STATUS[installation.status].includes(capability)
    ? { kind: 'permitted' }
    : DENIAL_BY_STATUS[installation.status];
}

export function syncDirective(installation: Installation): SyncDirective {
  return SYNC_BY_STATUS[installation.status];
}

function targetStatus(kind: InstallationCommand['kind']): InstallationStatus {
  if (kind === 'confirm_pairing' || kind === 'resume') {
    return 'active';
  }
  return kind === 'suspend' ? 'suspended' : 'revoked';
}

function legalTransition(status: InstallationStatus, kind: InstallationCommand['kind']): boolean {
  if (kind === 'confirm_pairing') {
    return status === 'pending';
  }
  if (kind === 'resume') {
    return status === 'suspended';
  }
  if (kind === 'suspend') {
    return status === 'active';
  }
  return status === 'pending' || status === 'active' || status === 'suspended';
}

function identifier(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function reason(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function instant(value: string): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
