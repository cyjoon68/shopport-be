export type AuthProvider = 'kakao';

export type VerifiedIdentity = Readonly<{
  provider: AuthProvider;
  subject: string;
  displayName: string;
  profileImageUrl: string | null;
}>;

export type AccountSession = Readonly<{
  accountId: string;
  displayName: string;
  profileImageUrl: string | null;
}>;

export type TokenPair = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}>;

export type AccessClaims = Readonly<{
  sub: string;
  sessionId: string;
}>;
