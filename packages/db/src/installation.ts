import type { QueryResultRow } from 'pg';
import {
  authoriseInstallation, syncDirective,
  type Installation, type InstallationCapability, type InstallationStatus, type SyncDirective,
} from '../../installation-lifecycle/src/pairing.ts';
import type { RuntimeClient } from './runtime.ts';

/**
 * Reads the stored lifecycle of the installation paired to an authenticated
 * subject. The lookup is the security-definer function of migration 0011: it
 * returns at most the caller's own row, so no caller can name another
 * installation or enumerate the table.
 */
export type InstallationRefusal = Readonly<{
  status: InstallationStatus | 'unknown';
  reason: 'pairing_incomplete' | 'installation_suspended' | 'installation_revoked' | 'installation_unknown';
  directive: SyncDirective;
}>;

type InstallationRow = QueryResultRow & {
  id: string; organisation_id: string; branch_id: string; status: string;
  paired_at: Date | string | null; status_changed_at: Date | string;
  status_reason: string | null; supersedes_installation_id: string | null;
};

const statuses: readonly string[] = ['pending', 'active', 'suspended', 'revoked'];

function instant(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toInstallation(row: InstallationRow): Installation {
  if (!statuses.includes(row.status)) throw new Error(`Unknown installation status: ${row.status}`);
  return Object.freeze({
    installationId: row.id,
    organisationId: row.organisation_id,
    branchId: row.branch_id,
    status: row.status as InstallationStatus,
    pairedAt: instant(row.paired_at),
    statusChangedAt: instant(row.status_changed_at) ?? new Date(0).toISOString(),
    statusReason: row.status_reason,
    supersedesInstallationId: row.supersedes_installation_id,
  });
}

export async function loadInstallation(client: RuntimeClient, subject: string): Promise<Installation | null> {
  const result = await client.query<InstallationRow>(
    `SELECT id,organisation_id,branch_id,status,paired_at,status_changed_at,status_reason,supersedes_installation_id
       FROM pharmacart_installation_lifecycle($1)`,
    [subject],
  );
  return result.rowCount === 1 ? toInstallation(result.rows[0]!) : null;
}

/**
 * Null means the capability is permitted. A refusal carries the stored status
 * and its sync directive for a future connector-facing surface; the HTTP
 * contract stays a single INSTALLATION_DENIED and discloses neither.
 */
export function refuseInstallation(
  installation: Installation | null,
  capability: InstallationCapability,
): InstallationRefusal | null {
  if (installation === null) {
    return Object.freeze({ status: 'unknown', reason: 'installation_unknown', directive: 'stop' });
  }
  const decision = authoriseInstallation(installation, capability);
  if (decision.kind === 'permitted') return null;
  return Object.freeze({ status: installation.status, reason: decision.reason, directive: syncDirective(installation) });
}
