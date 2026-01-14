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

  const missing = requiredVars.filter(
    (varName) => !process.env[varName] || process.env[varName]!.trim().length === 0
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing or empty required environment variables: ${missing.join(', ')}`
    );
  }

  const config = {
    adTenantId: process.env.AD_TENANT_ID!.trim(),
    adClientId: process.env.AD_CLIENT_ID!.trim(),
    adClientSecret: process.env.AD_CLIENT_SECRET!.trim(),
    adGroupName: process.env.AD_GROUP_NAME!.trim(),
    rillApiToken: process.env.RILL_API_TOKEN!.trim(),
    rillGroupName: process.env.RILL_GROUP_NAME!.trim(),
    rillOrgName: process.env.RILL_ORG_NAME?.trim(),
  };

  // Validate that critical values are not just whitespace
  if (!config.adTenantId || !config.adClientId || !config.adClientSecret) {
    throw new Error('AD credentials cannot be empty');
  }
  if (!config.rillApiToken) {
    throw new Error('RILL_API_TOKEN cannot be empty');
  }

  return config;
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

    // Check if Rill CLI is available
    const rillCliAvailable = await rillClient.checkRillCliAvailable();
    if (!rillCliAvailable) {
      throw new Error('Rill CLI is not available. Please ensure it is installed.');
    }

    // Fetch users from AD group
    console.log(`Fetching users from AD group: ${config.adGroupName}`);
    const adUsers = await adClient.getUsersInGroup(config.adGroupName);
    console.log(`Found ${adUsers.length} users in AD group`);

    // Validate group size to prevent timeouts
    const MAX_GROUP_SIZE = 10000;
    if (adUsers.length > MAX_GROUP_SIZE) {
      throw new Error(
        `AD group has ${adUsers.length} users, which exceeds the maximum of ${MAX_GROUP_SIZE}. ` +
        `This sync would likely timeout. Please split into smaller groups.`
      );
    }

    // Normalize AD users to lowercase for consistent comparison
    const normalizedAdUsers = adUsers.map((email) => email.toLowerCase().trim());

    // Fetch users from Rill group
    console.log(`Fetching users from Rill group: ${config.rillGroupName}`);
    let rillGroupUsers: string[] = [];
    try {
      rillGroupUsers = await rillClient.listGroupMembers(config.rillGroupName);
      console.log(`Found ${rillGroupUsers.length} users in Rill group`);
    } catch (error: any) {
      // If group doesn't exist, that's a critical error
      if (error.message && error.message.includes('does not exist')) {
        throw new Error(
          `Rill group "${config.rillGroupName}" does not exist. Please create it first.`
        );
      }
      throw error;
    }

    // Use Set for O(1) lookups instead of O(n) includes()
    const rillGroupUsersSet = new Set(rillGroupUsers.map((email) => email.toLowerCase().trim()));

    // Find users in AD but not in Rill group (these need to be created and added)
    const usersToCreate = normalizedAdUsers.filter(
      (email) => !rillGroupUsersSet.has(email)
    );

    // Find users that are in Rill but not in the group (these just need to be added)
    // Note: We can't easily determine this without listing all Rill users,
    // so we'll try to add all AD users and let Rill CLI handle "already in group" gracefully
    const usersToAddToGroup = normalizedAdUsers;

    // Create new users in Rill with rate limiting (sequential to avoid overwhelming the API)
    console.log(`Creating ${usersToCreate.length} new users in Rill`);
    const startTime = Date.now();
    for (let i = 0; i < usersToCreate.length; i++) {
      const email = usersToCreate[i];
      const progress = `[${i + 1}/${usersToCreate.length}]`;
      try {
        await rillClient.createUser(email, 'viewer');
        result.usersCreated++;
        console.log(`${progress} ✓ Created user: ${email}`);
      } catch (error) {
        const errorMsg = `Failed to create user ${email}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`${progress} ✗ ${errorMsg}`);
        result.errors.push(errorMsg);
        // Don't mark as failure if it's just "already exists" - that's expected
        if (!errorMsg.includes('already exists')) {
          result.success = false;
        }
        // Continue with other users even if one fails
      }
      // Small delay to avoid rate limiting (50ms between requests)
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const createDuration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`User creation completed in ${createDuration}s`);

    // Add all AD users to the Rill group (idempotent operation) with rate limiting
    console.log(
      `Adding ${normalizedAdUsers.length} users to Rill group: ${config.rillGroupName}`
    );
    const addStartTime = Date.now();
    for (let i = 0; i < normalizedAdUsers.length; i++) {
      const email = normalizedAdUsers[i];
      const progress = `[${i + 1}/${normalizedAdUsers.length}]`;
      try {
        await rillClient.addUserToGroup(email, config.rillGroupName);
        // Only count if it was a new addition (not already in group)
        if (!rillGroupUsersSet.has(email)) {
          result.usersAddedToGroup++;
          console.log(`${progress} ✓ Added user ${email} to group`);
        } else {
          // Only log every 10th user to reduce log noise for large groups
          if ((i + 1) % 10 === 0 || normalizedAdUsers.length < 20) {
            console.log(`${progress} - User ${email} already in group, skipped`);
          }
        }
      } catch (error) {
        const errorMsg = `Failed to add user ${email} to group: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`${progress} ✗ ${errorMsg}`);
        result.errors.push(errorMsg);
        // Don't mark as failure if it's just "already" - that's expected
        if (!errorMsg.includes('already')) {
          result.success = false;
        }
        // Continue with other users even if one fails
      }
      // Small delay to avoid rate limiting (50ms between requests)
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const addDuration = ((Date.now() - addStartTime) / 1000).toFixed(1);
    console.log(`Group addition completed in ${addDuration}s`);

    const totalDuration = ((Date.now() - Date.now() + (Date.now() - addStartTime) + (Date.now() - startTime)) / 1000).toFixed(1);
    console.log('Sync completed');
    console.log(`Summary: ${result.usersCreated} users created, ${result.usersAddedToGroup} users added to group`);
    if (result.errors.length > 0) {
      console.log(`Errors encountered: ${result.errors.length}`);
      // Only show first 5 errors to avoid log spam
      result.errors.slice(0, 5).forEach((err) => console.error(`  - ${err}`));
      if (result.errors.length > 5) {
        console.error(`  ... and ${result.errors.length - 5} more errors`);
      }
    }
    // Consider it successful if we made progress, even if some operations failed
    if (result.usersCreated > 0 || result.usersAddedToGroup > 0) {
      result.success = true;
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
