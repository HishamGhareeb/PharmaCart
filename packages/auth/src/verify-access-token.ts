import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type AccessTokenVerifierConfig = Readonly<{
  issuer: string;
  audience: string | string[];
  jwksUri: string | URL;
}>;
export type VerifiedAccessToken = Readonly<{ subject: string; issuer: string; claims: JWTPayload }>;

export function createAccessTokenVerifier(config: AccessTokenVerifierConfig) {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 3000 });
  return {
    async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
      if (typeof token !== 'string' || token.length > 16384) throw new Error('Invalid access token');
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
        typ: 'at+jwt', requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: '10m',
      });
      if (!payload.sub || payload.sub.length > 256) throw new Error('Invalid subject');
      return { subject: payload.sub, issuer: config.issuer, claims: payload };
    },
  };
}
