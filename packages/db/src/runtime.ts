import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

export const membershipRoles = [
  'pharmacy_owner',
  'purchaser',
  'receiver',
  'supplier_operator',
  'supplier_administrator',
  'support',
] as const;

export type MembershipRole = (typeof membershipRoles)[number];
export type OrganisationKind = 'pharmacy' | 'supplier';

export type TenantContext = {
  principalKind: 'member';
  userSubject: string;
  membershipId: string;
  organisationId: string;
  organisationKind: OrganisationKind;
  branchId: string;
  allowedBranchIds: readonly [string];
  role: MembershipRole;
  membershipVersion: number;
};

export type RuntimeClient = Pick<PoolClient, 'query'>;

type MembershipRow = QueryResultRow & {
  membership_id: string;
  organisation_kind: OrganisationKind;
  membership_role: MembershipRole;
  membership_version: number;
};

export class MembershipAccessDeniedError extends Error {
  readonly code = 'MEMBERSHIP_ACCESS_DENIED';

  constructor() {
    super('No active membership grants access to the selected organisation and branch');
    this.name = 'MembershipAccessDeniedError';
  }
}

function requiredSelector(value: string, label: string): string {
  if (value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

async function lookupMembership(
  client: PoolClient,
  subject: string,
  organisationId: string,
  branchId: string,
): Promise<MembershipRow> {
  const result = await client.query<MembershipRow>(
    `SELECT membership_id, organisation_kind, membership_role, membership_version
       FROM pharmacart_active_membership($1, $2::uuid, $3::uuid)`,
    [subject, organisationId, branchId],
  );
  if (result.rowCount !== 1) throw new MembershipAccessDeniedError();
  return result.rows[0];
}

export async function createRuntimePool(config: PoolConfig = {}): Promise<Pool> {
  const connectionString = config.connectionString ?? process.env.PHARMACART_RUNTIME_DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('PHARMACART_RUNTIME_DATABASE_URL is required');
  }
  const username = new URL(connectionString).username;
  if (username !== 'pharmacart_app') {
    throw new Error('Runtime database URL must use the pharmacart_app login');
  }
  const pool = new Pool({ ...config, connectionString });
  try {
    const result = await pool.query<{
      login_name: string;
      can_login: boolean;
      is_superuser: boolean;
      bypasses_rls: boolean;
      creates_role: boolean;
      creates_database: boolean;
      inherits_privileges: boolean;
      can_assume_runtime: boolean;
    }>(`SELECT role.rolname AS login_name,
              role.rolcanlogin AS can_login,
              role.rolsuper AS is_superuser,
              role.rolbypassrls AS bypasses_rls,
              role.rolcreaterole AS creates_role,
              role.rolcreatedb AS creates_database,
              role.rolinherit AS inherits_privileges,
              pg_has_role(session_user, 'pharmacart_runtime', 'MEMBER') AS can_assume_runtime
         FROM pg_roles AS role
        WHERE role.rolname = session_user`);
    const login = result.rows[0];
    if (result.rowCount !== 1
      || login.login_name !== 'pharmacart_app'
      || !login.can_login
      || login.is_superuser
      || login.bypasses_rls
      || login.creates_role
      || login.creates_database
      || login.inherits_privileges
      || !login.can_assume_runtime) {
      throw new Error('Runtime database login does not satisfy the required safety attributes');
    }
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function withTransaction<T>(
  pool: Pool,
  subject: string,
  organisationId: string,
  branchId: string,
  callback: (client: RuntimeClient, context: TenantContext) => Promise<T>,
): Promise<T> {
  requiredSelector(subject, 'subject');
  requiredSelector(organisationId, 'organisationId');
  requiredSelector(branchId, 'branchId');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE pharmacart_runtime');
    await lookupMembership(client, subject, organisationId, branchId);
    await client.query(
      `SELECT set_config('app.organisation_id', $1, true),
              set_config('app.branch_id', $2, true)`,
      [organisationId, branchId],
    );
    const membership = await lookupMembership(client, subject, organisationId, branchId);
    const context: TenantContext = {
      principalKind: 'member',
      userSubject: subject,
      membershipId: membership.membership_id,
      organisationId,
      organisationKind: membership.organisation_kind,
      branchId,
      allowedBranchIds: [branchId],
      role: membership.membership_role,
      membershipVersion: membership.membership_version,
    };
    const value = await callback(client, context);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
