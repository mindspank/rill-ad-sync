/**
 * Azure AD Client for Microsoft Graph API operations
 */

import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { GraphApiGroup, GraphApiResponse, GraphApiUser } from './types';
import * as logger from './logger';

export class AdClient {
  private client: Client;
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;

  constructor(tenantId: string, clientId: string, clientSecret: string) {
    this.tenantId = tenantId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;

    const credential = new ClientSecretCredential(
      tenantId,
      clientId,
      clientSecret
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });

    this.client = Client.initWithMiddleware({ authProvider });
  }

  /**
   * Escape single quotes in OData filter strings
   */
  private escapeODataString(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Resolve a group name to its ID
   */
  async getGroupId(groupName: string): Promise<string> {
    if (!groupName || groupName.trim().length === 0) {
      throw new Error('Group name cannot be empty');
    }

    try {
      const escapedGroupName = this.escapeODataString(groupName.trim());
      const response = await this.retryWithBackoff(async () => {
        return await this.client
          .api('/groups')
          .filter(`displayName eq '${escapedGroupName}'`)
          .get();
      });

      const groups: GraphApiResponse<GraphApiGroup> = response;
      
      if (!groups.value || groups.value.length === 0) {
        throw new Error(`Group "${groupName}" not found in Azure AD`);
      }

      if (groups.value.length > 1) {
        logger.logWarning('Multiple groups found with same name, using first one', {
          groupName,
          groupId: groups.value[0].id,
          totalMatches: groups.value.length,
        });
      }

      return groups.value[0].id;
    } catch (error) {
      logger.logError('Error resolving group name to ID', error, { groupName });
      throw new Error(
        `Failed to resolve group name "${groupName}" to ID: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Retry with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000
  ): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Don't retry on authentication errors or not found errors
        if (
          lastError.message.includes('401') ||
          lastError.message.includes('403') ||
          lastError.message.includes('404') ||
          lastError.message.includes('not found')
        ) {
          throw lastError;
        }
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.logWarning('Retrying operation', {
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError || new Error('Retry failed');
  }

  /**
   * Get all users in a group by group ID
   */
  async getGroupMembers(groupId: string): Promise<string[]> {
    const userEmailsSet = new Set<string>();
    let nextLink: string | undefined;

    try {
      do {
        const endpoint = nextLink
          ? nextLink.replace('https://graph.microsoft.com/v1.0', '')
          : `/groups/${groupId}/members`;

        const data = await this.retryWithBackoff(async () => {
          const response = await this.client.api(endpoint).get();
          return response as GraphApiResponse<GraphApiUser>;
        });

        // Filter for user objects only (not groups or other directory objects)
        const users = data.value.filter(
          (item) =>
            item['@odata.type'] === '#microsoft.graph.user' &&
            (item.userPrincipalName || item.mail)
        );

        // Extract email addresses (normalize to lowercase for consistent comparison)
        for (const user of users) {
          const email = (user.userPrincipalName || user.mail)?.toLowerCase().trim();
          if (email && this.isValidEmail(email)) {
            userEmailsSet.add(email);
          }
        }

        nextLink = data['@odata.nextLink'];
      } while (nextLink);

      return Array.from(userEmailsSet);
    } catch (error) {
      logger.logError('Error fetching group members', error, { groupId });
      throw new Error(
        `Failed to fetch group members: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Validate email format
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Get all users in a group by group name
   */
  async getUsersInGroup(groupName: string): Promise<string[]> {
    const groupId = await this.getGroupId(groupName);
    return this.getGroupMembers(groupId);
  }
}
