/**
 * Type definitions for the AD to Rill sync utility
 */

export interface EnvConfig {
  adTenantId: string;
  adClientId: string;
  adClientSecret: string;
  adGroupName: string;
  rillApiToken: string;
  rillGroupName: string;
  rillOrgName?: string;
}

export interface GraphApiUser {
  id: string;
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
  '@odata.type': string;
}

export interface GraphApiGroup {
  id: string;
  displayName: string;
}

export interface GraphApiResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

export interface RillUser {
  email: string;
  role?: string;
}

export interface SyncResult {
  success: boolean;
  usersCreated: number;
  usersAddedToGroup: number;
  errors: string[];
}
