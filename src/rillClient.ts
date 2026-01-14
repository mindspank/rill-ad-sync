/**
 * Rill CLI wrapper for user and group management operations
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class RillClient {
  private apiToken: string;
  private orgName?: string;

  constructor(apiToken: string, orgName?: string) {
    this.apiToken = apiToken;
    this.orgName = orgName;
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
   * Execute a Rill CLI command and return the result
   */
  private async executeCommand(
    command: string,
    ignoreErrors = false,
    timeout = 30000
  ): Promise<string> {
    const fullCommand = `rill ${command} --api-token ${this.apiToken} --format json`;
    
    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        env: {
          ...process.env,
          RILL_API_TOKEN: this.apiToken,
        },
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout,
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
