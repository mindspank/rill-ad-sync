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
   * Execute a Rill CLI command and return the result
   */
  private async executeCommand(
    command: string,
    ignoreErrors = false
  ): Promise<string> {
    const fullCommand = `rill ${command} --api-token ${this.apiToken} --format json`;
    
    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        env: {
          ...process.env,
          RILL_API_TOKEN: this.apiToken,
        },
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
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
      throw new Error(`Rill CLI command failed: ${errorMessage}`);
    }
  }

  /**
   * List all users in a Rill group
   */
  async listGroupMembers(groupName: string): Promise<string[]> {
    try {
      const output = await this.executeCommand(
        `user list --group "${groupName}"`,
        true // Ignore errors in case group doesn't exist or is empty
      );

      if (!output) {
        return [];
      }

      const data = JSON.parse(output);
      
      // Handle different possible response formats
      if (Array.isArray(data)) {
        return data
          .map((user: any) => user.email || user.userPrincipalName)
          .filter((email: string | undefined): email is string => !!email);
      }

      if (data.users && Array.isArray(data.users)) {
        return data.users
          .map((user: any) => user.email || user.userPrincipalName)
          .filter((email: string | undefined): email is string => !!email);
      }

      if (data.members && Array.isArray(data.members)) {
        return data.members
          .map((user: any) => user.email || user.userPrincipalName)
          .filter((email: string | undefined): email is string => !!email);
      }

      return [];
    } catch (error) {
      console.error(`Error listing group members for "${groupName}":`, error);
      // Return empty array on error to allow sync to continue
      return [];
    }
  }

  /**
   * Create a new user in Rill with the specified role
   */
  async createUser(email: string, role: string = 'viewer'): Promise<void> {
    try {
      await this.executeCommand(`user add --email "${email}" --role ${role}`);
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
   * Add a user to a Rill group
   */
  async addUserToGroup(email: string, groupName: string): Promise<void> {
    try {
      await this.executeCommand(
        `usergroup add-user --group "${groupName}" --user "${email}"`
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

  /**
   * Check if a user exists in Rill (by checking if they're in any group or org)
   */
  async userExists(email: string): Promise<boolean> {
    try {
      // Try to list users - if the user exists, we might be able to find them
      // This is a best-effort check since Rill CLI might not have a direct "user exists" command
      await this.executeCommand(`user list`, true);
      // If command succeeds, we can't definitively say if user exists
      // We'll rely on createUser to handle "already exists" errors
      return false;
    } catch (error) {
      return false;
    }
  }
}
