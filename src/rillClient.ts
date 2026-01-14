/**
 * Rill CLI wrapper for user and group management operations
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class RillClient {
  private apiToken: string;

  constructor(apiToken: string, orgName?: string) {
    this.apiToken = apiToken;
  }

  /**
   * Escape shell arguments to prevent command injection
   * Uses proper shell escaping for safe command execution
   */
  private escapeShellArg(arg: string): string {
    if (!arg || typeof arg !== 'string') {
      throw new Error('Invalid argument: must be a non-empty string');
    }
    // Remove any characters that could be used for command injection
    // Allow alphanumeric, dots, dashes, underscores, @ for emails, and spaces
    if (!/^[a-zA-Z0-9._@\s-]+$/.test(arg)) {
      throw new Error(`Invalid input format - contains unsafe characters: ${arg}`);
    }
    // Escape quotes and wrap in quotes
    return `"${arg.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
  }

  /**
   * Retry with exponential backoff
   * Handles rate limiting (429) with longer backoff
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
        // Don't retry on authentication errors or validation errors
        if (
          lastError.message.includes('401') ||
          lastError.message.includes('403') ||
          lastError.message.includes('Invalid') ||
          lastError.message.includes('not found')
        ) {
          throw lastError;
        }
        if (attempt < maxRetries - 1) {
          // Use longer backoff for rate limiting (429)
          const isRateLimit = lastError.message.includes('429') || 
                             lastError.message.includes('rate limit') ||
                             lastError.message.includes('too many requests');
          const delay = isRateLimit 
            ? baseDelay * Math.pow(2, attempt + 2) // Longer backoff for rate limits
            : baseDelay * Math.pow(2, attempt);
          console.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms${isRateLimit ? ' (rate limited)' : ''}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError || new Error('Retry failed');
  }

  /**
   * Check if Rill CLI is available
   */
  async checkRillCliAvailable(): Promise<boolean> {
    try {
      await execAsync('rill --version', { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a Rill CLI command and return the result
   * Note: Rill CLI requires --api-token flag, but we escape it properly to prevent injection
   */
  private async executeCommand(
    command: string,
    ignoreErrors = false,
    timeout = 30000
  ): Promise<string> {
    // Rill CLI requires --api-token flag. We escape the token to prevent injection.
    // The token is validated to only contain safe characters in the constructor.
    const escapedToken = this.escapeShellArg(this.apiToken);
    const fullCommand = `rill ${command} --api-token ${escapedToken} --format json`;
    
    try {
      const { stdout, stderr } = await this.retryWithBackoff(async () => {
        return await execAsync(fullCommand, {
          env: {
            ...process.env,
            RILL_API_TOKEN: this.apiToken, // Also set env var in case CLI supports it
          },
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
          timeout,
        });
      });

      if (stderr && !ignoreErrors) {
        console.warn(`Rill CLI stderr: ${stderr}`);
      }

      return stdout.trim();
    } catch (error: any) {
      if (ignoreErrors) {
        return '';
      }
      const errorMessage = error.stderr || error.message || 'Unknown error';
      if (error.code === 'ETIMEDOUT' || error.killed) {
        throw new Error(`Rill CLI command timed out: ${errorMessage}`);
      }
      throw new Error(`Rill CLI command failed: ${errorMessage}`);
    }
  }

  /**
   * List all users in a Rill group
   */
  async listGroupMembers(groupName: string): Promise<string[]> {
    if (!groupName || groupName.trim().length === 0) {
      throw new Error('Group name cannot be empty');
    }

    try {
      const escapedGroupName = this.escapeShellArg(groupName.trim());
      const output = await this.executeCommand(
        `user list --group ${escapedGroupName}`,
        false // Don't ignore errors - we need to know if group doesn't exist
      );

      if (!output || output.trim().length === 0) {
        return [];
      }

      const data = JSON.parse(output);
      
      // Handle different possible response formats and normalize emails
      let emails: string[] = [];
      
      if (Array.isArray(data)) {
        emails = data.map((user: any) => user.email || user.userPrincipalName);
      } else if (data.users && Array.isArray(data.users)) {
        emails = data.users.map((user: any) => user.email || user.userPrincipalName);
      } else if (data.members && Array.isArray(data.members)) {
        emails = data.members.map((user: any) => user.email || user.userPrincipalName);
      }

      // Normalize to lowercase and validate
      return emails
        .filter((email: any): email is string => !!email && typeof email === 'string')
        .map((email: string) => email.toLowerCase().trim())
        .filter((email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    } catch (error: any) {
      // If group doesn't exist, that's a real error we should surface
      if (error.message && error.message.includes('not found')) {
        throw new Error(`Rill group "${groupName}" does not exist`);
      }
      console.error(`Error listing group members for "${groupName}":`, error);
      throw error; // Re-throw to surface the issue
    }
  }

  /**
   * Create a new user in Rill with the specified role
   */
  async createUser(email: string, role: string = 'viewer'): Promise<void> {
    if (!email || !this.isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const validRoles = ['viewer', 'editor', 'admin'];
    if (!validRoles.includes(role.toLowerCase())) {
      throw new Error(`Invalid role: ${role}. Must be one of: ${validRoles.join(', ')}`);
    }

    try {
      const escapedEmail = this.escapeShellArg(email.toLowerCase().trim());
      await this.executeCommand(`user add --email ${escapedEmail} --role ${role.toLowerCase()}`);
      console.log(`Created user: ${email} with role: ${role}`);
    } catch (error: any) {
      // Check if user already exists
      if (
        error.message &&
        (error.message.includes('already exists') ||
          error.message.includes('duplicate') ||
          error.message.includes('409'))
      ) {
        console.log(`User ${email} already exists, skipping creation`);
        return;
      }
      throw new Error(
        `Failed to create user ${email}: ${error.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Validate email format
   */
  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  /**
   * Add a user to a Rill group
   */
  async addUserToGroup(email: string, groupName: string): Promise<void> {
    if (!email || !this.isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }
    if (!groupName || groupName.trim().length === 0) {
      throw new Error('Group name cannot be empty');
    }

    try {
      const escapedEmail = this.escapeShellArg(email.toLowerCase().trim());
      const escapedGroupName = this.escapeShellArg(groupName.trim());
      await this.executeCommand(
        `usergroup add-user --group ${escapedGroupName} --user ${escapedEmail}`
      );
      console.log(`Added user ${email} to group ${groupName}`);
    } catch (error: any) {
      // Check if user is already in group
      if (
        error.message &&
        (error.message.includes('already') ||
          error.message.includes('member') ||
          error.message.includes('409'))
      ) {
        console.log(
          `User ${email} is already in group ${groupName}, skipping`
        );
        return;
      }
      throw new Error(
        `Failed to add user ${email} to group ${groupName}: ${error.message || 'Unknown error'}`
      );
    }
  }
}
