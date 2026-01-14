/**
 * Cloud Function entry point for AD to Rill user sync
 */

import { Request, Response } from '@google-cloud/functions-framework';
import { AdClient } from './adClient';
import { RillClient } from './rillClient';
import { EnvConfig, SyncResult } from './types';

/**
 * Validate and load environment variables
 */
function getEnvConfig(): EnvConfig {
  const requiredVars = [
    'AD_TENANT_ID',
    'AD_CLIENT_ID',
    'AD_CLIENT_SECRET',
    'AD_GROUP_NAME',
    'RILL_API_TOKEN',
    'RILL_GROUP_NAME',
  ];

  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  return {
    adTenantId: process.env.AD_TENANT_ID!,
    adClientId: process.env.AD_CLIENT_ID!,
    adClientSecret: process.env.AD_CLIENT_SECRET!,
    adGroupName: process.env.AD_GROUP_NAME!,
    rillApiToken: process.env.RILL_API_TOKEN!,
    rillGroupName: process.env.RILL_GROUP_NAME!,
    rillOrgName: process.env.RILL_ORG_NAME,
  };
}

/**
 * Perform the sync operation
 */
async function performSync(config: EnvConfig): Promise<SyncResult> {
  const result: SyncResult = {
    success: true,
    usersCreated: 0,
    usersAddedToGroup: 0,
    errors: [],
  };

  try {
    // Initialize clients
    const adClient = new AdClient(
      config.adTenantId,
      config.adClientId,
      config.adClientSecret
    );
    const rillClient = new RillClient(
      config.rillApiToken,
      config.rillOrgName
    );

    // Fetch users from AD group
    console.log(`Fetching users from AD group: ${config.adGroupName}`);
    const adUsers = await adClient.getUsersInGroup(config.adGroupName);
    console.log(`Found ${adUsers.length} users in AD group`);

    // Fetch users from Rill group
    console.log(`Fetching users from Rill group: ${config.rillGroupName}`);
    const rillGroupUsers = await rillClient.listGroupMembers(
      config.rillGroupName
    );
    console.log(`Found ${rillGroupUsers.length} users in Rill group`);

    // Find users in AD but not in Rill
    const usersToCreate = adUsers.filter(
      (email) => !rillGroupUsers.includes(email)
    );

    // Find users in both AD and Rill but not in the Rill group
    // Note: We only know about users in the group, so we'll try to add all AD users
    // and let the Rill CLI handle "already in group" errors gracefully
    const usersToAddToGroup = adUsers.filter(
      (email) => !rillGroupUsers.includes(email)
    );

    // Create new users in Rill
    console.log(`Creating ${usersToCreate.length} new users in Rill`);
    for (const email of usersToCreate) {
      try {
        await rillClient.createUser(email, 'viewer');
        result.usersCreated++;
      } catch (error) {
        const errorMsg = `Failed to create user ${email}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(errorMsg);
        result.errors.push(errorMsg);
        result.success = false;
      }
    }

    // Add all AD users to the Rill group (idempotent operation)
    console.log(
      `Adding ${adUsers.length} users to Rill group: ${config.rillGroupName}`
    );
    for (const email of adUsers) {
      try {
        await rillClient.addUserToGroup(email, config.rillGroupName);
        // Only count if it was a new addition (not already in group)
        if (usersToAddToGroup.includes(email)) {
          result.usersAddedToGroup++;
        }
      } catch (error) {
        const errorMsg = `Failed to add user ${email} to group: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(errorMsg);
        result.errors.push(errorMsg);
        result.success = false;
      }
    }

    console.log('Sync completed successfully');
    console.log(`Users created: ${result.usersCreated}`);
    console.log(`Users added to group: ${result.usersAddedToGroup}`);
    if (result.errors.length > 0) {
      console.log(`Errors encountered: ${result.errors.length}`);
    }

    return result;
  } catch (error) {
    const errorMsg = `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(errorMsg);
    result.success = false;
    result.errors.push(errorMsg);
    return result;
  }
}

/**
 * Cloud Function HTTP handler
 */
export async function syncUsers(req: Request, res: Response): Promise<void> {
  console.log('Sync function triggered');

  try {
    // Validate environment variables
    const config = getEnvConfig();

    // Perform sync
    const result = await performSync(config);

    // Return result
    if (result.success) {
      res.status(200).json({
        success: true,
        message: 'Sync completed successfully',
        usersCreated: result.usersCreated,
        usersAddedToGroup: result.usersAddedToGroup,
        errors: result.errors,
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Sync completed with errors',
        usersCreated: result.usersCreated,
        usersAddedToGroup: result.usersAddedToGroup,
        errors: result.errors,
      });
    }
  } catch (error) {
    console.error('Function error:', error);
    res.status(500).json({
      success: false,
      message: 'Sync failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
